import type { AgentEditor } from "@opencode/plugin/effect/agent"
import type { MCPEditor } from "@opencode/plugin/effect/mcp"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration, Transform } from "@opencode/plugin/effect/registration"
import type { SessionContext, SessionHooks } from "@opencode/plugin/effect/session"
import type { SkillEditor } from "@opencode/plugin/effect/skill"
import { Skill } from "@opencode/schema/skill"
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
  registrations.push(...skills.registrations)
  const tools = await applyTools(ctx, scoped, agentIDs)
  if (tools) registrations.push(tools)
  const mcp = await applyMcp(ctx, scoped)
  if (mcp) registrations.push(mcp)
  if (prompt !== undefined || skills.agent) await runVoid(ctx.agent.reload())
  if (skills.skill) await runVoid(ctx.skill.reload())
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

interface SkillApplied {
  readonly registrations: Registration[]
  readonly agent: boolean
  readonly skill: boolean
}

async function applySkills(ctx: Context, snapshot: Snapshot, agentIDs: string[]): Promise<SkillApplied> {
  const skills = snapshot.items.filter((item) => item.kind === "skill")
  const denials = agentIDs.flatMap((agentID) => skillDenials(snapshot, skills, agentID))
  const copies = agentIDs.flatMap((agentID) => skillCopies(snapshot, skills, agentID))
  if (denials.length === 0 && copies.length === 0) return { registrations: [], agent: false, skill: false }
  const added = copies.length === 0 ? undefined : await addSkillCopies(ctx, copies)
  const addedIDs = added?.added ?? new Set<string>()
  const registrations: Registration[] = []
  if (added) registrations.push(added.registration)
  const rules = [
    ...denials.map((denial) => ({ agent: denial.agent, resource: denial.skill, effect: "deny" as const })),
    ...copies
      .filter((copy) => addedIDs.has(copyName(copy.agent, copy.skill)))
      .flatMap((copy) => [
        { agent: copy.agent, resource: copy.skill, effect: "deny" as const },
        { agent: copy.agent, resource: copyName(copy.agent, copy.skill), effect: "allow" as const },
      ]),
  ]
  if (rules.length === 0) return { registrations, agent: false, skill: added !== undefined }
  registrations.unshift(
    await runRegistration(ctx.agent.transform, (editor: AgentEditor) => {
      for (const rule of rules) pushSkillRule(editor, rule)
    }),
  )
  return { registrations, agent: true, skill: added !== undefined }
}

function pushSkillRule(
  editor: AgentEditor,
  rule: { agent: string; resource: string; effect: "deny" | "allow" },
) {
  const current = editor.get(rule.agent)
  const present = current?.permissions.some(
    (entry) => entry.action === "skill" && entry.resource === rule.resource && entry.effect === rule.effect,
  )
  if (present) return
  editor.update(rule.agent, (agent) => {
    agent.permissions.push({ action: "skill", resource: rule.resource, effect: rule.effect })
  })
}

const copyPrefix = "plus/"

export function copyName(agent: string, skill: string): string {
  return `${copyPrefix}${agent}/${skill}`
}

export function isSkillCopy(id: string): boolean {
  return id.startsWith(copyPrefix)
}

interface SkillCopy {
  readonly agent: string
  readonly skill: string
  readonly text: string
}

function skillCopies(snapshot: Snapshot, skills: Item[], agentID: string): SkillCopy[] {
  return skills.flatMap((item) => {
    if (!applies(item, agentID)) return []
    const resolved = effective(snapshot, item, agentID)
    if (!resolved.enabled) return []
    if (resolved.text === item.text) return []
    return [{ agent: agentID, skill: item.owner, text: resolved.text }]
  })
}

async function addSkillCopies(
  ctx: Context,
  copies: SkillCopy[],
): Promise<{ registration: Registration; added: Set<string> } | undefined> {
  const added = new Set<string>()
  const registration = await runRegistration(ctx.skill.transform, (editor: SkillEditor) => {
    for (const copy of copies) {
      const original = editor.get(copy.skill)
      if (!original) continue
      const id = copyName(copy.agent, copy.skill)
      added.add(id)
      editor.add(
        Skill.Info.make({
          id: Skill.ID.make(id),
          name: Skill.Name.make(original.name),
          ...(original.description === undefined ? {} : { description: original.description }),
          ...(original.slash === undefined ? {} : { slash: original.slash }),
          ...(original.autoinvoke === undefined ? {} : { autoinvoke: original.autoinvoke }),
          location: original.location,
          content: copy.text,
        }),
      )
    }
  })
  if (added.size === 0) {
    await Effect.runPromise(registration.dispose)
    return undefined
  }
  return { registration, added }
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
