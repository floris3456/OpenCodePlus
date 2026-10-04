// User categories (plan plus-1.1.12 T8): user-named, display-only groups for
// item rows. One organisation applies everywhere: assignments are keyed by the
// row's item id and stored once in the global store as category records. A row
// assigned to a category lists under it (with its children) in every owner's
// list instead of its home category; deleting the category returns the rows to
// their home category. Absent records mean no categories (no migration).

/**
 * One user category. `items` holds whole-row item ids (`tool:bash`,
 * `system:role`, `model:<provider>/<model>`, `perm:<tool>:<rule>`, …), never
 * sections and never group rows. Order is the tab order after the built-in
 * categories; the global store is the only tier.
 */
export interface CategoryRecord {
  readonly type: "category"
  readonly level: "global"
  readonly name: string
  readonly order: number
  readonly items: readonly string[]
  readonly updated: string
}

// A category's row/tab id segment: `:category:<slug>`. The slug follows the
// name but is stable when the name changes case or punctuation.
export function categorySlug(name: string): string {
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.length > 0 ? slug : "category"
}

/** True for a user-category group id (`…:category:<slug>`), not a built-in tab. */
export function isCategoryGroupId(id: string): boolean {
  return /:category(:[^:]*)?$/.test(id)
}

/** The slug of a user-category group id, or a bare `category:<slug>` id. */
export function categorySlugFromId(id: string): string | undefined {
  const group = /:category:([^:]*)$/.exec(id)
  if (group !== null) return group[1]
  const bare = /^category:([^:]*)$/.exec(id)
  return bare?.[1]
}

/** The user categories in tab order. */
export function orderedCategories(records: readonly CategoryRecord[]): CategoryRecord[] {
  return [...records].toSorted((left, right) => left.order - right.order || left.name.localeCompare(right.name))
}

/** The category named `name` (trimmed, case-insensitive), if any. */
export function categoryByName(records: readonly CategoryRecord[], name: string): CategoryRecord | undefined {
  const wanted = name.trim().toLowerCase()
  return records.find((record) => record.name.trim().toLowerCase() === wanted)
}

/** item id → the name of the category that holds it (first category wins). */
export function categoryByItem(records: readonly CategoryRecord[]): Map<string, string> {
  const map = new Map<string, string>()
  for (const category of orderedCategories(records)) {
    for (const item of category.items) if (!map.has(item)) map.set(item, category.name)
  }
  return map
}

/** The category holding `item`, if any. */
export function categoryOfItem(records: readonly CategoryRecord[], item: string): CategoryRecord | undefined {
  return orderedCategories(records).find((category) => category.items.includes(item))
}

/** The home category a row's item id belongs to, in the words the inspector uses. */
export function homeCategoryLabel(item: string): string {
  if (item.startsWith("model:") || item.startsWith("modeldefault:") || item.startsWith("modelsetting:")) return "Models"
  if (item.startsWith("base:")) return "Base"
  if (item.startsWith("system:")) return "System"
  if (item.startsWith("mcp:")) return "MCP"
  if (item.startsWith("compaction:")) return "Compaction"
  if (item.startsWith("setting:")) return "Settings"
  return "Tools"
}

/** A new category appended after the existing ones, with no rows yet. */
export function createCategoryRecord(
  records: readonly CategoryRecord[],
  name: string,
  updated: string,
): CategoryRecord[] {
  const order = records.reduce((highest, record) => Math.max(highest, record.order), -1) + 1
  return [
    ...records,
    { type: "category", level: "global", name: name.trim(), order, items: [], updated },
  ]
}

/**
 * Move `item` into the named category (adding it there), or out of every
 * category when `name` is null. Re-assigning an item already in a category
 * always leaves it once, in the target. No target returns the list unchanged.
 */
export function assignCategoryRecord(
  records: readonly CategoryRecord[],
  item: string,
  name: string | null,
  updated: string,
): CategoryRecord[] {
  const cleaned = records.map((record) =>
    record.items.includes(item) ? { ...record, items: record.items.filter((held) => held !== item), updated } : record,
  )
  if (name === null) return cleaned
  const wanted = name.trim().toLowerCase()
  return cleaned.map((record) =>
    record.name.trim().toLowerCase() === wanted ? { ...record, items: [...record.items, item], updated } : record,
  )
}

/** Rename the category named `from`; items and order follow. */
export function renameCategoryRecord(
  records: readonly CategoryRecord[],
  from: string,
  to: string,
  updated: string,
): CategoryRecord[] {
  const wanted = from.trim().toLowerCase()
  return records.map((record) =>
    record.name.trim().toLowerCase() === wanted ? { ...record, name: to.trim(), updated } : record,
  )
}

/** Delete the category named `name` (an id or a name); its rows go home with its record. */
export function deleteCategoryRecord(records: readonly CategoryRecord[], name: string): CategoryRecord[] {
  const wanted = name.trim().toLowerCase()
  const slug = categorySlugFromId(name)
  return records.filter(
    (record) =>
      !(
        record.name.trim().toLowerCase() === wanted ||
        (slug !== undefined && categorySlug(record.name) === slug)
      ),
  )
}