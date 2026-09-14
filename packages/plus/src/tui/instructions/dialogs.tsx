import type { Plugin } from "@opencode/plugin/tui"
import { Definition } from "../../rpc.js"
import type { AddKind, TreeNode } from "../../instructions/tree.js"
import type { InstructionsState } from "./state.js"

export function createInstructionsDialogs(context: Plugin.Context, state: InstructionsState) {
  const plus = context.client.rpc(Definition)
  let disposed = false

  async function addFor(node: TreeNode | undefined): Promise<void> {
    if (disposed) return
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
    if (kind === "agent") return addAgent()
    if (kind === "base") return addBase()
    if (kind === "skill") return addSkill()
    if (kind === "instruction") return addInstruction()
    if (kind === "section") return addSection(node)
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

  async function addBase(): Promise<void> {
    if (disposed) return
    const id = await context.ui.dialog.prompt({ title: "Base id", placeholder: "gpt" })
    if (disposed) return
    if (id === undefined) return
    const title = await context.ui.dialog.prompt({ title: "Base title", placeholder: "gpt.txt" })
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
    const name = await context.ui.dialog.prompt({ title: "AGENTS.md", placeholder: "AGENTS.md" })
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

  function dispose(): void {
    disposed = true
  }

  return { addFor, addAgent, addBase, addSkill, addInstruction, addMcp, dispose }
}

export type InstructionsDialogs = ReturnType<typeof createInstructionsDialogs>

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error !== "object" || error === null) return String(error)
  if (!("message" in error)) return String(error)
  if (typeof error.message !== "string") return String(error)
  return error.message
}
