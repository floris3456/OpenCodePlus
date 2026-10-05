# plus-1.1.15 Monitor page live acceptance (T87)

Repair of overnight issue #7 at the actual Monitor production boundaries. Scope:
`packages/plus/src/tui/monitor/*`, `packages/plus/src/tui/active-team.tsx`,
`packages/plus/src/monitor/query.ts`, `packages/plus/src/rpc.ts`,
`packages/plus/src/tui/index.tsx`, the storybook story in `packages/tui`, and the
focused tests. No config, keys or prompt contents appear here. `#8` backend is
T89; this file covers only the concrete UI half (miss-cost honesty and
all-metric totals) plus the query text/facets/top-tools repairs.

## End-state coverage

| #7 item | Fix | Regression test |
| --- | --- | --- |
| `/` text filter ignored | `filterReport` narrows every rendered table (groups, feed, requests, sessions, agents, top misses/tools, compare) while totals stay the real query | `monitor-view.test.tsx` "the / text filter narrows every table but leaves the totals" |
| Compact Enter follows stored Overview | compact body has its own `monitor-composer` store and always renders/drills Tools | "the composer defaults to the tree scope and drills Tools even when its stored tab is Overview" |
| Separate compact/full settings | full page keeps `monitor`; compact keeps `monitor-composer` | "full and compact keep separate persisted settings" |
| Team M bypasses remembered return | `createActiveTeam` takes `openMonitor`; `index.tsx` passes `monitor.open(sessionID)` so back returns to the source tab | `active-team.test.tsx` "Team M routes through the remembered Monitor open and closes the composer" |
| Poll newest requests, not oldest row | `refreshInterval` takes the max of feed[0] and `requests.at(-1)` | "the view polls every second while calls are live and every five when quiet" |
| Narrow Cache hides ping kind | Kind column always rendered | "the narrow Cache keeps the ping kind and the agents table fits 80 columns" |
| Agents width fits 80 | model column needs width ≥ 95; padded fixed-width cells | same test |
| Selected full rows scroll into view | per-tab scroll refs; the view scrolls the selection on tools/cache/sessions/steps | "the Cache selection scrolls its full row into view" |
| Overview top tools independent of last grouping | `queryMonitor` returns `topTools` always tool-grouped; Overview reads it | `monitor-ledger.test.ts` "the overview top tools are tool-grouped…"; `monitor-view.test.tsx` "the Overview top tools ignore the tab's last grouping" |
| Sessions Enter/space temporary drills | drill pushes `{...settings(), scope}` without mutating stored settings | "Sessions Enter and space are temporary drills that restore scope and filters on Esc" |
| Honest scope/view/id-aware fixtures | story overrides only `client.rpc`, answers `monitor.query` from the requested scope/view/id; details use hashes/sizes/names/timings only | live story below |
| Sessions tokens sum all fields | Sessions token cell sums input+output+reasoning+cache read+write | "the Sessions tab shows a token total that includes cache and reasoning" |
| Restricted `Reflect.get` at story 466/473 | replaced with object spread + typed `rpc` override; no `Reflect` | root `oxlint` clean |
| Stale active-team expectations | hints gain `monitor M`; commands 7; M routing regression added | `active-team.test.tsx` |

### #8 UI half (accuracy contract, not optional-field strengthening)

| Item | Fix | Regression |
| --- | --- | --- |
| Overview top miss substituted the whole request cost | `overview.tsx` uses `formatCostLabel(miss.missCost)` only; unknown is `—`, never `miss.cost` or `$0.00` | "the overview top miss shows an unknown miss cost as — and never the request cost" |
| Totals suppressed miss cost when ≤0/absent | `formatCostLabel` keeps known-0 as `$0.00` and unknown as `—`; totals always label `miss cost` | "known zero, known positive and omitted miss cost each render distinctly" |
| Totals dropped input/write/output/reasoning/pings at narrow or when 0 | `totalsLines` wraps every labelled metric; full page renders the wrapped lines | "every total metric stays visible and labelled at 80, 100 and 160 columns" |

## New actual-ledger query regressions (`test/monitor-ledger.test.ts`)

Seven tests read a real temporary `monitor.db` through `queryMonitor` (no mock):
scope (session/tree/project/all, fail-closed), agent/tool/model filters with
unfiltered facets, failed-only, tool-grouped `topTools` independent of the
requested grouping, `id` detail only in scope, `missesOnly` totals invariance,
and ping kind/usage survival.

## Reviewed draft corrections applied

- New `test/monitor-ledger.test.ts` is real scope/filter/top-tools/id coverage,
  not the migration stub; `test/monitor.test.ts` (raw ledger/attribution) also
  runs and is untouched (T85 owns privacy there).
- README `## Monitor` Sessions line no longer says `space`/`t`; `t` is the global
  window key, `space` is the tree key. Help tab matches.
- The legitimate `## Tools` section at README line 159 is the agent Instructions
  tools; it was not renamed or touched.
- Temporary-drill preservation and the max-poll-timestamp fix are landed.
- All-labelled totals and unknown-miss-cost rendering are landed.

## Live evidence

Build: `pilotty spawn --name overnight-monitor-page opencodeplus-dev .` from the
worker worktree. Terminal 80×30, 100×30 and 160×40. Owned home:
`/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t8752d5-20261005-0302`.

- `/monitor` opens full screen. Scope line `Scope: Project`; `s` cycles
  Project → Team → Project → Everything; `t` cycles All → Since last compaction
  → 15m → 1h → 24h.
- Totals at 80 (`reqs: 5 · steps: 5 · in: 34.3k · read: 30.8k · write: 0 · out:
  512 · reason: 0` / `hit rate: 47% · misses: 1 · miss cost: $0.00 · pings: 0 ·
  cost: $0.00`), at 100, and one 160 line — every metric labelled, nothing
  clipped.
- All five tabs render at 80/100/160; Cache keeps `Kind` at 80; Sessions at 80
  shows `Session / Role State Steps Tokens Active`.
- Sessions tab: `Down` to the second session, `Enter` → `Scope: This session
  (ses_ef6174)` with `drilled 1 (⌫ back)`; `space` → `Scope: Team tree` with
  `drilled 2`; `Escape` twice → `Scope: Project`, the saved project scope and
  filters restored.
- Compact composer: `Down` opens it, `Right` to `Tools` shows `scope tree ·
  window all · order tokens`; `M` opens the page at `Scope: This session`.
  Team tab hints `move attach active tree stop|resume monitor M`; `M` opens the
  page and `Escape` returns to the chat.
- Story `OPENCODE_STORY=monitor opencodeplus-dev .`: real page with contract
  fixtures; Overview unstable-prefix warning, token mix, top misses/tools; Cache
  `compaction [COLD] compacted`, `step [HIT]`, `ping [HIT]`, `step [MISS]
  prefix-changed`; `Enter` on the miss opens `Request Detail: req_miss · step …
  Cause: prefix-changed (certain)` with `system part AGENTS.md changed: chars
  3200 → 3800`; `ctrl+m` switches the cause and the footer reads `miss:
  cache-expired`.

### Owned runtime and log

- Launcher PTY `overnight-monitor-page` and `overnight-monitor-story` both report
  `Session … killed`; `pilotty list-sessions` no longer lists either name.
- Kernel check: no `opencode*` process has this worktree as cwd after cleanup.
  The only remaining `opencode` process with this cwd is PID 2707728, the
  immutable worker MCP (`releases/2.0.18-plus-1.1.14/bin/opencodeplus
  search-mcp`), which is not a runtime I started and is left running.
- Log `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t8752d5-20261005-0302/data/opencode/log/opencode-local.log`
  (583 267 bytes, 2 298 lines): **0 ERROR**, 66 WARN — every WARN is
  `executor-controlled plugin source refused` for the workspace `.opencode`
  sources (the confinement rule), and 11 INFO `InterruptError: All fibers
  interrupted without error` lines, one per normal TUI shutdown. No Monitor or
  Plus error or warning.

## Unresolved / new findings

- `packages/plus` whole suite: 8 failures in `test/ops.test.ts` (2),
  `test/tools.test.ts` (4), `test/route.test.tsx` (2) — the Instructions A2/#6
  model-row field editing/reset/refusal area. Command `bun test test/ops.test.ts
  test/tools.test.ts test/route.test.tsx` fails with the same names at the parent
  base `254fcbcccc6231bda5469d66907d399269670470` (reproduced by stashing this
  branch's changes). Four of the `tools.test.ts` names are T82's `#15`; the rest
  are not yet validated by the parent. Not touched here.
- `packages/tui` whole suite is not authorized by the plan (focused TUI tests
  only); no Monitor/story test lives there and none is newly broken.
