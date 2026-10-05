# Basic team live acceptance — Flash-C-Worker t1168a8f

Live test of basic team use in this worktree's own build: create a project team
from the `basic` preset, delegate one small report task, check the Team tree,
the Team scopes and the composer's Team tab, then stop the run and check it
shows as stopped. Evidence only; no source file changed.

## Build under test

- Worktree (this one):
  `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t1168a8f-20261005-1513`
- HEAD at test start: `e33f5c5fa6174ce9e3947db966bb5dc446e8ce47`
  (branch `team/Flash-C-Worker/t1168a8f-20261005-1513`).
- Launched exactly: `pilotty spawn --name basic-team opencodeplus-dev .`
  from the worktree root. Own dev home, never shared port 40375, never
  `bun run dev:live`, never `bun run dev`.
- Owned dev home:
  `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t1168a8f-20261005-1513`
- Server log: `<dev-home>/data/opencode/log/opencode-local.log`.
- The TUI opens the home's scratch project (`<dev-home>/project`, a git repo
  on branch `master`).
- Model for the team members: `cliproxyapi/deepseek-v4.1-flash-cheap` at
  Project (the dev home's default `cliproxyapi/claude-fable-5-1` is rejected by
  the route, per the Brief's decision).

## Step 1 — Project team from the `basic` preset

Action: `ctrl+p` → typed `Instructions` → `Enter` opened the Instructions
screen. Via the level aliases (`$` for Presets, `!` for Project, `@` for
Global, `#` for Defaults) I navigated to `Project › Teams`, pressed `a`, named
the team `basic-live`, and chose the `Basic` team preset (Enter on the preset
list, `Create from a team preset`).

After submission the team row appeared, initially disabled:

```
Project › Teams › basic-live
  state       off
  preset      Basic (Plus)
  contains    7 rows · 6 on · 0 off
  ▾ ○ basic-live
      ● build-seat        89
      ● implementer       15
      ● orchestrator      23
      ● planner           23
      ● reviewer          10
      ● scout              9
    ▾ Special
      ● com...ionh...n  90
      ● title   hidden  90
      ● summary hidden  90
```

Action: `Space` on the `basic-live` row to enable it. The row changed to `●`
and the footer reported:

```
Enabled team "basic-live"; disabled global:Simple
```

```
Project › Teams › basic-live
  state       on
  preset      Basic (Plus)
  contains    7 rows · 6 on · 0 off
  ▾ ● basic-live
```

Then for each member (`build-seat`, `scout`): opened the member → `]` to its
`Models` category → `a` → provider `cliproxyapi` → model
`deepseek-v4.1-flash-cheap` → variant `(no variant)` → Enter. Each addition
toasted:

```
Added model cliproxyapi/deepseek-v4.1-flash-cheap
```

and the member's Models list then showed the row active:

```
Project › Teams › basic-live › build-seat › Models
▌▸ cliproxyapi/deepseek-v4.1-flash-cheap          ◆
  source      active model: set here (Project)
  model       cliproxyapi/deepseek-v4.1-flash-cheap
  from        Project · active
```

```
Project › Teams › basic-live › scout › Models
▌▸ cliproxyapi/deepseek-v4.1-flash-cheap          ◆
    ▸ cliproxyapi/gpt-5.6-luna@high from default scout
  source      active model: set here (Project)
  model       cliproxyapi/deepseek-v4.1-flash-cheap
  from        Project · active
```

On-disk confirmation in the owned home
(`<dev-home>/project/.opencodeplus/`): `teams/basic-live/{planner,orchestrator,implementer,reviewer,scout,build-seat}.md`
exist with `mode: primary`; `instructions/records.jsonl` holds the team link,
the `link` records for all six members, `{"type":"team",...,"team":"basic-live","enabled":true}`
and the two `{"type":"model","level":"project","agent":"build-seat"|"scout","providerID":"cliproxyapi","modelID":"deepseek-v4.1-flash-cheap","active":true}`
records.

Result: step 1 passed.

## Step 2 — delegate a small report task to scout

Action: switched the chat agent to the team's `build-seat` member (composer
badge `Build-Seat · deepseek-v4.1-flash-cheap CLIProxyAPI`, status line
`…/project:master · team basic-live`), then sent:

```
Use team_delegate to give the scout member a report task: list the top-level files of this folder. Then end your turn.
```

build-seat called `team_delegate` and ended its turn:

```
✓ team_delegate [objective=List the top-level files and directories of this repository's folder. Report their exact names and kinds, compactly., reason=A quick read-only lookup of the folder's top-level contents is a scout's job and needs no edits., requestID=scout-top-level-files-1, role=scout]

Delegated to scout (run w-2c37ed52b53f479b). Ended turn to await its settlement.

Build-Seat · deepseek-v4.1-flash-cheap · 20.9s · 75.2 tok/s
```

After the scout settled, the child's `child.settled` item woke build-seat in
the same chat:

```
[team] w-2c37ed52b53f479b (scout, T1) settled: done — attempt 1 succeeded.
Top-level listing of the repo folder (worktree root): exactly one entry.

- `.git` — file (gitdir pointer file, contents: `gitdir: .../project/.git/worktrees/t12c37-20261005-1521`)

No other top-level files or directories exist. The working tree has no checked-out files; directory read and glob
(including hidden) both return only `.git`.
Findings:
- note .git: Only top-level entry; it is a file, not a directory, containing a gitdir pointer to the main
  worktree metadata outside this checkout.
- note .: Worktree working directory is empty apart from .git; no tracked files are checked out here.
next: use the result; there is nothing to land.
```

and build-seat's own second-turn summary:

```
Scout run w-2c37ed52b53f479b settled with the report:

Top-level entries of the worktree root (scout's checkout):

- .git — file (gitdir pointer to the main worktree metadata)
- nothing else

Note: in my own (build-seat) checkout I also saw an untracked .opencodeplus/ directory (teams/, instructions/),
which the scout's isolated worktree did not contain — likely a worktree isolation difference, not a contradiction
to land. No commit or integration was needed; the task was read-only.

Build-Seat · deepseek-v4.1-flash-cheap · 3.3s · 79.7 tok/s
```

Result: step 2 passed; scout run `w-2c37ed52b53f479b` is the root's only child.

## Step 3a — composer Team tab

Action: in the chat, arrow-down opened the composer tabs
(`Subagents  Shell  Terminals  Tools  Team`); `→` moved to the `Team` tab.

It lists the root run and the scout run indented under it, with
id/role/state/task:

```
┃  Subagents  Shell  Terminals  Tools  Team                                                                    esc
┃
┃  main-759512680ad0df59 — build-seat — idle                                                               idle
┃    w-2c37ed52b53f479b — scout — idle — T1                                                                idle
┃
┃  move ↑↓  attach ⏎  active ctrl+a  tree ctrl+t  stop|resume ctrl+d  monitor M  tabs ←/→
```

`ctrl+t` switched to all-runs and the hint bar named the view:

```
┃  main-759512680ad0df59 — build-seat — idle
┃  w-2c37ed52b53f479b — scout — idle — T1
┃  move ↑↓  attach ⏎  active ctrl+a  all ctrl+t  stop|resume ctrl+d  monitor M  tabs ←/→
```

`ctrl+t` again restored the tree and the hint read `tree ctrl+t`.

## Step 3b — /monitor

Action: `ctrl+p` → `monitor` → Enter opened the full-screen Monitor page,
filtered on this session.

Scope `s` stepped to `Team tree`; the header and totals then covered both
sessions:

```
Monitor                                                                                        tokens, cache and tools
 Scope: Team tree [s] step · [S] session · [T] team
 When: Since last compaction [t] step window
 order calls
 reqs: 15 · steps: 15 · in: 21.9k · read: 124k · write: 0 · out: 1.7k · reason: 2.2k · hit rate: 85% · misses: 0
 miss cost: $0.00 · pings: 0 · cost: $0.00
 [1 Overview] [2 Cache] [3 Tools] [4 Sessions] [5 Steps]
 Agents in Scope
  Agent           Model             Steps   Hit Rate  Misses  Tokens    Cost      Active
  build-seat      cliproxyapi/deeps…8       86%       0       108k      $0.00     15:22:04
  scout           cliproxyapi/deeps…7       82%       0       42.2k     $0.00     15:22:02
```

Session tab (`4`) shows the delegation tree:

```
 [1 Overview] [2 Cache] [3 Tools] [4 Sessions] [5 Steps]
  Session / Role                    Agent         State     Steps   Tokens    Read      Hit Rate  Cost      Active
  Delegate folder...listing to scoutbuild-seat    completed 8       108k      91.3k     86%       $0.00     15:22:04
    └─ Repo top-l...ectories listingscout         completed 7       42.2k     32.8k     82%       $0.00     15:22:02
```

`T` opened the team picker (`No team filter`, `basic-live`); choosing
`basic-live` set the header to:

```
 Scope: Team: basic-live [s] step · [S] session · [T] team
  Session / Role                    Agent         State     Steps   Tokens    Read      Hit Rate  Cost      Active
  Delegate folder...listing to scoutbuild-seat    completed 8       108k      91.3k     86%       $0.00     15:22:04
    └─ Repo top-l...ectories listingscout         completed 7       42.2k     32.8k     82%       $0.00     15:22:02
```

Result: step 3 passed; both scopes list both sessions and the Sessions tab
shows the tree.

## Step 4 — stop the idle scout run and see it stopped

Action: with the composer Team tab open, arrow-down selected the scout row and
`ctrl+d` stopped it. The active view then showed only the idle root:

```
┃  Subagents  Shell  Terminals  Tools  Team                                                                    esc
┃  main-759512680ad0df59 — build-seat — idle                                                               idle
┃  move ↑↓  attach ⏎  active ctrl+a  tree ctrl+t  stop|resume ctrl+d  monitor M  tabs ←/→
```

`ctrl+a` switched to the inactive view, which shows the stopped scout:

```
┃  Subagents  Shell  Terminals  Tools  Team                                                                    esc
┃    w-2c37ed52b53f479b — scout — stopped — T1                                                            stopped
┃  move ↑↓  attach ⏎  inactive ctrl+a  tree ctrl+t  stop|resume ctrl+d  monitor M  tabs ←/→
```

On-disk confirmation (`<dev-home>/data/opencode/opencodeplus/teams/runs`):
`w-2c37ed52b53f479b/run.json` has `"state": "stopped"`, `"role": "scout"`,
`"parent": "main-759512680ad0df59"`; the root `main-759512680ad0df59/run.json`
stays `"state": "idle"` with `parent: null`.

Result: step 4 passed.

## Server log — every ERROR and WARN line

The server log at `<dev-home>/data/opencode/log/opencode-local.log` (350
lines at the end of the run) contains **no** `level=ERROR` line. The only WARN
lines are the eight expected `executor-controlled plugin source refused`
warnings (paths under the checkout's own `.opencode` and the worktree root):

```
timestamp=2026-10-05T13:15:17.648Z level=WARN run=7a4d81f0 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode/opencode.json type=document http.span=106 role=server
timestamp=2026-10-05T13:15:17.648Z level=WARN run=7a4d81f0 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode type=directory http.span=106 role=server
timestamp=2026-10-05T13:15:19.401Z level=WARN run=7a4d81f0 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode/opencode.json type=document http.span=100 role=server
timestamp=2026-10-05T13:15:19.401Z level=WARN run=7a4d81f0 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode type=directory http.span=100 role=server
timestamp=2026-10-05T13:15:19.401Z level=WARN run=7a4d81f0 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t1168a8f-20261005-1513/.opencode/opencode.jsonc type=document http.span=100 role=server
timestamp=2026-10-05T13:15:19.401Z level=WARN run=7a4d81f0 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t1168a8f-20261005-1513/.opencode type=directory http.span=100 role=server
timestamp=2026-10-05T13:21:39.566Z level=WARN run=7a4d81f0 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode/opencode.json type=document role=server
timestamp=2026-10-05T13:21:39.566Z level=WARN run=7a4d81f0 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode type=directory role=server
```

`level=` counts across the log: `342 level=INFO`, `8 level=WARN`, `0 level=ERROR`.
The path was proven by kernel fd: the server process (pid 7614) holds fd 9 on
`…/t1168a8f-20261005-1513/data/opencode/log/opencode-local.log`.

`<dev-home>/data/opencode/opencodeplus/teams/audit.log` has 5 entries and no
`error`/`warn` text. Its first entry records one failed `team_delegate`
(`"ok":false,"code":"E_INTERNAL","durationMs":6`) at 13:21:24, 14 seconds
before the successful delegation; it never surfaced in the chat and did not
block the run.

## Result

All four steps passed against this worktree's own build:

- Step 1: `basic-live` created from the `Basic` preset at Project, enabled;
  `build-seat` and `scout` both activated
  `cliproxyapi/deepseek-v4.1-flash-cheap` at Project.
- Step 2: `build-seat` delegated a report task to `scout`
  (`w-2c37ed52b53f479b`) and ended its turn; the child settled `done` with the
  top-level listing and the parent reported it back into the same chat.
- Step 3: composer Team tab showed the root with the scout run indented under
  it and `ctrl+t` switched tree/all with the hint bar naming the view;
  `/monitor` scope `Team tree` and scope `Team: basic-live` each listed both
  sessions, and the Sessions tab showed the tree.
- Step 4: `ctrl+d` on the idle scout run stopped it; `ctrl+a` (inactive view)
  showed `w-2c37ed52b53f479b — scout — stopped — T1`, matching on-disk state.

No source file was changed; only this evidence file.


## Parent review (residual run)

The screens and on-disk states quoted above are consistent and cover the four
steps. One correction: the failed first `team_delegate` did surface in the
chat. The stored tool result is `E_INTERNAL: Cannot read HEAD from
<dev-home>/project: fatal: ambiguous argument 'HEAD': unknown revision…`. The
home's scratch project had no commit yet. build-seat then ran
`git commit --allow-empty -m "chore: initialize worktree"` and the second
call succeeded. Recorded as issue #27 in the overnight log.
