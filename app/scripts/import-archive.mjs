/* Import earlier Harbor jobs (18-task subset runs) into the app's run store. */
import path from "node:path";
import fs from "node:fs";
import { loadConfig } from "../lib/config.js";
import { listTasks, recordFromTrial } from "../lib/tasks.js";
import { importRun } from "../lib/runner.js";

const cfg = loadConfig();
const workDir = path.dirname(cfg.harbor.datasetDir); // .../work
const dsName = "subset18";
const meta = {};
for (const t of listTasks(path.join(cfg.harbor.datasetDir, dsName))) meta[t.name] = t;

const machine = {
  capturedAt: "2026-11-07T00:00:00.000Z",
  source: cfg.omlx.baseUrl,
  chip: "Apple M1 Max",
  chipName: "Apple M1",
  chipVariant: "Max",
  memoryGb: 128,
  gpuCores: 32,
  note: "Historical run from 2026-11-07 (oMLX admin device-info was not captured then)",
};

const jobs = [
  { dir: "oq4e-sub18", model: "Qwen3.8-Flash-Next-oQ4e-mtp", name: "[18 tasks] Qwen3.8-Flash-Next-oQ4e-mtp (oMLX · M1 Max)" },
  { dir: "unc-sub18", model: "Qwen3.8-Flash-Next-Uncensored-oQ5e-mtp", name: "[18 tasks] Qwen3.8-Flash-Next-Uncensored-oQ5e-mtp (oMLX · M1 Max)" },
  { dir: "swift-sub18", model: "Swift1.5-Qwen3.8-Flash-Next-oQ5e-mtp", name: "[18 tasks] Swift1.5-Qwen3.8-Flash-Next-oQ5e-mtp (oMLX · M1 Max)" },
];

for (const j of jobs) {
  const jobDir = path.join(workDir, "jobs", j.dir);
  if (!fs.existsSync(jobDir)) {
    console.log(`skip ${j.dir} (missing)`);
    continue;
  }
  const records = [];
  for (const trial of fs.readdirSync(jobDir)) {
    if (!trial.includes("__")) continue;
    const task = trial.split("__")[0];
    const rec = recordFromTrial(task, path.join(jobDir, trial), meta[task] || {});
    if (rec) records.push(rec);
  }
  const created = fs.statSync(path.join(jobDir, "config.json")).mtime.toISOString();
  const run = importRun(cfg, {
    id: `import-${j.dir}`,
    name: j.name,
    model: j.model,
    dataset: dsName,
    agent: "qwen-coder",
    agentVersion: "0.26.7",
    createdAt: created,
    machine,
    note: `Imported from Harbor job ${j.dir} (18-task stratified subset, concurrency 5)`,
    records,
  });
  console.log(`${run.id}: ${records.length} trials`);
}
