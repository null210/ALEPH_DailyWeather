// GitHub Actions에서 실행: 실제 공개 원천(Open-Meteo)을 조회해 data/live-state.json을 갱신합니다.
// 비밀키를 쓰지 않습니다. 실패는 일별 행을 바꾸지 않고 상태(stale/코드)만 남깁니다.
import { readFile, writeFile } from "node:fs/promises";
import { resetEvaluationState, kstDate } from "../lib/core.js";
import { runLive } from "../lib/adapters.js";

const path = new URL("../data/live-state.json", import.meta.url);
const MAX_DATES = Number(process.env.LIVE_MAX_DATES || 2); // 실제 날짜 2건이 모이면 새 날짜 행을 만들지 않음

let state;
try { state = JSON.parse(await readFile(path, "utf8")); } catch { state = resetEvaluationState(); }

const today = kstDate(new Date().toISOString());
const dates = [...new Set(state.daily_readings.map((r) => r.record_date))];
if (dates.length >= MAX_DATES && !dates.includes(today)) {
  console.log(`실제 날짜 ${dates.join(", ")} ${dates.length}건이 이미 보존되어 있어 새 날짜(${today}) 행을 만들지 않습니다. (LIVE_MAX_DATES=${MAX_DATES})`);
  process.exit(0);
}

const next = await runLive(state, { deadlineMs: 10000 });
await writeFile(path, JSON.stringify(next, null, 2) + "\n");
const r = next.last_run;
if (r.outcome === "success") {
  const row = next.daily_readings.find((x) => x.record_date === next.current_reading.record_date);
  console.log(`성공: ${row.record_date} ${row.normalized_value} ${row.unit} (원자료 ${row.raw.path}=${row.raw.value}, 원천 시각 ${next.current_reading.source_time}) · 행 ${next.daily_readings.length}건`);
} else {
  console.log(`실패: stale/${r.error_code} · ${r.message} · 일별 행 ${next.daily_readings.length}건 그대로`);
}
