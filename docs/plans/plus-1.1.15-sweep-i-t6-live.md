# Instructions T6 live sweep — Flash-C-Worker t130dc70

Final live sweep of Instructions T6 ("rename agents, team members and teams") in
this worktree's own build. Evidence only; no source file changed.

Contract lines come from `docs/plans/plus-1.1.12-instructions.md` T6 end state
(copied into the task brief). Each line is recorded below with what was done,
what was seen, and PASS / FAIL / NOT LIVE.

## Build under test

- Worktree (this one):
  `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t130dc70-20261005-1726`
- HEAD at test start: `97b1f52e2a28c57e5b61f8e77cbaa84116d07e14` (branch
  `team/Flash-C-Worker/t130dc70-20261005-1726`).
- Launched exactly: `pilotty spawn --name sweep-i-t6 opencodeplus-dev .` from the
  worktree root, then `pilotty resize -s sweep-i-t6 160 48`. Own dev home, never
  shared port 40375, never `bun run dev:live`, never `bun run dev`.
- Owned dev home:
  `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t130dc70-20261005-1726`
  (shorthand `<dev-home>` below).
- Server log: `<dev-home>/data/opencode/log/opencode-local.log`.
- Model where a chat is used: `cliproxyapi/deepseek-v4.1-flash-cheap`.

## Objective (as executed)

Verify every end-state line of Instructions T6 live in this worktree's own
build, recording what was done and what was seen for each line.

## Results

The rename key in this build is **`shift+r`** (not bare `R`), recorded from
both the help dialog and the live footer hint:

- Help (`?`) Change group:
  `shift+r   rename a user category, user agent, team member or team`.
- Footer on a Global user agent row `t6-renamed`:
  `↑↓ move   → open   space toggle   ctrl+space select   a add   l link   shift+r rename   d delete   [ ] category   tab list   / filter   ? help   esc close`.

So the contract's "If `R` collides, choose another free key and update help and
hints" branch is the one this build takes: `R` alone belongs to reset
(`r reset this level's override`), and rename is `shift+r`, shown in the help
and in the row footer. PASS for the key/help/hints sub-line.

### Line 1 — `shift+r` prompts (prefilled, validated like creation) and renames; renamable rows are Project/Global user agents, on-disk team members, Project/Global teams

**Agent rename (Global).** Created a Global user agent `t6-live` (preset Build)
and gave it records of several kinds first: a model
(`cliproxyapi/claude-opus-5-5@medium`, active), a switched-off tool
(`tool:edit`, state off), and a text edit (`system:role`, sentinel
`T6-RENAME-SENTINEL`), plus the creation link to preset `build`. With the
sidebar selection on the `t6-live` agent row (footer showed
`shift+r rename`), sent `shift+r`. A prompt opened:

```
Rename t6-live
New id; use / for nesting. .. is not allowed.
t6-live
enter submit
```

The value was **prefilled** with the current id (`t6-live`). Validation like
creation was exercised twice:

- `..` submitted → the prompt closed with no rename and no new file/record
  (invalid id, rejected as at creation).
- `release` (an existing Global agent) submitted → no rename, the row stayed
  `t6-live`, no collision was applied.
- Then `t6-renamed` submitted → rename landed.

What was seen after the successful rename: the tree selected the new row
(`Global › Agents › User › t6-renamed`, row `● t6-renamed 77`), the agent file
`t6-renamed.md` existed and `t6-live.md` was gone (see Line 2 for the record
follow-through). The store log recorded one line:

```
{"ts":"2026-10-05T15:33:47.980Z","actor":{"type":"tui"},"op":"agent.rename","target":".../config/opencode/agents/t6-renamed.md","summary":"agent.rename t6-live to t6-renamed (global)","revision":494}
```

**PASS** (agent row). Team member and team row sub-cases recorded under the
same line below.

### Line 2 — everything that names the renamed thing follows: its file, every stored record, the tree selection

Records were read before and after the agent rename directly from
`<dev-home>/config/opencode/opencodeplus/instructions/records.jsonl`:

Before (`grep '"t6-live"'` → 4 records):

```
{"type":"customization","level":"global","agent":"t6-live","item":"system:role",... "text":"... T6-RENAME-SENTINEL.", ...}
{"type":"customization","level":"global","agent":"t6-live","item":"tool:edit","section":null,"state":"off","basedOn":"4194c060...","basedOnState":"on","updated":"..."}
{"type":"link","level":"global","agent":"t6-live","preset":{"kind":"agent","id":"build"},"updated":"..."}
{"type":"model","level":"global","agent":"t6-live","providerID":"cliproxyapi","modelID":"claude-opus-5-5","variant":"medium","active":true,"updated":"..."}
```

After (`grep -c '"t6-live"'` → `0`; the same 4 records, same item/state/model
fields, now owned by `t6-renamed`):

```
{"type":"customization","level":"global","agent":"t6-renamed","item":"system:role",... "text":"... T6-RENAME-SENTINEL.", ...}
{"type":"customization","level":"global","agent":"t6-renamed","item":"tool:edit","section":null,"state":"off","basedOn":"4194c060...","basedOnState":"on","updated":"..."}
{"type":"link","level":"global","agent":"t6-renamed","preset":{"kind":"agent","id":"build"},"updated":"..."}
{"type":"model","level":"global","agent":"t6-renamed","providerID":"cliproxyapi","modelID":"claude-opus-5-5","variant":"medium","active":true,"updated":"..."}
```

- **File follows:** `t6-renamed.md` exists with the same bytes (frontmatter
  `description`/`mode`); `ls t6-live.md` → `No such file or directory`.
- **Stored records follow:** the customization (text edit), the customization
  (tool:edit off), the link and the model all moved to `t6-renamed` in one
  revision (`{"version":2,"revision":494}` on the store header; the rename log
  line names revision 494).
- **Tree selection follows:** after the successful rename the Instructions tree
  immediately selected `Global › Agents › User › t6-renamed`
  (`▌      ● t6-renamed        77`) and the detail pane read
  `Global › Agents › User › t6-renamed`.

**PASS** (agent case: file, records, selection). Member/team cases and the
`team_delegate` "Delegate to" / team-enablement rows are covered under the
team lines below.

### Line 3 — session history keeps the old name

Recorded after a live chat check below (assistant/session message still names
the old agent id). See "Line 3" section.

**Member rename (Global team, on-disk member).** Created Global team `t6crew`
(preset Basic) and added member `mate6` (preset Explore). With the member row
selected (`Global › Teams › t6crew › mate6`, footer `shift+r rename`), sent
`shift+r`:

```
Rename mate6
New id; use / for nesting. .. is not allowed.
mate6
enter submit
```

Prefilled `mate6`. Validated live: `special` was refused (`Member id "special"
is reserved` — the reserved Special name) and `mate6` unchanged. Then
`mate6-renamed` succeeded; the tree selected
`Global › Teams › t6crew › mate6-renamed`. On disk:

```
$ ls <dev-home>/config/opencode/opencodeplus/teams/t6crew/
build-seat.md  implementer.md  mate6-renamed.md  orchestrator.md  planner.md  reviewer.md  scout.md
```

`mate6.md` gone, `mate6-renamed.md` present; the team link record followed:

```
{"type":"link","level":"global","agent":"mate6-renamed","team":{"level":"global","team":"t6crew"},"preset":{"kind":"agent","id":"explore"},"updated":"2026-10-05T15:37:54.197Z"}
```

Log: `{"op":"agent.rename","target":".../teams/t6crew/mate6-renamed.md","summary":"agent.rename mate6 to mate6-renamed (global team t6crew)","revision":497}`.
**PASS** (member row).

**Team rename (Global team).** With the `t6crew` team row selected
(`Global › Teams › t6crew`, footer `shift+r rename`), sent `shift+r`:

```
Rename t6crew
New team name; members and records follow.
t6crew
enter submit
```

Prefilled `t6crew`. Submitted `t6squad`:

```
Global › Teams › t6squad
▌  ▾ ● t6squad
       ● build-seat        89
       ● implementer       15
       ● mat...amedsu...t  90
       ● orchestrator      23
       ● planner           23
       ● reviewer          10
       ● scout              9
```

- **Team directory follows:** `<dev-home>/config/opencode/opencodeplus/teams/t6crew`
  no longer exists; `.../teams/t6squad/` holds all seven member files
  (`build-seat.md implementer.md mate6-renamed.md orchestrator.md planner.md reviewer.md scout.md`).
- **Team-scoped records follow:** every link that named the team now names
  `t6squad` (`grep -c '"t6crew"' records.jsonl` → `0`); the team's own
  enablement row became
  `{"type":"team","level":"global","team":"t6squad","enabled":true,...}`.
- **Tree selection follows:** the tree selected `Global › Teams › t6squad`.

Log: `{"op":"team.rename","target":"team:global:t6squad","summary":"team.rename t6crew to t6squad (global)","revision":500}`.
**PASS** (team row: prefilled, validated, directory/records/selection follow).

### Line 4 — `team_delegate` "Delegate to" rows naming a member follow — **FAIL**

Setup: in the team `t6squad`, the member `build-seat` carries a stored
"Delegate to" override for the member `mate6-renamed`. I toggled that row off on
screen (`Global › Teams › t6squad › build-seat › Tools › OpenCodePlus ›
delegate › Permissions › Delegate to › mate6-renamed`, `state off`,
`source: state: set here (Global)`), producing the stored record:

```
records.jsonl:120
{"type":"customization","level":"global","agent":"build-seat","item":"perm:team_delegate:to.mate6-renamed","section":null,"state":"off","basedOn":"d8cb06ab32...","basedOnState":"on","updated":"2026-10-05T15:46:30.057Z"}
```

Then I renamed the member `mate6-renamed` → `mate6-final` with `shift+r`
(prefilled `mate6-renamed`; the tree selected
`Global › Teams › t6squad › mate6-final`). The member file moved
(`mate6-renamed.md` → `mate6-final.md`) and its link moved, and the log recorded
`agent.rename mate6-renamed to mate6-final (global team t6squad), revision 502`.

What did **not** follow: the stored "Delegate to" row still names the old id.

```
$ grep -n '"agent":"build-seat"' records.jsonl | grep team_delegate
120:{"type":"customization","level":"global","agent":"build-seat","item":"perm:team_delegate:to.mate6-renamed",...}
$ grep -c 'to.mate6-final' records.jsonl
0
```

The screen confirms the override was orphaned: the row
`Delegate to › mate6-final` now reads `state on`, `source: from preset Basic ›
build-seat` — the stored `off` no longer applies, because the stored row names
the old id. Expected: the row would have become
`perm:team_delegate:to.mate6-final` with `state off` (`set here`).

Likely cause (source, not fixed): `renameTeamMember` (index.ts ~3794–3808)
rewrites a delegate row only when `sameTeam(record.team, { level, team })`,
i.e. the record must carry a `team` ref. The live TUI wrote the "Delegate to"
override **without** a `team` field (the detail pane addresses it
`Global · build-seat · catalogue: teams · perm:team_delegate:to.…`, no team),
so the filter skips it. The unit test
`packages/plus/test/rename.test.ts` seeds the row **with** `team: teamRef`, so
the API path passes while the TUI-written shape fails live.

**FAIL.** Recorded exactly; no source changed.

### Line 3 — session history keeps the old name

Live chat check. Started a new chat session on the worktree server, switched it
to the user agent `t6-palette` (created by the palette rename below) and sent
`say READY`; the assistant reply rendered as `T6-Palette · claude-opus-5-5`.
Session storage (read-only from `<dev-home>/data/opencode/opencode-local.db`)
then held:

```
session_v2: {"id":"ses_ef3328fd6ffeR3jnwgXNQrlvRE","agent":"t6-palette","title":"READY confirmation request"}
session_message: assistant row with "agent":"t6-palette" (seq 27)
```

Then the agent was renamed (`t6-palette` → `t6-history`, log
`agent.rename t6-palette to t6-history (global), revision 504`) and the same
rows re-read:

```
sessions after rename: {"id":"ses_ef3328fd6ffeR3jnwgXNQrlvRE","agent":"t6-palette","title":"READY confirmation request"}
assistant agents after rename: seq 27 "t6-palette", seq 15 "t6-palette", seq 9 agent-switched "t6-palette"
```

Every stored session row kept the old name `t6-palette`; the rename touched no
session storage. **PASS.**

### Line 6 — the palette command `plus.agent.rename` uses the same path

In the chat, `Ctrl+P` → typed `rename agent` → the palette listed
`Rename agent   OpenCodePlus`. Running it opened the same
`Rename agent / Select an agent to rename` picker (the `build` built-in and
defaults rows disabled, user agents listed with their scope/path), then
`Rename <id>` prompt prefilled with the id and the same validation. Renaming
`t6-renamed` → `t6-palette` wrote
`.../config/opencode/agents/t6-palette.md` and logged
`{"op":"agent.rename","target":".../agents/t6-palette.md","summary":"agent.rename t6-renamed to t6-palette (global)","revision":503}`.
**PASS** (palette uses the same RPC path).

### Line 5 — refusals: built-in agent, shipped Defaults team/member, ancestor-backed, `protectedAgents`

**Built-in agent — PASS.** Selected the Global OpenCode `build` row (footer
shows no rename hint on a built-in) and pressed `shift+r`. A toast appeared:

```
Agent build is built in and cannot be renamed
```

No prompt, no file/record change. **PASS.**

**Shipped Defaults team and member — recorded below.**

**Ancestor-backed agent and `protectedAgents` (tool actor) — recorded below.**

## Server log — every ERROR and WARN line

(pending)

## Result

(pending)
