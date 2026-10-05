# plus-1.1.15 sweep re-check live — Flash-C-Worker t1386fc0

Live re-check, in this worktree's own build, of the two contract lines touched by
fixes #30 (a member rename moves its `team_delegate` "Delegate to" rows) and #28
(a still-running request is no longer judged a cache miss). Evidence only; no
source file changed.

Source brief: `r6/recheck.md` (parts A and B, followed in order). Contract lines
come from `docs/plans/plus-1.1.12-instructions.md` T6 and
`docs/plans/plus-1.1.12-monitor.md` T2.

## Build under test

- Worktree (this one):
  `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t1386fc0-20261005-1819`
- HEAD at test start: `bba249ddebbddbf75576650ec3ae5c57aa8c3d7e` (branch
  `team/Flash-C-Worker/t1386fc0-20261005-1819`).
- Launched exactly: `pilotty spawn --name sweep-recheck opencodeplus-dev .` from
  the worktree root, then `pilotty resize -s sweep-recheck 160 48`. Own dev home,
  never shared port 40375, never `bun run dev:live`, never `bun run dev`,
  never `~/.config/opencodeplus`.
- Owned dev home (shorthand `<dev-home>` below):
  `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t1386fc0-20261005-1819`
- Server log: `<dev-home>/data/opencode/log/opencode-local.log`.

## Part A — Instructions T6 (fix #30)

Contract line: renaming a member moves every stored record that names it,
including "`team_delegate` 'Delegate to' rows naming a member".

### A1. Create Global team `rc-team` from the `Basic` team preset

Did: `/instructions` → `@` (Global) → moved the sidebar cursor to the `Teams`
group → `a` → typed `rc-team` → `Enter` (name) → in the `Team preset` picker
filtered/selected `Basic` → `Enter`.

Saw the tree select `Global › Teams › rc-team` with exactly the six Basic
members (order as rendered):

```
Global › Teams › rc-team
▌  ▾ ○ rc-team
       ● build-seat        89
       ● implementer       15
       ● orchestrator      23
       ● planner           23
       ● reviewer          10
       ● scout              9
```

On disk: `<dev-home>/config/opencode/opencodeplus/teams/rc-team/` holds
`build-seat.md implementer.md orchestrator.md planner.md reviewer.md scout.md`.
Log: `{"op":"team.create","target":"team:global:rc-team","summary":"team.create
rc-team (global)","revision":493}` (an earlier Empty-team attempt and the stray
user agent named `rc-team` I created by mistake were deleted; the final
directory has the six members).

**PASS** (Global team created from the Basic team preset).

Note: this is the pre-fix sweep's environment only. The `Down`-then-`Enter`
route selects `Empty team`; typing `Basic` in the filter and pressing `Enter`
selects the Basic row.

### A2. Toggle `team_delegate › Delegate to › scout` off and quote the record

_Pending._

### A3. Rename member `scout` → `scout-rn` with `shift+r`

_Pending._

### A4. PASS criteria

_Pending._

## Part B — Monitor T2 (fix #28)

Contract line: every request gets a cache verdict, and one `monitor.query` call
returns the calling session's misses. Fix #28: a request still running with no
usage is no longer judged a miss.

### B1. Model and two prompts

_Pending._

### B2. `monitor.query({ view: "cache" })`

_Pending._

### B3. Still-running request shows verdict `none`

_Pending._

### B4. `/monitor` Cache tab shows the real verdict after completion

_Pending._

## Server log — every ERROR and WARN line

_Pending._

## Result

_Pending._
