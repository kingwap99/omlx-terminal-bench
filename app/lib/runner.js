import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { RUNS_DIR } from "./config.js";
import { listTasks, filterTasks, recordFromTrial, summarize } from "./tasks.js";
import { machineSnapshot, preloadCheck } from "./omlx.js";

const runtime = new Map(); // runId -> { child, pauseRequested, cancelRequested, batchDir }
/* oMLX serves one stream, so two runs at once starve each other. */
let activeRunId = null;

/* A run belongs to one provider (oMLX, OpenCodex, or any OpenAI-compatible
   endpoint). The key lives in config, never in the run record. */
function providerFor(cfg, run) {
  const list = cfg.providers || [];
  return (
    list.find((p) => p.id === run.providerId) || {
      id: "omlx",
      label: "oMLX",
      baseUrl: cfg.omlx.baseUrl,
      apiKey: cfg.omlx.apiKey,
    }
  );
}

function runDir(id) {
  return path.join(RUNS_DIR, id);
}
function metaPath(id) {
  return path.join(runDir(id), "run.json");
}
function resultsPath(id) {
  return path.join(runDir(id), "results.json");
}

function writeJson(p, obj) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const tmp = p + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2));
  fs.renameSync(tmp, p);
}

export function readRun(id) {
  try {
    return JSON.parse(fs.readFileSync(metaPath(id), "utf8"));
  } catch {
    return null;
  }
}

export function readResults(id) {
  try {
    return JSON.parse(fs.readFileSync(resultsPath(id), "utf8"));
  } catch {
    return [];
  }
}

function saveRun(run, records) {
  run.updatedAt = new Date().toISOString();
  run.summary = summarize(records ?? readResults(run.id));
  writeJson(metaPath(run.id), run);
  if (records) writeJson(resultsPath(run.id), records);
}

export function listRuns() {
  if (!fs.existsSync(RUNS_DIR)) return [];
  const out = [];
  for (const id of fs.readdirSync(RUNS_DIR).sort()) {
    const run = readRun(id);
    if (run) out.push(run);
  }
  return out.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function stampId() {
  const d = new Date();
  const p = (n, w = 2) => String(n).padStart(w, "0");
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

function tail(file, lines = 60) {
  try {
    const all = fs.readFileSync(file, "utf8").split("\n");
    return all.slice(-lines).join("\n");
  } catch {
    return "";
  }
}

function killTree(child, signal = "SIGTERM") {
  if (!child || child.killed || child.exitCode !== null) return;
  try {
    process.kill(-child.pid, signal);
  } catch {
    try {
      child.kill(signal);
    } catch {
      /* gone */
    }
  }
}

/* Is the container runtime reachable? Catches "colima is not running" before a
   run burns through every batch in seconds. */
function dockerCheck(cfg) {
  return new Promise((resolve) => {
    const h = cfg.harbor;
    const env = { ...process.env };
    if (h.dockerHost) env.DOCKER_HOST = h.dockerHost;
    let out = "";
    let child;
    try {
      child = spawn(process.env.DOCKER_BIN || "docker", ["info", "--format", "{{.ServerVersion}}"], { env, stdio: ["ignore", "pipe", "pipe"] });
    } catch (e) {
      return resolve({ ok: false, detail: String(e.message || e) });
    }
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (out += d));
    child.on("error", (e) => resolve({ ok: false, detail: e.message }));
    child.on("exit", (code) => resolve({ ok: code === 0, detail: out.trim().slice(0, 400) }));
  });
}

function copyTrial(src, dest) {
  fs.mkdirSync(dest, { recursive: true });
  const skipDirs = new Set(["agent", "artifacts"]);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dest, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "qwen-sessions" || entry.name === "setup") continue;
      if (skipDirs.has(entry.name) && entry.name === "artifacts") continue;
      if (entry.name === "agent") {
        fs.mkdirSync(d, { recursive: true });
        for (const f of ["qwen-code.txt", "trajectory.json"]) {
          const fp = path.join(s, f);
          if (fs.existsSync(fp)) {
            try {
              const st = fs.statSync(fp);
              if (st.size > 40 * 1024 * 1024) continue;
              fs.copyFileSync(fp, path.join(d, f));
            } catch {
              /* best effort */
            }
          }
        }
        continue;
      }
      copyTrial(s, d);
    } else {
      try {
        const st = fs.statSync(s);
        if (st.size > 40 * 1024 * 1024) continue;
        fs.copyFileSync(s, d);
      } catch {
        /* best effort */
      }
    }
  }
}

function buildArgs(cfg, run, taskNames, jobName) {
  const h = cfg.harbor;
  const prov = providerFor(cfg, run);
  const endpoint = (prov.containerBaseUrl || prov.baseUrl).replace(/\/+$/, "");
  const args = ["run", "-p", path.join(h.datasetDir, run.dataset), "-a", h.agent, "--ak", `version=${h.agentVersion}`, "-m", `openai/${run.model}`, "--base-url", `${endpoint}/v1`, "-n", String(run.options.batchConcurrency), "-r", String(h.maxRetries)];
  const attempts = Number(run.options.nAttempts || 1);
  if (attempts > 1) args.push("-k", String(attempts));
  const mult = Number(run.options.agentTimeoutMultiplier || 1);
  if (mult !== 1) args.push("--agent-timeout-multiplier", String(mult));
  for (const e of h.retryInclude || []) args.push("--retry-include", e);
  for (const n of taskNames) args.push("-i", n);
  for (const n of h.envExtraArgs || []) args.push(n);
  if (h.agentCacheDir && fs.existsSync(h.agentCacheDir)) {
    args.push("--mounts", JSON.stringify([{ type: "bind", source: h.agentCacheDir, target: "/opt/qwen", read_only: true }]));
  }
  args.push("-o", path.join(runDir(run.id), "harbor"), "--job-name", jobName, "-y");
  return args;
}

function collectBatchResults(run, records, batchDir, taskMeta, jobName) {
  if (!fs.existsSync(batchDir)) return 0;
  let added = 0;
  const mult = Number(run.options?.agentTimeoutMultiplier || 1);
  /* Only ingest this batch's own job dir: a batch killed by pause/restart can
     leave a partial trial (e.g. "service main is not running") that must not be
     scored. */
  const jobEntries = jobName ? [{ name: jobName, isDirectory: () => true }] : [];
  if (!jobName) {
    try {
      jobEntries.push(...fs.readdirSync(batchDir, { withFileTypes: true }).filter((e) => e.isDirectory()));
    } catch {
      return 0;
    }
  }
  for (const jobEntry of jobEntries) {
    if (!jobEntry.isDirectory()) continue;
    const jobPath = path.join(batchDir, jobEntry.name);
    let trials = [];
    try {
      trials = fs.readdirSync(jobPath, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const trial of trials) {
      if (!trial.isDirectory() || !trial.name.includes("__")) continue;
      const trialSrc = path.join(jobPath, trial.name);
      const task = trial.name.split("__")[0];
      if (!taskMeta[task]) continue;
      const meta = taskMeta[task];
      const scaled = meta && meta.agentTimeoutSec ? { ...meta, agentTimeoutSec: meta.agentTimeoutSec * mult } : meta;
      const record = recordFromTrial(task, trialSrc, scaled);
      if (!record || record.reward === null) continue;
      /* The agent never produced a token and died almost immediately: that is a
         runtime/API failure, not a wrong answer. Leave it pending so the retry
         guard decides whether to surface it. */
      const agentNeverRan =
        !record.passed &&
        (record.inputTokens || 0) + (record.outputTokens || 0) === 0 &&
        !!record.exceptionType &&
        (/ExitCode|Container|Docker|Setup/i.test(record.exceptionType)
          ? record.durationSec == null || record.durationSec < 90
          : /API|Connection/i.test(record.exceptionType));
      if (agentNeverRan) continue;
      const dest = path.join(runDir(run.id), "trials", trial.name);
      try {
        copyTrial(trialSrc, dest);
      } catch {
        /* record still valid without artifacts */
      }
      record.trialDir = path.posix.join("trials", trial.name);
      const want = Number(run.options?.nAttempts || 1);
      const existingCount = records.filter((r) => r.task === task).length;
      if (want > 1) {
        /* keep up to N attempts per task; a resume that re-runs an attempt
           replaces the previous slot instead of stacking duplicates */
        if (existingCount < want) {
          record.attempt = existingCount + 1;
          records.push(record);
        } else {
          record.attempt = existingCount;
          const idx = records.findIndex((r) => r.task === task && r.attempt === existingCount);
          if (idx >= 0) records.splice(idx, 1, record);
          else records.push(record);
        }
      } else {
        record.attempt = 1;
        const prev = records.findIndex((r) => r.task === task);
        if (prev >= 0) records.splice(prev, 1);
        records.push(record);
      }
      added += 1;
    }
  }
  if (added) {
    records.sort((a, b) => String(a.startedAt || "").localeCompare(String(b.startedAt || "")));
    saveRun(run, records);
  }
  return added;
}

function runBatch(cfg, run, taskNames, index, logFile) {
  return new Promise((resolve) => {
    const h = cfg.harbor;
    const rt = runtime.get(run.id);
    const jobName = `batch-${String(index).padStart(3, "0")}`;
    const args = buildArgs(cfg, run, taskNames, jobName);
    const env = {
      ...process.env,
      PATH: h.binary.includes("/") ? `${path.dirname(h.binary)}:${process.env.PATH}` : process.env.PATH,
      OPENAI_API_KEY: providerFor(cfg, run).apiKey || "",
    };
    if (h.dockerHost) env.DOCKER_HOST = h.dockerHost;
    fs.appendFileSync(logFile, `\n$ ${h.binary} ${args.join(" ")}\n`);
    const child = spawn(h.binary, args, { cwd: cfg.harbor.datasetDir, env, detached: true, stdio: ["ignore", "pipe", "pipe"] });
    rt.child = child;
    const onData = (chunk) => {
      try {
        fs.appendFileSync(logFile, chunk);
      } catch {
        /* ignore */
      }
    };
    child.stdout.on("data", onData);
    child.stderr.on("data", onData);

    let timedOut = false;
    const capMs = (run.options.batchTimeoutMin || 300) * 60_000;
    const timer = setTimeout(() => {
      timedOut = true;
      fs.appendFileSync(logFile, `\n[runner] batch exceeded ${run.options.batchTimeoutMin} min, terminating\n`);
      killTree(child, "SIGTERM");
      setTimeout(() => killTree(child, "SIGKILL"), 20_000).unref();
    }, capMs);

    child.on("exit", (code, signal) => {
      clearTimeout(timer);
      rt.child = null;
      resolve({ code, signal, timedOut, jobName });
    });
    child.on("error", (err) => {
      clearTimeout(timer);
      rt.child = null;
      fs.appendFileSync(logFile, `\n[runner] spawn failed: ${err.message}\n`);
      resolve({ code: -1, signal: null, timedOut: false, spawnError: err.message, jobName });
    });
  });
}

async function loop(cfg, run) {
  const rt = runtime.get(run.id);
  const dir = runDir(run.id);
  const logFile = path.join(dir, "runner.log");
  const records = readResults(run.id);
  const done = new Set(records.filter((r) => r.scored).map((r) => r.task));
  run.status = "running";
  run.startedAt ||= new Date().toISOString();
  run.currentBatch = null;
  saveRun(run, records);

  const taskMeta = {};
  for (const t of run.tasks) taskMeta[t.name] = t;

  let i = Number(run.batchCursor || 0);
  const attempts = {};
  try {
    /* Recompute the queue every round: a restart can leave finished trials on
       disk that were ingested after the queue was built. */
    for (;;) {
      if (rt.cancelRequested) break;
      if (rt.pauseRequested) {
        run.status = "paused";
        run.batchCursor = i;
        run.note = "Paused between batches. You can resume at any time.";
        saveRun(run, records);
        return;
      }
      const want = Number(run.options?.nAttempts || 1);
      const perTask = new Map();
      for (const r of records) if (r.scored) perTask.set(r.task, (perTask.get(r.task) || 0) + 1);
      const doneNow = new Set([...perTask].filter(([, c]) => c >= want).map(([t]) => t));
      const pendingNow = run.tasks.filter((t) => !doneNow.has(t.name));
      if (!pendingNow.length) break;
      const group = pendingNow.slice(0, run.options.batchConcurrency).map((t) => t.name);
      const batchDir = path.join(dir, "harbor");
      fs.mkdirSync(batchDir, { recursive: true });
      run.currentBatch = { index: i, tasks: group, startedAt: new Date().toISOString() };
      run.status = "running";
      saveRun(run, records);
    const res = await runBatch(cfg, run, group, i, logFile);
      const added = collectBatchResults(run, records, batchDir, taskMeta, res.jobName);
      run.lastBatchExit = { code: res.code, signal: res.signal, timedOut: !!res.timedOut, spawnError: res.spawnError || null };
      i += 1;
      run.batchCursor = i;
      run.currentBatch = null;
      if (rt.cancelRequested) break;
      if (rt.pauseRequested) {
        run.status = "paused";
        run.note = "Paused between batches. You can resume at any time.";
        saveRun(run, records);
        return;
      }
      /* A batch that exits non-zero without producing a single result is an
         infrastructure failure (docker down, bad mount, auth), not a task
         failure. Stop here instead of marching through the whole queue. */
      if (added === 0 && res.code !== 0) {
        const tailText = tail(logFile, 12).split("\n").filter((l) => l.trim() && !l.startsWith("$ ")).slice(-3).join(" ");
        run.status = "error";
        run.note = `Batch ${i - 1} produced no results (harbor exit ${res.code}). ${tailText || "See runner log."}`;
        run.lastBatchExit = { ...run.lastBatchExit, infraFailure: true };
        saveRun(run, records);
        return;
      }
      if (added === 0) {
        for (const name of group) attempts[name] = (attempts[name] || 0) + 1;
        const stuck = group.filter((name) => attempts[name] >= 2);
        if (stuck.length) {
          run.status = "error";
          run.note = `harbor produced no usable result for ${stuck.join(", ")} (2 attempts) — often the model endpoint is unreachable from containers. Check the agent log for "ECONNREFUSED".`;
          saveRun(run, records);
          return;
        }
      }
      saveRun(run, records);
      if (res.spawnError) {
        run.status = "error";
        run.note = `harbor failed to start: ${res.spawnError}`;
        saveRun(run, records);
        return;
      }
    }
    const want = Number(run.options?.nAttempts || 1);
    const perTask = new Map();
    for (const r of records) if (r.scored) perTask.set(r.task, (perTask.get(r.task) || 0) + 1);
    const remaining = run.tasks.filter((t) => (perTask.get(t.name) || 0) < want);
    if (rt.cancelRequested) {
      run.status = "canceled";
      run.note = "Stopped. Completed task results are kept.";
    } else if (remaining.length === 0) {
      run.status = "completed";
      run.finishedAt = new Date().toISOString();
    } else {
      run.status = "paused";
      run.note = `${remaining.length} task(s) have no score yet. Resume to continue.`;
    }
    saveRun(run, records);
    notify(run);
  } catch (err) {
    run.status = "error";
    run.note = String(err?.message || err);
    saveRun(run, records);
  } finally {
    runtime.delete(run.id);
    if (activeRunId === run.id) activeRunId = null;
  }
}

function notify(run) {
  if (!run.notify) return;
  const s = run.summary || {};
  const title = `Benchmark ${run.status === "completed" ? "complete" : run.status}`;
  const body = `${run.model}: ${s.passed ?? 0}/${s.scored ?? 0} passed (leak-checked ${s.cleanPct ?? "n/a"}%)`;
  const script = `display notification ${JSON.stringify(body)} with title ${JSON.stringify(title)}`;
  try {
    spawn("osascript", ["-e", script], { detached: true, stdio: "ignore" }).unref();
  } catch {
    /* notifications are optional */
  }
}

export function isBusy(id) {
  return runtime.has(id);
}

export function activeId() {
  return activeRunId;
}

export async function createRun(cfg, payload) {
  const datasetDir = path.join(cfg.harbor.datasetDir, payload.dataset || cfg.harbor.defaultDataset);
  const all = listTasks(datasetDir);
  if (!all.length) throw new Error(`No tasks found in: ${datasetDir}`);
  const tasks = filterTasks(all, {
    include: payload.includeTaskNames || [],
    exclude: [...(cfg.harbor.excludeTaskNames || []), ...(payload.excludeTaskNames || [])],
  });
  if (!tasks.length) throw new Error("No tasks left after filtering");
  const provider = (cfg.providers || []).find((p) => p.id === payload.providerId) || {
    id: "omlx",
    label: "oMLX",
    baseUrl: cfg.omlx.baseUrl,
    apiKey: cfg.omlx.apiKey,
  };
  const id = payload.id || stampId();
  const dir = runDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const machine =
    provider.id === "omlx"
      ? await machineSnapshot(cfg).catch((e) => ({ capturedAt: new Date().toISOString(), error: String(e.message || e) }))
      : { capturedAt: new Date().toISOString(), provider: provider.label, baseUrl: provider.baseUrl, note: "provider has no admin spec API" };
  machine.local = { hostname: os.hostname(), platform: `${os.type()} ${os.release()}`, arch: os.arch(), cpus: os.cpus().length, totalMemoryGb: +(os.totalmem() / 1024 ** 3).toFixed(1), node: process.version, role: "benchmark controller" };
  const run = {
    id,
    name: payload.name || `${payload.model} · ${new Date().toLocaleString("zh-TW")}`,
    model: payload.model,
    providerId: provider.id,
    providerLabel: provider.label,
    dataset: payload.dataset || cfg.harbor.defaultDataset,
    baseUrl: provider.baseUrl,
    agent: cfg.harbor.agent,
    agentVersion: cfg.harbor.agentVersion,
    options: {
      /* Serial by design: one task at a time, so a task's wall-clock budget is not
         split between trials queued on a single-stream model server. */
      batchConcurrency: 1,
      batchTimeoutMin: Math.max(15, Number(payload.batchTimeoutMin) || cfg.harbor.runTimeoutMin),
      agentTimeoutMultiplier: Math.max(0.25, Math.min(8, Number(payload.agentTimeoutMultiplier) || Number(cfg.harbor.agentTimeoutMultiplier) || 1)),
      nAttempts: Math.max(1, Math.min(5, Math.round(Number(payload.nAttempts) || Number(cfg.harbor.nAttempts) || 1))),
      preload: payload.preload !== false,
    },
    notify: cfg.notify !== false,
    status: "queued",
    createdAt: new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    batchCursor: 0,
    currentBatch: null,
    machine,
    modelInfo: payload.modelInfo || null,
    tasks,
    note: null,
  };
  saveRun(run, []);
  return run;
}

export async function startRun(cfg, id) {
  const run = readRun(id);
  if (!run) throw new Error("Run not found");
  if (runtime.has(id)) return { started: false, reason: "already-running", run };
  if (activeRunId && activeRunId !== id) return { started: false, reason: "another-run-active:" + activeRunId, run };
  if (cfg.harbor.requireDocker !== false) {
    const docker = await dockerCheck(cfg);
    if (!docker.ok) {
      run.status = "error";
      run.note = `Container runtime unreachable: ${docker.detail || "docker info failed"}. Start Docker (Colima), then press Resume.`;
      saveRun(run);
      return { started: false, reason: "docker-unavailable", run };
    }
  }
  const rt = { child: null, pauseRequested: false, cancelRequested: false };
  runtime.set(id, rt);
  activeRunId = id;
  run.status = "running";
  run.note = null;
  saveRun(run);
  (async () => {
    if (run.options.preload) {
      try {
        const p = await preloadCheck(providerFor(cfg, run), run.model);
        fs.appendFileSync(path.join(runDir(id), "runner.log"), `\n[runner] preload ok ${p.model} in ${p.seconds.toFixed(1)}s\n`);
        run.preloadSeconds = p.seconds;
        saveRun(run);
      } catch (e) {
        fs.appendFileSync(path.join(runDir(id), "runner.log"), `\n[runner] preload failed: ${e.message}\n`);
        run.status = "error";
        run.note = `Model load failed: ${e.message}`;
        saveRun(run);
        runtime.delete(id);
        if (activeRunId === id) activeRunId = null;
        return;
      }
    }
    await loop(cfg, run);
  })();
  return { started: true, run };
}

export function pauseRun(id, { force = false } = {}) {
  const rt = runtime.get(id);
  const run = readRun(id);
  if (!run) return { ok: false, reason: "not-found" };
  if (!rt) {
    run.status = "paused";
    run.note = "Paused (no active batch).";
    saveRun(run);
    return { ok: true, mode: "idle", run };
  }
  rt.pauseRequested = true;
  if (force) killTree(rt.child, "SIGTERM");
  run.note = force ? "Stopping the current batch (unfinished tasks will re-run)…" : "Pausing after the current batch…";
  saveRun(run);
  return { ok: true, mode: force ? "force" : "graceful", run };
}

export function cancelRun(id) {
  const rt = runtime.get(id);
  const run = readRun(id);
  if (!run) return { ok: false, reason: "not-found" };
  if (rt) {
    rt.cancelRequested = true;
    killTree(rt.child, "SIGTERM");
    setTimeout(() => killTree(rt.child, "SIGKILL"), 20_000).unref();
  }
  run.status = "canceled";
  run.note = "Stopped. Completed task results are kept.";
  saveRun(run);
  return { ok: true, run };
}

export function deleteRun(id) {
  if (runtime.has(id)) return { ok: false, reason: "running" };
  const dir = runDir(id);
  if (!fs.existsSync(dir)) return { ok: false, reason: "not-found" };
  fs.rmSync(dir, { recursive: true, force: true });
  return { ok: true };
}

export function runView(cfg, run) {
  if (!run) return null;
  const records = readResults(run.id);
  const rt = runtime.get(run.id);
  const want = Number(run.options?.nAttempts || 1);
  const perTask = new Map();
  for (const r of records) if (r.scored) perTask.set(r.task, (perTask.get(r.task) || 0) + 1);
  const done = new Set([...perTask].filter(([, c]) => c >= want).map(([t]) => t));
  /* Wall-clock duration: stop the clock at finishedAt, otherwise every read of
     a finished run would report a longer total. */
  const startMs = run.startedAt ? Date.parse(run.startedAt) : null;
  const endMs = run.finishedAt ? Date.parse(run.finishedAt) : Date.now();
  const elapsed = startMs ? Math.max(0, (endMs - startMs) / 1000) : 0;
  const durations = records.map((r) => r.durationSec).filter((x) => x != null);
  const remainingTasks = run.tasks.filter((t) => !done.has(t.name));
  const eta = durations.length ? (durations.reduce((a, b) => a + b, 0) / durations.length) * remainingTasks.length / Math.max(1, run.options.batchConcurrency) : null;
  return {
    ...run,
    runtime: { active: !!rt, childPid: rt?.child?.pid ?? null, pauseRequested: !!rt?.pauseRequested, cancelRequested: !!rt?.cancelRequested },
    records,
    progress: { total: run.tasks.length, done: done.size, remaining: remainingTasks.length, elapsedSec: Math.round(elapsed), etaSec: eta ? Math.round(eta) : null },
    logTail: tail(path.join(runDir(run.id), "runner.log"), 120),
    runningOrphan: !rt && run.status === "running",
  };
}

export function markOrphansInterrupted() {
  for (const run of listRuns()) {
    if (runtime.has(run.id)) continue;
    if (run.status === "running" || run.status === "queued") {
      run.status = "paused";
      run.note = "Interrupted by a service restart. Resume to continue.";
      saveRun(run);
    }
  }
}

export function importRun(cfg, payload) {
  const id = payload.id || `import-${stampId()}`;
  const dir = runDir(id);
  fs.mkdirSync(dir, { recursive: true });
  const datasetDir = path.join(cfg.harbor.datasetDir, payload.dataset || cfg.harbor.defaultDataset);
  const meta = {};
  for (const t of listTasks(datasetDir)) meta[t.name] = t;
  const incoming = (payload.records || []).map((r) => ({
    task: r.task,
    passed: !!r.passed,
    reward: r.reward ?? (r.passed ? 1 : 0),
    scored: r.scored !== false,
    flags: r.flags || [],
    flagged: !!(r.flags && r.flags.length),
    durationSec: r.durationSec ?? null,
    timedOut: !!r.timedOut,
    toolCalls: r.toolCalls ?? 0,
    inputTokens: r.inputTokens ?? 0,
    outputTokens: r.outputTokens ?? 0,
    cacheTokens: r.cacheTokens ?? 0,
    difficulty: r.difficulty || meta[r.task]?.difficulty || null,
    category: r.category || meta[r.task]?.category || null,
    exceptionType: r.exceptionType || null,
    startedAt: r.startedAt || null,
    finishedAt: r.finishedAt || null,
    trialDir: null,
  }));
  const taskNames = new Set(incoming.map((r) => r.task));
  const run = {
    id,
    name: payload.name || `${payload.model} · imported`,
    model: payload.model,
    dataset: payload.dataset || cfg.harbor.defaultDataset,
    baseUrl: payload.baseUrl || "external",
    agent: payload.agent || cfg.harbor.agent,
    agentVersion: payload.agentVersion || null,
    options: { batchConcurrency: 1, batchTimeoutMin: 60, preload: false },
    notify: false,
    status: "imported",
    createdAt: payload.createdAt || new Date().toISOString(),
    startedAt: null,
    finishedAt: null,
    batchCursor: 0,
    currentBatch: null,
    machine: payload.machine || { capturedAt: null, note: "External import, no host snapshot" },
    modelInfo: payload.modelInfo || null,
    tasks: [...taskNames].sort().map((name) => meta[name] || { name, difficulty: "unknown", category: "unknown", agentTimeoutSec: null }),
    note: payload.note || "Imported from existing results",
  };
  saveRun(run, incoming);
  return run;
}
