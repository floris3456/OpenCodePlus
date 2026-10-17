// Saved category membership shared by the TUI and Instructions tools. New
// categories belong to one owner's tab; ownerless records retain the legacy
// global layout until an owner edits it, at which point it is copied locally.

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
  return match?.[1]
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

/** Isolate one owner before planning; materialize legacy membership on first edit. */
export function ownerLayout(layout: { readonly folders: readonly FolderRecord[]; readonly orders: readonly OrderRecord[] }, owner: string) {
  const tab = tabOfGroupId(owner)
  if (tab === undefined) throw new Error(`Not a category: ${owner}`)
  const own = layout.orders.some((order) => order.scope === groupScope(owner)) || layout.folders.some((folder) => folder.owner === owner)
  const source = layout.folders.filter((folder) => folder.tab === tab && folder.owner === (own ? owner : undefined))
  const ids = new Map(source.map((folder) => [folder.id, own ? folder.id : `${owner}/${folder.id}`]))
  const token = (value: string) => {
    const id = folderIdOfRef(value)
    return id === undefined ? value : folderRef(ids.get(id) ?? id)
  }
  const folders = source.map((folder) => ({
    ...folder, id: ids.get(folder.id)!, owner, level: layoutLevel(owner), items: folder.items.map(token),
    ...(folder.parent === undefined ? {} : { parent: ids.get(folder.parent) ?? folder.parent }),
  }))
  const order = orderOf(layout.orders, own ? groupScope(owner) : `tab:${tab}`)
  const orders: OrderRecord[] = order === undefined ? [] : [{ ...order, scope: `tab:${tab}`, items: order.items.map(token) }]
  return {
    folders, orders, token,
    finish: (next: { readonly folders: readonly FolderRecord[]; readonly orders: readonly OrderRecord[] }, updated: string) => ({
      folders: [...layout.folders.filter((folder) => folder.owner !== owner), ...next.folders.map((folder) => ({ ...folder, owner, level: layoutLevel(owner) }))],
      // Even an empty order marks this owner's layout as independent of legacy folders.
      orders: [...layout.orders.filter((entry) => entry.scope !== groupScope(owner)), {
        type: "order" as const, level: layoutLevel(owner), scope: groupScope(owner),
        items: orderOf(next.orders, `tab:${tab}`)?.items ?? [], updated,
      }],
    }),
  }
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
