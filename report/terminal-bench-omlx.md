# Terminal-Bench 2.0：oMLX 三款 Qwen3.8-Flash-Next 變體

測試日期：2026-11-07（Asia/Taipei）  
模型伺服器：Apple M1 Max、128GB、oMLX 0.7.4.dev1、MLX 0.32.4；模型最大 context 262,144，本次 oMLX 實際上限 65,536  
Benchmark harness：Harbor 0.25.0 + Terminal-Bench 2.0  
Agent：Qwen Code 0.26.7，`qwen --yolo`，OpenAI-compatible endpoint  

## 先講結論

在同一個 18 題分層子集上，三款 oMLX 模型的分數是：

| 排名 | 模型 | Leak-checked 分數 | 解題數 |
|---:|---|---:|---:|
| 1 | `Qwen3.8-Flash-Next-Uncensored-oQ5e-mtp` | 66.7% | 12 / 18 |
| 2 | `Qwen3.8-Flash-Next-oQ4e-mtp` | 61.1% | 11 / 18 |
| 3 | `Swift1.5-Qwen3.8-Flash-Next-oQ5e-mtp` | 50.0% | 9 / 18 |

三款模型不是單純的「越大越好」：Uncensored oQ5e 多解了 `polyglot-rust-c`、`raman-fitting`、`merge-diff-arc-agi-task`，但在 `largest-eigenval`、`nginx-request-logging` 上輸給 oQ4e。Swift1.5 的解題數最少，且 timeout 最多（8 題）。

**重要限制：這是 18 題子集，不是文章完整的 86 題。** 三款 oMLX 模型之間的分數可以直接互相比較；把它們的 66.7% / 61.1% / 50.0% 直接拿去和文章的 69.8%（Qwen 完整 86 題）比較，則不是同一尺度。

## 為什麼是 18 題子集

文章用 Terminal-Bench 2.0 完整 89 題，排除 3 題基礎設施問題後計分 86 題。這台機器完整跑一輪的長尾太重：`build-pov-ray` 單題 agent timeout 是 200 分鐘，`sam-cell-seg` 是 120 分鐘，還有多題 60 分鐘。以這次 18 題、5 並行、每題約 11–13 分鐘中位數推估，三個模型完整跑 86 題會超過 12 小時，還沒算 image 建置與 amd64 模擬。

因此這次用固定 18 題分層子集，維持相同方法與計分規則：

- 4 題 easy、10 題 medium、4 題 hard。
- 所有題目的 agent timeout 不超過 20 分鐘，避免 200 分鐘的長尾占住並行槽。
- 覆蓋 software engineering、security、data science、system administration、scientific computing、file operations、data processing、model training、mathematics、debugging。
- One attempt per task；agent error、crash、timeout 都算 fail；只重試 `AgentSetupTimeoutError` 這類基礎設施錯誤。
- Leak check：掃描每個 trajectory 是否出現 Terminal-Bench 的 repo、dataset、官網或 Harbor Hub 來源。三款模型都是 0 flagged runs。

18 題清單：

`fix-git`、`overfull-hbox`、`cobol-modernization`、`prove-plus-comm`、`git-leak-recovery`、`openssl-selfsigned-cert`、`hf-model-inference`、`nginx-request-logging`、`raman-fitting`、`db-wal-recovery`、`log-summary-date-ranges`、`pytorch-model-cli`、`largest-eigenval`、`merge-diff-arc-agi-task`、`gpt2-codegolf`、`fix-code-vulnerability`、`model-extraction-relu-logits`、`polyglot-rust-c`。

## 三款 oMLX 模型：18 題結果

| 模型 | Leak-checked | Raw | 解題 | Easy (4) | Medium (10) | Hard (4) | 中位數時間 | Timeouts | Leak flags |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| `Qwen3.8-Flash-Next-oQ4e-mtp` | 61.1% | 61.1% | 11 / 18 | 50% | 80% | 25% | 11.3 min | 7 | 0 |
| `Qwen3.8-Flash-Next-Uncensored-oQ5e-mtp` | 66.7% | 66.7% | 12 / 18 | 50% | 80% | 50% | 13.3 min | 7 | 0 |
| `Swift1.5-Qwen3.8-Flash-Next-oQ5e-mtp` | 50.0% | 50.0% | 9 / 18 | 50% | 60% | 25% | 13.0 min | 8 | 0 |

效率數字（中位數）：

| 模型 | Tool calls | Tokens in | Tokens out |
|---|---:|---:|---:|
| `Qwen3.8-Flash-Next-oQ4e-mtp` | 12.5 | 261K | 10.3K |
| `Qwen3.8-Flash-Next-Uncensored-oQ5e-mtp` | 13.5 | 305K | 10.3K |
| `Swift1.5-Qwen3.8-Flash-Next-oQ5e-mtp` | 13.0 | 295K | 9.2K |

## 與文章裡的模型並排

下面這張表刻意保留 `Scope` 欄位：前三列是文章作者的完整 86 題結果，後三列是這次的 18 題子集。數字可以一起看，但不能當成同一個排行榜。

| Agent / model | Scope | Harness | Leak-checked | Raw | 解題 | Easy | Medium | Hard |
|---|---|---|---:|---:|---:|---:|---:|---:|
| Claude Code (Sonnet 5.5) | 86 tasks | Claude Code 2.1.318, effort high | 77.9% | 79.1% | 67 / 86 | 100% | 79% | 72% |
| Qwen Code (Qwen3.8-Flash-Next, IQ3_S) | 86 tasks | Qwen Code 0.26.7, Strata on RTX 5080 | 69.8% | 69.8% | 60 / 86 | 100% | 70% | 66% |
| Antigravity (Gemini 3.8 Flash) | 86 tasks | agy 1.5.0, high | 58.1% | 80.2% | 50 / 86 | 100% | 62% | 45% |
| Codex (GPT-6 Luna) | 86 tasks | Codex CLI 0.164.0, effort medium | 41.9% | 44.2% | 36 / 86 | 50% | 57% | 14% |
| `Qwen3.8-Flash-Next-oQ4e-mtp` | 18-task subset | Qwen Code 0.26.7, this oMLX run | 61.1% | 61.1% | 11 / 18 | 50% | 80% | 25% |
| `Qwen3.8-Flash-Next-Uncensored-oQ5e-mtp` | 18-task subset | Qwen Code 0.26.7, this oMLX run | 66.7% | 66.7% | 12 / 18 | 50% | 80% | 50% |
| `Swift1.5-Qwen3.8-Flash-Next-oQ5e-mtp` | 18-task subset | Qwen Code 0.26.7, this oMLX run | 50.0% | 50.0% | 9 / 18 | 50% | 60% | 25% |

僅供方向感的觀察：

- Uncensored oQ5e 在這個子集拿到 66.7%，和文章完整 86 題的 Qwen IQ3_S（69.8%）看起來接近，但兩者題目、硬體、量化與並行度都不同，不應解讀成「打成平手」。
- oQ4e 的 medium 表現（80%）與 Uncensored 相同；差距主要在 hard（25% vs 50%）。
- Swift1.5 在 medium 掉到 60%，hard 只有 25%，且 8 題 timeout。

## 逐題結果

| Task | Difficulty | oQ4e | Uncensored oQ5e | Swift1.5 oQ5e |
|---|---|---|---|---|
| cobol-modernization | easy | fail (timeout) | fail (timeout) | fail (timeout) |
| fix-git | easy | pass | pass | pass |
| overfull-hbox | easy | fail (timeout) | fail (timeout) | fail (timeout) |
| prove-plus-comm | easy | pass | pass | pass |
| db-wal-recovery | medium | pass (timeout) | pass (timeout) | pass (timeout) |
| git-leak-recovery | medium | pass | pass | pass |
| hf-model-inference | medium | pass | pass | fail (timeout) |
| largest-eigenval | medium | pass (timeout) | fail (timeout) | fail (timeout) |
| log-summary-date-ranges | medium | pass | pass | pass |
| merge-diff-arc-agi-task | medium | fail | pass (timeout) | pass |
| nginx-request-logging | medium | pass | fail | fail |
| openssl-selfsigned-cert | medium | pass | pass | pass |
| pytorch-model-cli | medium | pass (timeout) | pass (timeout) | pass (timeout) |
| raman-fitting | medium | fail | pass | fail |
| fix-code-vulnerability | hard | pass | pass | pass |
| gpt2-codegolf | hard | fail (timeout) | fail | fail |
| model-extraction-relu-logits | hard | fail | fail (timeout) | fail (timeout) |
| polyglot-rust-c | hard | fail | pass | fail |

`timeout` 表示 agent 執行到該題的 agent timeout；若 hidden tests 仍通過，分數照算 pass（`db-wal-recovery`、`largest-eigenval`、`pytorch-model-cli` 就是這種情況），與文章規則一致。

## 方法與差異

- 文章：RTX 5080 16GB + Ryzen 9 9950X + 96GB RAM，Strata，IQ3_S，262K context，1 並行。
- 這次：M1 Max 128GB + oMLX/MLX，oQ4e / oQ5e；模型上限 262K，但 oMLX 實際 `max_context_window` 是 65,536（128GB 記憶體限制），5 並行；Docker 在 M1 Pro 16GB 上以 amd64 模擬執行 task containers。
- 兩邊都用 Qwen Code 0.26.7、`qwen --yolo`、hidden tests、one attempt。
- 這次把 Qwen Code 的 Node/Qwen Code 工具鏈做成共用的 amd64 快取掛載到 `/opt/qwen`，避免每題重裝；agent 行為與版本不變。
- Timeout 是 fail；但 timeout 後 hidden tests 若已通過，仍算 pass。
- 量測的是 agent + CLI + tool loop + model 的整體表現，不是單純 model benchmark。

## Caveats

- 18 題樣本小：差 1 題就是 5.6 個百分點；三款模型之間的 1–3 題差距不宜過度解讀。
- 子集刻意排除了 60–200 分鐘的長尾題，因此不能推論到完整 86 題的分數。
- amd64 模擬與 5 並行會拖慢 tool 執行，timeout 次數可能比原生 x86 主機多。
- 量化不同：文章是 IQ3_S（約 3.5-bit），這次是 oQ4e（4-bit）與 oQ5e（5-bit）；較高 bit 不一定在 agent 任務上等比例轉成高分。
- Context 不同：文章 q3 用 262K，這次 oMLX 只開 65,536；長上下文任務對 q4/q5 不利。
- 只跑一次，沒有 pass@3；文章也只用 one attempt。
- Leak check 只掃描 trajectory 中是否出現 benchmark 來源；像 `git-leak-recovery` 這種 task 內部 commit author 叫 `TerminalBench` 的情況，已人工排除，不當成 leak。

## 重現

主要指令（每個模型更換 `-m` 與 `--job-name`）：

```bash
harbor run -p ds/subset18 \
  -a qwen-coder --ak version=0.26.7 \
  -m openai/Qwen3.8-Flash-Next-oQ4e-mtp \
  --base-url http://omlx.example:8258/v1 \
  --mounts '[{"type":"bind","source":"<repo>/work/agent-cache/qwen","target":"/opt/qwen","read_only":true}]' \
  -n 5 -r 2 --retry-include AgentSetupTimeoutError \
  -o jobs --job-name oq4e-sub18 -y
```

原始 job 目錄（未上傳）：`work/jobs/oq4e-sub18`、`work/jobs/unc-sub18`、`work/jobs/swift-sub18`。逐題明細在 `data/results.csv`。
