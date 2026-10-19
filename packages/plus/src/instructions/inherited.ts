import { controlItemFor, isControl } from "./agent-controls.js"
import { withoutFinalNewline } from "./merge-units.js"
import { applies, resolve, resolveEnabled, resolveSplit, type Address, type CustomizationRecord, type Item, type Level, type RuleRecord, type Scopes, type SplitRecord } from "./model.js"
import { ruleItem } from "./rules.js"

export interface InheritedInput {
  readonly items: readonly Item[]
  readonly rules: readonly RuleRecord[]
  readonly customizations: readonly CustomizationRecord[]
  readonly splits: readonly SplitRecord[]
  readonly scopes: Scopes
  readonly agents: readonly { readonly id: string }[]
  readonly teams: readonly { readonly level: Level; readonly team: string; readonly agents: readonly string[] }[]
}

type Field = "text" | "state" | "pin"

/**
 * The records without what their rows already inherit. A text, on/off or pin
 * is dropped when no row that reads it resolves differently without it, and a
 * record left with nothing it sets goes whole. What reaches the model is the
 * same either way; the rows stop showing an edit, show where their value
 * comes from, and the next save of the row stores none.
 *
 * Only records whose readers are known are looked at: an agent's own records
 * (read by that agent at its level and the more specific ones, alone and as a
 * team member) and a shared Defaults row's text and pin (the item's own text
 * and pin below it for every agent). A preset's, a team-scoped node's and a
 * pattern entry's records are read by agents not listed here, so they stay.
 */
export function withoutInherited(input: InheritedInput): CustomizationRecord[] {
  const known = new Set([...input.agents.map((agent) => agent.id), ...input.teams.flatMap((team) => team.agents)])
  return input.customizations.flatMap((record) => {
    // An edit for an agent that is gone is an orphan, kept for the person to decide on.
    if (record.agent !== null && !known.has(record.agent)) return [record]
    const readers = readersOf(input, record)
    if (readers === undefined) return [record]
    // A pin is a whole row's; one on a section is left as it is.
    const dropped = readers.fields.filter(
      (field) => record[field] !== undefined && !(field === "pin" && record.section !== null) && inherits(input, record, field, readers.addresses),
    )
    if (dropped.length === 0) return [record]
    const kept = dropped.reduce(strip, record)
    return kept.text === undefined && kept.state === undefined && kept.pin === undefined && kept.requires === undefined ? [] : [kept]
  })
}

// The upstream item a row reads: an agent's own variant of the item when
// several exist, or an agent control's item.
export function upstreamFor(items: readonly Item[], address: Address): Item | undefined {
  if (isControl(address.item)) return controlItemFor(items, address)
  const matches = items.filter((entry) => entry.id === address.item)
  const owner = address.agent
  if (owner === null) return matches[0]
  return matches.find((entry) => applies(entry, owner)) ?? matches[0]
}

function readersOf(input: InheritedInput, record: CustomizationRecord): { addresses: Address[]; fields: readonly Field[] } | undefined {
  const at = (level: Level): Address => ({ level, agent: record.agent, item: record.item, section: record.section })
  if (record.team !== undefined || record.level === "preset") return undefined
  if (record.agent === null) {
    // Below the shared row every agent falls back to the item: one item for
    // all of them, and on/off falls back differently per agent, so only text
    // and pin, and never a rule (its owner's rule record makes its text).
    if (record.level !== "defaults" || record.item.startsWith("perm:")) return undefined
    const matches = input.items.filter((item) => item.id === record.item)
    if (matches.length !== 1 || matches[0]?.agents !== undefined || matches[0]?.ownedBy !== undefined) return undefined
    return { addresses: [{ ...at("defaults"), ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }) }], fields: ["text", "pin"] }
  }
  if (/[*%]/.test(record.agent)) return undefined
  const agent = record.agent
  const levels: readonly Level[] = record.level === "project" ? ["project"] : record.level === "global" ? ["global", "project"] : ["defaults", "global", "project"]
  const teams = input.teams.filter((team) => team.agents.includes(agent))
  const member = teams.length > 0 || (input.scopes.memberTeams?.get(agent)?.length ?? 0) > 0
  return {
    addresses: levels.flatMap((level) => [
      at(level),
      ...teams.map((team) => ({ ...at(level), memberOf: { level: team.level, team: team.team } })),
      ...(member ? [{ ...at(level), catalogue: "teams" as const }] : []),
    ]),
    fields: ["text", "state", "pin"],
  }
}

function inherits(input: InheritedInput, record: CustomizationRecord, field: Field, addresses: readonly Address[]): boolean {
  const without = input.customizations.map((other) => (other === record ? strip(record, field) : other))
  return addresses.every((address) => {
    const item = upstreamFor(input.items, address)
    if (item === undefined) return false
    // A whole rule row reads the rule its owner stores, as the tree does (resolve-memo wholeOf).
    const upstream = address.section === null ? ruleItem(item, input.rules, input.scopes, address) : item
    if (upstream === undefined) return false
    const chain = { upstream, splits: input.splits, scopes: input.scopes, address }
    // A section the row no longer has is an orphan's: kept for the person to decide on.
    if (address.section !== null && !hasSection(input, upstream, address)) return false
    // A whole row's on/off alone needs no text assembled.
    if (field === "state" && address.section === null)
      return resolveEnabled({ ...chain, records: input.customizations }) === resolveEnabled({ ...chain, records: without })
    const before = resolve({ ...chain, records: input.customizations })
    const after = resolve({ ...chain, records: without })
    if (field === "state") return before.enabled === after.enabled
    if (field === "pin") return before.pinned === after.pinned
    return sameText(before.text, after.text) && sameText(before.fullText ?? before.text, after.fullText ?? after.text)
  })
}

// The row's sections as the tree splits them (resolve-memo splitOf): its text,
// or with section overrides its assembled text.
function hasSection(input: InheritedInput, upstream: Item, address: Address): boolean {
  const whole = { ...address, section: null }
  const resolved = resolve({ upstream, records: input.customizations, splits: input.splits, scopes: input.scopes, address: whole })
  return [resolved.text, resolved.fullText ?? resolved.text].some((text) =>
    resolveSplit({ text, title: upstream.title, splits: input.splits, scopes: input.scopes, address: whole }).sections.some((section) => section.id === address.section),
  )
}

// Texts compare without their final newline, as reviews do.
function sameText(left: string, right: string): boolean {
  return withoutFinalNewline(left) === withoutFinalNewline(right)
}

// A field goes with what records it was set against.
const fieldKeys = {
  text: ["text", "basedOnText", "acknowledged"],
  state: ["state", "basedOnState"],
  pin: ["pin", "basedOnPin"],
} as const satisfies Record<Field, readonly (keyof CustomizationRecord)[]>

function strip(record: CustomizationRecord, field: Field): CustomizationRecord {
  const next: Partial<Record<keyof CustomizationRecord, unknown>> = { ...record }
  for (const key of fieldKeys[field]) delete next[key]
  return next as CustomizationRecord
}
