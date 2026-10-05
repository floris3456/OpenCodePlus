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
