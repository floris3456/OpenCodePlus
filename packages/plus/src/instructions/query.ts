import { applies, canReset, fingerprint, resolutionChain, resolveSplit } from "./model.js"
import type {
  Address,
  AgentSource,
  CustomizationRecord,
  Item,
  Level,
  SplitRecord,
} from "./model.js"
import { buildMemo, sectionResolveOf, wholeOf, type Memo, type MemoInput } from "./resolve-memo.js"
import { skeletonOf, type Lazy, type TreeNodeActions, type TreeNodeKind } from "./tree.js"
import { builtinBaseIds } from "../agents/base.js"
import { slice } from "./sections.js"
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
  const scope: Scope = { all: [] }
  const parsed = parseWhere(options?.where ?? "", state, scope)
  const candidates = collectCandidates(state, parsed.wantsOrphans)
  scope.all = candidates
  const matched = candidates.filter((candidate) => parsed.filters.every((filter) => filter.negate !== filter.test(candidate)))
  const sorted = sortCandidates(state, matched, parseSort(options?.sort) ?? parsed.sort)
  const total = sorted.length
  const offset = options?.offset ?? 0
  const limit = options?.limit ?? sorted.length
  if (!Number.isInteger(offset) || offset < 0) throw new Error(`bad query offset "${offset}"`)
  if (!Number.isInteger(limit) || limit < 0) throw new Error(`bad query limit "${limit}"`)
  const fields = options?.fields ?? (["id", "badges", "source", "tokens"] as const satisfies readonly Field[])
  return { rows: sorted.slice(offset, offset + limit).map((candidate) => project(state, scope, candidate, fields)), total }
}

interface QueryState {
  readonly memo: Memo
  readonly recs: Map<string, CustomizationRecord[]>
  readonly splits: Map<string, SplitRecord[]>
  readonly agents: Map<string, AgentSource>
}

interface Scope {
  all: Candidate[]
}

interface Candidate {
  readonly id: string
  readonly kind: TreeNodeKind
  readonly label: string
  readonly depth: number
  readonly index: number
  readonly orphan: boolean
  readonly lazy: Lazy | undefined
  readonly address: Address | undefined
  readonly sectionCount: number
  resolvedText: string | undefined
  upstreamText: string | undefined
}

interface Filter {
  readonly negate: boolean
  readonly rank: number
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
    const key = JSON.stringify([split.level, split.agent, split.item])
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
): CustomizationRecord | undefined {
  return records.find((record) => record.level === level && record.agent === agent)
}

function ownOf(state: QueryState, address: Address): CustomizationRecord | undefined {
  return atNode(recsAt(state, address.item, address.section), address.level, address.agent)
}

function splitOfAddress(state: QueryState, level: Level, agent: string | null, item: string): SplitRecord | undefined {
  return state.splits.get(JSON.stringify([level, agent, item]))?.[0]
}

function lookupItem(state: QueryState, itemId: string, owner: string | null): Item | undefined {
  const matches = state.memo.ctx.items.filter((entry) => entry.id === itemId)
  if (owner === null) return matches[0]
  return matches.find((entry) => applies(entry, owner)) ?? matches[0]
}

// Candidates walk the lazy skeleton without resolving: branch children are
// cheap, item rows enumerate sections through a memo-free split of the
// walked whole text, so merely listing rows never touches whole/section.
function collectCandidates(state: QueryState, wantsOrphans: boolean): Candidate[] {
  const out: Candidate[] = []
  const push = (candidate: Omit<Candidate, "index" | "resolvedText" | "upstreamText">) => {
    out.push({ ...candidate, index: out.length, resolvedText: undefined, upstreamText: undefined })
  }
  const visit = (lazy: Lazy) => {
    if (lazy.kind === "item" && lazy.address !== undefined) {
      const sections = sectionsFor(state, lazy)
      push({ id: lazy.id, kind: lazy.kind, label: lazy.label, depth: lazy.depth, orphan: false, lazy, address: lazy.address, sectionCount: sections.length })
      for (const section of sections)
        push({ id: section.id, kind: "section", label: section.label, depth: section.depth, orphan: false, lazy: undefined, address: section.address, sectionCount: 0 })
      return
    }
    push({ id: lazy.id, kind: lazy.kind, label: lazy.label, depth: lazy.depth, orphan: false, lazy, address: lazy.address, sectionCount: 0 })
    for (const child of lazy.children()) visit(child)
  }
  for (const root of skeletonOf(state.memo)) visit(root)
  if (wantsOrphans) pushOrphans(state, push)
  return out
}

interface SectionRow {
  readonly id: string
  readonly label: string
  readonly depth: number
  readonly address: Address
}

function sectionsFor(state: QueryState, lazy: Lazy): SectionRow[] {
  const address = lazy.address
  if (address === undefined) return []
  const item = lookupItem(state, address.item, address.agent)
  if (item === undefined) return []
  const split = resolveSplit({
    text: effectiveWholeText(state, address, item),
    title: item.title,
    splits: state.memo.ctx.splits,
    scopes: state.memo.ctx.scopes,
    address: { ...address, section: null },
  })
  return split.sections.map((section) => ({
    id: `section:${address.level}:${address.agent ?? ""}:${address.item}:${section.id}`,
    label: section.name,
    depth: lazy.depth + 1 + section.depth,
    address: { ...address, section: section.id },
  }))
}

// Orphan means stale by the record alone: the item id names no snapshot
// item, the agent names no known agent, or the section id is gone from the
// current split at that address. Records at rowless but valid addresses
// (per-agent MCP state, say) are not orphans.
function pushOrphans(
  state: QueryState,
  push: (candidate: Omit<Candidate, "index" | "resolvedText" | "upstreamText">) => void,
): void {
  const seen = new Set<string>()
  for (const record of state.memo.ctx.customizations) {
    const key = JSON.stringify([record.level, record.agent, record.item, record.section])
    if (seen.has(key)) continue
    seen.add(key)
    if (!isOrphan(state, record.level, record.agent, record.item, record.section)) continue
    const address: Address = { level: record.level, agent: record.agent, item: record.item, section: record.section }
    if (record.section === null)
      push({ id: `item:${record.level}:${record.agent ?? ""}:${record.item}`, kind: "item", label: record.item, depth: 0, orphan: true, lazy: undefined, address, sectionCount: 0 })
    else
      push({ id: `section:${record.level}:${record.agent ?? ""}:${record.item}:${record.section}`, kind: "section", label: record.section, depth: 0, orphan: true, lazy: undefined, address, sectionCount: 0 })
  }
  for (const split of state.memo.ctx.splits) {
    const key = JSON.stringify([split.level, split.agent, split.item, null])
    if (seen.has(key)) continue
    seen.add(key)
    if (!isOrphan(state, split.level, split.agent, split.item, null)) continue
    push({ id: `item:${split.level}:${split.agent ?? ""}:${split.item}`, kind: "item", label: split.item, depth: 0, orphan: true, lazy: undefined, address: { level: split.level, agent: split.agent, item: split.item, section: null }, sectionCount: 0 })
  }
}

function isOrphan(state: QueryState, level: Level, agent: string | null, itemId: string, section: string | null): boolean {
  const item = lookupItem(state, itemId, agent)
  if (item === undefined) return true
  if (agent !== null && !state.agents.has(agent)) return true
  if (section === null) return false
  const address: Address = { level, agent, item: itemId, section: null }
  const split = resolveSplit({
    text: effectiveWholeText(state, address, item),
    title: item.title,
    splits: state.memo.ctx.splits,
    scopes: state.memo.ctx.scopes,
    address,
  })
  return !split.sections.some((entry) => entry.id === section)
}

function effectiveWholeText(state: QueryState, address: Address, item: Item): string {
  const chain = resolutionChain(address, state.memo.ctx.scopes)
  const whole = recsAt(state, address.item, null)
  const winner = chain.find((node) => atNode(whole, node.level, node.agent)?.text !== undefined)
  if (winner === undefined) return item.text
  return atNode(whole, winner.level, winner.agent)?.text ?? item.text
}

// The badge values the tree renders, recomputed from stored records without
// touching the memo so structural filters never resolve text.
function wholeBadges(
  state: QueryState,
  address: Address,
  item: Item,
): { enabled: boolean; source: Level | "upstream"; modified: boolean; review: boolean } {
  const chain = resolutionChain(address, state.memo.ctx.scopes)
  const whole = recsAt(state, address.item, null)
  const stateWinner = chain.find((node) => atNode(whole, node.level, node.agent)?.state !== undefined)
  const own = atNode(whole, address.level, address.agent)
  let review = false
  if (own?.text !== undefined) {
    const above = chain
      .slice(1)
      .map((node) => atNode(whole, node.level, node.agent)?.text)
      .find((text) => text !== undefined)
    const current = above === undefined ? item.fingerprint : fingerprint(above)
    review = current !== own.basedOn && current !== own.acknowledged
  }
  const source = chain.find((node) => {
    const found = atNode(whole, node.level, node.agent)
    return found?.text !== undefined || found?.state !== undefined
  })
  return {
    enabled: stateWinner === undefined ? item.enabled : atNode(whole, stateWinner.level, stateWinner.agent)?.state === "on",
    source: source?.level ?? "upstream",
    modified: own?.text !== undefined,
    review,
  }
}

function sectionBadges(
  state: QueryState,
  address: Address,
  item: Item,
  section: string,
): { enabled: boolean; source: Level | "upstream"; modified: boolean; review: boolean } {
  const chain = resolutionChain(address, state.memo.ctx.scopes)
  const sectioned = recsAt(state, address.item, section)
  const winner = chain.find((node) => atNode(sectioned, node.level, node.agent)?.text !== undefined)
  const stateWinner = chain.find((node) => atNode(sectioned, node.level, node.agent)?.state !== undefined)
  const whole = wholeBadges(state, { ...address, section: null }, item)
  const own = atNode(sectioned, address.level, address.agent)
  return {
    enabled: stateWinner === undefined ? whole.enabled : atNode(sectioned, stateWinner.level, stateWinner.agent)?.state === "on",
    source: winner?.level ?? stateWinner?.level ?? "upstream",
    modified: own?.text !== undefined,
    review: sectionReview(state, address, item, section),
  }
}

function sectionReview(state: QueryState, address: Address, item: Item, section: string): boolean {
  const own = atNode(recsAt(state, address.item, section), address.level, address.agent)
  if (own?.text === undefined) return false
  const current = fingerprint(aboveSectionText(state, address, item, section))
  return current !== own.basedOn && current !== own.acknowledged
}

function aboveWholeText(state: QueryState, address: Address, item: Item): string {
  const chain = resolutionChain(address, state.memo.ctx.scopes)
  const whole = recsAt(state, address.item, null)
  return (
    chain
      .slice(1)
      .map((node) => atNode(whole, node.level, node.agent)?.text)
      .find((text) => text !== undefined) ?? item.text
  )
}

function aboveSectionText(state: QueryState, address: Address, item: Item, section: string): string {
  const chain = resolutionChain(address, state.memo.ctx.scopes)
  const sectioned = recsAt(state, address.item, section)
  const ancestor = chain
    .slice(1)
    .map((node) => atNode(sectioned, node.level, node.agent)?.text)
    .find((text) => text !== undefined)
  if (ancestor !== undefined) return ancestor
  const text = aboveWholeText(state, address, item)
  const split = resolveSplit({
    text,
    title: item.title,
    splits: state.memo.ctx.splits,
    scopes: state.memo.ctx.scopes,
    address,
  })
  const definition = split.sections.find((entry) => entry.id === section)
  if (definition === undefined) return text
  return slice(text, definition)
}

function resolvedTextOf(state: QueryState, candidate: Candidate): string {
  if (candidate.resolvedText !== undefined) return candidate.resolvedText
  const address = candidate.address
  const item = address === undefined ? undefined : lookupItem(state, address.item, address.agent)
  const text =
    address === undefined || item === undefined
      ? ""
      : address.section === null
        ? wholeOf(state.memo, address.level, address.agent, item).text
        : sectionResolveOf(state.memo, address.level, address.agent, item, address.section).text
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
      : address.section === null
        ? aboveWholeText(state, address, item)
        : aboveSectionText(state, address, item, address.section)
  candidate.upstreamText = text
  return text
}

function enabledOf(state: QueryState, candidate: Candidate): boolean | undefined {
  const address = candidate.address
  if (address === undefined) {
    if (candidate.kind !== "team") return undefined
    const level = levelOf(candidate)
    if (level !== "project" && level !== "global") return undefined
    const team = state.memo.ctx.teams.find((entry) => entry.level === level && candidate.id === `team:${level}:${entry.team}`)
    return team?.enabled
  }
  const item = lookupItem(state, address.item, address.agent)
  if (item === undefined) {
    const stateValue = ownOf(state, address)?.state
    return stateValue === undefined ? undefined : stateValue === "on"
  }
  if (address.section !== null) return sectionBadges(state, address, item, address.section).enabled
  return wholeBadges(state, address, item).enabled
}

function actionsOf(state: QueryState, candidate: Candidate): TreeNodeActions {
  if (candidate.lazy !== undefined) return candidate.lazy.actions
  const address = candidate.address
  if (address === undefined || candidate.orphan) return { toggle: false, edit: false, reset: false, remove: false, split: false }
  const item = lookupItem(state, address.item, address.agent)
  const gated = item !== undefined && item.kind === "tool" && item.codemode === true
  return {
    toggle: !gated,
    edit: !gated,
    reset: canReset(state.memo.ctx.customizations, address),
    remove: false,
    split: false,
  }
}

function livenessOf(state: QueryState, candidate: Candidate, key: "active" | "inactive" | "unsupported"): boolean {
  const address = candidate.address
  if (address === undefined) return false
  const item = lookupItem(state, address.item, address.agent)
  if (item === undefined) return false
  // Sections never carry the base liveness badges: like the tree, only a
  // gated Code Mode section reads unsupported.
  if (address.section !== null) return key === "unsupported" && item.kind === "tool" && item.codemode === true
  if (key === "unsupported") {
    if (item.kind === "tool" && item.codemode === true) return true
    return item.id === "system:role" || item.kind === "base"
  }
  if (item.kind !== "base") return false
  if (key === "active") {
    const owner = address.agent === null ? undefined : state.agents.get(address.agent)
    return owner?.base !== undefined && item.id === `base:${owner.base}`
  }
  if (item.userBase !== true) return false
  return !builtinBaseIds().has(baseIdOf(item.id))
}

function baseIdOf(id: string): string {
  return id.startsWith("base:") ? id.slice("base:".length) : id
}

interface Badges {
  readonly state: "on" | "off" | undefined
  readonly modified: boolean
  readonly active: boolean
  readonly inactive: boolean
  readonly unsupported: boolean
  readonly review: boolean
  readonly reviewCount: number
  readonly source: Level | "upstream" | undefined
}

function badgesOf(state: QueryState, scope: Scope, candidate: Candidate): Badges {
  const address = candidate.address
  if (address === undefined) {
    const enabled = enabledOf(state, candidate)
    const count = reviewCountOf(state, scope, candidate)
    return {
      state: enabled === undefined ? undefined : enabled ? "on" : "off",
      modified: false,
      active: false,
      inactive: false,
      unsupported: false,
      review: count > 0,
      reviewCount: count,
      source: undefined,
    }
  }
  const item = lookupItem(state, address.item, address.agent)
  if (item === undefined) {
    const enabled = enabledOf(state, candidate)
    return {
      state: enabled === undefined ? undefined : enabled ? "on" : "off",
      modified: ownOf(state, address)?.text !== undefined,
      active: false,
      inactive: false,
      unsupported: false,
      review: false,
      reviewCount: 0,
      source: undefined,
    }
  }
  const resolved =
    address.section === null ? wholeBadges(state, address, item) : sectionBadges(state, address, item, address.section)
  const count = reviewCountOf(state, scope, candidate)
  return {
    state: resolved.enabled ? "on" : "off",
    modified: resolved.modified,
    active: livenessOf(state, candidate, "active"),
    inactive: livenessOf(state, candidate, "inactive"),
    unsupported: livenessOf(state, candidate, "unsupported"),
    review: resolved.review || count > 0,
    reviewCount: candidate.kind === "section" ? 0 : count,
    source: resolved.source,
  }
}

function selfReviewOf(state: QueryState, candidate: Candidate): boolean {
  const address = candidate.address
  if (address === undefined) return false
  const item = lookupItem(state, address.item, address.agent)
  if (item === undefined) return false
  if (address.section !== null) return sectionBadges(state, address, item, address.section).review
  return wholeBadges(state, address, item).review
}

function reviewCountOf(state: QueryState, scope: Scope, candidate: Candidate): number {
  const address = candidate.address
  if (address !== undefined) {
    if (candidate.kind === "section") return 0
    const item = lookupItem(state, address.item, address.agent)
    if (item === undefined) return 0
    if (item.kind === "tool" && item.codemode === true) return 0
    const split = resolveSplit({
      text: effectiveWholeText(state, address, item),
      title: item.title,
      splits: state.memo.ctx.splits,
      scopes: state.memo.ctx.scopes,
      address,
    })
    return split.sections.filter((section) => sectionBadges(state, address, item, section.id).review).length
  }
  return directChildren(scope, candidate).reduce(
    (sum, child) => sum + reviewCountOf(state, scope, child) + (selfReviewOf(state, child) ? 1 : 0),
    0,
  )
}

function directChildren(scope: Scope, candidate: Candidate): Candidate[] {
  const out: Candidate[] = []
  for (let at = candidate.index + 1; at < scope.all.length; at++) {
    const next = scope.all[at]
    if (next === undefined || next.depth <= candidate.depth) break
    if (next.depth === candidate.depth + 1) out.push(next)
  }
  return out
}

function levelOf(candidate: Candidate): Level | undefined {
  if (candidate.address !== undefined) return candidate.address.level
  const segment = candidate.id.split(":")[1]
  return segment === "project" || segment === "global" || segment === "defaults" ? segment : undefined
}

function agentOf(candidate: Candidate): string | null {
  if (candidate.address !== undefined) return candidate.address.agent
  if (candidate.kind === "agent") return candidate.id.split(":").slice(2).join(":")
  return null
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
  if (candidate.kind === "agent") {
    const team = state.agents.get(agentOf(candidate) ?? "")?.team
    return team === undefined ? [] : [team]
  }
  if (candidate.kind !== "team") return []
  const level = levelOf(candidate)
  if (level !== "project" && level !== "global") return []
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
  return splitOfAddress(state, address.level, address.agent, address.item)?.updated
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
  if (item.kind === "tool" && item.codemode === true) return true
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

function tokensOf(state: QueryState, candidate: Candidate): number {
  if (candidate.address === undefined) return 0
  return Math.ceil(resolvedTextOf(state, candidate).length / 4)
}

function deltaOf(state: QueryState, candidate: Candidate): number {
  const address = candidate.address
  if (address === undefined) return 0
  if (ownOf(state, address)?.text === undefined) return 0
  return changedLines(upstreamTextOf(state, candidate), resolvedTextOf(state, candidate))
}

function parseWhere(where: string, state: QueryState, scope: Scope): Parsed {
  const filters: Filter[] = []
  let sort: SortSpec | undefined
  let wantsOrphans = false
  for (const raw of splitTerms(where)) {
    const parsed = parseTerm(raw, state, scope)
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

function parseTerm(raw: string, state: QueryState, scope: Scope): TermOut | undefined {
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
    return { negate, rank: 0, test: (candidate) => contains(candidate.label, word) || contains(candidate.id, word), wantsOrphans: false }
  }
  const key = body.slice(0, colon).toLowerCase()
  const alts = splitValue(body.slice(colon + 1), raw)
  if (key === "sort") {
    if (negate) throw new Error(`cannot negate the sort directive in "${raw}"`)
    if (alts.length !== 1) throw new Error(`bad sort directive in "${raw}"`)
    return { sort: parseSortKey(alts[0] ?? "", raw) }
  }
  return { negate, rank: rankFor(key, raw), test: testFor(key, alts, raw, state, scope), wantsOrphans: key === "orphan" && wantsTrue(alts, negate) }
}

function wantsTrue(alts: readonly string[], negate: boolean): boolean {
  return negate ? alts.some((alt) => lower(alt) === "false") : alts.some((alt) => lower(alt) === "true")
}

function rankFor(key: string, term: string): number {
  if (key === "state" || key === "modified" || key === "review" || key === "source" || key === "excluded") return 1
  const order = ["identical", "dead", "shadowed", "orphan", "tokens", "delta", "overriders", "text", "upstream"]
  const index = order.indexOf(key)
  if (index === -1 && !structuralKeys.has(key)) throw new Error(`unknown filter key in "${term}"`)
  return index === -1 ? 0 : 2 + index
}

const structuralKeys = new Set([
  "kind",
  "item",
  "group",
  "server",
  "level",
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

function testFor(key: string, alts: readonly string[], term: string, state: QueryState, scope: Scope): (candidate: Candidate) => boolean {
  switch (key) {
    case "kind": {
      const allowed = oneOf(key, alts, ["root", "group", "agent", "team", "item", "section"], term)
      return (candidate) => allowed.some((alt) => candidate.kind === lower(alt))
    }
    case "item": {
      const allowed = oneOf(key, alts, ["tool", "base", "skill", "system", "mcp"], term)
      return (candidate) => allowed.some((alt) => itemKindOf(state, candidate) === lower(alt))
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
    case "agent": {
      return (candidate) => {
        const agent = agentOf(candidate)
        return alts.some((alt) => (alt === "_" ? agent === null : agent !== null && lower(agent) === lower(alt)))
      }
    }
    case "state": {
      const allowed = oneOf(key, alts, ["on", "off"], term)
      return (candidate) => {
        const enabled = enabledOf(state, candidate)
        if (enabled === undefined) return false
        return allowed.some((alt) => (enabled ? "on" : "off") === lower(alt))
      }
    }
    case "modified": {
      const allowed = booleanOf(alts, term)
      return (candidate) => {
        const address = candidate.address
        const modified = address !== undefined && ownOf(state, address)?.text !== undefined
        return allowed.some((alt) => modified === alt)
      }
    }
    case "review": {
      const allowed = booleanOf(alts, term)
      return (candidate) => allowed.some((alt) => badgesOf(state, scope, candidate).review === alt)
    }
    case "source": {
      const allowed = oneOf(key, alts, ["project", "global", "defaults", "upstream"], term)
      return (candidate) => {
        const address = candidate.address
        if (address === undefined) return false
        const item = lookupItem(state, address.item, address.agent)
        if (item === undefined) return false
        const source =
          address.section === null
            ? wholeBadges(state, address, item).source
            : sectionBadges(state, address, item, address.section).source
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
    case "unsupported": {
      const allowed = booleanOf(alts, term)
      return (candidate) => allowed.some((alt) => livenessOf(state, candidate, key) === alt)
    }
    case "codemode": {
      const allowed = booleanOf(alts, term)
      return (candidate) => {
        const address = candidate.address
        const value = address !== undefined && lookupItem(state, address.item, address.agent)?.codemode === true
        return allowed.some((alt) => value === alt)
      }
    }
    case "can": {
      const allowed = oneOf(key, alts, ["toggle", "edit", "reset", "remove", "split"], term)
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
        const enabled = enabledOf(state, candidate)
        const excluded = candidate.address !== undefined && enabled === false
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
  if (alt === "split") return splitOfAddress(state, address.level, address.agent, address.item) !== undefined
  if (alt === "sections") return candidate.sectionCount > 0
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

function badgesString(badges: Badges): string {
  const labels: string[] = []
  if (badges.state !== undefined) labels.push(badges.state)
  if (badges.modified) labels.push("modified")
  if (badges.active) labels.push("active")
  if (badges.inactive) labels.push("inactive")
  if (badges.unsupported) labels.push("unsupported")
  if (badges.reviewCount > 0) labels.push(`${badges.reviewCount} to review`)
  else if (badges.review) labels.push("review")
  return labels.join(" ")
}

function project(state: QueryState, scope: Scope, candidate: Candidate, fields: readonly Field[]): QueryRow {
  const row: Record<string, unknown> = { id: candidate.id }
  for (const field of fields) {
    if (field === "id") continue
    if (field === "badges") {
      row.badges = badgesString(badgesOf(state, scope, candidate))
      continue
    }
    if (field === "source") {
      const source = badgesOf(state, scope, candidate).source
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
      if (candidate.kind === "item" && candidate.lazy !== undefined)
        row.sections = sectionsFor(state, candidate.lazy).map((section) => section.id)
    }
  }
  return row as unknown as QueryRow
}
