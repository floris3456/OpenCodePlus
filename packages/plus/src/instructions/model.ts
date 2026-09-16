import { createHash } from "node:crypto"
import type { Tool } from "@opencode/schema/tool"
import { assembleWithOverrides, derive, manual, slice, type Split } from "./sections.js"

export type Level = "defaults" | "global" | "project"

/** `agent === null` means a Defaults shared-inventory row. Only valid at level "defaults". */
export interface Address {
  readonly level: Level
  readonly agent: string | null
  readonly item: string
  readonly section: string | null
}

export type ItemKind = "tool" | "base" | "skill" | "system" | "mcp" | "model" | "perm"
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
  /** True for user-created base templates (deletable, never the host active answer). */
  readonly userBase?: boolean
  /** True for Code Mode tools: applied through deny rules and the catalog hook. */
  readonly codemode?: boolean
  /** The Code Mode namespace the tool is grouped under (`tool.options.namespace`). */
  readonly namespace?: string
  /** The tool registry's own default pin (`tool.options.pinned`), i.e. the upstream value a user pin overrides. */
  readonly pinned?: boolean
  /** Marks the single synthetic host-owned `execute` row. Only discovery ever sets it, always `true`. */
  readonly execute?: boolean
  /** Perm rule rows only: the parent tool id (e.g. "shell", "edit", "subagent"). Only discovery ever sets it. */
  readonly permTool?: string
  /** Perm rule rows only: the core permission action from the tool's own `options.permission` when the registry carries one. Only discovery ever sets it. */
  readonly permAction?: string
  /** Perm rule rows only: the rule id within its tool (e.g. "git-push"). Only discovery ever sets it. */
  readonly ruleId?: string
  /** Perm rule rows only: core wildcard patterns denied when the row is off. Only discovery ever sets it. */
  readonly patterns?: readonly string[]
  /** Perm rule rows only: whole-word scrub keywords derived via keywordsForPattern. Only discovery ever sets it. */
  readonly keywords?: readonly string[]
  /** Perm rule rows only: item ids whose text mentioned this rule, most-mentioned first. Only discovery ever sets it. */
  readonly provenance?: readonly string[]
  /** Perm rule rows only: true when the row comes from a user RuleRecord. Only discovery ever sets it. */
  readonly custom?: boolean
}

// Id forms (documented, not enforced):
// - `tool:<toolId>`
// - `base:<templateId>` (gpt|claude|muse|gemini|general)
// - `skill:<skillId>`
// - `system:role` (the agent's own prompt body = Role/persona), `system:<relativePath>`
// - `mcp:<server>`
// - `model:<providerID>/<modelID>` or `model:<providerID>/<modelID>@<variant>`
// - `perm:<toolId>:<ruleId>`

export interface Scopes {
  readonly global: ReadonlySet<string>
  readonly defaults: ReadonlySet<string>
}

export type AgentScope = "project" | "global" | "defaults"

export interface AgentSource {
  readonly id: string
  readonly scope: AgentScope
  readonly path?: string
  /** team contributing this agent when it comes from an enabled team */
  readonly team?: string
  /** id of the base prompt template active for this agent's model, e.g. "gpt" */
  readonly base?: string
  /** unmasked upstream model for this agent's Models group (file frontmatter wins, else host) */
  readonly model?: ModelRefLike
}

export interface ModelRefLike {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
}

export interface ModelCandidate {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
  readonly source: Level | "upstream"
}

export function modelKey(candidate: Pick<ModelRefLike, "providerID" | "modelID" | "variant">): string {
  if (candidate.variant === undefined) return `${candidate.providerID}/${candidate.modelID}`
  return `${candidate.providerID}/${candidate.modelID}@${candidate.variant}`
}

export function sameModelCandidate(
  left: Pick<ModelRefLike, "providerID" | "modelID" | "variant">,
  right: Pick<ModelRefLike, "providerID" | "modelID" | "variant">,
): boolean {
  if (left.providerID !== right.providerID) return false
  if (left.modelID !== right.modelID) return false
  return (left.variant ?? "default") === (right.variant ?? "default")
}

// Union down the chain, deduplicated, most-specific source wins. Chain is the
// existing resolutionChain order (most specific first): the first record for
// a candidate names its source. Upstream appends last when not already present.
export function modelCandidates(input: {
  models: readonly ModelRecord[]
  scopes: Scopes
  level: Level
  agent: string | null
  upstream?: ModelRefLike
}): ModelCandidate[] {
  const chain = resolutionChain(
    { level: input.level, agent: input.agent, item: "", section: null },
    input.scopes,
  )
  const seen = new Map<string, ModelCandidate>()
  for (const node of chain) {
    const matches = input.models.filter((record) => record.level === node.level && record.agent === node.agent)
    for (const record of matches) {
      const key = modelKey(record)
      if (seen.has(key)) continue
      seen.set(key, {
        providerID: record.providerID,
        modelID: record.modelID,
        ...(record.variant === undefined ? {} : { variant: record.variant }),
        source: node.level,
      })
    }
  }
  if (input.agent !== null && input.upstream !== undefined) {
    const key = modelKey(input.upstream)
    if (!seen.has(key))
      seen.set(key, {
        providerID: input.upstream.providerID,
        modelID: input.upstream.modelID,
        ...(input.upstream.variant === undefined ? {} : { variant: input.upstream.variant }),
        source: "upstream",
      })
  }
  return [...seen.values()]
}

// First active record down the chain, else upstream. No active and no
// upstream means Plus installs nothing for this agent.
export function resolveActiveModel(input: {
  models: readonly ModelRecord[]
  scopes: Scopes
  level: Level
  agent: string | null
  upstream?: ModelRefLike
}): ModelCandidate | undefined {
  const chain = resolutionChain(
    { level: input.level, agent: input.agent, item: "", section: null },
    input.scopes,
  )
  for (const node of chain) {
    const winner = input.models.find(
      (record) => record.level === node.level && record.agent === node.agent && record.active === true,
    )
    if (winner !== undefined)
      return {
        providerID: winner.providerID,
        modelID: winner.modelID,
        ...(winner.variant === undefined ? {} : { variant: winner.variant }),
        source: node.level,
      }
  }
  if (input.agent !== null && input.upstream !== undefined)
    return {
      providerID: input.upstream.providerID,
      modelID: input.upstream.modelID,
      ...(input.upstream.variant === undefined ? {} : { variant: input.upstream.variant }),
      source: "upstream",
    }
  return undefined
}

export function hasModelRecordAt(
  models: readonly ModelRecord[],
  address: { level: Level; agent: string | null },
  target: Pick<ModelRefLike, "providerID" | "modelID" | "variant">,
): boolean {
  return models.some(
    (record) =>
      record.level === address.level &&
      record.agent === address.agent &&
      record.providerID === target.providerID &&
      record.modelID === target.modelID &&
      record.variant === target.variant,
  )
}

export function hasModelActiveAt(
  models: readonly ModelRecord[],
  address: { level: Level; agent: string | null },
): boolean {
  return models.some((record) => record.level === address.level && record.agent === address.agent && record.active === true)
}

// Adding a candidate stores an inactive row; activation is a separate
// exclusive flip so adding never steals the effective model. A duplicate at
// the same address returns an identical list (an unchanged save stays a
// no-op). Records keep caller-supplied timestamps: this is pure content.
export function addModelRecord(
  models: readonly ModelRecord[],
  address: { level: Level; agent: string | null },
  target: { providerID: string; modelID: string; variant?: string },
  updated: string,
): ModelRecord[] {
  const exists = models.some(
    (record) =>
      record.level === address.level &&
      record.agent === address.agent &&
      record.providerID === target.providerID &&
      record.modelID === target.modelID &&
      record.variant === target.variant,
  )
  if (exists) return [...models]
  return [
    ...models,
    {
      type: "model",
      level: address.level,
      agent: address.agent,
      providerID: target.providerID,
      modelID: target.modelID,
      ...(target.variant === undefined ? {} : { variant: target.variant }),
      updated,
    },
  ]
}

// Activating a candidate that has no row at this address first creates the
// inactive row, then flips it active exclusively. This is the TUI space path:
// the visible union includes inherited rows with no local record, and
// choosing one must plant the level override rather than refuse.
export function ensureActivateModel(
  models: readonly ModelRecord[],
  address: { level: Level; agent: string | null },
  target: { providerID: string; modelID: string; variant?: string },
  updated: string,
): ModelRecord[] {
  const withRow = addModelRecord(models, address, target, updated)
  return activateModel(withRow, address, target)
}

// Reset clears only this level's active flag, leaving candidates in place so
// the chain falls through to the next active below (or upstream). No active
// at this address returns an identical list.
export function clearModelActive(
  models: readonly ModelRecord[],
  address: { level: Level; agent: string | null },
): ModelRecord[] {
  const scoped = models.some((record) => record.level === address.level && record.agent === address.agent && record.active === true)
  if (!scoped) return [...models]
  return models.map((record) => {
    if (record.level !== address.level || record.agent !== address.agent) return record
    if (record.active === undefined) return record
    return {
      type: "model",
      level: record.level,
      agent: record.agent,
      providerID: record.providerID,
      modelID: record.modelID,
      ...(record.variant === undefined ? {} : { variant: record.variant }),
      updated: record.updated,
    }
  })
}

export function removeModelRecord(
  models: readonly ModelRecord[],
  address: { level: Level; agent: string | null },
  target: { providerID: string; modelID: string; variant?: string },
): ModelRecord[] {
  return models.filter(
    (record) =>
      !(
        record.level === address.level &&
        record.agent === address.agent &&
        record.providerID === target.providerID &&
        record.modelID === target.modelID &&
        record.variant === target.variant
      ),
  )
}

/** { global: ids with scope "global", defaults: ids with scope "defaults" } */
export function scopesOf(agents: readonly AgentSource[]): Scopes {
  return {
    global: new Set(agents.filter((agent) => agent.scope === "global").map((agent) => agent.id)),
    defaults: new Set(agents.filter((agent) => agent.scope === "defaults").map((agent) => agent.id)),
  }
}

// Item ids for the two phase-1 record kinds. Row ids address the whole row as
// `item:<level>:<agent|''>:<itemId>` by concatenation and match by exact
// string equality (ops.ts findNode), so `/`, `@`, and extra `:` inside the
// item segment need no escaping; the parsers below split on the first `/`
// (provider vs model) and the first `:` (tool vs rule) only.

// `model:<providerID>/<modelID>` or `model:<providerID>/<modelID>@<variant>`.
export function modelItemId(input: { providerID: string; modelID: string; variant?: string }): string {
  const base = `model:${input.providerID}/${input.modelID}`
  if (input.variant === undefined) return base
  return `${base}@${input.variant}`
}

export function parseModelItemId(id: string): { providerID: string; modelID: string; variant?: string } | undefined {
  if (!id.startsWith("model:")) return undefined
  const rest = id.slice("model:".length)
  const slash = rest.indexOf("/")
  if (slash === -1) return undefined
  const providerID = rest.slice(0, slash)
  const remainder = rest.slice(slash + 1)
  if (providerID.length === 0 || remainder.length === 0) return undefined
  const at = remainder.indexOf("@")
  if (at === -1) return { providerID, modelID: remainder }
  const modelID = remainder.slice(0, at)
  const variant = remainder.slice(at + 1)
  if (modelID.length === 0 || variant.length === 0) return undefined
  return { providerID, modelID, variant }
}

// `perm:<toolId>:<ruleId>`; the rule id keeps any extra `:` it contains.
export function permItemId(tool: string, ruleId: string): string {
  return `perm:${tool}:${ruleId}`
}

export function parsePermItemId(id: string): { tool: string; ruleId: string } | undefined {
  if (!id.startsWith("perm:")) return undefined
  const rest = id.slice("perm:".length)
  const colon = rest.indexOf(":")
  if (colon === -1) return undefined
  const tool = rest.slice(0, colon)
  const ruleId = rest.slice(colon + 1)
  if (tool.length === 0 || ruleId.length === 0) return undefined
  return { tool, ruleId }
}

// Activating one model clears `active` from ONLY the same (level, agent)
// pair's other model records; other levels and agents are untouched, so at
// most one record per (level, agent) stays active. Records keep their own
// `updated` timestamps: this is a pure content flip and the store's `same`
// still detects the change. Activating the already-active record, or a target
// with no record at all, returns an identical list (an unchanged save stays a
// no-op).
export function activateModel(
  records: readonly ModelRecord[],
  address: { level: Level; agent: string | null },
  target: { providerID: string; modelID: string; variant?: string },
): ModelRecord[] {
  const scoped = (record: ModelRecord) => record.level === address.level && record.agent === address.agent
  const wanted = (record: ModelRecord) =>
    record.providerID === target.providerID && record.modelID === target.modelID && record.variant === target.variant
  const targetRecord = records.find((record) => scoped(record) && wanted(record))
  if (targetRecord === undefined) return [...records]
  const stray = records.some((record) => scoped(record) && !wanted(record) && record.active === true)
  if (targetRecord.active === true && !stray) return [...records]
  return records.map((record) => {
    if (!scoped(record)) return record
    if (wanted(record)) return { ...cleared(record), active: true as const }
    if (record.active === true) return cleared(record)
    return record
  })
}

function cleared(record: ModelRecord): ModelRecord {
  if (record.active === undefined) return record
  return {
    type: "model",
    level: record.level,
    agent: record.agent,
    providerID: record.providerID,
    modelID: record.modelID,
    ...(record.variant === undefined ? {} : { variant: record.variant }),
    updated: record.updated,
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
  readonly pin?: boolean
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

// Per-agent model selection: which provider model an agent uses. At most one
// record per (level, agent) carries `active`. `active` is `true` or omitted,
// never `false`: records cross the RPC boundary as JSON, where a
// present-but-undefined key fails validation.
export interface ModelRecord {
  readonly type: "model"
  readonly level: Level
  readonly agent: string | null
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
  readonly active?: true
  readonly updated: string
}

// One curated or mined tool permission rule. On/off reuses
// CustomizationRecord.state on a `perm:<tool>:<rule>` item address, so
// resolve() already yields `enabled` with no new logic here.
export interface RuleRecord {
  readonly type: "rule"
  readonly level: Level
  readonly agent: string | null
  readonly tool: string
  readonly id: string
  readonly label: string
  readonly patterns: readonly string[]
  readonly keywords: readonly string[]
  readonly updated: string
}

export interface Resolved {
  readonly text: string
  readonly assembled: string
  readonly enabled: boolean
  readonly pinned: boolean
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
  readonly pin?: boolean | null
  readonly acknowledged?: string | null
}

export interface ChainInput {
  readonly upstream: Item
  readonly records: readonly CustomizationRecord[]
  readonly splits: readonly SplitRecord[]
  readonly scopes: Scopes
  readonly address: Address
}

// Content-keyed sha256 cache: tree rebuilds resolve every item per agent,
// rehashing identical text thousands of times. Map preserves insertion order,
// so evicting the oldest entry bounds memory over long sessions. 2048 entries
// comfortably covers real inventories (tens of items × agents) while keeping
// worst-case retention to a few MB of text keys.
const fingerprintCacheLimit = 2048
const fingerprintCache = new Map<string, string>()

export function fingerprint(text: string): string {
  const cached = fingerprintCache.get(text)
  if (cached !== undefined) return cached
  const digest = createHash("sha256").update(text, "utf8").digest("hex")
  if (fingerprintCache.size >= fingerprintCacheLimit) {
    const oldest = fingerprintCache.keys().next()
    if (!oldest.done) fingerprintCache.delete(oldest.value)
  }
  fingerprintCache.set(text, digest)
  return digest
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

// The resolved baseline for a new text edit at one address, exported so
// initial saves and acknowledgements can use the same upstream the review
// comparison uses: whole-item text from above, or the section text resolved
// down the same chain.
export function upstreamForEdit(input: ChainInput): string {
  if (input.address.section === null) return aboveWholeText(input, wholeRecords(input))
  return aboveSectionText(input, input.address.section)
}

export function resolveResolution(
  input: ChainInput,
  resolution: Resolution,
  edited?: string,
): CustomizationRecord[] {
  const records = [...input.records]
  const index = records.findIndex((record) => sameNode(record, input.address))
  const existing = index === -1 ? undefined : records[index]
  const upstream = upstreamForEdit(input)
  const fingerprintOf = fingerprint(upstream)
  if (resolution === "keep") {
    if (existing === undefined) return records
    if (existing.acknowledged === fingerprintOf) return records
    records[index] = { ...withoutUndefined(existing), acknowledged: fingerprintOf, updated: now() }
    return records
  }
  if (resolution === "take") {
    if (existing === undefined) return records
    const dropped = withoutUndefined({ ...existing, text: undefined, basedOnText: undefined, acknowledged: undefined })
    if (dropped.text === undefined && dropped.state === undefined && dropped.pin === undefined) {
      records.splice(index, 1)
      return records
    }
    records[index] = dropped
    return records
  }
  if (edited === undefined) return records
  if (
    existing !== undefined &&
    existing.text === edited &&
    existing.acknowledged === fingerprintOf &&
    existing.basedOn === fingerprintOf &&
    existing.basedOnText === upstream
  )
    return records
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
    basedOn: fingerprintOf,
    basedOnText: upstream,
    acknowledged: fingerprintOf,
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
  scopes?: Scopes,
  splits?: readonly SplitRecord[],
): CustomizationRecord[] {
  const rest = records.filter((record) => !sameNode(record, address))
  const existing = records.find((record) => sameNode(record, address))
  const text = fields.text === undefined ? existing?.text : (fields.text ?? undefined)
  const state = fields.state === undefined ? existing?.state : (fields.state ?? undefined)
  const pin = fields.pin === undefined ? existing?.pin : (fields.pin ?? undefined)
  const acknowledged = fields.acknowledged === undefined ? existing?.acknowledged : (fields.acknowledged ?? undefined)
  if (text === undefined && state === undefined && pin === undefined) return [...rest]
  const baseline = baselineForMerge(records, address, upstream, scopes, splits)
  const next: CustomizationRecord = {
    type: "customization",
    level: address.level,
    agent: address.agent,
    item: address.item,
    section: address.section,
    ...(text === undefined ? {} : { text }),
    ...(state === undefined ? {} : { state }),
    ...(pin === undefined ? {} : { pin }),
    basedOn: existing?.basedOn ?? baseline.fingerprint,
    ...(existing?.basedOnText === undefined && text === undefined ? {} : { basedOnText: existing?.basedOnText ?? baseline.text }),
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

// The one host-sourced Code Mode classification: tools default into
// Code Mode (`packages/core/src/tool/AGENTS.md`) — only `codemode: false`
// keeps a tool on the provider's native tool list where the session context
// hook can address it. Discovery marks the item; apply routes Code Mode
// tools through deny rules and the catalog hook against the same rule.
export function isCodeModeToolEntry(tool: Pick<Tool.Info, "options">): boolean {
  return tool.options?.codemode !== false
}

// Core builds the registry id as `namespace.replaceAll(".", "_") + "_" + normalizedName`
// but the catalog path as `namespace + "." + normalizedName`, where
// `normalizedName = tool.name.replace(/[^a-zA-Z0-9_-]/g, "_")`
// (`packages/core/src/tool/runtime.ts`, `packages/core/src/codemode/tool.ts qualifiedName`).
// The registry id is therefore not reversible: derive the catalog path from the
// Item's namespace plus the normalized title (discovery fills title from the raw tool name).
export function catalogPath(item: Pick<Item, "namespace" | "title">): string {
  const normalized = item.title.replace(/[^a-zA-Z0-9_-]/g, "_")
  if (item.namespace === undefined) return normalized
  return `${item.namespace}.${normalized}`
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
  const pinWinner = chain.find((node) => at(whole, node)?.pin !== undefined)
  const text = textWinner === undefined ? input.upstream.text : (at(whole, textWinner)?.text ?? "")
  const enabled = stateWinner === undefined ? input.upstream.enabled : at(whole, stateWinner)?.state === "on"
  const pinned = pinWinner === undefined ? (input.upstream.pinned ?? false) : (at(whole, pinWinner)?.pin ?? false)
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
  const overridden = sectionOverrides(input, chain)
  const modified = own?.text !== undefined
  const source = chain.find(
    (node) => at(whole, node)?.text !== undefined || at(whole, node)?.state !== undefined || at(whole, node)?.pin !== undefined,
  )
  return {
    text,
    assembled: assembleWithOverrides(text, split, excluded, overridden),
    enabled,
    pinned,
    source: source?.level ?? "upstream",
    overriddenHere: own !== undefined && (own.text !== undefined || own.state !== undefined || own.pin !== undefined),
    modified,
    review: isReview(own, aboveWholeFingerprint(input, whole, chain)),
  }
}

function resolveSection(input: ChainInput): Resolved {
  const id = input.address.section
  if (id === null) return resolveWhole(input)
  const chain = resolutionChain(input.address, input.scopes)
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
  const winner = chain.find((node) => at(sectioned, node)?.text !== undefined)
  const upstreamSlice = definition === undefined ? "" : slice(whole.text, definition)
  const winnerText = winner === undefined ? undefined : (at(sectioned, winner)?.text ?? "")
  const text = winnerText ?? upstreamSlice
  const stateWinner = chain.find((node) => at(sectioned, node)?.state !== undefined)
  const own = at(sectioned, input.address)
  const modified = own?.text !== undefined
  return {
    text,
    assembled: text,
    enabled: stateWinner === undefined ? whole.enabled : at(sectioned, stateWinner)?.state === "on",
    pinned: whole.pinned,
    source: winner?.level ?? stateWinner?.level ?? "upstream",
    overriddenHere: own !== undefined && (own.text !== undefined || own.state !== undefined),
    modified,
    review: isReview(own, aboveSectionFingerprint(input, id)),
  }
}

function threeWaySection(input: ChainInput): ThreeWay | undefined {
  const id = input.address.section
  if (id === null) return undefined
  const own = at(sectionRecords(input, id), input.address)
  if (own?.text === undefined) return undefined
  if (own.basedOnText === undefined) return undefined
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

function aboveWholeFingerprint(
  input: ChainInput,
  whole: readonly CustomizationRecord[],
  chain?: readonly ChainNode[],
): string {
  const nodes = chain ?? resolutionChain(input.address, input.scopes)
  const above = nodes
    .slice(1)
    .map((node) => at(whole, node)?.text)
    .find((text) => text !== undefined)
  return above === undefined ? input.upstream.fingerprint : fingerprint(above)
}

function aboveSectionText(input: ChainInput, id: string): string {
  const chain = resolutionChain(input.address, input.scopes)
  const ancestor = chain
    .slice(1)
    .map((node) => sectionTextAt(input, node, id))
    .find((text) => text !== undefined)
  if (ancestor !== undefined) return ancestor
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

function resolvedUpstreamText(input: ChainInput): string {
  if (input.address.section === null) return aboveWholeText(input, wholeRecords(input))
  const id = input.address.section
  return aboveSectionText(input, id)
}

function aboveSectionFingerprint(input: ChainInput, id: string): string {
  return fingerprint(aboveSectionText(input, id))
}

// Section textOverrides compose into the whole-item assembled body. The
// winning text for each section down the chain replaces that section's
// upstream slice; exclusions still drop a parent with its children, and a
// child edit cannot resurrect an excluded parent.
function sectionOverrides(input: ChainInput, chain: readonly ChainNode[]): Map<string, string> {
  const split = resolveSplit({
    text: effectiveWholeText(input),
    title: input.upstream.title,
    splits: input.splits,
    scopes: input.scopes,
    address: input.address,
  })
  const out = new Map<string, string>()
  for (const section of split.sections) {
    const winner = chain.find((node) => sectionTextAt(input, node, section.id) !== undefined)
    if (winner === undefined) continue
    const override = sectionTextAt(input, winner, section.id)
    if (override === undefined) continue
    out.set(section.id, override)
  }
  return out
}

function sectionTextAt(input: ChainInput, node: ChainNode | Address, id: string): string | undefined {
  return sectionRecords(input, id).find((record) => record.level === node.level && record.agent === node.agent)?.text
}

function effectiveWholeText(input: ChainInput): string {
  const whole = wholeRecords(input)
  const winner = resolutionChain(input.address, input.scopes).find((node) => at(whole, node)?.text !== undefined)
  if (winner === undefined) return input.upstream.text
  return at(whole, winner)?.text ?? ""
}

function baselineForMerge(
  records: readonly CustomizationRecord[],
  address: Address,
  upstream: Pick<Item, "fingerprint" | "text">,
  scopes?: Scopes,
  splits?: readonly SplitRecord[],
): { text: string; fingerprint: string } {
  if (scopes === undefined) return { text: upstream.text, fingerprint: upstream.fingerprint }
  if (splits === undefined) return { text: upstream.text, fingerprint: upstream.fingerprint }
  const text = resolvedUpstreamText(upstreamInput(records, address, upstream, scopes, splits))
  return { text, fingerprint: fingerprint(text) }
}

function upstreamInput(
  records: readonly CustomizationRecord[],
  address: Address,
  upstream: Pick<Item, "fingerprint" | "text">,
  scopes: Scopes,
  splits: readonly SplitRecord[],
): ChainInput {
  const found = upstream as Partial<Item>
  return {
    upstream: {
      id: address.item,
      kind: found.kind ?? "system",
      group: found.group ?? "none",
      title: found.title ?? address.item,
      text: upstream.text,
      enabled: found.enabled ?? true,
      fingerprint: upstream.fingerprint,
    },
    records,
    splits,
    scopes,
    address,
  }
}

function sectionState(input: ChainInput, chain: readonly ChainNode[], id: string): "on" | "off" | undefined {
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

export interface ChainNode {
  readonly level: Level
  readonly agent: string | null
}

// Resolution chain, most specific first, resolving text and state
// independently: the first level supplying that field wins.
export function resolutionChain(address: Address, scopes: Scopes): ChainNode[] {
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
