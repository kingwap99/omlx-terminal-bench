#!/usr/bin/env node
/* Install (or reinstall) the app as a macOS LaunchAgent so it starts at login. */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const LABEL = "com.omlx.bench-tracker";
const LOG_DIR = path.join(os.homedir(), "Library", "Logs");
const PLIST = path.join(os.homedir(), "Library", "LaunchAgents", `${LABEL}.plist`);
const NODE = process.execPath;

const xml = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key><string>${LABEL}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE}</string>
    <string>${path.join(APP_DIR, "server.js")}</string>
  </array>
  <key>WorkingDirectory</key><string>${APP_DIR}</string>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>StandardOutPath</key><string>${path.join(LOG_DIR, "omlx-bench-tracker.out")}</string>
  <key>StandardErrorPath</key><string>${path.join(LOG_DIR, "omlx-bench-tracker.err")}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${path.dirname(NODE)}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
  </dict>
</dict>
</plist>
`;

fs.mkdirSync(path.dirname(PLIST), { recursive: true });
fs.mkdirSync(LOG_DIR, { recursive: true });
fs.writeFileSync(PLIST, xml);
console.log(`wrote ${PLIST}`);

const uid = process.getuid();
try {
  execFileSync("launchctl", ["bootout", `gui/${uid}/${LABEL}`], { stdio: "ignore" });
} catch {
  /* not loaded yet */
}
execFileSync("launchctl", ["bootstrap", `gui/${uid}`, PLIST], { stdio: "inherit" });
console.log("loaded. logs:", path.join(LOG_DIR, "omlx-bench-tracker.out"));
