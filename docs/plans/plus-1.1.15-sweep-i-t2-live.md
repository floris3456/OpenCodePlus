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

Owned home `<dev-home>` =
`/home/bliss/OpenCodePlus/run/plus-dev/run-plus-data-opencodeplus-teams-worktrees-opencode-Flash-C-Worker-t124490f-20261005-1623`.
`project` (TUI `sweep-i-t2-one`) and `project-two` (TUI `sweep-i-t2-two`) are
two separate Locations in each TUI's own standalone server; the global config
under `<dev-home>/config/opencode/` is shared. Every change below was made in
TUI **one** and observed in TUI **two** (and back); each result quotes the
screen or log lines and the timestamps (`date +%s%3N`).

### Line 1 — agent disable / enable / create / delete / rename reach the other TUI

All five agent verbs were exercised from TUI one; the agent picker and the
`shift+tab` switcher in TUI two were checked; the Team picker is covered under
line 2 (no team exists yet at this point, so `team.list` is empty for both).

**1a. Disable `build` (Global › Agents › OpenCode › build › Settings › Enabled, or the
sidebar `build` row).** Action: `Space` on the sidebar `build` row / the `Enabled`
setting in TUI one at `1791210848531`; TUI one showed
`build  primary · off` and `○ Enabled … value Off`. TUI two's `shift+tab`
cycle was probed at `1791210858454` and four more times: every probe showed
`Plan · claude-fable-5-1` / `T2-Live…` with **no** `Build`. Opening TUI two's
`Switch agent` picker showed

```
Agents
  build Human-driven build seat: full access, fixes wh
● plan Read-only agent for exploring the codebase and
```

`build` listed without the `●` availability marker. **PASS**, and line 3 PASS
(no lingering). Re-confirmed controlled at `1791211441165`: disable in TUI one,
first TUI two `shift+tab` probe at `+613ms` already lacked `Build`; 40 probes
over 6.1 s never showed it.

**1b. Enable `build`.** Action: `Space` on the same row at `1791210893155`
(TUI one `● Enabled`, source `set here (Global)`). Re-confirmed at
`1791211431640`: first TUI two `shift+tab` probe to show `Build` was
`+1188ms`; TUI two's cycle then alternated Build/Plan/T2-Live… **PASS.**

**1c. Create agent `t2-live` (Global, preset `Build`).** Action: palette
`Create agent` → id `t2-live` → `Global` → `Create from a preset` → `Build`,
final Enter at `1791211028771`. TUI one toasted
`Created agent t2-live at <dev-home>/…/config/opencode/agents/t2-live.md` and
selected the new `User › t2-live` row. In TUI two, opening the `Switch agent`
picker 3.6 s later and again at 6.3/9.1/11.8 s showed `t2-live` each time, and
the `shift+tab` cycle in TUI two included `T2-Live` repeatedly. **PASS.**

**1d. Create `t2-live2`/`t2-live3`, then rename `t2-live3` → `r3-renamed`.**
With TUI two's picker **open**, TUI one renamed the row with `R` (prompt
`Rename t2-live3`, value prefilled). Final Enter at `1791211191108`; TUI two's
open picker showed the new name `r3-renamed` from +512 ms onward
(`+512ms PICKER shows r3-renamed`). **Rename PASS** (within ~0.5 s).

**1e. Delete `r3-renamed`.** `d` → confirm dialog
`Delete global agent "r3-renamed"? This cannot be undone.` → confirm at
`1791211263749`. TUI two's open picker dropped it: `+261ms shows r3-renamed;
+516ms PICKER gone`. **Delete PASS** (within ~0.5 s).

Agent summary: create / rename / delete / enable reach the other TUI within
~0.5–1 s for the picker and `shift+tab` (PASS); **disable reaches the other
TUI's picker (unavailable marker) but its `shift+tab` cycle kept the disabled
`Build` for ≥ 6.6 s (FAIL for `shift+tab`)**. This also fails line 3 (see
below).
