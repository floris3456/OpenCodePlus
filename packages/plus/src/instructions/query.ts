import { applies, canReset, catalogueForAddress, catalogueOf, upstreamForEdit } from "./model.js"
import type {
  Address,
  AgentSource,
  Catalogue,
  CustomizationRecord,
  Item,
  Level,
  SplitRecord,
} from "./model.js"
import { buildMemo, sectionResolveOf, splitOf, wholeOf, type Memo, type MemoInput } from "./resolve-memo.js"
import { materialize, skeletonOf, teamsOwnerSegment, toolPermRows, type Lazy, type TreeNode, type TreeNodeActions, type TreeNodeKind } from "./tree.js"
import { changedLines } from "./diff-lines.js"

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
}

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
}

export function query(input: MemoInput, options?: QueryOptions, memo?: Memo): { rows: QueryRow[]; total: number } {
  const active = memo ?? buildMemo(input)
  const state = queryState(active)
  const parsed = parseWhere(options?.where ?? "", state)
  const candidates = collectCandidates(state, parsed)
  const matched = candidates.filter((candidate) => parsed.filters.every((filter) => filter.negate !== filter.test(candidate)))
  const sorted = sortCandidates(state, matched, parseSort(options?.sort) ?? parsed.sort)
  const total = sorted.length
  const offset = options?.offset ?? 0
  const limit = options?.limit ?? sorted.length
  if (!Number.isInteger(offset) || offset < 0) throw new Error(`bad query offset "${offset}"`)
  if (!Number.isInteger(limit) || limit < 0) throw new Error(`bad query limit "${limit}"`)
  const fields = options?.fields ?? (["id", "badges", "source", "tokens"] as const satisfies readonly Field[])
  return { rows: sorted.slice(offset, offset + limit).map((candidate) => project(state, candidate, fields)), total }
}

interface QueryState {
  readonly memo: Memo
  readonly recs: Map<string, CustomizationRecord[]>
  readonly splits: Map<string, SplitRecord[]>
  readonly agents: Map<string, AgentSource>
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
  node: TreeNode | undefined
  resolvedText: string | undefined
  upstreamText: string | undefined
}

interface Filter {
  readonly negate: boolean
  readonly rank: number
  readonly excludesSections: boolean
  readonly mentionsSections: boolean
  readonly propagating: boolean
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
  return { memo, recs, splits, agents: new Map(memo.ctx.agents.map((agent) => [agent.id, agent])) }
}

function recsAt(state: QueryState, item: string, section: string | null): readonly CustomizationRecord[] {
  return state.recs.get(JSON.stringify([item, section])) ?? []
}

function atNode(
  records: readonly CustomizationRecord[],
  level: Level,
  agent: string | null,
  catalogue: Catalogue,
): CustomizationRecord | undefined {
  return records.find(
    (record) =>
      record.level === level &&
      record.agent === agent &&
      (agent !== null || catalogueOf(record.catalogue) === catalogue),
  )
}

function ownOf(state: QueryState, address: Address): CustomizationRecord | undefined {
  return atNode(recsAt(state, address.item, address.section), address.level, address.agent, catalogueForAddress(address))
}

function splitOfAddress(state: QueryState, address: Address): SplitRecord | undefined {
  return state.splits.get(JSON.stringify([address.level, address.agent, address.item, catalogueForAddress(address)]))?.[0]
}

function lookupItem(state: QueryState, itemId: string, owner: string | null): Item | undefined {
  const matches = state.memo.ctx.items.filter((entry) => entry.id === itemId)
  if (owner === null) return matches[0]
  return matches.find((entry) => applies(entry, owner)) ?? matches[0]
}

// Candidates walk the lazy skeleton: branch children are cheap, item rows
// enumerate their sections through the shared memo split, so listing rows
// costs the same per-row resolve the TUI already pays when it builds the
// tree. Section expansion is skipped when a positive structural term can
// never match a section, or when the item itself fails a term its sections
// necessarily fail (level, agent, and the upstream item attributes).
function collectCandidates(state: QueryState, parsed: Parsed): Candidate[] {
  const out: Candidate[] = []
  const seen = new Set<string>()
  const push = (candidate: Omit<Candidate, "index" | "node" | "resolvedText" | "upstreamText">) => {
    if (seen.has(candidate.id)) return
    seen.add(candidate.id)
    out.push({ ...candidate, index: out.length, node: undefined, resolvedText: undefined, upstreamText: undefined })
  }
  const skipRows = parsed.filters.some((filter) => filter.excludesSections)
  const needIds = !skipRows || parsed.filters.some((filter) => filter.mentionsSections)
  const visit = (lazy: Lazy) => {
    if (lazy.kind === "item" && lazy.address !== undefined) {
      const enumerated = (!needIds || failsPropagating(parsed, lazy) ? [] : sectionsFor(lazy))
      push({ id: lazy.id, kind: lazy.kind, label: lazy.label, depth: lazy.depth, orphan: false, lazy, parent: undefined, address: lazy.address, sectionIds: enumerated.map((section) => section.id) })
      if (!skipRows) {
        for (const section of enumerated)
          push({ id: section.id, kind: "section", label: section.label, depth: section.depth, orphan: false, lazy: undefined, parent: lazy, address: section.address, sectionIds: [] })
      }
      // Item rows may own non-section children (permission rows hanging
      // directly off tool rows after their sections). Sections are already
      // pushed above; enumerate perm rows directly (they filter items with no
      // resolve) instead of lazy.children(), which would also derive sections
      // via splitOf and resolve every address even for structural misses.
      const address = lazy.address
      const item = address === undefined ? undefined : lookupItem(state, address.item, address.agent)
      // Perm rows hang off the tool row and share its owner path, which the
      // row id already carries between `item:<level>:` and `:<itemId>`.
      const permRows =
        item === undefined || address === undefined
          ? []
          : toolPermRows(
              state.memo.ctx,
              state.memo,
              address.level,
              address.agent,
              item,
              lazy.depth + 1,
              address.team,
              address.catalogue,
              lazy.id.slice(`item:${address.level}:`.length, lazy.id.length - address.item.length - 1),
            )
      for (const perm of permRows)
        push({ id: perm.id, kind: perm.kind, label: perm.label, depth: perm.depth, orphan: false, lazy: perm, parent: undefined, address: perm.address, sectionIds: [] })
      return
    }
    push({ id: lazy.id, kind: lazy.kind, label: lazy.label, depth: lazy.depth, orphan: false, lazy, parent: undefined, address: lazy.address, sectionIds: [] })
    for (const child of lazy.children()) visit(child)
  }
  for (const root of skeletonOf(state.memo)) visit(root)
  if (parsed.wantsOrphans) pushOrphans(state, push, skipRows)
  return out
}

const propagatingKeys = new Set(["level", "catalogue", "agent", "item", "group", "server", "codemode", "namespace", "execute", "tool"])
// pinned is resolved state like state:/modified: (per-row resolve through the
// shared memo), so it must not propagate: a section inherits its whole row's
// pin for display, but enumeration cannot skip sections from the item test.

function failsPropagating(parsed: Parsed, lazy: Lazy): boolean {
  const probe: Candidate = { id: lazy.id, kind: lazy.kind, label: lazy.label, depth: lazy.depth, index: -1, orphan: false, lazy, parent: undefined, address: lazy.address, sectionIds: [], node: undefined, resolvedText: undefined, upstreamText: undefined }
  return parsed.filters.some((filter) => filter.propagating && !filter.test(probe))
}

interface SectionRow {
  readonly id: string
  readonly label: string
  readonly depth: number
  readonly address: Address
}

function sectionsFor(lazy: Lazy): SectionRow[] {
  // Single source of truth for "this row has no sections": read the tree's
  // lazy children, which already return [] for the host-owned execute row.
  const rows: SectionRow[] = []
  for (const child of lazy.children()) {
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
  if (item === undefined) return true
  if (agent !== null && !state.agents.has(agent)) return true
  if (section === null) return false
  return !splitOf(state.memo, level, agent, item, catalogue).sections.some((entry) => entry.id === section)
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
  const item = address === undefined ? undefined : lookupItem(state, address.item, address.agent)
  const text =
    address === undefined || item === undefined
      ? ""
      : address.section === null
        ? wholeOf(state.memo, address.level, address.agent, item, address.catalogue).text
        : sectionResolveOf(state.memo, address.level, address.agent, item, address.section, address.catalogue).text
  candidate.resolvedText = text
  return text
}

function upstreamTextOf(state: QueryState, candidate: Candidate): string {
  if (candidate.upstreamText !== undefined) return candidate.upstreamText
  const address = candidate.address
  const item = address === undefined ? undefined : lookupItem(state, address.item, address.agent)
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
  const item = lookupItem(state, address.item, address.agent)
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
  return segment === "project" || segment === "global" || segment === "defaults" ? segment : undefined
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
    if (parts[2] === "teams" || parts[2] === teamsOwnerSegment) return "teams"
    return "agents"
  }
  return undefined
}

function itemKindOf(state: QueryState, candidate: Candidate): string | undefined {
  const address = candidate.address
  if (address === undefined) return undefined
  const item = lookupItem(state, address.item, address.agent)
  if (item !== undefined) return item.kind
  if (!candidate.orphan) return undefined
  const prefix = address.item.split(":")[0]
  return prefix === undefined || prefix === "" ? undefined : prefix
}

function teamNamesOf(state: QueryState, candidate: Candidate): string[] {
  if (candidate.address?.team !== undefined) {
    return [candidate.address.team.team]
  }
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
function shadowedOf(state: QueryState, candidate: Candidate): boolean {
  const address = candidate.address
  if (address === undefined) return false
  const own = ownOf(state, address)
  if (own?.text === undefined) return false
  const rank = specificity(address.level, address.agent)
  return recsAt(state, address.item, address.section).some(
    (record) => record.text !== undefined && sameScope(record, address) && specificity(record.level, record.agent) > rank,
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
  const item = lookupItem(state, address.item, address.agent)
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
  const item = lookupItem(state, candidate.address.item, candidate.address.agent)
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
  for (const raw of splitTerms(where)) {
    const parsed = parseTerm(raw, state)
    if (parsed === undefined) continue
    if ("sort" in parsed) {
      sort = parsed.sort
      continue
    }
    filters.push(parsed)
    if (parsed.wantsOrphans) wantsOrphans = true
  }
  return { filters: filters.sort((left, right) => left.rank - right.rank), sort, wantsOrphans }
}

type TermOut = (Filter & { wantsOrphans: boolean }) | { sort: SortSpec }

function parseTerm(raw: string, state: QueryState): TermOut | undefined {
  if (raw === "") return undefined
  let negate = false
  let body = raw
  if (body.startsWith("!")) {
    negate = true
    body = body.slice(1)
  }
  const colon = indexOfColon(body)
  if (colon === -1) {
    const word = unescape(body)
    if (word === "") throw new Error(`empty filter term in "${raw}"`)
    return { negate, rank: 0, excludesSections: false, mentionsSections: false, propagating: false, test: (candidate) => contains(candidate.label, word) || contains(candidate.id, word), wantsOrphans: false }
  }
  const key = body.slice(0, colon).toLowerCase()
  const alts = splitValue(body.slice(colon + 1), raw)
  if (key === "sort") {
    if (negate) throw new Error(`cannot negate the sort directive in "${raw}"`)
    if (alts.length !== 1) throw new Error(`bad sort directive in "${raw}"`)
    return { sort: parseSortKey(alts[0] ?? "", raw) }
  }
  return { negate, rank: rankFor(key, raw), excludesSections: excludesSections(key, alts, negate), mentionsSections: key === "has" && alts.some((alt) => lower(alt) === "sections"), propagating: !negate && propagatingKeys.has(key), test: testFor(key, alts, raw, state), wantsOrphans: key === "orphan" && wantsTrue(alts, negate) }
}

function excludesSections(key: string, alts: readonly string[], negate: boolean): boolean {
  if (negate) return false
  if (key === "team") return true
  if (key === "has" && alts.length === 1 && lower(alts[0] ?? "") === "sections") return true
  if (key === "can" && alts.every((alt) => lower(alt) === "split" || lower(alt) === "remove")) return true
  if (key === "kind" && !alts.some((alt) => lower(alt) === "section")) return true
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
    key === "pinned"
  )
    return 1
  const textKeys = ["identical", "tokens", "delta", "text", "upstream"]
  const index = textKeys.indexOf(key)
  if (index !== -1) return 2 + index
  if (!structuralKeys.has(key)) throw new Error(`unknown filter key in "${term}"`)
  return 0
}

const structuralKeys = new Set([
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
    case "kind": {
      const allowed = oneOf(key, alts, ["root", "group", "agent", "team", "item", "section"], term)
      return (candidate) => allowed.some((alt) => candidate.kind === lower(alt))
    }
    case "item": {
      const allowed = oneOf(key, alts, ["tool", "base", "skill", "system", "mcp", "model", "perm"], term)
      return (candidate) => allowed.some((alt) => itemKindOf(state, candidate) === lower(alt))
    }
    case "tool": {
      return (candidate) => {
        const address = candidate.address
        if (address === undefined) return false
        const item = lookupItem(state, address.item, address.agent)
        if (item === undefined) return false
        if (item.kind !== "perm" || item.permTool === undefined) return false
        return alts.some((alt) => lower(item.permTool as string) === lower(alt))
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
        if (server === undefined) return false
        return alts.some((alt) => lower(server) === lower(alt))
      }
    }
    case "level": {
      const allowed = oneOf(key, alts, ["project", "global", "defaults"], term)
      return (candidate) => allowed.some((alt) => levelOf(candidate) === lower(alt))
    }
    case "catalogue": {
      const allowed = oneOf(key, alts, ["agents", "teams"], term)
      return (candidate) => {
        const catalogue = catalogueOfCandidate(candidate)
        if (catalogue === undefined) return false
        return allowed.some((alt) => catalogue === lower(alt))
      }
    }
    case "agent": {
      return (candidate) => {
        const agent = agentOf(candidate)
        return alts.some((alt) => {
          if (alt === "_") return agent === null
          if (agent === null) return false
          return lower(agent).includes(lower(alt))
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
      const allowed = oneOf(key, alts, ["project", "global", "defaults", "upstream"], term)
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
        const value = address !== undefined && lookupItem(state, address.item, address.agent)?.codemode === true
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
  const item = lookupItem(state, address.item, address.agent)
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

function badgesString(node: TreeNode): string {
  const labels: string[] = []
  if (node.badges.state !== undefined) labels.push(node.badges.state === "off" ? "off" : "on")
  if (node.badges.modified === true) labels.push("modified")
  if (node.badges.active === true) labels.push("active")
  if (node.badges.inactive === true) labels.push("inactive")
  if (node.badges.pinned === true) labels.push("pinned")
  if (node.badges.unsupported === true) labels.push("unsupported")
  const count = node.badges.reviewCount ?? 0
  if (count > 0) labels.push(`${count} to review`)
  else if (node.badges.review === true) labels.push("review")
  return labels.join(" ")
}

function project(state: QueryState, candidate: Candidate, fields: readonly Field[]): QueryRow {
  const row: Record<string, unknown> = { id: candidate.id }
  for (const field of fields) {
    if (field === "id") continue
    if (field === "badges") {
      const node = nodeOf(state, candidate)
      if (node !== undefined) row.badges = badgesString(node)
      continue
    }
    if (field === "source") {
      const source = nodeOf(state, candidate)?.badges.source
      if (source !== undefined) row.source = source
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
        const own = ownOf(state, candidate.address)
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
