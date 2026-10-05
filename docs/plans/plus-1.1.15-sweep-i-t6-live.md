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

### Line 1 (continued) — on-disk team member and team rows also prompt, prefilled and validated

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

### Line 2 (continued) — the team directory and team-scoped records follow; the `team_delegate` row does not — **FAIL on that row only**

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

**FAIL** (that stored row). Recorded exactly; no source changed.

### Line 2 (continued) — member file, team directory, team enablement and selection all followed

The team rename above moved the whole directory and every team-scoped link and
enablement row. The member rename moved the member file and its link. Only the
`team_delegate` "Delegate to" stored row failed to follow.

### Line 3 — session history keeps the old name — PASS

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

### Line 4 — not offered / refused: built-in agent, shipped Defaults team/member, ancestor-backed, `protectedAgents`

**Built-in agent — PASS.** Selected the Global OpenCode `build` row (footer
shows no rename hint on a built-in) and pressed `shift+r`. A toast appeared:

```
Agent build is built in and cannot be renamed
```

No prompt, no file/record change. **PASS.**

**Shipped Defaults team and member — NOT LIVE (no shipped Defaults team row exists).** The Defaults tree in this build lists only the `Every member` inventory under Teams (`Defaults › Every member`, no team rows); the one shipped team `basic` appears only as a **Plus preset** (`Presets › Teams › Plus › Basic`). Pressing `shift+r` on `Presets › Teams › Plus › Basic › planner` opened **`Rename category`** (the category rename), not a row rename, and its footer showed no `shift+r rename` — preset rows are not renamable. There is no shipped Defaults team/member row to exercise live. The refusal is covered by the focused test `packages/plus/test/rename.test.ts` → *"instructions.set rename covers agent, member and team rows and refuses Defaults rows"*, which asserts `team:defaults:ship` and `team:defaults:ship:mate` fail with a message containing `shipped`. Ran `bun test test/rename.test.ts`: **6 pass, 0 fail** (see log below). NOT LIVE (covered by test).

**Ancestor-backed agent — NOT LIVE (not constructed live); covered by test.**
Test `rename.test.ts` → *"rename refuses built-in and ancestor-backed agents"* creates an agent file in the parent directory and asserts `renameAgent` fails with `agent.invalid` and a message containing `ancestor`. Included in the 6 passing tests.

**`protectedAgents` for a tool actor — NOT LIVE (no tool actor in the TUI); covered by test.**
Test `rename.test.ts` → *"a tool actor may not rename a protected agent"* writes `protectedAgents: ["alice"]` in `.opencodeplus/project.json` and asserts `instructions_set` with `rename` fails with `agent.protected` and the file is untouched. Included in the 6 passing tests.

Focused test run, from `packages/plus`:

```
$ bun test test/rename.test.ts
(pass) rename an agent moves its file and records of every kind and keeps resolution
(pass) rename a member moves its records and the Delegate-to rows that name it
(pass) rename a team moves its directory, members, records and enablement
(pass) rename refuses built-in and ancestor-backed agents
(pass) instructions.set rename covers agent, member and team rows and refuses Defaults rows
(pass) a tool actor may not rename a protected agent
 6 pass
 0 fail
 49 expect() calls
Ran 6 tests across 1 file.
```

**Line 4 summary:** live built-in agent refusal **PASS**; shipped Defaults team/member, ancestor-backed agent and `protectedAgents` tool-actor refusal **NOT LIVE** in the TUI (no shipped Defaults team row exists; the others need a constructed tree or a tool actor) and each is covered by a passing focused test above.

### Line 5 — the palette command `plus.agent.rename` uses the same path — PASS

In the chat, `Ctrl+P` → typed `rename agent` → the palette listed
`Rename agent   OpenCodePlus`. Running it opened the same
`Rename agent / Select an agent to rename` picker (the `build` built-in and
defaults rows disabled, user agents listed with their scope/path), then the
`Rename <id>` prompt prefilled with the id and the same validation. Renaming
`t6-renamed` → `t6-palette` wrote
`.../config/opencode/agents/t6-palette.md` and logged
`{"op":"agent.rename","target":".../agents/t6-palette.md","summary":"agent.rename t6-renamed to t6-palette (global)","revision":503}`.
**PASS** (palette uses the same RPC path).

### Line 6 — Tools: `instructions.set({ id, rename: "<new>" })` on agent, member and team rows; documented in `teaching.ts`

Documentation: `packages/plus/src/instructions/teaching.ts` line 79 documents
`set({ id, rename: "<new name>" })` renaming a Project/Global user agent, an
on-disk team member or a Project/Global team, listing the moved file/records and
the refusals; line 138 lists the `rename.invalid` error. Quoted:

```
set({ id, rename: "<new name>" }) renames a Project/Global user agent, an on-disk team member or a Project/Global team (TUI `R`). The agent file or team directory moves and every stored record that names the thing ... moves to the new name in one revision; an open tree selection follows it. Session history keeps the old name. Built-ins ..., shipped Defaults teams and members, ancestor-backed agents, and (for a tool actor) protected agents' rows refuse with `rename.invalid`/`agent.protected`.
```

Behaviour: focus of the passing test
*"instructions.set rename covers agent, member and team rows and refuses Defaults rows"*
(part of the 6 passing `bun test test/rename.test.ts` above): `instructions_set`
with `{ id: "agent:project:alice", rename: "bob" }`, `{ id:
"team:project:crew:m1", rename: "m2" }` and `{ id: "team:project:crew",
rename: "squad" }` all succeed and return the new row id; Defaults rows refuse
with `shipped`. **PASS** (documented and covered by the passing test). The tool
was not driven from a live model chat in this sweep; that limitation is noted.

## Remaining contract line — key/help/hints sub-line

Recorded at the top of Results: rename is on `shift+r` (help Change group and
the row footer both say so); `r` alone is reset. PASS.

## Server log — every ERROR and WARN line

`<dev-home>/data/opencode/log/opencode-local.log` at cleanup: **278 lines, 1
ERROR, 8 WARN.** Full lines:

**The one ERROR** (my own chat attempt while the session was briefly on the
`Scout` team member, whose `claude-fable-5-1` has no provider route in this dev
home — a test-setup error, not a rename failure). Full line:

```
timestamp=2026-10-05T16:02:32.905Z level=ERROR run=a6e9eeef message="Failed to drain Session" cause="AI.Error: unknown provider for model claude-fable-5-1\n    at httpFailure (.../packages/ai/src/route/executor.ts:131:10)\n    at <anonymous> (.../packages/ai/src/route/executor.ts:108:19)\n    at SessionStep.attempt (.../packages/core/src/session/runner/llm.ts:245:38)\n    at SessionStep.attempt (definition) (.../packages/core/src/session/runner/step.ts:72:26)\n    at SessionRunner.runStep (.../packages/core/src/session/runner/llm.ts:191:29)\n    at SessionRunner.runStep (definition) (.../packages/core/src/session/runner/llm.ts:206:28)\n    at SessionRunner.drain (.../node_modules/.bun/effect@4.0.0-rc.112/node_modules/effect/dist/internal/effect.js:462:98)\n    at SessionRunner.drain (definition) (.../packages/core/src/session/runner/llm.ts:54:26)\n    at ServerProcess.start (.../packages/cli/src/server-process.ts:85:29)\n    at ServerProcess.start (definition) (.../packages/server/src/process.ts:46:29) {\n  [cause]: AI.Error.InvalidRequest: unknown provider for model claude-fable-5-1\n      at classifyProviderFailure (.../packages/ai/src/provider-error.ts:238:69)\n      at httpFailure (.../packages/ai/src/route/executor.ts:132:13)\n      at <anonymous> (.../packages/ai/src/route/executor.ts:108:19)\n}" role=server sessionID=ses_ef3328fd6ffeR3jnwgXNQrlvRE
```

The retry after switching to the user agent `t6-palette` (model
`cliproxyapi/claude-opus-5-5`) succeeded and returned `READY`.

**Six WARNs** are the expected `executor-controlled plugin source refused`
refusal control (workspace root and this worktree's `.opencode`):

```
timestamp=2026-10-05T15:28:02.082Z level=WARN run=a6e9eeef message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode/opencode.json type=document http.span=98 role=server
timestamp=2026-10-05T15:28:02.082Z level=WARN run=a6e9eeef message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode type=directory http.span=98 role=server
timestamp=2026-10-05T15:28:03.771Z level=WARN run=a6e9eeef message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode/opencode.json type=document http.span=70 role=server
timestamp=2026-10-05T15:28:03.771Z level=WARN run=a6e9eeef message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode type=directory http.span=70 role=server
timestamp=2026-10-05T15:28:03.771Z level=WARN run=a6e9eeef message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t130dc70-20261005-1726/.opencode/opencode.jsonc type=document http.span=70 role=server
timestamp=2026-10-05T15:28:03.771Z level=WARN run=a6e9eeef message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t130dc70-20261005-1726/.opencode type=directory http.span=70 role=server
```

**Two further WARNs** are a direct consequence of the rename contract (session
history keeps the old name): after `t6-palette` was renamed to `t6-history`, the
still-open chat session stayed pinned to the old id, so its warming pings could
not find the agent under its new name:

```
timestamp=2026-10-05T16:09:41.463Z level=WARN run=a6e9eeef message="failed to warm session" sessionID=ses_ef3328fd6ffeR3jnwgXNQrlvRE cause="Cause([Fail(Session.AgentNotFoundError: Agent not found: \"t6-palette\")])" role=server
timestamp=2026-10-05T16:13:41.473Z level=WARN run=a6e9eeef message="failed to warm session" sessionID=ses_ef3328fd6ffeR3jnwgXNQrlvRE cause="Cause([Fail(Session.AgentNotFoundError: Agent not found: \"t6-palette\")])" role=server
```

These two WARNs are expected given the contract: session history intentionally
keeps the old name, so a warming ping addressed to a session still pinned to the
old id finds no such agent.

## Result

End-state lines verified against this worktree's own build (the six contract
lines from the attached brief):

- **Line 1** (`shift+r` on a renamable row prompts prefilled, validated like creation, and renames: Project/Global user agents, on-disk team members, Project/Global teams; another free key with help and hints if `R` collides): **PASS** — key is `shift+r`, in help and the row footer; agent, member and team all renamed live with prefilled prompts and validation/collision refusals.
- **Line 2** (its file or team directory; every stored record — customizations, splits, models, rules, links, warming rows, team-scoped records, `team_delegate` "Delegate to" rows naming a member, team enablement; the tree selection — all follow): **PASS for everything except the `team_delegate` "Delegate to" stored row, which is a FAIL.** Agent file/records/selection, member file/link, team directory/links/enablement all followed.
- **Line 3** (session history keeps the old name): **PASS** — the stored `session_v2`/`session_message` rows kept `t6-palette` after the rename.
- **Line 4** (not offered and refused with a clear message: built-in OpenCode/Special agents, shipped Defaults teams and members, ancestor-backed agents, and rows of a `protectedAgents` agent for a tool actor): built-in agent **PASS** live; shipped Defaults team/member, ancestor-backed agent and `protectedAgents` tool actor **NOT LIVE** live (no shipped Defaults team row exists; the others need a constructed tree/tool actor) but covered by 6 passing focused tests.
- **Line 5** (palette `plus.agent.rename` uses the same path): **PASS**.
- **Line 6** (Tools `instructions.set({ id, rename })` on agent, member and team rows; documented in `teaching.ts`): **PASS** (documented; covered by the passing tool test) — not driven from a live model chat.

**One live defect found (the `team_delegate` "Delegate to" row does not follow a
member rename); no source file changed.** Only this evidence file was written.
