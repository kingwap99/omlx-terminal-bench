# Terminal-Bench 2.0 on oMLX: Qwen3.8-Flash-Next variants

This repository contains a reproducible Terminal-Bench 2.0 evaluation of three
Qwen3.8-Flash-Next variants served by oMLX on an Apple M1 Max (128GB), plus the
comparison with the four agents published in the Ponkcoding Terminal-Bench 2.0
article.

## Status

- The 18-task stratified subset is complete for all three oMLX models.
- The full 86-task Terminal-Bench 2.0 run for
  `Qwen3.8-Flash-Next-oQ4e-mtp` was stopped after 3 completed tasks because the
  one-concurrency run was taking too long on this hardware. Partial results are
  in `data/full-run-partial.json`; no full-suite q4 percentage is available.

## Subset results

All three models ran the same 18 tasks with Qwen Code 0.26.7, one attempt per
task, timeouts counted as failures, and a leak check over every trajectory.

| Model | Leak-checked | Solved | Easy | Medium | Hard | Median time | Timeouts |
|---|---:|---:|---:|---:|---:|---:|---:|
| `Qwen3.8-Flash-Next-Uncensored-oQ5e-mtp` | **66.7%** | 12 / 18 | 50% | 80% | 50% | 13.3 min | 7 |
| `Qwen3.8-Flash-Next-oQ4e-mtp` | **61.1%** | 11 / 18 | 50% | 80% | 25% | 11.3 min | 7 |
| `Swift1.5-Qwen3.8-Flash-Next-oQ5e-mtp` | **50.0%** | 9 / 18 | 50% | 60% | 25% | 13.0 min | 8 |

Uncensored oQ5e gained `polyglot-rust-c`, `raman-fitting`, and
`merge-diff-arc-agi-task` over oQ4e, but lost `largest-eigenval` and
`nginx-request-logging`. All three runs had zero leak-check flags.

## Published full-suite comparison

These rows are from the Ponkcoding article (full 86 scored tasks). They are shown
for context only; they are not directly comparable to the 18-task subset.

| Agent / model | Leak-checked | Raw | Solved | Easy | Medium | Hard |
|---|---:|---:|---:|---:|---:|---:|
| Claude Code (Sonnet 5.5) | 77.9% | 79.1% | 67 / 86 | 100% | 79% | 72% |
| Qwen Code (Qwen3.8-Flash-Next, IQ3_S) | 69.8% | 69.8% | 60 / 86 | 100% | 70% | 66% |
| Antigravity (Gemini 3.8 Flash) | 58.1% | 80.2% | 50 / 86 | 100% | 62% | 45% |
| Codex (GPT-6 Luna) | 41.9% | 44.2% | 36 / 86 | 50% | 57% | 14% |

## Important caveats

- The subset is 18 tasks, not the full 86. Do not compare its percentage
  directly with the article's full-suite percentages.
- The oMLX server is an Apple M1 Max with 128GB. The model's maximum context is
  262,144 tokens, but the run used a 65,536-token server limit because of the
  memory guard. The article's q3 used 262K context.
- The subset runs used 5 concurrent trials; the article's Qwen run used 1. The
  full q4 run in progress uses 1 concurrency.
- Quantization is not a simple bit-width ladder: IQ3_S is a llama.cpp imatrix
  quant, while oQ4e/oQ5e are MLX quantizations. Different kernels, KV cache, and
  hardware also affect agent behavior.
- A 1-task difference is 5.6 percentage points on the 18-task subset.

## Files

- `report/terminal-bench-omlx.md` - full report with the per-task matrix and methodology.
- `data/results.csv` - per-task metrics for all three models.
- `data/summary.json` - aggregate scores, timeouts, and token medians.
- `data/tasks-subset18.txt` - the 18 task names.
- `scripts/analyze_jobs.py` - Harbor job parser and leak check.
- `scripts/report.py` - table and CSV generator.

## Attribution

The full-suite comparison numbers and the benchmark method come from Rifan
Fauzi's article "Benchmarking four coding agents on Terminal-Bench 2.0" at
<https://ponkcoding.com/s/8fwsfu>. The oMLX results in this repository were
measured independently.
