import { fingerprint, parsePermItemId, resolutionChain, scopedTo, type Address, type Item, type RuleRecord, type Scopes } from "./model.js"

/** Shared rules stored in project/global files are displayed in the Defaults inventory. */
export function ownRule(records: readonly RuleRecord[], address: Address): RuleRecord | undefined {
  const parsed = parsePermItemId(address.item)
  if (parsed === undefined) return undefined
  const owners = address.level === "defaults" && address.agent === null
    ? (["project", "global", "defaults"] as const).map((level) => ({ ...address, level }))
    : [address]
  return owners.flatMap((owner) => records.filter((record) =>
    record.tool === parsed.tool && record.id === parsed.ruleId && scopedTo(record, owner),
  ))[0]
}

/** Definitions follow the same owner/preset/Defaults chain as row settings. */
export function ruleAt(records: readonly RuleRecord[], scopes: Scopes, address: Address): RuleRecord | undefined {
  const parsed = parsePermItemId(address.item)
  if (parsed === undefined) return undefined
  return resolutionChain(address, scopes).flatMap((node) => {
    if (node.shipped !== undefined) return []
    const record = ownRule(records, { ...node, item: address.item, section: null })
    return record === undefined ? [] : [record]
  })[0]
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
