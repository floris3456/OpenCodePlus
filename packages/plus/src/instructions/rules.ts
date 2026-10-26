import { fingerprint, parsePermItemId, resolutionChain, scopedTo, type Address, type Item, type RuleRecord, type Scopes } from "./model.js"

const ruleIndexes = new WeakMap<readonly RuleRecord[], Map<string, RuleRecord[]>>()

/** Shared rules stored in project/global files are displayed in the Defaults inventory. */
export function ownRule(records: readonly RuleRecord[], address: Address): RuleRecord | undefined {
  const parsed = parsePermItemId(address.item)
  if (parsed === undefined) return undefined
  let index = ruleIndexes.get(records)
  if (index === undefined) {
    index = new Map<string, RuleRecord[]>()
    for (const record of records) {
      const key = `${record.tool}\u0000${record.id}`
      const rows = index.get(key)
      if (rows === undefined) {
        index.set(key, [record])
        continue
      }
      rows.push(record)
    }
    ruleIndexes.set(records, index)
  }
  const candidates = index.get(`${parsed.tool}\u0000${parsed.ruleId}`)
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
  for (const node of resolutionChain(address, scopes)) {
    if (node.shipped !== undefined) continue
    const record = ownRule(records, { ...node, item: address.item, section: null })
    if (record !== undefined) return record
  }
  return undefined
}

export function ruleItem(item: Item, records: readonly RuleRecord[], scopes: Scopes, address: Address): Item | undefined {
  if (item.kind !== "perm") return item
  const record = ruleAt(records, scopes, address)
  if (record === undefined) return item.custom === true ? undefined : item
  const byOwner = ruleItems.get(item) ?? new Map<RuleRecord, Map<string, Item>>()
  ruleItems.set(item, byOwner)
  const byRecord = byOwner.get(record) ?? new Map<string, Item>()
  byOwner.set(record, byRecord)
  const ownerKey = record.agent === null ? "" : address.agent === null ? "\u0000" : `\u0001${address.agent}`
  const cached = byRecord.get(ownerKey)
  if (cached !== undefined) return cached
  const text = `${record.label}\n${record.patterns.join("\n")}`
  const built = {
    ...item, title: record.label, text, fingerprint: fingerprint(text), custom: true,
    patterns: record.patterns, keywords: record.keywords, message: record.message,
    ...(record.agent === null ? {} : { ownedBy: address.agent ?? undefined }),
  }
  byRecord.set(ownerKey, built)
  return built
}

// The rule's Item for one upstream item, record and owner: built once, since the tree resolves each permission row on every walk.
const ruleItems = new WeakMap<Item, WeakMap<RuleRecord, Map<string, Item>>>()
