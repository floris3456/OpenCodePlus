import type { Agent } from "@opencode/schema/agent"
import { fingerprint, sameTeam, type Address, type CustomizationRecord, type Item } from "./model.js"
import { toolModeError } from "./tool-mode.js"

// These are ordinary customization rows. Boolean settings use state; scalar
// settings use text. Empty steps/color/model clear that optional field; empty
// instructions are an explicit empty prompt. Reset resumes inheritance.
export const controlIds = [
  "setting:enabled", "setting:mode", "setting:description", "setting:hidden", "setting:color", "setting:steps",
  "compaction:strategy", "compaction:model", "compaction:instructions",
] as const
export type ControlId = typeof controlIds[number]
export type AgentControls = Partial<Pick<Agent.Info, "mode" | "description" | "hidden" | "color" | "steps">> & {
  readonly disabled?: boolean
  readonly compaction?: Agent.Compaction
}

export function isControl(id: string): id is ControlId {
  return (controlIds as readonly string[]).includes(id)
}

export function booleanControl(id: string): boolean {
  return id === "setting:enabled" || id === "setting:hidden"
}

/** Prefer the addressed member's upstream, then the standalone agent, then defaults. */
// Items by id, once per items array (tree rows look controls up per agent).
const rowsById = new WeakMap<readonly Item[], Map<string, Item[]>>()

export function controlItemFor(items: readonly Item[], address: Pick<Address, "agent" | "item" | "team" | "memberOf">): Item | undefined {
  const index = rowsById.get(items) ?? Map.groupBy(items, (item) => item.id)
  rowsById.set(items, index)
  const rows = index.get(address.item) ?? []
  const team = address.team ?? address.memberOf
  return rows.find((item) => item.agents?.includes(address.agent ?? "") && sameTeam(item.controlTeam, team))
    ?? rows.find((item) => item.agents?.includes(address.agent ?? "") && item.controlTeam === undefined)
    ?? rows.find((item) => item.agents === undefined)
}

export function controlItems(agent?: string, fields: AgentControls = {}, inheritedInstructions = ""): Item[] {
  const model = fields.compaction?.model
  const texts: Record<ControlId, string> = {
    "setting:enabled": "",
    "setting:mode": fields.mode ?? "primary",
    "setting:description": fields.description ?? "",
    "setting:hidden": "",
    "setting:color": fields.color ?? "",
    "setting:steps": fields.steps === undefined ? "" : String(fields.steps),
    "compaction:strategy": fields.compaction?.strategy ?? "auto",
    "compaction:model": model === undefined ? "" : `${model.providerID}/${model.id}${model.variant === undefined ? "" : `#${model.variant}`}`,
    "compaction:instructions": fields.compaction?.system ?? inheritedInstructions,
  }
  return controlIds.map((id, order) => ({
    id,
    kind: id.startsWith("setting:") ? "setting" : "compaction",
    group: "none",
    title: id.slice(id.indexOf(":") + 1),
    text: texts[id],
    enabled: id === "setting:enabled" ? fields.disabled !== true : id === "setting:hidden" ? fields.hidden === true : true,
    fingerprint: fingerprint(texts[id]),
    order,
    ...(agent === undefined ? {} : { agents: [agent] }),
  }))
}

/** Validation at the shared mutation boundary (Tool and TUI both call it). */
export function controlRecordError(record: Pick<CustomizationRecord, "item" | "section" | "text" | "state" | "pin">): string | undefined {
  if (record.item.startsWith("toolmode:")) return toolModeError(record)
  if (!record.item.startsWith("setting:") && !record.item.startsWith("compaction:")) return undefined
  if (!isControl(record.item)) return `Unknown agent control ${record.item}`
  if (record.pin !== undefined) return `${record.item} does not support pins`
  // A sectioned text control: only the agent/member description and the
  // agent-wide compaction instructions hold text that sections address (B7).
  // A section record carries the section's text and its on/off state; only the
  // whole row keeps the scalar/enumerated rules below.
  const sectioned = record.item === "setting:description" || record.item === "compaction:instructions"
  if (record.section !== null) {
    if (!sectioned) return `${record.item} does not support sections`
    return undefined
  }
  if (booleanControl(record.item)) return record.text === undefined ? undefined : `${record.item} accepts state on/off, not text`
  if (record.state !== undefined) return `${record.item} accepts text, not state`
  const text = record.text
  if (text === undefined) return undefined
  if (record.item === "setting:mode" && !["primary", "subagent", "all"].includes(text)) return "Mode must be primary, subagent, or all"
  if (record.item === "setting:steps" && text !== "" && (!/^[1-9]\d*$/.test(text) || !Number.isSafeInteger(Number(text)))) return "Steps must be a positive integer or empty (unlimited)"
  if (record.item === "setting:color" && text !== "" && !/^#[0-9a-fA-F]{6}$/.test(text)) return "Color must be a six-digit #RRGGBB value or empty"
  if (record.item === "compaction:strategy" && !["auto", "local", "remote"].includes(text)) return "Compaction strategy must be auto, local, or remote"
  if (record.item === "compaction:model" && text !== "" && !/^[^/\s#]+\/[^\s#]+(?:#[^\s#]+)?$/.test(text)) return "Compaction model must be provider/model with an optional #variant, or empty (inherit the maintenance compaction model, otherwise the active session model)"
  return undefined
}
