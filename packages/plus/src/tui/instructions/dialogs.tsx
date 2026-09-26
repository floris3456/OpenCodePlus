import type { Plugin } from "@opencode/plugin/tui"
import { Definition, type Level, type Plus, type PresetRef } from "../../rpc.js"
import { parsePermItemId } from "../../instructions/model.js"
import type { AddKind, RowOwner, TreeNode } from "../../instructions/tree.js"
import { pickAgentPreset, pickTeamPreset, presetName } from "../preset-picker.js"
import type { InstructionsState } from "./state.js"

export function createInstructionsDialogs(context: Plugin.Context, state: InstructionsState) {
  const plus = context.client.rpc(Definition)
  let disposed = false

  async function addFor(node: TreeNode | undefined): Promise<void> {
    if (disposed) return
    if (
      node !== undefined &&
      (node.id.match(/^team:(project|global|defaults):[^:]+:special$/) !== null ||
        node.id.match(/^team:(project|global|defaults):[^:]+:special:[^:]+$/) !== null)
    ) {
      state.setStatus("Special agents are built in; add is not available here")
      return
    }
    // A tool row that hosts both sections and rules carries no direct add:
    // `a` offers the Section / Permission rule choice. Every other row keeps
    // today's direct add or the generic picker.
    if (node?.kind === "item" && node.address !== undefined && node.add === undefined && node.actions?.split === true && node.address.item.startsWith("tool:")) {
      const picked = await context.ui.dialog.select<"section" | "rule">({
        title: "Add",
        placeholder: "Select what to add",
        options: [
          { title: "Section", value: "section" },
          { title: "Permission rule", value: "rule" },
        ],
      })
      if (disposed) return
      if (picked === undefined) return
      await addKind(picked, node)
      return
    }
    const kind = node?.add
    if (kind === undefined) {
      const picked = await context.ui.dialog.select<AddKind>({
        title: "Add",
        placeholder: "Select what to add",
        options: [
          { title: "Agent", value: "agent" },
          { title: "Base prompt", value: "base" },
          { title: "Skill", value: "skill" },
          // OpenCodePlus: AGENTS.md handling disabled pending the Context catalogue
          // (instructions/discover.ts). Restore with the rows.
          // { title: "Instruction", value: "instruction" },
          { title: "MCP server", value: "mcp" },
          { title: "Team", value: "team" },
          { title: "Model", value: "model" },
          { title: "Permission rule", value: "rule" },
        ],
      })
      if (disposed) return
      if (picked === undefined) return
      await addKind(picked, node)
      return
    }
    await addKind(kind, node)
  }

  async function addKind(kind: AddKind, node?: TreeNode): Promise<void> {
    if (kind === "preset") return addPreset()
    if (kind === "team-preset") return addTeamPreset()
    if (kind === "agent") {
      // A user team preset takes member presets.
      if (node?.owner?.preset?.ref.kind === "team") return addPresetMember(node.owner.preset.ref.id)
      // Team rows and member rows carry `add: "agent"` (kind "team"); both
      // route to addTeamAgent, which resolves the enclosing team (at
      // Defaults: a member entry of the team pattern).
      if (node?.kind === "team" && node.add === "agent" && node.id.match(/^team:(project|global|defaults):(.+)$/s) !== null)
        return addTeamAgent(node)
      // Defaults → Agents takes entries (names or patterns), not files.
      if (node?.id.startsWith("group:defaults:agents") === true) return addEntry()
      return addAgent(node)
    }
    if (kind === "base") return addBase()
    if (kind === "skill") return addSkill()
    if (kind === "instruction") return addInstruction()
    // Defaults → Teams takes team entries: a team pattern with a member entry.
    if (kind === "team" && node?.id === "group:defaults:teams") return addTeamEntry()
    if (kind === "team") return addTeam(node)
    if (kind === "section") return addSection(node)
    if (kind === "model") return addModel(node)
    if (kind === "rule") return addRule(node)
    return addMcp()
  }

  // a on an item row appends a section to that item: prompt for the name and
  // body, reuse the manual splitter boundary path in state.addSection, then
  // persist both halves of the boundary contract (the SplitRecord boundary
  // and the CustomizationRecord text) in one mutate.
  async function addSection(node: TreeNode | undefined): Promise<void> {
    if (disposed) return
    if (!node || node.kind !== "item" || node.address === undefined || node.actions?.split !== true) {
      context.ui.toast.show({ variant: "error", message: "This row does not support sections" })
      return
    }
    const raw = await context.ui.dialog.prompt({ title: "Section name", placeholder: "New section" })
    if (disposed) return
    if (raw === undefined) return
    const name = raw.trim()
    if (name.length === 0) {
      context.ui.toast.show({ variant: "error", message: "Section name cannot be empty" })
      return
    }
    const text = await context.ui.dialog.prompt({ title: "Section text", placeholder: "Section content" })
    if (disposed) return
    if (text === undefined) return
    await state.addSection(node, name, text)
  }

  async function currentSnapshot(): Promise<Plus.Snapshot | undefined> {
    try {
      const snapshot = await plus["instructions.snapshot"](undefined, { location: context.location })
      if (disposed) return undefined
      return snapshot
    } catch (error: unknown) {
      if (disposed) return undefined
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
      return undefined
    }
  }

  async function promptName(title: string, description: string, placeholder: string): Promise<string | undefined> {
    const raw = await context.ui.dialog.prompt({ title, description, placeholder })
    if (disposed || raw === undefined) return undefined
    const name = raw.trim()
    if (name.length === 0) {
      context.ui.toast.show({ variant: "error", message: `${title} cannot be empty` })
      return undefined
    }
    return name
  }

  // DESIGN §5: a → name → preset → done. The cursor's Project or Global root
  // decides where; a row outside both asks for the scope last.
  async function addAgent(node?: TreeNode): Promise<void> {
    if (disposed) return
    const id = await promptName("Create agent", "Agent name; use / for nesting (team/lead). .. is not allowed.", "my-agent")
    if (id === undefined) return
    const snapshot = await currentSnapshot()
    if (snapshot === undefined) return
    const preset = await pickAgentPreset(context, snapshot)
    if (disposed) return
    if (preset === undefined) return
    const scope = levelOfRow(node) ?? (await pickScope("Agent scope"))
    if (disposed) return
    if (scope === undefined) return
    try {
      const ref = await plus["agent.create"](
        { scope, id, ...(preset === null ? {} : { preset }) },
        { location: context.location },
      )
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Created agent ${id} at ${ref.path}` })
      context.ui.dialog.clear()
      // Core reloads agents on a debounce, so the row may appear a snapshot
      // later: the state selects it as soon as it is there.
      state.reveal([`root:${scope}`, `group:${scope}:agents`, `group:${scope}:agents:user`], `agent:${scope}:${id}`)
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  async function pickScope(title: string): Promise<"project" | "global" | undefined> {
    return context.ui.dialog.select<"project" | "global">({
      title,
      options: [
        { title: "Project", value: "project", description: "Stored with this project" },
        { title: "Global", value: "global", description: "Stored in your global config" },
      ],
    })
  }

  async function addTeamAgent(node: TreeNode): Promise<void> {
    if (disposed) return
    // Team rows and member rows (add: "agent") take this path. The team name
    // is resolved against known teams in the snapshot, choosing the longest
    // match so colon team names win.
    if (node.add !== "agent") {
      context.ui.toast.show({ variant: "error", message: "This row does not support adding agents" })
      return
    }
    const match = node.id.match(/^team:(project|global|defaults):(.+)$/s)
    if (match === null) {
      context.ui.toast.show({ variant: "error", message: "This row does not support adding agents" })
      return
    }
    const level = match[1] as "project" | "global" | "defaults"
    const teams = (state.snapshot()?.teams ?? [])
      .filter((entry) => entry.level === level)
      .toSorted((left, right) => right.team.length - left.team.length)
    const exactTeam = teams.find((entry) => node.id === `team:${level}:${entry.team}`)
    const memberTeam = teams.find(
      (entry) =>
        entry.team !== exactTeam?.team &&
        entry.agents.some((member) => node.id === `team:${level}:${entry.team}:${member}`),
    )
    if (exactTeam !== undefined && memberTeam !== undefined) {
      context.ui.toast.show({
        variant: "error",
        message: `"${exactTeam.team}" is ambiguous: it matches both a team and a member of team "${memberTeam.team}". Rename one to continue.`,
      })
      return
    }
    const matchEntry = teams.find(
      (entry) =>
        node.id === `team:${level}:${entry.team}` ||
        entry.agents.some((member) => node.id === `team:${level}:${entry.team}:${member}`) ||
        node.id.startsWith(`team:${level}:${entry.team}:`),
    )
    // The row names its team: a team or member row its team, a Defaults team
    // entry or member entry row its team PATTERN (entry rows carry no team in
    // the snapshot, so the row's owner is the only source for them).
    const team = node.owner?.team?.team ?? (matchEntry !== undefined ? matchEntry.team : (match[2] as string))
    const id =
      level === "defaults"
        ? await promptName("Member name or pattern", `A member entry of ${team}; ${wildcards} (e.g. *orchestrator*)`, "*orchestrator*")
        : await promptName("Member name", `A new member of team ${team}; use / for nesting. .. is not allowed.`, "my-agent")
    if (id === undefined) return
    await addMember(level, team, id)
  }

  // Defaults → Teams: a team entry is a team pattern with at least one member
  // entry (the entry record is the member), so both patterns are asked.
  async function addTeamEntry(): Promise<void> {
    if (disposed) return
    const team = await promptName("Team name or pattern", `The teams this entry matches; ${wildcards} (e.g. *review*)`, "*review*")
    if (team === undefined) return
    const id = await promptName("Member name or pattern", `The members it matches in ${team}; ${wildcards} (e.g. *orchestrator*)`, "*orchestrator*")
    if (id === undefined) return
    await addMember("defaults", team, id)
  }

  async function addMember(level: "project" | "global" | "defaults", team: string, id: string): Promise<void> {
    const snapshot = await currentSnapshot()
    if (snapshot === undefined) return
    const preset = await pickAgentPreset(context, snapshot)
    if (disposed) return
    if (preset === undefined) return
    try {
      const ref = await plus["team.addAgent"](
        { level, team, id, ...(preset === null ? {} : { preset }) },
        { location: context.location },
      )
      if (disposed) return
      context.ui.toast.show({
        variant: "success",
        message: level === "defaults" ? `Created Defaults entry ${id} in ${team}` : `Created agent ${id} in team ${team} at ${ref.path}`,
      })
      context.ui.dialog.clear()
      state.reveal([`root:${level}`, `group:${level}:teams`, `team:${level}:${team}`], `team:${level}:${team}:${id}`)
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  async function addBase(): Promise<void> {
    if (disposed) return
    const id = await context.ui.dialog.prompt({ title: "Base id", placeholder: "custom" })
    if (disposed) return
    if (id === undefined) return
    const title = await context.ui.dialog.prompt({ title: "Base title", placeholder: "custom.txt" })
    if (disposed) return
    if (title === undefined) return
    const text = await context.ui.dialog.prompt({ title: "Base text", placeholder: "Base prompt text" })
    if (disposed) return
    if (text === undefined) return
    try {
      await plus["base.create"]({ id, title, text }, { location: context.location })
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Created base ${id}` })
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  async function addSkill(): Promise<void> {
    if (disposed) return
    const mode = await context.ui.dialog.select<"create" | "import">({
      title: "Add skill",
      options: [
        { title: "Create", value: "create", description: "Create a new skill from name and body" },
        { title: "Import", value: "import", description: "Import from a path to SKILL.md" },
      ],
    })
    if (disposed) return
    if (mode === undefined) return
    if (mode === "import") {
      const path = await context.ui.dialog.prompt({ title: "Import skill", placeholder: "path/to/SKILL.md" })
      if (disposed) return
      if (path === undefined) return
      try {
        const ref = await plus["skill.import"]({ path }, { location: context.location })
        if (disposed) return
        context.ui.toast.show({ variant: "success", message: `Imported skill ${ref.id}` })
        await state.refresh()
      } catch (error: unknown) {
        if (disposed) return
        context.ui.toast.show({ variant: "error", message: errorMessage(error) })
      }
      return
    }
    const name = await context.ui.dialog.prompt({ title: "Skill name", placeholder: "my-skill" })
    if (disposed) return
    if (name === undefined) return
    const body = await context.ui.dialog.prompt({ title: "Skill body", placeholder: "Skill instructions" })
    if (disposed) return
    if (body === undefined) return
    try {
      const ref = await plus["skill.create"]({ name, body }, { location: context.location })
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Created skill ${ref.id}` })
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  async function addInstruction(): Promise<void> {
    if (disposed) return
    const name = await context.ui.dialog.prompt({ title: "Instruction name", placeholder: "AGENTS.md" })
    if (disposed) return
    if (name === undefined) return
    const text = await context.ui.dialog.prompt({ title: "Instruction text", placeholder: "Instruction text" })
    if (disposed) return
    if (text === undefined) return
    try {
      const ref = await plus["instruction.create"]({ name, text }, { location: context.location })
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Created instruction ${ref.id}` })
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  async function addMcp(): Promise<void> {
    if (disposed) return
    const name = await context.ui.dialog.prompt({ title: "MCP server name", placeholder: "my-server" })
    if (disposed) return
    if (name === undefined) return
    const raw = await context.ui.dialog.prompt({ title: "MCP config JSON", placeholder: '{"type":"local","command":["npx"]}' })
    if (disposed) return
    if (raw === undefined) return
    let config: Record<string, unknown>
    try {
      const parsed: unknown = JSON.parse(raw)
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("not an object")
      config = parsed as Record<string, unknown>
    } catch {
      context.ui.toast.show({ variant: "error", message: "MCP config must be a JSON object" })
      return
    }
    try {
      await plus["mcp.add"]({ name, config }, { location: context.location })
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Added MCP server ${name}` })
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  // DESIGN §5: a → team name → team preset (or an empty team) → done. The
  // cursor's Project or Global root decides where.
  async function addTeam(node?: TreeNode): Promise<void> {
    if (disposed) return
    const team = await promptName("Team name", "A new team; no slashes or ..", "my-team")
    if (team === undefined) return
    const snapshot = await currentSnapshot()
    if (snapshot === undefined) return
    const preset = await pickTeamPreset(context, snapshot)
    if (disposed) return
    if (preset === undefined) return
    const level = levelOfRow(node) ?? (await pickScope("Team scope"))
    if (disposed) return
    if (level === undefined) return
    try {
      const ref = await plus["team.create"]({ level, team, ...(preset === "" ? {} : { preset }) }, { location: context.location })
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Created team ${ref.team}` })
      state.reveal([`root:${level}`, `group:${level}:teams`], `team:${level}:${ref.team}`)
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  // Defaults → Agents: an entry named by a name or pattern, from a preset.
  async function addEntry(): Promise<void> {
    if (disposed) return
    const name = await promptName("Agent name or pattern", `The agents this entry matches; ${wildcards} (e.g. *orchestrator*)`, "*orchestrator*")
    if (name === undefined) return
    const snapshot = await currentSnapshot()
    if (snapshot === undefined) return
    const preset = await pickAgentPreset(context, snapshot)
    if (disposed || preset === undefined) return
    await run(
      () => plus["entry.create"]({ catalogue: "agents", name, ...(preset === null ? {} : { preset }) }, { location: context.location }),
      `Created Defaults entry ${name}`,
      [["root:defaults", "group:defaults:agents", "group:defaults:agents:user"], `agent:defaults:${name}`],
    )
  }

  // Presets → Agents → User: a user preset from a base preset (or none).
  async function addPreset(): Promise<void> {
    if (disposed) return
    const id = await promptName("Preset name", "A new User agent preset", "my-preset")
    if (id === undefined) return
    const snapshot = await currentSnapshot()
    if (snapshot === undefined) return
    const from = await pickAgentPreset(context, snapshot, { title: "Base preset" })
    if (disposed || from === undefined) return
    await run(
      () => plus["preset.create"]({ kind: "agent", id, ...(from === null ? {} : { from }) }, { location: context.location }),
      `Created preset ${id}`,
      [["root:preset", "group:preset:agents", "group:preset:agents:user"], `agent:preset:${id}`],
    )
  }

  // Presets → Teams → User: a user team preset, its members copied from a team preset.
  async function addTeamPreset(): Promise<void> {
    if (disposed) return
    const id = await promptName("Team preset name", "A new User team preset", "my-team")
    if (id === undefined) return
    const snapshot = await currentSnapshot()
    if (snapshot === undefined) return
    const from = await pickTeamPreset(context, snapshot)
    if (disposed || from === undefined) return
    await run(
      () => plus["preset.create"]({ kind: "team", id, ...(from === "" ? {} : { from }) }, { location: context.location }),
      `Created team preset ${id}`,
      [["root:preset", "group:preset:teams", "group:preset:teams:user"], `team:preset:${id}`],
    )
  }

  async function addPresetMember(team: string): Promise<void> {
    if (disposed) return
    const id = await promptName("Member name", `A new member of team preset ${team}`, "my-member")
    if (id === undefined) return
    const snapshot = await currentSnapshot()
    if (snapshot === undefined) return
    const from = await pickAgentPreset(context, snapshot)
    if (disposed || from === undefined) return
    await run(
      () => plus["preset.addMember"]({ team, id, ...(from === null ? {} : { from }) }, { location: context.location }),
      `Added member preset ${id} to ${team}`,
      [["root:preset", "group:preset:teams", "group:preset:teams:user", `team:preset:${team}`], `team:preset:${team}:${id}`],
    )
  }

  // l: relink the row's owner (an agent, member, team, Defaults entry or User
  // preset) to another preset, or unlink it. The current link is preselected;
  // refusals (a cycle, a protected agent, a read-only preset) toast the
  // server's message.
  async function relink(node: TreeNode | undefined): Promise<void> {
    if (disposed) return
    const owner = node?.owner
    if (node === undefined || !isLinkable(owner)) {
      state.setStatus(`"${node?.label ?? "This row"}" takes no preset link`)
      return
    }
    const snapshot = await currentSnapshot()
    if (snapshot === undefined) return
    const preset = owner.agent === null ? await pickTeamLink(snapshot, owner.link) : await pickAgentPreset(context, snapshot, {
      title: "Link to preset",
      none: "None — unlink",
      ...(owner.link === undefined ? {} : { current: owner.link }),
    })
    if (disposed || preset === undefined) return
    const said = preset === null ? `Unlinked ${node.label}` : `Linked ${node.label} to ${presetName(snapshot, preset)}`
    await run(
      () =>
        plus["link.set"](
          {
            level: owner.level,
            agent: owner.agent,
            ...(owner.team === undefined ? {} : { team: owner.team }),
            ...(owner.catalogue === undefined ? {} : { catalogue: owner.catalogue }),
            preset,
          },
          { location: context.location },
        ),
      // A team relink also relinks the members the team preset has.
      (result) => (result.members === undefined || result.members.length === 0 ? said : `${said}; relinked ${result.members.map((member) => member.agent).join(", ")}`),
    )
  }

  async function pickTeamLink(snapshot: Plus.Snapshot, link: PresetRef | undefined): Promise<PresetRef | null | undefined> {
    const picked = await pickTeamPreset(context, snapshot, {
      title: "Link to team preset",
      none: "None — unlink",
      ...(link?.kind === "team" ? { current: link.id } : {}),
    })
    if (picked === undefined) return undefined
    if (picked === "") return null
    return { kind: "team", id: picked }
  }

  async function run<Result>(
    call: () => Promise<Result>,
    success: string | ((result: Result) => string),
    reveal?: readonly [readonly string[], string],
  ): Promise<void> {
    try {
      const result = await call()
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: typeof success === "string" ? success : success(result) })
      if (reveal !== undefined) state.reveal(reveal[0], reveal[1])
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  function dispose(): void {
    disposed = true
  }

  // The row a group hangs under (the nearest shallower row above it).
  function parentOf(node: TreeNode): TreeNode | undefined {
    const list = state.nodes()
    const index = list.findIndex((entry) => entry.id === node.id)
    return list.slice(0, Math.max(index, 0)).findLast((entry) => entry.depth < node.depth)
  }

  function scopeFromModelsGroup(
    node: TreeNode | undefined,
  ): { level: "project" | "global" | "defaults" | "preset"; agent: string | null; team?: { level: Level; team: string } } | undefined {
    if (node === undefined) return undefined
    const match = node.id.match(/^group:(project|global|defaults|preset):(.*):models$/)
    if (match === null) return undefined
    const level = match[1]
    if (level !== "project" && level !== "global" && level !== "defaults" && level !== "preset") return undefined
    const owner = match[2] ?? ""
    if (owner === "") {
      if (level !== "defaults") return undefined
      return { level, agent: null }
    }
    // Team-member groups carry `/:` between team and member (agent ids forbid
    // `:`, team names allow it), so an owner containing `/:` is a team group
    // and never a nested agent id like `crew/alpha`. Team names never contain
    // `/`, so the member is everything after the first `/` with the leading
    // `:` stripped, even for colon team names and nested member ids.
    const slash = owner.indexOf("/")
    if (slash !== -1 && owner[slash + 1] === ":") {
      const rest = owner.slice(slash + 2)
      const special = rest.startsWith("special:")
      const member = special ? rest.slice("special:".length) : rest
      if (member.length === 0) return undefined
      // Member presets, Teams entries and a team's Special agents keep
      // team-scoped records; a discovered member's are its own (tree.ts
      // lazyTeamMember).
      const parent = special ? undefined : parentOf(node)?.owner
      const scoped = special || parent?.preset !== undefined || parent?.entry !== undefined
      return { level, agent: member, ...(scoped ? { team: { level, team: owner.slice(0, slash) } } : {}) }
    }
    return { level, agent: owner }
  }

  // a on a Models group: provider/model → variant → scope (scope comes from
  // the group when invoked there, otherwise prompt for level then agent).
  // Candidates come from the host model catalog, so only real models can be
  // added. Adding stores an inactive row; activate with space afterwards.
  async function addModel(node?: TreeNode): Promise<void> {
    if (disposed) return
    const scoped = scopeFromModelsGroup(node)
    let level: "project" | "global" | "defaults" | "preset" | undefined = scoped?.level
    let agent: string | null | undefined = scoped?.agent
    const team = scoped?.team
    let catalog: { providerID: string; modelID: string; variant?: string; name: string }[]
    try {
      const output = await plus["catalog.models"](undefined, { location: context.location })
      if (disposed) return
      catalog = [...output.models]
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
      return
    }
    if (catalog.length === 0) {
      context.ui.toast.show({ variant: "error", message: "No models in the host catalog" })
      return
    }
    const providers = [...new Set(catalog.map((entry) => entry.providerID))].toSorted()
    const provider = await context.ui.dialog.select<string>({
      title: "Model provider",
      placeholder: "Select a provider",
      options: providers.map((entry) => ({ title: entry, value: entry })),
    })
    if (disposed) return
    if (provider === undefined) return
    const forProvider = catalog.filter((entry) => entry.providerID === provider)
    const modelIds = [...new Set(forProvider.map((entry) => entry.modelID))].toSorted()
    const modelID = await context.ui.dialog.select<string>({
      title: "Model",
      placeholder: "Select a model",
      options: modelIds.map((id) => {
        const name = forProvider.find((entry) => entry.modelID === id)?.name ?? id
        return { title: name === id ? id : `${name} (${id})`, value: id }
      }),
    })
    if (disposed) return
    if (modelID === undefined) return
    const variants = forProvider.filter((entry) => entry.modelID === modelID).flatMap((entry) => (entry.variant === undefined ? [] : [entry.variant]))
    let variant: string | undefined
    if (variants.length > 0) {
      const picked = await context.ui.dialog.select<string>({
        title: "Variant",
        placeholder: "Select a reasoning variant",
        options: [{ title: "(no variant)", value: "" }, ...variants.toSorted().map((entry) => ({ title: entry, value: entry }))],
      })
      if (disposed) return
      if (picked === undefined) return
      variant = picked === "" ? undefined : picked
    }
    if (level === undefined) {
      const pickedLevel = await context.ui.dialog.select<"project" | "global" | "defaults">({
        title: "Model scope",
        options: [
          { title: "Project", value: "project", description: "Stored with this project" },
          { title: "Global", value: "global", description: "Stored in your global config" },
          { title: "Defaults", value: "defaults", description: "Shared default for every agent" },
        ],
      })
      if (disposed) return
      if (pickedLevel === undefined) return
      level = pickedLevel
    }
    if (agent === undefined) {
      if (level === "defaults") {
        const shared = await context.ui.dialog.select<string>({
          title: "Model agent",
          placeholder: "Shared or per-agent?",
          options: [
            { title: "Shared (every agent)", value: "" },
            { title: "Per-agent…", value: "__agent__" },
          ],
        })
        if (disposed) return
        if (shared === undefined) return
        if (shared === "") {
          agent = null
        } else {
          const raw = await context.ui.dialog.prompt({ title: "Agent id", placeholder: "my-agent" })
          if (disposed) return
          if (raw === undefined) return
          const trimmed = raw.trim()
          if (trimmed.length === 0) {
            context.ui.toast.show({ variant: "error", message: "Agent id cannot be empty" })
            return
          }
          agent = trimmed
        }
      } else {
        const raw = await context.ui.dialog.prompt({ title: "Agent id", placeholder: "my-agent" })
        if (disposed) return
        if (raw === undefined) return
        const trimmed = raw.trim()
        if (trimmed.length === 0) {
          context.ui.toast.show({ variant: "error", message: "Agent id cannot be empty" })
          return
        }
        agent = trimmed
      }
    }
    if (level === undefined || agent === undefined) return
    try {
      const ref = await plus["model.add"](
        { level, agent, ...(team === undefined ? {} : { team }), providerID: provider, modelID, ...(variant === undefined ? {} : { variant }) },
        { location: context.location },
      )
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Added model ${ref.providerID}/${ref.modelID}` })
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  // Level/agent/catalogue come from the tool item row or the perm row itself
  // (their own address); otherwise undefined so the caller prompts. Tool rows
  // address tool:<id>, perm rows address perm:<tool>:<rule>. A shared row
  // inherits its address catalogue so adding from a Teams row writes a Teams
  // rule; an agent-qualified row never gains one (catalogueField semantics),
  // so only the `agent === null` form forwards it.
  function scopeFromToolOrPermRow(
    node: TreeNode | undefined,
  ): { level: "project" | "global" | "defaults"; agent: string | null; catalogue?: "agents" | "teams" } | undefined {
    if (node === undefined || node.kind !== "item" || node.address === undefined) return undefined
    if (!node.address.item.startsWith("tool:") && !node.address.item.startsWith("perm:")) return undefined
    // Rules are not added at preset level yet: the caller prompts for a scope.
    if (node.address.level === "preset") return undefined
    const catalogue = node.address.agent === null ? node.address.catalogue : undefined
    return { level: node.address.level, agent: node.address.agent, ...(catalogue === undefined ? {} : { catalogue }) }
  }

  function toolFromToolOrPermRow(node: TreeNode | undefined): string | undefined {
    if (node === undefined || node.address === undefined) return undefined
    const item = node.address.item
    if (item.startsWith("tool:")) {
      const tool = item.slice("tool:".length)
      return tool.length > 0 ? tool : undefined
    }
    if (item.startsWith("perm:")) return parsePermItemId(item)?.tool
    return undefined
  }

  // a on a tool row: label → patterns → keywords (defaulting through
  // keywordsForPattern) → scope. Patterns are core wildcards, not regex.
  // The parent tool and scope come from the tool row when invoked there,
  // otherwise prompt. Scope prompts mirror addModel.
  async function addRule(node?: TreeNode): Promise<void> {
    if (disposed) return
    const scoped = scopeFromToolOrPermRow(node)
    let level: "project" | "global" | "defaults" | undefined = scoped?.level
    let agent: string | null | undefined = scoped?.agent
    const catalogue = scoped?.catalogue
    let tool = toolFromToolOrPermRow(node)
    if (tool === undefined) {
      const rawTool = await context.ui.dialog.prompt({ title: "Rule tool", placeholder: "shell" })
      if (disposed) return
      if (rawTool === undefined) return
      const trimmed = rawTool.trim()
      if (trimmed.length === 0) {
        context.ui.toast.show({ variant: "error", message: "Rule tool cannot be empty" })
        return
      }
      tool = trimmed
    }
    const rawLabel = await context.ui.dialog.prompt({ title: "Rule label", placeholder: "No force pushes" })
    if (disposed) return
    if (rawLabel === undefined) return
    const label = rawLabel.trim()
    if (label.length === 0) {
      context.ui.toast.show({ variant: "error", message: "Rule label cannot be empty" })
      return
    }
    const rawPatterns = await context.ui.dialog.prompt({ title: "Rule patterns", placeholder: "git push --force *, separated by commas" })
    if (disposed) return
    if (rawPatterns === undefined) return
    const patterns = rawPatterns
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    if (patterns.length === 0) {
      context.ui.toast.show({ variant: "error", message: "Rule patterns cannot be empty" })
      return
    }
    const rawKeywords = await context.ui.dialog.prompt({ title: "Rule keywords", placeholder: "blank for defaults" })
    if (disposed) return
    if (rawKeywords === undefined) return
    const keywords = rawKeywords.trim().length === 0 ? undefined : rawKeywords.split(",").map((entry) => entry.trim()).filter((entry) => entry.length > 0)
    const rawMessage = await context.ui.dialog.prompt({
      title: "Message shown on refusal (optional)",
      placeholder: "force pushes are not allowed here",
    })
    if (disposed) return
    if (rawMessage === undefined) return
    const message = rawMessage.trim()
    if (level === undefined) {
      const pickedLevel = await context.ui.dialog.select<"project" | "global" | "defaults">({
        title: "Rule scope",
        options: [
          { title: "Project", value: "project", description: "Stored with this project" },
          { title: "Global", value: "global", description: "Stored in your global config" },
          { title: "Defaults", value: "defaults", description: "Shared default for every agent" },
        ],
      })
      if (disposed) return
      if (pickedLevel === undefined) return
      level = pickedLevel
    }
    if (level === "defaults" && agent === undefined) {
      const shared = await context.ui.dialog.select<string>({
        title: "Rule agent",
        placeholder: "Shared or per-agent?",
        options: [
          { title: "Shared (every agent)", value: "" },
          { title: "Per-agent…", value: "__agent__" },
        ],
      })
      if (disposed) return
      if (shared === undefined) return
      if (shared === "") {
        agent = null
      }
      if (shared !== "") {
        const raw = await context.ui.dialog.prompt({ title: "Agent id", placeholder: "my-agent" })
        if (disposed) return
        if (raw === undefined) return
        const trimmed = raw.trim()
        if (trimmed.length === 0) {
          context.ui.toast.show({ variant: "error", message: "Agent id cannot be empty" })
          return
        }
        agent = trimmed
      }
    }
    if (agent === undefined) {
      const raw = await context.ui.dialog.prompt({ title: "Agent id", placeholder: "my-agent" })
      if (disposed) return
      if (raw === undefined) return
      const trimmed = raw.trim()
      if (trimmed.length === 0) {
        context.ui.toast.show({ variant: "error", message: "Agent id cannot be empty" })
        return
      }
      agent = trimmed
    }
    if (level === undefined || agent === undefined) return
    try {
      const ref = await plus["rule.add"](
        { level, agent, ...(catalogue === undefined ? {} : { catalogue }), tool, id: slugify(label), label, patterns, ...(keywords === undefined ? {} : { keywords }), ...(message.length === 0 ? {} : { message }) },
        { location: context.location },
      )
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Added rule ${ref.tool}:${ref.id}` })
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  // enter on a perm row: label → patterns → keywords, each prefilled with the
  // row's current values. Tool and rule id reuse the snapshot item's permTool
  // and ruleId; level/agent come from the row's own address, so no tool or
  // scope prompts. Blank keywords derive via keywordsForPattern on the server.
  async function editRule(node: TreeNode): Promise<void> {
    if (disposed) return
    const address = node.address
    if (address === undefined) {
      context.ui.toast.show({ variant: "error", message: "This row cannot be edited" })
      return
    }
    const parsed = parsePermItemId(address.item)
    if (parsed === undefined) {
      context.ui.toast.show({ variant: "error", message: "This row cannot be edited" })
      return
    }
    // The row's own catalogue rides along for the upsert path: editing a
    // curated or mined Teams row materialises its override in the Teams
    // catalogue. A matched record keeps its stored identity server-side, and
    // an agent-qualified row never gains a catalogue.
    const catalogue = address.agent === null ? address.catalogue : undefined
    const snapshot = state.snapshot()
    const current = snapshot?.items.find((entry) => entry.id === address.item)
    const tool = current?.permTool ?? parsed.tool
    const ruleId = current?.ruleId ?? parsed.ruleId
    const rawLabel = await context.ui.dialog.prompt({
      title: "Rule label",
      placeholder: "No force pushes",
      value: current?.title ?? node.label,
    })
    if (disposed) return
    if (rawLabel === undefined) return
    const label = rawLabel.trim()
    if (label.length === 0) {
      context.ui.toast.show({ variant: "error", message: "Rule label cannot be empty" })
      return
    }
    const rawPatterns = await context.ui.dialog.prompt({
      title: "Rule patterns",
      placeholder: "git push --force *, separated by commas",
      value: (current?.patterns ?? []).join(", "),
    })
    if (disposed) return
    if (rawPatterns === undefined) return
    const patterns = rawPatterns
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
    if (patterns.length === 0) {
      context.ui.toast.show({ variant: "error", message: "Rule patterns cannot be empty" })
      return
    }
    const rawKeywords = await context.ui.dialog.prompt({
      title: "Rule keywords",
      placeholder: "blank for defaults",
      value: (current?.keywords ?? []).join(", "),
    })
    if (disposed) return
    if (rawKeywords === undefined) return
    const keywords =
      rawKeywords.trim().length === 0
        ? undefined
        : rawKeywords
            .split(",")
            .map((entry) => entry.trim())
            .filter((entry) => entry.length > 0)
    // The stored message lives on the rule record, not the snapshot item, so
    // a user rule can be edited back to the generic refusal by clearing it.
    const storedRule = snapshot?.records.find(
      (record): record is Plus.SnapshotRuleRecord => record.type === "rule" && record.tool === tool && record.id === ruleId,
    )
    const rawMessage = await context.ui.dialog.prompt({
      title: "Message shown on refusal (optional)",
      placeholder: "force pushes are not allowed here",
      value: storedRule?.message ?? "",
    })
    if (disposed) return
    if (rawMessage === undefined) return
    const message = rawMessage.trim()
    try {
      const ref = await plus["rule.update"](
        { level: address.level, agent: address.agent, ...(catalogue === undefined ? {} : { catalogue }), tool, id: ruleId, label, patterns, ...(keywords === undefined ? {} : { keywords }), message },
        { location: context.location },
      )
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Updated rule ${ref.tool}:${ref.id}` })
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  function slugify(name: string): string {
    const slug = name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
    return slug.length > 0 ? slug : "rule"
  }

  return { addFor, addAgent, addTeamAgent, addBase, addSkill, addInstruction, addMcp, addTeam, addModel, addRule, editRule, relink, dispose }
}

export type InstructionsDialogs = ReturnType<typeof createInstructionsDialogs>

const wildcards = "* and % match any text, case-insensitive"

/**
 * Whether `l` can relink this row: an agent, member or team at Project or
 * Global, a Defaults entry, or a User preset. A Teams entry pattern row takes
 * no link (its member entries do), Native and Plus presets are read-only.
 */
export function isLinkable(owner: RowOwner | undefined): owner is RowOwner {
  if (owner === undefined) return false
  if (owner.level === "defaults" && owner.agent === null) return false
  if (owner.preset !== undefined && owner.preset.origin !== "user") return false
  return true
}

// The Project or Global root a row sits under, read from its id's level segment.
function levelOfRow(node: TreeNode | undefined): "project" | "global" | undefined {
  const level = node?.id.match(/^[a-z]+:(project|global)(?::|$)/)?.[1]
  return level === "project" || level === "global" ? level : undefined
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error !== "object" || error === null) return String(error)
  if (!("message" in error)) return String(error)
  if (typeof error.message !== "string") return String(error)
  return error.message
}
