import type { Plugin } from "@opencode/plugin/tui"
import { Definition } from "../../rpc.js"
import { parsePermItemId } from "../../instructions/model.js"
import type { AddKind, TreeNode } from "../../instructions/tree.js"
import type { InstructionsState } from "./state.js"

export function createInstructionsDialogs(context: Plugin.Context, state: InstructionsState) {
  const plus = context.client.rpc(Definition)
  let disposed = false

  async function addFor(node: TreeNode | undefined): Promise<void> {
    if (disposed) return
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
          { title: "Instruction", value: "instruction" },
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
    if (kind === "agent") {
      // Team rows carry `add: "agent"`; member rows are also kind "team" but
      // carry no `add`, so this keeps member rows on the ordinary agent path.
      // The level prefix is fixed, the entire remainder is the team name so
      // colon team names still route to team.addAgent.
      if (node?.kind === "team" && node.add === "agent" && node.id.match(/^team:(project|global|defaults):(.+)$/) !== null)
        return addTeamAgent(node)
      return addAgent()
    }
    if (kind === "base") return addBase()
    if (kind === "skill") return addSkill()
    if (kind === "instruction") return addInstruction()
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

  async function addAgent(): Promise<void> {
    if (disposed) return
    let templates: { id: string }[] = []
    try {
      const snapshot = await plus["instructions.snapshot"](undefined, { location: context.location })
      if (disposed) return
      templates = snapshot.agents.filter((entry) => entry.scope === "defaults").map((entry) => ({ id: entry.id }))
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
      return
    }
    const template = await context.ui.dialog.select<string>({
      title: "Agent template",
      placeholder: "Select a Defaults template",
      options: [
        { title: "Blank", value: "", description: "Start with an empty prompt" },
        ...templates.map((entry) => ({ title: entry.id, value: entry.id })),
      ],
    })
    if (disposed) return
    if (template === undefined) return
    const raw = await context.ui.dialog.prompt({
      title: "Create agent",
      description: "Agent id; use / for nesting. .. is not allowed.",
      placeholder: "my-agent",
    })
    if (disposed) return
    if (raw === undefined) return
    const id = raw.trim()
    if (id.length === 0) {
      context.ui.toast.show({ variant: "error", message: "Agent id cannot be empty" })
      return
    }
    const scope = await context.ui.dialog.select<"project" | "global">({
      title: "Agent scope",
      options: [
        { title: "Project", value: "project", description: "Stored with this project" },
        { title: "Global", value: "global", description: "Stored in your global config" },
      ],
    })
    if (disposed) return
    if (scope === undefined) return
    const prompt = await context.ui.dialog.prompt({
      title: "Agent prompt",
      description: template ? `Starting from template ${template}` : "Starting prompt",
      placeholder: "You are a helpful assistant",
    })
    if (disposed) return
    if (prompt === undefined) return
    try {
      const ref = await plus["agent.create"](
        {
          scope,
          id,
          ...(template ? { template } : {}),
          prompt,
        },
        { location: context.location },
      )
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Created agent ${id} at ${ref.path}` })
      context.ui.dialog.clear()
      context.ui.router.navigate({ type: "plugin", name: "instructions", data: { agent: id } })
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  async function addTeamAgent(node: TreeNode): Promise<void> {
    if (disposed) return
    // Member rows are kind "team" with no `add`; only team rows (add: "agent")
    // take this path. The team name is the entire remainder so colons survive.
    if (node.add !== "agent") {
      context.ui.toast.show({ variant: "error", message: "This row does not support adding agents" })
      return
    }
    const match = node.id.match(/^team:(project|global|defaults):(.+)$/)
    if (match === null) {
      context.ui.toast.show({ variant: "error", message: "This row does not support adding agents" })
      return
    }
    const level = match[1] as "project" | "global" | "defaults"
    const team = match[2] as string
    let templates: { id: string }[] = []
    try {
      const snapshot = await plus["instructions.snapshot"](undefined, { location: context.location })
      if (disposed) return
      templates = snapshot.agents.filter((entry) => entry.scope === "defaults").map((entry) => ({ id: entry.id }))
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
      return
    }
    const template = await context.ui.dialog.select<string>({
      title: "Agent template",
      placeholder: "Select a Defaults template",
      options: [
        { title: "Blank", value: "", description: "Start with an empty prompt" },
        ...templates.map((entry) => ({ title: entry.id, value: entry.id })),
      ],
    })
    if (disposed) return
    if (template === undefined) return
    const raw = await context.ui.dialog.prompt({
      title: "Create agent",
      description: "Agent id; use / for nesting. .. is not allowed.",
      placeholder: "my-agent",
    })
    if (disposed) return
    if (raw === undefined) return
    const id = raw.trim()
    if (id.length === 0) {
      context.ui.toast.show({ variant: "error", message: "Agent id cannot be empty" })
      return
    }
    const prompt = await context.ui.dialog.prompt({
      title: "Agent prompt",
      description: template ? `Starting from template ${template}` : "Starting prompt",
      placeholder: "You are a helpful assistant",
    })
    if (disposed) return
    if (prompt === undefined) return
    try {
      const ref = await plus["team.addAgent"](
        {
          level,
          team,
          id,
          ...(template ? { template } : {}),
          prompt,
        },
        { location: context.location },
      )
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Created agent ${id} in team ${team} at ${ref.path}` })
      context.ui.dialog.clear()
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

  async function addTeam(_node?: TreeNode): Promise<void> {
    void _node
    if (disposed) return
    let templates: { team: string }[] = []
    try {
      const snapshot = await plus["instructions.snapshot"](undefined, { location: context.location })
      if (disposed) return
      templates = (snapshot.teams ?? []).filter((entry) => entry.level === "defaults").map((entry) => ({ team: entry.team }))
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
      return
    }
    const template = await context.ui.dialog.select<string>({
      title: "Team template",
      placeholder: "Select a Defaults template",
      options: [
        { title: "Blank", value: "", description: "Start with an empty team" },
        ...templates.map((entry) => ({ title: entry.team, value: entry.team })),
      ],
    })
    if (disposed) return
    if (template === undefined) return
    const raw = await context.ui.dialog.prompt({
      title: "Team name",
      description: template ? `Starting from template ${template}` : "Team name; no slashes or ..",
      placeholder: "my-team",
    })
    if (disposed) return
    if (raw === undefined) return
    const team = raw.trim()
    if (team.length === 0) {
      context.ui.toast.show({ variant: "error", message: "Team name cannot be empty" })
      return
    }
    const scope = await context.ui.dialog.select<"project" | "global">({
      title: "Team scope",
      options: [
        { title: "Project", value: "project", description: "Stored with this project" },
        { title: "Global", value: "global", description: "Stored in your global config" },
      ],
    })
    if (disposed) return
    if (scope === undefined) return
    try {
      const ref = await plus["team.create"](
        { level: scope, team, ...(template ? { template } : {}) },
        { location: context.location },
      )
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Created team ${ref.team}` })
      await state.refresh()
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  function dispose(): void {
    disposed = true
  }

  function scopeFromModelsGroup(node: TreeNode | undefined): { level: "project" | "global" | "defaults"; agent: string | null } | undefined {
    if (node === undefined) return undefined
    const match = node.id.match(/^group:(project|global|defaults):(.*):models$/)
    if (match === null) return undefined
    const level = match[1]
    if (level !== "project" && level !== "global" && level !== "defaults") return undefined
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
      const member = owner.slice(slash + 2)
      if (member.length > 0) return { level, agent: member }
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
    let level: "project" | "global" | "defaults" | undefined = scoped?.level
    let agent: string | null | undefined = scoped?.agent
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
        { level, agent, providerID: provider, modelID, ...(variant === undefined ? {} : { variant }) },
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

  // Level/agent come from the tool item row or the perm row itself (their own
  // address); otherwise undefined so the caller prompts. Tool rows address
  // tool:<id>, perm rows address perm:<tool>:<rule>.
  function scopeFromToolOrPermRow(node: TreeNode | undefined): { level: "project" | "global" | "defaults"; agent: string | null } | undefined {
    if (node === undefined || node.kind !== "item" || node.address === undefined) return undefined
    if (!node.address.item.startsWith("tool:") && !node.address.item.startsWith("perm:")) return undefined
    return { level: node.address.level, agent: node.address.agent }
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
        { level, agent, tool, id: slugify(label), label, patterns, ...(keywords === undefined ? {} : { keywords }) },
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
    try {
      const ref = await plus["rule.update"](
        { level: address.level, agent: address.agent, tool, id: ruleId, label, patterns, ...(keywords === undefined ? {} : { keywords }) },
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

  return { addFor, addAgent, addTeamAgent, addBase, addSkill, addInstruction, addMcp, addTeam, addModel, addRule, editRule, dispose }
}

export type InstructionsDialogs = ReturnType<typeof createInstructionsDialogs>

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error !== "object" || error === null) return String(error)
  if (!("message" in error)) return String(error)
  if (typeof error.message !== "string") return String(error)
  return error.message
}
