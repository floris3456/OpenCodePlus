import { parsePermItemId } from "./model.js"
import { tabOfGroupId } from "./folders.js"
import { parseModelDefaultItemId, parseModelFieldItemId, parseModelSettingItemId } from "./model-settings.js"
import type { RowlinkEndpoint } from "./rowlinks.js"
import { findLazy, lazyPath, materialize, type Lazy, type Memo, type TreeNode } from "./tree.js"

export interface ReflectedRows {
  readonly targets: readonly TreeNode[]
  readonly skipped: readonly { readonly id: string; readonly reason: string }[]
}

export function modelActivationRefusal(rows: readonly TreeNode[]): string | undefined {
  const owners = rows.flatMap((row) => row.address?.item.startsWith("model:")
    ? [JSON.stringify([row.address.level, row.address.agent, row.address.team, row.address.catalogue])] : [])
  return new Set(owners).size === owners.length ? undefined : "Only one model can be active per owner; select one model per owner"
}

/** Match settings by identity inside selected roots, independently of placement. */
export function reflectedRows(memo: Memo, focused: string, selected: readonly string[]): ReflectedRows {
  const path = lazyPath(memo, focused)
  const focus = path.at(-1)
  if (focus === undefined) return { targets: [], skipped: [{ id: focused, reason: "Row no longer exists" }] }
  const source = path.toReversed().find((row) => selected.includes(row.id))
  if (source === undefined) return { targets: [materialize(focus)], skipped: [] }
  const key = relativeKey(memo, source, focus)
  const targets: TreeNode[] = []
  const skipped: { id: string; reason: string }[] = []
  const seen = new Set<string>()
  for (const id of new Set(selected)) {
    const root = findLazy(memo, id)
    if (root === undefined) {
      skipped.push({ id, reason: "Row no longer exists" })
      continue
    }
    const target = source.id === focus.id ? root : corresponding(memo, root, root, key)
    if (target === undefined) {
      skipped.push({ id, reason: "Does not have the corresponding setting" })
      continue
    }
    const identity = target.address === undefined ? target.id : JSON.stringify(target.address)
    if (seen.has(identity)) continue
    seen.add(identity)
    targets.push(materialize(target))
  }
  return { targets, skipped }
}

/** Rebase a related row (for example a link endpoint) alongside a reflected edit. */
export function reflectedPeer(memo: Memo, focused: string, target: string, selected: readonly string[], peer: string): TreeNode | undefined {
  if (focused === target) {
    const row = findLazy(memo, peer)
    return row === undefined ? undefined : materialize(row)
  }
  const source = lazyPath(memo, focused).toReversed().find((row) => selected.includes(row.id))
  const destination = lazyPath(memo, target).toReversed().find((row) => selected.includes(row.id))
  const path = lazyPath(memo, peer)
  const row = path.at(-1)
  if (source === undefined || destination === undefined || row === undefined) return undefined
  if (path.some((parent) => parent.id === source.id)) {
    const found = corresponding(memo, destination, destination, relativeKey(memo, source, row))
    return found === undefined ? undefined : materialize(found)
  }
  // An endpoint outside the selected subtree retains its identity in the new
  // owner's view, rather than remaining linked to the source owner's row.
  const sourceOwner = lazyPath(memo, focused).findLast((parent) => parent.owner !== undefined)
  const targetOwner = lazyPath(memo, target).findLast((parent) => parent.owner !== undefined)
  if (sourceOwner === undefined || targetOwner === undefined) return undefined
  const found = corresponding(memo, targetOwner, targetOwner, relativeKey(memo, sourceOwner, row))
  return found === undefined ? undefined : materialize(found)
}

export function reflectedEndpoint(memo: Memo, focused: string, target: string, selected: readonly string[], endpoint: RowlinkEndpoint): RowlinkEndpoint | undefined {
  if (focused === target) return endpoint
  const owner = lazyPath(memo, focused).findLast((parent) => parent.owner !== undefined)
  if (owner === undefined) return undefined
  const find = (row: Lazy): Lazy | undefined => {
    if (row.address?.item === endpoint.item && row.address.section === endpoint.section) return row
    for (const child of row.children()) {
      const found = find(child)
      if (found !== undefined) return found
    }
    return undefined
  }
  const source = find(owner)
  if (source === undefined) return undefined
  const found = reflectedPeer(memo, focused, target, selected, source.id)?.address
  return found === undefined ? undefined : { item: found.item, section: found.section }
}

function corresponding(memo: Memo, root: Lazy, row: Lazy, key: string): Lazy | undefined {
  if (relativeKey(memo, root, row) === key) return row
  for (const child of row.children()) {
    const found = corresponding(memo, root, child, key)
    if (found !== undefined) return found
  }
  return undefined
}

export function correspondingRow(source: Memo, root: Lazy, row: Lazy, destination: Memo, target: Lazy): Lazy | undefined {
  return row.id === root.id ? target : corresponding(destination, target, target, relativeKey(source, root, row))
}

function relativeKey(memo: Memo, root: Lazy, row: Lazy): string {
  const address = row.address
  if (address === undefined) return row.id === root.id ? "root" : `structure:${tabOfGroupId(row.id) ?? row.id.slice(root.id.length)}`
  const own = root.address
  const description = row.kind === "section" && address.section === null
  const section = address.section === null ? null : own?.section !== null && own?.section !== undefined
    ? address.section.slice(own.section.length) : address.section
  if (own?.item === address.item) return JSON.stringify(["self", section, description])
  if (own !== undefined && (own.item.startsWith("model:") || parseModelDefaultItemId(own.item) !== undefined)) {
    const field = parseModelFieldItemId(address.item)?.field ?? parseModelSettingItemId(address.item)?.field
    if (field !== undefined) return `model-field:${field}`
  }
  if (own?.item.startsWith("tool:") && address.item.startsWith("toolmode:")) return "exposure"
  const item = memo.ctx.items.find((item) => item.id === address.item)
  if (own?.item.startsWith("tool:") && item?.kind === "param") return JSON.stringify(["parameter", item.title, section, description])
  if ((own?.item.startsWith("tool:") || own?.item.startsWith("param:")) && item?.kind === "perm") {
    const rule = parsePermItemId(item.permissionSource ?? item.id)
    return JSON.stringify(["permission", own.item.startsWith("param:") ? null : item.permissionParameter ?? null, rule?.ruleId ?? item.id])
  }
  return JSON.stringify([address.item, section, description])
}
