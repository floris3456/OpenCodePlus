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
