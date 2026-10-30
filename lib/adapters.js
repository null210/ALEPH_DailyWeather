// lib/adapters.js — 실제 원천(live)과 공개 합성 fixture(replay)를 같은 저장 함수로 넘기는 어댑터.
import { applySuccessfulReading, applyError, kstDate, validateNormalizedReading } from "./core.js";

/* ---------------- live: Open-Meteo 서울 기온 ---------------- */
export const LIVE_SOURCE = Object.freeze({
  signal_id: "seoul-temperature-2m",
  source_name: "Open-Meteo Forecast API (current)",
  source_url: "https://api.open-meteo.com/v1/forecast?latitude=37.5665&longitude=126.978&current=temperature_2m&timezone=Asia%2FSeoul",
  unit: "°C",
  meaning: "서울시청 좌표(북위 37.5665°, 동경 126.978°)의 지상 2m 기온. Open-Meteo가 15분 간격으로 내는 '현재' 값이며 특정 관측소 실측값과 다를 수 있습니다.",
});

export class SourceFailure extends Error {
  constructor(code, message, extra = {}) { super(message); this.code = code; Object.assign(this, extra); }
}

/** Open-Meteo 응답 본문 → normalized reading. 형식이 다르면 schema_error */
export function normalizeOpenMeteo(body, fetchedAtIso) {
  const c = body && body.current;
  const v = c && c.temperature_2m;
  const t = c && c.time;
  const off = body && body.utc_offset_seconds;
  const unit = body && body.current_units && body.current_units.temperature_2m;
  if (typeof v !== "number" || !Number.isFinite(v) || typeof t !== "string" ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(t) || typeof off !== "number" || unit !== "°C") {
    throw new SourceFailure("schema_error", "current.temperature_2m / current.time / current_units 형식이 예상과 다릅니다.");
  }
  // 원천 시각(현지 표기 + 오프셋)을 UTC ISO로
  const sourceTime = new Date(Date.parse(t + ":00Z") - off * 1000).toISOString();
  const reading = {
    signal_id: LIVE_SOURCE.signal_id,
    normalized_value: v,                 // 원자료 값을 그대로 저장 (변형 없음)
    unit: LIVE_SOURCE.unit,
    source_name: LIVE_SOURCE.source_name,
    source_url: LIVE_SOURCE.source_url,
    source_time: sourceTime,
    fetched_at: fetchedAtIso,
    record_timezone: "Asia/Seoul",
    record_date: kstDate(fetchedAtIso),
  };
  validateNormalizedReading(reading);
  const raw = { path: "current.temperature_2m", value: v, time: t, utc_offset_seconds: off, unit };
  return { reading, raw };
}

/** 실제 원천 호출. 실패는 계약의 5개 코드로 분류 */
export async function fetchLive({ fetchImpl = globalThis.fetch, now = () => new Date(), deadlineMs = 10000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), deadlineMs);
  try {
    let res;
    try {
      res = await fetchImpl(LIVE_SOURCE.source_url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    } catch (e) {
      if (e && e.name === "AbortError") throw new SourceFailure("timeout", `${deadlineMs}ms 안에 응답이 없었습니다.`);
      throw new SourceFailure("offline", "원천에 연결하지 못했습니다: " + ((e && (e.cause?.code || e.message)) || e));
    }
    if (res.status === 401 || res.status === 403) throw new SourceFailure("auth", `원천이 HTTP ${res.status}로 거절했습니다.`);
    if (res.status === 429) {
      const ra = res.headers.get("retry-after");
      throw new SourceFailure("rate_limit", "원천 호출 제한(HTTP 429).", { retry_after_seconds: ra && Number.isFinite(Number(ra)) ? Number(ra) : null });
    }
    if (!res.ok) throw new SourceFailure("schema_error", `원천이 예상 밖의 HTTP ${res.status}를 돌려줬습니다.`);
    let body;
    try { body = await res.json(); } catch (e) {
      if (e && e.name === "AbortError") throw new SourceFailure("timeout", `${deadlineMs}ms 안에 응답이 끝나지 않았습니다.`);
      throw new SourceFailure("schema_error", "응답이 JSON이 아닙니다.");
    }
    return normalizeOpenMeteo(body, now().toISOString());
  } finally {
    clearTimeout(timer);
  }
}

/** live 한 번 실행 → 상태 갱신 (성공은 저장, 실패는 상태만) */
export async function runLive(state, opts = {}) {
  const attempted_at = (opts.now ? opts.now() : new Date()).toISOString();
  try {
    const { reading, raw } = await fetchLive(opts);
    return applySuccessfulReading(state, reading, { raw, attempted_at });
  } catch (e) {
    const code = e instanceof SourceFailure ? e.code : (e instanceof TypeError ? "schema_error" : "offline");
    return applyError(state, code, { attempted_at, message: e.message, retry_after_seconds: e.retry_after_seconds ?? null });
  }
}

/* ---------------- replay: 공개 fixture (contract 1.1.0) ---------------- */
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * fixture 한 개를 실제 시간 흐름(지연·제한시간)대로 재생합니다.
 * timeout: delay_ms가 deadline_ms보다 길면 deadline에서 끊고 timeout.
 * 2xx 응답의 payload는 live와 똑같이 validateNormalizedReading → applySuccessfulReading을 지납니다.
 */
export async function runFixture(state, fx, { sleep = wait } = {}) {
  const t = fx.transport;
  const meta = {
    fixture_id: fx.fixture_id,
    virtual_now: fx.virtual_now,
    attempted_at: fx.virtual_now,
    retry_after_seconds: t.headers && t.headers["retry-after"] ? Number(t.headers["retry-after"]) : null,
  };
  if (t.mode === "offline") return applyError(state, "offline", { ...meta, message: "합성: 네트워크 연결 없음" });
  if (t.mode === "timeout" || t.delay_ms > t.deadline_ms) {
    await sleep(Math.min(t.delay_ms, t.deadline_ms));
    return applyError(state, "timeout", { ...meta, message: `합성: ${t.delay_ms}ms 지연 > 제한 ${t.deadline_ms}ms` });
  }
  await sleep(t.delay_ms);
  if (t.status === 401 || t.status === 403) return applyError(state, "auth", { ...meta, message: `합성: HTTP ${t.status}` });
  if (t.status === 429) return applyError(state, "rate_limit", { ...meta, message: "합성: HTTP 429" });
  if (t.status >= 200 && t.status < 300) {
    try { return applySuccessfulReading(state, fx.payload, meta); }
    catch (e) { return applyError(state, "schema_error", { ...meta, message: "합성: " + e.message }); }
  }
  return applyError(state, "schema_error", { ...meta, message: `합성: HTTP ${t.status}` });
}

export const SEQUENCES = Object.freeze({
  success: ["T04-NORMAL-D1-A", "T04-NORMAL-D1-B", "T04-NORMAL-D2"],
  failureBaseline: ["T04-NORMAL-D1-A", "T04-NORMAL-D1-B"],
  failures: ["T04-TIMEOUT", "T04-AUTH-401", "T04-RATE-429", "T04-OFFLINE", "T04-SCHEMA-BREAK"],
  recovery: ["T04-NORMAL-D1-A", "T04-NORMAL-D1-B", "T04-TIMEOUT", "T04-RECOVER-D2"],
});

export const FIXTURE_FILES = Object.freeze({
  "T04-NORMAL-D1-A": "normal-d1-a.json",
  "T04-NORMAL-D1-B": "normal-d1-b.json",
  "T04-NORMAL-D2": "normal-d2.json",
  "T04-TIMEOUT": "timeout.json",
  "T04-AUTH-401": "auth-401.json",
  "T04-RATE-429": "rate-429.json",
  "T04-OFFLINE": "offline.json",
  "T04-SCHEMA-BREAK": "schema-break.json",
  "T04-RECOVER-D2": "recover-d2.json",
});
