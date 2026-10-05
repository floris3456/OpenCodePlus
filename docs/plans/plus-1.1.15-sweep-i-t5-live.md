# Instructions T5 live sweep — Flash-C-Worker t136f068

Final live sweep of Instructions T5 ("Global and Project team members never leak
into Defaults, including a team named like a shipped preset team") in this
worktree's own build. Evidence only; no source file changed.

## Build under test

- Worktree (this one):
  `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t136f068-20261005-1811`
- HEAD at test start: `31623301b057b3c65489fea2616d4889ecb5ae05`
  (branch `team/Flash-C-Worker/t136f068-20261005-1811`).
- Launched exactly: `pilotty spawn --name sweep-i-t5 opencodeplus-dev .` from
  the worktree root, then `pilotty resize -s sweep-i-t5 160 48`. Own dev home,
  never shared port 40375, never `bun run dev:live`, never `bun run dev`.
- Owned dev home (`$DEV`):
  `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t136f068-20261005-1811`
- Real global config directory of this dev build (upstream identity):
  `$DEV/config/opencode`; Global instruction store in
  `$DEV/config/opencode/opencodeplus/instructions/records.jsonl`; Global teams in
  `$DEV/config/opencode/opencodeplus/teams/`; project store in
  `$DEV/project/.opencodeplus/`.
  `~/.config/opencodeplus` is the installed product's directory and was never
  read or written.
- Server log: `$DEV/data/opencode/log/opencode-local.log`.

## End-state line

Copied from `docs/plans/plus-1.1.12-instructions.md` T5:

**End state:** creating a team at Global or Project and adding members from
presets one by one writes only that team's files and team-scoped records. Those
members appear only under that level's team, and under levels that resolve
through it as today. They never appear under Defaults (Agents or Teams), and no
Defaults entry, overlay or record is written. This includes a team whose name
equals a shipped preset team's name in another case (`Basic` vs `basic`) or
the same case.

## Decisions taken for this build

- This home already has a Global team named `Basic` (copied from the release).
  New teams: a Global team `BASIC` and a Project team `basic`, members added
  from Presets › Teams › Basic members one by one.
- Before the first change: `grep -c '"level":"defaults"'` on the global store,
  and `ls -R` of the Defaults overlay/entries location.
- After each team's members are added: repeat both, and quote Defaults › Agents
  and Defaults › Teams from the tree.
- Where something cannot be shown live, cite `bun test test/tree.test.ts` or
  `bun test test/agents.test.ts` from `packages/plus`.

## Results

(Each result is added below the moment it is observed; checkpoints follow.)

### Baseline before the first change

Session spawned and resized; TUI came up on `Build · claude-opus-5-5
CLIProxyAPI · high`. Pre-existing store and the Defaults location:

```
$ grep -c '"level":"defaults"' "$DEV/config/opencode/opencodeplus/instructions/records.jsonl"
10
$ head -1 "$DEV/config/opencode/opencodeplus/instructions/records.jsonl"
{"version":2,"revision":492}
$ wc -l "$DEV/config/opencode/opencodeplus/instructions/records.jsonl"
255
```

The Defaults overlay/entries location on disk is the global instruction store
itself — there is **no** on-disk Defaults overlay or entries directory in this
build (the old `teams-defaults/` overlay is not read; `teams.ts:8-13`). An
`ls -R` of the only global Plus location, `$DEV/config/opencode/opencodeplus/`:

```
$ ls -R "$DEV/config/opencode/opencodeplus/"
.../opencodeplus/:
instructions

.../opencodeplus/instructions:
OPENCODEPLUS.md
linked-projects.json
log.jsonl
records.jsonl
```

No `teams/`, no `skills/`, no `teams-defaults/`, no `entries/` directory exists
at baseline. The 10 `"level":"defaults"` lines are all `model` /
`modelSettings` rows (lines 223, 226, 227, 234, 237, 240, 246, 251, 252, 253);
there is **no** `"type":"entry"` record at all (`grep -c '"type":"entry"'` = 0)
and no `"type":"team"` record with `"level":"defaults"` (the two team records
are `global/Basic` and `global/Simple`).

Existing (release-copied) Global teams in the store: `global/Basic`
(`enabled:false`) and `global/Simple` (`enabled:true`). Per the Brief's
decision, the new Global team is named `BASIC` (different case from the shipped
`Basic`).

### Check 1 — Global team `BASIC` created from the Basic preset

**What was done.** Palette `ctrl+p` → `Instructions` → Enter. With level alias
`@` I went to `Global › Teams`, pressed `a`, typed the team name `BASIC`, Enter;
the team-preset dialog showed `Plus / Basic / Empty team`; Enter on `Basic`
created the team. The screen toasted `Created team BASIC` and the tree rendered:

```
Global › Teams › BASIC
  state       off
  preset      Basic (Plus)
  contains    7 rows · 6 on · 0 off
 ▾  ○ BASIC
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

**What was written (team files).** Only the new team directory exists:

```
$ ls -R "$DEV/config/opencode/opencodeplus/teams/"
.../opencodeplus/teams/:
BASIC
.../opencodeplus/teams/BASIC:
build-seat.md  implementer.md  orchestrator.md  planner.md  reviewer.md  scout.md
$ head -4 .../teams/BASIC/build-seat.md
---
description: "Coordinates the team from the chat and may delegate to every member"
mode: primary
---
```

(The other five files carry the matching member descriptions. No member file
was written anywhere else.)

**What was written (records).** The store advanced revision `492 → 493` and
255 → 262 lines, adding **seven** records — the team link plus one link per
member — all team-scoped to `{"level":"global","team":"BASIC"}`, never
`defaults`:

```
222:{"type":"link","level":"global","agent":"build-seat","team":{"level":"global","team":"BASIC"}, ...}
224:{"type":"link","level":"global","agent":"implementer","team":{"level":"global","team":"BASIC"}, ...}
225:{"type":"link","level":"global","agent":null,"team":{"level":"global","team":"BASIC"},"preset":{"kind":"team","id":"basic"}, ...}
226:{"type":"link","level":"global","agent":"orchestrator","team":{"level":"global","team":"BASIC"}, ...}
227:{"type":"link","level":"global","agent":"planner","team":{"level":"global","team":"BASIC"}, ...}
228:{"type":"link","level":"global","agent":"reviewer","team":{"level":"global","team":"BASIC"}, ...}
229:{"type":"link","level":"global","agent":"scout","team":{"level":"global","team":"BASIC"}, ...}
```

**Defaults unchanged.** `grep -c '"level":"defaults"'` is **10 before and 10
after** — the same lines (all `model`/`modelSettings` rows at 223/226/227/234/
237/240/246/251/252/253). No new Defaults record, entry or overlay was written;
`grep -c '"type":"entry"'` is still 0 and there is still no `"type":"team"`
record with `"level":"defaults"`.

**Defaults › Agents.** `#` to Defaults, then `End` to `Defaults › Agents` (the
group row); it reports `contains 4 rows` and lists only the built-in agents
(`Every agent`, `OpenCode › build/general/explore/plan`, `Special`). None of
`build-seat`, `implementer`, `orchestrator`, `planner`, `reviewer`, `scout`
appears.

**Defaults › Teams.** `Left` to the `Teams` group in the sidebar, `Right` into
it; the inspector reads `Defaults › Teams` / `contains 1 rows` and the only row
is `Every member`. Neither `BASIC` nor `Basic` nor any member appears under
Defaults.

**Result: PASS** for the Global team half: members appear only under
`Global › Teams › BASIC`, files land only in `teams/BASIC/`, records are
team-scoped links, and Defaults (Agents, Teams, records) is untouched.

### Check 2 — Project team `basic` created empty, members added one by one

**What was done.** Alias `!` → `Project › Teams` (empty at baseline: no
`.opencodeplus/` at all). Pressed `a`, typed `basic`, Enter; at the team-preset
dialog I chose **Empty team** (the third option) so members are added one by one,
not copied from a preset. The screen toasted `Created team basic` and the tree
showed `Project › Teams › basic` with `preset No preset`, `contains 1 rows` (the
Special group only) and the `Project › Teams › basic/Special` rows.

Then, for each of the six Basic members in Presets order (`planner`,
`orchestrator`, `implementer`, `reviewer`, `scout`, `build-seat`), on the
`basic` row I pressed `a`, typed the member id, Enter, and in the preset dialog
picked **Team preset members → `Basic › <id>`**, Enter. Each time the tree
grew a member row and on the final pass it read:

```
Project › Teams › basic
  ▾ ○ basic
      ● build-seat        89
      ● implementer       15
      ● orchestrator      23
      ● planner           23
      ● reviewer          10
      ● scout              9
    ▾ Special
```

The first member's creation toasted the exact path:
`Created agent planner in team basic at …/project/.opencodeplus/teams/basic/planner.md`.

**What was written (project files).** Only inside the project store:

```
$ find "$DEV/project/.opencodeplus"
.../project/.opencodeplus
.../project/.opencodeplus/instructions
.../project/.opencodeplus/instructions/log.jsonl
.../project/.opencodeplus/instructions/records.jsonl
.../project/.opencodeplus/teams
.../project/.opencodeplus/teams/basic
.../project/.opencodeplus/teams/basic/build-seat.md
.../project/.opencodeplus/teams/basic/implementer.md
.../project/.opencodeplus/teams/basic/orchestrator.md
.../project/.opencodeplus/teams/basic/planner.md
.../project/.opencodeplus/teams/basic/reviewer.md
.../project/.opencodeplus/teams/basic/scout.md
```

**What was written (project records).** The project store's `records.jsonl`
first line `{"version":2,"revision":6}`, then **six** records, every one a
project+team-scoped link, none `defaults`:

```
{"type":"link","level":"project","agent":"build-seat","team":{"level":"project","team":"basic"},"preset":{"kind":"member","team":"basic","id":"build-seat"}, ...}
{"type":"link","level":"project","agent":"implementer","team":{"level":"project","team":"basic"}, ...}
{"type":"link","level":"project","agent":"orchestrator","team":{"level":"project","team":"basic"}, ...}
{"type":"link","level":"project","agent":"planner","team":{"level":"project","team":"basic"}, ...}
{"type":"link","level":"project","agent":"reviewer","team":{"level":"project","team":"basic"}, ...}
{"type":"link","level":"project","agent":"scout","team":{"level":"project","team":"basic"}, ...}
```

**Global store untouched by the Project team.** The global store is byte-stable
across the whole Project half: revision still `493`, line count still `262`,
`grep -c '"level":"defaults"'` still **10**, and
`grep '"project"' …/instructions/records.jsonl` returns nothing (no project
record leaks into the global store).

**Defaults unchanged — explicit check after the Project team.** On the
`Defaults` level (`#`):

- **Defaults › Teams** reports `contains 1 rows`; the only row is
  `Every member`. Neither `basic` nor `BASIC` nor `Basic` nor any member
  appears.
- **Defaults › Agents** already reported `contains 4 rows` in Check 1 and the
  sidebar lists only `Every agent`, the OpenCode agents, `Special`, `Plus`,
  `User` — no `basic` team member.
- `grep -c '"level":"defaults"'` is **10 after**, exactly the 10 baseline lines
  (all `model`/`modelSettings`); `grep -c '"type":"entry"'` is still 0; no
  `"level":"defaults"` team record exists.

**Name-collision case.** The new Project team is `basic`, the exact name (same
case) of the shipped Basic preset team; the new Global team is `BASIC`, which
differs from the release-copied Global team `Basic` only by case. Both were
created and populated without touching the shipped preset, the release-copied
`Global/Basic` team (still `enabled:false`) or Defaults. There is therefore no
path from a same-named or same-name-different-case team to a Defaults row.

**Result: PASS** for the Project team half: members appear only under
`Project › Teams › basic`, files land only in `project/.opencodeplus/teams/basic/`,
records are project+team-scoped links, the global store and Defaults are
untouched, and the same-name / different-case collision writes nothing to
Defaults.

## Focused tests (supplementary)

Run from `packages/plus` in this worktree at this HEAD:

- `bun test test/tree.test.ts` → **58 pass / 0 fail, 726 expect() calls**
  (9.41 s). Includes the team-member tree tests named
  `team member rows expand to full agent subtrees with team-prefixed groups`,
  `a team member's own rows list under the tools they govern, rows for absent
  tools under Other permissions, and team tools never reach the Agents
  catalogue`, `a team member's own rows survive the snapshot boundary into the
  Policy group`, and `nested agent id and team member group ids never collide`.
- `bun test test/agents.test.ts` → **16 pass / 0 fail, 103 expect() calls**
  (95 ms) — the agent file / path confinement tests unaffected by team writes.
- `bun test test/plus-instructions-propagation.test.ts` → **5 pass / 0 fail,
  31 expect() calls**. The direct T5 cover is
  **`T5: a Global Basic team with preset-linked members writes no Defaults
  entry and lists no Defaults agent`**: it writes a Global `Basic` team whose
  members link to the shipped `basic` member presets, then asserts
  `snapshot.entries` is empty, each member has a `team:global:Basic:<member>`
  node, no `agent:defaults:<member>` node exists, and no
  `team:defaults:Basic` / `team:defaults:basic` node exists — the exact
  end-state line, also on the tree the live TUI renders.

(The tests emit `plus permission hook not installed` WARN lines to the test
process's own stdout; they are unrelated to the sweep and are not server-log
lines.)

## Server log — every ERROR and WARN line

`$DEV/data/opencode/log/opencode-local.log` at cleanup: **175 lines — 169
INFO, 6 WARN, 0 ERROR.** There is no `level=ERROR` line; every WARN is the
expected `executor-controlled plugin source refused` refusal control (the only
distinct WARN message), one server run `3b156bf9`, six lines:

```
timestamp=2026-10-05T16:13:28.437Z level=WARN run=3b156bf9 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode/opencode.json type=document http.span=105 role=server
timestamp=2026-10-05T16:13:28.437Z level=WARN run=3b156bf9 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode type=directory http.span=105 role=server
timestamp=2026-10-05T16:13:31.105Z level=WARN run=3b156bf9 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode/opencode.json type=document http.span=1620 role=server
timestamp=2026-10-05T16:13:31.105Z level=WARN run=3b156bf9 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode type=directory http.span=1620 role=server
timestamp=2026-10-05T16:13:31.105Z level=WARN run=3b156bf9 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t136f068-20261005-1811/.opencode/opencode.jsonc type=document http.span=1620 role=server
timestamp=2026-10-05T16:13:31.105Z level=WARN run=3b156bf9 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t136f068-20261005-1811/.opencode type=directory http.span=1620 role=server
```

`grep -E 'level=(ERROR|WARN)' … | grep -v "executor-controlled plugin source
refused"` returns nothing (0 lines).

## Result

The end-state line verified **PASS** against this worktree's own build, with the
name-collision case exercised in both directions:

1. **PASS** — Global team `BASIC` (name differing only in case from the
   release-copied `Basic`) created from the Basic preset wrote only
   `teams/BASIC/*.md` and seven `team:global:BASIC`-scoped link records; its
   members show only under `Global › Teams › BASIC`; Defaults › Agents and
   Defaults › Teams show none of them and the `"level":"defaults"` count stayed
   10.
2. **PASS** — Project team `basic` (exact same name as the shipped Basic preset
   team) created empty and filled one member at a time from
   Presets › Teams › Basic members wrote only `project/.opencodeplus/teams/basic/*.md`
   and six `team:project:basic`-scoped links; its members show only under
   `Project › Teams › basic`; the global store was byte-stable (revision 493,
   262 lines) across the whole Project half; Defaults is unchanged.
3. **PASS (same-tree focused test)** — `T5: a Global Basic team with
   preset-linked members writes no Defaults entry and lists no Defaults agent`
   asserts the exact T5 end-state (no Defaults entry, no `agent:defaults:*`
   node, no `team:defaults:*` node) on the real rendered tree.

No source file was changed; only this evidence file.

## Cleanup

`pilotty list-sessions` before killing (mine is `sweep-i-t5`; the others are not
mine):

```
['sweep-recheck', 'w-f15454a0a1ed9809-b', 'sweep-m-t4', 'sweep-i-t8',
 'w-1e01-story', 'sweep-i-t7a', 'sweep-i-t5', 'w-f15454a0a1ed9809-a', 'ux1',
 'rt-t6']
```

Killed only `sweep-i-t5` (`Session e421d7c5-0547-4310-9fc0-eefabbf1d5fb killed`).
After:

```
['sweep-recheck', 'w-f15454a0a1ed9809-b', 'sweep-m-t4', 'sweep-i-t8',
 'w-1e01-story', 'sweep-i-t7a', 'w-f15454a0a1ed9809-a', 'ux1', 'rt-t6']
```

`sweep-i-t5 present: False`; every remaining session is one I did not start and
was left alone. A kernel scan of `/proc/<pid>/environ` and `/proc/<pid>/cwd` for
processes bound to this run's dev home returned no match: the only cwd hits were
the tool shell itself and an unrelated release `opencodeplus search-mcp`
process, neither of them a server for this run. No owned server or launcher
survived.


