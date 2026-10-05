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
