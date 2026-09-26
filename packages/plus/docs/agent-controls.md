# Agent controls in Instructions

Instructions manages agent behavior at Project, Global, Defaults, and Presets
levels. Project overrides are local to the project; Global values apply across
projects. Reset removes only the selected level's override, so inherited values
become effective again.

## Enabled and hidden are different

- **Enabled** turns the agent on or off without deleting its customizations.
  An off agent stays in Instructions so it can be turned back on, but is absent
  from the host agent catalogue and cannot execute as a subagent.
- **Hidden** controls discovery and normal pickers. It is not a permission or
  security boundary.
- **Mode** controls whether the agent can be used as Primary, Subagent, or All.
  Press Enter on Mode to cycle through those values.

Description, color, and maximum steps use OpenCode's existing agent fields. The
step limit is a positive integer; new user input resets the allowance. Empty
color or step values clear those fields; Reset resumes inheritance. Reset on an
agent row clears its nine agent/compaction controls at that level, not its tool
or prompt overrides.

The **OpenCode → Special** group contains only `title`, `compaction`, and
`summary`. A custom agent does not become Special merely because it is hidden.
OpenCode supplies agent presets, not team presets.

## Compaction

Each agent has a Compaction category. Configure it on the agent, on its linked
preset, or through Defaults, using the same scope and reset rules as the rest of
Instructions.

| Strategy | Behavior |
| --- | --- |
| Auto | Follows the active model's compaction policy. |
| Local | Summarizes locally, using the selected compaction model and instructions. |
| Remote | Requests the active model's provider compaction operation. |

Without an explicit model override, local compaction inherits an explicitly
configured maintenance compaction-agent model, otherwise the session's current
active model. It does not pin the model that happened to be active when the
setting was saved. Per-agent instructions override maintenance compaction-agent
instructions; the structured summary format remains enforced.

Compaction models use `provider/model#variant` syntax (the variant is optional).
An empty model clears the per-agent choice. Empty instructions are an explicit
empty prompt; use Reset instead when you want inherited instructions.

Remote compaction uses provider capability detection, not provider names. It
ignores local model and instruction overrides, and those controls are disabled
in the TUI. Their saved values are retained for switching back to Local or Auto.
An unsupported remote operation fails explicitly; it does not silently produce
a local summary. Auto retains the existing local overflow-recovery behavior.

## Tool examples

Turn an agent off and back on without deleting it:

```ts
await tools.instructions.set({ id: "agent:project:reviewer", state: "off" })
await tools.instructions.set({ id: "agent:project:reviewer", state: "on" })
```

Set its mode and local compaction instructions:

```ts
await tools.instructions.set({
  id: "item:project:reviewer:setting:mode",
  text: "subagent",
})
await tools.instructions.set({
  id: "item:project:reviewer:compaction:strategy",
  text: "local",
})
await tools.instructions.set({
  id: "item:project:reviewer:compaction:instructions",
  text: "Preserve unresolved review findings and exact file references.",
})
```

Use `instructions.list` to obtain the exact row IDs for team members, presets,
and Defaults entries rather than constructing them. Existing protected-agent
and project-mode write guards still apply.

## Current limitations

Per-agent request header/body overlays are not exposed as working controls:
OpenCode currently retains those fields but does not send them with model
requests. Configure effective request settings on providers, models, or model
variants instead.

The low-level session API retains OpenCode's existing ability to store an
explicit agent ID before execution. Disabling removes the agent from available
agents; a session retaining that ID must select an enabled agent before it can
execute again.
