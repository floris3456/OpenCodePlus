# Instructions T2 live sweep — Flash-C-Worker t124490f

Final live sweep of Instructions T2 ("agent and team changes reach every open
TUI at once") in this worktree's own build. Evidence only; no source file
changed.

## Build under test

- Worktree (this one):
  `/home/bliss/OpenCodePlus/run/plus/data/opencodeplus/teams/worktrees/opencode/Flash-C-Worker/t124490f-20261005-1623`
- HEAD at test start: `012caf2267b27eae35dbe01800ededa75dd7e1ff`
  (branch `team/Flash-C-Worker/t124490f-20261005-1623`).
- Launched exactly: `pilotty spawn --name sweep-i-t2-one opencodeplus-dev .`
  from the worktree root, then
  `pilotty spawn --name sweep-i-t2-two opencodeplus-dev . $DEV/project-two`
  (the second folder). Own dev home, never shared port 40375, never
  `bun run dev:live`, never `bun run dev`.
- Owned dev home:
  `/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t124490f-20261005-1623`
  (shorthand `<dev-home>` below).
- Server logs: `<dev-home>/data/opencode/log/opencode-local.log`.
- Model where a chat is used: `cliproxyapi/deepseek-v4.1-flash-cheap`.

## End-state lines

The contract lines copied from `docs/plans/plus-1.1.12-instructions.md` T2:

1. Within about 2 seconds, with no TUI or server restart, in every open TUI and
   every Location: **disabling, enabling, creating, deleting or renaming an
   agent** updates the agent switcher (`shift+tab`), the agent picker and the
   Team picker.
2. Within about 2 seconds, with no TUI or server restart, in every open TUI and
   every Location: **creating a team, adding or removing members, and enabling
   or disabling a team** updates the same three places and the Instructions
   tree; in particular, a team just created and filled shows its members
   immediately, without toggling the team off and on.
3. **Disabled agents never linger in `shift+tab`.**

## Results

_To be filled per line below._
