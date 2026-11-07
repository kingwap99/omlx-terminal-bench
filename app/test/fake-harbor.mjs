/* Minimal stand-in for `harbor run` used to verify the runner loop.
   Honors: -i <task>, -o <jobsdir> --job-name <name>, and sleeps per task.
   Tasks named "fail-*" exit non-zero without writing results (simulates infra error). */
import fs from "node:fs";
import path from "node:path";

const argv = process.argv.slice(2);
const tasks = [];
let outDir = "jobs";
let jobName = "job";
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "-i") tasks.push(argv[++i]);
  else if (argv[i] === "-o") outDir = argv[++i];
  else if (argv[i] === "--job-name") jobName = argv[++i];
}
console.log(`fake-harbor ${jobName}: ${tasks.join(",")}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* simulate infra failure while the marker file exists */
const bad = tasks.find((t) => t.startsWith("fail-"));
if (bad && fs.existsSync("/tmp/fake-harbor-fail")) {
  await sleep(3000);
  console.error(`fake-harbor: simulated infra failure on ${bad}`);
  process.exit(2);
}
await sleep(15000);
const jobDir = path.join(outDir, jobName);
for (const t of tasks) {
  const trial = path.join(jobDir, `${t}__FAKE01`);
  fs.mkdirSync(path.join(trial, "agent"), { recursive: true });
  const now = new Date();
  const start = new Date(now.getTime() - 45000).toISOString().replace(/.\d+Z$/, "Z");
  fs.writeFileSync(
    path.join(trial, "result.json"),
    JSON.stringify({
      exception_info: null,
      verifier_result: { rewards: { reward: t.startsWith("bad-") ? 0 : 1 } },
      agent_result: { n_input_tokens: 12345, n_output_tokens: 678 },
      agent_execution: { started_at: start, finished_at: now.toISOString().replace(/.\d+Z$/, "Z") },
    })
  );
  fs.writeFileSync(path.join(trial, "agent", "qwen-code.txt"), "just chatting, nothing to see");
  fs.writeFileSync(path.join(trial, "agent", "trajectory.json"), JSON.stringify({ steps: [{ tool_calls: [{ id: 1 }, { id: 2 }] }] }));
}
console.log("fake-harbor done");
