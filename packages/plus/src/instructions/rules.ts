import { fingerprint, parsePermItemId, resolutionChain, scopedTo, type Address, type Item, type RuleRecord, type Scopes } from "./model.js"

const ruleIndexes = new WeakMap<readonly RuleRecord[], Map<string, RuleRecord[]>>()

/** Shared rules stored in project/global files are displayed in the Defaults inventory. */
export function ownRule(records: readonly RuleRecord[], address: Address): RuleRecord | undefined {
  const parsed = parsePermItemId(address.item)
  if (parsed === undefined) return undefined
  const candidates = ruleIndexOf(records).get(`${parsed.tool}\u0000${parsed.ruleId}`)
  if (candidates === undefined) return undefined
  const owners = address.level === "defaults" && address.agent === null
    ? (["project", "global", "defaults"] as const).map((level) => ({ ...address, level }))
    : [address]
  for (const owner of owners) {
    const record = candidates.find((record) => scopedTo(record, owner))
    if (record !== undefined) return record
  }
  return undefined
}

/** Definitions follow the same owner/preset/Defaults chain as row settings. */
export function ruleAt(records: readonly RuleRecord[], scopes: Scopes, address: Address): RuleRecord | undefined {
  const parsed = parsePermItemId(address.item)
  if (parsed === undefined) return undefined
  // Most rule rows have no record anywhere: answer before resolving the chain.
  if (!ruleIndexOf(records).has(`${parsed.tool}\u0000${parsed.ruleId}`)) return undefined
  for (const node of resolutionChain(address, scopes)) {
    if (node.shipped !== undefined) continue
    const record = ownRule(records, { ...node, item: address.item, section: null })
    if (record !== undefined) return record
  }
  return undefined
}

// Rule records by tool and rule id, once per record list.
function ruleIndexOf(records: readonly RuleRecord[]): Map<string, RuleRecord[]> {
  const known = ruleIndexes.get(records)
  if (known !== undefined) return known
  const index = Map.groupBy(records, (record) => `${record.tool}\u0000${record.id}`)
  ruleIndexes.set(records, index)
  return index
}

export function ruleItem(item: Item, records: readonly RuleRecord[], scopes: Scopes, address: Address): Item | undefined {
  if (item.kind !== "perm") return item
  const record = ruleAt(records, scopes, address)
  if (record === undefined) return item.custom === true ? undefined : item
  const byRecord = ruleItems.get(item) ?? new WeakMap<RuleRecord, Map<string, Item>>()
  if (!ruleItems.has(item)) ruleItems.set(item, byRecord)
  const byOwner = byRecord.get(record) ?? new Map<string, Item>()
  if (!byRecord.has(record)) byRecord.set(record, byOwner)
  const ownerKey = record.agent === null ? "" : address.agent === null ? "\u0000" : `\u0001${address.agent}`
  const cached = byOwner.get(ownerKey)
  if (cached !== undefined) return cached
  const text = `${record.label}\n${record.patterns.join("\n")}`
  const built = {
    ...item, title: record.label, text, fingerprint: fingerprint(text), custom: true,
    patterns: record.patterns, keywords: record.keywords, message: record.message,
    ...(record.agent === null ? {} : { ownedBy: address.agent ?? undefined }),
  }
  byOwner.set(ownerKey, built)
  return built
}

// The rule's Item for one upstream item, record and owner: built once, since the tree resolves each permission row on every walk.
const ruleItems = new WeakMap<Item, WeakMap<RuleRecord, Map<string, Item>>>()
