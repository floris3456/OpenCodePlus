import { createHash, randomUUID } from "node:crypto"
import path from "node:path"
import { Session } from "@opencode/schema/session"
import { Effect, Option, Schema } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionContext } from "@opencode/plugin/effect/session"
import type { StorageDomain } from "@opencode/plugin/effect/storage"
import type { PermissionTable } from "./permission-enforce.js"
import type { BasePlan, InstructionPlan, ToolPlan } from "./apply.js"
import { derive, slice } from "./sections.js"
import { cacheLifetime } from "../monitor/cache.js"
import type { RequestRow } from "../monitor/ledger.js"
import { isSessionWarm } from "../teams/cold-compaction.js"
import { matchesModel } from "./model-patterns.js"
import { guidancePath, isModelPromptFile, teachingFilePath } from "./paths.js"

export interface PlanSet {
  readonly roles: ReadonlyMap<string, string>
  readonly base: readonly BasePlan[]
  readonly native: readonly ToolPlan[]
  readonly instructions: readonly InstructionPlan[]
  readonly scrubByAgent: ReadonlyMap<string, readonly string[]>
  readonly needsNarrowing: boolean
  readonly permissions: PermissionTable
  readonly customByAgent: ReadonlySet<string>
  /** Per agent with a stored System order: the slot order its system parts are sent in (system-order.ts). */
  readonly orders: ReadonlyMap<string, readonly string[]>
  /**
   * Team members whose role the team installs (in the agent's own body) but
   * this plan set has none for: a folder's first publish runs before its
   * discovery sees the installed members. Their role is not gone.
   */
  readonly unseenRoles: ReadonlySet<string>
  readonly version: number
}

let planSetSeq = 0

export function createPlanSet(options: {
  readonly roles: ReadonlyMap<string, string>
  readonly base: readonly BasePlan[]
  readonly native: readonly ToolPlan[]
  readonly instructions: readonly InstructionPlan[]
  readonly scrubByAgent: ReadonlyMap<string, readonly string[]>
  readonly needsNarrowing: boolean
  readonly permissions: PermissionTable
  readonly customByAgent: ReadonlySet<string>
  readonly orders?: ReadonlyMap<string, readonly string[]>
  readonly unseenRoles?: ReadonlySet<string>
}): PlanSet {
  planSetSeq += 1
  return {
    roles: options.roles,
    base: options.base,
    native: options.native,
    instructions: options.instructions,
    scrubByAgent: options.scrubByAgent,
    needsNarrowing: options.needsNarrowing,
    permissions: options.permissions,
    customByAgent: options.customByAgent,
    orders: options.orders ?? new Map(),
    unseenRoles: options.unseenRoles ?? new Set(),
    version: planSetSeq,
  }
}

export interface SessionPin {
  readonly sessionID: string
  model: { providerID: string; id: string; variant?: string }
  planSet: PlanSet
  pinnedSystem0: Map<string, string>
  pinnedRoles: Map<string, string>
  /** Per agent: every permission-table answer its tool narrowing read (pinnedPermissions). */
  permissionAnswers: Map<string, Map<string, unknown>>
  /** New with each plan set the pin takes: a stored agent part from another epoch is stale. */
  epoch: string
  lastNoteHash?: string
  lastRequestAt: number
  rebuildNeeded?: boolean
}

// A chat's pin is also stored (Plus's plugin storage: core's KV table), so a restart or a
// re-activation of Plus keeps sending what the chat was sent before. Without it the next
// request pinned the current files: one file edited meanwhile rewrote the system prompt,
// and the provider cache missed from the tools on.
const RECORD_PREFIX = "session-pin/"
const recordKey = (sessionID: string) => `${RECORD_PREFIX}${sessionID}`
const agentKey = (sessionID: string, agent: string) => `session-pin-agent/${sessionID}/${agent}`
/** A stored pin idle this long is past every cache lifetime: its chat re-pins anyway. */
const PIN_RETENTION_MS = 24 * 60 * 60 * 1000
const SWEEP_INTERVAL_MS = 60 * 60 * 1000
let sweptAt = 0

const StoredRecord = Schema.Struct({
  version: Schema.Literal(1),
  epoch: Schema.String,
  model: Schema.Struct({ providerID: Schema.String, id: Schema.String, variant: Schema.optional(Schema.String) }),
  lastRequestAt: Schema.Number,
  lastNoteHash: Schema.optional(Schema.String),
  rebuildNeeded: Schema.optional(Schema.Boolean),
  /** Every agent with a stored part, any epoch: what removing the pin removes. */
  agents: Schema.Array(Schema.String),
})

// One agent's share of the pinned plan set, with the system prompt and the
// permission answers it was sent with.
const StoredAgent = Schema.Struct({
  epoch: Schema.String,
  system0: Schema.optional(Schema.String),
  role: Schema.String,
  base: Schema.Array(Schema.Struct({ agent: Schema.String, template: Schema.String, text: Schema.String, upstream: Schema.String })),
  native: Schema.Array(
    Schema.Struct({
      agent: Schema.String,
      tool: Schema.String,
      enabled: Schema.Boolean,
      text: Schema.String,
      codemode: Schema.optional(Schema.Boolean),
      catalogPath: Schema.optional(Schema.String),
      pinned: Schema.optional(Schema.Boolean),
      params: Schema.optional(Schema.Array(Schema.Struct({ name: Schema.String, enabled: Schema.Boolean, text: Schema.String }))),
    }),
  ),
  instructions: Schema.Array(
    Schema.Struct({
      agent: Schema.String,
      path: Schema.String,
      text: Schema.String,
      enabled: Schema.Boolean,
      models: Schema.optional(Schema.Array(Schema.String)),
      asSource: Schema.optional(Schema.Literal(true)),
    }),
  ),
  scrub: Schema.Array(Schema.String),
  order: Schema.optional(Schema.Array(Schema.String)),
  custom: Schema.Boolean,
  narrowing: Schema.Boolean,
  permissionAnswers: Schema.Array(Schema.Tuple([Schema.String, Schema.Unknown])),
})

type StoredRecord = Schema.Schema.Type<typeof StoredRecord>
type StoredAgent = Schema.Schema.Type<typeof StoredAgent>
const decodeRecord = Schema.decodeUnknownOption(Schema.fromJsonString(StoredRecord))
const decodeAgent = Schema.decodeUnknownOption(Schema.fromJsonString(StoredAgent))

/** What was last stored for a chat, to write only what changed. */
interface Written {
  record?: string
  readonly agents: Set<string>
  readonly parts: Map<string, PartMark>
}

interface PartMark {
  readonly planSet: PlanSet
  readonly epoch: string
  readonly system0: string | undefined
  readonly answers: number
}

export class SessionPinManager {
  private readonly pins = new Map<string, SessionPin>()
  private readonly written = new Map<string, Written>()
  private readonly store: StorageDomain | undefined

  /** Without a store, pins live only as long as this manager. */
  constructor(store?: StorageDomain) {
    this.store = store
  }

  getPin(sessionID: string): SessionPin | undefined {
    return this.pins.get(sessionID)
  }

  /** The chat's pin in memory, else the one stored before a restart or a re-activation. */
  load(sessionID: string, current: PlanSet): Effect.Effect<SessionPin | undefined> {
    const pin = this.pins.get(sessionID)
    const store = this.store
    if (pin !== undefined || store === undefined) return Effect.succeed(pin)
    return restorePin(store, sessionID, current).pipe(
      Effect.map((restored) => {
        if (restored === undefined) return undefined
        const raced = this.pins.get(sessionID)
        if (raced !== undefined) return raced
        this.pins.set(sessionID, restored.pin)
        this.written.set(sessionID, restored.written)
        return restored.pin
      }),
      Effect.catchCause((cause) =>
        Effect.as(Effect.logWarning("plus could not restore a chat's pinned prompt", { sessionID, cause }), undefined),
      ),
    )
  }

  /** Stores what changed since the last write: this agent's part, then the record. */
  save(pin: SessionPin, agent?: string): Effect.Effect<void> {
    const store = this.store
    if (store === undefined) return Effect.void
    return Effect.suspend(() => {
      const written = this.written.get(pin.sessionID) ?? { agents: new Set<string>(), parts: new Map<string, PartMark>() }
      this.written.set(pin.sessionID, written)
      const mark = agent === undefined ? undefined : markOf(pin, agent)
      const last = agent === undefined ? undefined : written.parts.get(agent)
      const part = agent !== undefined && mark !== undefined && !sameMark(last, mark) ? agent : undefined
      const agents = part === undefined ? written.agents : new Set([...written.agents, part])
      const record = JSON.stringify(recordOf(pin, agents))
      const writes = [
        ...(part === undefined ? [] : [[agentKey(pin.sessionID, part), JSON.stringify(agentPart(pin, part))] as const]),
        ...(record === written.record ? [] : [[recordKey(pin.sessionID), record] as const]),
      ]
      const now = Date.now()
      const sweep = now - sweptAt > SWEEP_INTERVAL_MS
      if (sweep) sweptAt = now
      return Effect.forEach(writes, ([key, value]) => store.set(key, value), { discard: true }).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            written.record = record
            if (part === undefined || mark === undefined) return
            written.agents.add(part)
            written.parts.set(part, mark)
          }),
        ),
        Effect.andThen(sweep ? Effect.forkDetach(sweepStoredPins(store, now)) : Effect.void),
        Effect.catchCause((cause) =>
          Effect.logWarning("plus could not store a chat's pinned prompt", { sessionID: pin.sessionID, cause }),
        ),
        Effect.asVoid,
      )
    })
  }

  pinSession(
    sessionID: string,
    model: { providerID: unknown; id: unknown; variant?: unknown },
    planSet: PlanSet,
  ): SessionPin {
    const pin: SessionPin = {
      sessionID,
      model: {
        providerID: String(model.providerID),
        id: String(model.id),
        ...(model.variant !== undefined ? { variant: String(model.variant) } : {}),
      },
      planSet,
      pinnedSystem0: new Map(),
      pinnedRoles: new Map(),
      permissionAnswers: new Map(),
      epoch: randomUUID(),
      lastRequestAt: Date.now(),
    }
    this.pins.set(sessionID, pin)
    return pin
  }

  repinSession(
    sessionID: string,
    model: { providerID: unknown; id: unknown; variant?: unknown },
    planSet: PlanSet,
  ): SessionPin {
    const existing = this.pins.get(sessionID)
    if (existing === undefined) {
      return this.pinSession(sessionID, model, planSet)
    }
    existing.model = {
      providerID: String(model.providerID),
      id: String(model.id),
      ...(model.variant !== undefined ? { variant: String(model.variant) } : {}),
    }
    existing.planSet = planSet
    existing.pinnedSystem0.clear()
    existing.pinnedRoles.clear()
    existing.permissionAnswers = new Map()
    existing.epoch = randomUUID()
    delete existing.lastNoteHash
    delete existing.rebuildNeeded
    existing.lastRequestAt = Date.now()
    return existing
  }

  /** The chat's next request pins the current plan set; kept across a restart too. */
  markRebuild(sessionID: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      const pin = this.pins.get(sessionID)
      if (pin !== undefined) {
        pin.rebuildNeeded = true
        return this.save(pin)
      }
      if (this.store === undefined) return Effect.void
      return markStoredRebuild(this.store, sessionID).pipe(
        Effect.catchCause((cause) => Effect.logWarning("plus could not mark a stored chat pin for rebuild", { sessionID, cause })),
      )
    })
  }

  dropPin(sessionID: string): Effect.Effect<void> {
    return Effect.suspend(() => {
      const agents = this.written.get(sessionID)?.agents
      this.pins.delete(sessionID)
      this.written.delete(sessionID)
      if (this.store === undefined) return Effect.void
      return removeStored(this.store, sessionID, agents).pipe(
        Effect.catchCause((cause) => Effect.logWarning("plus could not remove a chat's pinned prompt", { sessionID, cause })),
      )
    })
  }

  /** Forgets the pins in memory only: a later Plus instance restores them from the store. */
  clear(): void {
    this.pins.clear()
    this.written.clear()
  }
}

/**
 * The permission table a pin's tool narrowing reads. Each answer is kept on the pin
 * and stored with it, so the narrowed tools stay as first sent; after a restart only
 * a question never asked before reaches the current table.
 */
export function pinnedPermissions(pin: SessionPin, agent: string, table: PermissionTable): PermissionTable {
  const answers = pin.permissionAnswers.get(agent) ?? new Map<string, unknown>()
  pin.permissionAnswers.set(agent, answers)
  const remember = <A>(read: () => A, ...question: readonly string[]): A => {
    const key = JSON.stringify(question)
    // A stored answer of "none" comes back as null.
    if (answers.has(key)) return (answers.get(key) ?? undefined) as A
    const answer = read()
    answers.set(key, answer)
    return answer
  }
  return {
    rows: (target) => remember(() => table.rows(target), "rows", target),
    toolRows: (target, tool) => remember(() => table.toolRows(target, tool), "toolRows", target, tool),
    ruleRows: (target, tool) => remember(() => table.ruleRows(target, tool), "ruleRows", target, tool),
    teamMembers: table.teamMembers,
    describe: (target) => remember(() => table.describe(target), "describe", target),
  }
}

const restorePin = Effect.fnUntraced(function* (store: StorageDomain, sessionID: string, current: PlanSet) {
  const record = Option.getOrUndefined(decodeRecord(yield* store.get(recordKey(sessionID))))
  if (record === undefined) return undefined
  const stored = yield* Effect.forEach(record.agents, (agent) =>
    store.get(agentKey(sessionID, agent)).pipe(Effect.map((value) => [agent, Option.getOrUndefined(decodeAgent(value))] as const)),
  )
  const parts = new Map(
    stored.flatMap(([agent, part]) => (part === undefined || part.epoch !== record.epoch ? [] : [[agent, part] as const])),
  )
  const pin: SessionPin = {
    sessionID,
    model: {
      providerID: record.model.providerID,
      id: record.model.id,
      ...(record.model.variant === undefined ? {} : { variant: record.model.variant }),
    },
    planSet: restoredPlanSet(current, parts),
    pinnedSystem0: new Map([...parts].flatMap(([agent, part]) => (part.system0 === undefined ? [] : [[agent, part.system0] as const]))),
    pinnedRoles: new Map([...parts].map(([agent, part]) => [agent, part.role] as const)),
    permissionAnswers: new Map([...parts].map(([agent, part]) => [agent, new Map(part.permissionAnswers)] as const)),
    epoch: record.epoch,
    ...(record.lastNoteHash === undefined ? {} : { lastNoteHash: record.lastNoteHash }),
    lastRequestAt: record.lastRequestAt,
    ...(record.rebuildNeeded === true ? { rebuildNeeded: true } : {}),
  }
  const written: Written = {
    agents: new Set(record.agents),
    parts: new Map([...parts.keys()].map((agent) => [agent, markOf(pin, agent)] as const)),
  }
  return { pin, written }
})

// The stored agents' plans in place of their current ones; any other agent the
// chat switches to starts from the current plan set, as a first use would.
function restoredPlanSet(current: PlanSet, parts: ReadonlyMap<string, StoredAgent>): PlanSet {
  const others = <T extends { readonly agent: string }>(plans: readonly T[]) => plans.filter((plan) => !parts.has(plan.agent))
  const stored = [...parts]
  return createPlanSet({
    roles: new Map([
      ...[...current.roles].filter(([agent]) => !parts.has(agent)),
      ...stored.flatMap(([agent, part]) => (part.role === "" ? [] : [[agent, part.role] as const])),
    ]),
    base: [...others(current.base), ...stored.flatMap(([, part]) => part.base)],
    native: [...others(current.native), ...stored.flatMap(([, part]) => part.native)],
    instructions: [...others(current.instructions), ...stored.flatMap(([, part]) => part.instructions)],
    scrubByAgent: new Map([...current.scrubByAgent, ...stored.map(([agent, part]) => [agent, part.scrub] as const)]),
    // One flag for every agent, as on the pin it was stored from.
    needsNarrowing: stored.length === 0 ? current.needsNarrowing : stored.some(([, part]) => part.narrowing),
    permissions: current.permissions,
    customByAgent: new Set([
      ...[...current.customByAgent].filter((agent) => !parts.has(agent)),
      ...stored.flatMap(([agent, part]) => (part.custom ? [agent] : [])),
    ]),
    orders: new Map([
      ...[...current.orders].filter(([agent]) => !parts.has(agent)),
      ...stored.flatMap(([agent, part]) => (part.order === undefined ? [] : [[agent, part.order] as const])),
    ]),
  })
}

function agentPart(pin: SessionPin, agent: string): StoredAgent {
  const own = <T extends { readonly agent: string }>(plans: readonly T[]) => plans.filter((plan) => plan.agent === agent)
  const system0 = pin.pinnedSystem0.get(agent)
  const order = pin.planSet.orders.get(agent)
  return {
    epoch: pin.epoch,
    ...(system0 === undefined ? {} : { system0 }),
    role: pin.planSet.roles.get(agent) ?? "",
    base: own(pin.planSet.base),
    native: own(pin.planSet.native),
    instructions: own(pin.planSet.instructions),
    scrub: pin.planSet.scrubByAgent.get(agent) ?? [],
    ...(order === undefined ? {} : { order }),
    custom: pin.planSet.customByAgent.has(agent),
    narrowing: pin.planSet.needsNarrowing,
    permissionAnswers: [...(pin.permissionAnswers.get(agent) ?? [])].map(([key, answer]) => [key, answer ?? null] as const),
  }
}

function recordOf(pin: SessionPin, agents: ReadonlySet<string>): StoredRecord {
  return {
    version: 1,
    epoch: pin.epoch,
    model: pin.model,
    lastRequestAt: pin.lastRequestAt,
    ...(pin.lastNoteHash === undefined ? {} : { lastNoteHash: pin.lastNoteHash }),
    ...(pin.rebuildNeeded === true ? { rebuildNeeded: true } : {}),
    agents: [...agents],
  }
}

function markOf(pin: SessionPin, agent: string): PartMark {
  return {
    planSet: pin.planSet,
    epoch: pin.epoch,
    system0: pin.pinnedSystem0.get(agent),
    answers: pin.permissionAnswers.get(agent)?.size ?? 0,
  }
}

function sameMark(a: PartMark | undefined, b: PartMark): boolean {
  return a !== undefined && a.planSet === b.planSet && a.epoch === b.epoch && a.system0 === b.system0 && a.answers === b.answers
}

const markStoredRebuild = Effect.fnUntraced(function* (store: StorageDomain, sessionID: string) {
  const record = Option.getOrUndefined(decodeRecord(yield* store.get(recordKey(sessionID))))
  if (record === undefined || record.rebuildNeeded === true) return
  yield* store.set(recordKey(sessionID), JSON.stringify({ ...record, rebuildNeeded: true }))
})

const removeStored = Effect.fnUntraced(function* (store: StorageDomain, sessionID: string, known?: ReadonlySet<string>) {
  const agents = known ?? Option.getOrUndefined(decodeRecord(yield* store.get(recordKey(sessionID))))?.agents ?? []
  yield* Effect.forEach(agents, (agent) => store.remove(agentKey(sessionID, agent)), { discard: true })
  yield* store.remove(recordKey(sessionID))
})

// Drops stored pins idle past every cache lifetime. A record this version cannot
// read (a newer release's) is left alone.
export function sweepStoredPins(store: StorageDomain, now: number, after?: string): Effect.Effect<void> {
  return store.scan({ prefix: RECORD_PREFIX, limit: 500, ...(after === undefined ? {} : { after }) }).pipe(
    Effect.flatMap((page) =>
      Effect.forEach(
        page.entries,
        (entry) => {
          const record = Option.getOrUndefined(decodeRecord(entry.value))
          if (record === undefined || now - record.lastRequestAt < PIN_RETENTION_MS) return Effect.void
          return removeStored(store, entry.key.slice(RECORD_PREFIX.length), new Set(record.agents))
        },
        { discard: true },
      ).pipe(Effect.andThen(page.next === undefined ? Effect.void : sweepStoredPins(store, now, page.next))),
    ),
    Effect.catchCause((cause) => Effect.logWarning("plus could not sweep stored chat pins", { cause })),
  )
}

export const sessionPins = new SessionPinManager()

function instructionLabel(filePath: string): string {
  if (filePath === teachingFilePath()) return "Teaching"
  if (filePath === guidancePath()) return "Tools and rules"
  if (isModelPromptFile(filePath)) return `model prompt ${path.basename(filePath, ".md")}`
  return path.basename(filePath)
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex")
}

export async function isRebuildMoment(
  pin: SessionPin,
  event: SessionContext,
  now = Date.now(),
): Promise<boolean> {
  if (pin.rebuildNeeded === true) return true
  if (
    String(event.model.providerID) !== pin.model.providerID ||
    String(event.model.id) !== pin.model.id
  ) {
    return true
  }
  const lifetime = cacheLifetime({ provider: pin.model.providerID, model: pin.model.id } as unknown as RequestRow)
  if (lifetime === undefined) return false
  const idle = now - pin.lastRequestAt
  if (idle <= lifetime) return false
  const warm = await isSessionWarm(pin.sessionID, now).catch(() => false)
  if (warm) return false
  return true
}

export function computeChangeNote(
  pin: SessionPin,
  current: PlanSet,
  agent: string,
): { noteText: string; hash: string } | undefined {
  const items: string[] = []

  // 1. Role text / sections. An empty pinned role is never a change here:
  // checkAndEmitChangeNote adopts a role the pin lacked before diffing. A
  // team member's role this plan set has not seen yet is not removed either:
  // a chat moved to a new folder meets its first publish.
  const pinnedRole = pin.planSet.roles.get(agent) ?? ""
  const currentRole = current.roles.get(agent) ?? ""
  if (pinnedRole.length > 0 && currentRole.length === 0) {
    if (!current.unseenRoles.has(agent)) items.push("Role text is removed.")
  } else if (pinnedRole.length > 0 && currentRole !== pinnedRole) {
    const pinSplit = derive(pinnedRole, "Role")
    const curSplit = derive(currentRole, "Role")
    if (curSplit.kind !== "whole" && curSplit.sections.length > 0) {
      for (const sec of curSplit.sections) {
        const curText = slice(currentRole, sec).trim()
        const pinSec = pinSplit.sections.find((s) => s.name === sec.name || s.id === sec.id)
        const pinText = pinSec !== undefined ? slice(pinnedRole, pinSec).trim() : undefined
        if (pinText === undefined || curText !== pinText) {
          items.push(`Section "${sec.name}" replaces the earlier text:\n${curText}`)
        }
      }
      for (const pinSec of pinSplit.sections) {
        if (!curSplit.sections.some((s) => s.name === pinSec.name || s.id === pinSec.id)) {
          items.push(`Section "${pinSec.name}" is removed.`)
        }
      }
    } else {
      items.push(`Role text replaces the earlier text:\n${currentRole.trim()}`)
    }
  }

  // 2. Base template changes
  const pinBase = pin.planSet.base.find((b) => b.agent === agent)
  const curBase = current.base.find((b) => b.agent === agent)
  if (pinBase !== undefined && curBase !== undefined && pinBase.text !== curBase.text) {
    items.push(`Base template replaces the earlier text:\n${curBase.text.trim()}`)
  }

  // 3. System instruction rows; a model prompt only for the session's model
  const forModel = (p: InstructionPlan) => p.agent === agent && (p.models === undefined || matchesModel(p.models, { providerID: pin.model.providerID, id: pin.model.id }))
  const pinnedInstructions = pin.planSet.instructions.filter(forModel)
  const currentInstructions = current.instructions.filter(forModel)
  const pinByPath = new Map(pinnedInstructions.map((p) => [p.path, p]))
  const curByPath = new Map(currentInstructions.map((p) => [p.path, p]))

  for (const [filePath, curPlan] of curByPath) {
    const pinPlan = pinByPath.get(filePath)
    // A file edited where Plus changes nothing reaches the chat as OpenCode's own instruction
    // notice; a second note here would announce the same change twice. So does a file of
    // that kind that is new to the chat (one a folder move brought in).
    if (curPlan.asSource === true && (pinPlan === undefined || pinPlan.asSource === true)) continue
    const label = instructionLabel(filePath)
    if (pinPlan === undefined || !pinPlan.enabled) {
      if (curPlan.enabled) {
        items.push(`Instruction "${label}" is added:\n${curPlan.text.trim()}`)
      }
      continue
    }
    if (pinPlan.enabled && !curPlan.enabled) {
      items.push(`Instruction "${label}" is removed.`)
      continue
    }
    if (pinPlan.enabled && curPlan.enabled && pinPlan.text !== curPlan.text) {
      const curSplit = derive(curPlan.text, label)
      const pinSplit = derive(pinPlan.text, label)
      if (curSplit.kind !== "whole" && curSplit.sections.length > 0) {
        for (const sec of curSplit.sections) {
          const curText = slice(curPlan.text, sec).trim()
          const pinSec = pinSplit.sections.find((s) => s.name === sec.name || s.id === sec.id)
          const pinText = pinSec !== undefined ? slice(pinPlan.text, pinSec).trim() : undefined
          if (pinText === undefined || curText !== pinText) {
            items.push(`Section "${sec.name}" in ${label} replaces the earlier text:\n${curText}`)
          }
        }
      } else {
        items.push(`Instruction "${label}" replaces the earlier text:\n${curPlan.text.trim()}`)
      }
    }
  }

  for (const [filePath, pinPlan] of pinByPath) {
    if (pinPlan.asSource === true) continue
    if (pinPlan.enabled && !curByPath.has(filePath)) {
      items.push(`Instruction "${instructionLabel(filePath)}" is removed.`)
    }
  }

  // 4. Tools turned off
  const pinnedTools = pin.planSet.native.filter((p) => p.agent === agent)
  const currentTools = current.native.filter((p) => p.agent === agent)
  const pinToolMap = new Map(pinnedTools.map((p) => [p.tool, p]))
  const curToolMap = new Map(currentTools.map((p) => [p.tool, p]))

  for (const [tool, pinTool] of pinToolMap) {
    if (!pinTool.enabled) continue
    const curTool = curToolMap.get(tool)
    if (curTool === undefined || !curTool.enabled) {
      items.push(`Tool "${tool}" is turned off and will be refused from now on.`)
    }
  }

  // 5. Tools turned on or description changed
  for (const [tool, curTool] of curToolMap) {
    if (!curTool.enabled) continue
    const pinTool = pinToolMap.get(tool)
    if (pinTool === undefined || !pinTool.enabled) {
      items.push(`Tool "${tool}" is turned on (available after the next rebuild).`)
      continue
    }
    if (pinTool.enabled && pinTool.text !== curTool.text) {
      items.push(`Tool "${tool}" description changed (available after the next rebuild).`)
    }
    if (pinTool.enabled && JSON.stringify(pinTool.params ?? []) !== JSON.stringify(curTool.params ?? [])) {
      items.push(`Tool "${tool}" parameters changed (available after the next rebuild).`)
    }
  }

  if (items.length === 0) return undefined

  const noteText = `The following system instructions and tool settings have changed:\n\n${items.join("\n\n")}`
  const hash = sha256(noteText)
  return { noteText, hash }
}

export async function checkAndEmitChangeNote(
  ctx: Context,
  pin: SessionPin,
  current: PlanSet,
  agent: string,
  sessionID: string,
): Promise<string | undefined> {
  adoptEmptyPinnedRole(pin, current, agent)
  locatePinnedInstructions(pin, ctx.location.directory)
  const diff = computeChangeNote(pin, current, agent)
  if (diff === undefined) return undefined
  if (pin.lastNoteHash === diff.hash) return undefined

  pin.lastNoteHash = diff.hash
  if (typeof ctx.session?.synthetic === "function") {
    await Effect.runPromise(
      ctx.session.synthetic({
        sessionID: Session.ID.make(sessionID),
        text: diff.noteText,
        delivery: "steer",
        resume: false,
      } as never).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("failed to admit synthetic instruction update note", { sessionID, cause }),
        ),
      ),
    )
  }
  return diff.noteText
}

// A pin stored before plans named their files absolutely holds relative ids.
// They are resolved against the folder serving the chat, as applying the pin
// does, so the diff against the current plans does not announce each edited
// file as removed and added again.
function locatePinnedInstructions(pin: SessionPin, directory: string): void {
  if (pin.planSet.instructions.every((plan) => path.isAbsolute(plan.path))) return
  pin.planSet = {
    ...pin.planSet,
    instructions: pin.planSet.instructions.map((plan) => (path.isAbsolute(plan.path) ? plan : { ...plan, path: path.resolve(directory, plan.path) })),
  }
}

// A role the pin never had (the agent had none at the first request) is taken
// into the pin without a note: later edits must diff against it. The model
// gets the role through the system prompt instead: dropping the pinned system
// prompt makes the next request re-pin the current one, role included (one
// prefix change, no note). The PlanSet is shared by every session pinned at
// its version, so the roles map is copied instead of edited in place.
function adoptEmptyPinnedRole(pin: SessionPin, current: PlanSet, agent: string): void {
  const pinnedRole = pin.planSet.roles.get(agent) ?? ""
  const currentRole = current.roles.get(agent) ?? ""
  if (pinnedRole.length > 0 || currentRole.length === 0) return
  pin.planSet = { ...pin.planSet, roles: new Map(pin.planSet.roles).set(agent, currentRole) }
  pin.pinnedRoles.set(agent, currentRole)
  pin.pinnedSystem0.delete(agent)
}

export const handlePromptBoundary = Effect.fnUntraced(function* (
  ctx: Context,
  state: {
    sessionPins?: SessionPinManager
    currentPlanSet?: PlanSet
  },
  sessionID: string,
) {
  const pinManager = state.sessionPins ?? sessionPins
  const current = state.currentPlanSet
  if (current === undefined) return
  const pin = yield* pinManager.load(sessionID, current)
  if (pin === undefined) return
  // A chat marked for a rebuild (after a compaction, for one) gets the current text in its
  // system prompt on its next request; a note now would announce the same change twice.
  if (pin.rebuildNeeded === true) return

  const now = Date.now()
  const lifetime = cacheLifetime({ provider: pin.model.providerID, model: pin.model.id } as unknown as RequestRow)
  if (lifetime !== undefined && now - pin.lastRequestAt > lifetime) {
    const warm = yield* Effect.promise(() => isSessionWarm(sessionID, now).catch(() => false))
    if (!warm) {
      pinManager.repinSession(sessionID, pin.model, current)
      return
    }
  }

  // Only this session's own agent can change what its model sees. An
  // unreadable session has no agent to check, so it yields no note.
  const session = yield* ctx.session.get({ sessionID: Session.ID.make(sessionID) }).pipe(
    Effect.catchCause(() => Effect.succeed(undefined)),
  )
  const agent = session?.agent
  if (agent === undefined) return
  yield* Effect.promise(() => checkAndEmitChangeNote(ctx, pin, current, agent, sessionID))
})
