// Saved category membership shared by the TUI and Instructions tools. New
// categories belong to one owner's tab. A tab without its own layout shows the
// first one down its owner's chain (tree.ts tabLayout), else the ownerless
// legacy layout; editing it copies that layout to the tab.

import { catalogueOf, fingerprint, type ChainNode } from "./model.js"

/** One folder in a tab. `items` are item ids and child folders (`folder:<id>`), in display order. */
export interface FolderRecord {
  readonly type: "folder"
  readonly level: "global" | "project"
  /** The owning tab's tree id; absent only on legacy shared folders. */
  readonly owner?: string
  readonly tab: string
  readonly id: string
  readonly name: string
  readonly parent?: string
  readonly items: readonly string[]
  readonly updated: string
}

/** The display order of one list: `tab:<tab>` or `sidebar`. Ids missing from it keep today's order after the listed ones. */
export interface OrderRecord {
  readonly type: "order"
  readonly level: "global" | "project"
  readonly scope: string
  readonly items: readonly string[]
  /**
   * A tab's own layout (scope `group:<tab id>`): the fingerprint of the layout
   * it inherited when it took its own copy, or when it was last kept
   * (layoutPrint). The copy is to review while what it inherits differs.
   * Absent: never reviewed.
   */
  readonly basedOn?: string
  readonly updated: string
}

/** The tab keys the tree uses for a row's group (`group:<level>:<owner>:<tab>`). */
export const tabKeys = ["settings", "models", "compaction", "tools", "base", "system", "mcp"] as const

/**
 * The owner segment of the Teams catalogue's shared inventory rows; the
 * Agents catalogue's is empty. Agent ids forbid `:` and never start with `/`,
 * so it can never collide with one.
 */
export const teamsOwnerSegment = "/teams"

/**
 * The order scope of one non-tab list: the direct children of a tree group that
 * is neither a tab nor a folder. S1b uses it for a tab's origin subgroups
 * (Tools › OpenCode, Tools › MCP) and for the sidebar's owner lists (agents,
 * teams, members) without touching the built-in headings they sit under.
 */
export function groupScope(groupId: string): string {
  return `group:${groupId}`
}

/** The tab an item row belongs to (the tab its inspector names as its home). */
export function tabOfItem(item: string): string {
  if (item.startsWith("model:") || item.startsWith("modeldefault:") || item.startsWith("modelsetting:")) return "models"
  if (item.startsWith("base:")) return "base"
  if (item.startsWith("system:")) return "system"
  if (item.startsWith("mcp:")) return "mcp"
  if (item.startsWith("compaction:")) return "compaction"
  if (item.startsWith("setting:")) return "settings"
  return "tools"
}

/** The tab key a tree group id ends with, if it is a tab. */
export function tabOfGroupId(id: string): string | undefined {
  if (id.endsWith(":system:instructions")) return "system"
  const match = /:(settings|models|compaction|tools|base|system|mcp)$/.exec(id)
  if (match?.[1] === undefined) return undefined
  // A tab group is `group:<level>:<owner>:<tab>`; an origin subgroup inside a
  // tab ends in a tab key too (Tools › MCP is `…:tools:mcp`), so a tab key
  // right before this one means a subgroup, not a tab.
  const previous = id.slice(0, id.length - match[1].length - 1).split(":").at(-1)
  return tabKeys.some((tab) => tab === previous) ? undefined : match[1]
}

export function folderSlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.length > 0 ? slug : "folder"
}

/** The list entry that names a child folder inside a folder or an order record. */
export function folderRef(id: string): string {
  return `folder:${id}`
}

/** The folder id an entry names, when it is a folder entry. */
export function folderIdOfRef(entry: string): string | undefined {
  return entry.startsWith("folder:") ? entry.slice("folder:".length) : undefined
}

export function folderOf(records: readonly FolderRecord[], id: string): FolderRecord | undefined {
  return records.find((folder) => folder.id === id)
}

/** The tab's top-level order record, if one exists. */
export function orderOf(records: readonly OrderRecord[], scope: string): OrderRecord | undefined {
  return records.find((order) => order.scope === scope)
}

/** The name of the folder that holds each item row directly, keyed by item id. */
export function folderNameByItem(records: readonly FolderRecord[]): ReadonlyMap<string, string> {
  return new Map(
    records.flatMap((folder) =>
      folder.items.filter((entry) => folderIdOfRef(entry) === undefined).map((item) => [item, folder.name] as const),
    ),
  )
}

/** The folder that holds an item row's whole row directly, if any. */
export function folderHolding(records: readonly FolderRecord[], item: string): FolderRecord | undefined {
  return records.find((folder) => folder.items.includes(item))
}

/** Folder ids from `id` up to the tab's top level, nearest first. Bounded, so a corrupt cycle ends. */
export function ancestorsOf(records: readonly FolderRecord[], id: string, hops: number = records.length): string[] {
  const folder = folderOf(records, id)
  if (folder?.parent === undefined || hops === 0) return []
  return [folder.parent, ...ancestorsOf(records, folder.parent, hops - 1)]
}

/** A new folder id in `tab`: `<tab>:<slug>`, numbered when the slug is taken. */
export function uniqueFolderId(records: readonly FolderRecord[], tab: string, name: string): string {
  const base = `${tab}:${folderSlug(name)}`
  const taken = new Set(records.map((folder) => folder.id))
  const candidates = [base, ...Array.from({ length: records.length + 1 }, (_, index) => `${base}-${index + 2}`)]
  return candidates.find((candidate) => !taken.has(candidate)) ?? base
}

/** Create a folder in `tab` (inside `parent` when given), listed last in its list. */
export function createFolderRecord(
  records: readonly (FolderRecord | OrderRecord)[],
  input: { readonly tab: string; readonly name: string; readonly parent?: string; readonly owner?: string },
  updated: string,
): (FolderRecord | OrderRecord)[] {
  const folders = records.filter((record): record is FolderRecord => record.type === "folder")
  const id = uniqueFolderId(folders, input.owner ?? input.tab, input.name)
  const folder: FolderRecord = {
    type: "folder",
    level: input.owner === undefined ? "global" : layoutLevel(input.owner),
    ...(input.owner === undefined ? {} : { owner: input.owner }),
    tab: input.tab,
    id,
    name: input.name.trim(),
    ...(input.parent === undefined ? {} : { parent: input.parent }),
    items: [],
    updated,
  }
  const listed =
    input.parent === undefined
      ? appendToOrder(records, input.tab, folderRef(id), updated)
      : records.map((record) =>
          record.type === "folder" && record.id === input.parent
            ? { ...record, items: [...record.items, folderRef(id)], updated }
            : record,
        )
  return [...listed, folder]
}

/** Rename a folder; its id and place stay. */
export function renameFolderRecord(
  records: readonly (FolderRecord | OrderRecord)[],
  id: string,
  name: string,
  updated: string,
): (FolderRecord | OrderRecord)[] {
  return records.map((record) =>
    record.type === "folder" && record.id === id ? { ...record, name: name.trim(), updated } : record,
  )
}

/**
 * Delete a folder. Its items and child folders take its place in the list it
 * sat in (its parent folder, or the tab's top-level order), in place.
 */
export function deleteFolderRecord(
  records: readonly (FolderRecord | OrderRecord)[],
  id: string,
  updated: string,
): (FolderRecord | OrderRecord)[] {
  const folder = folderOf(
    records.filter((record): record is FolderRecord => record.type === "folder"),
    id,
  )
  if (folder === undefined) return [...records]
  const ref = folderRef(id)
  const splice = (items: readonly string[]): string[] =>
    items.flatMap((entry) => (entry === ref ? folder.items : [entry]))
  return records.flatMap((record): (FolderRecord | OrderRecord)[] => {
    if (record.type === "folder" && record.id === id) return []
    if (record.type === "folder" && record.parent === id) return [{ ...reparent(record, folder.parent), updated }]
    if (!record.items.includes(ref)) return [record]
    return [{ ...record, items: splice(record.items), updated }]
  })
}

/** Why a whole folder and order set cannot be stored, or undefined when it can. */
export function layoutRefusal(folders: readonly FolderRecord[], orders: readonly OrderRecord[]): string | undefined {
  const ids = folders.map((folder) => folder.id)
  const duplicate = ids.find((id, index) => ids.indexOf(id) !== index)
  if (duplicate !== undefined) return `folder "${duplicate}" is listed twice`
  const badTab = folders.find((folder) => !tabKeys.some((tab) => tab === folder.tab))
  if (badTab !== undefined) return `folder "${badTab.name}" names no tab`
  const badParent = folders.find(
    (folder) => folder.parent !== undefined && (folderOf(folders, folder.parent)?.tab !== folder.tab || folderOf(folders, folder.parent)?.owner !== folder.owner),
  )
  if (badParent !== undefined) return `folder "${badParent.name}" must sit in a folder of its own tab`
  const badOwner = folders.find((folder) => folder.owner === undefined
    ? folder.level !== "global"
    : !/^group:(project|global|defaults|preset):/.test(folder.owner) || tabOfGroupId(folder.owner) !== folder.tab || folder.level !== layoutLevel(folder.owner))
  if (badOwner !== undefined) return `folder "${badOwner.name}" has an invalid owner or storage level`
  const cyclic = folders.find((folder) => ancestorsOf(folders, folder.id).includes(folder.id))
  if (cyclic !== undefined) return `folder "${cyclic.name}" cannot sit inside itself`
  const badScope = orders.find(
    (order) => order.scope !== "sidebar" && !order.scope.startsWith("group:") && !tabKeys.some((tab) => order.scope === `tab:${tab}`),
  )
  if (badScope !== undefined) return `order "${badScope.scope}" names no list`
  return undefined
}

export interface LayoutRecordSet {
  readonly folders: FolderRecord[]
  readonly orders: OrderRecord[]
}

export function layoutLevel(owner: string): "project" | "global" {
  return owner.startsWith("group:project:") ? "project" : "global"
}

type Layout = { readonly folders: readonly FolderRecord[]; readonly orders: readonly OrderRecord[] }

/**
 * The tab ids a chain node's owner lists `tab` under (tree.ts). A
 * team-scoped node is a member, a member preset, a Teams entry or a team's
 * Special agent; shipped nodes hold no records.
 */
export function ownerGroupIds(node: ChainNode, tab: string): string[] {
  if (node.shipped !== undefined) return []
  if (node.agent === null)
    return node.team === undefined ? [`group:${node.level}:${catalogueOf(node.catalogue) === "teams" ? teamsOwnerSegment : ""}:${tab}`] : []
  if (node.team === undefined) return [`group:${node.level}:${node.agent}:${tab}`]
  return [`group:${node.level}:${node.team.team}/:${node.agent}:${tab}`, `group:${node.level}:${node.team.team}/:special:${node.agent}:${tab}`]
}

/** Whether a tab keeps a layout of its own: an order record or a folder. */
export function hasOwnLayout(layout: Layout, owner: string): boolean {
  return layout.orders.some((order) => order.scope === groupScope(owner)) || layout.folders.some((folder) => folder.owner === owner)
}

/** The tab whose layout `owners` (a tab, then the tabs down its chain) shows: the first with one, else undefined, the legacy layout. */
export function layoutSource(layout: Layout, owners: readonly string[]): string | undefined {
  return owners.find((owner) => hasOwnLayout(layout, owner))
}

/** A tab's layout as one fingerprint: its folders and order, or with no owner the legacy layout of `tab`. */
export function layoutPrint(layout: Layout, owner: string | undefined, tab: string): string {
  const folders = layout.folders
    .filter((folder) => folder.tab === tab && folder.owner === owner)
    .map((folder) => [folder.id, folder.name, folder.parent ?? null, folder.items] as const)
    .toSorted(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
  return fingerprint(JSON.stringify([folders, orderOf(layout.orders, owner === undefined ? `tab:${tab}` : groupScope(owner))?.items ?? []]))
}

/**
 * Isolate one tab's layout before planning. A tab without its own reads
 * `from`'s (the tab its layout comes from down the chain, or undefined for the
 * legacy layout); finishing copies it to the tab, remembering what it was
 * based on so a later change there is to review.
 */
export function ownerLayout(layout: Layout, owner: string, from?: string) {
  const tab = tabOfGroupId(owner)
  if (tab === undefined) throw new Error(`Not a category: ${owner}`)
  const own = hasOwnLayout(layout, owner)
  const source = own ? owner : from
  const sourceFolders = layout.folders.filter((folder) => folder.tab === tab && folder.owner === source)
  const ids = new Map(sourceFolders.map((folder) => [folder.id, own ? folder.id : copiedId(folder.id, owner, from)]))
  const token = (value: string) => {
    const id = folderIdOfRef(value)
    return id === undefined ? value : folderRef(ids.get(id) ?? id)
  }
  const folders = sourceFolders.map((folder) => ({
    ...folder, id: ids.get(folder.id)!, owner, level: layoutLevel(owner), items: folder.items.map(token),
    ...(folder.parent === undefined ? {} : { parent: ids.get(folder.parent) ?? folder.parent }),
  }))
  const order = orderOf(layout.orders, source === undefined ? `tab:${tab}` : groupScope(source))
  const orders: OrderRecord[] = order === undefined ? [] : [{ type: "order", level: order.level, scope: `tab:${tab}`, items: order.items.map(token), updated: order.updated }]
  const basedOn = own ? orderOf(layout.orders, groupScope(owner))?.basedOn : layoutPrint(layout, from, tab)
  return {
    folders, orders, token,
    finish: (next: Layout, updated: string) => ({
      folders: [...layout.folders.filter((folder) => folder.owner !== owner), ...next.folders.map((folder) => ({ ...folder, owner, level: layoutLevel(owner) }))],
      // Even an empty order marks this tab's layout as its own.
      orders: [...layout.orders.filter((entry) => entry.scope !== groupScope(owner)), {
        type: "order" as const, level: layoutLevel(owner), scope: groupScope(owner),
        items: orderOf(next.orders, `tab:${tab}`)?.items ?? [], ...(basedOn === undefined ? {} : { basedOn }), updated,
      }],
    }),
  }
}

// A copied folder's id: the source tab's prefix swapped for this tab's.
function copiedId(id: string, owner: string, from: string | undefined): string {
  return from !== undefined && id.startsWith(`${from}:`) ? `${owner}:${id.slice(from.length + 1)}` : `${owner}/${id}`
}

export function splitLayout(records: readonly (FolderRecord | OrderRecord)[]): LayoutRecordSet {
  return {
    folders: records.filter((record): record is FolderRecord => record.type === "folder"),
    orders: records.filter((record): record is OrderRecord => record.type === "order"),
  }
}

/** A folder under `parent`, or at its tab's top level when `parent` is undefined (the key is absent, never undefined). */
export function reparent(folder: FolderRecord, parent: string | undefined): FolderRecord {
  const { parent: _previous, ...rest } = folder
  return parent === undefined ? rest : { ...rest, parent }
}

/** Replace a tab's top-level order with `items`, creating the record when none exists. */
export function setOrder(
  orders: readonly OrderRecord[],
  tab: string,
  items: readonly string[],
  updated: string,
): OrderRecord[] {
  return setOrderScope(orders, `tab:${tab}`, items, updated)
}

/** Replace the order record for an arbitrary scope with `items`, creating the record when none exists. */
export function setOrderScope(
  orders: readonly OrderRecord[],
  scope: string,
  items: readonly string[],
  updated: string,
): OrderRecord[] {
  if (orderOf(orders, scope) === undefined)
    return [...orders, { type: "order", level: "global", scope, items: [...items], updated }]
  return orders.map((order) => (order.scope === scope ? { ...order, items: [...items], updated } : order))
}

/** Append an entry to a tab's top-level order record, creating the record when none exists. */
export function appendToOrder(
  records: readonly (FolderRecord | OrderRecord)[],
  tab: string,
  entry: string,
  updated: string,
): (FolderRecord | OrderRecord)[] {
  const scope = `tab:${tab}`
  if (
    orderOf(
      records.filter((record): record is OrderRecord => record.type === "order"),
      scope,
    ) === undefined
  )
    return [...records, { type: "order", level: "global", scope, items: [entry], updated }]
  return records.map((record) =>
    record.type === "order" && record.scope === scope
      ? { ...record, items: [...record.items.filter((item) => item !== entry), entry], updated }
      : record,
  )
}
