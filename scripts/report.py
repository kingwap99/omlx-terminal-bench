#!/usr/bin/env python3
"""Render the Terminal-Bench comparison tables from Harbor job directories."""

from __future__ import annotations

import argparse
import csv
import statistics
from collections import defaultdict
from pathlib import Path

from analyze_jobs import collect


ARTICLE_ROWS = [
    {
        "agent": "Claude Code (Sonnet 5.5)",
        "scope": "86 tasks",
        "harness": "Claude Code 2.1.318, effort high",
        "score": 77.9,
        "raw": 79.1,
        "solved": 67,
        "n": 86,
        "easy": "100%",
        "medium": "79%",
        "hard": "72%",
        "time": 0.9,
        "calls": 5,
        "tin": 124,
        "tout": 3.4,
        "timeouts": 5,
    },
    {
        "agent": "Qwen Code (Qwen3.8-Flash-Next, IQ3_S)",
        "scope": "86 tasks",
        "harness": "Qwen Code 0.26.7, Strata on RTX 5080",
        "score": 69.8,
        "raw": 69.8,
        "solved": 60,
        "n": 86,
        "easy": "100%",
        "medium": "70%",
        "hard": "66%",
        "time": 6.2,
        "calls": 34,
        "tin": 1330,
        "tout": 30,
        "timeouts": 14,
    },
    {
        "agent": "Antigravity (Gemini 3.8 Flash)",
        "scope": "86 tasks",
        "harness": "agy 1.5.0, high",
        "score": 58.1,
        "raw": 80.2,
        "solved": 50,
        "n": 86,
        "easy": "100%",
        "medium": "62%",
        "hard": "45%",
        "time": 9.9,
        "calls": 63,
        "tin": 2980,
        "tout": 34,
        "timeouts": 7,
    },
    {
        "agent": "Codex (GPT-6 Luna)",
        "scope": "86 tasks",
        "harness": "Codex CLI 0.164.0, effort medium",
        "score": 41.9,
        "raw": 44.2,
        "solved": 36,
        "n": 86,
        "easy": "50%",
        "medium": "57%",
        "hard": "14%",
        "time": 1.1,
        "calls": 8,
        "tin": 145,
        "tout": 2.4,
        "timeouts": 0,
    },
]


def diff_pct(records: list[dict], difficulty: str) -> str:
    rows = [r for r in records if r["difficulty"] == difficulty and r["reward"] is not None]
    if not rows:
        return "—"
    return f"{sum(r['passed'] and not r['flagged'] for r in rows) / len(rows) * 100:.0f}%"


def model_row(name: str, records: list[dict], harness: str) -> dict:
    scored = [r for r in records if r["reward"] is not None]
    clean = [r for r in scored if not r["flagged"]]
    passed = [r for r in scored if r["passed"]]
    clean_passed = [r for r in clean if r["passed"]]
    durations = [r["duration"] for r in scored if r["duration"]]
    return {
        "agent": name,
        "scope": "18-task subset",
        "harness": harness,
        "score": 100 * len(clean_passed) / len(clean) if clean else None,
        "raw": 100 * len(passed) / len(scored) if scored else None,
        "solved": len(clean_passed),
        "n": len(scored),
        "easy": diff_pct(scored, "easy"),
        "medium": diff_pct(scored, "medium"),
        "hard": diff_pct(scored, "hard"),
        "time": statistics.median(durations) / 60 if durations else None,
        "calls": statistics.median([r["tool_calls"] for r in scored]) if scored else None,
        "tin": statistics.median([r["input_tokens"] for r in scored]) / 1000 if scored else None,
        "tout": statistics.median([r["output_tokens"] for r in scored]) / 1000 if scored else None,
        "timeouts": sum(r["timed_out"] for r in scored),
        "flagged": sum(r["flagged"] for r in scored),
    }


def fmt(value, digits=1, suffix="") -> str:
    if value is None:
        return "—"
    if isinstance(value, str):
        return value
    return f"{value:.{digits}f}{suffix}"


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("jobs", nargs="+", help="job labels in the form name=path")
    parser.add_argument("--dataset", default="ds/terminal-bench")
    parser.add_argument("--out", default="results.md")
    parser.add_argument("--csv", default="results.csv")
    args = parser.parse_args()

    rows = list(ARTICLE_ROWS)
    all_records = {}
    for spec in args.jobs:
        label, _, path = spec.partition("=")
        records = collect(Path(path or label), Path(args.dataset))
        all_records[label] = records
        rows.append(model_row(label, records, "Qwen Code 0.26.7, this oMLX run"))

    lines = [
        "| Agent / model | Scope | Harness | Leak-checked | Raw | Solved | Easy | Medium | Hard |",
        "|---|---|---|---:|---:|---:|---:|---:|---:|",
    ]
    for row in rows:
        score = fmt(row["score"], 1, "%") if not isinstance(row["score"], str) else row["score"]
        raw = fmt(row["raw"], 1, "%") if not isinstance(row["raw"], str) else row["raw"]
        solved = f"{row['solved']} / {row['n']}" if row["n"] else "—"
        lines.append(
            f"| {row['agent']} | {row.get('scope', '—')} | {row['harness']} | {score} | {raw} | {solved} | "
            f"{row['easy']} | {row['medium']} | {row['hard']} |"
        )

    lines += [
        "",
        "| Agent / model | Median time | Median tool calls | Median tokens in | Median tokens out | Timeouts |",
        "|---|---:|---:|---:|---:|---:|",
    ]
    for row in rows:
        lines.append(
            f"| {row['agent']} | {fmt(row.get('time'), 1, ' min')} | {fmt(row.get('calls'), 0)} | "
            f"{fmt(row.get('tin'), 0, 'K')} | {fmt(row.get('tout'), 1, 'K')} | {fmt(row.get('timeouts'), 0)} |"
        )

    if all_records:
        lines += ["", "| Task | " + " | ".join(all_records) + " |", "|---|" + "---|" * len(all_records)]
        tasks = sorted({r["task"] for recs in all_records.values() for r in recs})
        for task in tasks:
            cells = []
            for label in all_records:
                match = next((r for r in all_records[label] if r["task"] == task), None)
                if not match:
                    cells.append("—")
                elif match["passed"] and match["flagged"]:
                    cells.append("pass (leak)")
                elif match["passed"]:
                    cells.append("pass")
                else:
                    cells.append("fail")
            lines.append(f"| {task} | " + " | ".join(cells) + " |")

    Path(args.out).write_text("\n".join(lines) + "\n")

    with Path(args.csv).open("w", newline="") as handle:
        writer = csv.writer(handle)
        writer.writerow(["model", "task", "passed", "flagged", "duration_sec", "tool_calls", "input_tokens", "output_tokens", "difficulty", "category"])
        for label, records in all_records.items():
            for r in records:
                writer.writerow([
                    label, r["task"], r["passed"], r["flagged"], r["duration"],
                    r["tool_calls"], r["input_tokens"], r["output_tokens"],
                    r["difficulty"], r["category"],
                ])
    print("\n".join(lines[:16]))


if __name__ == "__main__":
    main()
