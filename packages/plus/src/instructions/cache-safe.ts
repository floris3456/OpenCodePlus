import { createHash } from "node:crypto"
import path from "node:path"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Effect } from "effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionContext } from "@opencode/plugin/effect/session"
import type { PermissionTable } from "./permission-enforce.js"
import type { BasePlan, InstructionPlan, ToolPlan } from "./apply.js"
import { derive, slice } from "./sections.js"
import { cacheLifetime } from "../monitor/cache.js"
import type { RequestRow } from "../monitor/ledger.js"
import { isSessionWarm } from "../teams/cold-compaction.js"
import { guidancePath, teachingFilePath } from "./paths.js"

export interface PlanSet {
  readonly roles: ReadonlyMap<string, string>
  readonly base: readonly BasePlan[]
  readonly native: readonly ToolPlan[]
  readonly instructions: readonly InstructionPlan[]
  readonly scrubByAgent: ReadonlyMap<string, readonly string[]>
  readonly needsNarrowing: boolean
  readonly permissions: PermissionTable
  readonly customByAgent: ReadonlySet<string>
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
    version: planSetSeq,
  }
}

export interface SessionPin {
  readonly sessionID: string
  model: { providerID: string; id: string }
  planSet: PlanSet
  pinnedSystem0: Map<string, string>
  pinnedRoles: Map<string, string>
  lastNoteHash?: string
  lastRequestAt: number
  rebuildNeeded?: boolean
}

export class SessionPinManager {
  private readonly pins = new Map<string, SessionPin>()

  getPin(sessionID: string): SessionPin | undefined {
    return this.pins.get(sessionID)
  }

  pinSession(
    sessionID: string,
    model: { providerID: unknown; id: unknown },
    planSet: PlanSet,
  ): SessionPin {
    const pin: SessionPin = {
      sessionID,
      model: { providerID: String(model.providerID), id: String(model.id) },
      planSet,
      pinnedSystem0: new Map(),
      pinnedRoles: new Map(),
      lastRequestAt: Date.now(),
    }
    this.pins.set(sessionID, pin)
    return pin
  }

  repinSession(
    sessionID: string,
    model: { providerID: unknown; id: unknown },
    planSet: PlanSet,
  ): SessionPin {
    const existing = this.pins.get(sessionID)
    if (existing === undefined) {
      return this.pinSession(sessionID, model, planSet)
    }
    existing.model = { providerID: String(model.providerID), id: String(model.id) }
    existing.planSet = planSet
    existing.pinnedSystem0.clear()
    existing.pinnedRoles.clear()
    delete existing.lastNoteHash
    delete existing.rebuildNeeded
    existing.lastRequestAt = Date.now()
    return existing
  }

  markRebuild(sessionID: string): void {
    const pin = this.pins.get(sessionID)
    if (pin !== undefined) pin.rebuildNeeded = true
  }

  dropPin(sessionID: string): void {
    this.pins.delete(sessionID)
  }

  clear(): void {
    this.pins.clear()
  }
}

export const sessionPins = new SessionPinManager()

function instructionLabel(filePath: string): string {
  if (filePath === teachingFilePath()) return "Teaching"
  if (filePath === guidancePath()) return "Tools and rules"
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
  // checkAndEmitChangeNote adopts a role the pin lacked before diffing.
  const pinnedRole = pin.planSet.roles.get(agent) ?? ""
  const currentRole = current.roles.get(agent) ?? ""
  if (pinnedRole.length > 0 && currentRole.length === 0) {
    items.push("Role text is removed.")
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

  // 3. System instruction rows
  const pinnedInstructions = pin.planSet.instructions.filter((p) => p.agent === agent)
  const currentInstructions = current.instructions.filter((p) => p.agent === agent)
  const pinByPath = new Map(pinnedInstructions.map((p) => [p.path, p]))
  const curByPath = new Map(currentInstructions.map((p) => [p.path, p]))

  for (const [filePath, curPlan] of curByPath) {
    const pinPlan = pinByPath.get(filePath)
    const label = instructionLabel(filePath)
    if (pinPlan === undefined || !pinPlan.enabled) {
      if (curPlan.enabled) {
        items.push(`Instruction "${label}" replaces the earlier text:\n${curPlan.text.trim()}`)
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
  const pin = pinManager.getPin(sessionID)
  const current = state.currentPlanSet
  if (pin === undefined || current === undefined) return

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
