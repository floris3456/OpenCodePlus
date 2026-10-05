# plus-1.1.15 Monitor page live acceptance (T87)

Repair of overnight issue #7 at the actual Monitor production boundaries. The
scope is `packages/plus/src/tui/monitor/*`, `packages/plus/src/tui/active-team.tsx`,
`packages/plus/src/monitor/query.ts`, `packages/plus/src/rpc.ts`,
`packages/plus/src/tui/index.tsx`, the storybook story in `packages/tui`, and
the focused tests. No config, keys or prompt contents appear here.

## End-state coverage

| #7 item | Fix | Regression test |
| --- | --- | --- |
| `/` text filter ignored | `filterReport` narrows every rendered table (groups, feed, requests, sessions, agents, top misses/tools, compare) while totals stay the real query | `monitor-view.test.tsx` "the / text filter narrows every table but leaves the totals" |
| Compact Enter follows stored Overview | compact body has its own `monitor-composer` store and always renders/drills Tools | "the composer defaults to the tree scope and drills Tools even when its stored tab is Overview" |
| Separate compact/full settings | full page keeps `monitor`; compact keeps `monitor-composer` | "full and compact keep separate persisted settings" |
| Team M bypasses remembered return | `createActiveTeam` takes `openMonitor`; `index.tsx` passes `monitor.open(sessionID)` so back returns to the source tab | `active-team.test.tsx` "Team M routes through the remembered Monitor open and closes the composer"; live below |
| Poll newest requests, not oldest row | `refreshInterval` reads `requests.at(-1)` (oldest-first list) | "the view polls every second while calls are live and every five when quiet" |
| Narrow Cache hides ping kind | Kind column always rendered (Time + Kind kept; Agent/Model, In, Cost drop first) | "the narrow Cache keeps the ping kind and the agents table fits 80 columns" |
| Agents width fits 80 | model column needs width ≥ 95; padded fixed-width cells | same test |
| Selected full rows scroll into view | per-tab scroll refs; the view scrolls the selection on tools/cache/sessions/steps | "the Cache selection scrolls its full row into view" |
| Overview top tools independent of last grouping | `queryMonitor` returns `topTools` always tool-grouped; Overview reads it | "the Overview top tools ignore the tab's last grouping" |
| Honest scope/view/id-aware fixtures | story proxies only `client.rpc`, answers `monitor.query` from the requested scope/view/id; details use hashes/sizes/names/timings only | live story below |
| Sessions tokens sum all fields | Sessions tab token cell sums input+output+reasoning+cache read+write | "the Sessions tab shows a token total that includes cache and reasoning" |
| Restricted `Reflect.get` at story 466/473 | replaced with object spread + typed `rpc` override; no `Reflect` | root `oxlint` clean |
| Stale active-team expectations | hints gain `monitor M`; commands 7; M routing regression added | `active-team.test.tsx` |

## Live evidence

Build: `pilotty spawn --name overnight-monitor-page opencodeplus-dev .` from the
worker worktree. Terminal 80×24 and 160×40. Model `cliproxyapi` route used by
the dev home's default agent.

- `/monitor` opens full screen. Scope line reads `Scope: Project`, `s` cycles
  Project → Team → Project → Everything, `t` cycles All → Since last
  compaction → 15m → 1h → 24h.
- Every tab renders at 80: `[1 Overview] [2 Cache] [3 Tools] [4 Sessions] [5 Steps]`.
  Cache header at 80 shows `Time Kind Verdict Cause Read Evidence` (Kind kept).
  Sessions header at 80 shows `Session / Role State Steps Tokens Active`.
- After two real turns, Tools showed `read` and `glob` with a latest-calls feed;
  `Enter` on `read` drilled to `read /home/bliss...README.md` and `read README.md`
  with `drilled 1 (⌫ back)`; `backspace` returned.
- Cache showed real rows: `[NONE] prefix-changed`, `[MISS] unknown`, then two
  `[HIT]` rows; `Enter` opened `Request Detail` with `Cause: none (certain)`,
  `Expected prefix: 13k`, `Gap since last request: 2.6s · Cache lifetime: 5m ·
  Warming: on`.
- At 160 the Cache row shows `Kind Verdict Cause Agent/Model In Read Cost Evidence`.
- Compact composer: `Down` opens the composer; `Right` to `Tools` shows
  `scope tree · window all · order tokens`, `reqs: 1 …` and `No tool calls here
  yet.`; hints `group g scope s window t filter a/f full M`. `M` opened the page
  at `Scope: This session (ses_ef60cb)`.
- Team tab (compact) hints read `move attach active tree stop|resume monitor M`;
  `M` opened the page at `Scope: This session (ses_ef6174)` and `Escape`
  returned to the same chat.
- 80-column Overview after the layout fix: `Top Misses` and `Top Tools` sit side
  by side, the agents table drops `Model`, and no row overdraws another.
- Story `OPENCODE_STORY=monitor opencodeplus-dev .`: renders the real page with
  contract fixtures; Overview shows the unstable-prefix warning, token mix, top
  misses and top tools; Cache shows `compaction [COLD] compacted`, `step [HIT]`,
  `ping [HIT]`, `step [MISS] prefix-changed`; `Enter` on the miss opens
  `Request Detail: req_miss · step … Cause: prefix-changed (certain)` with
  `system part AGENTS.md changed: chars 3200 → 3800`; `ctrl+m` switches the miss
  cause and the footer reads `miss: cache-expired`.

## Server log

`$DEV/data/opencode/log/opencode-local.log` for this worktree. After every run
the only WARN lines are `executor-controlled plugin source refused` for the
workspace `.opencode` plugin sources (the executor-confinement rule refusing
the checked-in workspace config), and the only ERROR-level line is the
`InterruptError` the CLI records on a normal TUI shutdown (`All fibers
interrupted without error`). No Monitor or Plus error or warning appears.

## Cleanup

`pilotty kill -s overnight-monitor-page` and `pilotty kill -s overnight-monitor-story`
both report `Session … killed`; `pilotty list-sessions` no longer lists either
name, and no `opencodeplus-dev` process has this worktree as its cwd.

## Unresolved / new findings

- The pre-existing `packages/plus` failures in `test/ops.test.ts`,
  `test/tools.test.ts`, `test/route.test.tsx` and `test/teams/worktree.test.ts`
  (model-row field editing/reset/refusal) are the Instructions A2 model-area
  work (#6), reproduced identically at the parent HEAD; not touched here.
- `packages/tui` whole-suite failures are baseline environment failures
  (plugin reload, terminal, markdown); no Monitor/story test exists there and
  none is newly broken by this change.
