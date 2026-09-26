import type { Plugin } from "@opencode/plugin/tui"
import { validateAgentId } from "../../agents/files.js"
import { Definition } from "../../rpc.js"
import { pickAgentPreset } from "../preset-picker.js"
import type { AgentEntry, FileScope, Snapshot } from "../../rpc.js"

export function createAgentActions(context: Plugin.Context) {
  const plus = context.client.rpc(Definition)
  let disposed = false

  async function loadSnapshot(): Promise<Snapshot | undefined> {
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

  async function pickEligibleAgent(snapshot: Snapshot, action: "rename" | "delete"): Promise<AgentEntry | undefined> {
    const protectedAgents = new Set(snapshot.protectedAgents)
    if (disposed) return undefined
    if (snapshot.agents.length === 0) {
      context.ui.toast.show({ variant: "error", message: "No agents found" })
      return undefined
    }
    const verb = action === "rename" ? "renamed" : "deleted"
    if (!snapshot.agents.some((entry) => isEligible(entry, protectedAgents))) {
      context.ui.toast.show({
        variant: "error",
        message: `No agents available to ${action}: every agent is builtin or protected`,
      })
      return undefined
    }
    const picked = await context.ui.dialog.select<string>({
      title: action === "rename" ? "Rename agent" : "Delete agent",
      placeholder: action === "rename" ? "Select an agent to rename" : "Select an agent to delete",
      options: snapshot.agents.map((entry) => ({
        title: entry.id,
        value: entry.id,
        description: describeAgent(entry, protectedAgents),
        disabled: !isEligible(entry, protectedAgents),
      })),
    })
    if (disposed) return undefined
    if (picked === undefined) return undefined
    const entry = snapshot.agents.find((candidate) => candidate.id === picked)
    if (!entry) {
      context.ui.toast.show({ variant: "error", message: "Selected agent is no longer available" })
      return undefined
    }
    const blocked = ineligibility(entry, protectedAgents)
    if (blocked === "defaults") {
      context.ui.toast.show({ variant: "error", message: `Agent "${entry.id}" is builtin and cannot be ${verb}` })
      return undefined
    }
    if (blocked === "protected") {
      context.ui.toast.show({ variant: "error", message: `Agent "${entry.id}" is protected and cannot be ${verb}` })
      return undefined
    }
    return entry
  }

  async function createAgent(): Promise<void> {
    if (disposed) return
    const raw = await context.ui.dialog.prompt({
      title: "Create agent",
      description: "Agent id; use / for nesting (team/lead). .. is not allowed.",
      placeholder: "my-agent",
    })
    if (disposed) return
    if (raw === undefined) return
    const validated = validateAgentId(raw)
    if (!validated.ok) {
      context.ui.toast.show({ variant: "error", message: validated.reason })
      return
    }
    const scope = await context.ui.dialog.select<FileScope>({
      title: "Agent scope",
      options: [
        { title: "Project", value: "project", description: "Stored with this project" },
        { title: "Global", value: "global", description: "Stored in your global config" },
      ],
    })
    if (disposed) return
    if (scope === undefined) return
    // DESIGN §5: name → preset → done (the palette also asks the scope).
    const snapshot = await loadSnapshot()
    if (disposed) return
    if (!snapshot) return
    const preset = await pickAgentPreset(context, snapshot)
    if (disposed) return
    if (preset === undefined) return
    try {
      const ref = await plus["agent.create"](
        { scope, id: validated.id, ...(preset === null ? {} : { preset }) },
        { location: context.location },
      )
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Created agent ${validated.id} at ${ref.path}` })
      context.ui.dialog.clear()
      context.ui.router.navigate({ type: "plugin", name: "instructions", data: { agent: validated.id } })
    } catch (error: unknown) {
      if (disposed) return
      if (errorType(error) === "agent.exists") {
        const path = errorPath(error)
        context.ui.toast.show({
          variant: "error",
          message: path ? `Agent ${validated.id} already exists at ${path}` : `Agent ${validated.id} already exists`,
        })
        return
      }
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  async function renameAgent(): Promise<void> {
    if (disposed) return
    const snapshot = await loadSnapshot()
    if (disposed) return
    if (!snapshot) return
    const target = await pickEligibleAgent(snapshot, "rename")
    if (disposed) return
    if (!target) return
    const scope = target.scope
    if (scope !== "project" && scope !== "global") {
      context.ui.toast.show({ variant: "error", message: `Agent "${target.id}" is builtin and cannot be renamed` })
      return
    }
    const raw = await context.ui.dialog.prompt({
      title: `Rename ${target.id}`,
      description: "New agent id; use / for nesting. .. is not allowed.",
      value: target.id,
    })
    if (disposed) return
    if (raw === undefined) return
    const validated = validateAgentId(raw)
    if (!validated.ok) {
      context.ui.toast.show({ variant: "error", message: validated.reason })
      return
    }
    if (validated.id === target.id) {
      context.ui.toast.show({ variant: "info", message: `Agent id is unchanged (${target.id})` })
      return
    }
    try {
      await plus["agent.rename"]({ scope, from: target.id, to: validated.id }, { location: context.location })
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Renamed agent ${target.id} to ${validated.id}` })
    } catch (error: unknown) {
      if (disposed) return
      if (errorType(error) === "agent.exists") {
        const path = errorPath(error)
        context.ui.toast.show({
          variant: "error",
          message: path
            ? `Agent ${validated.id} already exists at ${path}`
            : `Agent ${validated.id} already exists`,
        })
        return
      }
      if (errorType(error) === "agent.missing") {
        context.ui.toast.show({ variant: "error", message: `Agent ${target.id} no longer exists` })
        return
      }
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  async function deleteAgent(): Promise<void> {
    if (disposed) return
    const snapshot = await loadSnapshot()
    if (disposed) return
    if (!snapshot) return
    const target = await pickEligibleAgent(snapshot, "delete")
    if (disposed) return
    if (!target) return
    const scope = target.scope
    if (scope !== "project" && scope !== "global") {
      context.ui.toast.show({ variant: "error", message: `Agent "${target.id}" is builtin and cannot be deleted` })
      return
    }
    const confirmed = await context.ui.dialog.confirm({
      title: `Delete agent ${target.id}?`,
      message: target.path
        ? `Delete ${scope} agent "${target.id}" at ${target.path}? This cannot be undone.`
        : `Delete ${scope} agent "${target.id}"? This cannot be undone.`,
    })
    if (disposed) return
    if (!confirmed) return
    try {
      await plus["agent.delete"]({ scope, id: target.id }, { location: context.location })
      if (disposed) return
      context.ui.toast.show({ variant: "success", message: `Deleted agent ${target.id}` })
    } catch (error: unknown) {
      if (disposed) return
      context.ui.toast.show({ variant: "error", message: errorMessage(error) })
    }
  }

  function dispose(): void {
    disposed = true
  }

  return { createAgent, renameAgent, deleteAgent, dispose }
}

function isEligible(entry: AgentEntry, protectedAgents: ReadonlySet<string>): boolean {
  return ineligibility(entry, protectedAgents) === undefined
}

function ineligibility(entry: AgentEntry, protectedAgents: ReadonlySet<string>): "defaults" | "protected" | undefined {
  if (!entry.fileBacked || entry.scope === "defaults") return "defaults"
  if (protectedAgents.has(entry.id)) return "protected"
  return undefined
}

function describeAgent(entry: AgentEntry, protectedAgents: ReadonlySet<string>): string | undefined {
  const blocked = ineligibility(entry, protectedAgents)
  if (blocked === "defaults") return "Defaults (not file-backed)"
  if (blocked === "protected") return "Protected"
  if (entry.path) return `${entry.scope} · ${entry.path}`
  return entry.scope
}

function errorType(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  if (!("type" in error)) return undefined
  if (typeof error.type !== "string") return undefined
  return error.type
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error !== "object" || error === null) return String(error)
  if (!("message" in error)) return String(error)
  if (typeof error.message !== "string") return String(error)
  return error.message
}

function errorPath(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined
  if (!("data" in error)) return undefined
  const data = error.data
  if (typeof data !== "object" || data === null) return undefined
  if (!("path" in data)) return undefined
  if (typeof data.path !== "string") return undefined
  return data.path
}
