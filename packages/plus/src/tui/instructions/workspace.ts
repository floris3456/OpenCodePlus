// The workspace view of the Instructions tree (docs/instructions-redesign.md,
// design A). The flat tree stays the single source of rows; this module only
// decides which rows are open and slices them into four places:
//
//   level (tab) → sidebar (catalogues, origins, teams, owners)
//               → categories of the selected owner (tabs)
//               → the selected category's own subtree (the list)
//
// An owner is a row whose children are the agent groups (Settings … System):
// agents, team members, a team's Special agents, presets, Defaults entries,
// and the Defaults catalogues themselves ("Every agent", "Every member").
import { controlKind, findLazy, type Lazy, type Memo, type TreeNode } from "../../instructions/tree.js"
import { isModelSettingRowId, MODELS_GROUP_ID } from "../../instructions/model-settings.js"

export const LEVELS = [
  { id: "project", label: "Project", root: "root:project" },
  { id: "global", label: "Global", root: "root:global" },
  { id: "defaults", label: "Defaults", root: "root:defaults" },
  { id: "preset", label: "Presets", root: "root:preset" },
] as const

export type LevelId = (typeof LEVELS)[number]["id"]

export function isLevelId(value: unknown): value is LevelId {
  return LEVELS.some((level) => level.id === value)
}

const CATEGORY = /:(settings|models|compaction|tools|base|skills|system|mcp)$/

export type RowRole = "catalogue" | "group" | "container" | "owner" | "every" | "item"

export interface Row {
  /** Unique within its pane: the node id, or `<id>#every` for a catalogue's own owner row. */
  readonly key: string
  readonly node: TreeNode
  readonly label: string
  /** Indent within the pane. */
  readonly depth: number
  readonly role: RowRole
  readonly expandable: boolean
  readonly expanded: boolean
  /** Shown only as context (a filter result's ancestors). */
  readonly context?: boolean
}

export interface WorkspaceInput {
  readonly rows: (open: ReadonlySet<string>) => TreeNode[]
  readonly level: LevelId
  /** Sidebar rows the user collapsed. */
  readonly navCollapsed: ReadonlySet<string>
  /** Preferred owner row key; the first owner when missing. */
  readonly owner?: string
  /** Preferred category id of that owner; the first category when missing. */
  readonly category?: string
  /** List rows the user expanded / collapsed (any owner). */
  readonly listOpen: ReadonlySet<string>
  readonly listCollapsed: ReadonlySet<string>
}

export interface Workspace {
  readonly levels: readonly { readonly id: LevelId; readonly label: string; readonly review: number }[]
  readonly root?: TreeNode
  readonly nav: readonly Row[]
  readonly owner?: Row
  readonly categories: readonly TreeNode[]
  readonly category?: TreeNode
  readonly list: readonly Row[]
  /** Every emitted row's parent: dialogs and breadcrumbs read it. */
  readonly parents: ReadonlyMap<string, TreeNode>
}

/**
 * One workspace slice. `known` carries the structure rows found open on the
 * previous call so a steady view costs one tree() build; new structure (a new
 * level, a created team) converges in a few more.
 */
export function workspaceOf(input: WorkspaceInput, known: Set<string> = new Set()): Workspace {
  const root = LEVELS.find((level) => level.id === input.level)?.root ?? "root:project"
  const open = new Set<string>([root, ...known, ...input.listOpen])
  for (const id of input.navCollapsed) open.delete(id)
  for (const id of input.listCollapsed) open.delete(id)
  let rows: TreeNode[] = []
  let parents = new Map<string, TreeNode>()
  for (let pass = 0; pass < 10; pass++) {
    rows = input.rows(open)
    parents = parentsOf(rows)
    const wanted = wantedOpen(rows, parents, root, input, open)
    if (wanted.length === 0) break
    for (const id of wanted) open.add(id)
  }
  const slice = sliceOf(rows, parents, root, input, open)
  // Remember the open structure for the next call: sidebar groups and teams,
  // the current owner and category, and category subgroups opened by
  // default. Owners visited earlier are dropped so the tree stays small.
  for (const row of slice.nav) if (row.expanded) known.add(row.node.id)
  if (slice.owner?.role === "owner") known.add(slice.owner.node.id)
  if (slice.category !== undefined) known.add(slice.category.id)
  for (const row of slice.list) if (row.depth === 0 && row.expanded && !input.listOpen.has(row.node.id)) known.add(row.node.id)
  for (const id of [...known]) {
    const node = rows.find((entry) => entry.id === id)
    if (node === undefined || id === slice.owner?.node.id || id === slice.category?.id) continue
    const parent = parents.get(id)
    const owner = node.kind === "agent" || (node.kind === "team" && navRole(node, parent) === "owner")
    const category = node.kind === "group" && CATEGORY.test(id) && parent !== undefined && (parent.kind === "agent" || parent.kind === "team" || navRole(parent, parents.get(parent.id)) === "catalogue")
    if (owner || category) known.delete(id)
  }
  return {
    levels: LEVELS.map((level) => ({
      id: level.id,
      label: level.label,
      review: rows.find((node) => node.id === level.root)?.badges.reviewCount ?? 0,
    })),
    root: rows.find((node) => node.id === root),
    ...slice,
    parents,
  }
}

function wantedOpen(
  rows: readonly TreeNode[],
  parents: ReadonlyMap<string, TreeNode>,
  root: string,
  input: WorkspaceInput,
  open: ReadonlySet<string>,
): string[] {
  const slice = sliceOf(rows, parents, root, input, open)
  const wanted: string[] = []
  for (const row of slice.nav)
    if (row.role !== "owner" && row.role !== "every" && !row.expanded && !input.navCollapsed.has(row.node.id)) wanted.push(row.node.id)
  const owner = slice.owner
  if (owner !== undefined && owner.role === "owner" && !open.has(owner.node.id)) wanted.push(owner.node.id)
  const category = slice.category
  if (category !== undefined && !open.has(category.id)) wanted.push(category.id)
  // A category's own subgroups (Tools › OpenCode, Skills › Project …) open by
  // default: they read as headings, not as another level to descend.
  for (const row of slice.list)
    if (row.depth === 0 && row.node.kind === "group" && !row.expanded && !input.listCollapsed.has(row.node.id)) wanted.push(row.node.id)
  return [...new Set(wanted)]
}

function sliceOf(
  rows: readonly TreeNode[],
  parents: ReadonlyMap<string, TreeNode>,
  root: string,
  input: WorkspaceInput,
  open: ReadonlySet<string>,
): Pick<Workspace, "nav" | "owner" | "categories" | "category" | "list"> {
  const start = rows.findIndex((node) => node.id === root)
  if (start === -1) return { nav: [], categories: [], list: [] }
  const top = rows[start]!
  const under = subtreeOf(rows, start)
  const nav: Row[] = []
  let skipBelow: number | undefined
  for (const node of under) {
    if (skipBelow !== undefined && node.depth > skipBelow) continue
    skipBelow = undefined
    const parent = parents.get(node.id)
    const role = navRole(node, parent)
    const depth = node.depth - top.depth - 1
    // The Defaults › Models section is owner-like: one sidebar row whose rows
    // are the list pane (so their values show in the list's meta line).
    if (node.id === MODELS_GROUP_ID) {
      nav.push({ key: `${node.id}#models`, node, label: node.label, depth, role: "every", expandable: false, expanded: false })
      skipBelow = node.depth
      continue
    }
    // A category straight under a catalogue belongs to its "Every …" owner row.
    if (node.kind === "group" && CATEGORY.test(node.id)) {
      skipBelow = node.depth
      continue
    }
    if (role === "owner") {
      nav.push({ key: node.id, node, label: node.label, depth, role, expandable: false, expanded: false })
      skipBelow = node.depth
      continue
    }
    nav.push({ key: node.id, node, label: node.label, depth, role, expandable: true, expanded: open.has(node.id) })
    if (role === "catalogue" && hasCategoryChild(rows, node)) {
      nav.push({
        key: `${node.id}#every`,
        node,
        label: node.label === "Teams" ? "Every member" : "Every agent",
        depth: depth + 1,
        role: "every",
        expandable: false,
        expanded: false,
      })
    }
  }
  // An open group with nothing in it shows no ▾: there is nothing to close.
  nav.forEach((row, index) => {
    if (row.expandable && row.expanded && (nav[index + 1]?.depth ?? -1) <= row.depth) nav[index] = { ...row, expandable: false }
  })
  const owners = nav.filter((row) => row.role === "owner" || row.role === "every")
  const owner = owners.find((row) => row.key === input.owner) ?? owners[0]
  if (owner === undefined) return { nav, categories: [], list: [] }
  const ownerIndex = rows.findIndex((node) => node.id === owner.node.id)
  // The Defaults › Models section is its own category: Every model and the
  // per-model rows are the list, so the section needs no second group level.
  // Each row opens (→) into its fields.
  if (owner.node.id === MODELS_GROUP_ID) {
    const list = subtreeOf(rows, ownerIndex).map((node) => listRow(node, owner.node.depth, open))
    return { nav, owner, categories: [owner.node], category: owner.node, list }
  }
  const children = directChildren(rows, ownerIndex)
  const categories = children.filter((node) => node.kind === "group" && (owner.role === "owner" || CATEGORY.test(node.id)))
  const category = categories.find((node) => node.id === input.category) ?? categories[0]
  if (category === undefined) return { nav, owner, categories, list: [] }
  const categoryIndex = rows.findIndex((node) => node.id === category.id)
  const list = subtreeOf(rows, categoryIndex).map((node) => listRow(node, category.depth, open))
  return { nav, owner, categories, category, list }
}

function listRow(node: TreeNode, base: number, open: ReadonlySet<string>): Row {
  const expandable = canExpand(node)
  return {
    key: node.id,
    node,
    label: node.label,
    depth: node.depth - base - 1,
    role: node.kind === "group" ? "group" : "item",
    expandable,
    expanded: expandable && open.has(node.id),
  }
}

/** Rows that can hold children: sections, models, rule rows, controls and Defaults › Models fields are leaves. */
export function canExpand(node: TreeNode): boolean {
  if (node.kind === "section") return false
  if (isModelSettingRowId(node.id)) return false
  if (node.kind === "item" && controlKind(node.address?.item) !== undefined) return false
  if (node.address?.item.startsWith("model:") === true) return false
  if (node.address?.item.startsWith("perm:") === true) return false
  return true
}

function navRole(node: TreeNode, parent: TreeNode | undefined): RowRole {
  if (node.kind === "agent") return "owner"
  // A team hangs under a catalogue or origin group; its members hang under
  // it, and a team's Special agents under its Special group (`team:…:special`).
  if (node.kind === "team") return parent?.kind === "group" && !parent.id.startsWith("team:") ? "container" : "owner"
  if (node.kind === "group" && parent?.kind === "root") return "catalogue"
  return "group"
}

function hasCategoryChild(rows: readonly TreeNode[], node: TreeNode): boolean {
  const index = rows.findIndex((row) => row.id === node.id)
  return directChildren(rows, index).some((child) => child.kind === "group" && CATEGORY.test(child.id))
}

export function parentsOf(rows: readonly TreeNode[]): Map<string, TreeNode> {
  const parents = new Map<string, TreeNode>()
  const stack: TreeNode[] = []
  for (const node of rows) {
    while (stack.length > 0 && stack[stack.length - 1]!.depth >= node.depth) stack.pop()
    const parent = stack[stack.length - 1]
    if (parent !== undefined) parents.set(node.id, parent)
    stack.push(node)
  }
  return parents
}

function subtreeOf(rows: readonly TreeNode[], index: number): TreeNode[] {
  const node = rows[index]
  if (node === undefined) return []
  const out: TreeNode[] = []
  for (let at = index + 1; at < rows.length; at++) {
    const row = rows[at]!
    if (row.depth <= node.depth) break
    out.push(row)
  }
  return out
}

function directChildren(rows: readonly TreeNode[], index: number): TreeNode[] {
  const node = rows[index]
  if (node === undefined) return []
  return subtreeOf(rows, index).filter((row) => row.depth === node.depth + 1)
}

/** The chain from the level root down to `id` (exclusive of the root). */
export function ancestry(parents: ReadonlyMap<string, TreeNode>, node: TreeNode): TreeNode[] {
  const chain: TreeNode[] = []
  let current = parents.get(node.id)
  while (current !== undefined && current.kind !== "root") {
    chain.unshift(current)
    current = parents.get(current.id)
  }
  return chain
}

export interface ReviewTarget {
  /** Sidebar key of the owner the row belongs to. */
  readonly owner: string
  readonly category: string
  readonly row: string
  /** List rows to open so the row is visible. */
  readonly open: readonly string[]
}

/**
 * Every row under review in a level, in tree order. Each pass opens the rows
 * whose review roll-up is positive, so the cost is one tree() build per depth.
 */
export function reviewTargets(rowsOf: (open: ReadonlySet<string>) => TreeNode[], level: LevelId): ReviewTarget[] {
  const root = LEVELS.find((entry) => entry.id === level)?.root ?? "root:project"
  const open = new Set<string>([root])
  let rows: TreeNode[] = []
  for (let pass = 0; pass < 16; pass++) {
    rows = rowsOf(open)
    const start = rows.findIndex((node) => node.id === root)
    const more = subtreeOf(rows, start).filter(
      (node) => !open.has(node.id) && canExpand(node) && ((node.badges.reviewCount ?? 0) > 0 || structural(node)),
    )
    if (more.length === 0) break
    for (const node of more) open.add(node.id)
  }
  const parents = parentsOf(rows)
  const start = rows.findIndex((node) => node.id === root)
  return subtreeOf(rows, start)
    // review is "this row or something under it"; a target is a row whose
    // own value is under review, i.e. nothing below it is.
    .filter((node) => node.badges.review === true && (node.badges.reviewCount ?? 0) === 0)
    .flatMap((node) => {
      const chain = ancestry(parents, node)
      const index = chain.findIndex((entry, at) => {
        const next = chain[at + 1] ?? node
        return next.kind === "group" && CATEGORY.test(next.id) && (entry.kind === "agent" || entry.kind === "team" || entry.kind === "group")
          && navRole(entry, parents.get(entry.id)) !== "container"
      })
      const owner = chain[index]
      const category = chain[index + 1]
      if (owner === undefined || category === undefined) return []
      const every = owner.kind === "group"
      return [{
        owner: every ? `${owner.id}#every` : owner.id,
        category: category.id,
        row: node.id,
        open: chain.slice(index + 2).map((entry) => entry.id),
      }]
    })
}

// Structure rows that carry no review roll-up of their own but lead to owners.
function structural(node: TreeNode): boolean {
  return node.kind === "group" && !CATEGORY.test(node.id) && (node.id.startsWith("group:") && /:(agents|teams)(:|$)/.test(node.id) || node.id.endsWith(":special"))
    || (node.kind === "team" && (node.badges.reviewCount ?? 0) > 0)
}

export interface ToolCount {
  /** Tool rows switched on for this owner. */
  readonly on: number
  /** Of those, the ones the model reaches only through Code Mode (`execute`); a pinned one is direct. */
  readonly codemode: number
  /** Tool rows in total, on or off. */
  readonly total: number
}

/**
 * One owner's tool count, on demand: descend the memo's lazy skeleton to the
 * owner's Tools group and count the tool rows under it. The caller caches the
 * result per snapshot, so no level-wide sweep runs after a load.
 *
 * `ownerKey` is the sidebar key: an owner row id, or `<catalogue group>#every`
 * for Defaults' shared inventories.
 */
export function toolCountOf(memo: Memo, ownerKey: string, codemode: (item: string) => boolean): ToolCount | undefined {
  const owner = findLazy(memo, ownerKey.endsWith("#every") ? ownerKey.slice(0, -"#every".length) : ownerKey)
  const group = owner?.children().find((child) => child.kind === "group" && child.id.endsWith(":tools"))
  if (group === undefined) return undefined
  const rows = toolRows(group)
  const on = rows.filter((row) => row.on)
  return { on: on.length, codemode: on.filter((row) => codemode(row.item) && !row.pinned).length, total: rows.length }
}

// The tool rows below a Tools group. Tool rows are leaves here: their sections
// and permission rows are not tools and the old sweep never opened them.
function toolRows(lazy: Lazy): { readonly item: string; readonly on: boolean; readonly pinned: boolean }[] {
  if (lazy.kind === "item") {
    const address = lazy.address
    if (address === undefined || address.section !== null || !address.item.startsWith("tool:")) return []
    const badges = lazy.partial()
    return [{ item: address.item, on: badges.state === "on", pinned: badges.pinned === true }]
  }
  return lazy.children().flatMap(toolRows)
}

/** "72 tools on (13 direct, 59 through Code Mode)", or "no tools on". */
export function toolWords(count: ToolCount): string {
  if (count.on === 0) return "no tools on"
  const direct = count.on - count.codemode
  const split = count.codemode === 0 ? "" : ` (${direct} direct, ${count.codemode} through Code Mode)`
  return `${count.on} tool${count.on === 1 ? "" : "s"} on${split}`
}

/**
 * The owner header's tools line: the same counts as toolWords, and for an
 * owner that can act on nothing the way out of it. The inspector keeps the
 * fuller account (total rows, why it cannot act).
 */
export function toolHint(count: ToolCount): string {
  if (count.on === 0) return "no tools on · link a preset (l) or turn tools on (4)"
  return toolWords(count)
}
