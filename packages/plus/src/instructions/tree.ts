import { applies, canReset, resolve, resolveSplit, scopesOf } from "./model.js"
import type { Address, AgentSource, CustomizationRecord, Item, Level, Resolved, Scopes, SplitRecord } from "./model.js"
import type { Section, Split } from "./sections.js"

export type TreeNodeKind = "root" | "group" | "agent" | "item" | "section"
export type AddKind = "agent" | "base" | "skill" | "instruction" | "mcp" | "section"

export interface TreeNodeBadges {
  readonly state?: "on" | "off"
  readonly modified?: boolean
  readonly review?: boolean
  readonly reviewCount?: number
  readonly active?: boolean
  readonly source?: Level | "upstream"
  /** User base template that can never be the host active answer. */
  readonly inactive?: boolean
  /** Code Mode tool whose customizations are never applied. */
  readonly unsupported?: boolean
}

export interface TreeNodeActions {
  readonly toggle: boolean
  readonly edit: boolean
  readonly reset: boolean
  readonly remove: boolean
  readonly split: boolean
}

export interface TreeNode {
  readonly id: string
  readonly kind: TreeNodeKind
  readonly label: string
  readonly depth: number
  readonly address?: Address
  readonly add?: AddKind
  readonly badges: TreeNodeBadges
  readonly actions?: TreeNodeActions
}

export interface TreeInput {
  readonly items: readonly Item[]
  readonly records: readonly (CustomizationRecord | SplitRecord)[]
  readonly agents: readonly AgentSource[]
  readonly expanded?: ReadonlySet<string>
}

export function tree(input: TreeInput): TreeNode[] {
  const ctx = contextOf(input)
  const expanded = input.expanded ?? new Set<string>()
  const memo = memoOf(ctx)
  const roots = [lazyRoot(ctx, memo, "project"), lazyRoot(ctx, memo, "global"), lazyRoot(ctx, memo, "defaults")]
  return roots.flatMap((root) => emit(root, expanded))
}

// Single-pass full expansion for filter matching: the skeleton already knows
// every id without resolving anything, so walk it directly instead of
// converging by repeated expanded builds. Output matches tree() with every id
// expanded.
export function expandedTree(input: Omit<TreeInput, "expanded">): TreeNode[] {
  const ctx = contextOf(input)
  const memo = memoOf(ctx)
  const roots = [lazyRoot(ctx, memo, "project"), lazyRoot(ctx, memo, "global"), lazyRoot(ctx, memo, "defaults")]
  return roots.flatMap(emitAll)
}

interface BuildContext {
  readonly items: readonly Item[]
  readonly customizations: readonly CustomizationRecord[]
  readonly splits: readonly SplitRecord[]
  readonly scopes: Scopes
  readonly agents: readonly AgentSource[]
}

function contextOf(input: TreeInput): BuildContext {
  return {
    items: input.items,
    customizations: input.records.filter((record): record is CustomizationRecord => record.type === "customization"),
    splits: input.records.filter((record): record is SplitRecord => record.type === "split"),
    scopes: scopesOf(input.agents),
    agents: input.agents,
  }
}

// Lazy skeleton: ids, labels, depths, and actions are cheap, so the structure
// is built without resolving anything. Resolution runs only for emitted rows
// and for roll-up flags; collapsed subtrees never resolve.
interface Lazy {
  readonly id: string
  readonly kind: TreeNodeKind
  readonly label: string
  readonly depth: number
  readonly address?: Address
  readonly add?: AddKind
  readonly actions: TreeNodeActions
  readonly selfReview: () => boolean
  readonly partial: () => TreeNodeBadges
  readonly reviewCount: () => number
  readonly children: () => readonly Lazy[]
}

interface TextEntry {
  whole: boolean
  readonly sections: Set<string>
}

interface Memo {
  readonly ctx: BuildContext
  readonly whole: Map<string, Resolved>
  readonly section: Map<string, Resolved>
  readonly split: Map<string, Split>
  readonly flag: Map<string, boolean>
  readonly kids: Map<string, readonly Lazy[]>
  readonly texts: Map<string, TextEntry>
}

function memoOf(ctx: BuildContext): Memo {
  return {
    ctx,
    whole: new Map(),
    section: new Map(),
    split: new Map(),
    flag: new Map(),
    kids: new Map(),
    texts: textIndex(ctx),
  }
}

// One pass over customizations: review needs a stored text, so index which
// addresses have one and skip every resolve for addresses without.
function textIndex(ctx: BuildContext): Map<string, TextEntry> {
  const index = new Map<string, TextEntry>()
  ctx.customizations.forEach((record) => {
    if (record.text === undefined) return
    const key = textKey(record.level, record.agent, record.item)
    const entry = index.get(key)
    if (entry !== undefined) {
      if (record.section === null) entry.whole = true
      else entry.sections.add(record.section)
      return
    }
    index.set(key, { whole: record.section === null, sections: new Set(record.section === null ? [] : [record.section]) })
  })
  return index
}

function textKey(level: Level, owner: string | null, item: string): string {
  return JSON.stringify([level, owner, item])
}

function keyOf(level: Level, owner: string | null, item: string, section: string | null): string {
  return JSON.stringify([level, owner, item, section])
}

function wholeOf(memo: Memo, level: Level, owner: string | null, item: Item): Resolved {
  const key = keyOf(level, owner, item.id, null)
  const cached = memo.whole.get(key)
  if (cached !== undefined) return cached
  const resolved = resolve({
    upstream: item,
    records: memo.ctx.customizations,
    splits: memo.ctx.splits,
    scopes: memo.ctx.scopes,
    address: { level, agent: owner, item: item.id, section: null },
  })
  memo.whole.set(key, resolved)
  return resolved
}

function splitOf(memo: Memo, level: Level, owner: string | null, item: Item): Split {
  const key = keyOf(level, owner, item.id, null)
  const cached = memo.split.get(key)
  if (cached !== undefined) return cached
  const whole = wholeOf(memo, level, owner, item)
  const split = resolveSplit({
    text: whole.text,
    title: item.title,
    splits: memo.ctx.splits,
    scopes: memo.ctx.scopes,
    address: { level, agent: owner, item: item.id, section: null },
  })
  memo.split.set(key, split)
  return split
}

function sectionResolveOf(memo: Memo, level: Level, owner: string | null, item: Item, section: string): Resolved {
  const key = keyOf(level, owner, item.id, section)
  const cached = memo.section.get(key)
  if (cached !== undefined) return cached
  const resolved = resolve({
    upstream: item,
    records: memo.ctx.customizations,
    splits: memo.ctx.splits,
    scopes: memo.ctx.scopes,
    address: { level, agent: owner, item: item.id, section },
  })
  memo.section.set(key, resolved)
  return resolved
}

// Review is false wherever no customization stores text, so those addresses
// short-circuit with no resolve call at all.
function flagOf(memo: Memo, level: Level, owner: string | null, item: Item, section: string | null): boolean {
  const key = keyOf(level, owner, item.id, section)
  const cached = memo.flag.get(key)
  if (cached !== undefined) return cached
  const entry = memo.texts.get(textKey(level, owner, item.id))
  if (entry === undefined) {
    memo.flag.set(key, false)
    return false
  }
  if (section === null && !entry.whole) {
    memo.flag.set(key, false)
    return false
  }
  if (section !== null && !entry.sections.has(section)) {
    memo.flag.set(key, false)
    return false
  }
  const flag = section === null ? wholeOf(memo, level, owner, item).review : sectionResolveOf(memo, level, owner, item, section).review
  memo.flag.set(key, flag)
  return flag
}

// Section ids come from the split, so an item with no section customizations
// contributes zero without resolving anything; only items that actually have
// section overrides pay for one whole resolve plus one split.
function itemRollup(memo: Memo, level: Level, owner: string | null, item: Item): number {
  const entry = memo.texts.get(textKey(level, owner, item.id))
  if (entry === undefined) return 0
  if (entry.sections.size === 0) return 0
  return splitOf(memo, level, owner, item).sections.filter(
    (section) => entry.sections.has(section.id) && flagOf(memo, level, owner, item, section.id),
  ).length
}

function cachedKids(memo: Memo, id: string, build: () => readonly Lazy[]): readonly Lazy[] {
  const cached = memo.kids.get(id)
  if (cached !== undefined) return cached
  const kids = build()
  memo.kids.set(id, kids)
  return kids
}

function rollup(children: readonly Lazy[]): number {
  return children.reduce((sum, child) => sum + child.reviewCount() + (child.selfReview() ? 1 : 0), 0)
}

function emit(lazy: Lazy, expanded: ReadonlySet<string>): TreeNode[] {
  const head = [finalizeLazy(lazy)]
  if (!expanded.has(lazy.id)) return head
  return head.concat(lazy.children().flatMap((child) => emit(child, expanded)))
}

function emitAll(lazy: Lazy): TreeNode[] {
  const head = [finalizeLazy(lazy)]
  return head.concat(lazy.children().flatMap(emitAll))
}

// Same badge rule as before: sections carry their own flags, every other row
// rolls hidden and visible descendant review into review/reviewCount.
function finalizeLazy(lazy: Lazy): TreeNode {
  if (lazy.kind === "section") return shell(lazy, lazy.partial())
  const count = lazy.reviewCount()
  const self = lazy.selfReview()
  return shell(lazy, { ...lazy.partial(), review: self || count > 0, reviewCount: count })
}

function shell(lazy: Lazy, badges: TreeNodeBadges): TreeNode {
  return {
    id: lazy.id,
    kind: lazy.kind,
    label: lazy.label,
    depth: lazy.depth,
    ...(lazy.address === undefined ? {} : { address: lazy.address }),
    ...(lazy.add === undefined ? {} : { add: lazy.add }),
    badges,
    actions: lazy.actions,
  }
}

interface BranchArgs {
  readonly kind: TreeNodeKind
  readonly id: string
  readonly label: string
  readonly depth: number
  readonly add?: AddKind
  readonly actions: TreeNodeActions
  readonly children: () => readonly Lazy[]
}

function branch(memo: Memo, args: BranchArgs): Lazy {
  const kids = (): readonly Lazy[] => cachedKids(memo, args.id, args.children)
  return {
    id: args.id,
    kind: args.kind,
    label: args.label,
    depth: args.depth,
    ...(args.add === undefined ? {} : { add: args.add }),
    actions: args.actions,
    selfReview: () => false,
    partial: () => ({}),
    reviewCount: () => rollup(kids()),
    children: kids,
  }
}

function lazyRoot(ctx: BuildContext, memo: Memo, level: Level): Lazy {
  if (level === "defaults")
    return branch(memo, {
      kind: "root",
      id: "root:defaults",
      label: "Defaults",
      depth: 0,
      actions: noActions(),
      children: () => [lazyAgentsGroup(ctx, memo, "defaults"), ...lazySharedGroups(ctx, memo)],
    })
  return branch(memo, {
    kind: "root",
    id: `root:${level}`,
    label: level === "project" ? "Project" : "Global",
    depth: 0,
    actions: noActions(),
    children: () => [lazyAgentsGroup(ctx, memo, level)],
  })
}

function lazyAgent(ctx: BuildContext, memo: Memo, level: Level, agent: AgentSource, depth: number): Lazy {
  return branch(memo, {
    kind: "agent",
    id: `agent:${level}:${agent.id}`,
    label: agent.id,
    depth,
    actions: { ...noActions(), remove: true },
    children: () => [
      lazyTools(ctx, memo, level, agent.id, agent, depth + 1),
      lazyBase(ctx, memo, level, agent.id, agent, depth + 1),
      lazySkills(ctx, memo, level, agent.id, agent, depth + 1),
      lazySystem(ctx, memo, level, agent.id, agent, depth + 1),
    ],
  })
}

function lazyAgentsGroup(ctx: BuildContext, memo: Memo, level: Level): Lazy {
  return branch(memo, {
    kind: "group",
    id: `group:${level}:agents`,
    label: "Agents",
    depth: 1,
    add: "agent",
    actions: noActions(),
    children: () =>
      ctx.agents.filter((agent) => agent.scope === level).map((agent) => lazyAgent(ctx, memo, level, agent, 2)),
  })
}

function lazySharedGroups(ctx: BuildContext, memo: Memo): Lazy[] {
  return [
    lazyTools(ctx, memo, "defaults", null, null, 1),
    lazyBase(ctx, memo, "defaults", null, null, 1),
    lazySkills(ctx, memo, "defaults", null, null, 1),
    lazySystem(ctx, memo, "defaults", null, null, 1),
    lazyMcpInventory(ctx, memo),
  ]
}

function lazyMcpInventory(ctx: BuildContext, memo: Memo): Lazy {
  return branch(memo, {
    kind: "group",
    id: "group:defaults::mcp",
    label: "MCP",
    depth: 1,
    add: "mcp",
    actions: noActions(),
    children: () => sortedKind(ctx, "mcp", null).map((item) => lazyItem(ctx, memo, "defaults", null, null, item, 2)),
  })
}

function lazyTools(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  depth: number,
): Lazy {
  const prefix = `group:${level}:${owner ?? ""}:tools`
  return branch(memo, {
    kind: "group",
    id: prefix,
    label: "Tools",
    depth,
    actions: noActions(),
    children: () => {
      const tools = sortedKind(ctx, "tool", owner)
      return [
        leafGroup(ctx, memo, level, owner, agent, `${prefix}:native`, "Native", depth + 1, tools.filter((item) => item.group === "native")),
        leafGroup(ctx, memo, level, owner, agent, `${prefix}:plus`, "OpenCodePlus", depth + 1, tools.filter((item) => item.group === "plus")),
        mcpGroup(ctx, memo, level, owner, agent, `${prefix}:mcp`, depth + 1, tools.filter((item) => item.group === "mcp")),
        ...strayTools(ctx, memo, level, owner, agent, tools, depth + 1),
      ]
    },
  })
}

function lazySkills(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  depth: number,
): Lazy {
  const prefix = `group:${level}:${owner ?? ""}:skills`
  return branch(memo, {
    kind: "group",
    id: prefix,
    label: "Skills",
    depth,
    actions: noActions(),
    children: () => {
      const skills = sortedKind(ctx, "skill", owner)
      return [
        leafGroup(ctx, memo, level, owner, agent, `${prefix}:native`, "Native", depth + 1, skills.filter((item) => item.group === "native")),
        leafGroup(ctx, memo, level, owner, agent, `${prefix}:plus`, "OpenCodePlus", depth + 1, skills.filter((item) => item.group === "plus")),
        mcpGroup(ctx, memo, level, owner, agent, `${prefix}:mcp`, depth + 1, skills.filter((item) => item.group === "mcp")),
        leafGroup(
          ctx,
          memo,
          level,
          owner,
          agent,
          `${prefix}:project`,
          "Project",
          depth + 1,
          skills.filter((item) => item.group === "project"),
          "skill",
        ),
        ...straySkills(ctx, memo, level, owner, agent, skills, depth + 1),
      ]
    },
  })
}

// Tools or skills whose group belongs to no subgroup still need a row, so
// they hang directly off the category group rather than being dropped.
function strayTools(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  tools: readonly Item[],
  depth: number,
): Lazy[] {
  return tools
    .filter((item) => item.group !== "native" && item.group !== "plus" && item.group !== "mcp")
    .map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth))
}

function straySkills(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  skills: readonly Item[],
  depth: number,
): Lazy[] {
  return skills
    .filter((item) => item.group !== "native" && item.group !== "plus" && item.group !== "mcp" && item.group !== "project")
    .map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth))
}

function lazyBase(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  depth: number,
): Lazy {
  return branch(memo, {
    kind: "group",
    id: `group:${level}:${owner ?? ""}:base`,
    label: "Base",
    depth,
    add: "base",
    actions: noActions(),
    children: () => sortedKind(ctx, "base", owner).map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth + 1)),
  })
}

function lazySystem(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  depth: number,
): Lazy {
  return branch(memo, {
    kind: "group",
    id: `group:${level}:${owner ?? ""}:system`,
    label: "System",
    depth,
    add: "instruction",
    actions: noActions(),
    children: () => {
      const systems = sortedKind(ctx, "system", owner)
      const role = systems.find((item) => item.id === "system:role")
      const head = role === undefined ? [] : [lazyItem(ctx, memo, level, owner, agent, role, depth + 1)]
      return [
        ...head,
        ...systems.filter((item) => item.id !== "system:role").map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth + 1)),
      ]
    },
  })
}

function leafGroup(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  id: string,
  label: string,
  depth: number,
  items: readonly Item[],
  add?: AddKind,
): Lazy {
  return branch(memo, {
    kind: "group",
    id,
    label,
    depth,
    ...(add === undefined ? {} : { add }),
    actions: noActions(),
    children: () => items.map((item) => lazyItem(ctx, memo, level, owner, agent, item, depth + 1)),
  })
}

function mcpGroup(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  id: string,
  depth: number,
  items: readonly Item[],
): Lazy {
  return branch(memo, {
    kind: "group",
    id,
    label: "MCP",
    depth,
    actions: noActions(),
    children: () => {
      const servers = [...new Set(items.map((item) => item.server ?? "unknown"))].sort()
      return servers.map((server) =>
        leafGroup(
          ctx,
          memo,
          level,
          owner,
          agent,
          `${id}:${server}`,
          server,
          depth + 1,
          items.filter((item) => (item.server ?? "unknown") === server),
        ),
      )
    },
  })
}

function lazyItem(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  agent: AgentSource | null,
  item: Item,
  depth: number,
): Lazy {
  const address: Address = { level, agent: owner, item: item.id, section: null }
  // Code Mode tool rows stay discoverable but offer nothing apply would drop:
  // no toggle/edit/split and no `a: add section` affordance. Sections of such
  // an item are unreachable because the item cannot split. The TUI already
  // gates every one of these on these same two fields (`canToggle`,
  // `canEdit`, `canSplit` in tui/instructions/route.tsx and the `add:
  // "section"` emission below), so no TUI change is needed.
  const codemode = item.kind === "tool" && item.codemode === true
  const splittable = !codemode && (item.kind === "tool" || item.kind === "system" || item.kind === "skill" || item.kind === "base")
  const kids = (): readonly Lazy[] =>
    cachedKids(memo, `item:${level}:${owner ?? ""}:${item.id}`, () =>
      splitOf(memo, level, owner, item).sections.map((section) =>
        lazySection(ctx, memo, level, owner, item, section, depth + 1 + section.depth),
      ),
    )
  return {
    id: `item:${level}:${owner ?? ""}:${item.id}`,
    kind: "item",
    label: item.id === "system:role" ? "Role/persona" : item.title,
    depth,
    address,
    ...(splittable ? { add: "section" as const } : {}),
    actions: {
      toggle: !codemode,
      edit: !codemode,
      reset: canReset(ctx.customizations, address),
      remove: removable(level, owner, item),
      split: splittable,
    },
    selfReview: () => flagOf(memo, level, owner, item, null),
    partial: () => itemBadges(memo, level, owner, agent, item),
    reviewCount: () => itemRollup(memo, level, owner, item),
    children: kids,
  }
}

function itemBadges(memo: Memo, level: Level, owner: string | null, agent: AgentSource | null, item: Item): TreeNodeBadges {
  const resolved = wholeOf(memo, level, owner, item)
  const active = agent?.base !== undefined && item.id === `base:${agent.base}`
  return {
    state: resolved.enabled ? "on" : "off",
    modified: resolved.modified,
    source: resolved.source,
    ...(active ? { active: true } : {}),
    // A user template id can never be the host active answer, so it reads as
    // applicable while never reaching system[0]. `inactive` reuses the
    // existing active/state badge slot the tree already uses for base
    // liveness: it is the negation of active, not a new visual language.
    ...(item.kind === "base" && item.userBase === true ? { inactive: true } : {}),
    // Stored Code Mode customizations are filtered out of apply and never
    // reach the session, so the row must not read as live state. `unsupported`
    // reuses the existing review-family slot for content that will not take
    // effect: like review it flags saved content needing user attention,
    // rather than inventing a new badge language.
    ...(item.kind === "tool" && item.codemode === true ? { unsupported: true } : {}),
  }
}

function lazySection(
  ctx: BuildContext,
  memo: Memo,
  level: Level,
  owner: string | null,
  item: Item,
  section: Section,
  depth: number,
): Lazy {
  const address: Address = { level, agent: owner, item: item.id, section: section.id }
  return {
    id: `section:${level}:${owner ?? ""}:${item.id}:${section.id}`,
    kind: "section",
    label: section.name,
    depth,
    address,
    actions: { toggle: true, edit: true, reset: canReset(ctx.customizations, address), remove: false, split: false },
    selfReview: () => flagOf(memo, level, owner, item, section.id),
    partial: () => sectionBadges(memo, level, owner, item, section),
    reviewCount: () => 0,
    children: () => [],
  }
}

function sectionBadges(memo: Memo, level: Level, owner: string | null, item: Item, section: Section): TreeNodeBadges {
  const resolved = sectionResolveOf(memo, level, owner, item, section.id)
  return {
    state: resolved.enabled ? "on" : "off",
    modified: resolved.modified,
    review: resolved.review,
    source: resolved.source,
  }
}

// User-owned rows can be deleted outright: shared MCP servers, project-group
// items (skills, added instructions, added base prompts), user-created base
// templates (which carry group "none" with userBase, deletable through
// base.delete while builtins stay refused), and agents. The
// agent's own Role/persona body is owned but not deletable.
function removable(level: Level, owner: string | null, item: Item): boolean {
  if (level === "defaults" && owner === null && item.kind === "mcp") return true
  if (item.id === "system:role") return false
  if (item.kind === "base" && item.userBase === true) return true
  return item.group === "project"
}

function sortedKind(ctx: BuildContext, kind: Item["kind"], owner: string | null): Item[] {
  return ctx.items
    .filter((item) => item.kind === kind && (owner === null || applies(item, owner)))
    .sort(byOrderTitle)
}

function byOrderTitle(left: Item, right: Item): number {
  const order = (left.order ?? Number.MAX_SAFE_INTEGER) - (right.order ?? Number.MAX_SAFE_INTEGER)
  if (order !== 0) return order
  if (left.title < right.title) return -1
  if (left.title > right.title) return 1
  return 0
}

function noActions(): TreeNodeActions {
  return { toggle: false, edit: false, reset: false, remove: false, split: false }
}
