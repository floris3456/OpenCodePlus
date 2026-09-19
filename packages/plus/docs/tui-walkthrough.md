# Instructions TUI Round 2 — Live Walkthrough

Captured at commit `c32b49c477a3ad473211859f9e5505edcffe883e`.

This document records the live pilotty walkthrough verifying the Round 2 integration of OpenCodePlus Instructions TUI features:
- Template-driven team creation without redundant scope prompts (R1)
- Direct agent template flow when adding from team member rows (R2)
- Agent origin subgroups (`Native`, `Special`, `Plus`, `User`) under all three roots and ancestor-agent delete suppression (R3)
- Member deletion with confirmation and disk unlinking (R4)
- Model candidate activation on team members propagating to the host agent registry and active base badge alignment (R5)
- Absence of deletion affordance on tool rows

The walkthrough was driven against a live TUI session using the lab harness at session `r6` with lab project `/home/bliss/OpenCodePlus/run/tmp-build/tui-lab-r6/proj` (nested under the `OpenCodePlus` repository root, exposing ancestor agents `f` and `lolz`).

## Lab Recipe

The walkthrough commands used in the harness:

```sh
LAB=docs/team-v2/scripts/tui-lab.sh          # in the OpenCodePlus workspace root
$LAB up <worktree> r6                         # prints port + project dir
$LAB keys r6 "Ctrl+P"; $LAB type r6 instructions; $LAB keys r6 Enter
$LAB keys r6 "Down Right"                     # navigate; prints the settled screen
$LAB snap r6                                  # current screen
$LAB rpc r6 instructions.snapshot             # lab server snapshot (JSON)
$LAB down r6
```

Host agent state was inspected via curl:
```sh
curl -u opencode:$PW -H "x-opencode-directory: $T/proj" http://127.0.0.1:$(cat $T/port)/api/agent
```

---

## Capture 1 — Three Agents Subgroups at the Project Root (R3)

Navigating to `Project → Agents`:

```
 Instructions                                                     Special (group)
  - Project
    - Agents                                                      No item details
      - Native
        + build
        + plan
 ›      - Special
          + general
          + explore
          + compaction
          + title
          + summary
      + Plus
      - User
        + f
```

**Proves:** Built-in native and special agents project under the Project root in dedicated `Native` (with nested `Special`) origin subgroups alongside `Plus` and `User`.

---

## Capture 2 — Same Shape at the Global Root (R3)

Navigating to `Global → Agents`:

```
  - Global
    - Agents
 ›    - Native
        + build
        + plan
        + Special
      + Plus
      + User
    + Teams
```

**Proves:** The Global root renders the identical agent origin subgroup structure (`Native` with nested `Special`, `Plus`, `User`) as the Project root.

---

## Capture 3 — Ancestor-Backed Agent Offers No `d delete` (R3 + Ancestor RPC Fix)

Before the ancestor fix, `instructions.snapshot` carried no `ancestor` property for ancestor-discovered agents:

```json
{"id": "f", "scope": "project", "origin": "user", "path": "/home/bliss/OpenCodePlus/.opencode/agent/f.md", "base": "claude", "fileBacked": true}
```

BEFORE the fix, the footer on `Project → Agents → User → f` offered delete:

```
arrows move · left/right expand · enter edit · a add · d delete · / filter · ? help · esc back
```

AFTER the fix, selecting `Project → Agents → User → f`:

```
 ›      + f
arrows move · left/right expand · enter edit · a add · / filter · ? help · esc back
```

**Explanation:** `existingAgentPath` confines agent deletion to the project's own `.opencode/{agent,agents}` directory and refuses to resolve outside it. Ancestor-backed agent rows cannot be deleted from the child project; the server identifies them and passes `AgentEntry.ancestor: true` across the RPC boundary, causing the TUI tree to suppress the delete action (`actions.remove === false`).

**Proves:** Ancestor-backed project agents suppress the `d delete` action because deletion is confined to the local project directory and cannot modify ancestor repositories.

---

## Capture 4 — Team Create from Template at Project (R1)

Pressing `a` on `Project → Teams` displays the Defaults template picker:

```
Team template                                    esc
[S]elect a Defaults template
Blank Start with an empty team
opencodeplus-team
review
starter
```

Selecting `opencodeplus-team` transitions directly to the name prompt, prefilled with the chosen template name:

```
Team name                                            esc
Starting from template opencodeplus-team
opencodeplus-team[ ]
enter submit
```

Submitting with a single Enter creates the team without displaying any `Team scope` dialog (`grep -c "Team scope"` returned `0`):

```
    - Teams
      + opencodeplus-team [off]
```

**Proves:** Creating a team from a template under `Project → Teams` takes project scope directly without prompting for scope and prefills the team name from the chosen template.

---

## Capture 5 — `a` on a Team Member Row Opens the Agent Template Flow (R2)

With the cursor on member row `astra-planner` under `Project → Teams → opencodeplus-team`, pressing `a`:

```
        + fable-planner                Agent template                                   esc
```

The generic eight-option item type picker (`Select what to add`) did not appear; the prompt navigated directly to Defaults agent templates.

**Proves:** Pressing `a` on a team member row opens the Agent template flow directly rather than presenting the generic item picker.

---

## Capture 6 — `d` on a Member Row (R4)

Selected member row `astra-planner` displaying footer actions:

```
 ›      + astra-planner
arrows move · left/right expand · enter edit · a add · d delete · / filter · ? help · esc back
```

Pressing `d` triggers the confirmation dialog:

```
Delete team member astra-planner?                    esc
Delete member "astra-planner" from team "opencodeplus-team"? This cannot be undone.
                                        Cancel  Confirm
```

Confirming unlinks the member file and updates the tree:

Disk state (`.opencodeplus/teams/opencodeplus-team/`):
```
astra-reviewer.md fable-planner.md gemini-implementer.md muse-implementer.md opus-orchestrator.md scout.md sol-orchestrator.md spark-implementer.md
```

TUI tree:
```
      - opencodeplus-team [off]
        + astra-reviewer
        + fable-planner
        ...
```

**Proves:** Pressing `d` on a team member row prompts for confirmation, invokes `team.removeAgent`, unlinks the member file from disk, and removes the row from the tree.

---

## Capture 7 — Model Activation on a Team Member Reaches the Host (R5)

Enabling the team via `space` on `Project → Teams → opencodeplus-team` sets `opencodeplus-team [on]` with toast `Enabled team "opencodeplus-team"`.

Adding and activating model `cliproxyapi/claude-opus-5@high` on member `muse-implementer`:

```
 ›            cliproxyapi/claude-opus-5@high [active]
      detail: active model from: Project · source: Project · active
```

Querying `GET /api/agent` on the lab server:

```
muse-implementer -> model: {"id": "claude-opus-5", "providerID": "cliproxyapi", "variant": "high"}
scout            -> model: null
```

The activated model is reflected in the host agent registry for `muse-implementer`, while the sibling member `scout` remains untouched (`null`).

**Proves:** Activating a model on a team member updates the host registry at `/api/agent` while unconfigured sibling members remain untouched.

---

## Capture 8 — Base Badge Follows the Activated Claude Model

Inspecting `Base` under `muse-implementer`:

```
 ›        - Base
            + Claude.txt [on] [active] [unsupported]
            + GPT.txt [on] [unsupported]
            + Gemini.txt [on] [unsupported]
            + General.txt [on] [unsupported]
            + Kimi.txt [on] [unsupported]
```

**Proves:** The base prompt active badge dynamically tracks the member's activated model family (selecting `Claude.txt` for the Claude model).

---

## Capture 9 — Tool Rows Offer No `d delete`

Inspecting a tool row (such as `edit` under Tools):

```
 ›            + edit [on]
arrows move · left/right expand · enter edit · space toggle · a add · s split · / filter · ? help · esc back
```

**Proves:** Tool rows are non-file items that do not offer or bind the `d delete` action.
