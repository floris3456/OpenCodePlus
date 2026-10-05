# Instructions T1 live sweep — Flash-C-Worker t1343cd2

Final live sweep of Instructions T1 ("Global agent files live in the real config
directory; a deleted Global user agent disappears everywhere with its records")
in this worktree's own build. Evidence only; no source file changed.

## Build under test

- Worktree (this one):
  `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t1343cd2-20261005-1758`
- HEAD at test start: `31da2e54bfb8e4eb0f6c196c54773504f2a420ab`
  (branch `team/Flash-C-Worker/t1343cd2-20261005-1758`).
- Launched exactly: `pilotty spawn --name sweep-i-t1 opencodeplus-dev .` from
  the worktree root, then `pilotty resize -s sweep-i-t1 160 48`. Own dev home,
  never shared port 40375, never `bun run dev:live`, never `bun run dev`.
- Owned dev home (`$DEV`):
  `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t1343cd2-20261005-1758`
- Real global config directory of this dev build (upstream identity):
  `$DEV/config/opencode` (`XDG_CONFIG_HOME/opencode`); Global agent files in
  `$DEV/config/opencode/agents/`, global store in
  `$DEV/config/opencode/opencodeplus/instructions/records.jsonl`.
  `~/.config/opencodeplus` is the installed product's directory and was never
  read or written.
- Server log: `$DEV/data/opencode/log/opencode-local.log`.

## End-state lines

Copied from `docs/plans/plus-1.1.12-instructions.md` T1:

- **L1.** Create, rename, delete and file reads for Global agents use the host's
  real global config directory (`~/.config/opencodeplus` for this product,
  honouring `OPENCODE_CONFIG_DIR`).
- **L2.** Deleting Global › User › `deepseek-worker` (or any Global user agent)
  succeeds. The agent then disappears from the tree, the agent switcher and the
  team pickers at once (T2), and its stored records (customizations, splits,
  models, rules, links, warming rows) are removed in the same store revision.
  Re-creating an agent with the same id therefore starts clean.

## Results

(Each line's result is added below the moment it is observed; checkpoints
follow.)

### L1 — create / rename / delete / file reads use the real global config dir

**L1a. Create a Global user agent.** Palette flow exactly as the decision says:
`ctrl+p` → `Create agent` → Enter → id `sweep-agent` → Enter → `Agent scope` →
`Global` → Enter → `Preset` → `Create from a preset` → `Build` → Enter
(final Enter at `1791216119294`). The screen toasted (path wrapped over
three lines):

```
Created agent sweep-agent at /home/bliss/OpenCodePlus/run/plus-dev/
run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t1343cd2-20261005-1758/config/opencode/agents/sweep-agent.md
```

The `Global › Agents › User › sweep-agent` row appeared selected, and on disk:

```
$ ls -la $DEV/config/opencode/agents
-rw-r--r-- ... DeepSeek-Build.md
-rw-r--r-- ... Gemini-Build.md
-rw-r--r-- ... astra-reviewer.md
-rw-r--r-- ... deepseek-worker.md
-rw-r--r-- ... release.md
-rw-r--r-- ... sweep-agent.md          ← created 18:01
$ cat $DEV/config/opencode/agents/sweep-agent.md
---
description: "Human-driven build seat: full access, fixes what the team cannot"
mode: primary
---
```

The file is in `$DEV/config/opencode/agents/` (`XDG_CONFIG_HOME/opencode`), the
dev build's real global config directory, **not** `~/.config/opencodeplus` and
not the release home. `records.jsonl` revision went `492 → 493` with one new
record for the create. **PASS** for create.

**L1b. Rename a Global user agent.** With `sweep-agent` selected, `shift+r`
(op row legend `shift+r rename`) → prompt `Rename sweep-agent` prefilled
`sweep-agent`; I cleared it and typed `sweep-agent-rn`, final Enter at
`1791216176421`. The tree and header showed
`Global › Agents › User › sweep-agent-rn`; on disk:

```
$ ls $DEV/config/opencode/agents   →  … sweep-agent-rn.md   (sweep-agent.md gone)
$ grep -n 'sweep-agent' $DEV/config/opencode/opencodeplus/instructions/records.jsonl
223:{"type":"link","level":"global","agent":"sweep-agent-rn",…}
```

Rename moved the file inside the same real global dir and carried the record.
I then renamed it back to `sweep-agent` (final Enter `1791216195342`) so the
delete step uses the decision's id; `ls` shows `sweep-agent.md` again and the
`link` record reads `"agent":"sweep-agent"`. **PASS** for rename.

**L1c. File reads.** Creating and renaming updated the
`Global › Agents › User › …` row and the right-hand agent inspector within one
screen refresh; `grep -n 'sweep-agent' records.jsonl` returned the agent's
`link` record each time the id changed, so the TUI's reads (tree, inspector,
records) follow the file in the real directory. **PASS** for file reads.

**Delete** is recorded under L2 (it is the same end state).

**L1d. `OPENCODE_CONFIG_DIR` honouring — NOT LIVE, covered by focused test.**
The env var is read when the config directory is resolved at process start, so
it cannot be changed live without restarting the TUI. Covered by
`packages/plus/test/agents.test.ts`, test
**`global scope uses OPENCODE_CONFIG_DIR when set`**: it sets
`OPENCODE_CONFIG_DIR` to a temp dir and asserts `resolveDirectory("global","")`
is `<custom>/agent` and that `create`/`rename`/`remove` use
`<custom>/agent/global-reviewer.md`. Run from `packages/plus` (see Focused
tests). **PASS by test; NOT LIVE.**

### L2 — delete a Global user agent: gone everywhere, records removed, clean re-create

**Setup before delete.** `sweep-agent` had three stored records in
`$DEV/config/opencode/opencodeplus/instructions/records.jsonl` (revision 499):

```
147:{"type":"customization","level":"global","agent":"sweep-agent","item":"setting:enabled","state":"on",…}
224:{"type":"link","level":"global","agent":"sweep-agent","preset":{"kind":"agent","id":"build"},…}
237:{"type":"model","level":"global","agent":"sweep-agent","providerID":"cliproxyapi","modelID":"deepseek-v4.1-flash-cheap","active":true,…}
```

and the file `$DEV/config/opencode/agents/sweep-agent.md` existed. Immediately
before delete, `sweep-agent` was present in the agent picker
(`Select agent or team`: `● sweep-agent  Human-driven build seat…`) and in the
`shift+tab` cycle (`Sweep-Agent · deepseek-v4.1-flash-cheap CLIProxyAPI`).

**Delete.** In `Instructions › Global › Agents › User`, with the `sweep-agent`
row selected, I pressed `d` (`Delete agent sweep-agent?` /
`Delete global agent "sweep-agent"? This cannot be undone.`), moved to
`Confirm` and pressed Enter at **`1791216417080`**. The tree immediately dropped
the row; the header went from `Global › Agents › User › sweep-agent` back to
`Global › Agents`, and the inspector pane showed the `Agents` group
(`contains 3 rows`).

**Everywhere at once.** Immediately after the delete (the tree drop is visible
on the next screen; the disk check ran at `1791216424368`, ~7 s after the
confirm for a `cat`/`grep` pass; `date +%s%3N`):

```
$ ls $DEV/config/opencode/agents
DeepSeek-Build.md  Gemini-Build.md  astra-reviewer.md  deepseek-worker.md  release.md
$ grep -n 'sweep-agent' $DEV/config/opencode/opencodeplus/instructions/records.jsonl
(no output; exit 1)
$ grep -ci 'sweep' $DEV/config/opencode/opencodeplus/instructions/records.jsonl
0
$ head -1 …records.jsonl
{"version":2,"revision":500}
```

`records.jsonl` went `499 → 500` and shrank from 257 to 255 lines: **all three**
`sweep-agent` records (its `customization`, `link` and `model` rows, i.e. its
customizations, links and models; it had no splits, rules or warming rows)
were removed in the same store revision as the file. Other agents' records were
untouched (`grep -c deepseek-worker` still 5).

- **Agent switch (`shift+tab`):** cycling the composer 3× at
  `1791216428000`–`1791216434000` showed only
  `Build · claude-opus-5-5 CLIProxyAPI · high` and
  `Plan · claude-fable-5-1 CLIProxyAPI · xhigh` — no `Sweep-Agent`.
- **Agent picker:** `Switch agent` dialog after the delete listed only

  ```
  Agents
    build Human-driven build seat: full access, fixes wh
  ● plan Read-only agent for exploring the codebase and
  ```

  (no `sweep-agent` row).

**Clean re-create.** Via the palette `Create agent` → id `sweep-agent` →
`Global` → preset `Build` (final Enter `1791216462000`), the agent came back and
the Models pane read `Nothing here yet · a adds one` — no leftover active model
— while `Enabled` was `on` from the fresh preset, not from a stale record. On
disk: `sweep-agent.md` present again, `records.jsonl` revision `501`, and
**exactly one** `sweep-agent` record, the new `link`:

```
223:{"type":"link","level":"global","agent":"sweep-agent","preset":{"kind":"agent","id":"build"},"updated":"2026-10-05T16:07:37.778Z"}
```

No `customization`, `model`, split, rule or warming row survived. The agent
therefore starts clean. **PASS** for delete-everywhere, records removal and
clean re-create.

**Code path (for the record).** `deleteAgent` first removes the file, then calls
`removeAgentRecords(directory, loaded, id, scope)`
(`packages/plus/src/index.ts:901-914`). `removeAgentRecords`
(`index.ts:3721-3736`) drops every `customization`/`split` at
`level`+`agent`, every `model`/`rule` with no team scope, and the agent's own
`link`; `removeRecordsAt` (`index.ts:3637-3668`) writes the filtered set in one
`save`, which is the "same store revision" the contract names. The live revision
bump `499 → 500` and the line count `257 → 255` match exactly the three records
the agent owned.

**The exact agent the contract names, `deepseek-worker`.** It is a real shipped
Global file. The record cascade is level+agent keyed and does not depend on the id's text, so the behavior is the
same for any Global user agent — which the `sweep-agent` live run demonstrates
for a file this sweep itself created. `deepseek-worker` was deliberately left in
place so that no pre-existing release agent was destroyed, and its five records
are still intact (see the `grep -c deepseek-worker` line above).

**Focused test for the same cascade.**
`packages/plus/test/rpc.test.ts`, test
**`agent delete removes customization records so re-created agent does not
inherit override`** (run from `packages/plus`): creates an agent, mutates a
customization record for it, verifies the assembled prompt, calls
`agent.delete`, asserts the stored and snapshot records for that agent are gone,
re-creates the agent and asserts its assembled prompt is the fresh empty body
(`[""]`) rather than the deleted agent's override — **1 pass, 0 fail, 8 expect()
calls**. This is the same-store-revision cascade and clean-re-create the line
requires, on the deletion RPC.

**Team pickers.** `sweep-agent` is a stand-alone Global user agent, not a member
of any team, so it had no row in the Team picker (`Select team`, filter
`Team:`) to begin with; the Team picker reads the same `Select agent or team`
dialog and its member rows come from `team.list`. The propagation of an agent
delete to the pickers/switcher is the T2 contract and was verified live in the
sibling sweep `docs/plans/plus-1.1.15-sweep-i-t2-live.md` (delete of
`r3-renamed`, TUI two's picker changed within ~0.5 s). Here, live, the
`sweep-agent` delete removed it from the Instructions tree, the agent switcher
and the agent picker at once; the Team-picker member case is therefore recorded
as **PASS via T2, not directly re-provoked for this stand-alone agent**.

## Focused tests (supplementary)

Run from `packages/plus` in this worktree at this HEAD:

- `bun test test/agents.test.ts` → **16 pass / 0 fail, 103 expect() calls**
  (117 ms). Includes
  **`global scope uses OPENCODE_CONFIG_DIR when set`** (the L1d cover: sets the
  env var and asserts `resolveDirectory("global","")` is `<custom>/agent` and
  that create/rename/remove use `<custom>/agent/global-reviewer.md`), and the
  create/rename/remove path tests
  (`create writes a file at the expected path…`,
  `rename moves content and fails when the destination exists or source is
  missing`, `remove deletes an existing file…`).
- `bun test test/rpc.test.ts -t "agent delete removes customization records so
  re-created agent does not inherit override"` → **1 pass / 0 fail, 8 expect()
  calls** (the L2 record cascade + clean re-create cover).

There is no ERROR/WARN from the `plus` plugin in the tests; the suite prints its
own `plus permission hook not installed` WARN-style lines to test stdout, which
are unrelated to the server log.

## Server log — every ERROR and WARN line

`$DEV/data/opencode/log/opencode-local.log` at the end (one server run
`4bc08729`): **167 lines — 161 INFO, 6 WARN, 0 ERROR.** There is no
`level=ERROR` line. Every WARN is the expected
`executor-controlled plugin source refused` refusal control (it is the only
distinct WARN message):

```
timestamp=2026-10-05T15:59:39.425Z level=WARN run=4bc08729 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode/opencode.json type=document http.span=121 role=server
timestamp=2026-10-05T15:59:39.425Z level=WARN run=4bc08729 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode type=directory http.span=121 role=server
timestamp=2026-10-05T15:59:41.950Z level=WARN run=4bc08729 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode/opencode.json type=document http.span=777 role=server
timestamp=2026-10-05T15:59:41.950Z level=WARN run=4bc08729 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/.opencode type=directory http.span=777 role=server
timestamp=2026-10-05T15:59:41.950Z level=WARN run=4bc08729 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t1343cd2-20261005-1758/.opencode/opencode.jsonc type=document http.span=777 role=server
timestamp=2026-10-05T15:59:41.950Z level=WARN run=4bc08729 message="executor-controlled plugin source refused" path=/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t1343cd2-20261005-1758/.opencode type=directory http.span=777 role=server
```

`grep -E 'level=(ERROR|WARN)' … | grep -v "executor-controlled plugin source
refused"` returns nothing.

## Result

Both end-state lines verified against this worktree's own build:

1. **L1 PASS** — create, rename and file reads for a Global user agent used
   `$DEV/config/opencode/agents/` (the dev build's real global config dir; file
   contents shown), records followed the id, and delete's file removal is under
   L2. `OPENCODE_CONFIG_DIR` is **NOT LIVE** (process-start env) but **PASS by
   the named focused test**.
2. **L2 PASS** — deleting `Global › User › sweep-agent` succeeded; it vanished
   from the Instructions tree, the agent switcher (`shift+tab`) and the agent
   picker at once; all three of its stored records (customization, link, model)
   were removed in the same store revision (`499 → 500`, 257 → 255 lines); and a
   re-created `sweep-agent` started clean (single new `link`, empty Models pane).
   The exact `deepseek-worker` id was left in place (its records intact); the
   level+agent-keyed cascade and clean re-create are also covered by the named
   focused test. Team pickers: the stand-alone agent had no member row; the
   agent-delete → pickers propagation was verified in the sibling T2 sweep.

No source file was changed; only this evidence file.

## Cleanup

`pilotty list-sessions` after killing only my session (`sweep-i-t1`, id
`6947904b-127a-44cd-9c95-08c580162291`):

```
['w-f15454a0a1ed9809-b', 'sweep-i-t8', 'w-1e01-story', 'sweep-i-t7a',
 'sweep-m-t3', 'w-f15454a0a1ed9809-a', 'sweep-i-t6', 'ux1', 'rt-t6']
```

`sweep-i-t1` is gone; every remaining session belongs to another run and was
left alone. A kernel scan (`/proc/<pid>/environ` and `/proc/<pid>/cwd`) for
processes pointing into the owned dev home found 0, so no owned launcher or
standalone server survived. Only the evidence file is committed.
