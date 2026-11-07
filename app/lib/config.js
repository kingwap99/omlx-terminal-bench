import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const DATA_DIR = path.join(APP_DIR, "data");
export const RUNS_DIR = path.join(DATA_DIR, "runs");
export const CONFIG_PATH = path.join(DATA_DIR, "config.json");
export const REFERENCE_PATH = path.join(DATA_DIR, "reference.json");

const DEFAULTS = {
  port: Number(process.env.PORT) || 4665,
  omlx: {
    baseUrl: process.env.OMLX_BASE_URL || "http://127.0.0.1:8258",
    apiKey: process.env.OMLX_API_KEY || "",
  },
  harbor: {
    binary: process.env.HARBOR_BIN || "harbor",
    dockerHost: process.env.DOCKER_HOST || "",
    agent: "qwen-coder",
    agentVersion: "0.26.7",
    /* optional bind mount with a pre-installed agent toolchain (speeds up batches) */
    agentCacheDir: process.env.HARBOR_AGENT_CACHE || "",
    datasetDir: process.env.HARBOR_DATASET_DIR || path.join(os.homedir(), "terminal-bench-tasks"),
    defaultDataset: "terminal-bench",
    excludeTaskNames: ["qemu-*", "mcmc-sampling-stan"],
    maxRetries: 2,
    retryInclude: ["AgentSetupTimeoutError"],
    batchConcurrency: 4,
    runTimeoutMin: 300,
    envExtraArgs: ["--no-force-build"],
  },
  notify: true,
};

function deepMerge(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra || {})) {
    if (v && typeof v === "object" && !Array.isArray(v) && base[k] && typeof base[k] === "object" && !Array.isArray(base[k])) {
      out[k] = deepMerge(base[k], v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out;
}

export function loadConfig() {
  let saved = {};
  try {
    saved = JSON.parse(fs.readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    /* first run */
  }
  return deepMerge(DEFAULTS, saved);
}

export function saveConfig(cfg) {
  fs.mkdirSync(DATA_DIR, { recursive: true });
  const tmp = CONFIG_PATH + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(cfg, null, 2));
  fs.renameSync(tmp, CONFIG_PATH);
}

export function maskKey(key) {
  if (!key) return "";
  if (key.length <= 8) return "****";
  return key.slice(0, 5) + "…" + key.slice(-3);
}
