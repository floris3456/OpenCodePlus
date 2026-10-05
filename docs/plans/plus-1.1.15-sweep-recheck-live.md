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

Did: enabled the team (`rc-team` Space on its row: detail `Enabled ○` → `Enabled
●`, record `{"type":"team","level":"global","team":"rc-team","enabled":true,...}`),
then navigated `rc-team › build-seat › Tools › OpenCodePlus › delegate ›
Permissions › Delegate to › scout` and pressed `Space`.

The row reads `○ scout` and the detail pane:

```
scout                                   permission
Global › Teams › rc-team › build-seat › Tools ›
OpenCodePlus › delegate › Permissions › Delegate
to › scout
state       off
source      state: set here (Global) · text: from
            preset Basic › build-seat
rule        team_delegate · to.scout
message     build-seat may not delegate to scout
address     Global · build-seat · catalogue: teams
            · perm:team_delegate:to.scout
```

Record written
(`<dev-home>/config/opencode/opencodeplus/instructions/records.jsonl:120`):

```
{"type":"customization","level":"global","agent":"build-seat","item":"perm:team_delegate:to.scout","section":null,"state":"off","basedOn":"3608e4bd0e693177369e17f48cdf750eb962b86aaac1bf6b50c7a46d52f7d94b","basedOnState":"on","updated":"2026-10-05T16:41:42.929Z"}
```

**It has NO `team` field.** This is the shape the pre-fix sweep found failing:
the TUI writes the "Delegate to" override without a `team` ref. PASS (setup
step recorded; the fix's behaviour is judged in A3/A4).

### A3. Rename member `scout` → `scout-rn` with `shift+r`

Did: selected the member row `rc-team › scout` and pressed `R` (`shift+r`).
A prompt opened, prefilled with the current id:

```
Rename scout
New id; use / for nesting. .. is not allowed.
scout
enter submit
```

The textarea had focus and the value prefilled (`scout`). I cleared it
(`Ctrl+A` did not select; Backspace cleared, then typed `-rn` after `End`, since
`pilotty type "-rn"` needs `--`) and submitted `scout-rn`.

Saw the tree select `Global › Teams › rc-team › scout-rn`:

```
Global › Teams › rc-team › scout-rn
   ▾ ● rc-team
       ● build-seat        89
       ● implementer       15
       ● orchestrator      23
       ● planner           23
       ● reviewer          10
▌      ● scout-rn           9
```

On disk `scout.md` is gone and `scout-rn.md` is present. Log:
`{"op":"agent.rename","target":".../teams/rc-team/scout-rn.md","summary":"agent.rename
scout to scout-rn (global team rc-team)","revision":498}`.

**PASS** (rename prompts prefilled and lands the file/member).

### A4. PASS criteria

The brief's three criteria, checked exactly:

1. `grep 'team_delegate:to.scout-rn' $DEV/config/opencode/opencodeplus/instructions/records.jsonl`:

```
120:{"type":"customization","level":"global","agent":"build-seat","item":"perm:team_delegate:to.scout-rn","section":null,"state":"off","basedOn":"3608e4bd0e693177369e17f48cdf750eb962b86aaac1bf6b50c7a46d52f7d94b","basedOnState":"on","updated":"2026-10-05T16:41:42.929Z"}
```

build-seat's record with `state off`. **The item id moved from `to.scout` to
`to.scout-rn` in place**, same `basedOn`/`basedOnState`/`updated`. This is the
record the pre-fix sweep found left naming the old member.

2. `grep -c 'team_delegate:to.scout"' $DEV/config/opencode/opencodeplus/instructions/records.jsonl`
   → `0`. No stored `Delegate to` row still names the old member id.

3. The screen row `Delegate to › scout-rn` reads:

```
scout-rn                                permission
Global › Teams › rc-team › build-seat › Tools ›
OpenCodePlus › delegate › Permissions › Delegate
to › scout-rn
state       off
source      state: set here (Global) · text: from
            preset Basic › build-seat
rule        team_delegate · to.scout-rn
message     build-seat may not delegate to scout-
            rn
```

`state off`, `set here (Global)` — the stored override still applies to the
renamed member.

**PASS — all three criteria.**

Note on the fix: the same TUI-written record shape as the pre-fix sweep (no
`team` field; see A2) now follows the rename, so fix #30 closes the live defect
recorded in `plus-1.1.15-sweep-i-t6-live.md` Line 2. No source file changed.

## Part B — Monitor T2 (fix #28)

Contract line: every request gets a cache verdict, and one `monitor.query` call
returns the calling session's misses. Fix #28: a request still running with no
usage is no longer judged a miss.

### B1. Model and two prompts

Did: `Esc` back to the chat. The chat had inherited the team's `Build-Seat`
agent (`claude-fable-5-1`, no route in this dev home). `/model` → filtered
`claude-opus-5-5` → `Enter` → `Select variant` → `high` → `Enter`. Footer then
read `Build-Seat · claude-opus-5-5 CLIProxyAPI · high`.

Sent `Reply with exactly OK` twice; each reply rendered `OK` with
`Build-Seat · claude-opus-5-5 · 1.6s` / `1.5s`.

**PASS** (model `cliproxyapi/claude-opus-5-5` variant `high` chosen, two prompts
sent).

### B2. `monitor.query({ view: "cache" })`

Did: sent the brief's prompt in the same chat:

```
Call monitor.query({ view: "cache" }) in Code Mode and print, for every request, its id, verdict, cause and evidence, then the misses count.
```

The agent ran `✓ execute` → `› monitor.query [view=cache]` and replied (`Each of
the three requests, with its id, verdict, cause and evidence:`):

```
1. 57ec1557-d6df-4fea-8890-c51b7416c94f
   - Verdict: none
   - Cause: prefix-changed (confidence: certain)
   - Evidence: option prompt_cache_key removed; instruction update: core/environment, core/date, core/codemode, ...
2. 93a2098b-c6c7-4e83-8bcd-2b0bf588f877
   - Verdict: partial
   - Cause: unknown (confidence: unknown)
   - Evidence: Reusable prefix unchanged, within cache lifetime; provider-side eviction or routing
   - It expected 18,227 cached tokens but read 9,265, so 8,962 tokens missed.
3. eedc1942-f963-4b80-8d1c-4df5698f9e52
   - Verdict: none
   - Cause: unknown (confidence: unknown)
   - Evidence: Request still running; no usage reported yet
   - This is the request that ran the query.

Misses: 1 (8,962 tokens), from request 93a2098b. The cache hit rate was 25.4%.
```

**PASS** (one `monitor.query({ view: "cache" })` call returned the calling
session's requests with id, verdict, cause and evidence, plus the misses count).

### B3. Still-running request shows verdict `none`

The third request, `eedc1942-f963-4b80-8d1c-4df5698f9e52` — the very step that
called the tool, still running — reads exactly:

```
3. eedc1942-f963-4b80-8d1c-4df5698f9e52
   - Verdict: none
   - Cause: unknown (confidence: unknown)
   - Evidence: Request still running; no usage reported yet
   - This is the request that ran the query.
```

and the misses count names only `93a2098b`:

```
Misses: 1 (8,962 tokens), from request 93a2098b.
```

So the still-running request is verdict `none` with the exact evidence text and
is **not** counted among the misses. This is fix #28: pre-fix, that same row was
reported as a miss (see `plus-1.1.15-sweep-m-t2-live.md` E1). **PASS.**

### B4. `/monitor` Cache tab shows the real verdict after completion

_Pending._

## Server log — every ERROR and WARN line

_Pending._

## Result

_Pending._
