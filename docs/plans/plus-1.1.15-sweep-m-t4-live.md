# plus-1.1.15 Monitor T4 live sweep (final)

Scope: verify every end-state line of the Monitor T4 contract
(`docs/plans/plus-1.1.12-monitor.md` §T4, copied into the task brief m-t4.md) in
**this worktree's own build**, and record the result per line. Source: none
changed — this file only.

Build under test: worktree
`team/Flash-C-Worker/t1373533-20261005-1817` (HEAD `59b0029be1`).
Command: `pilotty spawn --name sweep-m-t4 opencodeplus-dev .` (own build, own
home; never `dev:live`, never port 40375, never `~/.config/opencodeplus`).
Owned dev home (`$DEV`):
`/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t1373533-20261005-1817`.
Server log: `$DEV/data/opencode/log/opencode-local.log`.
Team under test: project team `basic-t4` from the `basic` preset in
`$DEV/project`, enabled; members `build-seat` and `scout` each activated
`cliproxyapi/deepseek-v4.1-flash-cheap` at Project (the notes' model).
Chat: agent `build-seat` (team `basic-t4`), which delegated a report task to
`scout`; runs `main-0af5212ae376b4b0` (build-seat, root) and
`w-75ae68e3ee55f824` (scout, child, task `T1`).

Each line below quotes what was done, the screen text seen, and ends with
**PASS**, **FAIL** or **NOT LIVE** plus the reason.

## End-state lines

### L1. The `Team` tab lists, by default, only the runs of the current chat's team tree (root above the chat's run, every descendant at any depth, indented by depth)

Did: from the build-seat chat, arrow-down opened the composer tabs
(`Subagents  Shell  Terminals  Tools  Team`); `→` ×4 moved to the `Team` tab,
which opens in the tree view by default with no key pressed. Screen at 160×48
(the composer tab body; right column is the unrelated Getting-started pane):

```
┃  Subagents  Shell  Terminals  Tools  Team                                                                    esc
┃
┃  main-0af5212ae376b4b0 — build-seat — idle                                                               idle
┃    w-75ae68e3ee55f824 — scout — idle — T1                                                                idle
┃
┃  move ↑↓  attach ⏎  active ctrl+a  tree ctrl+t  stop|resume ctrl+d  monitor M  tabs ←/→
```

The root `main-0af5212ae376b4b0` (this chat's build-seat run) is depth 0 and the
scout child `w-75ae68e3ee55f824` is indented two spaces under it (depth 1),
matching `{"  ".repeat(treeView() ? (run.depth ?? 0) : 0)}`
(`packages/plus/src/tui/active-team.tsx:599`) and the server-side tree filter
(`team.runs.list` with `tree: true`). The namespace at this point holds exactly
these two runs (`$DEV/data/opencode/opencodeplus/teams/runs/` has only
`main-0af5212ae376b4b0` and `w-75ae68e3ee55f824`), so the default listing is
consistent with the tree filter; that the tree view excludes a run outside the
chat's tree is shown live in L4 (plain chat → no rows) and asserted by the
focused test below.

Focused test (run from `packages/plus`): `bun test test/active-team.test.tsx`
"the tree from an implementer's session shows its orchestrator root and
siblings, ctrl+t toggles to all, and empty state shows when no runs exist"
covers the same contract at the handler and render boundaries: `tree.runs.list`
for `ses_impl_1` returns `main-orch` depth 0, `w-impl-1`/`w-impl-2` depth 1 and
`w-scout` depth 2, and does not include the unrelated `w-other`; the tree frame
contains `main-orch — orchestrator — working — Root Task`,
`  w-impl-1 — implementer-1 — working — T1` and
`    w-scout — scout — working — T1-scout` and not `w-other`. Result recorded
under F1.

**PASS**.

### L2. A toggle switches between this tree and all runs in the namespace; the hint bar names the current view (`tree` / `all`)

Did: with the Team tab open, `ctrl+t` toggled the view. In the tree view the
hint read `tree ctrl+t`; after `ctrl+t` the root's child lost its indent and the
hint read `all ctrl+t`:

```
┃  main-0af5212ae376b4b0 — build-seat — idle                                                               idle
┃  w-75ae68e3ee55f824 — scout — idle — T1                                                                  idle
┃
┃  move ↑↓  attach ⏎  active ctrl+a  all ctrl+t  stop|resume ctrl+d  monitor M  tabs ←/→
```

`ctrl+t` again restored the indented tree and the hint read `tree ctrl+t`. The
toggle is bound `ctrl+t` (`active-team.tsx:505-514`, README `## Team tab`), and
the hint label switches between `tree` and `all` from the same signal
(`active-team.tsx:238`).

**PASS**.

### L3. `ctrl+a` (active/inactive), Enter (attach) and `ctrl+d` (stop/resume) keep working in both views

Did, in the build-seat chat, tree view:

- `ctrl+a` switched active → inactive: the active rows disappeared and the hint
  read `inactive ctrl+a` with body `No inactive runs` (both runs were idle); a
  second `ctrl+a` restored `main-… — build-seat — idle` /
  `  w-75ae… — scout — idle — T1` and `active ctrl+a`.
- Arrow-down selected the scout row and `ctrl+d` stopped the idle run: the
  active tree then showed only `main-0af5212ae376b4b0 — build-seat — idle`, and
  `$DEV/data/opencode/opencodeplus/teams/runs/w-75ae68e3ee55f824/run.json` went
  `state: "stopped"`. `ctrl+a` then listed
  `  w-75ae68e3ee55f824 — scout — stopped — T1` with hint `inactive ctrl+a`.
- `ctrl+d` on that stopped row resumed it by attaching to its session: the
  footer changed to `Scout · deepseek-v4.1-flash-cheap CLIProxyAPI` and the
  path line to `…/scout/t175ae-…:team/scout/t175ae-…`, i.e. the run's session
  was opened (README: resume attaches to the session and consumes the retained
  stop intent).

Repeated in the **all** view (`ctrl+t`): `ctrl+a` toggled active/inactive
(`active ctrl+a` ↔ `inactive ctrl+a`, with `No inactive runs` when none); in
all+inactive the stopped scout showed as
`w-75ae68e3ee55f824 — scout — stopped — T1`, `ctrl+d` resumed it (attached to
the scout session, footer `Scout · …`), and Enter attached too. In all+active,
Enter on the idle root `main-0af5212ae376b4b0` attached to the build-seat chat
(footer back to `Build-Seat · …`). `ctrl+t` and `ctrl+a` independently keep
their state (views: tree/all × active/inactive all reached).

Focused test: `test/active-team.test.tsx` "TeamMonitorTab renders active runs
by default, toggles to inactive with ctrl+a, and navigates with select" and
"TeamMonitorTab ctrl+d actions: idle stops, stopped/dead resumes, working shows
warning toast" cover ctrl+a and ctrl+d in the rendered tab (13 pass, 0 fail
overall, result under F1).

**PASS**.

### L4. A chat that is in no team tree shows `No team runs from this chat · ctrl+t shows all`

Worker T137 stopped here (no write for 27 minutes after two nudges; stopped by
the parent). The parent recorded L4 and L5 itself, in the parent worktree's own
build (`pilotty spawn --name r6-m-t4 opencodeplus-dev .` from
`plus-1.1.15_overnight`, HEAD `6bc7729e7b`, home
`run/plus-dev/worktrees-plus-1.1.15_overnight-opencode`, which has no team runs
at all), 160×48.

Did: a plain chat with agent Build (`Reply with exactly OK`), then arrow-down
and `→` four times to `Team`:

```
┃  Subagents  Shell  Terminals  Tools  Team                                  esc
┃
┃  No team runs from this chat · ctrl+t shows all
┃
┃  move ↑↓  attach ⏎  active ctrl+a  tree ctrl+t  stop|resume ctrl+d  monitor M  tabs ←/→
```

`ctrl+t` then shows the namespace view, empty here, with the hint naming it:

```
┃  No active runs
┃
┃  move ↑↓  attach ⏎  active ctrl+a  all ctrl+t  stop|resume ctrl+d  monitor M  tabs ←/→
```

Focused test: `test/active-team.test.tsx` "…and empty state shows when no runs
exist" (13 pass, 0 fail in the worker's run).

**PASS**.

### L5. The `Team` and `Tools` tabs stay separate in the composer

Did: in the same chat, the tab bar reads `Subagents  Shell  Terminals  Tools
Team`. `Tools` shows the compact monitor with its own header and hint bar:

```
┃  scope tree · window all · order tokens
┃  reqs: 1 · steps: 1 · in: 12.7k · read: 0 · write: 0 ...misses: 0 · miss cost: $0.00 · pings: 0 · cost: $0.00
┃  No tool calls here yet.
┃  group g  scope s  window t  filter a/f  full M  tabs ←/→
```

`→` moves to `Team`, which shows the runs list and its own hint bar (L4). They
are two tabs with separate bodies and keys.

**PASS**.

## Result

All five lines PASS. L1–L3 by worker T137 in its build at `59b0029be1` (team
`basic-t4`: build-seat root and scout child; tree, `ctrl+t`, `ctrl+a`, Enter
attach and `ctrl+d` stop/resume in both views). L4–L5 by the parent at
`6bc7729e7b`. No source changed for this sweep.

## Log and cleanup

### Server log

- T137's home (`…-t1373533-20261005-1817`): 506 lines, 498 INFO, 8 WARN, 0
  ERROR. All WARN are the expected `executor-controlled plugin source refused`.
- The parent's home (`worktrees-plus-1.1.15_overnight-opencode`, shared with
  R4): 538 lines, 520 INFO, 18 WARN, 0 ERROR. All WARN are the same expected
  refusal.

### Cleanup

The parent killed T137's PTY `sweep-m-t4` after the run had stopped, and its
own `r6-m-t4`. A `/proc` cwd scan finds no process in either home.
