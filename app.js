// app.js — 저장된 실제 조회 결과(data/live-state.json)를 그대로 보여주고, 공개 fixture를 합성 재생합니다.
// 화면은 외부 API를 직접 부르지 않습니다. 실제 조회는 GitHub Actions(scripts/collect.mjs)가 하고 결과를 저장합니다.
import { resetEvaluationState, comparisonFor, recheck, kstLabel, ERROR_GUIDE, TIMEZONE } from "./lib/core.js";
import { runFixture, SEQUENCES, FIXTURE_FILES, LIVE_SOURCE } from "./lib/adapters.js";

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

const app = {
  view: "live",                    // live | replay
  live: null, liveError: null, liveLoadedAt: null,
  replay: resetEvaluationState(), replayLog: [], busy: false,
};

/* ---------------- 데이터 ---------------- */
async function loadLive() {
  try {
    const r = await fetch(`data/live-state.json?t=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    app.live = await r.json();
    app.liveError = null;
  } catch (e) {
    app.liveError = "저장된 조회 결과를 읽지 못했습니다: " + e.message;
  }
  app.liveLoadedAt = new Date().toISOString();
  render();
}

const fixtureCache = {};
async function loadFixture(id) {
  if (!fixtureCache[id]) {
    const r = await fetch(`fixtures/${FIXTURE_FILES[id]}`, { cache: "no-store" });
    if (!r.ok) throw new Error(`${id}: HTTP ${r.status}`);
    fixtureCache[id] = await r.json();
  }
  return fixtureCache[id];
}

async function runIds(ids, { reset = false } = {}) {
  if (app.busy) return;
  app.busy = true;
  if (reset) { app.replay = resetEvaluationState(); app.replayLog = []; }
  render();
  try {
    for (const id of ids) {
      app.replayLog.push({ id, state: "running" });
      render();
      const fx = await loadFixture(id);
      app.replay = await runFixture(app.replay, fx);
      const st = app.replay.status;
      const ok = st.freshness === fx.expected.freshness && st.error_code === fx.expected.error_code &&
        app.replay.daily_readings.length === fx.expected.row_count &&
        (app.replay.current_reading?.normalized_value ?? null) === fx.expected.stored_value;
      app.replayLog[app.replayLog.length - 1] = { id, state: "done", status: `${st.freshness}/${st.error_code}`, rows: app.replay.daily_readings.length, matchesExpected: ok };
    }
  } finally {
    app.busy = false;
    render();
  }
}

function resetReplay() {
  app.replay = resetEvaluationState();
  app.replayLog = [];
  render();
}

/* 다시 시도: 합성 재생에서는 공개 asset T04-RECOVER-D2, 실제 화면에서는 저장된 최신 결과를 다시 읽음 */
function retry() {
  if (app.view === "replay") return runIds(["T04-RECOVER-D2"]);
  return loadLive();
}

/* ---------------- 화면 ---------------- */
function fmt(v) { return typeof v === "number" ? String(v) : "—"; }

function deltaText(c) {
  if (!c || c.state === "insufficient") return `<span class="flat">비교 불가 · 앞 날짜 기록 없음</span>`;
  if (c.state === "unit_mismatch") return `<span class="flat">비교 불가 · 단위 다름</span>`;
  const sign = c.signed > 0 ? "+" : c.signed < 0 ? "−" : "±";
  const label = c.is_yesterday ? "어제 대비" : `직전 기록(${c.previous_date}) 대비`;
  const word = { increase: "증가", decrease: "감소", unchanged: "변화 없음" }[c.direction];
  return `<span class="${c.direction}">${label} ${sign}${Math.abs(c.signed)} ${esc(c.unit)} (${word})</span>`;
}

function boardHtml(s, { mode }) {
  const st = s.status;
  const cur = s.current_reading;
  const latestRow = cur ? s.daily_readings.find((r) => r.record_date === cur.record_date) : null;
  const stale = st?.freshness === "stale";
  const chip = !st ? `<span class="chip wait" data-freshness="none">조회 기록 없음</span>`
    : st.freshness === "fresh" ? `<span class="chip ok" data-freshness="fresh">fresh · none</span>`
    : `<span class="chip bad" data-freshness="stale">stale · ${esc(st.error_code)}</span>`;
  const g = stale ? ERROR_GUIDE[st.error_code] : null;
  const ra = s.last_run?.retry_after_seconds;
  const errBox = g ? `
    <div class="err" role="alert" data-error-code="${esc(st.error_code)}">
      <strong>${esc(g.title)}</strong>
      <span>${esc(g.what)}</span>
      ${s.last_run?.message ? `<span class="muted mono small">${esc(s.last_run.message)}</span>` : ""}
      ${ra ? `<span class="mono small">Retry-After: ${ra}초</span>` : ""}
      <span class="next"><b>다음 행동</b> · ${esc(g.next)}</span>
      <button type="button" class="btn" data-action="retry" id="retry-${mode}">다시 시도${mode === "replay" ? " (T04-RECOVER-D2 재생)" : " (저장된 최신 결과 다시 읽기)"}</button>
    </div>` : "";
  const comp = latestRow ? comparisonFor(s.daily_readings, latestRow) : null;
  const srcTime = cur ? (cur.source_time ? `${kstLabel(cur.source_time)} <span class="muted small">(${esc(cur.source_time)})</span>` : "원천이 시각을 주지 않음 (source_time: null)") : "—";

  const rows = s.daily_readings.map((r) => `
    <tr data-record-id="${esc(r.record_id)}">
      <td class="mono">${esc(r.record_date)}</td>
      <td class="mono small">${esc(r.record_id)}</td>
      <td class="mono">${r.raw ? `${esc(r.raw.path)} = ${esc(JSON.stringify(r.raw.value))}` : `<span class="muted">payload.normalized_value = ${esc(JSON.stringify(r.reading.normalized_value))}</span>`}</td>
      <td class="mono strong">${fmt(r.normalized_value)}</td>
      <td>${esc(r.unit)}</td>
      <td class="mono small">${esc(r.reading.source_time ?? "null")}</td>
      <td class="mono small">${esc(r.last_fetched_at)}</td>
      <td class="url small"><a href="${esc(r.reading.source_url)}" target="_blank" rel="noopener">${esc(r.reading.source_url)}</a></td>
      <td class="mono">${deltaText(comparisonFor(s.daily_readings, r))}</td>
    </tr>`).join("");

  const rc = recheck(s);
  const recheckHtml = s.daily_readings.length < 2
    ? `<p class="muted">서로 다른 ${TIMEZONE} 날짜의 기록이 2건이 되면, 저장된 두 값으로 변화값을 다시 계산해 화면값과 대조합니다. 지금 ${s.daily_readings.length}건입니다.</p>`
    : `<ul class="vlist">
        ${rc.rows.map((x) => `<li class="mono">${esc(x.record_date)}: ${x.raw_value !== null ? `원자료 ${esc(JSON.stringify(x.raw_value))} → ` : ""}저장값 ${fmt(x.stored_value)} ${esc(x.unit)} → 화면 ${fmt(x.stored_value)} <b class="${x.match ? "okc" : "badc"}">${x.match ? "일치" : "불일치"}</b></li>`).join("")}
        <li class="mono">변화 = ${fmt(rc.rows.at(-1).stored_value)} − ${fmt(rc.rows.at(-2).stored_value)} = ${rc.delta.independent} ${esc(rc.delta.unit)} · 화면 ${rc.delta.shown} <b class="${rc.delta.match ? "okc" : "badc"}">${rc.delta.match ? "일치" : "불일치"}</b></li>
      </ul>`;

  return `
  <section class="hero ${stale ? "is-stale" : ""}" data-mode="${mode}" data-freshness="${esc(st?.freshness ?? "none")}" data-error-code="${esc(st?.error_code ?? "none")}">
    <div class="lead">
      <div class="row"><h2 class="plain">${mode === "live" ? "서울 기온 · 지상 2m" : "합성 지표 (aleph-demo-index)"}</h2>${chip}</div>
      <div class="big"><span class="num" data-field="value">${cur ? fmt(cur.normalized_value) : "—"}</span><span class="unit" data-field="unit">${esc(cur?.unit ?? "")}</span></div>
      ${stale && cur ? `<span class="stale" data-field="stale-label">오래된 값 · 마지막 정상 조회 ${esc(kstLabel(cur.fetched_at))}. 최근 조회는 실패했습니다.</span>` : ""}
      ${!cur ? `<span class="muted">아직 정상 조회된 값이 없습니다.${mode === "live" ? " 첫 자동 수집 뒤에 표시됩니다." : " 아래 재생 버튼으로 시작하세요."}</span>` : ""}
      ${comp ? `<div class="delta" data-field="delta">${deltaText(comp)}</div>` : ""}
      ${mode === "live" ? `<p class="meaning">${esc(LIVE_SOURCE.meaning)}</p>` : `<p class="meaning">공개 fixture의 합성 값입니다. 실제 데이터가 아니며, 날짜도 합성 시계입니다.</p>`}
    </div>
    <div class="lead">
      ${errBox}
      <dl>
        <dt>값</dt><dd class="mono" data-field="value-2">${cur ? fmt(cur.normalized_value) : "—"}</dd>
        <dt>단위</dt><dd data-field="unit-2">${esc(cur?.unit ?? "—")}</dd>
        <dt>출처</dt><dd data-field="source">${cur ? `${esc(cur.source_name)}<br><a class="small mono" href="${esc(cur.source_url)}" target="_blank" rel="noopener">${esc(cur.source_url)}</a>` : "—"}</dd>
        <dt>출처 시각</dt><dd class="mono" data-field="source-time">${srcTime}</dd>
        <dt>조회 시각</dt><dd class="mono" data-field="fetched-at">${cur ? `${kstLabel(cur.fetched_at)} <span class="muted small">(${esc(cur.fetched_at)})</span>` : "—"}</dd>
        <dt>기준 시간대</dt><dd class="mono" data-field="timezone">${esc(cur?.record_timezone ?? TIMEZONE)} (UTC+09:00)</dd>
        <dt>기록 날짜</dt><dd class="mono" data-field="record-date">${esc(cur?.record_date ?? "—")}</dd>
        ${s.last_run ? `<dt>마지막 시도</dt><dd class="mono small">${esc(s.last_run.attempted_at ?? s.last_run.virtual_now ?? "")} · ${esc(s.last_run.outcome)}${s.last_run.fixture_id ? " · " + esc(s.last_run.fixture_id) : ""}</dd>` : ""}
      </dl>
    </div>
  </section>

  <section>
    <h2>일별 저장 (${s.daily_readings.length}행) · 같은 ${TIMEZONE} 날짜는 한 행으로 갱신</h2>
    <div class="tbl"><table>
      <thead><tr><th>기록 날짜</th><th>record_id</th><th>원자료</th><th>저장값</th><th>단위</th><th>원천 관측 시각</th><th>조회 시각</th><th>공개 원천 URL</th><th>전일 대비 (재계산)</th></tr></thead>
      <tbody>${rows || `<tr><td colspan="9" class="muted">저장된 일별 행이 없습니다.</td></tr>`}</tbody>
    </table></div>
  </section>

  <section>
    <h2>저장값으로 다시 계산</h2>
    ${recheckHtml}
  </section>`;
}

function render() {
  document.body.dataset.view = app.view;
  $("tab-live").setAttribute("aria-selected", app.view === "live");
  $("tab-replay").setAttribute("aria-selected", app.view === "replay");
  $("replayPanel").hidden = app.view !== "replay";
  $("liveNote").hidden = app.view !== "live";

  if (app.view === "live") {
    $("board").innerHTML = app.liveError
      ? `<div class="err"><strong>저장된 조회 결과를 읽지 못했습니다</strong><span>${esc(app.liveError)}</span><span class="next"><b>다음 행동</b> · 잠시 뒤 다시 읽어 보세요.</span><button class="btn" data-action="retry">다시 시도</button></div>`
      : app.live ? boardHtml(app.live, { mode: "live" }) : `<p class="muted">불러오는 중…</p>`;
    $("liveLoaded").textContent = app.liveLoadedAt ? `이 화면이 저장 결과를 읽은 시각 ${kstLabel(app.liveLoadedAt)}` : "";
  } else {
    $("board").innerHTML = boardHtml(app.replay, { mode: "replay" });
    $("replayLog").innerHTML = app.replayLog.length
      ? app.replayLog.map((l) => `<li class="mono">${esc(l.id)} ${l.state === "running" ? "… 재생 중" : `→ ${esc(l.status)} · 행 ${l.rows} · expected ${l.matchesExpected ? "일치" : "불일치"}`}</li>`).join("")
      : `<li class="muted">초기화된 빈 상태입니다.</li>`;
    document.querySelectorAll("[data-run]").forEach((b) => { b.disabled = app.busy; });
  }

  const s = app.view === "live" ? app.live : app.replay;
  $("stateJson").textContent = JSON.stringify(s ? {
    view: app.view,
    status: s.status,
    daily_row_count: s.daily_readings.length,
    record_dates: s.daily_readings.map((r) => r.record_date),
    last_good_value: s.current_reading?.normalized_value ?? null,
    unit: s.current_reading?.unit ?? null,
    last_comparison: s.last_comparison,
    last_run: s.last_run,
  } : null, null, 2);
}

/* ---------------- 이벤트 ---------------- */
function setView(v) {
  app.view = v === "replay" ? "replay" : "live";
  if (location.hash !== "#" + app.view) history.replaceState(null, "", "#" + app.view);
  render();
}

document.addEventListener("click", (e) => {
  const t = e.target.closest("[data-action],[data-run],[data-view]");
  if (!t) return;
  if (t.dataset.view) return setView(t.dataset.view);
  if (t.dataset.action === "retry") return retry();
  if (t.dataset.action === "reset") return resetReplay();
  if (t.dataset.run) {
    const [kind, arg] = t.dataset.run.split(":");
    if (kind === "seq") {
      const ids = arg === "success" ? SEQUENCES.success
        : arg === "recovery" ? SEQUENCES.recovery.slice(0, 3)          // 회복표는 TIMEOUT 직후에서 시작, 다시 시도로 D2
        : [...SEQUENCES.failureBaseline, arg];
      return runIds(ids, { reset: true });
    }
    return runIds([arg]);
  }
});
window.addEventListener("hashchange", () => setView(location.hash.slice(1)));

/* 자동 확인용 공개 함수 (합성 상태만 다룸) */
window.T04 = Object.freeze({
  reset: () => { setView("replay"); resetReplay(); return app.replay; },
  run: async (id) => { setView("replay"); await runIds([id]); return app.replay; },
  runSequence: async (ids) => { setView("replay"); await runIds(ids, { reset: true }); return app.replay; },
  retry: async () => { await retry(); return app.view === "replay" ? app.replay : app.live; },
  state: () => JSON.parse(JSON.stringify(app.view === "replay" ? app.replay : app.live)),
  view: setView,
});

setView(location.hash.slice(1) || "live");
loadLive();
