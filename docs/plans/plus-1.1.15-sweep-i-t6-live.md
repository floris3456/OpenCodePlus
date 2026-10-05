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

## Server log — every ERROR and WARN line

(pending)

## Result

(pending)
