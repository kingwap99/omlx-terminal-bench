# oMLX Terminal-Bench Runner

A local app that benchmarks oMLX models with the same method the ponkcoding article used (Terminal-Bench 2.0 + Harbor + Qwen Code).

## Five features

1. **Pick a model**: lists models live from oMLX `/v1/models` (size, context, loaded state) and can load, unload, or preload them.
2. **Track progress**: refreshes every 4 seconds with current batch, completed tasks, ETA, per-task results, and a live log tail.
3. **Pause and resume**: runs are scheduled in batches (one batch = one harbor invocation with N concurrent tasks). Pause waits for the current batch to finish (or kills it immediately); unfinished tasks re-run when you resume.
4. **Save and compare**: every run is stored under `data/runs/<id>/` (run.json, results.json, raw harbor output, trial copies). The Compare tab puts selected runs side by side, can include the article's 86-task rows, and shows a per-task ✅/❌/⏱ matrix between local runs.
5. **Host hardware**: at start the app snapshots the Mac Studio specs from oMLX admin `device-info` (chip, DRAM, GPU cores) plus engine versions from `/admin/api/stats`, and stores them in the run record.

## Running it

- URL: <http://localhost:4665> (binds 0.0.0.0, reachable from other devices on the LAN)
- Install as a LaunchAgent (starts at login, restarts on crash):
  ```bash
  node scripts/install-launchagent.mjs
  launchctl kickstart -k gui/$(id -u)/com.omlx.bench-tracker   # restart after edits
  ```
- Logs: `~/Library/Logs/omlx-bench-tracker.{out,err}`
- Manual start: `node server.js` (override the port with `PORT`)

## Configuration

Settings live in `data/config.json` and are editable from the Settings tab. Defaults can also come from the environment:

| Variable | Used for |
| --- | --- |
| `OMLX_BASE_URL` | oMLX endpoint (default `http://127.0.0.1:8258`) |
| `OMLX_API_KEY` | API key sent as a bearer token |
| `HARBOR_BIN` | harbor binary (default `harbor` on `PATH`) |
| `DOCKER_HOST` | Docker socket (e.g. Colima) |
| `HARBOR_DATASET_DIR` | directory holding Terminal-Bench task folders |
| `HARBOR_AGENT_CACHE` | optional pre-installed agent toolchain to bind-mount into containers |
| `PORT` | HTTP port (default 4665) |

Get the task set with `harbor download terminal-bench` or by copying task folders that contain `task.toml`; point `HARBOR_DATASET_DIR` at that directory.

## How it matches the article

Same: Terminal-Bench 2.0 tasks, Qwen Code agent, timeouts counted as failures, and the leak check (agent output and trajectory scanned for benchmark source hints; flagged runs are excluded from the "leak-checked" rate).

Differences to keep in mind when comparing:
- Default batch size is 4 concurrent tasks (the article used 1). Concurrency slows each task and raises timeout risk; set "Tasks per batch" to 1 for a fair comparison.
- The host is a Mac Studio (M5 Max · 128GB · 40 GPU cores per oMLX `device-info`) running oMLX; the article used RTX 5080 + Strata.
- `qemu-*` and `mcmc-sampling-stan` are excluded by default because their environments do not run here, leaving 86 of 89 tasks.

## Data

- `data/config.json`: oMLX URL/API key and harbor paths/defaults (local only; the UI shows a masked key)
- `data/reference.json`: the article's 86-task scores (the 📰 option in Compare)
- `data/runs/<id>/`: one directory per run; CSV export via `/api/runs/<id>/export.csv`
- `scripts/import-archive.mjs`: imports existing harbor jobs (used for the three 18-task runs; their machine field reflects the M1 Max host at the time)

## Layout

```
server.js            HTTP API + static UI
lib/config.js        config load/save
lib/omlx.js          oMLX API (models, health, device-info, preload)
lib/tasks.js         task scanning, TOML parsing, harbor result.json -> record, leak check, stats
lib/runner.js        batch scheduling, pause/resume/stop, trial archiving, notifications
public/              front-end (plain static files, no framework)
test/fake-harbor.mjs fake harbor used to verify the runner loop (test/ds holds a small task set)
scripts/install-launchagent.mjs  macOS LaunchAgent installer
```

## Runner details

- Each batch runs: `harbor run -p <dataset> -i <task>... -a qwen-coder --ak version=0.26.7 -m openai/<model> --base-url <omlx>/v1 -n <batch size> -r 2 --retry-include AgentSetupTimeoutError --mounts <agent-cache> -o data/runs/<id>/harbor --job-name batch-NNN -y` (the agent toolchain is bind-mounted from `work/agent-cache/qwen` so it is not reinstalled per batch).
- `DOCKER_HOST` (Colima) and `OPENAI_API_KEY` are passed through the environment.
- Optional preload sends a tiny request before starting, turning a failed model load into a clear error instead of dozens of timeouts.
- Each batch has a hard cap (default 300 min); exceeding it SIGTERMs then SIGKILLs the whole process group.
- On service restart, runs left in "running" are marked paused so they can be resumed.
