import { createHash } from "node:crypto"

export type ItemKind = "prompt" | "skill" | "tool" | "mcp" | "instruction"

export type CustomizationState = "inherit" | "enabled" | "disabled"

export interface Item {
  id: string
  kind: ItemKind
  owner: string
  title: string
  text: string
  agents: string[]
  fingerprint: string
  available: boolean
}

export interface Customization {
  item: string
  agent: string
  text?: string
  state: CustomizationState
  basedOn: string
  reviewed?: string
  updated: string
}

export interface Snapshot {
  revision: number
  items: Item[]
  customizations: Customization[]
}

export interface Effective {
  text: string
  enabled: boolean
  customized: boolean
  review: boolean
}

export function fingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

export interface MergeCustomizationFields {
  // undefined preserves the field, null clears it, a value sets it.
  readonly text?: string | null
  readonly state?: CustomizationState
  readonly reviewed?: string | null
}

export function mergeCustomization(
  customizations: readonly Customization[],
  item: Item,
  agent: string,
  fields: MergeCustomizationFields,
): Customization[] {
  const existing = customizations.find((record) => record.item === item.id && record.agent === agent)
  const rest = customizations.filter((entry) => !(entry.item === item.id && entry.agent === agent))
  const text = resolveOptional(existing?.text, fields.text)
  const state = fields.state ?? existing?.state ?? "inherit"
  const reviewed = resolveOptional(existing?.reviewed, fields.reviewed)
  const inherited = inheritedAvailable(customizations, item, agent)
  if (text === undefined && !deviates(state, inherited) && reviewed === undefined) return rest
  const record: Customization = {
    item: item.id,
    agent,
    state,
    basedOn: existing?.basedOn ?? item.fingerprint,
    updated: new Date().toISOString(),
    ...(text === undefined ? {} : { text }),
    ...(reviewed === undefined ? {} : { reviewed }),
  }
  return [...rest, record]
}

function resolveOptional(existing: string | undefined, update: string | null | undefined): string | undefined {
  if (update === undefined) return existing
  if (update === null) return undefined
  return update
}

export function resetFields(item: { kind: string }): MergeCustomizationFields {
  if (item.kind === "mcp") return { state: "inherit" }
  return { text: null, reviewed: null, state: "inherit" }
}

export function canReset(snapshot: Snapshot, item: Item, agent: string): boolean {
  const own = snapshot.customizations.find((record) => record.item === item.id && record.agent === agent)
  if (!own) return false
  const inherited = inheritedAvailable(snapshot.customizations, item, agent)
  if (item.kind !== "mcp" && own.text !== undefined) return true
  return deviates(own.state, inherited)
}

export function applies(item: Item, agent: string): boolean {
  return item.agents.length === 0 || item.agents.includes(agent)
}

export function override(snapshot: Snapshot, itemID: string, agent: string): Customization | undefined {
  const own = snapshot.customizations.find((record) => record.item === itemID && record.agent === agent)
  if (!own) return snapshot.customizations.find((record) => record.item === itemID && record.agent === "*")
  const shared = snapshot.customizations.find((record) => record.item === itemID && record.agent === "*")
  if (!shared || agent === "*") return own
  return { ...own, text: own.text ?? shared.text, state: own.state === "inherit" ? shared.state : own.state }
}

export function effective(snapshot: Snapshot, item: Item, agent: string): Effective {
  const resolved = override(snapshot, item.id, agent)
  const inherited = inheritedAvailable(snapshot.customizations, item, resolved?.agent ?? agent)
  return {
    text: resolved?.text ?? item.text,
    // Plus can genuinely enable an upstream-disabled MCP server by deleting
    // `disabled` from config, whereas it cannot conjure missing skills or tools.
    enabled:
      resolved?.state === "disabled"
        ? false
        : resolved?.state === "enabled"
          ? item.kind === "mcp" || item.available
          : item.available,
    customized: isCustomized(item, resolved, inherited),
    review: isReview(item, resolved, inherited),
  }
}

function isCustomized(item: Item, resolved: Customization | undefined, inherited: boolean): boolean {
  if (!resolved) return false
  if (resolved.text !== undefined) return true
  return deviates(resolved.state, inherited)
}

function isReview(item: Item, resolved: Customization | undefined, inherited: boolean): boolean {
  if (!resolved) return false
  if (!isCustomized(item, resolved, inherited)) return false
  return resolved.basedOn !== item.fingerprint && resolved.reviewed !== item.fingerprint
}

function deviates(state: CustomizationState, available: boolean): boolean {
  if (state === "inherit") return false
  if (state === "enabled") return !available
  return available
}

function inheritedAvailable(customizations: readonly Customization[], item: Item, agent: string): boolean {
  if (agent !== "*") {
    const shared = customizations.find((record) => record.item === item.id && record.agent === "*")
    if (shared && shared.state !== "inherit") return shared.state === "enabled"
  }
  return item.available
}
