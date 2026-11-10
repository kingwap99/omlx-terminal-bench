import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { APP_DIR, DATA_DIR } from "./config.js";

const VERSION_FILE = path.join(DATA_DIR, "version.json");
const SOURCES = ["server.js", "lib", "public"];

function collect(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) collect(full, out);
    else if (/\.(js|mjs|css|html)$/.test(entry.name)) out.push(full);
  }
}

/* Fingerprint of the shipped code so a restart after editing files bumps the
   patch version automatically. */
function sourceHash() {
  const files = [];
  for (const rel of SOURCES) {
    const full = path.join(APP_DIR, rel);
    if (!fs.existsSync(full)) continue;
    if (fs.statSync(full).isDirectory()) collect(full, files);
    else files.push(full);
  }
  const hash = crypto.createHash("sha256");
  for (const f of files.sort()) hash.update(path.relative(APP_DIR, f)).update(fs.readFileSync(f));
  return hash.digest("hex").slice(0, 16);
}

const bump = (v) => {
  const [a, b, c] = String(v).split(".").map((n) => parseInt(n, 10) || 0);
  return `${a}.${b}.${c + 1}`;
};

const seedVersion = () => {
  try {
    return JSON.parse(fs.readFileSync(path.join(APP_DIR, "package.json"), "utf8")).version || "1.0.0";
  } catch {
    return "1.0.0";
  }
};

export function loadVersion() {
  const hash = sourceHash();
  let state = null;
  try {
    state = JSON.parse(fs.readFileSync(VERSION_FILE, "utf8"));
  } catch {
    state = null;
  }
  if (!state || !state.version) {
    state = { version: seedVersion(), hash, bumpedAt: new Date().toISOString(), builds: 1 };
  } else if (state.hash !== hash) {
    state = { version: bump(state.version), hash, bumpedAt: new Date().toISOString(), builds: (state.builds || 1) + 1 };
  }
  fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(VERSION_FILE, JSON.stringify(state, null, 2));
  return state;
}
