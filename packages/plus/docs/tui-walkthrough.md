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

> Superseded by presets (see "Presets: create, link, review" below): `a` on
> `Project → Teams` now asks the team name first, then a team preset; there
> is no Defaults template picker. Kept as the Round 2 record.

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

> Superseded by presets: `a` on a member row now asks `Member name`, then a
> preset. Kept as the Round 2 record.

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

---

# Round 3 Shipped Surface

The Round 3 integration extends the Instructions TUI and Composer experience with team lifecycle, team-scoped agent customization, and active-team interaction:

## 1. Team Deletion and Defaults Refusal
- **Project/Global Team Deletion:** Pressing `d delete` on an on-disk project or global team row (`team:<level>:<team>`) displays a confirmation dialog naming the team name, member count, and enabled state (`Delete project team "<team>" and its N member file(s)? ... This cannot be undone.`). Confirming deletes the team directory on disk via `team.delete`, unlinks all member files, uninstalls members if enabled, removes any stored `TeamRecord`, and removes the row from the tree with status `Deleted team <team>`.
- **Defaults Refusal:** Shipped built-in teams (`Defaults → Teams → <team>`) never offer `d delete` on the hint line (`actions.remove === false`), and pressing `d` shows an honest status refusal toast (`"<team>" cannot be deleted: team "<team>" is built in`) without opening a dialog.

## 2. Team-Scoped Special Group
- **Structure:** Every team row expands to its member rows followed by a dedicated `Special` group (`team:<level>:<team>:special`). Expanding `Special` reveals the three maintenance agents (`compaction`, `title`, `summary`, id `team:<level>:<team>:special:<id>`), each hosting the standard five agent groups (Models, Tools, Base, Skills, System with prefix `group:<level>:<team>/:special:<id>:<group>`). `general` and `explore` belong directly under OpenCode; hidden does not mean Special. Earlier captures above record the historical labels and classification.
- **Team-Scoped Customizations:** Customizations (overrides, section exclusions, model selections, perm rules) made under a team-scoped special agent persist with a `team: { level, team }` record field in `records.jsonl`. These overrides apply dynamically to the host special agents only while that team is enabled, restoring upstream baselines when the team is disabled.

## 3. Agent Selector Categories and Active-Team Cycling
- **Categorized Selector (`ctrl+x a`):** The agent selection palette groups agents under category headers: regular agents first under `Agents`, followed by active and enabled teams under `Team: <name> (<level>)`.
- **Active-Team Cycling:** Selecting any member of a team activates that team. When a team is active, the status line reflects the active team (`· team <name>`), and the cycling shortcut (`agent.cycle`, Shift+Tab or configured key) confines movement exclusively to that team's members.
- **Normal Cycling:** Selecting a regular agent under `Agents` (such as `build` or `plan`) clears the active team: the `· team` indicator leaves the status line and cycling returns to cycling normal agents only. Disabling the active team also clears active state.

## 4. Team Monitor Composer Tab
- **Composer Tab Registration:** Pressing `Down` in a started chat reveals a fourth `Team` tab alongside the built-in `Subagents`, `Shell`, and `Terminals` tabs.
- **Active Team Overview:** When a team is active, navigating to `Team` (`Right` ×3) displays the team members along with their execution mode, configured model, and session status (`idle` for active chat session owner, `none` when no session exists).
- **Direct Agent Switch:** Pressing `Enter` on any member without an existing session switches the current composer session agent to that member.
- **Inactive Fallback:** When no team is active, the tab renders the fallback notice: `No active team — select one with ctrl+x a`. Built-in composer navigation (`escape` to close, `left` to return to prior tabs) is fully preserved.

---

# Tool Permissions

Written from the code (`instructions/tree.ts`, `instructions/permission-catalog.ts`, `instructions/ops.ts`, `tui/instructions/route.tsx`, `tui/instructions/detail-pane.tsx`) and checked in a tui-lab home: the lab captures are in the workspace handoff `docs/handoffs/2026-09-25-tool-permissions/evidence/` (`tui-edit-permissions.txt`, `tui-delegate-to.txt`, `tui-filter-shell.txt`). The quoted strings are the ones those files produce; the tree sketch is schematic. `SPEC.md` (Permission rules) lists every tool's categories and every `enforced by` line.

## 1. Open a tool's Permissions

With project mode on, open `/instructions` and go to `Project → Agents → OpenCode → build → Tools → OpenCode → shell`. Expanding `shell` shows its `Description` (the tool's text, here one section) and its `Permissions`, one group per category:

```
shell [on]
  Description [on]
  Permissions
    Commands
    Working directories
    Parameters
    Environment
    Limits
    Approval
```

(`Mentioned in instructions` follows when instruction text suggested shell rules.) On `Permissions` (`group:project:build:tool:shell:permissions`) the detail pane reads `Every permission of shell, one group per category. Rows are on/off; enter edits a rule's patterns or a limit's number.`; on `Commands` it reads the category's summary, `Command families. The shell's permission resource is each parsed command's text, so these are wildcard patterns over it.`

## 2. Read "enforced by" and turn a row off

Expand `Commands`. `Every other command`, the category's Everything else row, comes first, then the curated rules, then the catalog's command families. Select `Git branches, tags and worktrees [on]`: the hint line offers `enter edit rule` and `space toggle`, and the detail pane's rule block reads

```
tool: shell · rule: commands.git-refs
enforced by: core rule on shell: off refuses what the patterns match
patterns: git branch -d *, git branch -D *, git branch -m *, git branch -M *, git branch -f *, git tag *, git update-ref *, git worktree add *, git worktree remove *, git worktree prune *, git worktree move *
keywords: (none)
provenance: (curated)
message: changing git refs or worktrees is not allowed here
```

Press space: the badge turns `[off]` and the status line reads `Disabled "Git branches, tags and worktrees"`. The record lands at the row's own level (Project, for `build`), and once applied, build's shell refuses `git tag v1.0` with `changing git refs or worktrees is not allowed here`. `r` drops the override again.

Other rows say other things on that line. `Parameters → Background (background: true)` reads `tool input (background): off removes the parameter from the schema and refuses a call that uses it`; it has no patterns, so its hint says `space switch` and enter only shows `"Background (background: true)" is a switch: space turns it on or off`. `Environment → Keys, tokens and passwords` reads `shell environment: off strips the matching variables before the command starts`.

## 3. Edit a limit

Expand `Limits` and select `Longest timeout (ms) [off]`. The hint line offers `enter edit number`; the detail pane reads `enforced by: limit on timeout (value, lowered to the cap): on applies the number`, and the row's text is its number, `600000`.

Press enter: a prompt titled `Longest timeout (ms)` says `A number. Space switches the cap off and on.`, prefilled with `600000`. Enter `120000`: the status reads `Saved "Longest timeout (ms)"`. The row is still off, so nothing is capped yet; space turns it on (`Enabled "Longest timeout (ms)"`). Once applied, a shell call asking for `timeout: 300000` runs with `120000`, and build's shell schema carries `maximum: 120000` on `timeout`. An answer with no number in it is refused with the toast `"Longest timeout (ms)" takes a number`. A tool can do the same with `tools.instructions.set({ id: "item:project:build:perm:shell:limits.timeout", text: "120000" })`.

---

# Presets: create, link, review

Written from the code (`tui/instructions/dialogs.tsx`, `route.tsx`, `tree-pane.tsx`, `detail-pane.tsx`, `tui/preset-picker.ts`, `tui/agents/create.tsx`) and its tests (`test/route.test.tsx`, `test/agent-create-palette.test.tsx`, `test/instructions-panes.test.tsx`); not a live lab capture. The quoted strings are the ones the code produces. `SPEC.md` (§"TUI create, link and review") has the full table.

## 1. Create: a → name → preset → done

Everywhere the flow is the same: `a`, a name, a preset. There is no template, prompt, model or mode step, and on a Project or Global row no scope question: the row's root decides.

- `Project → Agents` (or its `User`): prompt `Create agent`, then the `Preset` picker. Its options are grouped `Agent presets · OpenCode` (Build, Plan, …), `Agent presets · Plus` (Planner, Orchestrator, …), `Agent presets · User`, `Team preset members` (`starter › planner`, …), and last `None — everything off`. The new agent row is revealed and selected. OpenCode agent presets remain available; team presets have only Plus and User categories because OpenCode ships no teams.
- `Project → Teams`: prompt `Team name`, then `Team preset` (`Plus`: opencodeplus-team, review, starter; `User`: yours; last `Empty team`).
- a team row or a member row: prompt `Member name`, then `Preset`.
- `Defaults → Agents`: prompt `Agent name or pattern` (`* and % match any text, case-insensitive (e.g. *orchestrator*)`), then `Preset` → a Defaults entry.
- `Defaults → Teams`: prompts `Team name or pattern`, `Member name or pattern`, then `Preset` → a team entry with its first member entry. `a` on that team pattern row or its member entry rows adds more member entries to the same pattern.
- `Presets → Agents → User`: prompt `Preset name`, then `Base preset` (the same picker). `Presets → Teams → User`: prompt `Team preset name`, then `Team preset`. A User team preset row: prompt `Member name`, then `Preset`.
- A Models group anywhere, member presets included, adds a model for that owner with no scope prompts.
- The palette `Create agent` has no cursor, so it asks `Create agent`, then `Agent scope` (Project / Global), then `Preset`.

## 2. Relink with l

On an agent, member or team at Project/Global, a Defaults entry, or a User preset, the hint line offers `l link`. `l` opens `Link to preset` (a team: `Link to team preset`) with the current link preselected and `None — unlink` last. A success toasts `Linked alice to Planner (Plus)` or `Unlinked alice`; relinking a team also relinks every member the team preset has a member of the same id for and says so (`Linked crew to mine (User); relinked helper, planner`), while unlinking a team leaves its members linked; a refusal toasts the server's message, e.g. a cycle between User presets (`Linking … would make it reach itself (…)`). OpenCode and Plus presets, a Teams entry pattern row and an OpenCode agent's own Defaults row offer no `l`.

## 3. Delete a preset or an entry

`d` on a User preset or a Defaults entry confirms and deletes. A preset something links to is refused, and the toast names who uses it (`… (used by agent:project:alice)`).

## 4. Where a value comes from

A row that inherits shows its source after its badges, dim: `bash [on] · from preset Orchestrator`, `· from default *orchestrator*`, `· from Defaults (every agent)`, `· OpenCode`, `· off by default`. A row that sets its value itself shows nothing. The detail pane says the same: `state and text: from preset Orchestrator`, or `state: from preset Orchestrator · text: upstream` when they differ, `set here (Project)` for this level's own value. An agent's detail adds `Created from preset: Orchestrator (Plus)` (or `No preset`); a Defaults entry adds `matches agents named: *orchestrator*` and `matching now: …`. Stored `native` ids, API discriminators, and `group:native` filters remain compatible with the displayed OpenCode origin.

## 5. Review a changed state, pin or model

When the preset (or a Defaults entry) changes a value you had set yourself, the row reads `[to review (state)]` (text: `[to review]`; both: `[to review (text, state)]`) and the hint line offers `enter review`. Enter opens `Review "bash"`: `Keep yours (off)` keeps your value and acknowledges the change; `Take from preset Orchestrator (on)` drops yours so the row follows the preset again. If the text is under review too, the three-way diff (`k keep mine · t take new · e edit`) follows for the text. A model row under review (`[review]`) offers `Keep yours (acme/mine)` / `Take from Defaults (every agent) (acme/base)`.
