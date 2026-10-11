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
      const key = JSON.stringify([record.tool, record.id])
      const rows = index.get(key)
      if (rows === undefined) {
        index.set(key, [record])
        continue
      }
      rows.push(record)
    }
    ruleIndexes.set(records, index)
  }
  const candidates = index.get(JSON.stringify([parsed.tool, parsed.ruleId]))
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
  const text = `${record.label}\n${record.patterns.join("\n")}`
  return {
    ...item, title: record.label, text, fingerprint: fingerprint(text), custom: true,
    patterns: record.patterns, keywords: record.keywords, message: record.message,
    ...(record.agent === null ? {} : { ownedBy: address.agent ?? undefined }),
  }
}
