// lib/core.js — 정규화 검증, 일별 저장, 오류 상태, 전일 대비 계산.
// 실제 수집기(live adapter)와 합성 재생(replay adapter)이 모두 이 함수들만 거칩니다.
// 공개 계약: normalized-reading.schema.json, reading-status.schema.json (contract 1.1.0)

export const TIMEZONE = "Asia/Seoul";

export const NORMALIZED_KEYS = Object.freeze([
  "signal_id", "normalized_value", "unit", "source_name", "source_url",
  "source_time", "fetched_at", "record_timezone", "record_date",
]);

export const ERROR_CODES = Object.freeze(["timeout", "auth", "rate_limit", "offline", "schema_error"]);

/** 실패 종류별: 무엇이 일어났는지와 사용자가 할 다음 행동 */
export const ERROR_GUIDE = Object.freeze({
  timeout: {
    title: "응답 지연 (timeout)",
    what: "외부 원천이 제한 시간 안에 응답하지 않았습니다.",
    next: "잠시 뒤 다시 시도하세요. 보통 일시적인 지연입니다.",
  },
  auth: {
    title: "원천이 거절함 (auth · 401/403)",
    what: "외부 데이터 원천이 요청을 거절했습니다. 이 앱의 로그인 문제가 아니라 원천의 접근 정책 문제입니다.",
    next: "같은 요청을 다시 보내도 대개 다시 거절됩니다. 원천의 공지와 이용 정책을 먼저 확인하세요.",
  },
  rate_limit: {
    title: "호출 제한 (rate_limit · 429)",
    what: "짧은 시간에 요청이 너무 많아 외부 원천이 호출을 막았습니다.",
    next: "안내된 대기 시간(Retry-After)이 지난 뒤 다시 시도하세요.",
  },
  offline: {
    title: "오프라인 (offline)",
    what: "네트워크 연결이 끊겨 외부 원천에 요청을 보내지 못했습니다.",
    next: "인터넷 연결을 확인하세요. 연결이 돌아오면 다시 시도하세요.",
  },
  schema_error: {
    title: "응답 형식 변경 (schema_error)",
    what: "외부 원천은 응답했지만 필수 값의 형식이 예상과 달라 해석하지 못했습니다.",
    next: "다시 시도해도 같다면 앱의 해석 코드를 고쳐야 합니다. 관리자에게 알려 주세요.",
  },
});

/** fetched_at → Asia/Seoul 날짜 */
export function kstDate(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) throw new TypeError("fetched_at must be a valid ISO-8601 date-time");
  const p = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day}`;
}

/** Asia/Seoul 기준 "YYYY-MM-DD HH:mm:ss KST" 표시용 */
export function kstLabel(iso) {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  const p = Object.fromEntries(new Intl.DateTimeFormat("en", {
    timeZone: TIMEZONE, year: "numeric", month: "2-digit", day: "2-digit",
    hour: "2-digit", minute: "2-digit", second: "2-digit", hourCycle: "h23",
  }).formatToParts(d).map((x) => [x.type, x.value]));
  return `${p.year}-${p.month}-${p.day} ${p.hour}:${p.minute}:${p.second} KST`;
}

/** normalized-reading.schema.json 검증. 어긋나면 TypeError → schema_error */
export function validateNormalizedReading(r) {
  if (!r || typeof r !== "object" || Array.isArray(r)) throw new TypeError("normalized reading must be an object");
  const keys = Object.keys(r).sort(), want = [...NORMALIZED_KEYS].sort();
  if (keys.length !== want.length || keys.some((k, i) => k !== want[i])) {
    throw new TypeError(`normalized reading keys must be exactly: ${NORMALIZED_KEYS.join(", ")}`);
  }
  if (typeof r.signal_id !== "string" || !/^[a-z0-9][a-z0-9._-]*$/.test(r.signal_id) || r.signal_id.length > 100) throw new TypeError("signal_id is invalid");
  if (typeof r.normalized_value !== "number" || !Number.isFinite(r.normalized_value)) throw new TypeError("normalized_value must be a finite number");
  for (const f of ["unit", "source_name"]) {
    if (typeof r[f] !== "string" || r[f].trim() === "") throw new TypeError(`${f} must be a non-empty string`);
  }
  if (r.unit.length > 24 || r.source_name.length > 120) throw new TypeError("unit/source_name too long");
  let u;
  try { u = new URL(r.source_url); } catch { throw new TypeError("source_url must be an absolute URL"); }
  if (u.protocol !== "https:") throw new TypeError("source_url must use HTTPS");
  if (r.source_time !== null && (typeof r.source_time !== "string" || Number.isNaN(new Date(r.source_time).getTime()))) throw new TypeError("source_time must be a date-time or null");
  if (typeof r.fetched_at !== "string" || Number.isNaN(new Date(r.fetched_at).getTime())) throw new TypeError("fetched_at must be a valid date-time");
  if (r.record_timezone !== TIMEZONE) throw new TypeError("record_timezone must be Asia/Seoul");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(r.record_date) || r.record_date !== kstDate(r.fetched_at)) throw new TypeError("record_date must be the Asia/Seoul date of fetched_at");
  return true;
}

export function validateStatus(s) {
  if (!s || typeof s !== "object") return false;
  if (s.freshness === "fresh") return s.error_code === "none";
  if (s.freshness === "stale") return ERROR_CODES.includes(s.error_code);
  return false;
}

const clone = (v) => JSON.parse(JSON.stringify(v));

export function resetEvaluationState() {
  return {
    schema_version: "aleph-t04-evaluation-state-v1",
    daily_readings: [],
    current_reading: null,
    status: null,
    last_delta: null,
    last_comparison: { state: "insufficient", direction: null, magnitude: null, unit: null },
    last_run: null,
    sequence: 0,
  };
}

export const recordIdFor = (r) => `${r.signal_id}-${r.record_date}`;

function decimalsOf(n) {
  const s = String(n);
  if (/e/i.test(s)) return 6;
  const i = s.indexOf(".");
  return i < 0 ? 0 : s.length - i - 1;
}

/**
 * 전일 대비 계산 규칙 (화면과 재계산이 함께 쓰는 단 하나의 규칙):
 * 같은 signal_id의 일별 행을 record_date 순으로 놓고, 현재 행 바로 앞 행과 비교한다.
 * 변화 = 현재 normalized_value − 이전 normalized_value, 두 값 중 더 긴 소수 자릿수로 반올림.
 * 단위가 다르면 비교하지 않는다.
 */
export function comparisonFor(rows, current) {
  const prev = rows
    .filter((r) => r.signal_id === current.signal_id && r.record_date < current.record_date)
    .sort((a, b) => b.record_date.localeCompare(a.record_date))[0];
  if (!prev) return { state: "insufficient", direction: null, magnitude: null, unit: null, signed: null, previous_date: null };
  if (prev.unit !== current.unit) return { state: "unit_mismatch", direction: null, magnitude: null, unit: null, signed: null, previous_date: prev.record_date };
  const dp = Math.max(decimalsOf(prev.normalized_value), decimalsOf(current.normalized_value));
  const signed = Number((current.normalized_value - prev.normalized_value).toFixed(dp));
  return {
    state: "comparable",
    direction: signed > 0 ? "increase" : signed < 0 ? "decrease" : "unchanged",
    magnitude: Math.abs(signed),
    signed,
    unit: current.unit,
    previous_date: prev.record_date,
    previous_value: prev.normalized_value,
    is_yesterday: dayGap(prev.record_date, current.record_date) === 1,
  };
}

function dayGap(a, b) {
  return Math.round((Date.parse(b + "T00:00:00Z") - Date.parse(a + "T00:00:00Z")) / 864e5);
}

/**
 * 정상 조회 저장: 같은 signal_id + record_date면 같은 record_id 행을 갱신(새 행 없음),
 * 다음 Asia/Seoul 날짜면 새 행. raw는 원자료 발췌(실제 수집에서만 채움).
 */
export function applySuccessfulReading(input, reading, meta = {}) {
  validateNormalizedReading(reading);
  const s = clone(input);
  const i = s.daily_readings.findIndex((r) => r.signal_id === reading.signal_id && r.record_date === reading.record_date);
  const ex = i >= 0 ? s.daily_readings[i] : null;
  const row = {
    record_id: ex ? ex.record_id : recordIdFor(reading),
    signal_id: reading.signal_id,
    record_date: reading.record_date,
    normalized_value: reading.normalized_value,
    unit: reading.unit,
    first_fetched_at: ex ? ex.first_fetched_at : reading.fetched_at,
    last_fetched_at: reading.fetched_at,
    reading: clone(reading),
    raw: meta.raw ? clone(meta.raw) : null,
  };
  if (i >= 0) s.daily_readings[i] = row; else s.daily_readings.push(row);
  s.daily_readings.sort((a, b) => a.record_date.localeCompare(b.record_date));
  s.current_reading = clone(reading);
  s.status = { freshness: "fresh", error_code: "none" };
  s.last_comparison = comparisonFor(s.daily_readings, row);
  s.last_delta = s.last_comparison.magnitude;
  s.sequence += 1;
  s.last_run = {
    fixture_id: meta.fixture_id || null,
    virtual_now: meta.virtual_now || reading.fetched_at,
    attempted_at: meta.attempted_at || reading.fetched_at,
    outcome: "success", error_code: "none", retry_after_seconds: null, message: null,
  };
  return s;
}

/** 실패 기록: 일별 행과 current_reading(마지막 정상값)은 건드리지 않고 상태만 stale/코드로 */
export function applyError(input, code, meta = {}) {
  if (!ERROR_CODES.includes(code)) throw new TypeError(`unsupported error code: ${code}`);
  const s = clone(input);
  s.status = { freshness: "stale", error_code: code };
  s.sequence += 1;
  s.last_run = {
    fixture_id: meta.fixture_id || null,
    virtual_now: meta.virtual_now || null,
    attempted_at: meta.attempted_at || meta.virtual_now || null,
    outcome: "error", error_code: code,
    retry_after_seconds: meta.retry_after_seconds ?? null,
    message: meta.message || null,
  };
  return s;
}

/** 원자료 → 저장값 → 화면 변화값 재계산 대조 (C10, C23, C24 보조) */
export function recheck(state) {
  const rows = state.daily_readings;
  const rowChecks = rows.map((r) => {
    const rawValue = r.raw ? Number(r.raw.value) : null;
    return {
      record_date: r.record_date,
      raw_value: r.raw ? r.raw.value : null,
      stored_value: r.normalized_value,
      reading_value: r.reading.normalized_value,
      unit: r.unit,
      match: r.normalized_value === r.reading.normalized_value && (rawValue === null || rawValue === r.normalized_value),
    };
  });
  let delta = null;
  if (rows.length >= 2) {
    const a = rows[rows.length - 2], b = rows[rows.length - 1];
    const shown = comparisonFor(rows, b);
    const dp = Math.max(decimalsOf(a.normalized_value), decimalsOf(b.normalized_value));
    const independent = Number((b.normalized_value - a.normalized_value).toFixed(dp));
    delta = { from: a.record_date, to: b.record_date, independent, shown: shown.signed, unit: b.unit, match: shown.state === "comparable" && independent === shown.signed };
  }
  return { rows: rowChecks, delta, ok: rowChecks.every((x) => x.match) && (!delta || delta.match) };
}
