import { applies, canReset, catalogueForAddress, catalogueOf, sameTeam, upstreamForEdit } from "./model.js"
import { controlItemFor, isControl } from "./agent-controls.js"
import { ruleItem } from "./rules.js"
import type {
  Address,
  AgentSource,
  Catalogue,
  CustomizationRecord,
  Item,
  Level,
  SplitRecord,
  TeamRef,
} from "./model.js"
import { buildMemo, rowTeamOf, sectionResolveOf, splitOf, wholeOf, type Memo, type MemoInput } from "./resolve-memo.js"
import { lazyControl, materialize, skeletonOf, tabLayout, toolParameters, toolPermissions, type Lazy, type TreeNode, type TreeNodeActions, type TreeNodeKind } from "./tree.js"
import { changedLines } from "./diff-lines.js"
import { isModelDefaultRowId, parseModelDefaultItemId, parseModelSettingItemId, settingsFor, type ModelSettingsRecord } from "./model-settings.js"
import { tabOfItem, teamsOwnerSegment } from "./folders.js"
import { badgeLabels } from "./from-label.js"

export type Field =
  | "id"
  | "badges"
  | "source"
  | "tokens"
  | "text"
  | "upstream"
  | "record"
  | "label"
  | "path"
  | "updated"
  | "sections"
  | "from"

export type Sort =
  | "tokens"
  | "delta"
  | "updated"
  | "label"
  | "id"
  | "-tokens"
  | "-delta"
  | "-updated"
  | "-label"
  | "-id"

export interface QueryOptions {
  readonly where?: string
  readonly fields?: readonly Field[]
  readonly sort?: Sort
  readonly limit?: number
  readonly offset?: number
  /**
   * Leave out a Description row (the tree's alias of its item's whole text)
   * when its item row matched too: the two carry the same text and state.
   */
  readonly withoutAliases?: boolean
  /** find's one row per thing (see Collapse). */
  readonly collapse?: Collapse
}

/**
 * How find narrows a match to one row per thing (`findCollapse` picks the
 * parts a question does not ask past).
 */
export interface Collapse {
  /** Leave out section rows: their item row carries the same match. */
  readonly sections: boolean
  /** Leave out Description rows: each is its item's whole text again. */
  readonly descriptions: boolean
  /** Leave out rows at the Presets level. */
  readonly presets: boolean
  /**
   * One row per thing across project, global and defaults: its most specific
   * level, chosen before filtering, so a row shows what runs here.
   */
  readonly levels: boolean
  /**
   * Agents' copies of a row with the same on/off and text are one row: the
   * shared Defaults row when it is one of them; `QueryRow.copies` counts the rest.
   */
  readonly copies: boolean
}

// Keys that ask about an edit stored at one level rather than what runs: each
// level's row (presets too) is its own answer, so they keep every level and
// every copy.
const recordKeys = new Set(["is", "modified", "review", "overridden", "shadowed", "acked", "orphan", "updated", "identical", "dead"])

/**
 * find's collapse for a where: each part is on unless a positive term asks
 * for what it leaves out. `in:` and `id:` name rows outright.
 */
export function findCollapse(where: string): Collapse {
  const terms = splitTerms(where).flatMap((raw) => {
    const colon = indexOfColon(raw)
    if (raw.startsWith("!") || colon === -1) return []
    return [{ key: lower(raw.slice(0, colon)), value: lower(raw.slice(colon + 1)) }]
  })
  const asks = (keys: readonly string[], value?: string) =>
    terms.some((term) => keys.includes(term.key) && (value === undefined || term.value.includes(value)))
  const named = asks(["in", "id"])
  // is:held-back asks what runs, not about an edit; most of its rows are sections.
  const heldBack = (term: { key: string; value: string }) => term.key === "is" && term.value.replace(/["']/g, "").split(",").every((value) => value === "held-back")
  const record = terms.some((term) => recordKeys.has(term.key) && !heldBack(term)) || asks(["has"], "record")
  return {
    // A section's name is its own, so a name asks for sections too.
    sections: !named && !asks(["type", "kind"], "section") && !asks(["has"], "sections") && !asks(["name"]) && !asks(["is"], "held-back"),
    descriptions: !asks(["id"]),
    presets: !named && !record && !asks(["level", "type", "kind"], "preset"),
    levels: !named && !record && !asks(["level"]),
    copies: !named && !record && !asks(["agent", "team"]),
  }
}

/** find's row types (`type:`). */
export const rowTypes = [
  "agent",
  "team",
  "member",
  "preset",
  "entry",
  "tool",
  "param",
  "rule",
  "skill",
  "system",
  "base",
  "model",
  "setting",
  "compaction",
  "mcp",
  "section",
  "group",
] as const

export type RowType = (typeof rowTypes)[number]

/** find's named finds (`is:`). */
export const namedFinds = ["review", "changed", "overruled", "orphaned", "held-back"] as const

export interface QueryRow {
  readonly id: string
  readonly badges?: string
  readonly source?: Level | "upstream"
  readonly tokens?: number
  readonly text?: string
  readonly upstream?: string
  readonly record?: CustomizationRecord
  readonly label?: string
  readonly path?: string
  readonly updated?: string
  readonly sections?: readonly string[]
  /** Where the row's value comes from, in words ("from preset Orchestrator"). */
  readonly from?: string
  /** Other agents' copies with the same value that this row stands for (Collapse.copies). */
  readonly copies?: number
}

export function query(input: MemoInput, options?: QueryOptions, memo?: Memo): { rows: QueryRow[]; total: number } {
  const active = memo ?? buildMemo(input)
  const state = queryState(active)
  const parsed = parseWhere(options?.where ?? "", state)
  const collapse = options?.collapse
  const candidates = collectCandidates(state, parsed, parsed.wantsChains, collapse)
  const found = (collapse?.levels === true ? mostSpecific(candidates) : candidates).filter(
    (candidate) => !(collapse?.descriptions === true && isDescriptionAlias(candidate)) && parsed.filters.every((filter) => filter.negate !== filter.test(candidate)),
  )
  const ids = options?.withoutAliases === true ? new Set(found.map((candidate) => candidate.id)) : undefined
  const unaliased = ids === undefined ? found : found.filter((candidate) => !isDescriptionAlias(candidate) || !ids.has(candidate.id.slice(0, -":description".length)))
  const copies = collapse?.copies === true ? foldCopies(state, unaliased) : undefined
  const matched = copies === undefined ? unaliased : unaliased.filter((candidate) => candidate.address === undefined || copies.has(candidate))
  const sorted = sortCandidates(state, matched, parseSort(options?.sort) ?? parsed.sort)
  const total = sorted.length
  const offset = options?.offset ?? 0
  const limit = options?.limit ?? sorted.length
  if (!Number.isInteger(offset) || offset < 0) throw new Error(`bad query offset "${offset}"`)
  if (!Number.isInteger(limit) || limit < 0) throw new Error(`bad query limit "${limit}"`)
  const fields = options?.fields ?? (["id", "badges", "source", "tokens"] as const satisfies readonly Field[])
  const rows = sorted.slice(offset, offset + limit).map((candidate) => {
    const row = project(state, candidate, fields)
    const more = copies?.get(candidate) ?? 0
    return more === 0 ? row : { ...row, copies: more }
  })
  return { rows, total }
}

// tree.ts descriptionRow: a section row at its item's whole address.
function isDescriptionAlias(candidate: Candidate): boolean {
  return candidate.kind === "section" && candidate.address?.section === null && candidate.id.endsWith(":description")
}

// Agents' copies of a row (one item or section) with the same on/off and
// text fold into one: the shared Defaults row when it is one of them (the
// Teams catalogue's shared row with it), else the first. Answers each kept
// row and how many agents' copies it stands for.
function foldCopies(state: QueryState, candidates: readonly Candidate[]): Map<Candidate, number> {
  const groups = new Map<string, Candidate[]>()
  for (const candidate of candidates) {
    const address = candidate.address
    if (address === undefined) continue
    const key = JSON.stringify([address.item, address.section, nodeOf(state, candidate)?.badges.state ?? null, resolvedTextOf(state, candidate)])
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [candidate])
    else group.push(candidate)
  }
  return new Map(
    [...groups.values()].map((group) => {
      const kept = group.find((candidate) => candidate.address?.agent === null) ?? group[0]!
      return [kept, group.filter((candidate) => candidate !== kept && candidate.address?.agent !== null).length]
    }),
  )
}

// The same row at project, global and defaults (its id differs only in the
// level segment) is one thing: keep its most specific level. Presets are
// their own things.
function mostSpecific(candidates: readonly Candidate[]): Candidate[] {
  const rank = { project: 3, global: 2, defaults: 1 } as Record<string, number>
  const thing = (candidate: Candidate) => candidate.id.split(":").map((part, index) => (index === 1 ? "*" : part)).join(":")
  const best = new Map<string, Candidate>()
  for (const candidate of candidates) {
    const level = rank[levelOf(candidate) ?? ""]
    if (level === undefined) continue
    const current = best.get(thing(candidate))
    if (current === undefined || level > (rank[levelOf(current) ?? ""] ?? 0)) best.set(thing(candidate), candidate)
  }
  const kept = new Set(best.values())
  return candidates.filter((candidate) => kept.has(candidate) || rank[levelOf(candidate) ?? ""] === undefined)
}

interface QueryState {
  readonly memo: Memo
  readonly recs: Map<string, CustomizationRecord[]>
  readonly splits: Map<string, SplitRecord[]>
  readonly agents: Map<string, AgentSource>
  readonly items: Map<string, Item[]>
  /** item id → the name of the folder that holds the row. */
}

/**
 * The TUI filter's row set: the query engine's match semantics, with each
 * match's ancestor chain taken from the candidate walk itself. Only matches
 * and their ancestors are materialised, so a filter never builds the full
 * tree.
 */
export interface MatchedTree {
  /** Ids the filter itself matched (never ancestors). */
  readonly matched: ReadonlySet<string>
  /** Matched rows plus every match's ancestor chain, in tree order. */
  readonly rows: readonly TreeNode[]
}

export function matchedTree(input: MemoInput, where: string, memo?: Memo): MatchedTree {
  const needle = where.trim()
  if (needle.length === 0) return { matched: new Set(), rows: [] }
  const active = memo ?? buildMemo(input)
  const state = queryState(active)
  try {
    const parsed = parseWhere(needle, state)
    const candidates = collectCandidates(state, parsed, true)
    const found = candidates.filter((candidate) => parsed.filters.every((filter) => filter.negate !== filter.test(candidate)))
    const keep = new Set<Candidate>()
    const matched = new Set<string>()
    for (const candidate of found) {
      const node = nodeOf(state, candidate)
      if (node === undefined || !visibleRow(node.kind, node.actions?.toggle)) continue
      matched.add(candidate.id)
      for (const ancestor of candidate.ancestors ?? []) keep.add(ancestor)
      keep.add(candidate)
    }
    const rows = candidates.flatMap((candidate) => {
      if (!keep.has(candidate)) return []
      const node = nodeOf(state, candidate)
      return node === undefined ? [] : [node]
    })
    return { matched, rows }
  } catch {
    return fallbackTree(state, needle.toLowerCase())
  }
}

// Today's visible-row rule: section rows only when they can be toggled. Both a
// materialised row and a lazy row carry the two fields it reads.
function visibleRow(kind: TreeNodeKind, toggle: boolean | undefined): boolean {
  return kind !== "section" || toggle === true
}

// The grammar-rejected fallback: a label/id substring across every root,
// walking the lazy skeleton's cheap fields and materialising hits plus their
// ancestor chains only.
function fallbackTree(state: QueryState, needle: string): MatchedTree {
  const order: Lazy[] = []
  const matched: Lazy[] = []
  const ancestors = new Map<string, readonly Lazy[]>()
  const stack: Lazy[] = []
  const walk = (lazy: Lazy) => {
    order.push(lazy)
    if (visibleRow(lazy.kind, lazy.actions.toggle) &&
      (lazy.label.toLowerCase().includes(needle) || lazy.id.toLowerCase().includes(needle))) {
      matched.push(lazy)
      ancestors.set(lazy.id, [...stack])
    }
    stack.push(lazy)
    for (const child of lazy.children()) walk(child)
    stack.pop()
  }
  for (const root of skeletonOf(state.memo)) walk(root)
  const keep = new Set<Lazy>(matched)
  for (const lazy of matched) for (const ancestor of ancestors.get(lazy.id) ?? []) keep.add(ancestor)
  return { matched: new Set(matched.map((lazy) => lazy.id)), rows: order.filter((lazy) => keep.has(lazy)).map(materialize) }
}

interface Candidate {
  readonly id: string
  readonly kind: TreeNodeKind
  readonly label: string
  readonly depth: number
  readonly index: number
  readonly orphan: boolean
  readonly lazy: Lazy | undefined
  readonly parent: Lazy | undefined
  readonly address: Address | undefined
  readonly sectionIds: readonly string[]
  /** Pre-order ancestor path (root first), recorded only for filter row walks. */
  readonly ancestors?: readonly Candidate[]
  node: TreeNode | undefined
  resolvedText: string | undefined
  upstreamText: string | undefined
}

interface Filter {
  readonly negate: boolean
  readonly rank: number
  readonly excludesSections: boolean
  readonly mentionsSections: boolean
  /** `kind:group`: a tool's Description group only exists once its sections are known. */
  readonly mentionsGroups?: boolean
  readonly propagating: boolean
  /** Positive `level:`/`id:` terms: the only root levels whose rows can match. */
  readonly roots?: ReadonlySet<string>
  /** Positive `id:` terms: the lowercased prefixes a matching id starts with. */
  readonly idPrefixes?: readonly string[]
  readonly test: (candidate: Candidate) => boolean
}

interface SortSpec {
  readonly key: "tokens" | "delta" | "updated" | "label" | "id"
  readonly descending: boolean
}

interface Parsed {
  readonly filters: Filter[]
  readonly sort: SortSpec | undefined
  readonly wantsOrphans: boolean
  /** An `in:` term reads each candidate's ancestors. */
  readonly wantsChains: boolean
}

function queryState(memo: Memo): QueryState {
  const recs = new Map<string, CustomizationRecord[]>()
  for (const record of memo.ctx.customizations) {
    const key = JSON.stringify([record.item, record.section])
    const list = recs.get(key) ?? []
    list.push(record)
    recs.set(key, list)
  }
  const splits = new Map<string, SplitRecord[]>()
  for (const split of memo.ctx.splits) {
    const key = JSON.stringify([split.level, split.agent, split.item, catalogueOf(split.catalogue)])
    const list = splits.get(key) ?? []
    list.push(split)
    splits.set(key, list)
  }
  const items = new Map<string, Item[]>()
  for (const item of memo.ctx.items) {
    const list = items.get(item.id) ?? []
    list.push(item)
    items.set(item.id, list)
  }
  return { memo, recs, splits, items, agents: new Map(memo.ctx.agents.map((agent) => [agent.id, agent])) }
}

function recsAt(state: QueryState, item: string, section: string | null): readonly CustomizationRecord[] {
  return state.recs.get(JSON.stringify([item, section])) ?? []
}

function atNode(
  records: readonly CustomizationRecord[],
  level: Level,
  agent: string | null,
  catalogue: Catalogue,
  team?: TeamRef,
): CustomizationRecord | undefined {
  return records.find(
    (record) =>
      record.level === level &&
      record.agent === agent &&
      sameTeam(record.team, team) &&
      (agent !== null || catalogueOf(record.catalogue) === catalogue),
  )
}

function ownOf(state: QueryState, address: Address): CustomizationRecord | undefined {
  return atNode(recsAt(state, address.item, address.section), address.level, address.agent, catalogueForAddress(address), address.team)
}

// Defaults › Models rows keep their record in their own snapshot field, not in
// the inventory records.
function modelDefaultRecordOf(state: QueryState, address: Address): ModelSettingsRecord | undefined {
  const key = parseModelDefaultItemId(address.item) ?? parseModelSettingItemId(address.item)?.key
  return key === undefined ? undefined : settingsFor(state.memo.ctx.modelSettings, key)
}

function splitOfAddress(state: QueryState, address: Address): SplitRecord | undefined {
  return state.splits.get(JSON.stringify([address.level, address.agent, address.item, catalogueForAddress(address)]))?.[0]
}

function lookupItem(state: QueryState, itemId: string, owner: string | null, context?: Pick<Address, "team" | "memberOf" | "level" | "catalogue">): Item | undefined {
  if (isControl(itemId)) return controlItemFor(state.memo.ctx.items, { item: itemId, agent: owner, ...context })
  const matches = state.items.get(itemId) ?? []
  const item = (owner === null ? undefined : matches.find((entry) => applies(entry, owner))) ?? matches[0]
  if (item?.kind === "perm" && context !== undefined) return ruleItem(item, state.memo.ctx.rules, state.memo.ctx.scopes, { ...context, agent: owner, item: itemId, section: null })
  if (item?.kind !== "tool" || item.execute === true || context === undefined) return item
  const exposure = state.items.get(`toolmode:${item.id.slice("tool:".length)}`)?.[0]
  if (exposure === undefined) return item
  return { ...item, codemode: wholeOf(state.memo, context.level, owner, exposure, context.catalogue, rowTeamOf(context)).assembled === "codemode" }
}

// Candidates walk the lazy skeleton: branch children are cheap, item rows
// enumerate their sections through the shared memo split, so listing rows
// costs the same per-row resolve the TUI already pays when it builds the
// tree. Section expansion is skipped when a positive structural term can
// never match a section, or when the item itself fails a term its sections
// necessarily fail (level, agent, and the upstream item attributes).
//
// `chains` records each candidate's ancestor path from the walk's depth stack,
// so a filtered row set can include its ancestors without a second whole-tree
// walk. It costs one array per candidate, so only the filter path asks for it.
function collectCandidates(state: QueryState, parsed: Parsed, chains = false, collapse?: Collapse): Candidate[] {
  const out: Candidate[] = []
  const seen = new Set<string>()
  const stack: Candidate[] = []
  const push = (candidate: Omit<Candidate, "index" | "node" | "resolvedText" | "upstreamText" | "ancestors">) => {
    if (seen.has(candidate.id)) return
    seen.add(candidate.id)
    if (chains) while (stack.length > 0 && stack[stack.length - 1]!.depth >= candidate.depth) stack.pop()
    const next: Candidate = {
      ...candidate,
      index: out.length,
      ...(chains ? { ancestors: [...stack] } : {}),
      node: undefined,
      resolvedText: undefined,
      upstreamText: undefined,
    }
    out.push(next)
    if (chains) stack.push(next)
  }
  const skipRows = collapse?.sections === true || parsed.filters.some((filter) => filter.excludesSections)
  const needIds = !skipRows || parsed.filters.some((filter) => filter.mentionsSections)
  const visit = (lazy: Lazy) => {
    if (lazy.kind === "item" && lazy.address !== undefined) {
      const enumerated = !needIds || failsPropagating(parsed, lazy) || missesById(parsed, lazy.id) ? [] : sectionsFor(lazy)
      push({ id: lazy.id, kind: lazy.kind, label: lazy.label, depth: lazy.depth, orphan: false, lazy, parent: undefined, address: lazy.address, sectionIds: enumerated.map((section) => section.id) })
      for (const section of enumerated) {
        if (!skipRows)
          push({ id: section.id, kind: "section", label: section.label, depth: section.depth, orphan: false, lazy: section.row, parent: section.parent ?? lazy, address: section.address, sectionIds: [] })
      }
      // A tool's parameters and their permissions are
      // walked directly: building them resolves nothing, whereas
      // lazy.children() would also derive sections via splitOf and resolve
      // every address even for structural misses.
      const address = lazy.address
      const item = address === undefined ? undefined : lookupItem(state, address.item, address.agent, address)
      // Perm rows hang off the tool row and share its owner path, which the
      // row id already carries between `item:<level>:` and `:<itemId>`.
      const ownerPath = address === undefined ? "" : lazy.id.slice(`item:${address.level}:`.length, lazy.id.length - address.item.length - 1)
      const tool = item?.kind === "param" && item.paramTool !== undefined ? lookupItem(state, `tool:${item.paramTool}`, address.agent, address) : item
      const groups =
        tool === undefined || tool.kind !== "tool"
          ? []
          : item?.kind === "param"
            ? toolPermissions(state.memo.ctx, state.memo, address.level, address.agent, tool, lazy.depth + 1, rowTeamOf(address), address.catalogue, ownerPath, item.title)
          : [
              ...state.memo.ctx.items.filter((entry) => entry.id === `toolmode:${tool.id.slice("tool:".length)}`)
                .map((entry) => lazyControl(state.memo, address.level, address.agent, entry, lazy.depth + 1, rowTeamOf(address), address.catalogue, ownerPath)),
              ...toolParameters(state.memo.ctx, state.memo, address.level, address.agent, tool, lazy.id, lazy.depth + 1, rowTeamOf(address), address.catalogue, ownerPath),
              ...toolPermissions(state.memo.ctx, state.memo, address.level, address.agent, tool, lazy.depth + 1, rowTeamOf(address), address.catalogue, ownerPath),
            ]
      const walk = (node: Lazy) => {
        // A parameter row is a full item (its own text and sections), not a
        // permission row: visit it.
        if (node.kind === "item" && node.address?.item.startsWith("param:") === true) return visit(node)
        push({ id: node.id, kind: node.kind, label: node.label, depth: node.depth, orphan: false, lazy: node, parent: undefined, address: node.address, sectionIds: [] })
        if (node.kind === "group") for (const child of node.children()) walk(child)
      }
      for (const group of groups) walk(group)
      // A model row's field rows (agent rows and Defaults › Models rows
      // alike): built from the row alone, through the Warming and Compaction
      // groups and the cold-cache list, without splitting an item's text.
      if (isModelDefaultRowId(lazy.id) || address.item.startsWith("model:")) {
        const walkField = (node: Lazy) => {
          push({ id: node.id, kind: node.kind, label: node.label, depth: node.depth, orphan: false, lazy: node, parent: undefined, address: node.address, sectionIds: [] })
          if (node.kind === "group") for (const child of node.children()) walkField(child)
        }
        for (const child of lazy.children()) walkField(child)
      }
      return
    }
    push({ id: lazy.id, kind: lazy.kind, label: lazy.label, depth: lazy.depth, orphan: false, lazy, parent: undefined, address: lazy.address, sectionIds: [] })
    for (const child of lazy.children()) visit(child)
  }
  const roots = parsed.filters.flatMap((filter) => (filter.roots === undefined ? [] : [filter.roots]))
  for (const root of skeletonOf(state.memo))
    if (roots.every((allowed) => allowed.has(root.id.slice("root:".length))) && !(collapse?.presets === true && root.id === "root:preset")) visit(root)
  if (parsed.wantsOrphans) pushOrphans(state, push, skipRows)
  return collapse?.presets === true ? out.filter((candidate) => levelOf(candidate) !== "preset") : out
}

const propagatingKeys = new Set(["level", "catalogue", "agent", "item", "group", "server", "codemode", "namespace", "execute", "tool", "folder"])
// pinned is resolved state like state:/modified: (per-row resolve through the
// shared memo), so it must not propagate: a section inherits its whole row's
// pin for display, but enumeration cannot skip sections from the item test.

// A positive `id:` term none of whose prefixes can match this item row or
// any of its sections (`section:…`) and Description group (`group:…`):
// enumerating them would split the item for nothing.
function missesById(parsed: Parsed, itemId: string): boolean {
  const id = itemId.toLowerCase()
  const rest = id.slice("item:".length)
  const under = [`section:${rest}:`, `group:${rest}:`, `${id}:description`]
  return parsed.filters.some(
    (filter) =>
      filter.idPrefixes !== undefined &&
      filter.idPrefixes.every(
        (prefix) => !id.startsWith(prefix) && under.every((head) => !head.startsWith(prefix) && !prefix.startsWith(head)),
      ),
  )
}

function failsPropagating(parsed: Parsed, lazy: Lazy): boolean {
  const probe: Candidate = { id: lazy.id, kind: lazy.kind, label: lazy.label, depth: lazy.depth, index: -1, orphan: false, lazy, parent: undefined, address: lazy.address, sectionIds: [], node: undefined, resolvedText: undefined, upstreamText: undefined }
  return parsed.filters.some((filter) => filter.propagating && !filter.test(probe))
}

interface SectionRow {
  readonly id: string
  readonly label: string
  readonly depth: number
  readonly address?: Address
  /** The row whose children hold this section, when it is not the item row. */
  readonly parent?: Lazy
  readonly row?: Lazy
}

function sectionsFor(lazy: Lazy): SectionRow[] {
  // Description and its split sections share the tree's own addresses and
  // actions. Host-owned rows have no editable text children.
  const rows: SectionRow[] = []
  for (const child of lazy.children()) {
    if (child.id === `${lazy.id}:description`) {
      rows.push({ id: child.id, label: child.label, depth: child.depth, address: child.address, row: child })
      for (const section of child.children()) {
        rows.push({ id: section.id, label: section.label, depth: section.depth, address: section.address, parent: child, row: section })
      }
      continue
    }
    if (child.kind !== "section" || child.address === undefined) continue
    rows.push({ id: child.id, label: child.label, depth: child.depth, address: child.address })
  }
  return rows
}

// Orphan means stale by the record alone: the item id names no snapshot
// item, the agent names no known agent, or the section id is gone from the
// current split at that address. Records at rowless but valid addresses
// (per-agent MCP state, say) are not orphans.
function pushOrphans(
  state: QueryState,
  push: (candidate: Omit<Candidate, "index" | "node" | "resolvedText" | "upstreamText">) => void,
  skipSections: boolean,
): void {
  const seen = new Set<string>()
  for (const record of state.memo.ctx.customizations) {
    const key = JSON.stringify([record.level, record.agent, record.item, record.section, catalogueOf(record.catalogue)])
    if (seen.has(key)) continue
    seen.add(key)
    if (record.section !== null && skipSections) continue
    if (!isOrphan(state, record.level, record.agent, record.item, record.section, record.catalogue)) continue
    const address: Address = {
      level: record.level,
      agent: record.agent,
      item: record.item,
      section: record.section,
      ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
    }
    const owner = ownerSegmentOf(record.agent, record.catalogue)
    if (record.section === null)
      push({ id: `item:${record.level}:${owner}:${record.item}`, kind: "item", label: record.item, depth: 0, orphan: true, lazy: undefined, parent: undefined, address, sectionIds: [] })
    else
      push({ id: `section:${record.level}:${owner}:${record.item}:${record.section}`, kind: "section", label: record.section, depth: 0, orphan: true, lazy: undefined, parent: undefined, address, sectionIds: [] })
  }
  for (const split of state.memo.ctx.splits) {
    const key = JSON.stringify([split.level, split.agent, split.item, null, catalogueOf(split.catalogue)])
    if (seen.has(key)) continue
    seen.add(key)
    if (!isOrphan(state, split.level, split.agent, split.item, null, split.catalogue)) continue
    push({
      id: `item:${split.level}:${ownerSegmentOf(split.agent, split.catalogue)}:${split.item}`,
      kind: "item",
      label: split.item,
      depth: 0,
      orphan: true,
      lazy: undefined,
      parent: undefined,
      address: {
        level: split.level,
        agent: split.agent,
        item: split.item,
        section: null,
        ...(split.catalogue === undefined ? {} : { catalogue: split.catalogue }),
      },
      sectionIds: [],
    })
  }
}

function ownerSegmentOf(agent: string | null, catalogue: Catalogue | undefined): string {
  if (agent !== null) return agent
  return catalogueOf(catalogue) === "teams" ? teamsOwnerSegment : ""
}

function isOrphan(
  state: QueryState,
  level: Level,
  agent: string | null,
  itemId: string,
  section: string | null,
  catalogue?: Catalogue,
): boolean {
  const item = lookupItem(state, itemId, agent)
  if (item === undefined && !state.memo.ctx.items.some((row) => row.permissionSource === itemId)) return true
  // Presets and Defaults entries own records too, without being agents.
  if (agent !== null && !state.agents.has(agent) && !ownsRecords(state, level, agent)) return true
  if (section === null) return false
  if (item === undefined) return true
  return !splitOf(state.memo, level, agent, item, catalogue).sections.some((entry) => entry.id === section)
}

function ownsRecords(state: QueryState, level: Level, agent: string): boolean {
  if (level === "preset") return state.memo.ctx.listing.some((entry) => entry.ref.kind !== "team" && entry.ref.id === agent)
  if (level === "defaults") return state.memo.ctx.entries.some((entry) => entry.name === agent)
  return false
}

// Badge values come from the one tree path: materializing a lazy row runs
// the shared memo resolves exactly like the TUI build does. Section rows
// materialize through their parent item's cached children.
function nodeOf(state: QueryState, candidate: Candidate): TreeNode | undefined {
  if (candidate.node !== undefined) return candidate.node
  if (candidate.lazy !== undefined) {
    candidate.node = materialize(candidate.lazy)
    return candidate.node
  }
  const parent = candidate.parent
  const address = candidate.address
  if (parent === undefined || address === undefined) return undefined
  const found = parent.children().find((child) => child.id === candidate.id)
  if (found === undefined) return undefined
  candidate.node = materialize(found)
  return candidate.node
}

function resolvedTextOf(state: QueryState, candidate: Candidate): string {
  if (candidate.resolvedText !== undefined) return candidate.resolvedText
  const address = candidate.address
  const item = address === undefined ? undefined : lookupItem(state, address.item, address.agent, address)
  const resolved =
    address === undefined || item === undefined
      ? undefined
      : address.section === null
        ? wholeOf(state.memo, address.level, address.agent, item, address.catalogue, rowTeamOf(address))
        : sectionResolveOf(state.memo, address.level, address.agent, item, address.section, address.catalogue, rowTeamOf(address))
  const text = resolved?.fullText ?? resolved?.text ?? ""
  candidate.resolvedText = text
  return text
}

function upstreamTextOf(state: QueryState, candidate: Candidate): string {
  if (candidate.upstreamText !== undefined) return candidate.upstreamText
  const address = candidate.address
  const item = address === undefined ? undefined : lookupItem(state, address.item, address.agent, address)
  const text =
    address === undefined || item === undefined
      ? ""
      : upstreamForEdit({
          upstream: item,
          records: state.memo.ctx.customizations,
          splits: state.memo.ctx.splits,
          scopes: state.memo.ctx.scopes,
          address,
        })
  candidate.upstreamText = text
  return text
}

function actionsOf(state: QueryState, candidate: Candidate): TreeNodeActions {
  if (candidate.lazy !== undefined) return candidate.lazy.actions
  const address = candidate.address
  if (address === undefined || candidate.orphan)
    return { toggle: false, edit: false, reset: false, remove: false, split: false, pin: false }
  const item = lookupItem(state, address.item, address.agent, address)
  // Pin is true only for a whole Code Mode tool row, never a section and
  // never the host-owned execute row: mirrors lazyItem in tree.ts.
  const executable = item?.execute === true
  if (address.section !== null)
    return {
      toggle: true,
      edit: true,
      reset: canReset(state.memo.ctx.customizations, address),
      remove: false,
      split: false,
      pin: false,
    }
  if (executable) return { toggle: true, edit: false, reset: false, remove: false, split: false, pin: false }
  if (item?.kind === "perm")
    return {
      toggle: true,
      edit: true,
      reset: canReset(state.memo.ctx.customizations, address),
      remove: item.custom === true,
      split: false,
      pin: false,
    }
  const pinnable = item !== undefined && item.kind === "tool" && item.codemode === true
  return {
    toggle: true,
    edit: true,
    reset: canReset(state.memo.ctx.customizations, address),
    remove: false,
    split: false,
    pin: pinnable,
  }
}

function levelOf(candidate: Candidate): Level | undefined {
  if (candidate.address !== undefined) return candidate.address.level
  const segment = candidate.id.split(":")[1]
  return segment === "project" || segment === "global" || segment === "defaults" || segment === "preset" ? segment : undefined
}

function agentOf(candidate: Candidate): string | null {
  if (candidate.address !== undefined) return candidate.address.agent
  if (candidate.kind === "agent") return candidate.id.split(":").slice(2).join(":")
  if (candidate.id.startsWith("team:") && candidate.id.includes(":special:")) {
    const parts = candidate.id.split(":")
    return parts[parts.length - 1] ?? null
  }
  if (candidate.id.startsWith("group:") && candidate.id.includes("/:special:")) {
    const match = candidate.id.match(/\/:special:([^:]+)/)
    return match ? match[1] : null
  }
  return null
}

// The catalogue a row belongs to. Addressed rows answer from their address;
// structural rows answer from the id, which carries the catalogue in its
// second segment (`group:<level>:agents|teams`, `team:`/`agent:` prefixes) or
// in the owner segment (`` vs `/teams`). Roots belong to neither.
function catalogueOfCandidate(candidate: Candidate): Catalogue | undefined {
  if (candidate.address !== undefined) return catalogueForAddress(candidate.address)
  const id = candidate.id
  if (candidate.kind === "root") return undefined
  if (id.startsWith("team:")) return "teams"
  if (id.startsWith("agent:")) return "agents"
  const parts = id.split(":")
  if (parts[0] === "group") {
    // Team-member groups carry `<team>/:<member>` (member presets and Teams
    // entries included); the Presets root's `group:preset:teams[:<origin>]`
    // and every Teams catalogue root are teams too.
    if (parts[2] === "teams" || parts[2] === teamsOwnerSegment || id.includes("/:")) return "teams"
    return "agents"
  }
  return undefined
}

function itemKindOf(state: QueryState, candidate: Candidate): string | undefined {
  const address = candidate.address
  if (address === undefined) return undefined
  const item = lookupItem(state, address.item, address.agent, address)
  if (item !== undefined) return item.kind
  // A Defaults › Models row has no upstream item; its own kind names it.
  if (parseModelDefaultItemId(address.item) !== undefined) return "modeldefault"
  if (parseModelSettingItemId(address.item) !== undefined) return "modelsetting"
  if (!candidate.orphan) return undefined
  const prefix = address.item.split(":")[0]
  return prefix === undefined || prefix === "" ? undefined : prefix
}

// What find calls a row (type:). Rows of no type (roots, how a tool is
// offered, a model's field rows) answer undefined.
function typeOf(state: QueryState, candidate: Candidate): RowType | undefined {
  if (candidate.kind === "section") return "section"
  if (candidate.kind === "group") return "group"
  if (candidate.kind === "agent" || candidate.kind === "team") {
    const owner = candidate.lazy?.owner
    if (owner?.preset !== undefined) return "preset"
    if (owner?.entry !== undefined) return "entry"
    if (candidate.kind === "agent" || candidate.id.includes(":special:")) return "agent"
    return candidate.id.split(":").length > 3 ? "member" : "team"
  }
  const kind = itemKindOf(state, candidate)
  if (kind === "perm") return "rule"
  if (kind === "modeldefault") return "model"
  return (rowTypes as readonly string[]).includes(kind ?? "") ? (kind as RowType) : undefined
}

// A row's own names: its label, and the item or section id it is saved under
// (`read` for tool:read, `git-push` and `shell:git-push` for perm:shell:git-push).
function namesOf(candidate: Candidate): string[] {
  const address = candidate.address
  if (address === undefined) return [candidate.label, candidate.id.split(":").at(-1) ?? ""]
  if (address.section !== null) return [candidate.label, address.section]
  const rest = address.item.slice(address.item.indexOf(":") + 1)
  return [candidate.label, rest, rest.split(":").at(-1) ?? rest]
}

// Equal ignoring case; * or % stand for any text.
function matches(value: string, pattern: string): boolean {
  if (!/[*%]/.test(pattern)) return lower(value) === lower(pattern)
  const source = pattern.split(/[*%]/).map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&")).join(".*")
  return new RegExp(`^${source}$`, "i").test(value)
}

// The tool a row belongs to: the tool itself, its parameters, rules and offering.
function toolOfItem(item: string): string | undefined {
  const [kind, tool] = item.split(":")
  return kind === "tool" || kind === "param" || kind === "perm" || kind === "toolmode" ? tool : undefined
}

// The agent an unaddressed row stands for or sits under: a team member row
// (`team:<level>:<team>:<member>`) or a group under an agent or member.
function ownerAgentOf(state: QueryState, candidate: Candidate): string | null {
  if (candidate.address !== undefined) return null
  const parts = candidate.id.split(":")
  if (candidate.kind === "team" && parts.length > 3 && candidate.lazy?.owner?.preset === undefined) return parts.at(-1) ?? null
  if (candidate.kind !== "group" || parts.length < 4) return null
  if (parts[2]?.endsWith("/")) return parts[3] ?? null
  return state.agents.has(parts[2] ?? "") ? (parts[2] ?? null) : null
}

// Each named find answers for the row that holds the edit, not the rows that
// inherit it or the groups that count it: review is the row's own review,
// changed an edit stored on the row (what reset drops). held-back asks what
// the agent gets instead: on, but its "shown when" does not hold.
function isOf(state: QueryState, candidate: Candidate, what: string): boolean {
  if (what === "orphaned") return candidate.orphan
  if (what === "held-back") return nodeOf(state, candidate)?.badges.heldBack === true
  // A shared edit one agent overrides still applies to the others.
  if (what === "overruled") return candidate.address?.agent !== null && shadowedOf(state, candidate)
  if (what === "review") return candidate.lazy?.selfReview() ?? nodeOf(state, candidate)?.badges.review === true
  return candidate.address !== undefined && (actionsOf(state, candidate).reset || nodeOf(state, candidate)?.badges.modified === true)
}

function teamNamesOf(state: QueryState, candidate: Candidate): string[] {
  const team = candidate.address?.memberOf ?? candidate.address?.team
  if (team !== undefined) return [team.team]
  // Team presets, member presets and Teams entries name their team on the row.
  const ownerTeam = candidate.lazy?.owner?.team
  if (ownerTeam !== undefined) return [ownerTeam.team]
  if (candidate.kind === "agent") {
    const id = agentOf(candidate) ?? ""
    const fromTeams = state.memo.ctx.teams.filter((entry) => entry.agents.includes(id)).map((entry) => entry.team)
    const direct = state.agents.get(id)?.team
    return [...new Set(direct === undefined ? fromTeams : [...fromTeams, direct])]
  }
  if (candidate.kind !== "team" && candidate.kind !== "group") return []
  const level = levelOf(candidate)
  if (level !== "project" && level !== "global" && level !== "defaults") return []
  if (candidate.kind === "group") {
    return state.memo.ctx.teams
      .filter((entry) => entry.level === level)
      .filter((entry) => candidate.id.startsWith(`group:${level}:${entry.team}/`) || candidate.id.startsWith(`team:${level}:${entry.team}:special`))
      .map((entry) => entry.team)
  }
  return state.memo.ctx.teams
    .filter((entry) => entry.level === level)
    .filter((entry) => candidate.id === `team:${level}:${entry.team}` || candidate.id.startsWith(`team:${level}:${entry.team}:`))
    .map((entry) => entry.team)
}

function updatedOf(state: QueryState, candidate: Candidate): string | undefined {
  const address = candidate.address
  if (address === undefined) return undefined
  const own = ownOf(state, address)
  if (own?.updated !== undefined) return own.updated
  if (address.section !== null) return undefined
  return splitOfAddress(state, address)?.updated
}

// Precedence (model.ts resolutionChain): project/agent > global/agent > defaults/agent > defaults/shared.
// An own text or on/off that a more specific level sets too, so it never applies.
function shadowedOf(state: QueryState, candidate: Candidate): boolean {
  const address = candidate.address
  if (address === undefined) return false
  const own = ownOf(state, address)
  if (own === undefined || (own.text === undefined && own.state === undefined)) return false
  const rank = specificity(address.level, address.agent)
  return recsAt(state, address.item, address.section).some(
    (record) =>
      sameScope(record, address) &&
      specificity(record.level, record.agent) > rank &&
      ((own.text !== undefined && record.text !== undefined) || (own.state !== undefined && record.state !== undefined)),
  )
}

function specificity(level: Level, agent: string | null): number {
  if (agent === null) return level === "defaults" ? 0 : 3
  if (level === "project") return 3
  if (level === "global") return 2
  return 1
}

function sameScope(record: CustomizationRecord, address: Address): boolean {
  if (address.agent !== null) return record.agent === address.agent
  return true
}

function deadOf(state: QueryState, candidate: Candidate): boolean {
  const address = candidate.address
  if (address === undefined) return false
  const own = ownOf(state, address)
  if (own === undefined) return false
  const item = lookupItem(state, address.item, address.agent, address)
  if (item === undefined) return false
  if (item.kind === "mcp" && own.text !== undefined) return true
  if (address.section === null && own.text === undefined && own.state === "off" && (item.id === "system:role" || item.kind === "base"))
    return true
  return false
}

function identicalOf(state: QueryState, candidate: Candidate): boolean {
  const address = candidate.address
  if (address === undefined) return false
  const own = ownOf(state, address)
  if (own?.text === undefined) return false
  return own.text === upstreamTextOf(state, candidate)
}

function overridersOf(state: QueryState, candidate: Candidate): number {
  const address = candidate.address
  if (address === undefined || address.level !== "defaults" || address.agent !== null) return 0
  return new Set(
    recsAt(state, address.item, address.section)
      .map((record) => record.agent)
      .filter((agent): agent is string => agent !== null),
  ).size
}

// Keep in sync with packages/core/src/codemode/catalog.ts: the model never
// sees a Code Mode row's whole text, only the catalog line's first
// description line truncated at DESCRIPTION_LIMIT. The host-generated
// signature part of that line is not counted here, only the description.
const DESCRIPTION_LIMIT = 120
const CHARACTERS_PER_TOKEN = 4

function tokensOf(state: QueryState, candidate: Candidate): number {
  if (candidate.address === undefined) return 0
  const text = resolvedTextOf(state, candidate)
  const item = lookupItem(state, candidate.address.item, candidate.address.agent, candidate.address)
  if (item?.kind === "tool" && item.codemode === true) {
    const first = (text.split("\n", 1)[0] ?? "").trim()
    const truncated = first.length > DESCRIPTION_LIMIT ? first.slice(0, DESCRIPTION_LIMIT) : first
    return Math.ceil(truncated.length / CHARACTERS_PER_TOKEN)
  }
  return Math.ceil(text.length / CHARACTERS_PER_TOKEN)
}

function deltaOf(state: QueryState, candidate: Candidate): number {
  const address = candidate.address
  if (address === undefined) return 0
  if (ownOf(state, address)?.text === undefined) return 0
  return changedLines(upstreamTextOf(state, candidate), resolvedTextOf(state, candidate))
}

function parseWhere(where: string, state: QueryState): Parsed {
  const filters: Filter[] = []
  let sort: SortSpec | undefined
  let wantsOrphans = false
  let wantsChains = false
  for (const raw of splitTerms(where)) {
    const parsed = parseTerm(raw, state)
    if (parsed === undefined) continue
    if ("sort" in parsed) {
      sort = parsed.sort
      continue
    }
    filters.push(parsed)
    if (parsed.wantsOrphans) wantsOrphans = true
    if (parsed.wantsChains) wantsChains = true
  }
  return { filters: filters.sort((left, right) => left.rank - right.rank), sort, wantsOrphans, wantsChains }
}

type TermOut = (Filter & { wantsOrphans: boolean; wantsChains: boolean }) | { sort: SortSpec }

function parseTerm(raw: string, state: QueryState): TermOut | undefined {
  if (raw === "") return undefined
  let negate = false
  let body = raw
  if (body.startsWith("!")) {
    negate = true
    body = body.slice(1)
  }
  const colon = indexOfColon(body)
  // A word with a colon that names no key (`Basic/:Planner`, a row id
  // fragment) is a word, not a key.
  if (colon === -1 || !/^[a-z_]+$/i.test(body.slice(0, colon))) {
    const word = unescape(body)
    if (word === "") throw new Error(`empty filter term in "${raw}"`)
    return { negate, rank: 0, excludesSections: false, mentionsSections: false, propagating: false, test: (candidate) => contains(candidate.label, word) || contains(candidate.id, word), wantsOrphans: false, wantsChains: false }
  }
  const key = body.slice(0, colon).toLowerCase()
  const alts = splitValue(body.slice(colon + 1), raw)
  if (key === "sort") {
    if (negate) throw new Error(`cannot negate the sort directive in "${raw}"`)
    if (alts.length !== 1) throw new Error(`bad sort directive in "${raw}"`)
    return { sort: parseSortKey(alts[0] ?? "", raw) }
  }
  const roots = rootsFor(key, alts, negate)
  const idPrefixes = !negate && key === "id" ? alts.map(lower) : undefined
  const wantsOrphans = (key === "orphan" && wantsTrue(alts, negate)) || (key === "is" && !negate && alts.some((alt) => lower(alt) === "orphaned"))
  return { negate, rank: rankFor(key, raw), excludesSections: excludesSections(key, alts, negate), mentionsSections: (key === "has" && alts.some((alt) => lower(alt) === "sections")) || (key === "type" && alts.some((alt) => lower(alt) === "section")), mentionsGroups: !negate && (key === "kind" || key === "type") && alts.some((alt) => lower(alt) === "group"), propagating: !negate && propagatingKeys.has(key), ...(roots === undefined ? {} : { roots }), ...(idPrefixes === undefined ? {} : { idPrefixes }), test: testFor(key, alts, raw, state), wantsOrphans, wantsChains: key === "in" }
}

// The roots a positive `level:` or `id:` term can match under: every row id
// carries its level in its second segment, so an id prefix that reaches it
// (`item:project:…`, `root:pre`) names the only roots worth walking. The
// Presets root alone holds dozens of agent subtrees, so a query that cannot
// match there does not walk it.
function rootsFor(key: string, alts: readonly string[], negate: boolean): ReadonlySet<string> | undefined {
  if (negate) return undefined
  const levels = ["project", "global", "defaults", "preset"]
  if (key === "level") return new Set(alts.map(lower))
  // A row's subtree is at the row's own level.
  if (key === "in") return new Set(alts.flatMap((alt) => levels.filter((level) => level === lower(alt).split(":")[1])))
  if (key !== "id") return undefined
  const matched = alts.map((alt) => {
    const parts = lower(alt).split(":")
    if (parts.length < 2) return levels
    return levels.filter((level) => level.startsWith(parts[1] ?? "") && (parts.length === 2 || level === parts[1]))
  })
  return new Set(matched.flat())
}

function excludesSections(key: string, alts: readonly string[], negate: boolean): boolean {
  if (negate) return false
  if (key === "team") return true
  if (key === "has" && alts.length === 1 && lower(alts[0] ?? "") === "sections") return true
  if (key === "can" && alts.every((alt) => lower(alt) === "split" || lower(alt) === "remove")) return true
  if (key === "kind" && !alts.some((alt) => lower(alt) === "section")) return true
  if (key === "type" && !alts.some((alt) => lower(alt) === "section")) return true
  return false
}

function wantsTrue(alts: readonly string[], negate: boolean): boolean {
  return negate ? alts.some((alt) => lower(alt) === "false") : alts.some((alt) => lower(alt) === "true")
}

function rankFor(key: string, term: string): number {
  if (
    key === "state" ||
    key === "modified" ||
    key === "review" ||
    key === "source" ||
    key === "excluded" ||
    key === "active" ||
    key === "inactive" ||
    key === "unsupported" ||
    key === "pinned" ||
    key === "is"
  )
    return 1
  const textKeys = ["identical", "tokens", "delta", "text", "upstream"]
  const index = textKeys.indexOf(key)
  if (index !== -1) return 2 + index
  if (!structuralKeys.has(key)) throw new Error(unknownKeyMessage(key, term))
  return 0
}

// The keys agents reach for that do not exist, and what says it instead.
const keyHints: Record<string, string> = {
  member: "a team member is an agent: use agent:<member>, with team:<team>",
  preset: "use type:preset name:<preset>",
  entry: "use type:entry name:<name>",
  perm: "use type:rule, with tool:<tool> and name:<rule>",
  rule: "use type:rule, with tool:<tool> and name:<rule>",
}

function unknownKeyMessage(key: string, term: string): string {
  const hint = keyHints[key] ?? ((rowTypes as readonly string[]).includes(key) ? `use type:${key} name:<name>` : undefined)
  return `unknown filter key "${key}" in "${term}"; ${hint ?? "keys: agent, team, level, type, name, in, state, is, text, tool and more (skill instructions-tools)"}`
}

const structuralKeys = new Set([
  "type",
  "name",
  "in",
  "kind",
  "item",
  "tool",
  "group",
  "server",
  "namespace",
  "pinned",
  "execute",
  "level",
  "catalogue",
  "run",
  "agent",
  "state",
  "modified",
  "review",
  "source",
  "overridden",
  "active",
  "inactive",
  "unsupported",
  "codemode",
  "can",
  "has",
  "id",
  "label",
  "updated",
  "team",
  "folder",
  "acked",
  "excluded",
  "dead",
  "shadowed",
  "orphan",
  "overriders",
])

function contains(haystack: string, needle: string): boolean {
  return haystack.toLowerCase().includes(needle.toLowerCase())
}

function lower(value: string): string {
  return value.toLowerCase()
}

function unescape(value: string): string {
  return value.replace(/\\(.)/g, "$1")
}

function splitTerms(where: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: string | undefined
  for (let index = 0; index < where.length; index++) {
    const ch = where[index] ?? ""
    if (quote !== undefined) {
      if (ch === "\\" && index + 1 < where.length) {
        current += ch + (where[index + 1] ?? "")
        index += 1
        continue
      }
      current += ch
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === "\\" && index + 1 < where.length) {
      current += ch + (where[index + 1] ?? "")
      index += 1
      continue
    }
    if (ch === " " || ch === "\t" || ch === "\n") {
      if (current !== "") out.push(current)
      current = ""
      continue
    }
    current += ch
  }
  if (current !== "") out.push(current)
  return out
}

function indexOfColon(body: string): number {
  let quote: string | undefined
  for (let index = 0; index < body.length; index++) {
    const ch = body[index] ?? ""
    if (quote !== undefined) {
      if (ch === "\\") {
        index += 1
        continue
      }
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      continue
    }
    if (ch === "\\") {
      index += 1
      continue
    }
    if (ch === ":") return index
  }
  return -1
}

function splitValue(raw: string, term: string): string[] {
  const out: string[] = []
  let current = ""
  let quote: string | undefined
  for (let index = 0; index < raw.length; index++) {
    const ch = raw[index] ?? ""
    if (quote !== undefined) {
      if (ch === "\\" && index + 1 < raw.length) {
        current += ch + (raw[index + 1] ?? "")
        index += 1
        continue
      }
      current += ch
      if (ch === quote) quote = undefined
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
      continue
    }
    if (ch === "\\" && index + 1 < raw.length) {
      current += ch + (raw[index + 1] ?? "")
      index += 1
      continue
    }
    if (ch === ",") {
      out.push(stripQuotes(current, term))
      current = ""
      continue
    }
    current += ch
  }
  out.push(stripQuotes(current, term))
  return out
}

function stripQuotes(raw: string, term: string): string {
  if (raw.length >= 2) {
    const first = raw[0] ?? ""
    if ((first === '"' || first === "'") && raw.endsWith(first)) return unescape(raw.slice(1, -1))
  }
  const value = unescape(raw)
  if (value === "") throw new Error(`empty filter value in "${term}"`)
  return value
}

function oneOf(key: string, alts: readonly string[], allowed: readonly string[], term: string): readonly string[] {
  for (const alt of alts) {
    if (!allowed.includes(lower(alt))) throw new Error(`bad ${key} value in "${term}": expected one of ${allowed.join("|")}`)
  }
  return alts
}

function booleanOf(alts: readonly string[], term: string): readonly boolean[] {
  return alts.map((alt) => {
    if (lower(alt) === "true") return true
    if (lower(alt) === "false") return false
    throw new Error(`bad boolean value in "${term}": expected true|false`)
  })
}

interface Comparison {
  readonly op: "eq" | "gt" | "lt" | "gte" | "lte"
  readonly rest: string
}

function comparisonOf(value: string): Comparison {
  if (value.startsWith(">=")) return { op: "gte", rest: value.slice(2) }
  if (value.startsWith("<=")) return { op: "lte", rest: value.slice(2) }
  if (value.startsWith(">")) return { op: "gt", rest: value.slice(1) }
  if (value.startsWith("<")) return { op: "lt", rest: value.slice(1) }
  if (value.startsWith("=")) return { op: "eq", rest: value.slice(1) }
  return { op: "eq", rest: value }
}

function numberOf(rest: string, term: string): number {
  if (!/^\d+$/.test(rest)) throw new Error(`bad numeric comparison in "${term}": expected an integer`)
  return Number(rest)
}

const durations: Record<string, number> = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }

function updatedMatches(updated: string | undefined, alt: string, term: string): boolean {
  if (updated === undefined) return false
  const time = Date.parse(updated)
  if (Number.isNaN(time)) return false
  const { op, rest } = comparisonOf(alt)
  const duration = /^(\d+)([smhdw])$/i.exec(rest)
  if (duration !== null) {
    const cutoff = Date.now() - Number(duration[1] ?? 0) * (durations[lower(duration[2] ?? "")] ?? 0)
    if (op === "gt") return time < cutoff
    if (op === "lt") return time > cutoff
    if (op === "gte") return time <= cutoff
    if (op === "lte") return time >= cutoff
    return time === cutoff
  }
  const date = Date.parse(rest)
  if (Number.isNaN(date)) throw new Error(`bad time comparison in "${term}": expected like 7d or 2026-09-01`)
  if (op === "gt") return time > date
  if (op === "lt") return time < date
  if (op === "gte") return time >= date
  if (op === "lte") return time <= date
  return time === date
}

function numberMatches(value: number, alt: string, term: string): boolean {
  const { op, rest } = comparisonOf(alt)
  const expected = numberOf(rest, term)
  if (op === "gt") return value > expected
  if (op === "lt") return value < expected
  if (op === "gte") return value >= expected
  if (op === "lte") return value <= expected
  return value === expected
}

function testFor(key: string, alts: readonly string[], term: string, state: QueryState): (candidate: Candidate) => boolean {
  switch (key) {
    case "type": {
      const allowed = oneOf(key, alts.map((alt) => (lower(alt) === "perm" ? "rule" : alt)), rowTypes, term)
      return (candidate) => allowed.some((alt) => typeOf(state, candidate) === lower(alt))
    }
    // The older structural keys keep their values; a type value works there too.
    case "kind": {
      const kinds = ["root", "group", "agent", "team", "item", "section"]
      const allowed = oneOf(key, alts, [...new Set([...kinds, ...rowTypes])], term)
      return (candidate) => allowed.some((alt) => (kinds.includes(lower(alt)) ? candidate.kind === lower(alt) : typeOf(state, candidate) === lower(alt)))
    }
    case "item": {
      const kinds = ["tool", "base", "skill", "system", "mcp", "model", "modeldefault", "modelsetting", "perm", "param", "setting", "compaction"]
      const named = alts.find((alt) => alt.includes(":"))
      if (named !== undefined) {
        const [type, ...name] = named.split(":")
        throw new Error(`bad item value in "${term}": item takes a type; for one row use type:${type === "perm" ? "rule" : type} name:${name.at(-1)}`)
      }
      const allowed = oneOf(key, alts, kinds, term)
      return (candidate) => allowed.some((alt) => itemKindOf(state, candidate) === lower(alt))
    }
    case "name": {
      return (candidate) => alts.some((alt) => namesOf(candidate).some((name) => matches(name, alt)))
    }
    case "in": {
      return (candidate) => alts.some((alt) => candidate.ancestors?.some((ancestor) => lower(ancestor.id) === lower(alt)) === true)
    }
    case "is": {
      const allowed = oneOf(key, alts, namedFinds, term)
      return (candidate) => allowed.some((alt) => isOf(state, candidate, lower(alt)))
    }
    // A tool's own rows: the tool row, its parameters, its rules and how it is offered.
    case "tool": {
      return (candidate) => {
        const address = candidate.address
        if (address === undefined) return false
        const tool = toolOfItem(address.item)
        return tool !== undefined && alts.some((alt) => matches(tool, alt))
      }
    }
    case "group": {
      const allowed = oneOf(key, alts, ["native", "plus", "mcp", "project", "none"], term)
      return (candidate) => {
        const address = candidate.address
        if (address === undefined) return false
        return allowed.some((alt) => lookupItem(state, address.item, address.agent)?.group === lower(alt))
      }
    }
    case "server": {
      return (candidate) => {
        const address = candidate.address
        if (address === undefined) return false
        const server = lookupItem(state, address.item, address.agent)?.server
        if (server !== undefined && alts.some((alt) => lower(server) === lower(alt))) return true
        if (address.item.startsWith("mcp:")) {
          const serverName = address.item.slice("mcp:".length)
          return alts.some((alt) => lower(serverName) === lower(alt))
        }
        return false
      }
    }
    case "level": {
      const allowed = oneOf(key, alts, ["project", "global", "defaults", "preset"], term)
      return (candidate) => allowed.some((alt) => levelOf(candidate) === lower(alt))
    }
    // Run-scoped rows only: the live run whose edit scope the row expresses.
    // `run:<id>` is how a parent finds the rules a child is working under.
    case "run": {
      return (candidate) => {
        const address = candidate.address
        if (address === undefined) return false
        const runID = lookupItem(state, address.item, address.agent)?.runID
        if (runID === undefined) return false
        return alts.some((alt) => lower(runID) === lower(alt))
      }
    }
    case "catalogue": {
      const allowed = oneOf(key, alts, ["agents", "teams"], term)
      return (candidate) => {
        const catalogue = catalogueOfCandidate(candidate)
        if (catalogue === undefined) return false
        return allowed.some((alt) => catalogue === lower(alt))
      }
    }
    // The agent's name exactly, ignoring case; * or % stand for any text. `_` is the shared row.
    case "agent": {
      return (candidate) => {
        const agent = agentOf(candidate) ?? ownerAgentOf(state, candidate)
        return alts.some((alt) => {
          if (alt === "_") return agent === null
          if (agent === null) return false
          return matches(agent, alt)
        })
      }
    }
    case "state": {
      const allowed = oneOf(key, alts, ["on", "off"], term)
      return (candidate) => {
        const badges = nodeOf(state, candidate)?.badges
        if (badges?.state === undefined) return false
        return allowed.some((alt) => badges.state === lower(alt))
      }
    }
    case "modified": {
      const allowed = booleanOf(alts, term)
      return (candidate) => allowed.some((alt) => (nodeOf(state, candidate)?.badges.modified === true) === alt)
    }
    case "review": {
      const allowed = booleanOf(alts, term)
      return (candidate) => allowed.some((alt) => (nodeOf(state, candidate)?.badges.review === true) === alt)
    }
    case "source": {
      // `preset`: a preset in the chain supplied the row (DESIGN §3.2).
      const allowed = oneOf(key, alts, ["project", "global", "defaults", "preset", "upstream"], term)
      return (candidate) => {
        const source = nodeOf(state, candidate)?.badges.source
        if (source === undefined) return false
        return allowed.some((alt) => source === lower(alt))
      }
    }
    case "overridden": {
      const allowed = booleanOf(alts, term)
      return (candidate) => {
        const address = candidate.address
        const overridden = address !== undefined && ownOf(state, address)?.text !== undefined
        return allowed.some((alt) => overridden === alt)
      }
    }
    case "active":
    case "inactive":
    case "unsupported":
    case "pinned": {
      const allowed = booleanOf(alts, term)
      return (candidate) => allowed.some((alt) => (nodeOf(state, candidate)?.badges[key] === true) === alt)
    }
    case "codemode": {
      const allowed = booleanOf(alts, term)
      return (candidate) => {
        const address = candidate.address
        const value = address !== undefined && lookupItem(state, address.item, address.agent, address)?.codemode === true
        return allowed.some((alt) => value === alt)
      }
    }
    case "namespace": {
      return (candidate) => {
        const address = candidate.address
        if (address === undefined) return false
        const namespace = lookupItem(state, address.item, address.agent)?.namespace
        if (namespace === undefined) return false
        return alts.some((alt) => lower(namespace) === lower(alt))
      }
    }
    case "execute": {
      const allowed = booleanOf(alts, term)
      return (candidate) => {
        const address = candidate.address
        const value = address !== undefined && lookupItem(state, address.item, address.agent)?.execute === true
        return allowed.some((alt) => value === alt)
      }
    }
    case "can": {
      const allowed = oneOf(key, alts, ["toggle", "edit", "reset", "remove", "split", "pin"], term)
      return (candidate) => {
        const actions = actionsOf(state, candidate)
        return allowed.some((alt) => actions[lower(alt) as keyof TreeNodeActions] === true)
      }
    }
    case "has": {
      const allowed = oneOf(key, alts, ["record", "split", "sections", "text"], term)
      return (candidate) => allowed.some((alt) => hasOf(state, candidate, lower(alt)))
    }
    case "id": {
      return (candidate) => alts.some((alt) => candidate.id.toLowerCase().startsWith(lower(alt)))
    }
    case "label": {
      return (candidate) => alts.some((alt) => contains(candidate.label, alt))
    }
    case "updated": {
      return (candidate) => alts.some((alt) => updatedMatches(updatedOf(state, candidate), alt, term))
    }
    case "team": {
      return (candidate) => {
        const names = teamNamesOf(state, candidate).map(lower)
        return alts.some((alt) => names.includes(lower(alt)))
      }
    }
    case "folder": {
      return (candidate) => {
        const address = candidate.address
        if (address === undefined || address.section !== null) return false
        const tab = tabOfItem(address.item)
        // System (Base included) lists the request's parts in order and has no folders.
        if (tab === "system" || tab === "base") return false
        const owner = `group:${candidate.id.slice(candidate.id.indexOf(":") + 1, candidate.id.indexOf(`:${address.item}`))}:${tab}`
        // The folders the tab shows: its own or the ones it inherits.
        const source = tabLayout(state.memo, owner).source
        const name = state.memo.ctx.folders.find((folder) => folder.owner === source && folder.items.includes(address.item))?.name
        return name !== undefined && alts.some((alt) => lower(name) === lower(alt))
      }
    }
    case "acked": {
      const allowed = booleanOf(alts, term)
      return (candidate) => {
        const address = candidate.address
        const acked = address !== undefined && ownOf(state, address)?.acknowledged !== undefined
        return allowed.some((alt) => acked === alt)
      }
    }
    case "excluded": {
      const allowed = booleanOf(alts, term)
      return (candidate) => {
        const excluded = candidate.address !== undefined && nodeOf(state, candidate)?.badges.state === "off"
        return allowed.some((alt) => excluded === alt)
      }
    }
    case "identical": {
      const allowed = booleanOf(alts, term)
      return (candidate) => allowed.some((alt) => identicalOf(state, candidate) === alt)
    }
    case "dead": {
      const allowed = booleanOf(alts, term)
      return (candidate) => allowed.some((alt) => deadOf(state, candidate) === alt)
    }
    case "shadowed": {
      const allowed = booleanOf(alts, term)
      return (candidate) => allowed.some((alt) => shadowedOf(state, candidate) === alt)
    }
    case "orphan": {
      const allowed = booleanOf(alts, term)
      return (candidate) => allowed.some((alt) => candidate.orphan === alt)
    }
    case "tokens": {
      return (candidate) => alts.some((alt) => numberMatches(tokensOf(state, candidate), alt, term))
    }
    case "delta": {
      return (candidate) => alts.some((alt) => numberMatches(deltaOf(state, candidate), alt, term))
    }
    case "overriders": {
      return (candidate) => alts.some((alt) => numberMatches(overridersOf(state, candidate), alt, term))
    }
    case "text": {
      return (candidate) => {
        if (candidate.address === undefined) return false
        return alts.some((alt) => contains(resolvedTextOf(state, candidate), alt))
      }
    }
    case "upstream": {
      return (candidate) => {
        if (candidate.address === undefined) return false
        return alts.some((alt) => contains(upstreamTextOf(state, candidate), alt))
      }
    }
    default:
      throw new Error(`unknown filter key in "${term}"`)
  }
}

function hasOf(state: QueryState, candidate: Candidate, alt: string): boolean {
  const address = candidate.address
  if (address === undefined) return false
  if (alt === "record") return ownOf(state, address) !== undefined
  if (alt === "split") return splitOfAddress(state, address) !== undefined
  if (alt === "sections") return candidate.sectionIds.length > 0
  const item = lookupItem(state, address.item, address.agent, address)
  return (ownOf(state, address)?.text ?? item?.text ?? "") !== ""
}

function parseSortKey(raw: string, term: string): SortSpec {
  const descending = raw.startsWith("-")
  const key = lower(descending ? raw.slice(1) : raw)
  if (key !== "tokens" && key !== "delta" && key !== "updated" && key !== "label" && key !== "id")
    throw new Error(`bad sort key in "${term}": expected one of tokens|delta|updated|label|id`)
  return { key, descending }
}

function parseSort(sort: Sort | undefined): SortSpec | undefined {
  if (sort === undefined) return undefined
  return parseSortKey(sort, `sort:${sort}`)
}

function sortCandidates(state: QueryState, candidates: Candidate[], sort: SortSpec | undefined): Candidate[] {
  if (sort === undefined) return candidates
  const valueOf = (candidate: Candidate): number | string => {
    if (sort.key === "tokens") return tokensOf(state, candidate)
    if (sort.key === "delta") return deltaOf(state, candidate)
    if (sort.key === "updated") return updatedOf(state, candidate) ?? ""
    if (sort.key === "label") return lower(candidate.label)
    return candidate.id
  }
  return [...candidates]
    .map((candidate) => ({ candidate, value: valueOf(candidate) }))
    .sort((left, right) => {
      if (left.value < right.value) return sort.descending ? 1 : -1
      if (left.value > right.value) return sort.descending ? -1 : 1
      return left.candidate.index - right.candidate.index
    })
    .map((entry) => entry.candidate)
}

function project(state: QueryState, candidate: Candidate, fields: readonly Field[]): QueryRow {
  const row: Record<string, unknown> = { id: candidate.id }
  for (const field of fields) {
    if (field === "id") continue
    if (field === "badges") {
      const node = nodeOf(state, candidate)
      if (node !== undefined) row.badges = badgeLabels(node).join(" ")
      continue
    }
    if (field === "source") {
      const source = nodeOf(state, candidate)?.badges.source
      if (source !== undefined) row.source = source
      continue
    }
    if (field === "from") {
      const from = nodeOf(state, candidate)?.badges.fromLabel
      if (from !== undefined) row.from = from
      continue
    }
    if (field === "tokens") {
      row.tokens = tokensOf(state, candidate)
      continue
    }
    if (field === "text") {
      if (candidate.address !== undefined) row.text = resolvedTextOf(state, candidate)
      continue
    }
    if (field === "upstream") {
      if (candidate.address !== undefined) row.upstream = upstreamTextOf(state, candidate)
      continue
    }
    if (field === "record") {
      if (candidate.address !== undefined) {
        const own = modelDefaultRecordOf(state, candidate.address) ?? ownOf(state, candidate.address)
        if (own !== undefined) row.record = own
      }
      continue
    }
    if (field === "label") {
      row.label = candidate.label
      continue
    }
    if (field === "path") {
      if (candidate.kind === "agent") {
        const path = state.agents.get(agentOf(candidate) ?? "")?.path
        if (path !== undefined) row.path = path
      }
      continue
    }
    if (field === "updated") {
      const updated = updatedOf(state, candidate)
      if (updated !== undefined) row.updated = updated
      continue
    }
    if (field === "sections") {
      // Section result rows may be skipped by structural filtering, but a
      // requested projection must still report them: resolve on demand for
      // the returned rows instead of trusting the enumeration cache.
      if (candidate.kind === "item" && candidate.address !== undefined && !candidate.orphan) {
        const lazy = candidate.lazy
        row.sections = lazy === undefined ? candidate.sectionIds : sectionsFor(lazy).map((section) => section.id)
      }
    }
  }
  return row as unknown as QueryRow
}
