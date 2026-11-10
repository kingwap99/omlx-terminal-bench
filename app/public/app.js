const $ = (id) => document.getElementById(id);
const api = async (path, opts = {}) => {
  const res = await fetch(path, { headers: { "content-type": "application/json" }, ...opts });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
};
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const fmtMin = (m) => (m == null ? "—" : m >= 60 ? `${Math.floor(m / 60)}h${String(Math.round(m % 60)).padStart(2, "0")}` : `${m.toFixed ? m.toFixed(1) : m}m`);
const fmtPct = (p) => (p == null ? "—" : `${p}%`);
const STATUS = {
  running: ["running", "blue"], paused: ["paused", "yellow"], completed: ["complete", "green"], error: ["error", "red"],
  canceled: ["stopped", "gray"], queued: ["queued", "yellow"], imported: ["imported", "gray"],
};
const statusBadge = (s) => { const [t, c] = STATUS[s] || [s, "gray"]; return `<span class="badge ${c}">${t}</span>`; };

let state = { models: [], providers: [], providerId: "omlx", runs: [], tasks: {}, selectedModel: null, selectedRun: null, compareIds: new Set() };
let pollTimer = null;
let preferredModel = "";

function populatePreferred() {
  const sel = $("cfgPreferred");
  if (!sel) return;
  sel.innerHTML = '<option value="">(none)</option>' + state.models.map((m) => `<option value="${esc(m.id)}">${esc(m.id)}</option>`).join("");
  sel.value = preferredModel || "";
}

/* ---------------- tabs ---------------- */
document.querySelectorAll("nav button.tab").forEach((b) =>
  b.addEventListener("click", () => {
    document.querySelectorAll("nav button.tab").forEach((x) => x.classList.remove("active"));
    b.classList.add("active");
    document.querySelectorAll(".panel").forEach((p) => p.classList.add("hidden"));
    $(`tab-${b.dataset.tab}`).classList.remove("hidden");
    if (b.dataset.tab === "runs") refreshRuns();
    if (b.dataset.tab === "compare") renderComparePicker();
  })
);

/* ---------------- launch tab ---------------- */
async function refreshServer() {
  try {
    const provs = await api("/api/providers");
    state.providers = provs;
    const sel = $("selProvider");
    if (sel) {
      const keep = state.providerId;
      sel.innerHTML = provs.map((p) => `<option value="${esc(p.id)}">${esc(p.label)} — ${esc(p.baseUrl)}</option>`).join("");
      state.providerId = provs.some((p) => p.id === keep) ? keep : provs[0]?.id || "omlx";
      sel.value = state.providerId;
    }
    const pid = encodeURIComponent(state.providerId);
    const label = provs.find((p) => p.id === state.providerId)?.label || state.providerId;
    const st = await api(`/api/providers/${pid}/models`);
    $("serverBadge").textContent = st.error ? `${label}: ${st.error}` : `${label} online (${st.models.length} models)`;
    $("serverBadge").className = `badge ${st.error ? "red" : "green"}`;
    const meta = await api(`/api/providers/${pid}/status`).catch(() => null);
    const d = meta?.device || {};
    if (d.chip_name) {
      $("machineBadge").textContent = `Test host: ${d.chip_name}${d.chip_variant ? " " + d.chip_variant : ""} · DRAM ${d.memory_gb}GB · GPU ${d.gpu_cores} cores`;
      $("machineBadge").className = "badge blue";
    } else {
      $("machineBadge").textContent = `Provider: ${label}${st.error ? " (offline)" : ""}`;
      $("machineBadge").className = "badge gray";
    }
    state.models = st.models || [];
    renderModels();
    populatePreferred();
    renderProvidersEditor();
  } catch (e) {
    $("serverBadge").textContent = `Provider connection failed: ${e.message}`;
    $("serverBadge").className = "badge red";
  }
}

function renderModels() {
  const box = $("modelList");
  if (!state.models.length) { box.innerHTML = '<p class="muted">No models found or listing failed</p>'; return; }
  if (!state.selectedModel && preferredModel && state.models.some((m) => m.id === preferredModel)) state.selectedModel = preferredModel;
  box.innerHTML = state.models.map((m) => {
    const sizeGb = m.estimatedSize ? (m.estimatedSize / 1024 ** 3).toFixed(1) + " GB" : "";
    const canManage = state.providerId === "omlx";
    const badge = canManage ? m.loaded ? '<span class="badge green">loaded</span>' : m.isLoading ? '<span class="badge yellow">loading…</span>' : '<span class="badge gray">not loaded</span>' : '<span class="badge gray">available</span>';
    return `<div class="model-item ${state.selectedModel === m.id ? "selected" : ""}" data-model="${esc(m.id)}">
      <span class="grow"><b>${esc(m.id)}</b><div class="mid">context ${m.maxModelLen ?? "—"} · ${sizeGb}${m.maxContextWindow ? " · limit " + m.maxContextWindow : ""}</div></span>
      ${badge}
      ${canManage ? `<button class="small" data-act="load" data-model="${esc(m.id)}">${m.loaded ? "Preload" : "Load"}</button>` : ""}
      ${canManage && m.loaded && !m.isLoading ? `<button class="small danger" data-act="unload" data-model="${esc(m.id)}">Unload</button>` : ""}
    </div>`;
  }).join("");
  box.querySelectorAll(".model-item").forEach((el) =>
    el.addEventListener("click", (ev) => {
      if (ev.target.tagName === "BUTTON") return;
      state.selectedModel = el.dataset.model;
      renderModels();
    })
  );
  box.querySelectorAll("button[data-act]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      btn.disabled = true;
      try {
        if (btn.dataset.act === "load") await api("/api/omlx/load", { method: "POST", body: JSON.stringify({ model: btn.dataset.model }) });
        else await api("/api/omlx/unload", { method: "POST", body: JSON.stringify({ model: btn.dataset.model }) });
      } catch (e) { alert(e.message); }
      setTimeout(refreshServer, 1500);
    })
  );
}

async function loadDatasets() {
  const ds = await api("/api/datasets");
  $("selDataset").innerHTML = ds.map((d) => `<option value="${esc(d.name)}">${esc(d.name)} (${d.taskCount} tasks)</option>`).join("");
  $("selDataset").onchange = previewTasks;
  $("txtInclude").oninput = debounce(previewTasks, 350);
  $("txtExclude").oninput = debounce(previewTasks, 350);
  await previewTasks();
}

function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }

function globToRe(g) {
  return new RegExp("^" + g.split(/([*?])/).map((p) => (p === "*" ? ".*" : p === "?" ? "." : p.replace(/[.+^${}()|[\]\\]/g, "\\$&"))).join("") + "$");
}

async function previewTasks() {
  const ds = $("selDataset").value;
  if (!ds) return;
  if (!state.tasks[ds]) state.tasks[ds] = await api(`/api/tasks?dataset=${encodeURIComponent(ds)}`);
  const all = state.tasks[ds];
  const inc = $("txtInclude").value.trim().split(/[\s,]+/).filter(Boolean);
  const excCfg = (await getCachedConfig()).harbor?.excludeTaskNames || [];
  const exc = [...excCfg, ...$("txtExclude").value.split(/\n+/).map((s) => s.trim()).filter(Boolean)];
  let sel = all;
  if (inc.length) sel = sel.filter((t) => inc.some((g) => globToRe(g).test(t.name)));
  if (exc.length) sel = sel.filter((t) => !exc.some((g) => globToRe(g).test(t.name)));
  const diff = {};
  for (const t of sel) diff[t.difficulty] = (diff[t.difficulty] || 0) + 1;
  $("taskCount").textContent = `${sel.length} / ${all.length} tasks selected (${Object.entries(diff).map(([k, v]) => `${k} ${v}`).join(", ")})`;
  return sel.map((t) => t.name);
}

let cfgCache = null;
async function getCachedConfig() { if (!cfgCache) cfgCache = await api("/api/config"); return cfgCache; }

$("btnStart").addEventListener("click", async () => {
  if (!state.selectedModel) { $("startMsg").textContent = "Pick a model first"; return; }
  const names = await previewTasks();
  if (!names || !names.length) { $("startMsg").textContent = "No tasks after filtering"; return; }
  $("btnStart").disabled = true;
  $("startMsg").textContent = "Creating run…";
  try {
    const run = await api("/api/runs", {
      method: "POST",
      body: JSON.stringify({
        model: state.selectedModel,
        providerId: state.providerId,
        name: $("txtRunName").value.trim() || undefined,
        dataset: $("selDataset").value,
        includeTaskNames: $("txtInclude").value.trim().split(/[\s,]+/).filter(Boolean),
        excludeTaskNames: $("txtExclude").value.split(/\n+/).map((s) => s.trim()).filter(Boolean),
        batchTimeoutMin: Number($("numTimeout").value) || 300,
        agentTimeoutMultiplier: Number($("numTimeoutMult").value) || 1,
        nAttempts: Number($("numAttempts").value) || 1,
        preload: $("chkPreload").checked,
      }),
    });
    $("startMsg").textContent = run.status === "queued" ? "Another run is active — this one is queued." : "Started";
    document.querySelector('nav button[data-tab="runs"]').click();
    openRun(run.id);
  } catch (e) {
    $("startMsg").textContent = `Failed: ${e.message}`;
  } finally {
    $("btnStart").disabled = false;
  }
});

/* ---------------- runs tab ---------------- */
async function refreshRuns() {
  state.runs = await api("/api/runs");
  const box = $("runsTable");
  if (!state.runs.length) { box.innerHTML = '<p class="muted">No runs yet</p>'; return; }
  box.innerHTML = `<table><thead><tr><th>Name</th><th>Status</th><th class="num">Progress</th><th class="num">Passed</th><th class="num">Clean</th><th class="num">Median</th><th class="num">Elapsed</th><th class="num">Timeouts</th><th>Machine</th><th>Created</th></tr></thead><tbody>${state.runs
    .map((r) => {
      const s = r.summary || {};
      return `<tr data-run="${esc(r.id)}" style="cursor:pointer">
        <td><b>${esc(r.name)}</b>${r.active ? ' <span class="badge blue">live</span>' : ""}</td>
        <td>${statusBadge(r.status)}${r.runningOrphan ? '<span class="badge yellow">interrupted</span>' : ""}</td>
        <td class="num">${s.scored ?? 0}/${r.tasks.length}</td>
        <td class="num">${s.passed ?? 0} (${fmtPct(s.rawPct)})</td>
        <td class="num">${fmtPct(s.cleanPct)}${s.flagged ? ` ⚠${s.flagged}` : ""}</td>
        <td class="num">${fmtMin(s.medianMin)}</td>
        <td class="num">${r.elapsedSec != null ? fmtMin(r.elapsedSec / 60) : "—"}</td>
        <td class="num">${s.timeouts ?? 0}</td>
        <td>${esc(r.machine?.chip || "—")}${r.machine?.memoryGb ? ` · ${r.machine.memoryGb}GB` : ""}</td>
        <td class="muted">${esc((r.createdAt || "").slice(0, 16).replace("T", " "))}</td>
      </tr>`;
    })
    .join("")}</tbody></table>`;
  box.querySelectorAll("tr[data-run]").forEach((tr) => tr.addEventListener("click", () => openRun(tr.dataset.run)));
  if (state.selectedRun) refreshRunDetail();
}

async function openRun(id) {
  state.selectedRun = id;
  await refreshRunDetail();
  startPolling();
}

function startPolling() {
  clearInterval(pollTimer);
  pollTimer = setInterval(async () => {
    if ($("tab-runs").classList.contains("hidden")) { clearInterval(pollTimer); return; }
    await refreshRuns();
  }, 4000);
}

async function refreshRunDetail() {
  let r;
  try { r = await api(`/api/runs/${encodeURIComponent(state.selectedRun)}`); } catch { $("runDetail").innerHTML = ""; return; }
  const s = r.summary || {};
  const p = r.progress || {};
  const machine = r.machine || {};
  const pctDone = p.total ? Math.round((100 * p.done) / p.total) : 0;
  const recs = (r.records || []).slice().sort((a, b) => String(a.task).localeCompare(String(b.task)));
  const byTask = new Map();
  for (const x of recs) {
    if (!byTask.has(x.task)) byTask.set(x.task, []);
    byTask.get(x.task).push(x);
  }
  const rows = [...byTask.entries()].map(([task, list]) => {
    const first = list[0];
    const multi = list.length > 1;
    const passedN = list.filter((x) => x.passed).length;
    const timeouts = list.filter((x) => x.timedOut).length;
    let resultCell;
    if (multi) {
      const cls = passedN === list.length ? "pass" : passedN > 0 ? "" : "fail";
      resultCell = `<span class="${cls}">${passedN}/${list.length} pass</span>` + (timeouts ? ` <span class="muted">⏱${timeouts}</span>` : "");
    } else if (!first.scored) {
      resultCell = `<span class="muted">${esc(first.exceptionType || "unscored")}</span>`;
    } else if (first.verifierAnomaly) {
      resultCell = '<span class="fail" title="verifier produced no test output">⚠ verifier</span>';
    } else {
      resultCell = first.passed ? '<span class="pass">✅ pass</span>' : first.timedOut ? '<span class="fail">⏱ timeout</span>' : '<span class="fail">❌ fail</span>';
    }
    const durSum = list.reduce((a, x) => a + (x.durationSec || 0), 0);
    const tokIn = list.reduce((a, x) => a + (x.inputTokens || 0), 0);
    const tokOut = list.reduce((a, x) => a + (x.outputTokens || 0), 0);
    const tools = list.reduce((a, x) => a + (x.toolCalls || 0), 0);
    const tps = durSum ? (tokOut / durSum).toFixed(1) : "—";
    const flagged = list.find((x) => x.flagged);
    const rowCls = passedN === list.length ? "ok-flag" : passedN > 0 ? "" : "bad-flag";
    const timeCell = multi ? list.map((x) => fmtMin((x.durationSec || 0) / 60)).join(" / ") : first.durationSec != null ? fmtMin(first.durationSec / 60) : "—";
    return `<tr class="${rowCls}">
      <td>${esc(task)}</td><td>${esc(first.difficulty || "—")}</td>
      <td>${resultCell}</td>
      <td class="num">${timeCell}</td>
      <td class="num">${tools}</td><td class="num">${(tokIn / 1000).toFixed(0)}K/${(tokOut / 1000).toFixed(1)}K</td>
      <td class="num">${tps}</td>
      <td>${flagged ? `⚠ ${esc((flagged.flags || []).join(", "))}` : "—"}</td></tr>`;
  }).join("");
  const nAtt = Number(r.options?.nAttempts || 1);
  const agentSumMin = recs.reduce((a, x) => a + (x.durationSec || 0), 0) / 60;
  const pending = r.tasks.filter((t) => recs.filter((x) => x.task === t.name && x.scored).length < nAtt).map((t) => t.name);
  const cur = r.currentBatch ? `Current batch: ${r.currentBatch.tasks.join(", ")}` : "";
  $("runDetail").innerHTML = `<div class="card">
    <h2>${esc(r.name)} ${statusBadge(r.status)}</h2>
    ${r.note ? `<p class="muted">${esc(r.note)}</p>` : ""}
    <progress max="${p.total || 1}" value="${p.done}"></progress>
    <p class="muted">Progress ${p.done}/${p.total} (${pctDone}%) · elapsed ${fmtMin((p.elapsedSec || 0) / 60)}${p.etaSec != null && r.status === "running" ? ` · ETA ${fmtMin(p.etaSec / 60)}` : ""}　${esc(cur)}</p>
    <div class="kv">
      <div><b>Model</b>${esc(r.model)}</div><div><b>Agent</b>${esc(r.agent)} ${esc(r.agentVersion || "")}</div>
      <div><b>Dataset</b>${esc(r.dataset)} (${p.total} tasks)</div><div><b>Run mode</b>${(r.options?.batchConcurrency ?? 1) === 1 ? "serial" : "parallel ×" + r.options.batchConcurrency}</div>
      <div><b>Agent timeout</b>${r.options?.agentTimeoutMultiplier && r.options.agentTimeoutMultiplier !== 1 ? `×${r.options.agentTimeoutMultiplier}` : "dataset default"}</div>
      <div><b>Attempts per task</b>${nAtt}${nAtt > 1 ? ` · all-attempt pass ${s.taskPassedAll ?? 0}/${s.taskScored ?? 0} · any ${s.taskPassedAny ?? 0}/${s.taskScored ?? 0}` : ""}</div>
      <div><b>Leak-checked</b>${fmtPct(s.cleanPct)} (${s.cleanPassed ?? 0}/${s.clean ?? 0})</div><div><b>Raw pass</b>${s.passed ?? 0}/${s.scored ?? 0} (${fmtPct(s.rawPct)})</div>
      <div><b>Timeouts</b>${s.timeouts ?? 0}</div><div><b>Leak flags</b>${s.flagged ?? 0} (${s.flaggedPasses ?? 0} passing)</div>
      <div><b>Verifier anomalies</b>${s.verifierAnomalies ?? 0}</div>
      <div><b>Median time</b>${fmtMin(s.medianMin)}</div><div><b>By difficulty</b>${Object.entries(s.byDifficulty || {}).map(([k, v]) => `${k} ${v.rawPct}%`).join(", ") || "—"}</div>
      <div><b>Total time</b>${p.elapsedSec ? fmtMin(p.elapsedSec / 60) : "—"}</div><div><b>Agent time (sum)</b>${agentSumMin ? fmtMin(agentSumMin) : "—"}</div>
    </div>
    <h3>Host hardware (captured at start)</h3>
    <div class="kv">
      <div><b>Chip</b>${esc(machine.chip || machine.chipName || "—")}</div>
      <div><b>DRAM</b>${machine.memoryGb != null ? machine.memoryGb + " GB" : "—"}</div>
      <div><b>GPU cores</b>${machine.gpuCores != null ? machine.gpuCores : "—"}</div>
      <div><b>oMLX</b>${esc(machine.omlxVersion || "—")}${machine.engines?.mlx ? ` (MLX ${esc(machine.engines.mlx.version)})` : ""}</div>
      <div><b>Controller</b>${esc(machine.local?.hostname || "—")} · ${esc(machine.local?.platform || "")}</div>
      <div><b>Snapshot</b>${esc((machine.capturedAt || "").slice(0, 19).replace("T", " "))}</div>
    </div>
    <div class="row" style="margin-top:12px">
      ${r.status === "running" || r.status === "queued" ? `
        <button class="small" data-act="pause">Pause (after current batch)</button>
        <button class="small danger" data-act="force">Kill batch and pause now</button>
        <button class="small danger" data-act="cancel">Stop run</button>` : ""}
      ${["paused", "error", "canceled", "completed"].includes(r.status) && p.remaining > 0 ? `<button class="small" data-act="start">Resume (${p.remaining} tasks left)</button>` : ""}
      ${!r.runtime?.active ? `<a class="small" style="text-decoration:none" href="/api/runs/${encodeURIComponent(r.id)}/export.csv"><button class="small">Export CSV</button></a>
        <button class="small danger" data-act="delete">Delete run</button>` : ""}
    </div>
    <h3>Per-task results</h3>
    <div class="table-wrap"><table><thead><tr><th>Task</th><th>Difficulty</th><th>Result</th><th class="num">Time</th><th class="num">Tool calls</th><th class="num">tokens in/out</th><th class="num">tok/s</th><th>Leak check</th></tr></thead><tbody>${rows || '<tr><td colspan="8" class="muted">No completed tasks yet</td></tr>'}</tbody></table></div>
    ${pending.length ? `<p class="muted">Pending: ${esc(pending.slice(0, 40).join(", "))}${pending.length > 40 ? `… (${pending.length} total)` : ""}</p>` : ""}
    <h3>Runner log (last 120 lines)</h3><div class="log">${esc(r.logTail || "(no log yet)")}</div>
  </div>`;
  $("runDetail").querySelectorAll("button[data-act]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      const act = btn.dataset.act;
      btn.disabled = true;
      try {
        if (act === "pause") await api(`/api/runs/${r.id}/pause`, { method: "POST", body: "{}" });
        else if (act === "force") await api(`/api/runs/${r.id}/pause`, { method: "POST", body: JSON.stringify({ force: true }) });
        else if (act === "cancel") await api(`/api/runs/${r.id}/cancel`, { method: "POST", body: "{}" });
        else if (act === "start") {
          const res = await api(`/api/runs/${r.id}/start`, { method: "POST", body: "{}" });
          if (res.started === false) alert(res.reason && res.reason.startsWith("another-run-active") ? "Another run is already active. Pause or stop it first." : "Could not start: " + (res.reason || "unknown"));
        }
        else if (act === "delete") {
          if (!confirm(`Delete "${r.name}"? All records and trial files will be removed.`)) { btn.disabled = false; return; }
          await api(`/api/runs/${r.id}`, { method: "DELETE" });
          state.selectedRun = null;
          $("runDetail").innerHTML = "";
        }
      } catch (e) { alert(e.message); }
      await refreshRuns();
    })
  );
}

/* ---------------- compare tab ---------------- */
let compareRows = [];
const DIFF_ORDER = { easy: 0, medium: 1, hard: 2, unknown: 9 };

async function refreshRunsSilent() {
  state.runs = await api("/api/runs");
}

async function renderComparePicker() {
  await refreshRunsSilent();
  const box = $("comparePicker");
  const items = state.runs.map((r) => ({
    id: r.id,
    label: r.name,
    sub: [
      r.model,
      (r.options?.batchConcurrency ?? 1) === 1 ? "serial" : "parallel ×" + r.options.batchConcurrency,
      "timeout ×" + (r.options?.agentTimeoutMultiplier ?? 1),
      "attempts " + (r.options?.nAttempts ?? 1),
      `${r.summary?.passed ?? 0}/${r.summary?.scored ?? 0} passed`,
    ].join(" · "),
  }));
  items.push({ id: "article", label: "📰 Article results (86 tasks)", sub: "published numbers · RTX 5080 + Strata · not directly comparable" });
  box.innerHTML =
    items
      .map(
        (i) => `<label class="pick ${state.compareIds.has(i.id) ? "on" : ""}" data-id="${esc(i.id)}">
        <input type="checkbox" ${state.compareIds.has(i.id) ? "checked" : ""} />
        <span class="pgrow"><b>${esc(i.label)}</b><div class="mid">${esc(i.sub)}</div></span></label>`
      )
      .join("") +
    `<div class="row" style="margin-top:8px"><button class="small" id="pickAll">Select all runs</button><button class="small" id="pickNone">Clear</button></div>`;
  box.querySelectorAll(".pick").forEach((el) =>
    el.addEventListener("click", (ev) => {
      ev.preventDefault();
      const id = el.dataset.id;
      state.compareIds.has(id) ? state.compareIds.delete(id) : state.compareIds.add(id);
      renderComparePicker();
    })
  );
  const all = $("pickAll");
  const none = $("pickNone");
  if (all) all.onclick = (e) => { e.preventDefault(); state.runs.forEach((r) => state.compareIds.add(r.id)); renderComparePicker(); };
  if (none) none.onclick = (e) => { e.preventDefault(); state.compareIds.clear(); renderComparePicker(); };
}

function pctBar(p, cls) {
  if (p == null) return '<span class="muted">—</span>';
  const w = Math.max(0, Math.min(100, p));
  return `<div class="bar ${cls}"><div class="fill" style="width:${w}%"></div><span class="lbl">${p}%</span></div>`;
}

function renderBars(rows) {
  $("barChart").innerHTML = rows
    .map(
      (r) => `<div class="brow">
      <div class="bname"><b>${esc(r.label)}</b><div class="mid">${esc(r.model)} · ${r.scored} tasks${r.kind === "reference" ? " · article" : ""}</div></div>
      <div class="bwrap" title="leak-checked pass rate">${pctBar(r.cleanPct, "clean")}<div class="mid">clean</div></div>
      <div class="bwrap" title="raw pass rate">${pctBar(r.rawPct, "raw")}<div class="mid">raw</div></div>
      <div class="bmeta">⏱ ${r.timeouts ?? "—"}<br />${r.elapsedSec ? fmtMin(r.elapsedSec / 60) : "—"}</div>
    </div>`
    )
    .join("");
  $("compareChart").classList.remove("hidden");
}

function diffCell(d) {
  const parts = [
    ["E", d?.easy?.rawPct],
    ["M", d?.medium?.rawPct],
    ["H", d?.hard?.rawPct],
  ];
  return `<div class="mini">${parts.map(([k, v]) => `<span class="chip-mini" title="${k === "E" ? "easy" : k === "M" ? "medium" : "hard"}">${k} ${v == null ? "—" : v + "%"}</span>`).join("")}</div>`;
}

function renderSummaryTable(rows) {
  const maxScored = Math.max(...rows.map((r) => r.scored || 0));
  $("compareTable").innerHTML = `<table class="cmp-table"><thead><tr>
      <th>Run</th><th class="num">Tasks</th><th class="num">Passed</th>
      <th>Leak-checked</th><th>Raw</th><th class="num">Timeouts</th><th class="num">Median</th><th class="num">Total</th>
      <th>Difficulty E / M / H</th></tr></thead><tbody>${rows
    .map((r) => `<tr>
      <td><b>${esc(r.label)}</b>${r.kind === "reference" ? ' <span class="badge gray">article</span>' : ""}
        <div class="mid">${esc(r.model)}${r.machine ? " · " + esc(r.machine) : ""}${r.memoryGb ? " · " + r.memoryGb + "GB" : ""}</div></td>
      <td class="num">${r.scored}${r.scored < maxScored ? ' <span class="badge yellow" title="fewer tasks than the largest selection">⚠</span>' : ""}</td>
      <td class="num"><b>${r.passed}</b> (${fmtPct(r.rawPct)})</td>
      <td>${pctBar(r.cleanPct, "clean")}</td>
      <td class="num">${fmtPct(r.rawPct)}</td>
      <td class="num">${r.timeouts ?? "—"}</td>
      <td class="num">${fmtMin(r.medianMin)}</td>
      <td class="num">${r.elapsedSec ? fmtMin(r.elapsedSec / 60) : "—"}</td>
      <td>${diffCell(r.byDifficulty)}</td>
    </tr>`)
    .join("")}</tbody></table>`;
  $("compareSummaryCard").classList.remove("hidden");
}

async function renderMatrix(rows) {
  const locals = rows.filter((r) => r.kind === "local");
  const card = $("matrixCard");
  if (!locals.length) {
    card.classList.add("hidden");
    return;
  }
  card.classList.remove("hidden");
  const ds = locals[0].dataset;
  state.diffCache = state.diffCache || {};
  if (!state.diffCache[ds]) state.diffCache[ds] = await api(`/api/tasks?dataset=${encodeURIComponent(ds)}`);
  const diffMap = Object.fromEntries(state.diffCache[ds].map((t) => [t.name, t.difficulty]));
  const tasks = [...new Set(locals.flatMap((r) => Object.keys(r.tasks || {})))];
  const onlyDiff = $("chkDiffOnly").checked;
  const sortBy = $("selMatrixSort").value;
  const statusOf = (r, t) => {
    const x = (r.tasks || {})[t];
    if (!x || !x.scored) return "none";
    if (x.passed) return "pass";
    return x.timedOut ? "timeout" : "fail";
  };
  let list = tasks.map((t) => {
    const st = locals.map((r) => statusOf(r, t));
    return { t, st, passes: st.filter((s) => s === "pass").length, diff: diffMap[t] || "unknown" };
  });
  if (onlyDiff) list = list.filter((x) => new Set(x.st).size > 1);
  if (sortBy === "difficulty") list.sort((a, b) => (DIFF_ORDER[a.diff] ?? 9) - (DIFF_ORDER[b.diff] ?? 9) || a.t.localeCompare(b.t));
  else if (sortBy === "passes") list.sort((a, b) => b.passes - a.passes || a.t.localeCompare(b.t));
  else list.sort((a, b) => a.t.localeCompare(b.t));
  const icon = { pass: "✅", fail: "❌", timeout: "⏱", none: "·" };
  const cls = { pass: "c-pass", fail: "c-fail", timeout: "c-timeout", none: "c-none" };
  const short = (r) => r.model.replace("Qwen3.8-Flash-Next-", "").replace("-mtp", "");
  $("compareDiff").innerHTML = `<table class="matrix-table"><thead><tr>
      <th class="stick">Task</th><th>Diff</th>
      ${locals.map((r) => `<th title="${esc(r.label)}">${esc(short(r))}<div class="mid">${esc(r.createdAt ? new Date(r.createdAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "")}${(r.options?.agentTimeoutMultiplier ?? 1) !== 1 ? " · ×" + r.options.agentTimeoutMultiplier : ""}</div></th>`).join("")}
    </tr></thead><tbody>${list
    .map(
      (x) => `<tr><td class="stick">${esc(x.t)}</td><td class="muted">${esc(x.diff)}</td>${x.st
        .map((s) => `<td class="${cls[s]}">${icon[s]}</td>`)
        .join("")}</tr>`
    )
    .join("")}</tbody>
    <tfoot><tr><td class="stick">Passed</td><td></td>${locals
      .map((r) => `<td><b>${Object.values(r.tasks || {}).filter((x) => x.passed).length}/${r.scored}</b></td>`)
      .join("")}</tr></tfoot></table>`;
  $("cmpMsg").textContent = `${list.length}${onlyDiff ? " differing" : " total"} task rows · ${locals.length} runs`;
}

async function renderCompare() {
  const ids = [...state.compareIds];
  if (ids.length < 2) {
    $("cmpMsg").textContent = "Pick at least two runs";
    return;
  }
  const { rows } = await api(`/api/compare?ids=${encodeURIComponent(ids.join(","))}`);
  if (!rows.length) {
    $("cmpMsg").textContent = "No data";
    return;
  }
  compareRows = rows;
  renderBars(rows);
  renderSummaryTable(rows);
  await renderMatrix(rows);
}

$("btnCompare").addEventListener("click", async () => {
  try {
    await renderCompare();
  } catch (e) {
    $("cmpMsg").textContent = e.message;
  }
});
$("chkDiffOnly").addEventListener("change", () => compareRows.length && renderMatrix(compareRows));
$("selMatrixSort").addEventListener("change", () => compareRows.length && renderMatrix(compareRows));

/* ---------------- settings tab ---------------- */
async function loadSettings() {
  const c = await api("/api/config");
  cfgCache = c;
  preferredModel = c.preferredModel || "";
  populatePreferred();
  if (c.version) {
    $("appVersion").textContent = `v${c.version}`;
    document.title = `oMLX Terminal-Bench Runner v${c.version}`;
  }
  $("cfgBaseUrl").value = c.omlx.baseUrl;
  $("cfgAgentVersion").value = c.harbor.agentVersion;
  $("cfgRunTimeout").value = c.harbor.runTimeoutMin;
  $("cfgTimeoutMult").value = c.harbor.agentTimeoutMultiplier ?? 1;
  $("cfgAttempts").value = c.harbor.nAttempts ?? 1;
  /* New-run form starts from the configured default. */
  if (document.activeElement !== $("numTimeoutMult")) $("numTimeoutMult").value = c.harbor.agentTimeoutMultiplier ?? 1;
  if (document.activeElement !== $("numAttempts")) $("numAttempts").value = c.harbor.nAttempts ?? 1;
  $("cfgNotify").checked = !!c.notify;
}
$("btnSaveCfg").addEventListener("click", async () => {
  const body = { omlx: { baseUrl: $("cfgBaseUrl").value.trim() } };
  if ($("cfgApiKey").value.trim()) body.omlx.apiKey = $("cfgApiKey").value.trim();
  await api("/api/config", { method: "PUT", body: JSON.stringify(body) });
  cfgCache = null;
  $("cfgMsg").textContent = "Saved";
  refreshServer();
});
$("btnSaveHarbor").addEventListener("click", async () => {
  await api("/api/config", {
    method: "PUT",
    body: JSON.stringify({ harbor: { agentVersion: $("cfgAgentVersion").value.trim(), runTimeoutMin: Number($("cfgRunTimeout").value), agentTimeoutMultiplier: Number($("cfgTimeoutMult").value) || 1, nAttempts: Number($("cfgAttempts").value) || 1 }, notify: $("cfgNotify").checked, preferredModel: $("cfgPreferred").value }),
  });
  cfgCache = null;
  const mult = Number($("cfgTimeoutMult").value) || 1;
  preferredModel = $("cfgPreferred").value;
  state.selectedModel = null;
  renderModels();
  $("numTimeoutMult").value = mult;
  $("cfgMsg").textContent = "Runner settings saved — new runs use agent timeout ×" + mult;
});

/* ---------------- providers ---------------- */
let provDraft = [];
function renderProvidersEditor() {
  const box = $("provList");
  if (!box) return;
  if (!provDraft.length) {
    provDraft = state.providers.map((p) => ({ id: p.id, label: p.label, baseUrl: p.baseUrl, containerBaseUrl: p.containerBaseUrl || "", apiKey: "" }));
  }
  box.innerHTML = provDraft
    .map(
      (p, i) => `<div class="row prov-row" data-i="${i}">
      <label>Label <input data-k="label" value="${esc(p.label)}" /></label>
      <label>Base URL <input data-k="baseUrl" value="${esc(p.baseUrl)}" style="min-width:260px" placeholder="host:port, without /v1" /></label>
      <label>Container URL <input data-k="containerBaseUrl" value="${esc(p.containerBaseUrl || "")}" style="min-width:240px" placeholder="for Docker: host.docker.internal:port" /></label>
      <label>API key <input data-k="apiKey" placeholder="${p.id && state.providers.find((x) => x.id === p.id)?.hasKey ? "set — blank keeps it" : "optional"}" /></label>
      ${p.id === "omlx" ? '<span class="badge gray">default</span>' : `<button class="small danger" data-del="${i}">Remove</button>`}
    </div>`
    )
    .join("");
  box.querySelectorAll("input[data-k]").forEach((inp) =>
    inp.addEventListener("input", (e) => {
      const row = e.target.closest(".prov-row");
      provDraft[Number(row.dataset.i)][e.target.dataset.k] = e.target.value;
    })
  );
  box.querySelectorAll("button[data-del]").forEach((b) =>
    b.addEventListener("click", () => {
      provDraft.splice(Number(b.dataset.del), 1);
      renderProvidersEditor();
    })
  );
}

function bindProviderControls() {
  const sel = $("selProvider");
  if (sel) sel.addEventListener("change", (e) => { state.providerId = e.target.value; state.selectedModel = null; refreshServer(); });
  const add = $("btnAddProv");
  if (add) add.addEventListener("click", () => { provDraft.push({ id: "", label: "Provider", baseUrl: "", apiKey: "" }); renderProvidersEditor(); });
  const save = $("btnSaveProv");
  if (save) save.addEventListener("click", async () => {
    const providers = provDraft.map((p, i) => ({ id: p.id || `prov-${i + 1}`, label: p.label, baseUrl: p.baseUrl, containerBaseUrl: p.containerBaseUrl, apiKey: p.apiKey }));
    try {
      await api("/api/providers", { method: "PUT", body: JSON.stringify({ providers }) });
      $("provMsg").textContent = "Saved";
      provDraft = [];
      await refreshServer();
    } catch (e) { $("provMsg").textContent = e.message; }
  });
}
bindProviderControls();

/* ---------------- boot ---------------- */
refreshServer();
loadDatasets();
loadSettings();
refreshRuns().then(() => {
  const live = state.runs.find((r) => r.active || r.status === "running");
  if (live) { document.querySelector('nav button[data-tab="runs"]').click(); openRun(live.id); }
});
setInterval(() => { if (!$("tab-launch").classList.contains("hidden")) { refreshServer(); } }, 15000);
