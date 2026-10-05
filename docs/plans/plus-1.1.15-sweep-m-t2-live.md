# plus-1.1.15 Monitor T2 live sweep (final)

Scope: verify every end-state line of `docs/plans/plus-1.1.12-monitor.md` (cache
analysis and the Code Mode agent tools) in **this worktree's own build**, and
record the result per line. Source: none changed — this file only.

Build under test: worktree `team/Flash-C-Worker/t1235bc2-20261005-1623`
(HEAD `012caf2267b27eae35dbe01800ededa75dd7e1ff`).
Command: `pilotty spawn --name sweep-m-t2 opencodeplus-dev .` (own build, own
home; never `dev:live`, never port 40375, never `~/.config/opencodeplus`).
Owned dev home:
`/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t1235bc2-20261005-1623`.
Server log:
`$DEV/data/opencode/log/opencode-local.log`.
Chat model: `cliproxyapi/claude-opus-5-5@high` (the DeepSeek-cheap route reported
no cache fields; see line A1 note).

Each line below quotes the screen text, file line or log line observed and ends
with **PASS**, **FAIL** or **NOT LIVE** plus the reason where it is not live.

## A. Verdicts

### A1. Every request gets a cache verdict: hit, partial miss, miss, cold start, no cache reported

Did: three plain prompts in one `Build` chat on `cliproxyapi/claude-opus-5-5@high`
(the DeepSeek-cheap route reported no cache fields, so the notes' fallback model
was used), then `/monitor` → Cache (`2`). Verdicts seen live:

- **no cache reported** (`[NONE]`): the first request, whose Detail reads
  `Expected prefix: 0 · Cache read: 0` and
  `Cause: prefix-changed (certain)`.
- **miss** (`[MISS]`): `16:28:10 step [MISS] unknown 5k Reusable ...or routing`.
- **hit** (`[HIT]`): `16:31:29 step [HIT] — 12.9k Cache rea...889 tokens`, Detail
  `Cause: none (certain) · Expected prefix: 12.9k · Cache read: 12.9k · Miss tokens: 0`.
- **cold start** (`[COLD]`): shown live by the compaction/model-switch lines
  below (C1/C2), and by the Cache legend rendering `[COLD]` dim
  (`packages/plus/src/tui/monitor/tabs/cache.tsx:52`).
- **partial miss** (`[PARTIAL]`): not reproduced live (a partial read is a
  race), covered by the focused test
  `test/monitor-cache.test.ts` "append uses measured prompt tokens; changed
  prefixes estimate segments; thresholds are exact": `["partial", 2000,
  "partial"]` with `expected: 4000` — `bun test test/monitor-cache.test.ts`
  14 pass.

Screen (`/monitor` Cache at 80×24): `16:25:40 step [NONE] prefix-changed 0`;
`16:28:10 step [MISS] unknown 5k`; `16:31:29 step [HIT] — 12.9k`.

**PASS** (all five verdicts; hit / miss / none / cold shown live, partial by the
named focused test).

### A2. Expected reusable prefix, and the miss / partial thresholds

Did: read the second and third request's Cache Detail in the same chat.

- Second request (`16:28:10`, `4bfc60bf-5719-430d-b9fd-3d39c59a3595`) Detail:
  `Cause: unknown (unknown) · Expected prefix: 12.9k · Cache read: 5k · Miss
  tokens: 7.8k`, evidence
  `Reusable prefix unchanged, within cache lifetime; provider-side eviction or routing`,
  expected-line `12889 tokens (previous real prompt usage)`, actual cache read
  `5000`. Verdict `[MISS]` because expected 12889 ≥ 1024 and read 5000 < 6444
  (50 %).
- Third request (`16:31:29`, `1804a187-d3ba-45f7-8ee2-2e952d31cda8`) Detail:
  `Cause: none (certain) · Expected prefix: 12.9k · Cache read: 12.9k · Miss
  tokens: 0`, evidence `Cache read 12885; expected reusable prefix 12889 tokens`
  and `Expected reusable prefix: 12889 tokens (previous real prompt usage);
  actual cache read: 12885`. Verdict `[HIT]` (read ≥ 90 %).
- The measured-from-real-prompt-tokens path is the one exercised: a pure append
  of the previous request of the same session/provider/model, so expected is
  `previous real prompt usage`. The segment-size-estimate path (changed prefix)
  and the exact 1024 / 50 % / 90 % boundaries are covered by
  `test/monitor-cache.test.ts` "append uses measured prompt tokens; changed
  prefixes estimate segments; thresholds are exact": read 1999 → `miss`,
  2000 → `partial`, 3600 → `hit`, all with `expected: 4000`; a changed system
  part estimates `expected` 2560. `bun test test/monitor-cache.test.ts`: 14 pass.

**PASS**.
