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
