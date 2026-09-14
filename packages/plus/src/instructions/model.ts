import { createHash } from "node:crypto"
import { assemble, derive, manual, slice, type Split } from "./sections.js"

export type Level = "defaults" | "global" | "project"

/** `agent === null` means a Defaults shared-inventory row. Only valid at level "defaults". */
export interface Address {
  readonly level: Level
  readonly agent: string | null
  readonly item: string
  readonly section: string | null
}

export type ItemKind = "tool" | "base" | "skill" | "system" | "mcp"
export type ItemGroup = "native" | "plus" | "mcp" | "project" | "none"

export interface Item {
  readonly id: string
  readonly kind: ItemKind
  readonly group: ItemGroup
  readonly server?: string
  readonly title: string
  readonly text: string
  readonly enabled: boolean
  readonly fingerprint: string
  readonly agents?: readonly string[]
  readonly order?: number
}

// Id forms (documented, not enforced):
// - `tool:<toolId>`
// - `base:<templateId>` (gpt|claude|muse|gemini|general)
// - `skill:<skillId>`
// - `system:role` (the agent's own prompt body = Role/persona), `system:<relativePath>`
// - `mcp:<server>`

export interface Scopes {
  readonly global: ReadonlySet<string>
  readonly defaults: ReadonlySet<string>
}

export type AgentScope = "project" | "global" | "defaults"

export interface AgentSource {
  readonly id: string
  readonly scope: AgentScope
  readonly path?: string
  /** id of the base prompt template active for this agent's model, e.g. "gpt" */
  readonly base?: string
}

/** { global: ids with scope "global", defaults: ids with scope "defaults" } */
export function scopesOf(agents: readonly AgentSource[]): Scopes {
  return {
    global: new Set(agents.filter((agent) => agent.scope === "global").map((agent) => agent.id)),
    defaults: new Set(agents.filter((agent) => agent.scope === "defaults").map((agent) => agent.id)),
  }
}

export interface CustomizationRecord {
  readonly type: "customization"
  readonly level: Level
  readonly agent: string | null
  readonly item: string
  readonly section: string | null
  readonly text?: string
  readonly state?: "on" | "off"
  readonly basedOn: string
  readonly basedOnText?: string
  readonly acknowledged?: string
  readonly updated: string
}

export interface SplitRecord {
  readonly type: "split"
  readonly level: Level
  readonly agent: string | null
  readonly item: string
  readonly boundaries: readonly { id: string; name: string; start: number }[]
  readonly updated: string
}

export interface Resolved {
  readonly text: string
  readonly assembled: string
  readonly enabled: boolean
  readonly source: Level | "upstream"
  readonly overriddenHere: boolean
  readonly modified: boolean
  readonly review: boolean
}

export interface ThreeWay {
  readonly original: string
  readonly mine: string
  readonly upstream: string
}

export type Resolution = "keep" | "take" | "edit"

export interface MergeFields {
  readonly text?: string | null
  readonly state?: "on" | "off" | null
  readonly acknowledged?: string | null
}

export interface ChainInput {
  readonly upstream: Item
  readonly records: readonly CustomizationRecord[]
  readonly splits: readonly SplitRecord[]
  readonly scopes: Scopes
  readonly address: Address
}

export function fingerprint(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex")
}

export function resolve(input: ChainInput): Resolved {
  if (input.address.section !== null) return resolveSection(input)
  return resolveWhole(input)
}

export interface SplitInput {
  readonly text: string
  readonly title: string
  readonly splits: readonly SplitRecord[]
  readonly scopes: Scopes
  readonly address: Address
}

// Splits belong to the item, not the agent: the nearest split record down the
// same chain wins, otherwise the text derives its own split.
export function resolveSplit(input: SplitInput): Split {
  const chain = resolutionChain(input.address, input.scopes)
  const winner = chain
    .map((node) => input.splits.find((split) => split.item === input.address.item && split.level === node.level && split.agent === node.agent))
    .find((split) => split !== undefined)
  if (winner === undefined) return derive(input.text, input.title)
  return manual(input.text, winner.boundaries)
}

// The upstream view for review comparison: what the chain above this level
// resolves now. An unmodified node stores no text, so it re-resolves every
// read and a change above propagates with no user action.
export function threeWay(input: ChainInput): ThreeWay | undefined {
  if (input.address.section !== null) return threeWaySection(input)
  const whole = wholeRecords(input)
  const own = at(whole, input.address)
  if (own?.text === undefined || own.basedOnText === undefined) return undefined
  return { original: own.basedOnText, mine: own.text, upstream: aboveWholeText(input, whole) }
}

export function resolveResolution(
  input: ChainInput,
  resolution: Resolution,
  edited?: string,
): CustomizationRecord[] {
  const records = [...input.records]
  const index = records.findIndex((record) => sameNode(record, input.address))
  const existing = index === -1 ? undefined : records[index]
  if (resolution === "keep") {
    if (existing === undefined) return records
    records[index] = { ...withoutUndefined(existing), acknowledged: input.upstream.fingerprint, updated: now() }
    return records
  }
  if (resolution === "take") {
    if (existing === undefined) return records
    const dropped = withoutUndefined({ ...existing, text: undefined, basedOnText: undefined, acknowledged: undefined })
    if (dropped.text === undefined && dropped.state === undefined) {
      records.splice(index, 1)
      return records
    }
    records[index] = dropped
    return records
  }
  if (edited === undefined) return records
  const current = threeWay(input)
  const record: CustomizationRecord = {
    ...withoutUndefined(
      existing ?? {
        type: "customization",
        level: input.address.level,
        agent: input.address.agent,
        item: input.address.item,
        section: input.address.section,
        basedOn: "",
        updated: "",
      },
    ),
    level: input.address.level,
    agent: input.address.agent,
    item: input.address.item,
    section: input.address.section,
    text: edited,
    basedOn: input.upstream.fingerprint,
    basedOnText: current?.upstream ?? input.upstream.text,
    acknowledged: input.upstream.fingerprint,
    updated: now(),
  }
  records[index === -1 ? records.length : index] = record
  return records
}

export function merge(
  records: readonly CustomizationRecord[],
  address: Address,
  fields: MergeFields,
  upstream: Pick<Item, "fingerprint" | "text">,
): CustomizationRecord[] {
  const rest = records.filter((record) => !sameNode(record, address))
  const existing = records.find((record) => sameNode(record, address))
  const text = fields.text === undefined ? existing?.text : (fields.text ?? undefined)
  const state = fields.state === undefined ? existing?.state : (fields.state ?? undefined)
  const acknowledged = fields.acknowledged === undefined ? existing?.acknowledged : (fields.acknowledged ?? undefined)
  if (text === undefined && state === undefined) return [...rest]
  const next: CustomizationRecord = {
    type: "customization",
    level: address.level,
    agent: address.agent,
    item: address.item,
    section: address.section,
    ...(text === undefined ? {} : { text }),
    ...(state === undefined ? {} : { state }),
    basedOn: existing?.basedOn ?? upstream.fingerprint,
    ...(existing?.basedOnText === undefined && text === undefined ? {} : { basedOnText: existing?.basedOnText ?? upstream.text }),
    ...(acknowledged === undefined ? {} : { acknowledged }),
    updated: now(),
  }
  return [...rest, next]
}

export function reset(records: readonly CustomizationRecord[], address: Address): CustomizationRecord[] {
  return records.filter((record) => !sameNode(record, address))
}

export function applies(item: Pick<Item, "agents">, agent: string): boolean {
  if (item.agents === undefined) return true
  return item.agents.includes(agent)
}

export function canReset(records: readonly CustomizationRecord[], address: Address): boolean {
  return records.some((record) => sameNode(record, address))
}

// Roll-up for ancestor rows: count reviewable descendants under a prefix.
// Callers resolve each visible node and pass the entries in.
export function countReview(
  entries: readonly { address: Address; resolved: Resolved }[],
  prefix: { level: Level; agent: string | null; item?: string },
): number {
  return entries
    .filter(
      (entry) =>
        entry.address.level === prefix.level &&
        entry.address.agent === prefix.agent &&
        (prefix.item === undefined || entry.address.item === prefix.item),
    )
    .filter((entry) => entry.resolved.review).length
}

function resolveWhole(input: ChainInput): Resolved {
  const whole = wholeRecords(input)
  const chain = resolutionChain(input.address, input.scopes)
  const textWinner = chain.find((node) => at(whole, node)?.text !== undefined)
  const stateWinner = chain.find((node) => at(whole, node)?.state !== undefined)
  const text = textWinner === undefined ? input.upstream.text : (at(whole, textWinner)?.text ?? "")
  const enabled = stateWinner === undefined ? input.upstream.enabled : at(whole, stateWinner)?.state === "on"
  const own = at(whole, input.address)
  const split = resolveSplit({
    text,
    title: input.upstream.title,
    splits: input.splits,
    scopes: input.scopes,
    address: input.address,
  })
  const excluded = new Set(
    split.sections.map((section) => section.id).filter((id) => sectionState(input, chain, id) === "off"),
  )
  const modified = own?.text !== undefined
  const source = chain.find((node) => at(whole, node)?.text !== undefined || at(whole, node)?.state !== undefined)
  return {
    text,
    assembled: assemble(text, split, excluded),
    enabled,
    source: source?.level ?? "upstream",
    overriddenHere: own !== undefined && (own.text !== undefined || own.state !== undefined),
    modified,
    review: isReview(own, aboveWholeFingerprint(input, whole)),
  }
}

function resolveSection(input: ChainInput): Resolved {
  const id = input.address.section ?? ""
  const whole = resolveWhole({ ...input, address: { ...input.address, section: null } })
  const split = resolveSplit({
    text: whole.text,
    title: input.upstream.title,
    splits: input.splits,
    scopes: input.scopes,
    address: input.address,
  })
  const definition = split.sections.find((section) => section.id === id)
  const sectioned = sectionRecords(input, id)
  const chain = resolutionChain(input.address, input.scopes)
  const winner = chain.find((node) => at(sectioned, node)?.text !== undefined)
  const text = winner === undefined ? (definition === undefined ? "" : slice(whole.text, definition)) : (at(sectioned, winner)?.text ?? "")
  const stateWinner = chain.find((node) => at(sectioned, node)?.state !== undefined)
  const own = at(sectioned, input.address)
  const modified = own?.text !== undefined
  return {
    text,
    assembled: text,
    enabled: stateWinner === undefined ? whole.enabled : at(sectioned, stateWinner)?.state === "on",
    source: winner?.level ?? stateWinner?.level ?? "upstream",
    overriddenHere: own !== undefined && (own.text !== undefined || own.state !== undefined),
    modified,
    review: isReview(own, aboveSectionFingerprint(input, id)),
  }
}

function threeWaySection(input: ChainInput): ThreeWay | undefined {
  const id = input.address.section ?? ""
  const own = at(sectionRecords(input, id), input.address)
  if (own?.text === undefined || own.basedOnText === undefined) return undefined
  return { original: own.basedOnText, mine: own.text, upstream: aboveSectionText(input, id) }
}

function wholeRecords(input: ChainInput): CustomizationRecord[] {
  return input.records.filter((record) => record.item === input.address.item && record.section === null)
}

function sectionRecords(input: ChainInput, id: string): CustomizationRecord[] {
  return input.records.filter((record) => record.item === input.address.item && record.section === id)
}

function aboveWholeText(input: ChainInput, whole: readonly CustomizationRecord[]): string {
  const chain = resolutionChain(input.address, input.scopes)
  const above = chain
    .slice(1)
    .map((node) => at(whole, node)?.text)
    .find((text) => text !== undefined)
  return above ?? input.upstream.text
}

function aboveWholeFingerprint(input: ChainInput, whole: readonly CustomizationRecord[]): string {
  const chain = resolutionChain(input.address, input.scopes)
  const above = chain
    .slice(1)
    .map((node) => at(whole, node)?.text)
    .find((text) => text !== undefined)
  return above === undefined ? input.upstream.fingerprint : fingerprint(above)
}

function aboveSectionText(input: ChainInput, id: string): string {
  const text = aboveWholeText(input, wholeRecords(input))
  const split = resolveSplit({
    text,
    title: input.upstream.title,
    splits: input.splits,
    scopes: input.scopes,
    address: input.address,
  })
  const definition = split.sections.find((section) => section.id === id)
  if (definition === undefined) return text
  return slice(text, definition)
}

function aboveSectionFingerprint(input: ChainInput, id: string): string {
  return fingerprint(aboveSectionText(input, id))
}

function sectionState(
  input: ChainInput,
  chain: readonly { level: Level; agent: string | null }[],
  id: string,
): "on" | "off" | undefined {
  return chain
    .map((node) => sectionRecords(input, id).find((record) => record.level === node.level && record.agent === node.agent)?.state)
    .find((state) => state !== undefined)
}

// `modified` is text-only: a state-only override never marks a node modified
// and never raises review, so a disabled-but-otherwise-unmodified copy keeps
// taking upstream text silently.
function isReview(own: CustomizationRecord | undefined, current: string): boolean {
  if (own?.text === undefined) return false
  if (current === own.basedOn) return false
  if (current === own.acknowledged) return false
  return true
}

interface ChainNode {
  readonly level: Level
  readonly agent: string | null
}

// Resolution chain, most specific first, resolving text and state
// independently: the first level supplying that field wins.
function resolutionChain(address: Address, scopes: Scopes): ChainNode[] {
  const nodes: ChainNode[] = [{ level: address.level, agent: address.agent }]
  if (address.level === "project") {
    if (address.agent !== null && scopes.global.has(address.agent)) nodes.push({ level: "global", agent: address.agent })
    if (address.agent !== null && scopes.defaults.has(address.agent)) nodes.push({ level: "defaults", agent: address.agent })
  }
  if (address.level === "global" && address.agent !== null && scopes.defaults.has(address.agent))
    nodes.push({ level: "defaults", agent: address.agent })
  if (!(address.level === "defaults" && address.agent === null)) nodes.push({ level: "defaults", agent: null })
  return nodes
}

function at(records: readonly CustomizationRecord[], node: ChainNode | Address): CustomizationRecord | undefined {
  return records.find((record) => record.level === node.level && record.agent === node.agent)
}

function sameNode(
  record: { level: Level; agent: string | null; item: string; section: string | null },
  address: Address,
): boolean {
  return (
    record.level === address.level &&
    record.agent === address.agent &&
    record.item === address.item &&
    record.section === address.section
  )
}

function withoutUndefined(record: CustomizationRecord): CustomizationRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as CustomizationRecord
}

function now(): string {
  return new Date().toISOString()
}
