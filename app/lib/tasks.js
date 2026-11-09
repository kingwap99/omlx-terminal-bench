import fs from "node:fs";
import path from "node:path";

const LEAK_PATTERNS = [
  ["terminal-bench repo", /github\.com\/[^\s"']*terminal[-_]bench/i],
  ["terminal-bench dataset", /huggingface\.co\/(datasets|spaces)\/[^\s"']*terminal[-_]bench/i],
  ["tbench.ai", /tbench\.ai/i],
  ["terminal-bench registry", /terminal[-_]bench@\d|datasets\/terminal[-_]bench/i],
  ["terminal-bench canary", /terminal[-_]bench[-_]canary/i],
  ["harbor source", /harborframework\.com|harbor hub|harbor\.run|["']harbor (run|upload)/i],
];

/* --- tiny TOML reader for the handful of fields we need ------------------- */
export function parseTaskToml(text) {
  const meta = {};
  let section = "";
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const sec = /^\[([^\]]+)\]$/.exec(line);
    if (sec) {
      section = sec[1];
      continue;
    }
    const kv = /^([A-Za-z0-9_.\-]+)\s*=\s*(.+)$/.exec(line);
    if (!kv) continue;
    const key = kv[1];
    let val = kv[2].trim().replace(/,\s*$/, "");
    if (val.startsWith('"') && val.endsWith('"')) val = val.slice(1, -1);
    else if (val.startsWith("'") && val.endsWith("'")) val = val.slice(1, -1);
    else if (/^-?\d+(\.\d+)?$/.test(val)) val = parseFloat(val);
    if (section === "metadata") meta[key] = val;
    else if (section === "agent" && key === "timeout_sec") meta.agent_timeout_sec = val;
  }
  return meta;
}

export function listTasks(datasetDir) {
  const out = [];
  if (!fs.existsSync(datasetDir)) return out;
  for (const name of fs.readdirSync(datasetDir).sort()) {
    const dir = path.join(datasetDir, name);
    try {
      if (!fs.statSync(dir).isDirectory()) continue;
    } catch {
      continue;
    }
    const tomlPath = path.join(dir, "task.toml");
    if (!fs.existsSync(tomlPath)) continue;
    let meta = {};
    try {
      meta = parseTaskToml(fs.readFileSync(tomlPath, "utf8"));
    } catch {
      /* keep going */
    }
    out.push({
      name,
      difficulty: meta.difficulty || "unknown",
      category: meta.category || "unknown",
      agentTimeoutSec: typeof meta.agent_timeout_sec === "number" ? meta.agent_timeout_sec : null,
    });
  }
  return out;
}

export function matchesGlob(name, pattern) {
  if (!pattern.includes("*") && !pattern.includes("?")) return name === pattern;
  const re = new RegExp(
    "^" +
      pattern
        .split(/([*?])/)
        .map((p) => (p === "*" ? ".*" : p === "?" ? "." : p.replace(/[.+^${}()|[\]\\]/g, "\\$&")))
        .join("") +
      "$"
  );
  return re.test(name);
}

export function filterTasks(tasks, { include = [], exclude = [] }) {
  let sel = tasks;
  if (include.length) sel = sel.filter((t) => include.some((p) => matchesGlob(t.name, p)));
  if (exclude.length) sel = sel.filter((t) => !exclude.some((p) => matchesGlob(t.name, p)));
  return sel;
}

/* --- Harbor result.json -> compact record (mirrors analyze_jobs.py) -------- */
export function readTrialResult(trialDir) {
  const p = path.join(trialDir, "result.json");
  if (!fs.existsSync(p)) return null;
  try {
    return JSON.parse(fs.readFileSync(p, "utf8"));
  } catch {
    return null;
  }
}

function parseIso(v) {
  if (!v) return null;
  const d = new Date(String(v).replace("Z", "+00:00"));
  return Number.isNaN(d.getTime()) ? null : d;
}

function readText(p) {
  try {
    return fs.readFileSync(p, "utf8");
  } catch {
    return "";
  }
}

export function leakFlags(trialDir) {
  const texts = [readText(path.join(trialDir, "agent", "qwen-code.txt")), readText(path.join(trialDir, "agent", "trajectory.json"))].join("\n");
  const hits = [];
  for (const [label, re] of LEAK_PATTERNS) if (re.test(texts)) hits.push(label);
  return hits;
}

function countToolCalls(trialDir) {
  const p = path.join(trialDir, "agent", "trajectory.json");
  if (!fs.existsSync(p)) return 0;
  try {
    const traj = JSON.parse(fs.readFileSync(p, "utf8"));
    let n = 0;
    for (const step of traj.steps || []) n += (step.tool_calls || []).length;
    return n;
  } catch {
    /* trajectory may be huge or partial */
    const text = readText(p);
    return (text.match(/"tool_calls"/g) || []).length;
  }
}

export function recordFromTrial(task, trialDir, meta = {}) {
  const result = readTrialResult(trialDir);
  if (!result) return null;
  const exception = result.exception_info || {};
  const verifier = result.verifier_result || {};
  const rewards = verifier.rewards || {};
  let reward = null;
  if (Object.keys(rewards).length) reward = rewards.reward !== undefined ? rewards.reward : Number(Object.values(rewards)[0]);
  if (reward === null && Object.keys(exception).length) reward = 0;
  const passed = Number(reward || 0) >= 1.0;

  const agentResult = result.agent_result || {};
  const run = result.agent_execution || {};
  const started = parseIso(run.started_at);
  const finished = parseIso(run.finished_at);
  const duration = started && finished ? (finished - started) / 1000 : null;

  const flags = leakFlags(trialDir);
  const timeoutSec = meta.agentTimeoutSec ?? null;
  const timedOut = exception.exception_type === "AgentTimeoutError" || (duration != null && timeoutSec != null && duration >= timeoutSec - 5);

  return {
    task,
    passed,
    reward,
    scored: reward !== null,
    flags,
    flagged: flags.length > 0,
    durationSec: duration,
    timedOut,
    agentTimeoutSec: timeoutSec,
    toolCalls: countToolCalls(trialDir),
    inputTokens: agentResult.n_input_tokens || 0,
    cacheTokens: agentResult.n_cache_tokens || 0,
    outputTokens: agentResult.n_output_tokens || 0,
    /* effective generation rate over the agent's wall-clock time */
    outputTps: duration && agentResult.n_output_tokens ? +(agentResult.n_output_tokens / duration).toFixed(1) : null,
    totalTps:
      duration && (agentResult.n_input_tokens || agentResult.n_output_tokens)
        ? +(((agentResult.n_input_tokens || 0) + (agentResult.n_output_tokens || 0)) / duration).toFixed(1)
        : null,
    difficulty: meta.difficulty || null,
    category: meta.category || null,
    exceptionType: exception.exception_type || null,
    startedAt: run.started_at || null,
    finishedAt: run.finished_at || null,
  };
}

/* --- aggregation ---------------------------------------------------------- */
const median = (xs) => {
  const v = xs.filter((x) => x != null && Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const m = Math.floor(v.length / 2);
  return v.length % 2 ? v[m] : (v[m - 1] + v[m]) / 2;
};
const pct = (n, d) => (d ? +((100 * n) / d).toFixed(1) : null);

export function summarize(records) {
  const scored = records.filter((r) => r.scored);
  const passed = scored.filter((r) => r.passed);
  const byTask = new Map();
  for (const r of scored) {
    const t = byTask.get(r.task) || { n: 0, passed: 0 };
    t.n += 1;
    if (r.passed) t.passed += 1;
    byTask.set(r.task, t);
  }
  const taskPassedAll = [...byTask.values()].filter((t) => t.passed === t.n).length;
  const taskPassedAny = [...byTask.values()].filter((t) => t.passed > 0).length;
  const meanReward = scored.length ? +(scored.reduce((a, r) => a + Number(r.reward || 0), 0) / scored.length).toFixed(3) : null;
  const clean = scored.filter((r) => !r.flagged);
  const cleanPassed = clean.filter((r) => r.passed);
  const durations = scored.map((r) => r.durationSec);
  const byGroup = (key) => {
    const g = {};
    for (const r of scored) {
      const k = r[key] || "unknown";
      (g[k] ||= { total: 0, passed: 0, cleanTotal: 0, cleanPassed: 0 });
      g[k].total += 1;
      if (r.passed) g[k].passed += 1;
      if (!r.flagged) {
        g[k].cleanTotal += 1;
        if (r.passed) g[k].cleanPassed += 1;
      }
    }
    const out = {};
    for (const [k, v] of Object.entries(g)) out[k] = { ...v, rawPct: pct(v.passed, v.total), cleanPct: pct(v.cleanPassed, v.cleanTotal) };
    return out;
  };
  return {
    trials: records.length,
    attempts: scored.length,
    scored: scored.length,
    passed: passed.length,
    taskScored: byTask.size,
    taskPassedAll,
    taskPassedAny,
    meanReward,
    rawPct: pct(passed.length, scored.length),
    clean: clean.length,
    cleanPassed: cleanPassed.length,
    cleanPct: pct(cleanPassed.length, clean.length),
    flagged: scored.filter((r) => r.flagged).length,
    flaggedPasses: scored.filter((r) => r.flagged && r.passed).length,
    timeouts: scored.filter((r) => r.timedOut).length,
    medianMin: median(durations.map((d) => (d == null ? null : d / 60))),
    medianToolCalls: median(scored.map((r) => r.toolCalls)),
    medianInputTokens: median(scored.map((r) => r.inputTokens)),
    medianOutputTokens: median(scored.map((r) => r.outputTokens)),
    byDifficulty: byGroup("difficulty"),
    byCategory: byGroup("category"),
  };
}
