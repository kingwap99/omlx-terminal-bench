import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig, maskKey, APP_DIR } from "./lib/config.js";
import * as omlx from "./lib/omlx.js";
import { listTasks, summarize } from "./lib/tasks.js";
import * as runner from "./lib/runner.js";

const PUBLIC_DIR = path.join(APP_DIR, "public");
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
};

let cfg = loadConfig();
runner.markOrphansInterrupted();

function send(res, status, body, type = "application/json; charset=utf-8") {
  const buf = typeof body === "string" || Buffer.isBuffer(body) ? body : JSON.stringify(body);
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(buf);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = "";
    req.on("data", (c) => {
      data += c;
      if (data.length > 20 * 1024 * 1024) reject(new Error("body too large"));
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch (e) {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function publicRunShape(run) {
  if (!run) return null;
  const { logTail, ...rest } = run;
  return rest;
}

function csvEscape(v) {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

function runToCsv(run, records) {
  const head = ["run_id", "model", "task", "difficulty", "category", "passed", "reward", "flagged", "flags", "duration_sec", "timed_out", "tool_calls", "input_tokens", "output_tokens", "output_tps", "exception_type", "started_at", "finished_at"];
  const lines = [head.join(",")];
  for (const r of records) {
    const tps = r.outputTps ?? (r.durationSec && r.outputTokens ? +(r.outputTokens / r.durationSec).toFixed(1) : "");
    lines.push([run.id, run.model, r.task, r.difficulty, r.category, r.passed, r.reward, r.flagged, (r.flags || []).join("|"), r.durationSec, r.timedOut, r.toolCalls, r.inputTokens, r.outputTokens, tps, r.exceptionType, r.startedAt, r.finishedAt].map(csvEscape).join(","));
  }
  return lines.join("\n");
}

function buildComparison(cfg, ids) {
  const rows = [];
  const articleRef = loadArticleRows();
  for (const id of ids) {
    if (id === "article") {
      for (const a of articleRef) rows.push(a);
      continue;
    }
    const view = runner.runView(cfg, runner.readRun(id));
    if (!view) continue;
    rows.push({
      id: view.id,
      label: view.name,
      model: view.model,
      kind: "local",
      status: view.status,
      dataset: view.dataset,
      machine: view.machine?.chip || null,
      memoryGb: view.machine?.memoryGb ?? null,
      gpuCores: view.machine?.gpuCores ?? null,
      scored: view.summary?.scored ?? 0,
      passed: view.summary?.passed ?? 0,
      rawPct: view.summary?.rawPct,
      cleanPct: view.summary?.cleanPct,
      flagged: view.summary?.flagged ?? 0,
      timeouts: view.summary?.timeouts ?? 0,
      medianMin: view.summary?.medianMin != null ? +view.summary.medianMin.toFixed(1) : null,
      byDifficulty: view.summary?.byDifficulty || {},
      byCategory: view.summary?.byCategory || {},
      tasks: Object.fromEntries((view.records || []).map((r) => [r.task, { passed: r.passed, scored: r.scored, durationSec: r.durationSec, flagged: r.flagged, timedOut: r.timedOut }])),
      createdAt: view.createdAt,
    });
  }
  return rows;
}

function loadArticleRows() {
  try {
    const ref = JSON.parse(fs.readFileSync(path.join(APP_DIR, "data", "reference.json"), "utf8"));
    return (ref.rows || []).map((r) => ({ ...r, kind: "reference", byDifficulty: {}, byCategory: {}, tasks: {} }));
  } catch {
    return [];
  }
}

async function handle(req, res) {
  const url = new URL(req.url, "http://localhost");
  const p = url.pathname;
  const method = req.method || "GET";
  try {
    if (p.startsWith("/api/")) {
      /* ---------- config ---------- */
      if (p === "/api/config" && method === "GET") {
        return send(res, 200, {
          port: cfg.port,
          omlx: { baseUrl: cfg.omlx.baseUrl, apiKeyMasked: maskKey(cfg.omlx.apiKey), hasKey: !!cfg.omlx.apiKey },
          harbor: cfg.harbor,
          notify: cfg.notify,
        });
      }
      if (p === "/api/config" && method === "PUT") {
        const body = await readBody(req);
        if (body.omlx?.baseUrl) cfg.omlx.baseUrl = body.omlx.baseUrl;
        if (body.omlx?.apiKey) cfg.omlx.apiKey = body.omlx.apiKey;
        if (body.harbor) {
          for (const k of ["agent", "agentVersion", "batchConcurrency", "runTimeoutMin"]) if (body.harbor[k] !== undefined) cfg.harbor[k] = body.harbor[k];
          for (const k of ["excludeTaskNames", "envExtraArgs", "retryInclude"]) if (Array.isArray(body.harbor[k])) cfg.harbor[k] = body.harbor[k];
          for (const k of ["binary", "dockerHost", "agentCacheDir", "datasetDir", "defaultDataset"]) if (body.harbor[k]) cfg.harbor[k] = body.harbor[k];
          if (body.harbor.maxRetries !== undefined) cfg.harbor.maxRetries = Number(body.harbor.maxRetries);
        }
        if (body.notify !== undefined) cfg.notify = !!body.notify;
        saveConfig(cfg);
        return send(res, 200, { ok: true });
      }

      /* ---------- oMLX ---------- */
      if (p === "/api/omlx/status" && method === "GET") {
        const [models, status, health, device] = await Promise.allSettled([omlx.listModels(cfg), omlx.modelsStatus(cfg), omlx.health(cfg), omlx.deviceInfo(cfg)]);
        return send(res, 200, {
          baseUrl: cfg.omlx.baseUrl,
          online: health.status === "fulfilled",
          health: health.status === "fulfilled" ? health.value : { error: String(health.reason?.message || health.reason) },
          models: models.status === "fulfilled" ? models.value.map((m) => ({ ...m, ...(status.value?.byModel?.[m.id] || {}) })) : [],
          status: status.status === "fulfilled" ? { finalCeiling: status.value.finalCeiling, currentModelMemory: status.value.currentModelMemory, loadedCount: status.value.loadedCount } : null,
          device: device.status === "fulfilled" ? device.value : { error: String(device.reason?.message || device.reason) },
        });
      }
      if (p === "/api/omlx/load" && method === "POST") {
        const body = await readBody(req);
        return send(res, 200, await omlx.loadModel(cfg, body.model));
      }
      if (p === "/api/omlx/unload" && method === "POST") {
        const body = await readBody(req);
        return send(res, 200, await omlx.unloadModel(cfg, body.model));
      }
      if (p === "/api/omlx/preload" && method === "POST") {
        const body = await readBody(req);
        return send(res, 200, await omlx.preloadCheck(cfg, body.model));
      }
      if (p === "/api/machine" && method === "GET") {
        return send(res, 200, await omlx.machineSnapshot(cfg));
      }

      /* ---------- datasets ---------- */
      if (p === "/api/datasets" && method === "GET") {
        const out = [];
        if (fs.existsSync(cfg.harbor.datasetDir)) {
          for (const name of fs.readdirSync(cfg.harbor.datasetDir)) {
            const dir = path.join(cfg.harbor.datasetDir, name);
            try {
              if (!fs.statSync(dir).isDirectory()) continue;
            } catch {
              continue;
            }
            const n = fs.readdirSync(dir).filter((t) => fs.existsSync(path.join(dir, t, "task.toml"))).length;
            if (n) out.push({ name, taskCount: n });
          }
        }
        return send(res, 200, out);
      }
      if (p === "/api/tasks" && method === "GET") {
        const ds = url.searchParams.get("dataset") || cfg.harbor.defaultDataset;
        return send(res, 200, listTasks(path.join(cfg.harbor.datasetDir, ds)));
      }

      /* ---------- runs ---------- */
      if (p === "/api/runs" && method === "GET") {
        return send(res, 200, runner.listRuns().map((r) => ({ ...r, active: runner.isBusy(r.id) })));
      }
      if (p === "/api/runs" && method === "POST") {
        const body = await readBody(req);
        if (!body.model) return send(res, 400, { error: "model is required" });
        const run = await runner.createRun(cfg, body);
        if (body.autostart !== false) await runner.startRun(cfg, run.id);
        return send(res, 200, publicRunShape(runner.runView(cfg, run)));
      }
      const runMatch = /^\/api\/runs\/([^/]+)(?:\/(.*))?$/.exec(p);
      if (runMatch) {
        const id = decodeURIComponent(runMatch[1]);
        const action = runMatch[2] || "";
        if (!action && method === "GET") {
          const view = runner.runView(cfg, runner.readRun(id));
          if (!view) return send(res, 404, { error: "Run not found" });
          return send(res, 200, view);
        }
        if (!action && method === "DELETE") {
          const r = runner.deleteRun(id);
          if (!r.ok) return send(res, 400, { error: r.reason === "running" ? "Run is active; pause or stop it first" : "Run not found" });
          return send(res, 200, { ok: true });
        }
        if (action === "start" && method === "POST") {
          const r = await runner.startRun(cfg, id);
          return send(res, 200, { ...publicRunShape(runner.runView(cfg, runner.readRun(id))), started: r.started, reason: r.reason || null });
        }
        if (action === "pause" && method === "POST") {
          const body = await readBody(req).catch(() => ({}));
          const r = runner.pauseRun(id, { force: !!body.force });
          if (!r.ok) return send(res, 404, { error: "Run not found" });
          return send(res, 200, { ok: true, mode: r.mode, run: publicRunShape(runner.runView(cfg, runner.readRun(id))) });
        }
        if (action === "cancel" && method === "POST") {
          const r = runner.cancelRun(id);
          if (!r.ok) return send(res, 404, { error: "Run not found" });
          return send(res, 200, { ok: true, run: publicRunShape(runner.runView(cfg, runner.readRun(id))) });
        }
        if (action === "export.csv" && method === "GET") {
          const view = runner.runView(cfg, runner.readRun(id));
          if (!view) return send(res, 404, { error: "Run not found" });
          return send(res, 200, runToCsv(view, view.records || []), "text/csv; charset=utf-8");
        }
      }
      if (p === "/api/import" && method === "POST") {
        const body = await readBody(req);
        if (!body.model || !Array.isArray(body.records)) return send(res, 400, { error: "model and records[] are required" });
        const run = runner.importRun(cfg, body);
        return send(res, 200, publicRunShape(runner.runView(cfg, run)));
      }

      /* ---------- compare / reference ---------- */
      if (p === "/api/compare" && method === "GET") {
        const ids = (url.searchParams.get("ids") || "").split(",").map((s) => s.trim()).filter(Boolean);
        return send(res, 200, { rows: buildComparison(cfg, ids) });
      }
      if (p === "/api/reference" && method === "GET") {
        return send(res, 200, loadArticleRows());
      }
      if (p === "/api/summary" && method === "GET") {
        const id = url.searchParams.get("run");
        return send(res, 200, summarize(runner.readResults(id)));
      }
      return send(res, 404, { error: "unknown api" });
    }

    /* ---------- static ---------- */
    let file = p === "/" ? "/index.html" : p;
    file = path.normalize(file).replace(/^(\.\.[/\\])+/, "");
    const full = path.join(PUBLIC_DIR, file);
    if (!full.startsWith(PUBLIC_DIR)) return send(res, 403, "forbidden");
    if (fs.existsSync(full) && fs.statSync(full).isFile()) {
      return send(res, 200, fs.readFileSync(full), MIME[path.extname(full)] || "application/octet-stream");
    }
    return send(res, 404, "not found", "text/plain; charset=utf-8");
  } catch (err) {
    return send(res, 500, { error: String(err?.message || err) });
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => send(res, 500, { error: String(e?.message || e) }));
});

const PORT = Number(process.env.PORT || cfg.port || 4665);
server.listen(PORT, "0.0.0.0", () => {
  console.log(`[bench] http://localhost:${PORT}  (oMLX ${cfg.omlx.baseUrl})`);
});
