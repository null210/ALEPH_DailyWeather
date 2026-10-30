// 공개 fixture 시퀀스를 계약의 expected와 C19 전이표에 대조합니다: node scripts/selftest.mjs
import { readFile } from "node:fs/promises";
import assert from "node:assert/strict";
import { resetEvaluationState, validateStatus, recheck } from "../lib/core.js";
import { runFixture, SEQUENCES, FIXTURE_FILES, normalizeOpenMeteo } from "../lib/adapters.js";

const load = async (id) => JSON.parse(await readFile(new URL(`../fixtures/${FIXTURE_FILES[id]}`, import.meta.url), "utf8"));
const fast = { sleep: async () => {} };

function check(state, fx, history) {
  const e = fx.expected;
  assert.ok(validateStatus(state.status), `${fx.fixture_id}: status schema`);
  assert.equal(state.status.freshness, e.freshness, `${fx.fixture_id}: freshness`);
  assert.equal(state.status.error_code, e.error_code, `${fx.fixture_id}: error_code`);
  assert.equal(state.daily_readings.length, e.row_count, `${fx.fixture_id}: row_count`);
  assert.equal(state.current_reading?.normalized_value ?? null, e.stored_value, `${fx.fixture_id}: stored/last good value`);
  assert.equal(state.last_delta, e.delta, `${fx.fixture_id}: delta`);
  if (e.record_date) assert.ok(state.daily_readings.some((r) => r.record_date === e.record_date), `${fx.fixture_id}: record_date`);
  if (e.same_record_id_as) {
    const prev = history[e.same_record_id_as];
    assert.equal(state.daily_readings[0].record_id, prev, `${fx.fixture_id}: same record_id`);
  }
}

async function play(ids, { real = false } = {}) {
  let s = resetEvaluationState();
  const history = {};
  for (const id of ids) {
    const fx = await load(id);
    s = await runFixture(s, fx, real ? {} : fast);
    check(s, fx, history);
    history[id] = s.daily_readings.find((r) => r.record_date === fx.payload?.record_date)?.record_id;
  }
  return s;
}

// 1) 정상·일별 저장
let s = await play(SEQUENCES.success);
assert.equal(s.last_comparison.direction, "increase");
console.log("ok  정상 시퀀스 D1-A → D1-B(같은 record_id, 행 1) → D2(행 2, +15)");

// 2) 각 실패 (기준 D1-A, D1-B 후 실패 1개) — 실제 타이머로 재생
for (const f of SEQUENCES.failures) {
  s = await play([...SEQUENCES.failureBaseline, f], { real: true });
  assert.equal(s.current_reading.normalized_value, 105);
  console.log(`ok  ${f} → stale/${s.status.error_code}, 행 1, 마지막 정상값 105 유지`);
}

// 3) C19 회복 전이표
s = resetEvaluationState();
for (const id of ["T04-NORMAL-D1-A", "T04-NORMAL-D1-B", "T04-TIMEOUT"]) s = await runFixture(s, await load(id), fast);
assert.deepEqual(
  { freshness: s.status.freshness, error_code: s.status.error_code, daily_row_count: s.daily_readings.length, last_good_value: s.current_reading.normalized_value, record_date: s.daily_readings[0].record_date },
  { freshness: "stale", error_code: "timeout", daily_row_count: 1, last_good_value: 105, record_date: "2026-08-24" });
const before = s.daily_readings.map((r) => r.record_id);
s = await runFixture(s, await load("T04-RECOVER-D2"), fast);
const added = s.daily_readings.filter((r) => !before.includes(r.record_id));
assert.deepEqual(
  { freshness: s.status.freshness, error_code: s.status.error_code, daily_row_count: s.daily_readings.length, new_next_date_rows: added.length, stored_value: s.current_reading.normalized_value, record_date: added[0].record_date },
  { freshness: "fresh", error_code: "none", daily_row_count: 2, new_next_date_rows: 1, stored_value: 120, record_date: "2026-08-25" });
assert.equal(recheck(s).ok, true);
console.log("ok  C19: stale/timeout·행1·105 → 다시 시도(T04-RECOVER-D2) → fresh/none·행2·신규 1행(2026-08-25)·120");

// 4) live 정규화: 원자료 값 = 저장값, 원천 시각 변환, 형식 변경은 schema_error
const sample = { utc_offset_seconds: 32400, current_units: { temperature_2m: "°C" }, current: { time: "2026-10-29T15:45", temperature_2m: 14.3 } };
const { reading, raw } = normalizeOpenMeteo(sample, "2026-10-29T06:50:12.000Z");
assert.equal(reading.normalized_value, raw.value);
assert.equal(reading.source_time, "2026-10-29T06:45:00.000Z");
assert.equal(reading.record_date, "2026-10-29");
assert.throws(() => normalizeOpenMeteo({ ...sample, current: { time: "x", temperature_2m: "14.3" } }, "2026-10-29T06:50:12.000Z"), (e) => e.code === "schema_error");
console.log("ok  live 정규화: 원자료 14.3 = 저장값 14.3, 15:45 KST → 06:45Z, 형식 변경 → schema_error");
console.log("모든 검사 통과");
