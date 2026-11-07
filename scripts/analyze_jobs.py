#!/usr/bin/env python3
"""Summarize Harbor Terminal-Bench jobs and run the article's leak check."""

from __future__ import annotations

import argparse
import glob
import json
import os
import re
import statistics
import tomllib
from collections import Counter, defaultdict
from datetime import datetime
from pathlib import Path


LEAK_PATTERNS = [
    ("terminal-bench repo", re.compile(r"github\.com/[^\s\"']*terminal[-_]bench", re.I)),
    ("terminal-bench dataset", re.compile(r"huggingface\.co/(datasets|spaces)/[^\s\"']*terminal[-_]bench", re.I)),
    ("tbench.ai", re.compile(r"tbench\.ai", re.I)),
    ("terminal-bench registry", re.compile(r"terminal[-_]bench@\d|datasets/terminal[-_]bench", re.I)),
    ("terminal-bench canary", re.compile(r"terminal[-_]bench[-_]canary", re.I)),
    ("harbor source", re.compile(r"harborframework\.com|harbor hub|harbor\.run|[\"']harbor (run|upload)", re.I)),
]


def read_json(path: Path):
    try:
        return json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None


def parse_time(value: str | None) -> datetime | None:
    if not value:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None


def task_meta(task: str, dataset: Path) -> dict:
    path = dataset / task / "task.toml"
    if not path.exists():
        return {}
    try:
        with path.open("rb") as handle:
            return tomllib.load(handle)
    except (OSError, tomllib.TOMLDecodeError):
        return {}


def leak_flags(text: str) -> list[str]:
    hits = []
    for label, pattern in LEAK_PATTERNS:
        if pattern.search(text):
            hits.append(label)
    return hits


def collect(job: Path, dataset: Path) -> list[dict]:
    records = []
    for trial in sorted(job.iterdir()):
        if not trial.is_dir() or "__" not in trial.name:
            continue
        result = read_json(trial / "result.json")
        if not result:
            continue
        task = trial.name.rsplit("__", 1)[0]
        meta = task_meta(task, dataset).get("metadata", {})
        reward = None
        exception = result.get("exception_info") or {}
        verifier = result.get("verifier_result") or {}
        rewards = verifier.get("rewards") or {}
        if rewards:
            reward = rewards.get("reward", next(iter(rewards.values())))
        # Agent errors, crashes and timeouts count as fails, matching the article.
        if reward is None and exception:
            reward = 0.0
        passed = float(reward or 0) >= 1.0

        agent_result = result.get("agent_result") or {}
        agent_run = result.get("agent_execution") or {}
        started = parse_time(agent_run.get("started_at"))
        finished = parse_time(agent_run.get("finished_at"))
        duration = (finished - started).total_seconds() if started and finished else None

        texts = []
        for name in ("agent/qwen-code.txt", "agent/trajectory.json"):
            path = trial / name
            if path.exists():
                texts.append(path.read_text(encoding="utf-8", errors="replace"))
        transcript = "\n".join(texts)
        flags = leak_flags(transcript)

        tool_calls = 0
        traj = read_json(trial / "agent/trajectory.json")
        if traj:
            for step in traj.get("steps", []):
                tool_calls += len(step.get("tool_calls") or [])

        timeout = ((meta.get("agent") or {}).get("timeout_sec")) or None
        timed_out = bool(
            exception.get("exception_type") == "AgentTimeoutError"
            or (duration and timeout and duration >= timeout - 5)
        )

        records.append(
            {
                "task": task,
                "passed": passed,
                "reward": reward,
                "flagged": bool(flags),
                "flags": flags,
                "duration": duration,
                "timed_out": timed_out,
                "tool_calls": tool_calls,
                "input_tokens": agent_result.get("n_input_tokens") or 0,
                "cache_tokens": agent_result.get("n_cache_tokens") or 0,
                "output_tokens": agent_result.get("n_output_tokens") or 0,
                "difficulty": meta.get("difficulty"),
                "category": meta.get("category"),
                "exception": bool(exception),
                "exception_type": exception.get("exception_type"),
            }
        )
    return records


def pct(n: int, d: int) -> str:
    return f"{100.0 * n / d:.1f}%" if d else "n/a"


def summarize(name: str, records: list[dict]) -> dict:
    scored = [r for r in records if r["reward"] is not None]
    passed = [r for r in scored if r["passed"]]
    clean = [r for r in scored if not r["flagged"]]
    clean_passed = [r for r in clean if r["passed"]]
    durations = [r["duration"] for r in scored if r["duration"]]
    print(f"\n== {name} ==")
    print(f"trials: {len(records)}  scored: {len(scored)}  exceptions: {sum(r['exception'] for r in records)}")
    print(f"raw: {len(passed)}/{len(scored)} = {pct(len(passed), len(scored))}")
    print(f"leak-checked: {len(clean_passed)}/{len(clean)} = {pct(len(clean_passed), len(clean))}")
    if passed:
        print(f"flagged passes: {sum(r['passed'] and r['flagged'] for r in scored)}")
        print(f"flagged runs: {sum(r['flagged'] for r in scored)}")
    if durations:
        print(f"median agent time: {statistics.median(durations)/60:.1f} min")
        print(f"timeouts: {sum(r['timed_out'] for r in scored)}")
    if scored:
        print(
            "median tool calls / tokens in / tokens out: "
            f"{statistics.median([r['tool_calls'] for r in scored]):.0f} / "
            f"{statistics.median([r['input_tokens'] for r in scored])/1000:.0f}K / "
            f"{statistics.median([r['output_tokens'] for r in scored])/1000:.1f}K"
        )
    for key in ("difficulty", "category"):
        groups = defaultdict(list)
        for r in scored:
            groups[r[key] or "unknown"].append(r)
        print(f"-- by {key}")
        for group in sorted(groups, key=lambda g: (-len(groups[g]), g)):
            rows = groups[group]
            print(
                f"  {group:24s} {len([r for r in rows if r['passed']])/len(rows)*100:5.1f}% "
                f"({len(rows)} tasks, clean {len([r for r in rows if r['passed'] and not r['flagged']])/len(rows)*100:5.1f}%)"
            )
    return {"scored": len(scored), "passed": len(passed), "clean_passed": len(clean_passed), "clean": len(clean)}


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("jobs", nargs="+")
    parser.add_argument("--dataset", default="ds/terminal-bench")
    parser.add_argument("--json-out")
    args = parser.parse_args()
    dataset = Path(args.dataset)
    out = {}
    for name in args.jobs:
        records = collect(Path(name), dataset)
        out[Path(name).name] = summarize(Path(name).name, records)
        for r in records:
            if r["flagged"]:
                print(f"  FLAG {r['task']}: {', '.join(r['flags'])} pass={r['passed']}")
    if args.json_out:
        Path(args.json_out).write_text(json.dumps(out, indent=2))


if __name__ == "__main__":
    main()
