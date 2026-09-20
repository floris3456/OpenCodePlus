# Teams Round 3 — Integration Gate Walkthrough

- **Integrated HEAD:** `aeb3aaa0f2ae01c00be21e043e6b7b5af6862c5d`
- **Base:** `855c27a1e84072a055ce1d0a6037fab402d1b57c`

Every capture below was taken by the orchestrator with `/home/bliss/OpenCodePlus/docs/team-v2/scripts/tui-lab.sh` against the integrated branch, on a lab project seeded with the human's real teams (`Cobra`, `bruh test`, `lollie`, `opencodeplus-team`) and agents (`Test`, `f`, `lolz`, `tester`).

---

## T1 Timings

**Objective:** `d` on a team member row under 60 ms; Enter on `/instructions` to tree rows under 150 ms.

### BEFORE (base 855c27a1e)

```
=== BASELINE T1: move to member row testttt, time d -> confirm dialog ===
 Instructions                                                     testttt (team)
  - Project
    + Agents                                                      No item details
    - Teams
      - Cobra [off]
 ›      + testttt
      + bruh test [off]
d -> Delete dialog: 480 ms
```

Enter on `/instructions` -> first tree rows: 441 ms at base.

### AFTER (integrated branch, orchestrator's own run)

```
=== ORCH T1 AFTER: Enter -> tree rows: 69 ms  (base was 441 ms) ===
 Instructions                                                     testttt (team)
  - Project
    + Agents                                                      No item details
    - Teams
      - Cobra [off]
 ›      + testttt
      + bruh test [off]
      + lollie [off]
=== ORCH T1 AFTER: d -> Delete dialog (base was 480 ms) ===
run 1: 8 ms
run 2: 6 ms
run 3: 6 ms
```

and the settled dialog:

```
 Instructions                                                     testttt (team)
 ›      + testttt
  - Defaults                         Delete team member testttt?                          esc
    + Teams                          Delete member "testttt" from team "Cobra"? This cannot
    + Models                         be undone.
    + Skills                                                                 Cancel  Confirm
Delete of "testttt" cancelled
arrows move · left/right expand · enter edit · a add · d delete · / filter · ? help · esc back
```

**Verdict:** 480 ms -> 6-8 ms and 441 ms -> 69 ms, both inside the objective.

---

## T2 Team Delete + Defaults Refusal

### BEFORE (base)

Cursor on `› - Cobra [off]`, hint line:
`arrows move · left/right expand · enter edit · space toggle · a add · / filter · ? help · esc back`
(no `d delete`), and `d` did nothing.

### AFTER 1 — hint line now offers `d delete` (team `Cobra` ENABLED)

```
 Instructions                                                     Cobra (team)
  - Project
    + Agents                                                      on
    - Teams
 ›    + Cobra [on]                                                No item details
      + bruh test [off]
      + lollie [off]
      + opencodeplus-team [off]
arrows move · left/right expand · enter edit · space toggle · a add · d delete · / filter · ? help · esc back
```

### AFTER 2 — the confirm dialog, naming member count and enabled state

```
    + Agents                         Delete team Cobra?                                   esc
    + Models                         Delete project team "Cobra" and its 1 member file(s)? It
    + Tools                          is currently enabled. This cannot be undone.
    + System                                                                 Cancel  Confirm
```

### AFTER 3 — after Confirm the row is gone and the status line reads `Deleted team Cobra`

```
 Instructions                                                     Project (root)
 ›- Project
    + Agents                                                      No item details
    - Teams
      + bruh test [off]
      + lollie [off]
      + opencodeplus-team [off]
Deleted team Cobra
```

and on disk the team directory is gone (`ls .opencodeplus/teams/` went from `Cobra, bruh test, lollie, opencodeplus-team` to `bruh test, lollie, opencodeplus-team`).

### AFTER 4 — Defaults teams are never deletable

Cursor on `Defaults → Teams → starter [off]`, the hint line has NO `d delete`:

```
      + User
    - Teams
      + opencodeplus-team [off]
      + review [off]
 ›    + starter [off]
arrows move · left/right expand · enter edit · space toggle · a add · / filter · ? help · esc back
```

and `d` prints the honest status refusal with no dialog:

```
"starter" cannot be deleted: team "starter" is built in
```

---

## T3 Special Under a Team

### AFTER 1 — `Special` sits after the member rows under the team

```
 ›    - opencodeplus-team [on]
        + astra-planner
        ... (nine members) ...
        + spark-implementer
        + Special
```

### AFTER 2 — `Special` expands to exactly the five special agents

```
 ›      - Special
          + general
          + explore
          + compaction
          + title
          + summary
```

### AFTER 3 — each special agent expands to the same five groups a member has

```
 ›        - explore
            + Models
            + Tools
            + Base
            + Skills
            + System
```

### AFTER 4 — toggling a row under a team-special agent persists a TEAM-SCOPED record

`space` on `Tools → Native → edit [on]` under `explore` wrote, in `instructions.snapshot`:

```json
{
  "type": "customization",
  "level": "project",
  "agent": "explore",
  "team": { "level": "project", "team": "opencodeplus-team" },
  "item": "tool:edit",
  "section": null,
  "state": "off",
  "updated": "2026-09-20T00:27:14.871Z"
}
```

That `team` field is the plan's team-scoped owner: the record applies to `explore` only while `opencodeplus-team` is enabled.

The orchestrator's live probe of the host's reflection of this override queried `agent.permission.edit` on `/api/agent`, which is the wrong field for a tool-level deny, so it returned `None` both while the team was enabled and after disabling it; that probe proves nothing either way. Host reflection and restoration on disable are covered by the real-handler tests in `test/teams-apply.test.ts` and `test/teams-rpc.test.ts`, which are green.

---

## T4 Select Agent Categories + Team-Only Cycling + Back to Normal

Note that `pilotty key "Shift+Tab"` reports ok but never reaches the TUI's `agent.cycle` binding, so cycling was driven with `agent.cycle` rebound to `ctrl+n` in the lab's own `cli.json` — the identical `local.agent.move(1)` code path.

### BEFORE (base)

`ctrl+x a` was a flat list with no categories (build, plan, f, lolz, astra-planner, astra-reviewer, fable-planner, gemini-implementer, muse-implementer, opus-orchestrator, scout, sol-orchestrator, spark-implementer), and the ring mixed them: `Build -> Plan -> F -> Lolz -> Astra-Planner -> Astra-Reviewer`.

### AFTER 1 — `ctrl+x a` is categorized, `Agents` first then the team

```
--- Terminal 130x45 | Cursor: (14, 39) ---
                                       Select agent or team                             esc
                                       [S]earch
                                       Agents
                                     ● build The default agent. Executes tools based on con
                                       plan Read-only agent for exploring the codebase and
                                       f
                                       lolz
                                       Team: opencodeplus-team (project)
                            ┃          astra-planner Astra planner: turns goals into exact
                            ┃  Ask     astra-reviewer Astra reviewer: reviews diffs against
                            ┃          fable-planner Fable planner: turns goals into exact
                            ┃  Buil    gemini-implementer Gemini implementer: executes boun
                            ╹▀▀▀▀▀▀    muse-implementer Muse implementer: executes the brie
                            /…/run/    opus-orchestrator Opus orchestrator: owns work, dele
                                       scout Scout: finds things and reports exact file loc
                                       sol-orchestrator Sol orchestrator: owns work, delega
                                       spark-implementer Spark implementer: rapid edit and
```

### AFTER 2 — selecting `astra-planner` makes the team active; cycling stays inside the team

```
ctrl+n 1 -> ┃  Astra-Reviewer · claude-fable-5-1 CLIProxyAPI · xhigh
ctrl+n 2 -> ┃  Fable-Planner · claude-fable-5-1 CLIProxyAPI · xhigh
ctrl+n 3 -> ┃  Gemini-Implementer · claude-fable-5-1 CLIProxyAPI · xhigh
ctrl+n 4 -> ┃  Muse-Implementer · claude-fable-5-1 CLIProxyAPI · xhigh
ctrl+n 5 -> ┃  Opus-Orchestrator · claude-fable-5-1 CLIProxyAPI · xhigh
```

and the status line carries the active team:

```
                            /…/proj:master     · team opencodeplus-team  ctrl+n agents  ctrl+p commands
```

### AFTER 3 — selecting `Build` from `Agents` clears the team; cycling is normal agents only and the ` · team` marker is gone

```
ctrl+n 1 -> ┃  Plan ·
ctrl+n 2 -> ┃  F ·
ctrl+n 3 -> ┃  Lolz ·
ctrl+n 4 -> ┃  Build ·
ctrl+n 5 -> ┃  Plan ·
                            /…/run/tmp-build/tui-lab-orcht4/proj:master  ctrl+n agents  ctrl+p commands
```

### AFTER 4 — disabling the active team clears active state and uninstalls members

Disabling the active team from `/instructions` (`space` on `opencodeplus-team [on]`) flips the row to `[off]`, clears the active team (the ` · team opencodeplus-team` marker leaves the status line), and the server uninstalls the members (`/api/agent` goes from 18 entries back to 9: build, general, explore, compaction, title, summary, plan, f, lolz). After a TUI restart the ring is exactly `Build -> Plan -> F -> Lolz`.

Known limitation, recorded deliberately: when a team is enabled or disabled while the TUI is already running, the core client's cached agent list can lag, so the ring may briefly still cycle the removed members until it refreshes. `packages/plus/src/tui/active-team.tsx` now calls the host agent-list sync on `teams.changed` to shorten that window (commit a42faa14a); a TUI restart always settles it. The server side is always correct.

---

## T5 Team Tab

### BEFORE (base)

`Down` in a started chat showed three tabs:

```
  ┃  Subagents  Shell  Terminals                                                 esc
  ┃  No active subagents
  ┃  show inactive ctrl+a  tabs ←/→
```

### AFTER 1 — a fourth `Team` tab, after the three built-ins, with Subagents still the default

```
  ┃  Subagents  Shell  Terminals  Team                                           esc
  ┃  No active subagents
  ┃  show inactive ctrl+a  tabs ←/→
```

### AFTER 2 — `Right` ×3 reaches `Team`, listing the active team's members with mode, model and session status

```
  ┃  Subagents  Shell  Terminals  Team                                           esc
  ┃  astra-planner — primary — default                                         idle
  ┃  astra-reviewer — primary — default                                        none
  ┃  fable-planner — primary — default                                         none
  ┃  gemini-implementer — primary — default                                    none
  ┃  muse-implementer — primary — default                                      none
  ┃  select enter  tabs ←/→
```

(`astra-planner` reads `idle` because it owns the current chat session; the others have no session under this root, so `none`.)

### AFTER 3 — Enter on a member without a session sets it as the current agent

The prompt footer became:

```
  ┃  Astra-Reviewer · claude-fable-5-1 CLIProxyAPI · xhigh
```

### AFTER 4 — with no active team (after selecting `Build`) the tab shows the fallback

```
  ┃  Subagents  Shell  Terminals  Team                                           esc
  ┃  No active team — select one with ctrl+x a
  ┃  select enter  tabs ←/→
```

### AFTER 5 — composer navigation preserved

The Composer's existing behaviour is unchanged: `escape` closes it back to the prompt, and `left` from `Team` walks back through the built-in tabs.

---

## Checks at HEAD

Checks and results at HEAD (`aeb3aaa0f2ae01c00be21e043e6b7b5af6862c5d`):

- **plus-tree-route:** 123 pass / 0 fail
- **plus-teams:** 75 pass / 0 fail
- **plus-discover-apply:** 145 pass / 0 fail
- **plus-query-tools-ops:** 137 pass / 0 fail
- **plus-typecheck:** exit 0
- **tui-tests:** 14 pass / 0 fail
- **tui-typecheck:** exit 0
