# Monitor analysis accuracy — owned live evidence (#8 / #13)

Run: `overnight-analysis-backup` (Flash-B-Worker, T99 backup run `w-aeb3b1ca76bded1f`).
Worktree: `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-B-Worker/t99aeb3-20261005-0606`.
Own dev home: `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-B-Worker-t99aeb3-20261005-0606`.
No shared service (port 40375), no live config mutation, no release build/promotion.
Historical T89 home (`run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t890064-20261005-0334`) was closed and confirmed clean in `/proc` (`found=0`).

Scope: source regressions for overnight #8 (derived report loses unknowns/state and window semantics) and #13 (private ping tail falsely named a certain prefix change), retaining parent T87 `topTools` and page controls.

## Source regressions (real ledgers/fingerprints/host seams)

`packages/plus/test/monitor-analysis.test.ts` — 18 tests, all passing at HEAD:

- **#8 unknown/known missCost.** An unknown-priced miss omits `missCost` on the
  request *and* in `totals` (the T3 baseline zero is not merged under T2's
  omission); a recorded pricing fact yields a positive request and matching
  total.
- **#8 legacy v1 + recorded requests.** A v1 step row (with its own
  agent/model/tokens) and a v2 request for a different message both appear in
  the agents table and per-session totals, with no double count of the logical
  step. Reasoning is included in the agent's token total.
- **#8 real session state.** `running` from the host's live `session.active`
  set (future capability, optional), `completed`/`error`/`interrupted` from
  `Session.Info.outcome`; an open request marks running even against a stale
  completed outcome; a session with no recorded execution omits `state`.
- **#8 auxiliary agent.** A title and a generate outcome for the same session
  never rewrite the shown primary agent (ledger row stays `build`); the host's
  `session.get` agent wins for the sessions table.
- **#8 windowed pings.** A ping's followedByHit/Miss only counts a next request
  inside the window; a ping before the selection is not counted.
- **#8 unstable/unread as-of.** Instability surfaces only at the third
  change and honors the selected window; unread counts a write only after its
  lifetime passes by the cutoff, a read before the cutoff clears it, and a
  request at/after the cutoff never changes a historical report; the same input
   with a later cutoff evolves without any write (the cutoff is applied at
   report time, not included in the expensive fold's revision key).
- **#8 unstable prefix historical & future write control.** Retains per-request
  streak and identity (`UnstableStreak`: `requestID`, `agent`, `provider`,
  `model`, `at`, `streak`, `segment`), selecting the latest matching entry
  inside the selected window. A 5th future change at 5000 preserves historical
  streak 3 for `until: 4500` (exact before/after future-write equality:
  `expect(afterFuture.unstable).toEqual(beforeFuture.unstable)`), while a later
  window sees streak 4. Agent and model filters select matching identity without
  timestamps-only find ambiguity.
- **#8 totals.** Input/output/reasoning/cache read/cache write are all summed.
- **#13 reusable marked prefix.** The real Anthropic wire shape (long unchanged
  system + history with an assistant cache marker, then the ping's private final
  user prompt; the next primary replaces the uncached tail) yields **no**
  `segments`, no `firstDivergence`, `expected 9193`, `verdict miss`,
  `cause unknown`, `confidence unknown`, gap 10s < lifetime 300s, and the exact
  final-wire body hashes preserved.
- **#13 genuinely changed marked part** is still `prefix-changed` (certain);
  **#13 a changed reusable cache marker** (a `cache_control` ttl on a marked
  message or system part) is a `prefix-changed` with the `cache markers`
  segment named even when the tail is also replaced, while identical markers
  with a replaced tail stay `unknown`; **#13 failed / different-model /
  different-variant / unfinished pings** cannot refresh the reusable prefix
  (each yields `cache-expired` at gap 399s), and the same ledger flips to
  `unknown` at gap 10s once that ping completes successfully.
- **#8 agent/model filters.** A filtered query reports only the selected
  identity's pings, follow stats, unread writes and instability; another
  identity's signals never leak in.
- **#8 advancing-now poll.** The analysis fold is window-independent and cached
  on the ledger revision: cold fold once (~71 ms) + 3 advancing-now polls
  (~13–22 ms) on an unchanged 40×40 ledger reuse the fold while unread evolves
  (`[0, 200_000, 400_000, 780_000]`) across expiry boundaries.
- **#8 host active precedence.** A host-active chat with a prior succeeded or
  failed outcome stays `running`; the open-request fallback marks a session the
  host does not report active.
- **#8 title exclusion.** Title auxiliaries are excluded from unread and follow
  signals by default; `titles: true` includes them honestly.

All 8 assigned checks pass at HEAD:
`bun test test/monitor-analysis.test.ts` (18 pass),
`bun test test/monitor-cache.test.ts` (14 pass),
`bun test test/monitor-ledger.test.ts` (10 pass),
`bun test test/monitor-requests.test.ts` (18 pass),
`bun test test/monitor-plugin.test.ts` (3 pass),
`bun test test/monitor.test.ts` (15 pass),
`bun test test/rpc-contract.test.ts` (22 pass),
`bun run typecheck` (0 errors).

## Owned live acceptance

Command: `pilotty spawn --name overnight-analysis-backup opencodeplus-dev .`
Target: private dev server in isolated home `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-B-Worker-t99aeb3-20261005-0606`.
Model: `cliproxyapi/claude-opus-5-5` (working observed route replacing quota-exhausted DeepSeek-cheap per plan decision).
Evaluated at 80×24 and 160×40 columns.

- **Real state.** `/monitor` → Sessions tab showed the chat as `completed`
  after an idle turn, `running` (State column and spinner `⠇`) while a long
  prompt streamed, and `interrupted` after Escape. At 80×24:
  `Hello world one-word reply completed 1 12.9k 06:24:17`.
  At 160×40:
  `Hello world one-word reply build completed 1 12.9k 4.8k 38% $0.00 06:24:17`.
- **Agent not title.** The Sessions tab showed `build` as the shown agent while
  the session's ledger also held title (`12dc135f-311f-42f3-9957-0d4862e7af27`)
  and generate rows; the chat's primary agent was never overwritten.
- **Totals/unknown omission.** Overview totals line read:
  `reqs: 1 · steps: 1 · in: 8k · read: 4.8k · write: 0 · out: 6 · reason: 0 · hit rate: 38% · misses: 0 · miss cost: $0.00 · pings: 0 · cost: $0.00`.
  This live sample has no miss, so its $0.00 miss total does not establish the
  unknown-priced-miss omission boundary; that boundary is proved by the real
  ledger regression above.
- **Cache tab.** At 80×24 and 160×40:
  `06:24:17 step [HIT] prefix-changed 4.8k option prompt_cache_key removed...`.
  Enter opened Request Detail: `ef5c0146-8781-4c66-92d7-2dfcb0c13633`,
  `Expected prefix: 0 · Cache read: 4.8k · Miss tokens: 0`,
  `Gap since last request: 32ms · Cache lifetime: 5m · Warming: —`,
  `First diverging segment: option prompt_cache_key`.
- **Next-ping-tail (#13).** The Anthropic marked-prefix tail shape is verified
  by the real-wire fingerprint regression. Conservative analyzer TTL is 5m for
  Claude/CPA; no invented DeepSeek expiry.

## Log and cleanup

- **#20 lithosai authentication rejection classification.**
  In T89's historical ledger, probe title request `66220cc9-b773-451b-bfcd-1b0b558d5298`
  and step request `18d24c59-9e35-4420-9c59-8b61c8e2a643` for
  `lithosai/deepseek-ai/DeepSeek-V4.1-Flash` recorded status error with hash
  `56fcfe5e754d0f0e`, chars 15 (`AI.Error.Authentication: invalid API key`, HTTP 401).
  This proves remote provider authentication rejection, not a missing local credential.
- **Current run log.**
  `data/opencode/log/opencode-local.log`: 228 total lines:
  - 222 INFO lines
  - 6 WARN lines (all 6 are expected `executor-controlled plugin source refused` at the workspace document boundary)
  - 0 ERROR lines
  Zero Monitor or Plus errors.
- **Process lifecycle & kernel absence.**
  Owned launcher/server PIDs before stop:
  - PID 3366504 (launcher: `bun ... packages/cli/src/index.ts --standalone .../project`, cwd: test dev home `project`)
  - PID 3366648 (server: `bun ... packages/cli/src/index.ts serve --stdio --port 0`, fds to dev home log and sqlite)
  - PID 3366714 (search worker: `bun ... packages/plus/src/search/bin.ts`, cwd: test dev home `project`)
  Exited cleanly via TUI signal (exit code 0).
  Final `/proc` scan for cwd, fds, and maps matching the dev home path: 0 matches.
  All 3 PIDs confirmed absent from kernel.
  Immutable release worker MCP process (PID 3322495) untouched.
  PTY session `overnight-analysis-backup` confirmed closed and absent from `pilotty list-sessions`.

## Limitations

- The live route exercised here was `cliproxyapi/claude-opus-5-5`; Anthropic marked-prefix ping tail is verified by the real-wire fingerprint unit regression.
- Conservative analyzer TTL is not a provider-known lifetime; DeepSeek route lifetimes remain unknown.
- Parent integration found a large-ledger no-write polling regression (#22):
  the existing 200×200×200 benchmark's repeat Everything queries take about
  8.2 seconds instead of the earlier 80–87 ms. The smaller advancing-now
  benchmark proves evolving signals, not acceptable large-ledger performance.
  Repair and B4/final combined-head acceptance remain required.
