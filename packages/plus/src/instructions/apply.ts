import type { AgentEditor } from "@opencode/plugin/effect/agent"
import type { MCPEditor } from "@opencode/plugin/effect/mcp"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration, Transform } from "@opencode/plugin/effect/registration"
import type { SessionContext, SessionHooks } from "@opencode/plugin/effect/session"
import type { SkillEditor } from "@opencode/plugin/effect/skill"
import type { ToolEditor } from "@opencode/plugin/effect/tool"
import { Skill } from "@opencode/schema/skill"
import { Deferred, Effect, Scope } from "effect"
import { applies, effective, override, type Customization, type Item, type Snapshot } from "./model.js"

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
      if (!editor.get(update.agent)) continue
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
    if (!resolved.enabled) return []
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
  const addedCopies = copies.filter((copy) => addedIDs.has(copyName(copy.agent, copy.skill)))
  const namespaceDenies =
    addedCopies.length === 0
      ? []
      : agentIDs.map((agent) => ({ agent, resource: copyPattern(), effect: "deny" as const }))
  const rules = [
    ...denials.map((denial) => ({ agent: denial.agent, resource: denial.skill, effect: "deny" as const })),
    ...namespaceDenies,
    ...addedCopies.flatMap((copy) => [
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
  if (!current) return
  // Core evaluates permissions last-match-wins via rulesets.flat().findLast(...).
  // An identical earlier entry is insufficient if a later rule overrode it.
  const last = current.permissions.findLast(
    (entry) => matchPattern("skill", entry.action) && matchPattern(rule.resource, entry.resource),
  )
  if (last?.effect === rule.effect) return
  editor.update(rule.agent, (agent) => {
    agent.permissions.push({ action: "skill", resource: rule.resource, effect: rule.effect })
  })
}

function matchPattern(input: string, pattern: string): boolean {
  if (pattern === "*" || pattern === input) return true
  if (pattern.endsWith("*")) return input.startsWith(pattern.slice(0, -1))
  return false
}

const copyPrefix = "plus/"

export function copyName(agent: string, skill: string): string {
  return `${copyPrefix}${agent}/${skill}`
}

export function copyPattern(): string {
  return `${copyPrefix}*`
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
  const items = snapshot.items.filter((item) => item.kind === "tool")
  const customized = agentIDs.flatMap((agentID) => toolCandidates(snapshot, items, agentID))
  if (customized.length === 0) return undefined
  const inventory = await readTools(ctx)
  const plans = customized.filter((plan) => !isCodeModeTool(inventory, plan.tool))
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

function toolCandidates(snapshot: Snapshot, tools: Item[], agentID: string): ToolPlan[] {
  return tools.flatMap((item) => {
    if (!applies(item, agentID)) return []
    const resolved = effective(snapshot, item, agentID)
    if (resolved.enabled && resolved.text === item.text) return []
    return [{ agent: agentID, tool: item.owner, enabled: resolved.enabled, text: resolved.text }]
  })
}

function plansFor(plans: ToolPlan[], agent: string): ToolPlan[] {
  return plans.filter((plan) => plan.agent === agent)
}

type ToolInventory = ReadonlyMap<string, boolean>

async function readTools(ctx: Context): Promise<ToolInventory> {
  return readTransform(ctx.tool.transform, (editor: ToolEditor) => {
    const inventory = new Map<string, boolean>()
    for (const tool of editor.list()) inventory.set(tool.id, tool.options?.codemode === false)
    return inventory
  })
}

function readTransform<Editor, Value>(transform: Transform<Editor>, read: (editor: Editor) => Value): Promise<Value> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<Value, never>()
        yield* transform((editor) => {
          Deferred.doneUnsafe(deferred, Effect.succeed(read(editor)))
        })
        return yield* Deferred.await(deferred)
      }),
    ),
  )
}

function isCodeModeTool(inventory: ToolInventory, id: string): boolean {
  return inventory.get(id) !== true
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
      const current = editor.get(update.name)
      if (!current) continue
      if (update.enabled) {
        delete current.disabled
        continue
      }
      current.disabled = true
    }
  })
}

interface McpUpdate {
  readonly name: string
  readonly enabled: boolean
}

function mcpUpdates(snapshot: Snapshot, servers: Item[]): McpUpdate[] {
  return servers.flatMap((item): McpUpdate[] => {
    const resolved = override(snapshot, item.id, "*")
    if (!resolved || resolved.state === "inherit") return []
    const enabled = resolved.state === "enabled"
    if (enabled === item.available) return []
    return [{ name: item.owner, enabled }]
  })
}
