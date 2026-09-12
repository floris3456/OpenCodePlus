import type { AgentEditor } from "@opencode/plugin/effect/agent"
import type { MCPEditor } from "@opencode/plugin/effect/mcp"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration, Transform } from "@opencode/plugin/effect/registration"
import type { SessionContext, SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Option, Schema, Scope } from "effect"
import { applies, effective, type Customization, type Item, type Snapshot } from "./model.js"

export interface Applied {
  readonly registrations: Registration[]
}

export async function apply(ctx: Context, snapshot: Snapshot, customizations: Customization[]): Promise<Applied> {
  const scoped: Snapshot = { ...snapshot, customizations }
  if (scoped.customizations.length === 0) return { registrations: [] }
  const agentIDs = agentIDsFor(scoped)
  const registrations: Registration[] = []
  const prompt = await applyPrompts(ctx, scoped, agentIDs)
  if (prompt) registrations.push(prompt)
  const skills = await applySkills(ctx, scoped, agentIDs)
  if (skills) registrations.push(skills)
  const tools = await applyTools(ctx, scoped, agentIDs)
  if (tools) registrations.push(tools)
  const mcp = await applyMcp(ctx, scoped)
  if (mcp) registrations.push(mcp)
  if (prompt !== undefined || skills !== undefined) await runVoid(ctx.agent.reload())
  if (mcp !== undefined) await runVoid(ctx.mcp.reload())
  return { registrations }
}

async function runVoid(effect: Effect.Effect<void>): Promise<void> {
  await Effect.runPromise(effect)
}

async function runRegistration<Editor>(
  transform: Transform<Editor>,
  callback: (editor: Editor) => void,
): Promise<Registration> {
  const scope = await Effect.runPromise(Scope.make())
  return Effect.runPromise(Effect.provideService(transform(callback), Scope.Scope, scope))
}

async function runHook<Name extends "context">(
  hook: (name: Name, callback: (input: SessionHooks[Name]) => Effect.Effect<void>) => Effect.Effect<Registration, never, Scope.Scope>,
  name: Name,
  callback: (input: SessionHooks[Name]) => Effect.Effect<void>,
): Promise<Registration> {
  const scope = await Effect.runPromise(Scope.make())
  return Effect.runPromise(Effect.provideService(hook(name, callback), Scope.Scope, scope))
}

function agentIDsFor(snapshot: Snapshot): string[] {
  return snapshot.items
    .filter((item) => item.kind === "prompt")
    .map((item) => item.owner)
    .filter((id, index, all) => all.indexOf(id) === index)
}

async function applyPrompts(
  ctx: Context,
  snapshot: Snapshot,
  agentIDs: string[],
): Promise<Registration | undefined> {
  const prompts = snapshot.items.filter((item) => item.kind === "prompt")
  const updates = agentIDs.flatMap((agentID) => promptUpdates(snapshot, prompts, agentID))
  if (updates.length === 0) return undefined
  return runRegistration(ctx.agent.transform, (editor: AgentEditor) => {
    for (const update of updates) {
      editor.update(update.agent, (agent) => {
        agent.system = update.text
      })
    }
  })
}

function promptUpdates(snapshot: Snapshot, prompts: Item[], agentID: string): { agent: string; text: string }[] {
  return prompts.flatMap((item) => {
    if (!applies(item, agentID)) return []
    const resolved = effective(snapshot, item, agentID)
    if (!resolved.customized || resolved.text === item.text) return []
    return [{ agent: item.owner, text: resolved.text }]
  })
}

async function applySkills(
  ctx: Context,
  snapshot: Snapshot,
  agentIDs: string[],
): Promise<Registration | undefined> {
  const skills = snapshot.items.filter((item) => item.kind === "skill")
  const denials = agentIDs.flatMap((agentID) => skillDenials(snapshot, skills, agentID))
  if (denials.length === 0) return undefined
  return runRegistration(ctx.agent.transform, (editor: AgentEditor) => {
    for (const denial of denials) {
      const current = editor.get(denial.agent)
      const denied = current?.permissions.some(
        (rule) => rule.action === "skill" && rule.resource === denial.skill && rule.effect === "deny",
      )
      if (denied) continue
      editor.update(denial.agent, (agent) => {
        agent.permissions.push({ action: "skill", resource: denial.skill, effect: "deny" })
      })
    }
  })
}

function skillDenials(snapshot: Snapshot, skills: Item[], agentID: string): { agent: string; skill: string }[] {
  return skills.flatMap((item) => {
    if (!applies(item, agentID)) return []
    const resolved = effective(snapshot, item, agentID)
    if (resolved.enabled) return []
    return [{ agent: agentID, skill: item.owner }]
  })
}

async function applyTools(
  ctx: Context,
  snapshot: Snapshot,
  agentIDs: string[],
): Promise<Registration | undefined> {
  const tools = snapshot.items.filter((item) => item.kind === "tool")
  const plans = agentIDs.flatMap((agentID) => toolPlans(snapshot, tools, agentID))
  if (plans.length === 0) return undefined
  return runHook(ctx.session.hook, "context", (event) => {
    applyToolPlan(event, plansFor(plans, event.agent))
    return Effect.void
  })
}

interface ToolPlan {
  readonly agent: string
  readonly tool: string
  readonly enabled: boolean
  readonly text: string | undefined
}

function toolPlans(snapshot: Snapshot, tools: Item[], agentID: string): ToolPlan[] {
  return tools.flatMap((item) => {
    if (!applies(item, agentID)) return []
    const resolved = effective(snapshot, item, agentID)
    if (!resolved.customized) return []
    if (resolved.enabled && resolved.text === item.text) return []
    return [{ agent: agentID, tool: item.owner, enabled: resolved.enabled, text: resolved.text }]
  })
}

function plansFor(plans: ToolPlan[], agent: string): ToolPlan[] {
  return plans.filter((plan) => plan.agent === agent)
}

function applyToolPlan(event: SessionContext, plans: ToolPlan[]) {
  for (const plan of plans) {
    if (!plan.enabled) {
      delete event.tools[plan.tool]
      continue
    }
    if (plan.text === undefined) continue
    const tool = event.tools[plan.tool]
    if (tool) tool.description = plan.text
  }
}

async function applyMcp(ctx: Context, snapshot: Snapshot): Promise<Registration | undefined> {
  const servers = snapshot.items.filter((item) => item.kind === "mcp")
  const updates = mcpUpdates(snapshot, servers)
  if (updates.length === 0) return undefined
  return runRegistration(ctx.mcp.transform, (editor: MCPEditor) => {
    for (const update of updates) {
      if (!update.enabled) {
        editor.remove(update.name)
        continue
      }
      if (update.config === undefined) continue
      editor.set(update.name, update.config)
    }
  })
}

interface McpUpdate {
  readonly name: string
  readonly enabled: boolean
  readonly config?: McpConfig
}

type McpConfig = { type: "local"; command: string[] } | { type: "remote"; url: string }

function mcpUpdates(snapshot: Snapshot, servers: Item[]): McpUpdate[] {
  return servers.flatMap((item): McpUpdate[] => {
    const resolved = effective(snapshot, item, "*")
    if (!resolved.customized) return []
    if (!resolved.enabled) return [{ name: item.owner, enabled: false }]
    if (resolved.text === item.text) return []
    const config = parseConfig(resolved.text)
    if (config === undefined) return []
    return [{ name: item.owner, enabled: true, config }]
  })
}

const decodeConfig = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)))

function parseConfig(text: string): McpConfig | undefined {
  const decoded = Option.getOrUndefined(decodeConfig(text))
  if (!decoded) return undefined
  if (decoded.type === "local" && Array.isArray(decoded.command)) return { type: "local", command: decoded.command }
  if (decoded.type === "remote" && typeof decoded.url === "string") return { type: "remote", url: decoded.url }
  return undefined
}
