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
  readonly text?: string
  readonly state?: CustomizationState
  readonly reviewed?: string
}

export function mergeCustomization(
  customizations: readonly Customization[],
  item: Item,
  agent: string,
  fields: MergeCustomizationFields,
): Customization[] {
  const existing = customizations.find((record) => record.item === item.id && record.agent === agent)
  const text = fields.text ?? existing?.text
  const state = fields.state ?? existing?.state ?? "inherit"
  const reviewed = fields.reviewed ?? existing?.reviewed
  const record: Customization = {
    item: item.id,
    agent,
    state,
    basedOn: existing?.basedOn ?? item.fingerprint,
    updated: new Date().toISOString(),
    ...(text === undefined ? {} : { text }),
    ...(reviewed === undefined ? {} : { reviewed }),
  }
  return [...customizations.filter((entry) => !(entry.item === item.id && entry.agent === agent)), record]
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
  return {
    text: resolved?.text ?? item.text,
    enabled: item.available && resolved?.state !== "disabled",
    customized: isCustomized(item, resolved),
    review: isReview(item, resolved),
  }
}

function isCustomized(item: Item, resolved: Customization | undefined): boolean {
  if (!resolved) return false
  if (resolved.text !== undefined) return true
  return deviates(resolved.state, item.available)
}

function isReview(item: Item, resolved: Customization | undefined): boolean {
  if (!resolved) return false
  if (!isCustomized(item, resolved)) return false
  return resolved.basedOn !== item.fingerprint && resolved.reviewed !== item.fingerprint
}

function deviates(state: CustomizationState, available: boolean): boolean {
  if (state === "inherit") return false
  if (state === "enabled") return !available
  return available
}
