# B1 warming live acceptance — fresh owned build (T88)

Live acceptance of the merged B1 warming path in a fresh, owned build of the
overnight worktree HEAD, replacing the stopped T84 run. No source edits.

## Build under test

- Worktree: `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t88b9c4-20261005-0326`
- Branch: `team/Flash-C-Worker/t88b9c4-20261005-0326`
- HEAD at test start: `89a86fac9a9005b70b2ffdfd125e41534b00481a`
- Started (UTC): 2026-10-05T01:28:49Z; TUI spawn 2026-10-05T01:29Z.
- Model: `cliproxyapi/deepseek-v4.1-flash-cheap` (Build agent, Default variant).

## Owned test home (kernel-derived, not a registration file)

- Dev home: `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t88b9c4-20261005-0326`
- Actual server log (kernel fd): `<home>/data/opencode/log/opencode-local.log`
  (no `opencode.log` is created for the local channel).
- Config written only in this home: `<home>/config/opencode/opencodeplus/instructions/records.jsonl`.
- `monitor.db` lives beside the teams data under this home (created on first
  monitored event).

## Focused checks at HEAD (before live)

Run from package directories.

- `packages/core bun test test/plugin/warming.test.ts test/plugin/warming-ping-usage.test.ts test/session-warming-prefix.test.ts test/session-generate.test.ts`
  → **33 pass, 0 fail**.
- `packages/plus bun test test/monitor-requests.test.ts` → **18 pass, 0 fail**.
- `packages/core bun run typecheck` → exit 0.
- `packages/plus bun run typecheck` → exit 0.

## Setup phase — Defaults › Models (observed screen)

Actions in the owned TUI (`overnight-b1-live-retry`):

1. `ctrl+p` → "Switch model" → searched `deepseek-v4.1-flash-cheap` → Enter →
   variant `Default` → composer reads
   `Build · deepseek-v4.1-flash-cheap CLIProxyAPI`.
2. `ctrl+p` → "Instructions" → `#` (Defaults) → End → Down → Right → down to
   `cliproxyapi/deepseek-v4.1-flash-cheap` row → Right (opens fields:
   `Warming`, `Ping every`, `Keep-alive prompt`, `Effort`).
3. Enter on `Warming`, cleared, typed `4m`, Enter → row reads
   `warm 4m · every 4m ◆`.
4. Enter on `Ping every`, cleared, typed `1m`, Enter → row reads
   `warm 4m · every 1m ◆`; detail panel:
   `ping every 1m · Defaults › Models (this model)`.

Recorded bytes in the owned home:

- `records.jsonl` line:
  `{"type":"modelSettings","level":"defaults","providerID":"cliproxyapi","modelID":"deepseek-v4.1-flash-cheap","warming":"4m","interval":"1m","updated":"2026-10-05T01:32:41.248Z"}`
- store revision line: `{"version":2,"revision":467}`.

(Checkpointed before the wait for real pings, per the Brief.)

## Phase 1 — two messages, three real pings (observed screen + ledger)

Two minimal messages, each `Reply with exactly OK` / `Reply with exactly OK again`,
sent at 01:33:17Z and 01:33:58Z; both replied `OK` (composer line
`Build · deepseek-v4.1-flash-cheap · 1.5s`). Session id:
`ses_ef64e60c9ffePUt41BQF1FWVWR`.

The footer counted down a single window and never restarted on a ping:

```
01:34:51Z  cache warm · 3:08 left
01:35:48Z  cache warm · 2:11 left
01:36:28Z  cache warm · 1:31 left
01:36:56Z  cache warm · 0:56 left
```

(Five minutes later, at 01:41:11Z, the first submit of the phase-2 message showed
`cache cold · enter again to send` — the cold-send guard holding a send.)

Server log `opencode-local.log`, exactly three `warming session` lines:

```
timestamp=2026-10-05T01:34:59.326Z level=INFO run=4712b3e9 message="warming session" sessionID=ses_ef64e60c9ffePUt41BQF1FWVWR last=1791164039321
timestamp=2026-10-05T01:36:00.639Z level=INFO run=4712b3e9 message="warming session" sessionID=ses_ef64e60c9ffePUt41BQF1FWVWR last=1791164100635
timestamp=2026-10-05T01:37:02.038Z level=INFO run=4712b3e9 message="warming session" sessionID=ses_ef64e60c9ffePUt41BQF1FWVWR last=1791164162033
```

Isolated ledger `monitor.db` (read-only), one row per ping, all `completed`,
all pinned `agent=build provider=cliproxyapi model=deepseek-v4.1-flash-cheap
variant=default`, each with usage:

| id | kind | status | started UTC | input | cacheRead | output | reasoning | cost |
|----|------|--------|-------------|-------|-----------|--------|-----------|------|
| `bc38734d-a556-437d-b2e2-035be4099be1` | ping | completed | 01:34:59.340 | 49 | 8448 | 2 | 0 | 0 |
| `4cc089f8-9452-4c91-a6e3-18f14900cea8` | ping | completed | 01:36:00.653 | 49 | 8448 | 2 | 7 | 0 |
| `b78bb7f7-fe97-4c0f-961b-25979d52b60f` | ping | completed | 01:37:02.052 | 49 | 8448 | 2 | 0 | 0 |

Each ping has exactly one `request_fingerprint` row (`openai-responses`,
body-hash `17321134d710d262` on all three, consistent `prompt_cache_key`). The
stored fingerprint columns are encoded JSON: `length(system_parts)` 1592,
`length(tools)` 1375, `length(message_prefixes)` 540 characters. These are
serialized-column lengths, **not** prompt segment character sizes (segment
sizes are the per-part `chars`/`estimatedTokens` fields inside that JSON and
were not separately summed here). No orphan rows: `select count(*) from
request where ended is null` = **0**; `step where ended is null` = **0**; two
`step` rows only, one per real message.

`monitor.query` (view `cache`, scope `session`) returns the pings as kind
`ping`, verdict `hit`, with usage and a real detail; first ping detail:

```
verdict hit / confidence certain / expected 8469
"Cache read 8448; expected reusable prefix 8469 tokens"
"Gap 60009ms; lifetime unknownms; warming on"
actualCacheRead 8448
```

Phase-1 totals readback, captured 2026-10-05T01:38Z (after the three pings of
phase 1 and before phases 2–3): `requests 5, pings 3, hitRate 0.7966,
misses 0, unread 0`.

## Phase 2 — next message reads the cache

Next message `Reply with exactly OK one more` sent 01:41:17Z (after the window
had gone cold; a first submit showed `cache cold · enter again to send`, then
confirmed). Ledger row:

```
step completed started 01:41:18.917 input 33 cache_read 8448 cache_write 0 output 2
```

**cacheRead 8448 > 0** — the next real message reused the cached prompt prefix
(observed reuse after the pings). This does not by itself prove the pings
causally refreshed a DeepSeek disk-cache lifetime; the provider's cache
lifetime is recorded as `unknown` for this route, so the reuse is the required
`cacheRead > 0` observation, not a causal warming-lifetime claim. The message
was one step, not two.

## Phase 3 — composer-only selection does not redirect pings

Composer model switched to `claude-fable-5-1` **without sending a message**
(composer read `Build · claude-fable-5-1 CLIProxyAPI · xhigh`). The next window
still pinged the pinned selection:

```
ping at 01:42:18.928  provider=cliproxyapi model=deepseek-v4.1-flash-cheap variant=default  cacheRead=8448
```

The following pings (01:43:20, 01:44:22) remained
`deepseek-v4.1-flash-cheap`, and the footer again ran one uninterrupted
countdown from `cache warm · 3:26 left` to `cache cold`. Durable host history
(`opencode-local.db`, `session_message`) holds exactly three `user` and three
`assistant` messages; `session_inbox` and `session_pending` are empty, so the
private keep-alive prompt is never persisted as a message.

Session totals after all phases (readback captured 2026-10-05T01:46Z): `requests
9, pings 6, hitRate 0.884, misses 1, unread 0`.

## Failed auxiliary — not exercised live

The Brief's optional control for a *failed* auxiliary generation (the refusal
path that must record one errored fingerprinted row) could not be injected
safely in the live relay without breaking the run, so it was **not exercised
live**. It remains covered by unit tests only: `test/monitor-requests.test.ts`
("generate usage hook records request and warming warmed relabels it to ping,
hashing errors without text") and the core `session-generate` suite (33 pass /
18 pass above). No live claim is made for the failure path.

## Log classification (actual owned file)

`<home>/data/opencode/log/opencode-local.log` (`opencode.log` is not created for
the local channel). Mid-run read at 01:44Z: 68068 bytes, **212 INFO, 6 WARN, 0
ERROR**. Final read at 02:01Z after cleanup: 78580 bytes, **259 INFO, 6 WARN, 0
ERROR** (the six WARN are the same lines).

- All six WARN lines are `executor-controlled plugin source refused` for the
  test worktree's / workspace root's own `.opencode` plugin sources
  (`.../t88b9c4-.../.opencode/opencode.jsonc`, `.opencode`, and the repo-root
  equivalents). These are the normal refusal control that keeps
  executor-controlled sources from loading in a dev home; they are unrelated to
  warming.
- No other WARN, no ERROR, and no message containing `fail`, `error`, `deny`,
  `abort` or `cancel`. In particular zero `plus monitor hook failed`,
  `generated hook failed` or `cache warming decision failed` lines.

## Checks after live

- `packages/core bun test` four focused files → 33 pass, 0 fail.
- `packages/plus bun test test/monitor-requests.test.ts` → 18 pass, 0 fail.
- `packages/core` and `packages/plus` `bun run typecheck` → exit 0.

## Cleanup (observed)

- The owned TUI was exited through the palette (`ctrl+p` → `exit` → Enter) at
  01:48Z. Final PTY state read at 01:48:41Z: `outcome: exited`,
  `exit: {exit_code: 0, signal: null, success: true, killed_by_client: false,
  output_complete: true}`. `pilotty kill` then reported
  `[SESSION_EXITED] Session 'overnight-b1-live-retry' exited (exit code 0)`.
- At final check (02:01:20Z) the session has aged out of the daemon:
  `pilotty snapshot`/`status` return
  `[SESSION_NOT_FOUND] Session 'overnight-b1-live-retry' not found`.
- Owned test PIDs found by kernel cwd during the run — `2775307` (TUI),
  `2775428` (serve --stdio), `2775570` (search helper), `2775612` (search
  helper) — are all gone.
- `/proc` scan across every PID: **0** processes with cwd under this dev home,
  **0** with an open fd path under it. Final log: 78580 bytes, **259 INFO, 6
  WARN, 0 ERROR** (the same six executor-controlled-source refusals).
- PID `2769658` (`.../opencodeplus search-mcp`, ppid `2592457`, exe under
  `releases/opencodeplus/releases/2.0.18-plus-1.1.14`) remains: it is the
  immutable shared release worker's MCP helper indexing this worktree, not this
  test's runtime, so it was left untouched.
- The old T84 home under
  `.../Flash-C-Worker-t84524a-20261005-0236` is not touched.
