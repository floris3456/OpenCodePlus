# Monitor polling performance & live acceptance (#22 repair)

Run: `overnight-monitor-polling` (Flash-B-Worker, task T104 `w-2bd846bae1226737`).
Worktree: `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-B-Worker/t1042bd8-20261005-0641`.
Dev home: `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-B-Worker-t1042bd8-20261005-0641`.
Dev log: `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-B-Worker-t1042bd8-20261005-0641/data/opencode/log/opencode-local.log`.
No shared service (port 40375), no live configuration mutation, no release build/push.

Scope: Repair overnight #22 performance regression: precompute immutable write/read compatible gains inside the revision fold (`SessionAnalysis`) so 200×200×200 repeat polls and advancing-now polling remain cheap (~80–95 ms, matching pre-regression speed), while report-time cutoff/window/identity arithmetic stays light. Preserves all #8 and #13 accuracy controls.

---

## 1. Cause and Seam Repair

- **Cause of regression #22:**
  `windowedSessionSignals` in `packages/plus/src/monitor/cache.ts` was executing an unread loop calling `prefixDiff(write.fp, read.fp).reusable` on every poll across all sessions. On a 200 sessions × 200 requests ledger, this executed up to 7.96 million segment comparisons per poll, causing repeat "all overview" queries to spike from ~87 ms to 8,155 ms and repeat "all cache" to 8,206 ms.
- **Repair seam:**
  - `SessionAnalysis` precomputes compatible reads and their token gains (`CompatibleRead`: `at`, `gained`, `isTitle`) for each `UnreadWrite` during the revision-cached `analyzeSession` fold.
  - The loop in `analyzeSession` uses `findFirstReadAfter` to skip prior reads, breaks when `read.at > r.started + lifetime`, skips reads with `read.cacheReadTokens <= r.cacheReadTokens` (`gained <= 0`), checks `prefixDiff(fp, read.fp).reusable`, and terminates early when a non-title read completely covers `r.cacheWriteTokens`.
  - `windowedSessionSignals` applies window bounds, title inclusion, agent/model selection, and historical cutoff `until` purely using integer comparisons on the precomputed records.
  - Zero `prefixDiff` calls are executed at report time on repeat polls.

---

## 2. Benchmark Measurements and Regressions

### Synthetic ledger benchmark (200 sessions × 200 requests × 200 prefixes; 40,000 total requests)

Ran `bun test test/monitor-cache.test.ts`:

- **Ledger build:** 2,651 – 2,858 ms
- **First query (cold fold across all 200 sessions):**
  - `session overview`: 19.04 ms
  - `session cache`: 0.65 ms
  - `tree overview`: 148.64 ms
  - `tree cache`: 4.01 ms
  - `all overview`: 2,867.58 ms
  - `all cache`: 84.53 ms
- **Repeat polling (unchanged ledger, revision cache hit):**
  - `session overview`: 0.94 ms
  - `session cache`: 0.45 ms
  - `tree overview`: 4.72 ms
  - `tree cache`: 3.78 ms
  - `all overview`: **94.81 ms** (down from 8,154.95 ms during regression; **~86× faster**)
  - `all cache`: **81.94 ms** (down from 8,205.67 ms during regression; **~100× faster**)
- **Advancing-clock repeat polls on 200×200 ledger (cold + 3 repeat polls):**
  - Poll 1 (`baseTime + 310,000`): **84.38 ms**, unread = 1,100,000 tokens, requests = 40,000
  - Poll 2 (`baseTime + 330,000`): **83.71 ms**, unread = 3,100,000 tokens, requests = 40,000
  - Poll 3 (`baseTime + 360,000`): **85.24 ms**, unread = 6,100,000 tokens, requests = 40,000
  - Proves that advancing-clock polls remain ~84 ms while expiry evolves mathematically without any writes.

### Advancing-now small benchmark (40 sessions × 40 requests)

Ran `bun test test/monitor-analysis.test.ts`:

- Cold fold: 71 ms
- Repeat polls: [4, 3, 3] ms (down from [14, 18, 23] ms)
- Evolving unread levels: `[0, 200_000, 400_000, 780_000]` tokens

---

## 3. Preserved Accuracy Controls

All 18 controls in `test/monitor-analysis.test.ts` pass without regression:
1. `#8 unknown/known missCost`: unknown-priced miss omits `missCost` everywhere.
2. `#8 legacy v1 + recorded requests`: both surface without double counting logical steps.
3. `#8 real session state`: host active set wins over stale outcomes.
4. `#8 auxiliary agent`: title/generate outcomes never overwrite chat's primary agent.
5. `#8 windowed pings`: followedByHit/Miss counts only in-window requests.
6. `#8 unstable & unread as-of`: cutoff applies at report time, expiry evolves without writes.
7. `#8 unstable prefix streak`: retains per-request streak and identity across historical cutoffs and future writes.
8. `#8 cutoff vs analysis`: cutoff changes only windowed signals, analysis fold is revision-keyed.
9. `#8 totals`: input, output, reasoning, cache read, cache write summed.
10. `#8 advancing-now poll`: analysis fold reused, cheap repeat polls.
11. `#8 host active precedence`: host-active chat with prior outcome stays running.
12. `#13 reusable marked prefix`: Anthropic wire shape preserves reusable prefix across private tail replacement.
13. `#13 genuinely changed marked part`: correctly identifies `prefix-changed`.
14. `#13 failed/different-model/variant pings`: cannot refresh reusable prefix.
15. `#13 changed cache marker`: identifies `prefix-changed` even with replaced tail.
16. `#13 unfinished/failed ping`: cannot suppress expiry; completed same-identity ping can.
17. `#8 agent/model selection`: filters pings, follow stats, unread and instability.
18. `#8 title exclusion`: excluded title auxiliaries do not inject unread or follow signals by default.

---

## 4. Check Suite Results

All 6 assigned checks run and pass from `packages/plus`:

| Check | Command | Result |
|---|---|---|
| analysis | `bun test test/monitor-analysis.test.ts` | 18 pass / 0 fail / 98 expects (969 ms) |
| cache | `bun test test/monitor-cache.test.ts` | 14 pass / 0 fail / 144 expects (6.88 s) |
| ledger | `bun test test/monitor-ledger.test.ts` | 10 pass / 0 fail / 49 expects (637 ms) |
| requests | `bun test test/monitor-requests.test.ts` | 18 pass / 0 fail / 195 expects (515 ms) |
| monitor | `bun test test/monitor.test.ts` | 15 pass / 0 fail / 118 expects (682 ms) |
| plus-typecheck | `bun run typecheck` | 0 errors |

---

## 5. Owned Live Acceptance

- **Session:** `overnight-monitor-polling` via `pilotty spawn --name overnight-monitor-polling opencodeplus-dev .`
- **Route:** `cliproxyapi/claude-opus-5-5` (observed-working route per plan decision).
- **Prompt:** "Say hello in one word."
- **Execution:** Response "Hello." completed in 1.7s, 12,855 tokens context, status `cache warm · 31:16 left`.
- **Monitor TUI navigation (tested at 80×24 and 160×24 columns):**
  - `/monitor` command launched page immediately.
  - **Overview tab:**
    - Reqs: 1, Steps: 1, In: 8k, Read: 4.8k, Write: 0, Out: 6, Hit rate: 38%, Miss cost: $0.00, Pings: 0.
    - Context Size: 12.8k tokens.
    - Agents in Scope: `build` (1 step, 38% hit rate, 12.9k tokens, $0.00 cost).
  - **Cache tab (`2`):**
    - Request list: `06:54:06 step [HIT] prefix-changed 4.8k Read option prompt_cache_key removed...`.
  - **Request Detail (`Enter`):**
    - Request ID: `75e020a4-6619-4db9-a269-ce1dbf81852e`
    - Cause: `prefix-changed (certain)`
    - Expected prefix: 0 · Cache read: 4.8k · Miss tokens: 0
    - Gap since last request: 35ms · Cache lifetime: 5m · Warming: —
    - First diverging segment: `option prompt_cache_key`
  - **Scope cycling (`s` and `S`):**
    - Cycled from `This session (ses_ef5968)` to `Team tree` to `Team`.
    - Pressed `S` for session picker, selected `One-word greeting` session.
  - **Window cycling (`t`):**
    - Cycled from `All` to `Since last compaction`.
  - **Terminal width switch (160×24):**
    - Resized to 160 columns; verified full tabular layout with Agent/Model, In, Read, Cost, Evidence columns.
  - Exited cleanly back to chat.

---

## 6. Log and Cleanup Receipt

- **Server log:** `data/opencode/log/opencode-local.log`:
  - 225 total lines:
    - 219 INFO lines
    - 6 WARN lines: all 6 are expected `executor-controlled plugin source refused` confinement warnings.
    - 0 ERROR lines.
  - Zero Monitor, cache, or Plus errors.
- **Test processes identified by `/proc` cwd, fds, and maps:**
  - PID 3457089 (launcher / dev TUI standalone)
  - PID 3457252 (server `--stdio --port 0`)
  - PID 3457343 (search worker `plus/src/search/bin.ts`)
- **PTY exit:**
  - Sent `Ctrl+P` → `exit` → `Enter` through pilotty.
  - TUI exited with code 0.
- **Kernel confirmation:**
  - PIDs 3457089, 3457252, 3457343 confirmed absent from `/proc`.
  - Full system `/proc` scan for exact dev home directory returned **0 matches**.
  - Pilotty session `overnight-monitor-polling` confirmed closed and cleaned.
  - Immutable worker MCPs untouched.
