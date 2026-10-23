import type { AgentEditor } from "@opencode/plugin/effect/agent"
import { ruleItem } from "./rules.js"
import type { MCPEditor } from "@opencode/plugin/effect/mcp"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration, Transform } from "@opencode/plugin/effect/registration"
import type { SessionContext, SessionHooks } from "@opencode/plugin/effect/session"
import type { SkillEditor } from "@opencode/plugin/effect/skill"
import { Skill } from "@opencode/schema/skill"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Effect, Exit, Scope } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { agentBody } from "./discover.js"
import { builtinBody } from "./teams.js"
import type { BuiltinTeam } from "./builtin-teams.js"
import { parseTeamFields, runSpecialRegistration, runTeamRegistration, type TeamFields } from "./teams-apply.js"
import {
  applies,
  catalogPath,
  chainContentKey,
  clearsRole,
  scopesContentKey,
  fingerprint,
  itemRecordsIndex,
  resolve,
  resolveActiveModel,
  resolutionChain,
  runtimeScope,
  type AgentSource,
  type CustomizationRecord,
  type Item,
  type Level,
  type ModelRecord,
  type PolicyRule,
  type RuleRecord,
  type Scopes,
  type SplitRecord,
  type TeamRef,
} from "./model.js"
import { actionForToolId, curatedRuleMessage, scrubLines } from "./tool-permissions.js"
import { describeProjectChecks, readProjectChecks } from "../teams/project-checks.js"
import {
  allowListMessage,
  enforcementState,
  hook,
  installEnforcement,
  narrowTools,
  permissionTable,
  tableActive,
  tableNarrows,
  type EnforcementDeps,
  type EnforcementState,
  type PermissionTable,
} from "./permission-enforce.js"
import { guidanceItemId, guidancePath, isModelPromptFile, teachingFilePath, teachingItemId, userSystemFile } from "./paths.js"
import { matchesModel, type ModelTarget } from "./model-patterns.js"
import { gateOf } from "./requires.js"
import { editInputSchema, type ParamPlan } from "./parameters.js"
import { booleanControl, controlItemFor, isControl } from "./agent-controls.js"
import { isAttentionRow, type AttentionRow } from "../attention-settings.js"
import { runPublish } from "./publish-runtime.js"
import type { OrderRecord } from "./folders.js"
import { arrangeBySlot, effectiveSystemOrder, slotOfPart, storedSystemOrder } from "./system-order.js"
import {
  checkAndEmitChangeNote,
  createPlanSet,
  isRebuildMoment,
  pinnedPermissions,
  sessionPins,
  type PlanSet,
  type SessionPin,
  type SessionPinManager,
} from "./cache-safe.js"

export interface ApplyAgent {
  readonly id: string
  readonly level: Level
  /** Display/active-badge classification from discover; request fallback only, never the per-request answer. */
  readonly base?: string | undefined
  /** True when the agent defines its own custom system prompt. Base edits never touch such agents. */
  readonly customSystem?: boolean | undefined
  readonly team?: TeamRef | undefined
}

export interface ApplyInput {
  readonly items: readonly Item[]
  readonly agents: readonly ApplyAgent[]
  readonly records: readonly CustomizationRecord[]
  readonly splits: readonly SplitRecord[]
  readonly scopes: Scopes
  readonly models?: readonly ModelRecord[]
  /**
   * User-added permission rules. A rule that denies installs its own
   * `message` onto the core rule, so the model reads why instead of the
   * generic refusal; curated rules ship their message in tool-permissions.ts.
   */
  readonly rules?: readonly RuleRecord[]
  /** Ids of the currently resolved (enabled) team winners; the only absent ids applyModels may create. */
  readonly teamAgents?: readonly string[]
  /**
   * The cached provider catalogue for the per-request base classifier.
   * Absent (standalone callers, older tests) means installSessionPlans lists
   * it once; publishFresh always passes the cached read, so a publish never
   * lists the catalogue.
   */
  readonly catalog?: readonly Model.Info[]
  /** Hook-side permission state kept across publishes (pending approvals, "always" answers). */
  readonly enforcement?: EnforcementState
  /** How enforcement tells a delegated team run (nobody to ask) from a watched session. */
  readonly enforcementDeps?: EnforcementDeps
  /** publishFresh installs controls after team transforms as the final writer. */
  readonly deferAgentControls?: boolean
  /** Stored layout orders: one stored for a System group reorders its agents' system parts (system-order.ts). */
  readonly orders?: readonly OrderRecord[]
}

export interface ToolPlan {
  readonly agent: string
  readonly tool: string
  readonly enabled: boolean
  readonly text: string
  readonly codemode?: boolean
  readonly catalogPath?: string
  readonly pinned?: boolean
  /** The parameters this agent sees edited (Tools › <tool> › Parameters); absent when none are. */
  readonly params?: readonly ParamPlan[]
}

export interface Applied {
  readonly registrations: Registration[]
  readonly tools: readonly ToolPlan[]
  /** Every agent's resolved permission rows, for the team tools and the hooks. */
  readonly permissions: PermissionTable
}

export interface AppliedPart {
  readonly fingerprint: string
  readonly registrations: readonly Registration[]
}

export interface PublishPartsInput {
  readonly applyInput: ApplyInput
  readonly fileAgents?: readonly AgentSource[]
  readonly builtinWinners?: readonly AgentSource[]
  readonly builtins?: readonly BuiltinTeam[]
  readonly teamRoleOverrides?: ReadonlyMap<string, string>
  readonly specialRoleOverrides?: ReadonlyMap<string, string>
}

export interface PublishPartsResult {
  readonly tools: readonly ToolPlan[]
  readonly permissions: PermissionTable
  readonly installedIds: readonly string[]
}

export interface EnforcementPlans {
  readonly active: boolean
  readonly rowsByAgent: readonly (readonly [string, readonly { readonly item: string; readonly on: boolean; readonly text: string }[]])[]
  readonly members: readonly string[]
}

export function enforcementPlans(input: ApplyInput, permissions: PermissionTable): EnforcementPlans {
  const active = tableActive(permissions, input.agents.map((agent) => agent.id))
  if (!active) return { active: false, rowsByAgent: [], members: [] }
  const rowsByAgent = input.agents.map((agent) => [
    agent.id,
    permissions.rows(agent.id).map((r) => ({ item: r.item.id, on: r.on, text: r.text })),
  ] as const)
  const members = [...permissions.teamMembers].sort()
  return { active: true, rowsByAgent, members }
}

export interface TeamFilePlans {
  readonly agents: readonly { id: string; path: string; body: string; fields: TeamFields; override?: string }[]
  readonly special: readonly [string, string][]
}

export async function teamFilePlans(
  fileAgents: readonly AgentSource[],
  overrides?: ReadonlyMap<string, string>,
  specialOverrides?: ReadonlyMap<string, string>,
): Promise<TeamFilePlans> {
  const agents: { id: string; path: string; body: string; fields: TeamFields; override?: string }[] = []
  for (const agent of fileAgents) {
    if (agent.path === undefined) continue
    const text = await fs.readFile(agent.path, "utf8").catch(() => undefined)
    if (text === undefined) continue
    const fields = parseTeamFields(text)
    if (fields.disabled === true) continue
    agents.push({ id: agent.id, path: agent.path, body: agentBody(text), fields, override: overrides?.get(agent.id) })
  }
  const special = specialOverrides ? Array.from(specialOverrides.entries()).sort((a, b) => a[0].localeCompare(b[0])) : []
  return { agents, special }
}

export interface TeamBuiltinPlan {
  readonly id: string
  readonly team: string
  readonly body: string
  readonly fields: TeamFields
  readonly override?: string
}

export function teamBuiltinPlans(
  builtinWinners: readonly AgentSource[],
  builtins: readonly BuiltinTeam[],
  overrides?: ReadonlyMap<string, string>,
): readonly TeamBuiltinPlan[] {
  const list: TeamBuiltinPlan[] = []
  for (const agent of builtinWinners) {
    if (agent.team === undefined) continue
    const body = builtinBody(builtins, agent.team, agent.id)
    if (body === undefined) continue
    const fields: TeamFields = builtins.find((entry) => entry.name === agent.team)?.members.find((member) => member.id === agent.id)?.fields ?? { permissions: [] }
    list.push({ id: agent.id, team: agent.team, body: agentBody(body), fields, override: overrides?.get(agent.id) })
  }
  return list
}

export async function apply(ctx: Context, input: ApplyInput): Promise<Applied> {
  const models = input.models ?? []
  const permissions = permissionTableOf(input)
  const teamRules = input.items.some((item) => item.kind === "perm" && item.policy !== undefined)
  if (
    input.records.length === 0 &&
    models.length === 0 &&
    !teamRules &&
    teamNamespaceDenials(input).length === 0 &&
    input.agents.every((agent) => plain(input.scopes, agent.id)) &&
    systemOrders(input).length === 0
  )
    return { registrations: [], tools: [], permissions }

  const installed: Registration[] = []
  try {
    const rolePlans = roleUpdates(input)
    if (rolePlans.length > 0) {
      const reg = await applyRolesWithUpdates(ctx, rolePlans)
      if (reg !== undefined) installed.push(reg)
    }

    const modelPl = modelUpdates({ agents: input.agents, models, scopes: input.scopes, teamAgents: input.teamAgents })
    if (modelPl.updates.length > 0) {
      const reg = await applyModelsWithUpdates(ctx, modelPl.updates, modelPl.teamAgents)
      if (reg !== undefined) installed.push(reg)
    }

    const skPlans = skillPlans(input)
    const skRegs = await installSkillPlans(ctx, skPlans, input.teamAgents)
    installed.push(...skRegs)

    const sessPlans = sessionPlans(input, permissions)
    const sessRegs = await installSessionPlans(ctx, input, sessPlans, permissions)
    installed.push(...sessRegs)

    const enfPlans = enforcementPlans(input, permissions)
    if (enfPlans.active) {
      const enfRegs = await installEnforcement(
        ctx,
        permissions,
        input.enforcement ?? enforcementState(),
        input.enforcementDeps ?? { headless: async () => false },
      )
      installed.push(...enfRegs)
    }

    const mcPlans = mcpPlans(input)
    if (mcPlans.length > 0) {
      const reg = await applyMcpWithUpdates(ctx, mcPlans)
      if (reg !== undefined) installed.push(reg)
    }

    const ctlPlans = input.deferAgentControls ? [] : controlPlans(input)
    if (ctlPlans.length > 0) {
      const reg = await applyControlsWithPlans(ctx, ctlPlans)
      if (reg !== undefined) installed.push(reg)
    }

    const agentChanged =
      rolePlans.length > 0 ||
      modelPl.updates.length > 0 ||
      skPlans.rules.length > 0 ||
      sessPlans.denials.length > 0 ||
      sessPlans.permDenies.length > 0 ||
      ctlPlans.length > 0
    if (agentChanged) await runVoid(ctx.agent.reload())
    if (skPlans.copies.length > 0) await runVoid(ctx.skill.reload())
    if (mcPlans.length > 0) await runVoid(ctx.mcp.reload())

    return { registrations: [...installed], tools: sessPlans.tools, permissions }
  } catch (error) {
    await disposeRegistrations(installed)
    throw error
  }
}

export async function applyPublishParts(
  ctx: Context,
  state: {
    appliedParts: Map<string, AppliedPart>
    appliedPlans?: Map<string, unknown>
    sessionPins?: SessionPinManager
    currentPlanSet?: PlanSet
  },
  input: PublishPartsInput,
): Promise<PublishPartsResult> {
  const permissions = permissionTableOf(input.applyInput)
  state.appliedPlans ??= new Map()
  const toDispose: Registration[] = []
  let agentReload = false
  let skillReload = false
  let mcpReload = false

  // Compute resolutions and plans once per publish
  const customByAgent = await readCustomSystem(ctx, input.applyInput.agents)

  const roleCand = roleCandidates(input.applyInput)
  const roles = roleCand.filter((c) => !c.noop).map((c) => ({ agent: c.agent, text: c.text }))
  const allRoles = roleCand.map((c) => ({ agent: c.agent, text: c.text }))

  const allCandidates = toolCandidates(input.applyInput, { skipNoop: true })
  const candidates = allCandidates.filter((c) => !c.noop)
  const allNative: ToolPlan[] = allCandidates
    .filter((candidate) => candidate.item.codemode !== true && candidate.item.execute !== true)
    .map(nativePlan)

  const instructionCand = instructionCandidates(input.applyInput)
  const instructions = instructionCand.filter((c) => !c.noop).map((c) => instructionPlanOf(c, ctx.location.directory))
  const allInstructions = instructionCand.map((c) => instructionPlanOf(c, ctx.location.directory))

  // 1. roles
  const rolesFp = JSON.stringify(roles)
  if (rolesFp !== state.appliedParts.get("roles")?.fingerprint) {
    const prev = state.appliedParts.get("roles")?.registrations ?? []
    toDispose.push(...prev)
    const reg = await applyRolesWithUpdates(ctx, roles)
    const installed = reg !== undefined ? [reg] : []
    state.appliedParts.set("roles", { fingerprint: rolesFp, registrations: installed })
    agentReload = true
  }

  // 2. models
  const models = modelUpdates({
    agents: input.applyInput.agents,
    models: input.applyInput.models ?? [],
    scopes: input.applyInput.scopes,
    teamAgents: input.applyInput.teamAgents,
  })
  const modelsFp = JSON.stringify(models)
  if (modelsFp !== state.appliedParts.get("models")?.fingerprint) {
    const prev = state.appliedParts.get("models")?.registrations ?? []
    toDispose.push(...prev)
    const reg = await applyModelsWithUpdates(ctx, models.updates, models.teamAgents)
    const installed = reg !== undefined ? [reg] : []
    state.appliedParts.set("models", { fingerprint: modelsFp, registrations: installed })
    agentReload = true
  }

  // 3. skills
  const skills = skillPlans(input.applyInput)
  const skillsFp = JSON.stringify(skills)
  const prevSkills = state.appliedParts.get("skills")
  if (skillsFp !== prevSkills?.fingerprint) {
    toDispose.push(...(prevSkills?.registrations ?? []))
    const installed = await installSkillPlans(ctx, skills, input.applyInput.teamAgents)
    state.appliedParts.set("skills", { fingerprint: skillsFp, registrations: installed })
    const prevPlan = state.appliedPlans.get("skills") as SkillPlans | undefined
    if (!prevPlan || JSON.stringify(prevPlan.copies) !== JSON.stringify(skills.copies)) {
      skillReload = true
    }
    if (!prevPlan || JSON.stringify(prevPlan.rules) !== JSON.stringify(skills.rules)) {
      agentReload = true
    }
    state.appliedPlans.set("skills", skills)
  }

  // 4. session
  const session = sessionPlans(input.applyInput, permissions, candidates)
  const sessionFp = JSON.stringify(session)
  const prevSession = state.appliedParts.get("session")
  const sessionTools = session.tools

  state.currentPlanSet = createPlanSet({
    roles: new Map(allRoles.map((r) => [r.agent, r.text])),
    base: session.base,
    native: allNative,
    instructions: allInstructions,
    scrubByAgent: new Map(session.scrubByAgent),
    needsNarrowing: session.needsNarrowing,
    permissions,
    customByAgent,
    orders: new Map(session.orders),
    unseenRoles: new Set(
      [...(input.teamRoleOverrides?.keys() ?? []), ...(input.specialRoleOverrides?.keys() ?? [])].filter((agent) => !allRoles.some((role) => role.agent === agent)),
    ),
  })

  if (sessionFp !== prevSession?.fingerprint) {
    toDispose.push(...(prevSession?.registrations ?? []))
    const installed = await installSessionPlans(ctx, input.applyInput, session, permissions, state, {
      instructions,
      customByAgent,
    })
    state.appliedParts.set("session", { fingerprint: sessionFp, registrations: installed })
    const prevPlan = state.appliedPlans.get("session") as SessionPlans | undefined
    if (
      !prevPlan ||
      JSON.stringify(prevPlan.denials) !== JSON.stringify(session.denials) ||
      JSON.stringify(prevPlan.permDenies) !== JSON.stringify(session.permDenies)
    ) {
      agentReload = true
    }
    state.appliedPlans.set("session", session)
  }

  // 5. enforcement
  const enforcement = enforcementPlans(input.applyInput, permissions)
  const enforcementFp = JSON.stringify(enforcement)
  if (enforcementFp !== state.appliedParts.get("enforcement")?.fingerprint) {
    toDispose.push(...(state.appliedParts.get("enforcement")?.registrations ?? []))
    const installed = enforcement.active
      ? await installEnforcement(
          ctx,
          permissions,
          input.applyInput.enforcement ?? enforcementState(),
          input.applyInput.enforcementDeps ?? { headless: async () => false },
        )
      : []
    state.appliedParts.set("enforcement", { fingerprint: enforcementFp, registrations: installed })
  }

  // 6. mcp
  const mcp = mcpPlans(input.applyInput)
  const mcpFp = JSON.stringify(mcp)
  if (mcpFp !== state.appliedParts.get("mcp")?.fingerprint) {
    toDispose.push(...(state.appliedParts.get("mcp")?.registrations ?? []))
    const reg = await applyMcpWithUpdates(ctx, mcp)
    const installed = reg !== undefined ? [reg] : []
    state.appliedParts.set("mcp", { fingerprint: mcpFp, registrations: installed })
    mcpReload = true
  }

  // 7. controls
  const controls = controlPlans(input.applyInput)
  const controlsFp = JSON.stringify(controls)
  if (controlsFp !== state.appliedParts.get("controls")?.fingerprint) {
    toDispose.push(...(state.appliedParts.get("controls")?.registrations ?? []))
    const reg = await applyControlsWithPlans(ctx, controls)
    const installed = reg !== undefined ? [reg] : []
    state.appliedParts.set("controls", { fingerprint: controlsFp, registrations: installed })
    agentReload = true
  }

  // 8. teamFiles
  const filePlans = await teamFilePlans(input.fileAgents ?? [], input.teamRoleOverrides, input.specialRoleOverrides)
  const fileFp = JSON.stringify(filePlans)
  const installedFileIds: string[] = filePlans.agents.map((a: { id: string }) => a.id)
  if (fileFp !== state.appliedParts.get("teamFiles")?.fingerprint) {
    toDispose.push(...(state.appliedParts.get("teamFiles")?.registrations ?? []))
    const installed: Registration[] = []
    for (const a of filePlans.agents) {
      installed.push(await runTeamRegistration(ctx, a.id, a.body, a.fields, a.override))
    }
    for (const [id, text] of filePlans.special) {
      installed.push(await runSpecialRegistration(ctx, id, text))
      installedFileIds.push(id)
    }
    state.appliedParts.set("teamFiles", { fingerprint: fileFp, registrations: installed })
    agentReload = true
  }

  // 9. teamBuiltin
  const builtinPlans = teamBuiltinPlans(input.builtinWinners ?? [], input.builtins ?? [], input.teamRoleOverrides)
  const builtinFp = JSON.stringify(builtinPlans)
  const installedBuiltinIds: string[] = builtinPlans.map((a: { id: string }) => a.id)
  if (builtinFp !== state.appliedParts.get("teamBuiltin")?.fingerprint) {
    toDispose.push(...(state.appliedParts.get("teamBuiltin")?.registrations ?? []))
    const installed: Registration[] = []
    for (const a of builtinPlans) {
      installed.push(await runTeamRegistration(ctx, a.id, a.body, a.fields, a.override))
    }
    state.appliedParts.set("teamBuiltin", { fingerprint: builtinFp, registrations: installed })
    agentReload = true
  }

  // Dispose superseded registrations (install-before-dispose order)
  for (const reg of toDispose) {
    await runPublish(reg.dispose).catch(() => {})
  }

  // Reload affected subsystems
  if (agentReload) await runVoid(ctx.agent.reload())
  if (skillReload) await runVoid(ctx.skill.reload())
  if (mcpReload) await runVoid(ctx.mcp.reload())

  const installedIds = [...new Set([...installedFileIds, ...installedBuiltinIds])]
  return {
    tools: sessionTools,
    permissions,
    installedIds,
  }
}

export function controlPlans(input: ApplyInput): readonly { agent: string; rows: readonly { id: string; text: string; enabled: boolean }[] }[] {
  return input.agents.flatMap((agent) => {
    // Notification rows change no agent field: Plus reads them itself (attentionRowsOf).
    const rows = input.items.filter((item) => isControl(item.id) && !isAttentionRow(item.id) && applies(item, agent.id))
    const unique = [...new Set(rows.map((item) => item.id))].flatMap((id) => {
      const item = controlItemFor(rows, { agent: agent.id, item: id, team: agent.team })
      if (item === undefined) return []
      const value = resolvedFor(item, agent, input, gateFor(input, agent))
      // A false upstream state (e.g. a disabled member file) is a ceiling.
      if (id === "setting:enabled" && (!item.enabled || !value.enabled)) return [{ id, text: "", enabled: false }]
      // Text controls assemble like every other text kind: the description and
      // the compaction instructions take sections, so the assembled body (with
      // section edits and exclusions applied) is what apply installs.
      if (booleanControl(id) ? value.enabled === item.enabled && value.from.kind === "upstream" : value.assembled === item.text && value.textFrom.kind === "upstream") return []
      return [{ id, text: value.assembled, enabled: value.enabled }]
    })
    return unique.length === 0 ? [] : [{ agent: agent.id, rows: unique }]
  })
}

/** Every agent's notification rows resolved down its chain; only rows set somewhere are present. */
export function attentionRowsOf(input: ApplyInput): ReadonlyMap<string, Readonly<Partial<Record<AttentionRow, string>>>> {
  return new Map(
    input.agents.map((agent) => {
      const rows = input.items.filter((item) => isAttentionRow(item.id) && applies(item, agent.id))
      const texts = [...new Set(rows.map((item) => item.id))].flatMap((id) => {
        const item = controlItemFor(rows, { agent: agent.id, item: id, team: agent.team })
        if (item === undefined) return []
        const text = resolvedFor(item, agent, input).assembled
        return text === "" ? [] : [[id, text] as const]
      })
      return [agent.id, Object.fromEntries(texts)] as const
    }),
  )
}

export async function applyControlsWithPlans(
  ctx: Context,
  plans: readonly { agent: string; rows: readonly { id: string; text: string; enabled: boolean }[] }[],
): Promise<Registration | undefined> {
  if (plans.length === 0) return undefined
  return runRegistration(ctx.agent.transform, (editor: AgentEditor) => {
    for (const plan of plans) {
      if (plan.rows.some((row) => row.id === "setting:enabled" && !row.enabled)) {
        editor.remove(plan.agent)
        continue
      }
      // Config-disabled agents are absent from the upstream registry. Never
      // manufacture an Agent.Info.default just to apply retained settings.
      if (!editor.get(plan.agent)) continue
      editor.update(plan.agent, (agent) => {
        const compaction = { ...agent.compaction }
        for (const row of plan.rows) {
          if (row.id === "setting:mode") agent.mode = row.text as Agent.Info["mode"]
          if (row.id === "setting:description") agent.description = row.text
          if (row.id === "setting:hidden") agent.hidden = row.enabled
          if (row.id === "setting:color") {
            if (row.text === "") delete agent.color
            else agent.color = row.text
          }
          if (row.id === "setting:steps") {
            if (row.text === "") delete agent.steps
            else agent.steps = Number(row.text) as Agent.Info["steps"]
          }
          if (row.id === "compaction:strategy") compaction.strategy = row.text as Agent.Compaction["strategy"]
          if (row.id === "compaction:model") {
            if (row.text === "") delete compaction.model
            else compaction.model = Model.Ref.parse(row.text)
          }
          if (row.id === "compaction:instructions") compaction.system = row.text
        }
        if (plan.rows.some((row) => row.id.startsWith("compaction:"))) agent.compaction = compaction
      })
    }
  })
}

/** Final Plus agent writer: deletions happen after all possible team upserts. */
export async function applyAgentControls(ctx: Context, input: ApplyInput): Promise<Registration | undefined> {
  const plans = controlPlans(input)
  return applyControlsWithPlans(ctx, plans)
}

const enforcedPermKinds = new Set(["input", "value", "param", "limit", "approval", "env", "team"])

// Every agent's permission rows, resolved lazily. Rows nobody customized
// resolve to their shipped state without walking the records — for an agent
// no preset, entry or off fallback can change (`plain`). The team tools and
// the hooks read this table.
export function permissionTableOf(input: ApplyInput): PermissionTable {
  const byId = new Map(input.agents.map((agent) => [agent.id, agent] as const))
  const permRows = input.items.filter((item) => item.kind === "perm" && item.permKind !== undefined && enforcedPermKinds.has(item.permKind))
  const recordsIndex = itemRecordsIndex(input.records)

  const agentKeyCache = new Map<string, string>()
  const cacheKey = (agentId: string): string => {
    const cached = agentKeyCache.get(agentId)
    if (cached !== undefined) return cached

    const agent = byId.get(agentId)
    const address = {
      level: agent?.level ?? ("project" as const),
      agent: agentId,
      item: "",
      section: null,
      ...(agent?.team !== undefined ? { team: agent.team } : {}),
    }
    const chain = resolutionChain(address, input.scopes)
    const chainKey = chainContentKey(chain)

    const itemsForAgent = permRows.flatMap((item) => {
      const resolved = runtimeRule(item, agent ?? { id: agentId, level: "project" }, input)
      return resolved === undefined || !applies(resolved, agentId) ? [] : [resolved]
    })
    const itemsDigest = itemsForAgent
      .map((item) => {
        const recHash = recordsIndex.get(item.id)?.hash ?? ""
        return JSON.stringify([item.id, item.fingerprint, item.enabled, item.message, item.keywords, recHash])
      })
      .join(";")

    // The scopes content: a row resolved through a preset reads teammates'
    // links and Defaults entries (team_delegate's to.<member> rows do).
    const key = `${agentId}:${agent?.team ? agent.team.level + "/" + agent.team.team : ""}:${chainKey}:${scopesContentKey(input.scopes)}:${fingerprint(itemsDigest)}`
    agentKeyCache.set(agentId, key)
    return key
  }

  return permissionTable({
    items: input.items,
    item: (item, agentId) => runtimeRule(item, byId.get(agentId) ?? { id: agentId, level: "project" }, input),
    teamMembers: input.teamAgents ?? [],
    resolve: (item, agentId) => {
      const agent = byId.get(agentId)
      if (agent === undefined || (!touched(input).has(item.id) && plain(input.scopes, agentId)))
        return { enabled: item.enabled, text: item.text }
      const resolved = resolvedFor(item, agent, input)
      return { enabled: resolved.enabled, text: resolved.text }
    },
    // The description applyAgentControls installs on the agent: team_delegate
    // shows it beside each member a delegator may choose.
    describe: (agentId) => {
      const agent = byId.get(agentId)
      if (agent === undefined) return undefined
      const rows = input.items.filter((item) => item.id === "setting:description" && applies(item, agentId))
      const item = controlItemFor(rows, { agent: agentId, item: "setting:description", team: agent.team })
      return item === undefined ? undefined : resolvedFor(item, agent, input).text
    },
    cacheKey,
  })
}

const touchedCache = new WeakMap<ApplyInput, ReadonlySet<string>>()

// Item ids some customization addresses: every other item resolves to its
// shipped state at every address, so it needs no chain walk.
function touched(input: ApplyInput): ReadonlySet<string> {
  const cached = touchedCache.get(input)
  if (cached !== undefined) return cached
  const ids = new Set(input.records.map((record) => record.item))
  touchedCache.set(input, ids)
  return ids
}

// An agent whose uncustomized rows all resolve to their upstream value: no
// Defaults entry exists, nothing links it to a preset, and its fallback is
// upstream (a native agent, or a context from before presets). Any other
// agent's rows fall back to off or follow a preset (DESIGN §3.3), so they
// install even when no record exists.
function plain(scopes: Scopes, agent: string): boolean {
  if ((scopes.entries ?? []).length > 0) return false
  if ((scopes.links ?? []).some((link) => link.agent === agent)) return false
  return scopes.native === undefined || scopes.native.has(agent)
}

export function modelUpdates(input: { agents: readonly ApplyAgent[]; models: readonly ModelRecord[]; scopes: Scopes; teamAgents?: readonly string[] }) {
  const updates = input.agents.flatMap((agent) => {
    const runtime = runtimeScope(agent, input.scopes)
    const winner = resolveActiveModel({
      models: input.models,
      scopes: runtime.scopes,
      level: runtime.level,
      agent: agent.id,
      ...(agent.team !== undefined ? { team: agent.team } : {}),
    })
    if (winner === undefined) return []
    if (winner.source === "upstream") return []
    return [{ agent: agent.id, providerID: winner.providerID, modelID: winner.modelID, ...(winner.variant === undefined ? {} : { variant: winner.variant }) }]
  })
  const teamAgents = [...(input.teamAgents ?? [])].sort()
  return { updates, teamAgents }
}

export async function applyModelsWithUpdates(
  ctx: Context,
  updates: readonly { agent: string; providerID: string; modelID: string; variant?: string }[],
  teamAgents: readonly string[],
): Promise<Registration | undefined> {
  if (updates.length === 0) return undefined
  const team = new Set(teamAgents)
  return runRegistration(ctx.agent.transform, (editor: AgentEditor) => {
    for (const update of updates) {
      if (!editor.get(update.agent) && !team.has(update.agent)) continue
      editor.update(update.agent, (agent) => {
        agent.model = Model.Ref.make({
          providerID: Provider.ID.make(update.providerID),
          id: Model.ID.make(update.modelID),
          ...(update.variant === undefined ? {} : { variant: Model.VariantID.make(update.variant) }),
        })
      })
    }
  })
}

// Per-agent model selection: resolve each effective agent's active model down
// the existing chain and set the host agent's model in one transform. No
// active model means Plus installs nothing for that agent, so an unchanged
// save stays a no-op.
export async function applyModels(
  ctx: Context,
  input: { agents: readonly ApplyAgent[]; models: readonly ModelRecord[]; scopes: Scopes; teamAgents?: readonly string[] },
): Promise<Registration | undefined> {
  const plans = modelUpdates(input)
  return applyModelsWithUpdates(ctx, plans.updates, plans.teamAgents)
}

async function disposeRegistrations(registrations: readonly Registration[]): Promise<void> {
  const reversed = registrations.slice().reverse()
  for (const registration of reversed) {
    await runPublish(registration.dispose).catch(() => {})
  }
}

async function runVoid(effect: Effect.Effect<void>): Promise<void> {
  await runPublish(effect)
}

export async function runRegistration<Editor>(
  transform: Transform<Editor>,
  callback: (editor: Editor) => void,
): Promise<Registration> {
  return runPublish(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      return yield* Effect.suspend(() => transform(callback)).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause)).pipe(Effect.ignoreCause)),
      )
    }),
  )
}

async function runHook<Name extends "context" | "catalog" | "compaction" | "tools">(
  hook: (name: Name, callback: (input: SessionHooks[Name]) => Effect.Effect<void>) => Effect.Effect<Registration, never, Scope.Scope>,
  name: Name,
  callback: (input: SessionHooks[Name]) => Effect.Effect<void>,
): Promise<Registration> {
  return runPublish(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      return yield* Effect.suspend(() => hook(name, callback)).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause)).pipe(Effect.ignoreCause)),
      )
    }),
  )
}

interface ChainArgs {
  readonly rules?: readonly RuleRecord[]
  readonly records: readonly CustomizationRecord[]
  readonly splits: readonly SplitRecord[]
  readonly scopes: Scopes
}

// A Defaults-scope agent (every host built-in: build, plan, explore, …) owns a
// visible row under Project, Global AND Defaults, and ops.ts writes at the row
// the human pressed. Every item kind — tools, skills, base, system, perm — and
// the active model (applyModels) resolve through runtimeScope, the chain the
// tree's Project row shows, so what is displayed is what is enforced: a
// Defaults entry, a Project or Global row all reach the runtime answer.
export function resolvedFor(item: Item, agent: ApplyAgent, args: ChainArgs, gate?: (ids: readonly string[]) => boolean) {
  const runtime = runtimeScope(agent, args.scopes)
  return resolve({
    ...(gate === undefined ? {} : { gate }),
    upstream: runtimeRule(item, agent, args) ?? item,
    records: args.records,
    splits: args.splits,
    scopes: runtime.scopes,
    address: {
      level: runtime.level,
      agent: agent.id,
      item: item.id,
      section: null,
      ...(agent.team !== undefined ? { team: agent.team } : {}),
    },
  })
}

function runtimeRule(item: Item, agent: ApplyAgent, args: ChainArgs): Item | undefined {
  const runtime = runtimeScope(agent, args.scopes)
  return ruleItem(item, args.rules ?? [], runtime.scopes, {
    level: runtime.level, agent: agent.id, item: item.id, section: null,
    ...(agent.team === undefined ? {} : { team: agent.team }),
  })
}

function isNoop(item: Item, resolved: { assembled: string; enabled: boolean }): boolean {
  // assemble normalizes whitespace (collapses blank runs, trims), so an
  // unchanged resolution never round-trips byte-identically when the raw
  // upstream carries a trailing newline or extra blank lines. Compare through
  // the same normalization (like skillCustomized does) so an unrelated save
  // installs no plan for an untouched template.
  return normalizeLossless(resolved.assembled) === normalizeLossless(item.text) && resolved.enabled === item.enabled
}

// A skill installs a copy, denial or rule only when its resolved view for
// that agent differs from upstream: changed text, changed enablement, or a
// changed assembled body (section exclusions). Comparing the assembled body
// alone cannot decide this, because assemble also normalizes whitespace —
// so an unchanged resolution with lossy text must install nothing, while a
// section exclusion that changes the assembled body beyond normalization
// still installs its private copy.
function skillCustomized(item: Item, resolved: { text: string; assembled: string; enabled: boolean }): boolean {
  if (resolved.text !== item.text) return true
  if (resolved.enabled !== item.enabled) return true
  if (normalizeLossless(resolved.assembled) !== normalizeLossless(item.text)) return true
  return false
}

// The assemble normalization applied to text that carries no sections and no
// exclusions: whitespace collapsing plus trim. When the assembled body equals
// this, the difference from raw upstream is formatting loss, not a user
// customization.
function normalizeLossless(text: string): string {
  return text.replace(/\n(?:[ \t]*\n)+/g, "\n\n").trim()
}

function parseId(id: string, prefix: string): string {
  if (id.startsWith(prefix)) return id.slice(prefix.length)
  return id
}

// The rows an agent has, resolved for it, as the `requires` markers ask
// (requires.ts): a section depending on a row the agent has off, or does not
// have, is left out of what it reads. One answer per row id per agent.
export function rowGate(input: ApplyInput, agent: ApplyAgent): (ids: readonly string[]) => boolean {
  const byId = new Map<string, Item[]>()
  for (const item of input.items) byId.set(item.id, [...(byId.get(item.id) ?? []), item])
  const answers = new Map<string, boolean | undefined>()
  const isOn = (id: string): boolean | undefined => {
    if (answers.has(id)) return answers.get(id)
    const item = (byId.get(id) ?? []).find((candidate) => applies(candidate, agent.id))
    const on = item === undefined ? undefined : resolvedFor(item, agent, input).enabled
    answers.set(id, on)
    return on
  }
  return gateOf(isOn)
}

// The gate for one agent, built once per apply input: gating every text kind
// (B12) asks for it on each plan, and `rowGate` resolves every row it names.
const gateCache = new WeakMap<ApplyInput, Map<string, (ids: readonly string[]) => boolean>>()

function gateFor(input: ApplyInput, agent: ApplyAgent): (ids: readonly string[]) => boolean {
  let perAgent = gateCache.get(input)
  if (perAgent === undefined) {
    perAgent = new Map()
    gateCache.set(input, perAgent)
  }
  const hit = perAgent.get(agent.id)
  if (hit !== undefined) return hit
  const gate = rowGate(input, agent)
  perAgent.set(agent.id, gate)
  return gate
}

interface RoleCandidate {
  readonly agent: string
  readonly text: string
  readonly noop: boolean
}

function roleCandidates(input: ApplyInput): RoleCandidate[] {
  return input.agents.flatMap((agent) => {
    const gate = gateFor(input, agent)
    return input.items.flatMap((item) => {
      if (item.kind !== "system") return []
      if (item.id !== "system:role") return []
      if (!applies(item, agent.id)) return []
      // Resolved for this agent with its conditions applied: sections it
      // does not meet are out and no marker line is left (requires.ts).
      const resolved = resolvedFor(item, agent, input, gate)
      const text = resolved.assembled
      // A disabled role never clears the agent system text.
      if (!resolved.enabled) return []
      // A level that empties Role/persona clears the agent's own system text (its config or
      // agent file), so the request sends the base prompt, as the System list says. Sections
      // left out by their conditions only empty the assembled text: those keep the agent's text.
      if (clearsRole(item, resolved)) return [{ agent: agent.id, text: "", noop: isNoop(item, resolved) }]
      if (text.trim().length === 0) return []
      return [{ agent: agent.id, text, noop: isNoop(item, resolved) }]
    })
  })
}

export function roleUpdates(
  input: ApplyInput,
  options?: { readonly skipNoop?: boolean },
): { agent: string; text: string }[] {
  const candidates = roleCandidates(input)
  if (options?.skipNoop === true) {
    return candidates.map((c) => ({ agent: c.agent, text: c.text }))
  }
  return candidates.filter((c) => !c.noop).map((c) => ({ agent: c.agent, text: c.text }))
}

export async function applyRolesWithUpdates(ctx: Context, updates: readonly { agent: string; text: string }[]): Promise<Registration | undefined> {
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

export interface SkillPlans {
  readonly denials: readonly { agent: string; skill: string }[]
  readonly copies: readonly { agent: string; skill: string; text: string }[]
  readonly rules: readonly { agent: string; action: "skill"; resource: string; effect: PolicyRule["effect"] }[]
}

export function skillPlans(input: ApplyInput): SkillPlans {
  const denials = input.agents.flatMap((agent) =>
    input.items.flatMap((item) => {
      if (item.kind !== "skill") return []
      if (!applies(item, agent.id)) return []
      const resolved = resolvedFor(item, agent, input, gateFor(input, agent))
      if (!skillCustomized(item, resolved)) return []
      if (resolved.enabled) return []
      return [{ agent: agent.id, skill: parseId(item.id, "skill:") }]
    }),
  )
  const copies = input.agents.flatMap((agent) =>
    input.items.flatMap((item) => {
      if (item.kind !== "skill") return []
      if (!applies(item, agent.id)) return []
      const resolved = resolvedFor(item, agent, input, gateFor(input, agent))
      if (!skillCustomized(item, resolved)) return []
      if (!resolved.enabled) return []
      if (resolved.assembled === item.text) return []
      return [{ agent: agent.id, skill: parseId(item.id, "skill:"), text: resolved.assembled }]
    }),
  )
  const addedCopies = copies
  const namespaceDenies =
    addedCopies.length === 0
      ? []
      : input.agents.map((agent) => ({ agent: agent.id, action: "skill" as const, resource: copyPattern(), effect: "deny" as const }))
  const rules = [
    ...denials.map((denial) => ({ agent: denial.agent, action: "skill" as const, resource: denial.skill, effect: "deny" as const })),
    ...namespaceDenies,
    ...addedCopies.flatMap((copy) => [
      { agent: copy.agent, action: "skill" as const, resource: copy.skill, effect: "deny" as const },
      { agent: copy.agent, action: "skill" as const, resource: copyName(copy.agent, copy.skill), effect: "allow" as const },
    ]),
  ]
  return { denials, copies, rules }
}

export async function installSkillPlans(
  ctx: Context,
  plans: SkillPlans,
  teamAgents?: readonly string[],
): Promise<Registration[]> {
  const installed: Registration[] = []
  try {
    if (plans.copies.length > 0) {
      const added = await addSkillCopies(ctx, [...plans.copies])
      if (added !== undefined) installed.push(added.registration)
    }
    if (plans.rules.length > 0) {
      const team = new Set(teamAgents ?? [])
      const agentRegistration = await runRegistration(ctx.agent.transform, (editor: AgentEditor) => {
        for (const rule of plans.rules) pushRule(editor, rule, team)
      })
      installed.push(agentRegistration)
    }
    return installed
  } catch (error) {
    await disposeRegistrations(installed)
    throw error
  }
}

function pushRule(
  editor: AgentEditor,
  rule: { agent: string; action: string; resource: string; effect: PolicyRule["effect"]; message?: string },
  team: ReadonlySet<string>,
) {
  // Core evaluates permissions last-match-wins, so appending is always
  // sufficient and always correct, whereas deciding a rule is redundant
  // requires reimplementing core's wildcard semantics and still cannot
  // reason about concrete resources covered by a wildcard.
  // Team-provided agents are not host upstream: core's update upserts, so a
  // deny for a team-only id creates the entry here and the team install
  // overlays its body afterwards. Upsert only for a current team
  // winner; a retained rule for a disabled team would otherwise recreate the
  // disposed role from Agent.Info.default. Every other absent id keeps the
  // old skip-if-absent behaviour.
  if (!editor.get(rule.agent) && !team.has(rule.agent)) return
  editor.update(rule.agent, (agent) => {
    agent.permissions.push({
      action: rule.action,
      resource: rule.resource,
      effect: rule.effect,
      // Omitted rather than undefined: a rule with no message must encode
      // exactly as it did before rule messages existed.
      ...(rule.message === undefined ? {} : { message: rule.message }),
    })
  })
}

// Tool-specific permission rules: every perm item OFF for an agent installs
// one core deny per pattern through the existing agent registration. Because
// Permission.evaluate is last-match-wins, appending is always sufficient.
// The action comes from the per-rule `permAction` carried on the perm item by
// discovery (the tool's own `options.permission`), falling back to the tool id
// map (edit/write share core's `edit` action). A rule message travels with
// every pattern the row denies, so the model reads why it was refused.
// Every rule row that is off installs one core deny per pattern. Rule rows
// only ever refuse: a category's "Everything else" row and allow-list rows are
// input rows checked on the call itself (permission-enforce.ts), so no core
// allow from one category can reopen what another row or a role restriction
// closed. Rows of every other kind are enforced there too.
function permDenials(input: ApplyInput): Rule[] {
  return input.agents.flatMap((agent) =>
    input.items.flatMap((upstream): Rule[] => {
      const item = runtimeRule(upstream, agent, input)
      if (item === undefined || item.kind !== "perm") return []
      // Team policy rows carry both sides of their answer and install through
      // policyRules; installing their patterns here too would double them.
      if (item.policy !== undefined) return []
      if ((item.permKind ?? "rule") !== "rule") return []
      if (item.patterns === undefined || item.patterns.length === 0) return []
      if (!applies(item, agent.id)) return []
      if (resolvedFor(item, agent, input).enabled) return []
      const tool = item.permTool ?? item.id.slice("perm:".length).split(":")[0] ?? ""
      if (tool.length === 0) return []
      const action = item.permAction ?? actionForToolId(tool)
      const message = item.custom === true ? item.message : curatedRuleMessage(tool, item.ruleId ?? "") ?? item.message
      return item.patterns.map((pattern) => ({
        agent: agent.id,
        action,
        resource: pattern,
        effect: "deny" as const,
        refusal: true,
        ...(message === undefined ? {} : { message }),
      }))
    }),
  )
}

// The shell's allow-list: while an agent's "Every other command" row is off,
// only what an allow row that is on matches may run. Plus checks the call as
// written (permission-enforce.ts); core checks every command it parses out of
// it — each part of a pipeline, a list or a substitution — so a command
// chained after an allowed one (`pilotty … && git push`) is refused too. The
// rows that are off still refuse inside what the list opens: they land after it.
function shellAllowList(input: ApplyInput): Rule[] {
  const rows = input.items.filter((item) => item.kind === "perm" && item.permTool === "shell" && item.category === "commands")
  const closing = rows.find((item) => item.fallback === true)
  if (closing === undefined) return []
  const action = closing.permAction ?? actionForToolId("shell")
  return input.agents.flatMap((agent): Rule[] => {
    if (!applies(closing, agent.id) || resolvedFor(closing, agent, input).enabled) return []
    const opened = rows.flatMap((row) => {
      const item = runtimeRule(row, agent, input)
      return item !== undefined && item.allow === true && applies(item, agent.id) && resolvedFor(item, agent, input).enabled ? [item] : []
    })
    const message = allowListMessage(runtimeRule(closing, agent, input)?.message ?? "this command is not allowed here", opened.map((item) => item.title))
    return [
      { agent: agent.id, action, resource: "*", effect: "deny", allowList: "closing", message },
      ...opened.flatMap((item) => (item.patterns ?? []).map((pattern): Rule => ({ agent: agent.id, action, resource: pattern, effect: "allow", allowList: "opening" }))),
    ]
  })
}

interface Rule {
  readonly agent: string
  readonly action: string
  readonly resource: string
  readonly effect: PolicyRule["effect"]
  readonly message?: string
  /** A row's own refusal (a rule row that is off, the non-member namespace deny): always lands last. */
  readonly refusal?: boolean
  /** An allow-list (shellAllowList): its closing deny, then what its allow rows open, both before the refusals. */
  readonly allowList?: "closing" | "opening"
}

// The order every Plus rule lands in, whichever row produced it: first a
// role row's whole-resource defaults (its "shell *"), then the role rules that
// let a specific resource through (a run's scope paths, a planner's plan
// files), then the role's own refusals, then a closed allow-list (deny
// everything, then allow what its rows open), and last every refusal of a row
// that is off (curated, catalog and user rules, and the non-member namespace
// deny). Core answers last-match-wins, so a row that is off always refuses
// what it matches — even with the pattern `*` — and a role's "allow shell *"
// can no longer undo a "git push" row that is off or a closed allow-list.
// Within the defaults an allow comes before an ask before a deny, so the most
// restrictive default wins; the sort is stable, so each row keeps its own
// internal order.
export function orderRules<
  T extends { readonly resource: string; readonly effect: PolicyRule["effect"]; readonly refusal?: boolean; readonly allowList?: "closing" | "opening" },
>(rules: readonly T[]): T[] {
  const effectRank = { allow: 0, ask: 1, deny: 2 } as const
  const rank = (rule: T) => {
    if (rule.allowList === "closing") return 6
    if (rule.allowList === "opening") return 7
    if (rule.refusal === true) return 8
    if (rule.resource === "*") return effectRank[rule.effect]
    return rule.effect === "deny" ? 5 : 3 + effectRank[rule.effect]
  }
  return rules
    .map((rule, index) => ({ rule, index }))
    .toSorted((left, right) => rank(left.rule) - rank(right.rule) || left.index - right.index)
    .map((entry) => entry.rule)
}

// Policy rows: every policy row resolved for the member it belongs to,
// installing the row's own `on` rules when it resolves enabled and its `off`
// rules when it resolves disabled. The rules are the row's whole answer — a
// live run's edit scope arrives here — so a project or global override of the
// row changes what lands with no other code path involved. A rule's `message` travels with it: core sends it
// to the model in place of the generic refusal when that rule denies.
function policyRules(input: ApplyInput): { agent: string; action: string; resource: string; effect: PolicyRule["effect"]; message?: string }[] {
  return input.agents.flatMap((agent) =>
    input.items.flatMap((item) => {
      const policy = item.policy
      if (item.kind !== "perm" || policy === undefined) return []
      if (!applies(item, agent.id)) return []
      const resolved = resolvedFor(item, agent, input)
      const rules = resolved.enabled ? policy.on : policy.off
      return rules.map((rule) => ({ agent: agent.id, ...rule }))
    }),
  )
}

// What hides the team namespace from everyone else (item 4): an agent that is
// not a member of an enabled team gets one wildcard deny on the namespace's
// permission action, which is exactly the shape core drops a tool for
// (`packages/core/src/tool.ts` whollyDisabled matches the action by wildcard
// against `options.permission`). Nothing is emitted when the namespace is not
// registered at all, so an inventory without team tools installs nothing.
function teamNamespaceDenials(input: ApplyInput): { agent: string; action: string; resource: string; effect: "deny" }[] {
  const registered = input.items.some(
    (item) => item.kind === "tool" && (item.namespace === teamNamespace || item.id.startsWith(`tool:${teamNamespace}_`)),
  )
  if (!registered) return []
  const members = new Set(input.teamAgents ?? [])
  return input.agents
    .filter((agent) => !members.has(agent.id))
    .map((agent) => ({ agent: agent.id, action: `${teamNamespace}.*`, resource: "*", effect: "deny" as const, refusal: true }))
}

const teamNamespace = "team"

// A `tool:team_<name>` row that resolves off refuses the call itself: one
// core deny on the tool's own permission (`team.<name>`, teams/tools.ts
// teamOptions), for direct and Code Mode team tools alike. Hiding a direct
// tool from the model is not a refusal, and the Code Mode denial keyed on the
// registry id never matches `team.<name>`; the old per-kind team tool ceiling
// installed exactly this deny. A non-member already has the whole namespace
// denied (teamNamespaceDenials).
function teamToolDenials(candidates: readonly ToolCandidate[], members: readonly string[] = []): Rule[] {
  const prefix = `tool:${teamNamespace}_`
  return candidates.flatMap((candidate): Rule[] => {
    if (candidate.enabled || !candidate.item.id.startsWith(prefix) || !members.includes(candidate.agent)) return []
    const action = `${teamNamespace}.${candidate.item.id.slice(prefix.length)}`
    return [{ agent: candidate.agent, action, resource: "*", effect: "deny", refusal: true }]
  })
}

// Disabled-rule scrub keywords per agent: the union of keywords from every
// OFF perm item for that agent. Empty means no scrub, so unrelated saves
// install no extra hooks and stay no-ops.
function scrubKeywordsByAgent(input: ApplyInput): Map<string, string[]> {
  const out = new Map<string, string[]>()
  for (const agent of input.agents) {
    const keywords = input.items.flatMap((upstream) => {
      const item = runtimeRule(upstream, agent, input)
      if (item === undefined || item.kind !== "perm") return []
      if (item.keywords === undefined || item.keywords.length === 0) return []
      if (!applies(item, agent.id)) return []
      const resolved = resolvedFor(item, agent, input)
      if (resolved.enabled) return []
      return [...item.keywords]
    })
    if (keywords.length > 0) out.set(agent.id, [...new Set(keywords)])
  }
  return out
}

// The project's named checks (main checkout .opencodeplus/checks.json) on the
// checks field of team_delegate and the id field of team_check. Only when one
// of them is in the request; a failed read leaves the tools as they are.
function describeChecks(ctx: Context, event: { readonly tools: Record<string, { input: unknown }> }): Effect.Effect<void> {
  if (event.tools.team_delegate === undefined && event.tools.team_check === undefined) return Effect.void
  return Effect.promise(async () => {
    const project = await readProjectChecks(ctx.location.directory).catch(() => undefined)
    describeProjectChecks(event.tools, project)
  })
}

// Scrub the session prompt: drop whole lines containing disabled keywords
// from every tool description and every system part (base plus instructions).
// Runs inside the existing session.context hook, after the text plans.
// Preservation discipline (mirroring spliceToolGuidance): if scrubbing would
// empty a description or system text entirely, leave the original text rather
// than installing nothing.
function applyRuleScrub(event: SessionContext, keywords: readonly string[]): void {
  if (keywords.length === 0) return
  for (const tool of Object.values(event.tools)) {
    const scrubbed = scrubLines(tool.description, keywords).text
    if (scrubbed.trim().length === 0) continue
    tool.description = scrubbed
  }
  for (let index = 0; index < event.system.length; index++) {
    const part = event.system[index]
    if (part === undefined || typeof part.text !== "string") continue
    const scrubbed = scrubLines(part.text, keywords).text
    if (scrubbed.trim().length === 0) continue
    if (scrubbed !== part.text) event.system[index] = { ...part, text: scrubbed }
  }
}

// Scrub Code Mode catalog descriptions inside the existing session.catalog
// hook, after the text/pin plans. Same preservation: never install an emptied
// description.
function applyCatalogScrub(event: { agent: unknown; tools: Record<string, { description?: string }> }, keywords: readonly string[]): void {
  if (keywords.length === 0) return
  for (const entry of Object.values(event.tools)) {
    if (typeof entry.description !== "string") continue
    const scrubbed = scrubLines(entry.description, keywords).text
    if (scrubbed.trim().length === 0) continue
    entry.description = scrubbed
  }
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
          ...(original.autoinvoke === undefined ? {} : { autoinvoke: original.autoinvoke }),
          path: original.path,
          content: copy.text,
        }),
      )
    }
  })
  if (added.size === 0) {
    await runPublish(registration.dispose)
    return undefined
  }
  return { registration, added }
}

export interface BasePlan {
  readonly agent: string
  readonly template: string
  readonly text: string
  /** Raw upstream host template; the alignment fallback when the host lacks the per-request raw seam. */
  readonly upstream: string
}

export interface InstructionPlan {
  readonly agent: string
  readonly path: string
  readonly text: string
  readonly enabled: boolean
  /** A model prompt: sent only to a request whose model one of these patterns names. */
  readonly models?: readonly string[]
  /** The row is its source's own text: OpenCode sends that part itself and announces its changes. */
  readonly asSource?: true
}

function basePlans(input: ApplyInput): BasePlan[] {
  return input.agents.flatMap((agent) =>
    input.items.flatMap((item) => {
      if (item.kind !== "base") return []
      if (!applies(item, agent.id)) return []
      const resolved = resolvedFor(item, agent, input, gateFor(input, agent))
      if (isNoop(item, resolved)) return []
      if (!resolved.enabled) return []
      return [{ agent: agent.id, template: parseId(item.id, "base:"), text: resolved.assembled, upstream: item.text }]
    }),
  )
}

interface ToolCandidate {
  readonly mode?: "direct" | "codemode"
  readonly agent: string
  readonly item: Item
  readonly tool: string
  readonly enabled: boolean
  readonly text: string
  readonly pinned: boolean
  readonly params: readonly ParamPlan[]
  readonly noop?: boolean
}

function nativePlan(candidate: ToolCandidate): ToolPlan {
  return {
    agent: candidate.agent,
    tool: candidate.tool,
    enabled: candidate.enabled,
    text: candidate.text,
    ...(candidate.params.length === 0 ? {} : { params: candidate.params }),
  }
}

function toolCandidates(input: ApplyInput, options?: { readonly skipNoop?: boolean }): ToolCandidate[] {
  const edited = editedParams(input)
  // Every exposure row, not only stored ones: a member preset sets exposure too.
  const exposures = new Map(input.items.filter((item) => item.id.startsWith("toolmode:")).map((item) => [item.id, item]))
  return input.agents.flatMap((agent) =>
    input.items.flatMap((item) => {
      if (item.kind !== "tool") return []
      if (!applies(item, agent.id)) return []
      const resolved = resolvedFor(item, agent, input, gateFor(input, agent))
      const tool = parseId(item.id, "tool:")
      const params = paramPlans(input, agent, edited.get(tool))
      const exposure = exposures.get(`toolmode:${tool}`)
      const requested = item.execute !== true && exposure !== undefined
        ? resolvedFor(exposure, agent, input).assembled === "codemode" ? "codemode" : "direct"
        : undefined
      const mode = requested === (item.codemode === true ? "codemode" : "direct") ? undefined : requested
      // isNoop compares only text and enablement (it is shared with base and
      // instruction plans, which have no pin), so a pin-only change on a Code
      // Mode tool would be discarded here before catalogPlans ever sees it.
      // Let the candidate survive when the resolved pin differs from the
      // registry default, or when the agent sees a parameter edited.
      const noop = isNoop(item, resolved) && resolved.pinned === (item.pinned ?? false) && params.length === 0 && mode === undefined
      if (options?.skipNoop !== true && noop) return []
      return [{
        agent: agent.id,
        item: mode === undefined ? item : { ...item, codemode: mode === "codemode" },
        ...(mode === undefined ? {} : { mode }),
        tool,
        enabled: resolved.enabled,
        text: resolved.assembled,
        pinned: resolved.pinned,
        params,
        noop,
      }]
    }),
  )
}

// Parameter rows by tool, only those some record touches: a parameter nobody
// edited is its tool's own for every agent, so it is never resolved.
function editedParams(input: ApplyInput): Map<string, Item[]> {
  const touched = new Set(input.records.flatMap((record) => (record.item.startsWith("param:") ? [record.item] : [])))
  const byTool = new Map<string, Item[]>()
  if (touched.size === 0) return byTool
  for (const item of input.items) {
    if (item.kind !== "param" || item.paramTool === undefined || !touched.has(item.id)) continue
    byTool.set(item.paramTool, [...(byTool.get(item.paramTool) ?? []), item])
  }
  return byTool
}

// The parameters one agent sees differently from the tool's own: an edited
// description, or switched off. A required parameter always stays.
function paramPlans(input: ApplyInput, agent: ApplyAgent, params: readonly Item[] | undefined): ParamPlan[] {
  return (params ?? []).flatMap((param) => {
    if (!applies(param, agent.id)) return []
    const resolved = resolvedFor(param, agent, input, gateFor(input, agent))
    const enabled = resolved.enabled || param.required === true
    if (enabled && normalizeLossless(resolved.assembled) === normalizeLossless(param.text)) return []
    return [{ name: param.title, enabled, text: resolved.assembled }]
  })
}

interface InstructionCandidate {
  readonly agent: string
  readonly path: string
  readonly text: string
  readonly enabled: boolean
  readonly noop: boolean
  readonly models?: readonly string[]
}

function instructionCandidates(input: ApplyInput): InstructionCandidate[] {
  return input.agents.flatMap((agent) => {
    const gate = gateFor(input, agent)
    return input.items.flatMap((item) => {
      if (item.kind !== "system") return []
      if (item.id === "system:role") return []
      // OpenCode builds its own parts per request; their rows only show where they go.
      if (item.opencodePart !== undefined) return []
      if (!applies(item, agent.id)) return []
      const resolved = resolvedFor(item, agent, input, gate)
      const text = resolved.assembled
      // The Tools and rules row and user System rows have no source of their
      // own: they reach an agent only through this plan, so each is planned
      // exactly when some text of it applies to that agent (and nothing is
      // installed when none does).
      const planOnly = item.id === guidanceItemId || item.userSystem === true
      if (planOnly && (!resolved.enabled || text.trim().length === 0)) return []
      return [{
        agent: agent.id,
        path: instructionPlanPath(item),
        text,
        enabled: resolved.enabled && text.trim().length > 0,
        noop: !planOnly && isNoop(item, resolved),
        ...(item.models === undefined ? {} : { models: item.models }),
      }]
    })
  })
}

function instructionPlans(input: ApplyInput, directory: string, options?: { readonly skipNoop?: boolean }): InstructionPlan[] {
  const candidates = instructionCandidates(input)
  if (options?.skipNoop === true) return candidates.map((c) => instructionPlanOf(c, directory))
  return candidates.filter((c) => !c.noop).map((c) => instructionPlanOf(c, directory))
}

// Every path that installs instruction plans builds them here, so a model
// prompt never loses the models it is for. A plan names its file by absolute
// path, resolved against the folder whose discovery found it: a chat pinned
// here and moved to another folder keeps naming the files OpenCode keeps
// sending it, where the relative id would name another folder's files.
function instructionPlanOf(c: InstructionCandidate, directory: string): InstructionPlan {
  return {
    agent: c.agent,
    path: resolveInstructionId(directory, c.path),
    text: c.text,
    enabled: c.enabled,
    ...(c.models === undefined ? {} : { models: c.models }),
    ...(c.noop ? { asSource: true as const } : {}),
  }
}

// The teaching row carries a stable id instead of a location-relative path,
// so it cannot resolve against the location directory like other instruction
// rows. Core keys that part by the seeded absolute path, so plan it
// absolutely; resolveInstructionId leaves the seeded path untouched. User
// System rows plan by their own file the same way.
function instructionPlanPath(item: Item): string {
  if (item.id === teachingItemId) return teachingFilePath()
  if (item.id === guidanceItemId) return guidancePath()
  const id = parseId(item.id, "system:")
  if (item.userSystem === true) return userSystemFile(id)
  return id
}

export interface SessionPlans {
  readonly exposure: readonly { readonly agent: string; readonly tool: string; readonly mode: "direct" | "codemode" }[]
  readonly base: readonly BasePlan[]
  readonly native: readonly ToolPlan[]
  readonly denials: readonly ToolCandidate[]
  readonly catalogPlans: readonly ToolPlan[]
  readonly permDenies: readonly Rule[]
  readonly scrubByAgent: readonly [string, string[]][]
  readonly needsNarrowing: boolean
  readonly tools: readonly ToolPlan[]
  /** Each agent with a stored System order: the complete slot order its system parts are sent in. */
  readonly orders: readonly (readonly [string, readonly string[]])[]
}

export function sessionPlans(
  input: ApplyInput,
  permissions: PermissionTable,
  candidatesInput?: readonly ToolCandidate[],
): SessionPlans {
  const base = basePlans(input)
  const candidates = candidatesInput ?? toolCandidates(input)
  const native: ToolPlan[] = candidates
    .filter((candidate) => candidate.item.codemode !== true && candidate.item.execute !== true)
    .map(nativePlan)
  const denials = candidates.filter(
    (candidate) => (candidate.item.codemode === true || candidate.item.execute === true) && !candidate.enabled,
  )
  const catalogPlans: ToolPlan[] = candidates
    .filter((candidate) => {
      if (candidate.item.codemode !== true) return false
      if (candidate.item.execute === true) return false
      if (candidate.params.length > 0) return true
      if (normalizeLossless(candidate.text) !== normalizeLossless(candidate.item.text)) return true
      return candidate.pinned !== (candidate.item.pinned ?? false)
    })
    .map((candidate) => ({
      agent: candidate.agent,
      tool: candidate.tool,
      enabled: candidate.enabled,
      text: candidate.text,
      codemode: true as const,
      catalogPath: catalogPath(candidate.item),
      pinned: candidate.pinned,
      ...(candidate.params.length === 0 ? {} : { params: candidate.params }),
    }))
  const permDenies = orderRules<Rule>([
    ...permDenials(input),
    ...shellAllowList(input),
    ...policyRules(input),
    ...teamNamespaceDenials(input),
    ...teamToolDenials(candidates, input.teamAgents),
  ]).map((rule) => ({
    agent: rule.agent,
    action: rule.action,
    resource: rule.resource,
    effect: rule.effect,
    ...(rule.message === undefined ? {} : { message: rule.message }),
  }))
  const scrubByAgent = scrubKeywordsByAgent(input)
  const needsNarrowing = tableNarrows(permissions, input.agents.map((agent) => agent.id)) || (input.teamAgents?.length ?? 0) > 0
  return {
    exposure: candidates.flatMap((candidate) => candidate.mode === undefined ? [] : [{ agent: candidate.agent, tool: candidate.tool, mode: candidate.mode }]),
    base,
    native,
    denials,
    catalogPlans,
    permDenies,
    scrubByAgent: Array.from(scrubByAgent.entries()),
    needsNarrowing,
    tools: [...native, ...catalogPlans],
    orders: systemOrders(input),
  }
}

// Each agent's stored System order, found down the chain its rows resolve
// through (runtimeScope): its own levels, its preset, the Defaults entries
// matching it, then Defaults' every agent (a team member: its team's chain and
// the Teams catalogue). An agent with none keeps the request's own order.
export function systemOrders(input: ApplyInput): (readonly [string, readonly string[]])[] {
  if ((input.orders ?? []).length === 0) return []
  return input.agents.flatMap((agent) => {
    const runtime = runtimeScope(agent, input.scopes)
    const chain = resolutionChain(
      { level: runtime.level, agent: agent.id, item: "system:role", section: null, ...(agent.team === undefined ? {} : { team: agent.team }) },
      runtime.scopes,
    )
    const order = effectiveSystemOrder(storedSystemOrder(input.orders ?? [], chain), input.items)
    return order === undefined ? [] : [[agent.id, order] as const]
  })
}

export async function installSessionPlans(
  ctx: Context,
  input: ApplyInput,
  plans: SessionPlans,
  permissions: PermissionTable,
  state?: {
    sessionPins?: SessionPinManager
    currentPlanSet?: PlanSet
  },
  precomputed?: {
    readonly instructions?: readonly InstructionPlan[]
    readonly customByAgent?: ReadonlySet<string>
  },
): Promise<Registration[]> {
  const installed: Registration[] = []
  try {
    if (plans.exposure.length > 0) {
      installed.push(await runHook(ctx.session.hook, "tools", (event) => Effect.sync(() => {
        for (const plan of plans.exposure) {
          if (plan.agent === String(event.agent)) event.modes[plan.tool] = plan.mode
        }
      })))
    }
    const team = new Set(input.teamAgents ?? [])
    const instructions = precomputed?.instructions ?? instructionPlans(input, ctx.location.directory)
    const scrubByAgent = new Map(plans.scrubByAgent)
    const needsScrub = plans.scrubByAgent.some(([_, keywords]) => keywords.length > 0)
    const contextHook =
      plans.base.length > 0 ||
      plans.native.length > 0 ||
      instructions.length > 0 ||
      needsScrub ||
      plans.orders.length > 0 ||
      state !== undefined

    if (plans.denials.length > 0) {
      const agentRegistration = await runRegistration(ctx.agent.transform, (editor: AgentEditor) => {
        for (const denial of plans.denials) pushRule(editor, { agent: denial.agent, action: denial.tool, resource: "*", effect: "deny" }, team)
      })
      installed.push(agentRegistration)
    }
    if (plans.permDenies.length > 0) {
      const permRegistration = await runRegistration(ctx.agent.transform, (editor: AgentEditor) => {
        for (const rule of plans.permDenies) pushRule(editor, rule, team)
      })
      installed.push(permRegistration)
    }
    if (contextHook) {
      const pins = new Map<string, string>()
      for (const agent of input.agents) {
        if (agent.base !== undefined) pins.set(agent.id, agent.base)
      }
      const data = input.catalog ?? (await runPublish(
        ctx.model.list().pipe(
          Effect.catchCause(() =>
            Effect.succeed({ data: [] as readonly Model.Info[], location: { directory: ctx.location.directory } }),
          ),
        ),
      )).data
      const classifier: RequestClassifier = { pinned: pins, catalog: data, prompt: ctx.prompt }
      const customByAgent = precomputed?.customByAgent ?? state?.currentPlanSet?.customByAgent ?? (await readCustomSystem(ctx, input.agents))
      const fallbackPlanSet = state?.currentPlanSet ?? (() => {
        const allRoles = roleUpdates(input, { skipNoop: true })
        const allInstructions = instructionPlans(input, ctx.location.directory, { skipNoop: true })
        const allCandidates = toolCandidates(input, { skipNoop: true })
        const allNative: ToolPlan[] = allCandidates
          .filter((candidate) => candidate.item.codemode !== true && candidate.item.execute !== true)
          .map(nativePlan)
        return createPlanSet({
          roles: new Map(allRoles.map((r) => [r.agent, r.text])),
          base: plans.base,
          native: allNative,
          instructions: allInstructions,
          scrubByAgent,
          needsNarrowing: plans.needsNarrowing,
          permissions,
          customByAgent,
          orders: new Map(plans.orders),
        })
      })()
      const orders = new Map(plans.orders)
      const registration = await runHook(ctx.session.hook, "context", (event) => {
        if (state === undefined) {
          applyBasePlan(event, plans.base, classifier, customByAgent)
          applyToolPlan(event, plans.native.filter((plan) => plan.agent === String(event.agent)))
          applyInstructionPlans(ctx, event, instructions.filter((plan) => plan.agent === String(event.agent)), classifier)
          applyRuleScrub(event, scrubByAgent.get(String(event.agent)) ?? [])
          if (plans.needsNarrowing) narrowTools(event, permissions)
          applySystemOrder(event, orders.get(String(event.agent)))
          return plans.needsNarrowing ? describeChecks(ctx, event) : Effect.void
        }
        return Effect.gen(function* () {
          const sessionID = String(event.sessionID)
          const agent = String(event.agent)
          const pinManager = state?.sessionPins ?? sessionPins
          const activePlanSet = state?.currentPlanSet ?? fallbackPlanSet
          // A first request, or a rebuild moment: the pin takes the current plan set.
          const applyCurrent = Effect.fnUntraced(function* (pin: SessionPin) {
            applyBasePlan(event, activePlanSet.base, classifier, activePlanSet.customByAgent)
            applyToolPlan(event, activePlanSet.native.filter((plan) => plan.agent === agent))
            applyInstructionPlans(ctx, event, activePlanSet.instructions.filter((plan) => plan.agent === agent), classifier)
            applyRuleScrub(event, activePlanSet.scrubByAgent.get(agent) ?? [])
            if (activePlanSet.needsNarrowing) narrowTools(event, pinnedPermissions(pin, agent, activePlanSet.permissions))
            pin.pinnedSystem0.set(agent, event.system[0]?.text ?? "")
            pin.pinnedRoles.set(agent, activePlanSet.roles.get(agent) ?? "")
            pin.lastRequestAt = Date.now()
            applySystemOrder(event, activePlanSet.orders.get(agent))
            if (activePlanSet.needsNarrowing) yield* describeChecks(ctx, event)
            yield* pinManager.save(pin, agent)
          })
          const pin = yield* pinManager.load(sessionID, activePlanSet)

          if (pin === undefined) return yield* applyCurrent(pinManager.pinSession(sessionID, event.model, activePlanSet))
          if (yield* Effect.promise(() => isRebuildMoment(pin, event, Date.now())))
            return yield* applyCurrent(pinManager.repinSession(sessionID, event.model, activePlanSet))

          // The note is delivered only as the steered synthetic admitted here;
          // copying it into this request's messages would deliver it twice.
          yield* Effect.promise(() => checkAndEmitChangeNote(ctx, pin, activePlanSet, agent, sessionID))

          yield* applyPinnedPlans(ctx, event, pin, classifier)
          pin.lastRequestAt = Date.now()
          if (event.model.variant !== undefined) pin.model.variant = String(event.model.variant)
          if (event.model.variant === undefined) delete pin.model.variant
          yield* pinManager.save(pin, agent)
        })
      })
      installed.push(registration)

      if (state !== undefined) {
        const compactionRegistration = await runHook(ctx.session.hook, "compaction", (event) =>
          Effect.gen(function* () {
            const pinManager = state?.sessionPins ?? sessionPins
            const pin = yield* pinManager.load(String(event.sessionID), state?.currentPlanSet ?? fallbackPlanSet)
            if (pin === undefined || !sameModel(event.model, pin.model)) return
            yield* applyPinnedPlans(ctx, event, pin, classifier)
          }),
        )
        installed.push(compactionRegistration)
      }
    }
    if (!contextHook && plans.needsNarrowing) {
      const narrowing = await hook(() =>
        ctx.session.hook("context", (event) => {
          narrowTools(event, permissions)
          return describeChecks(ctx, event)
        }),
      )
      if (narrowing !== undefined) installed.push(narrowing)
      if (state !== undefined) {
        const narrowingCompaction = await hook(() =>
          ctx.session.hook("compaction", (event) => {
            narrowTools(event, permissions)
            return describeChecks(ctx, event)
          }),
        )
        if (narrowingCompaction !== undefined) installed.push(narrowingCompaction)
      }
    }
    if (plans.catalogPlans.length > 0 || needsScrub) {
      const catalogRegistration = await runHook(ctx.session.hook, "catalog", (event) => {
        for (const plan of plans.catalogPlans) {
          if (plan.agent !== String(event.agent)) continue
          const catalogP = plan.catalogPath
          if (catalogP === undefined) continue
          const entry = event.tools[catalogP]
          if (entry === undefined) continue
          entry.description = plan.text
          if (plan.pinned !== undefined) entry.pinned = plan.pinned
          // Replaced, never mutated: core shows the request edited parameters by the new object.
          if (plan.params !== undefined && entry.input !== undefined) entry.input = editInputSchema(entry.input, plan.params)
        }
        applyCatalogScrub(event, scrubByAgent.get(String(event.agent)) ?? [])
        return Effect.void
      })
      installed.push(catalogRegistration)
    }
    return installed
  } catch (error) {
    await disposeRegistrations(installed)
    throw error
  }
}

function sameModel(
  a: { readonly providerID: unknown; readonly id: unknown; readonly variant?: unknown },
  b: { readonly providerID: unknown; readonly id: unknown; readonly variant?: unknown },
): boolean {
  if (String(a.providerID) !== String(b.providerID)) return false
  if (String(a.id) !== String(b.id)) return false
  const aVariant = a.variant === undefined ? undefined : String(a.variant)
  const bVariant = b.variant === undefined ? undefined : String(b.variant)
  return aVariant === bVariant
}

function applyPinnedSystem0(
  event: SessionContext,
  pin: SessionPin,
  classifier: RequestClassifier,
  agent: string,
): void {
  const pinnedSystem0 = pin.pinnedSystem0.get(agent)
  if (pinnedSystem0 !== undefined) {
    if (event.system[0] !== undefined) {
      event.system[0] = { ...event.system[0], text: pinnedSystem0 }
      return
    }
    event.system.push({ type: "text", text: pinnedSystem0 })
    return
  }
  applyBasePlan(event, pin.planSet.base, classifier, pin.planSet.customByAgent)
  pin.pinnedSystem0.set(agent, event.system[0]?.text ?? "")
}

function applyPinnedPlans(
  ctx: Context,
  event: SessionContext,
  pin: SessionPin,
  classifier: RequestClassifier,
): Effect.Effect<void> {
  const agent = String(event.agent)
  applyPinnedSystem0(event, pin, classifier, agent)
  applyToolPlan(event, pin.planSet.native.filter((plan) => plan.agent === agent))
  applyInstructionPlans(ctx, event, pin.planSet.instructions.filter((plan) => plan.agent === agent), classifier)
  applyRuleScrub(event, pin.planSet.scrubByAgent.get(agent) ?? [])
  if (pin.planSet.needsNarrowing) narrowTools(event, pinnedPermissions(pin, agent, pin.planSet.permissions))
  applySystemOrder(event, pin.planSet.orders.get(agent))
  if (pin.planSet.needsNarrowing) return describeChecks(ctx, event)
  return Effect.void
}

// The last step of every path: everything above finds the first part at index
// 0 and Plus's own parts by their file, so the parts move only once those are
// in place. No stored order leaves the array exactly as it is.
export function applySystemOrder(event: Pick<SessionContext, "system">, order: readonly string[] | undefined): void {
  if (order === undefined) return
  event.system.splice(0, event.system.length, ...arrangeBySlot(event.system, slotOfPart, order))
}

// The one host-sourced classification: mirror the core optimize plugin
// (core/src/plugin/optimize.ts lines 59-62) — look the REQUEST model ref up
// in the catalog list, defaulting to a bare ref (name = id, like
// `Model.Info.default`) when the catalog has no entry, then ask
// `ctx.prompt.active`. Classification happens per request from `event.model`
// because a session can select or switch to a model family that differs from
// the agent's configured model; classifying once at install time would serve
// the configured family's customization to the wrong model. The per-agent
// base threaded from discover (index.ts derives it from the agent's
// configured model) is display/active-badge state and only a fallback when
// the request model yields no classification.
interface RequestClassifier {
  readonly pinned: ReadonlyMap<string, string>
  readonly catalog: readonly Model.Info[]
  readonly prompt: Context["prompt"]
}

function classifyRequest(
  classifier: RequestClassifier,
  agent: string,
  ref: { providerID: unknown; id: unknown },
): string | undefined {
  const model = requestModel(classifier, ref)
  const request = Effect.runSync(
    classifier.prompt.active(model).pipe(Effect.catchCause(() => Effect.succeed(undefined as string | undefined))),
  )
  if (request !== undefined) return request
  return classifier.pinned.get(agent)
}

// The request model resolved the way the core optimize plugin resolves it:
// look the event's model ref up in the catalog list, defaulting to a bare
// ref (name = id) when the catalog has no entry. Shared by classification
// and raw-template lookup so the two answer for the same model.
function requestModel(
  classifier: RequestClassifier,
  ref: { providerID: unknown; id: unknown },
): { id: string; name: string } {
  const providerID = String(ref.providerID)
  const id = String(ref.id)
  const found = classifier.catalog.find((entry) => String(entry.providerID) === providerID && String(entry.id) === id)
  if (found !== undefined) return { id: found.id, name: found.name }
  return { id, name: id }
}

// The RAW template core actually rendered for this request. Classification
// alone cannot key the guidance splice: gpt-6 classifies as gpt but
// renders the astra text, so aligning discovery's gpt upstream against
// astra live finds no suffix and would wipe the guidance. Hosts without
// the seam (older hosts, and tests that predate it) leave `raw`
// undefined; fall back to upstream, which matches whenever classification
// and rendering agree — every family except gpt-6.
function rawForRequest(classifier: RequestClassifier, event: SessionContext): string | undefined {
  const raw = classifier.prompt.raw
  if (typeof raw !== "function") return undefined
  return Effect.runSync(
    raw(requestModel(classifier, event.model)).pipe(Effect.catchCause(() => Effect.succeed(undefined as string | undefined))),
  )
}

// "Custom system" comes from real agent info in the context hook's host:
// `ctx.agent.list()` reports the live system prompt, and an agent with one
// defined owns its own base — Plus must not overwrite `system[0]` for it. An
// explicit per-agent flag threaded from the caller wins. Hosts without an
// agent list (older tests) report no custom systems.
async function readCustomSystem(
  ctx: Context,
  agents: readonly ApplyAgent[],
): Promise<ReadonlySet<string>> {
  const explicit = new Set(agents.filter((agent) => agent.customSystem === true).map((agent) => agent.id))
  const listed = await runPublish(
    ctx.agent.list().pipe(Effect.catchCause(() => Effect.succeed({ data: [] as readonly Agent.Info[] }))),
  )
  for (const entry of listed.data) {
    if ((entry.system ?? "") !== "") explicit.add(String(entry.id))
  }
  return explicit
}

function applyBasePlan(
  event: SessionContext,
  plans: readonly BasePlan[],
  classifier: RequestClassifier,
  customByAgent: ReadonlySet<string>,
) {
  if (customByAgent.has(String(event.agent))) return
  const candidates = plans.filter((plan) => plan.agent === String(event.agent))
  if (candidates.length === 0) return
  // Only the template active for this request's model changes what the model
  // sees; stored edits for other templates wait until the agent switches model.
  const active = classifyRequest(classifier, String(event.agent), event.model)
  if (active === undefined) return
  const match = candidates.find((plan) => plan.template === active)
  if (match === undefined) return
  // System[0] already carries core's rendered family template: core's
  // optimize plugins run first (`pre`) and overwrite `system[0]` with the
  // rendered text, and Plus runs last (`post`). Stored custom text is raw
  // host template text, so render it through the host-owned seam before
  // writing: splice the rendered guidance out of the live system[0] in place
  // of the raw placeholder, and substitute the request model name for the
  // model placeholder.
  const first = event.system[0]
  const text = renderBaseText(match.text, match.upstream, event, classifier)
  // An unresolvable alignment leaves the live text exactly as core
  // rendered it: the customization is lost for this request, but the
  // model's tool guidance is never stripped (see spliceToolGuidance).
  if (text === undefined) return
  if (first === undefined) {
    event.system.push({ type: "text", text })
    return
  }
  event.system[0] = { ...first, text }
}

// Render one stored base customization the way core's optimize plugin renders
// the family template it replaces (core/src/plugin/optimize.ts + system
// prompt seam): the raw `${OPENCODE_TOOL_GUIDANCE}` marker becomes the live
// tool guidance visible in system[0], and `{{MODEL_NAME}}` becomes the
// request model name. The live text — not a regenerated guidance string —
// is the source of truth for what core rendered for this request, so Plus
// never invents guidance for tools the request does not have.
function renderBaseText(
  text: string,
  upstream: string,
  event: SessionContext,
  classifier: RequestClassifier,
): string | undefined {
  const rendered = spliceToolGuidance(text, rawForRequest(classifier, event) ?? upstream, event.system[0]?.text)
  if (rendered === undefined) return undefined
  return rendered.replaceAll("{{MODEL_NAME}}", requestModelName(classifier, event))
}

function requestModelName(classifier: RequestClassifier, event: SessionContext): string {
  const providerID = String(event.model.providerID)
  const id = String(event.model.id)
  const found = classifier.catalog.find((entry) => String(entry.providerID) === providerID && String(entry.id) === id)
  return found === undefined ? id : found.name
}

// The stored customization only knows the RAW placeholder; the live system[0]
// already carries core's rendered guidance for this request's tool set. Take
// the guidance span out of the live text by aligning the RAW template core
// actually rendered (the per-request `ctx.prompt.raw` text, or the discovery
// upstream on hosts without the seam) around its placeholder: the raw text
// before the marker locates the guidance start in the live text, and the raw
// text after the marker locates its end. Customized surroundings cannot align
// because editing them is the point of the feature. No marker in the stored
// text means nothing to render; no live text, or a raw template that itself
// carries no marker, means core rendered no guidance, so the marker resolves
// to empty rather than inventing any.
const toolGuidanceMarker = "${OPENCODE_TOOL_GUIDANCE}"

function spliceToolGuidance(stored: string, upstream: string, live: string | undefined): string | undefined {
  const at = stored.indexOf(toolGuidanceMarker)
  if (at === -1) return stored
  if (live === undefined) return stored.replaceAll(toolGuidanceMarker, "")
  const upstreamAt = upstream.indexOf(toolGuidanceMarker)
  if (upstreamAt === -1) return stored.replaceAll(toolGuidanceMarker, "")
  const before = upstream.slice(0, upstreamAt)
  const after = upstream.slice(upstreamAt + toolGuidanceMarker.length)
  const start = before === "" ? 0 : live.indexOf(before)
  // The live text genuinely lacks the raw surroundings, so something besides
  // core's renderer owns system[0]. Return undefined and let the caller keep
  // the live text unmodified: dropping one request's customization loses an
  // edit, but overwriting with guidance-stripped text would silently delete
  // every tool instruction the model sees. Guidance is only ever sliced out
  // of live text, never synthesized.
  if (start === -1) return undefined
  const guidanceStart = start + before.length
  const guidanceEnd = after === "" ? live.length : live.indexOf(after, guidanceStart)
  if (guidanceEnd === -1) return undefined
  return stored.replaceAll(toolGuidanceMarker, live.slice(guidanceStart, guidanceEnd))
}

function applyToolPlan(event: SessionContext, plans: readonly ToolPlan[]) {
  for (const plan of plans) {
    if (!plan.enabled) {
      delete event.tools[plan.tool]
      continue
    }
    const tool = event.tools[plan.tool]
    if (!tool) continue
    tool.description = plan.text
    if (plan.params !== undefined) tool.input = editInputSchema(tool.input, plan.params)
  }
}

// Core per-file instruction seam: one baseline part per instruction source
// file, with the canonical absolute file path on `metadata.instruction.path`
// (core/src/session/model-request.ts `instructionPart`). A plan path is the
// location-relative discovery id (`AGENTS.md`, `../AGENTS.md`, or a longer
// climb for the global file — discover.ts `instructionFileItems`, never
// edited here), so resolve it against the owning location before comparing:
// the plan applies to the event's session directory exactly the way
// discovery resolved it, and the comparison is against the absolute part
// path. Without the session directory the id is ambiguous — `AGENTS.md`
// alone cannot tell the global file from the project file, and `..`
// segments never match a canonical path — so the context-hook caller passes
// the full event and apply reads `event.sessionID`'s location from the host.
export function applyInstructions(
  event: Pick<SessionContext, "system">,
  plans: readonly InstructionPlan[],
): void {
  applyInstructionsToSystem(event.system, plans)
}

// The context-hook path: resolve each plan id against the owning session
// directory to a canonical absolute path, then match parts by canonical
// identity. `ctx.location.directory` is that directory: the plugin host is
// location-scoped (core PluginHost binds one Location.Service per location),
// the context event fires for sessions of that location, and discovery
// resolved these same ids against `ctx.location.directory`. `..` segments
// resolve here instead of silently matching nothing, and a bare `AGENTS.md`
// resolves to the session file rather than the first same-named part.
// A model prompt reaches only a request whose model it names; for any other
// model it is not planned at all.
function applyInstructionPlans(ctx: Context, event: SessionContext, plans: readonly InstructionPlan[], classifier: RequestClassifier): void {
  const model = requestTarget(classifier, event.model)
  const resolved = plans
    .filter((plan) => plan.models === undefined || matchesModel(plan.models, model))
    .map((plan) => ({ ...plan, path: resolveInstructionId(ctx.location.directory, plan.path) }))
  applyInstructionsToSystem(event.system, resolved)
}

function requestTarget(classifier: RequestClassifier, ref: { providerID: unknown; id: unknown }): ModelTarget {
  const providerID = String(ref.providerID)
  const id = String(ref.id)
  const found = classifier.catalog.find((entry) => String(entry.providerID) === providerID && String(entry.id) === id)
  return { providerID, id, ...(found === undefined ? {} : { name: found.name }) }
}

// A plan built here already names its file absolutely (instructionPlanOf), as
// do the seeded and user System files; a relative id comes from a pin stored
// before plans did, and resolves against the chat's folder as it did then.
function resolveInstructionId(directory: string, id: string): string {
  return path.isAbsolute(id) ? id : path.resolve(directory, id)
}

// Direct system-array form for unit callers that already hold the real event
// system (the exported shape keeps the event wrapper so the location-aware
// resolution has a home once discover.ts carries the owning directory).
function applyInstructionsToSystem(
  system: SessionContext["system"],
  plans: readonly InstructionPlan[],
): void {
  for (const plan of plans) {
    // A file Plus changes nothing in is OpenCode's own part, sent from OpenCode's
    // instruction baseline: Plus neither adds it nor rewrites it. Its text here is
    // what Plus read when it last published, which can be older than what
    // OpenCode reads before each request; rewriting the part put an edited
    // AGENTS.md back to its old text after a compaction.
    if (plan.asSource === true) continue
    const index = system.findIndex((part) => matchesPart(partPath(part), plan.path))
    if (!plan.enabled) {
      if (index !== -1) system.splice(index, 1)
      continue
    }
    if (index !== -1) {
      const current = system[index]
      if (current === undefined) continue
      if (current.text !== plan.text) system[index] = { ...current, text: plan.text }
      continue
    }
    const part = { type: "text" as const, text: plan.text, metadata: { instruction: { path: plan.path } } }
    if (plan.models === undefined) {
      system.push(part)
      continue
    }
    // Model prompts follow the base prompt (and each other) even with no
    // stored System order; a stored order moves them with their slot.
    const last = system.findLastIndex((entry) => isModelPromptFile(partPath(entry) ?? ""))
    system.splice(last === -1 ? Math.min(1, system.length) : last + 1, 0, part)
  }
}

// Canonical-path identity: a part matches only when its absolute path equals
// the plan's absolute path. Suffix matching is gone — `AGENTS.md` used to
// match the FIRST part ending in that name (normally the global file, not
// the project one), and ids containing `..` never matched at all, so
// disabling an ancestor or global instruction silently did nothing while
// editing it appended a duplicate.
function matchesPart(candidate: string | undefined, absolute: string): boolean {
  if (candidate === undefined) return false
  return candidate === absolute
}

function partPath(part: SessionContext["system"][number]): string | undefined {
  const metadata = part.metadata as Record<string, unknown> | undefined
  const fromMetadata = metadata?.["path"]
  if (typeof fromMetadata === "string") return fromMetadata
  const nested = (metadata?.["instruction"] as Record<string, unknown> | undefined)?.["path"]
  if (typeof nested === "string") return nested
  const direct = (part as { path?: unknown }).path
  if (typeof direct === "string") return direct
  return undefined
}

export function mcpPlans(input: ApplyInput): readonly { name: string; enabled: boolean }[] {
  return input.items.flatMap((item) => {
    if (item.kind !== "mcp") return []
    const resolved = resolve({
      upstream: item,
      records: input.records,
      splits: input.splits,
      scopes: input.scopes,
      address: { level: "defaults", agent: null, item: item.id, section: null },
    })
    // Server configuration is file-owned: a stored text on an MCP row is never applied.
    if (resolved.enabled === item.enabled) return []
    return [{ name: parseId(item.id, "mcp:"), enabled: resolved.enabled }]
  })
}

export async function applyMcpWithUpdates(
  ctx: Context,
  updates: readonly { name: string; enabled: boolean }[],
): Promise<Registration | undefined> {
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
