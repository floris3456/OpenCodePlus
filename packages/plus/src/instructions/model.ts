import { createHash } from "node:crypto"
import type { Tool } from "@opencode/schema/tool"
import { assembleWithOverrides, derive, manual, slice, type Split } from "./sections.js"

// `preset` holds the human's edits of presets (DESIGN §1); its records live
// in the global store file.
export type Level = "defaults" | "global" | "project" | "preset"

export interface TeamRef {
  readonly level: Level
  readonly team: string
}

export function sameTeam(
  a?: TeamRef | null,
  b?: TeamRef | null,
): boolean {
  if (!a && !b) return true
  if (!a || !b) return false
  return a.level === b.level && a.team === b.team
}

// The two catalogues the tree splits into. A stand-alone agent resolves
// through the Agents catalogue's shared inventory; an agent launched as a
// team member resolves through the Teams catalogue's. Absent means "agents"
// everywhere so every record and row id written before the split keeps its
// meaning.
export type Catalogue = "agents" | "teams"

export function catalogueOf(value: Catalogue | undefined): Catalogue {
  return value ?? "agents"
}

/**
 * The catalogue an address resolves through: its own when stated, else
 * "teams" for a team-scoped address and "agents" otherwise.
 */
export function catalogueForAddress(address: { catalogue?: Catalogue; team?: TeamRef }): Catalogue {
  if (address.catalogue !== undefined) return address.catalogue
  return address.team !== undefined ? "teams" : "agents"
}

/**
 * Catalogue equality for record lookup. Only the shared inventory
 * (`agent === null`) is per catalogue: a per-agent record is one record that
 * both catalogues read, which is what keeps every pre-split row id resolving.
 */
export function catalogueMatches(
  agent: string | null,
  left: Catalogue | undefined,
  right: Catalogue | undefined,
): boolean {
  if (agent !== null) return true
  return catalogueOf(left) === catalogueOf(right)
}

/** `agent === null` means a shared-inventory row of `catalogue`. Only valid at level "defaults". */
export interface Address {
  readonly level: Level
  readonly agent: string | null
  readonly item: string
  readonly section: string | null
  readonly team?: TeamRef
  readonly catalogue?: Catalogue
  /**
   * An ordinary team member's row (Teams → <team> → <member>): the team the
   * row belongs to. The chain is the one apply runs for that member (`L/A@T`
   * first, T's link, T's Teams entries); the address's own node — what an
   * edit writes — stays the per-agent `L/A` its Agents row edits too.
   */
  readonly memberOf?: TeamRef
}

export type ItemKind = "tool" | "base" | "skill" | "system" | "mcp" | "model" | "perm" | "setting" | "compaction"
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
  /** Settings upstream from a particular team member file. */
  readonly controlTeam?: TeamRef
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
  /**
   * The agent a user-created rule row belongs to (its RuleRecord's agent).
   * Only the fallback reads it (§3.3: the agent's own rule falls back to its
   * upstream value); unlike `agents` it does not limit where the row applies.
   */
  readonly ownedBy?: string
  /** Team policy rows only: the core rules this row installs — `on` when it resolves enabled, `off` when it resolves disabled. Only team-policy-rows.ts ever sets it. */
  readonly policy?: PolicyEffects
  /** Team policy rows derived from a live run: the run whose edit scope the row expresses. Only team-policy-rows.ts ever sets it. */
  readonly runID?: string
  /** Perm rows only: the Permissions category of the tool the row is listed under (e.g. "commands", "files", "to"). */
  readonly category?: string
  /** Perm rows only: how the row is enforced. Absent means "rule": core rules on `permAction` (see permission-catalog.ts). */
  readonly permKind?: PermKind
  /** input/value/param/limit/approval rows: the input field the row reads (dotted path; `[]` walks an array). */
  readonly field?: string
  /** value rows: the literal the row allows. param rows: the value that counts as using the parameter (absent: any value). */
  readonly value?: string | number | boolean | null
  /** An allow-list row: while on it lets its patterns through a category whose fallback is off. */
  readonly allow?: boolean
  /** limit rows: what the number in the row's text caps, and what a call above it gets. */
  readonly measure?: "value" | "length" | "count"
  readonly mode?: "clamp" | "refuse"
  /** Refusal text of catalog and team rows; curated and user rules keep theirs in tool-permissions.ts and RuleRecords. */
  readonly message?: string
  /** True for a category's "Everything else" row: its patterns are the fallback the other rows refine. */
  readonly fallback?: boolean
  /** Other tool ids whose Permissions list this same row: one permission shared by several tools. */
  readonly alsoUnder?: readonly string[]
}

/**
 * How a perm row is enforced:
 * - rule: core rules on the tool's own permission resource (paths, commands, URLs, agent and skill ids).
 * - input: wildcard patterns matched against values read from the call's input (`field`).
 * - value: one allowed literal of an enumerated input field; off removes it from the schema and refuses it.
 * - param: one optional input field; off removes it from the schema and refuses a call that uses it.
 * - limit: a number (the row's text) capping an input field or a team bound; off means no cap.
 * - approval: on asks the human before the call runs; a delegated run, which nobody watches, is refused instead.
 * - env: environment variable names a shell command inherits; off strips the matching variables.
 * - team: read by the team tools themselves (who a member may delegate to, which runs it may touch, what "done" needs).
 */
export type PermKind = "rule" | "input" | "value" | "param" | "limit" | "approval" | "env" | "team"

/** One core permission rule. `ask` is a real core effect, so policy rows can carry it. */
export interface PolicyRule {
  readonly action: string
  readonly resource: string
  readonly effect: "allow" | "deny" | "ask"
  /**
   * Why this rule answers the way it does, in the words the agent should read.
   * `apply.ts` installs it onto `Permission.Rule.message`, so core sends it to
   * the model instead of the generic refusal when this rule is the one denying.
   */
  readonly message?: string
}

export interface PolicyEffects {
  readonly on: readonly PolicyRule[]
  readonly off: readonly PolicyRule[]
}

// Id forms (documented, not enforced):
// - `tool:<toolId>`
// - `base:<templateId>` (gpt|claude|muse|gemini|general)
// - `skill:<skillId>`
// - `system:role` (the agent's own prompt body = Role/persona), `system:<relativePath>`
// - `mcp:<server>`
// - `model:<providerID>/<modelID>` or `model:<providerID>/<modelID>@<variant>`
// - `perm:<toolId>:<ruleId>`

/**
 * Everything the resolution chain needs besides the records it reads
 * (DESIGN §3). `global` and `defaults` are the pre-preset scopes; the rest
 * are optional so a bare `{ global, defaults }` keeps its old meaning:
 *
 * - `native` absent means every agent falls back to its upstream value (the
 *   behaviour before presets). Present, only agents in it (and items an agent
 *   owns, and native presets) fall back to upstream; everything else is off.
 * - `links`, `entries` absent mean none; `presets` absent means no preset
 *   exists (a link to one still reads its stored `preset/…` records).
 * - `memberTeams` names the teams a member belongs to when its address
 *   carries no team (the tree addresses members by id in the Teams catalogue);
 *   Teams entries match against these names.
 */
export interface ChainContext {
  /** Agent ids that have a Global row (Global agents and the native built-ins): a project agent then also reads `global/A`. */
  readonly global: ReadonlySet<string>
  /** Agents with an exact-name Defaults node `defaults/A` (native agents shown at Defaults). */
  readonly defaults: ReadonlySet<string>
  /** Agent ids whose fallback is native/upstream (origin native or special). */
  readonly native?: ReadonlySet<string>
  readonly links?: readonly LinkRecord[]
  readonly entries?: readonly EntryRecord[]
  readonly presets?: PresetCatalog
  readonly memberTeams?: ReadonlyMap<string, readonly string[]>
}

/** Kept as the name existing callers use. */
export type Scopes = ChainContext

/** What a link points at: an agent preset, one member of a team preset, or a whole team preset. */
export type PresetRef =
  | { readonly kind: "agent"; readonly id: string }
  | { readonly kind: "member"; readonly team: string; readonly id: string }
  | { readonly kind: "team"; readonly id: string }

export type PresetOrigin = "native" | "plus" | "user"

export interface PresetInfo {
  readonly ref: PresetRef
  readonly origin: PresetOrigin
}

/** A Native/Plus preset's shipped answer for one item (or section); a field left out is not set by the preset. */
export interface ShippedValue {
  readonly text?: string
  readonly state?: "on" | "off"
  readonly pin?: boolean
}

/**
 * Every preset that exists and the content Native/Plus presets ship. Shipped
 * content is code: it is computed on read (`shipped/P` chain nodes) and never
 * stored. User presets are `PresetRecord`s; their content is ordinary records
 * at level `preset`.
 */
export interface PresetCatalog {
  readonly presets: readonly PresetInfo[]
  /** Links that ship with Native/Plus presets (a Plus team member → its Plus agent preset). A stored link of the same preset wins. */
  readonly links: readonly LinkRecord[]
  /**
   * The shipped value of `item` (`section` null = whole item) in a
   * Native/Plus preset; undefined = the preset does not set it. `upstream` is
   * the item being resolved (several items share an id, one per agent, so the
   * id alone cannot name its upstream value).
   */
  readonly shipped: (
    preset: PresetRef,
    item: string,
    section: string | null,
    upstream?: Pick<Item, "text" | "enabled" | "pinned">,
  ) => ShippedValue | undefined
  /** The shipped active model of a Native/Plus preset; undefined = none. */
  readonly model: (preset: PresetRef) => ModelRefLike | undefined
}

/**
 * "Created from preset X" (DESIGN §7). The owner is an agent (`agent`), a
 * team member (`agent` + `team`), a team (`agent: null` + `team`), a Defaults
 * entry (level defaults, `agent` = the entry name, Teams entries with
 * `team: { level: "defaults", team: <team pattern> }`) or a preset (level
 * preset). Linked means live.
 */
export interface LinkRecord {
  readonly type: "link"
  readonly level: Level
  readonly agent: string | null
  readonly team?: TeamRef
  readonly catalogue?: Catalogue
  readonly preset: PresetRef
  readonly updated: string
}

/**
 * A Defaults entry: a row named by an exact name or a wildcard pattern (§4).
 * Its level is always `defaults`; it is stored so records route like every
 * other record. A Teams entry without `team` matches every team (as `*`).
 */
export interface EntryRecord {
  readonly type: "entry"
  readonly level: "defaults"
  readonly catalogue: Catalogue
  readonly team?: string
  readonly name: string
  readonly updated: string
}

/** A user preset (Native/Plus presets are code). A member preset is `kind: "agent"` with its team preset in `team`. */
export interface PresetRecord {
  readonly type: "preset"
  readonly level: "preset"
  readonly kind: "agent" | "team"
  readonly id: string
  readonly team?: string
  readonly fields?: { readonly mode?: string; readonly description?: string }
  readonly updated: string
}

/**
 * Where a resolved value came from. `level`: the address's own nodes
 * (project/global). `preset`: a preset in the chain (`shipped` = its shipped
 * content, not the human's edits). `default`: a Defaults entry or a native
 * agent's own Defaults node. `defaults-everyone`: Defaults "for every agent".
 * `native` / `upstream` / `off`: the fallback (§3.3).
 */
export type From =
  | { readonly kind: "level"; readonly level: Level }
  | { readonly kind: "preset"; readonly id: string; readonly team?: string; readonly shipped: boolean }
  | { readonly kind: "default"; readonly name: string; readonly team?: string }
  | { readonly kind: "defaults-everyone" }
  | { readonly kind: "native" }
  | { readonly kind: "upstream" }
  | { readonly kind: "off" }

/** Which part of an own override is "to review": its text, its on/off state, or its pin (§3.6). */
export type ReviewPart = "text" | "state" | "pin"

export type AgentScope = "project" | "global" | "defaults"

export type AgentOrigin = "native" | "special" | "plus" | "user"

export interface AgentSource {
  readonly id: string
  readonly scope: AgentScope
  readonly origin?: AgentOrigin
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
  /** The chain node that supplied it; `upstream` for the agent's own model. */
  readonly from: From
  /**
   * resolveActiveModel only: the winner is the address's own active record
   * and the active model above it changed since it was set (§3.6).
   */
  readonly review?: true
}

export interface ModelInput {
  readonly models: readonly ModelRecord[]
  readonly scopes: Scopes
  readonly level: Level
  readonly agent: string | null
  readonly team?: TeamRef
  readonly catalogue?: Catalogue
  /** As Address.memberOf: resolve as a member of this team, own records stay per-agent. */
  readonly memberOf?: TeamRef
  readonly upstream?: ModelRefLike
}

/** What activating a model needs to record the active model above it (§3.6). */
export interface ModelContext {
  readonly scopes: Scopes
  readonly upstream?: ModelRefLike
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

// Union down the chain, deduplicated, most-specific source wins. Chain is
// resolutionChain order (most specific first), presets and Defaults entries
// included: the first record for a candidate names its source. A shipped
// preset contributes its shipped active model. Upstream appends last when not
// already present.
export function modelCandidates(input: ModelInput): ModelCandidate[] {
  const seen = new Map<string, ModelCandidate>()
  for (const node of modelChain(input)) {
    for (const model of modelsAt(input, node)) {
      const key = modelKey(model)
      if (seen.has(key)) continue
      seen.set(key, candidateOf(model, node.level, node.from))
    }
  }
  const upstream = upstreamCandidate(input)
  if (upstream !== undefined && !seen.has(modelKey(upstream))) seen.set(modelKey(upstream), upstream)
  return [...seen.values()]
}

// First active record down the chain (a shipped preset's model counts as
// active), else upstream. No active and no upstream means Plus installs
// nothing for this agent. The address's own active record is "to review" when
// it recorded the active model above it (`basedOn`) and that has changed.
export function resolveActiveModel(input: ModelInput): ModelCandidate | undefined {
  const chain = modelChain(input)
  for (const node of chain) {
    const winner = activeAt(input, node)
    if (winner === undefined) continue
    const own = node.shipped === undefined && scopedTo(node, ownModelScope(input))
    const review = own && winner.basedOn !== undefined && winner.basedOn !== aboveActiveModelKey(input)
    return { ...candidateOf(winner, node.level, node.from), ...(review ? { review: true as const } : {}) }
  }
  return upstreamCandidate(input)
}

/**
 * The key of the active model the chain above `input`'s own address resolves
 * now ("" when none): what `basedOn` records when a model is activated there.
 */
export function aboveActiveModelKey(input: ModelInput): string {
  const own = ownModelScope(input)
  const above = resolveActiveModel({ ...input, models: input.models.filter((record) => !scopedTo(record, own)) })
  return above === undefined ? "" : modelKey(above)
}

function modelChain(input: ModelInput): ChainNode[] {
  return resolutionChain(
    {
      level: input.level,
      agent: input.agent,
      item: "",
      section: null,
      ...(input.team !== undefined ? { team: input.team } : {}),
      ...(input.catalogue !== undefined ? { catalogue: input.catalogue } : {}),
      ...(input.memberOf !== undefined ? { memberOf: input.memberOf } : {}),
    },
    input.scopes,
  )
}

function ownModelScope(input: ModelInput): RecordScope {
  return {
    level: input.level,
    agent: input.agent,
    ...(input.team !== undefined ? { team: input.team } : {}),
    catalogue: catalogueForAddress(input),
  }
}

function modelsAt(input: ModelInput, node: ChainNode): readonly ModelRefLike[] {
  if (node.shipped === undefined) return input.models.filter((record) => scopedTo(record, node))
  const shipped = input.scopes.presets?.model(node.shipped)
  return shipped === undefined ? [] : [shipped]
}

function activeAt(input: ModelInput, node: ChainNode): (ModelRefLike & { readonly basedOn?: string }) | undefined {
  if (node.shipped === undefined) return input.models.find((record) => scopedTo(record, node) && record.active === true)
  return input.scopes.presets?.model(node.shipped)
}

function upstreamCandidate(input: ModelInput): ModelCandidate | undefined {
  if (input.agent === null || input.upstream === undefined) return undefined
  return candidateOf(input.upstream, "upstream", { kind: "upstream" })
}

function candidateOf(model: ModelRefLike, source: Level | "upstream", from: From): ModelCandidate {
  return {
    providerID: model.providerID,
    modelID: model.modelID,
    ...(model.variant === undefined ? {} : { variant: model.variant }),
    source,
    from,
  }
}

/** Everything that identifies a record's owner: level, agent, team, catalogue. */
export interface RecordScope {
  readonly level: Level
  readonly agent: string | null
  readonly team?: TeamRef
  readonly catalogue?: Catalogue
}

/**
 * The `catalogue` key a new record written at `address` carries. Only the
 * shared inventory is per catalogue, and the Agents catalogue stays keyless so
 * a record written before the split and one written after are byte-identical.
 */
export function catalogueField(address: { agent: string | null; catalogue?: Catalogue }): { catalogue?: Catalogue } {
  if (address.agent !== null) return {}
  if (catalogueOf(address.catalogue) === "agents") return {}
  return { catalogue: "teams" }
}

// A shipped chain node is virtual: its content comes from the preset catalogue
// and no stored record ever belongs to it.
export function scopedTo(record: RecordScope, address: RecordScope & { readonly shipped?: PresetRef }): boolean {
  if (address.shipped !== undefined) return false
  return (
    record.level === address.level &&
    record.agent === address.agent &&
    sameTeam(record.team, address.team) &&
    catalogueMatches(address.agent, record.catalogue, address.catalogue)
  )
}

export function hasModelRecordAt(
  models: readonly ModelRecord[],
  address: RecordScope,
  target: Pick<ModelRefLike, "providerID" | "modelID" | "variant">,
): boolean {
  return models.some(
    (record) =>
      scopedTo(record, address) &&
      record.providerID === target.providerID &&
      record.modelID === target.modelID &&
      record.variant === target.variant,
  )
}

export function hasModelActiveAt(models: readonly ModelRecord[], address: RecordScope): boolean {
  return models.some((record) => scopedTo(record, address) && record.active === true)
}

// Adding a candidate stores an inactive row; activation is a separate
// exclusive flip so adding never steals the effective model. A duplicate at
// the same address returns an identical list (an unchanged save stays a
// no-op). Records keep caller-supplied timestamps: this is pure content.
export function addModelRecord(
  models: readonly ModelRecord[],
  address: RecordScope,
  target: { providerID: string; modelID: string; variant?: string },
  updated: string,
): ModelRecord[] {
  const exists = models.some(
    (record) =>
      scopedTo(record, address) &&
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
      ...(address.team !== undefined ? { team: address.team } : {}),
      ...catalogueField(address),
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
  address: RecordScope & { readonly memberOf?: TeamRef },
  target: { providerID: string; modelID: string; variant?: string },
  updated: string,
  context?: ModelContext,
): ModelRecord[] {
  const withRow = addModelRecord(models, address, target, updated)
  return activateModel(withRow, address, target, context)
}

// "Keep" for an active-model review: the own active record re-records the
// active model above it now. No own active record returns an identical list.
export function acknowledgeActiveModel(
  models: readonly ModelRecord[],
  address: RecordScope & { readonly memberOf?: TeamRef },
  context: ModelContext,
): ModelRecord[] {
  const active = models.find((record) => scopedTo(record, address) && record.active === true)
  if (active === undefined) return [...models]
  return activateModel(models, address, active, context)
}

// Reset clears only this level's active flag, leaving candidates in place so
// the chain falls through to the next active below (or upstream). No active
// at this address returns an identical list.
export function clearModelActive(models: readonly ModelRecord[], address: RecordScope): ModelRecord[] {
  const scoped = models.some((record) => scopedTo(record, address) && record.active === true)
  if (!scoped) return [...models]
  return models.map((record) => {
    if (!scopedTo(record, address)) return record
    if (record.active === undefined) return record
    return cleared(record)
  })
}

export function removeModelRecord(
  models: readonly ModelRecord[],
  address: RecordScope,
  target: { providerID: string; modelID: string; variant?: string },
): ModelRecord[] {
  return models.filter(
    (record) =>
      !(
        scopedTo(record, address) &&
        record.providerID === target.providerID &&
        record.modelID === target.modelID &&
        record.variant === target.variant
      ),
  )
}

/**
 * { global: ids with scope "global" plus the native built-ins (they have a
 * Global row too, so their Project row reads it), defaults: ids with scope
 * "defaults", native: ids with origin native or special }. No links, entries
 * or presets: callers that have them build the full ChainContext.
 */
export function scopesOf(agents: readonly AgentSource[]): Scopes {
  const native = agents.filter((agent) => agent.origin === "native" || agent.origin === "special")
  return {
    global: new Set([
      ...agents.filter((agent) => agent.scope === "global").map((agent) => agent.id),
      ...native.filter((agent) => agent.scope === "defaults").map((agent) => agent.id),
    ]),
    defaults: new Set(agents.filter((agent) => agent.scope === "defaults").map((agent) => agent.id)),
    native: new Set(native.map((agent) => agent.id)),
  }
}

/**
 * Where an agent's runtime answer resolves: its level and the chain context.
 * A native built-in discovered at Defaults (build, plan, explore, …) has a row
 * under Project, Global and Defaults alike (tree.ts nativeAgentsForLevel), and
 * the Project row is the one this location runs, so every item and its active
 * model resolve from Project with the agent's Global and Defaults rows in the
 * chain: project → global → link → Defaults entries → defaults/A →
 * defaults/null. That is the chain the tree's Project row shows (scopesOf
 * lists these agents at Global). A context without them (a bare
 * `{ global, defaults }`) gains them here. Every other agent — a host agent
 * the tree lists under Defaults only, a team-scoped one — resolves at its own
 * level, the row it is shown on.
 */
export function runtimeScope(agent: { readonly id: string; readonly level: Level; readonly team?: TeamRef }, scopes: Scopes): { level: Level; scopes: Scopes } {
  if (agent.team !== undefined || agent.level !== "defaults") return { level: agent.level, scopes }
  if (scopes.native !== undefined && !scopes.native.has(agent.id)) return { level: agent.level, scopes }
  if (scopes.global.has(agent.id) && scopes.defaults.has(agent.id)) return { level: "project", scopes }
  return {
    level: "project",
    scopes: { ...scopes, global: new Set(scopes.global).add(agent.id), defaults: new Set(scopes.defaults).add(agent.id) },
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
// no-op). With a context the active record also stores `basedOn`, the active
// model the chain above resolves now, so a later change above raises review.
export function activateModel(
  records: readonly ModelRecord[],
  address: RecordScope & { readonly memberOf?: TeamRef },
  target: { providerID: string; modelID: string; variant?: string },
  context?: ModelContext,
): ModelRecord[] {
  const scoped = (record: ModelRecord) => scopedTo(record, address)
  const wanted = (record: ModelRecord) =>
    record.providerID === target.providerID && record.modelID === target.modelID && record.variant === target.variant
  const targetRecord = records.find((record) => scoped(record) && wanted(record))
  if (targetRecord === undefined) return [...records]
  const basedOn =
    context === undefined
      ? undefined
      : aboveActiveModelKey({
          models: records,
          scopes: context.scopes,
          level: address.level,
          agent: address.agent,
          ...(address.team !== undefined ? { team: address.team } : {}),
          ...(address.catalogue !== undefined ? { catalogue: address.catalogue } : {}),
          ...(address.memberOf !== undefined ? { memberOf: address.memberOf } : {}),
          ...(context.upstream !== undefined ? { upstream: context.upstream } : {}),
        })
  const stray = records.some((record) => scoped(record) && !wanted(record) && record.active === true)
  const recorded = basedOn === undefined || targetRecord.basedOn === basedOn
  if (targetRecord.active === true && !stray && recorded) return [...records]
  return records.map((record) => {
    if (!scoped(record)) return record
    if (wanted(record)) return { ...cleared(record), active: true as const, ...(basedOn === undefined ? {} : { basedOn }) }
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
    ...(record.team !== undefined ? { team: record.team } : {}),
    ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
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
  readonly team?: TeamRef
  /** Shared-inventory rows only (`agent === null`); absent means the Agents catalogue. */
  readonly catalogue?: Catalogue
  readonly text?: string
  readonly state?: "on" | "off"
  readonly pin?: boolean
  readonly basedOn: string
  readonly basedOnText?: string
  readonly acknowledged?: string
  /** What the chain above resolved for the state when `state` was set here (§3.6); absent = never reviewed. */
  readonly basedOnState?: "on" | "off"
  /** What the chain above resolved for the pin when `pin` was set here (§3.6); absent = never reviewed. */
  readonly basedOnPin?: boolean
  readonly updated: string
}

export interface SplitRecord {
  readonly type: "split"
  readonly level: Level
  readonly agent: string | null
  readonly item: string
  readonly team?: TeamRef
  /** Shared-inventory rows only (`agent === null`); absent means the Agents catalogue. */
  readonly catalogue?: Catalogue
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
  readonly team?: TeamRef
  /** Shared-inventory rows only (`agent === null`); absent means the Agents catalogue. */
  readonly catalogue?: Catalogue
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
  readonly active?: true
  /** Active records only: the key of the active model above when this one was activated ("" = none); absent = never reviewed. */
  readonly basedOn?: string
  readonly updated: string
}

// One curated or mined tool permission rule. On/off reuses
// CustomizationRecord.state on a `perm:<tool>:<rule>` item address, so
// resolve() already yields `enabled` with no new logic here.
export interface RuleRecord {
  readonly type: "rule"
  readonly level: Level
  readonly agent: string | null
  readonly team?: TeamRef
  /** Shared-inventory rows only (`agent === null`); absent means the Agents catalogue. */
  readonly catalogue?: Catalogue
  readonly tool: string
  readonly id: string
  readonly label: string
  readonly patterns: readonly string[]
  readonly keywords: readonly string[]
  /**
   * Why this rule refuses, in the words the model should read. `apply.ts`
   * installs it onto core's `Permission.Rule.message`, so the model receives
   * it instead of the generic refusal when this rule is the one denying.
   * Absent means the generic refusal.
   */
  readonly message?: string
  readonly updated: string
}

export interface Resolved {
  readonly text: string
  readonly assembled: string
  readonly enabled: boolean
  readonly pinned: boolean
  readonly source: Level | "upstream"
  /** Where the on/off state came from. */
  readonly from: From
  /** Where the text came from. */
  readonly textFrom: From
  /** Where the pin came from. */
  readonly pinFrom: From
  readonly overriddenHere: boolean
  readonly modified: boolean
  /** True when any part is under review (`reviewOf` is not empty). */
  readonly review: boolean
  /** Which parts of the own override are "to review". */
  readonly reviewOf: readonly ReviewPart[]
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
    .map((node) =>
      input.splits.find((split) => split.item === input.address.item && scopedTo(split, node)),
    )
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

// `only` limits keep/take to some parts under review (the TUI resolves a
// state/pin review with its own choice before the text's three-way diff);
// absent = every part.
export function resolveResolution(
  input: ChainInput,
  resolution: Resolution,
  edited?: string,
  only?: readonly ReviewPart[],
): CustomizationRecord[] {
  const records = [...input.records]
  const index = records.findIndex((record) => sameNode(record, input.address))
  const existing = index === -1 ? undefined : records[index]
  const upstream = upstreamForEdit(input)
  const fingerprintOf = fingerprint(upstream)
  const wants = (part: ReviewPart) => only === undefined || only.includes(part)
  // keep: acknowledge the text above, and let a tracked state/pin re-record
  // the value above now, so the override stays and the review clears.
  if (resolution === "keep") {
    if (existing === undefined) return records
    const state = wants("state") && existing.state !== undefined && existing.basedOnState !== undefined
    const pin = wants("pin") && existing.pin !== undefined && existing.basedOnPin !== undefined
    const above = state || pin ? resolveAbove(input, existing) : undefined
    const kept = {
      ...withoutUndefined(existing),
      ...(wants("text") ? { acknowledged: fingerprintOf } : {}),
      ...(state && above !== undefined ? { basedOnState: stateOf(above.enabled) } : {}),
      ...(pin && above !== undefined ? { basedOnPin: above.pinned } : {}),
    }
    if (
      kept.acknowledged === existing.acknowledged &&
      kept.basedOnState === existing.basedOnState &&
      kept.basedOnPin === existing.basedOnPin
    )
      return records
    records[index] = { ...kept, updated: now() }
    return records
  }
  // take: drop the parts under review so they follow the chain above again;
  // with nothing under review it drops the text, as it always has.
  if (resolution === "take") {
    if (existing === undefined) return records
    const parts = resolve(input).reviewOf.filter(wants)
    if (only !== undefined && parts.length === 0) return records
    const dropped = withoutUndefined({
      ...existing,
      ...(parts.length === 0 || parts.includes("text")
        ? { text: undefined, basedOnText: undefined, acknowledged: undefined }
        : {}),
      ...(parts.includes("state") ? { state: undefined, basedOnState: undefined } : {}),
      ...(parts.includes("pin") ? { pin: undefined, basedOnPin: undefined } : {}),
    })
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
        ...(input.address.team !== undefined ? { team: input.address.team } : {}),
        ...catalogueField(input.address),
        item: input.address.item,
        section: input.address.section,
        basedOn: "",
        updated: "",
      },
    ),
    level: input.address.level,
    agent: input.address.agent,
    ...(input.address.team !== undefined ? { team: input.address.team } : {}),
    ...catalogueField(input.address),
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

/** What merge reads of the item: its text and fingerprint, plus (when known) what the fallback needs. */
export type MergeUpstream = Pick<Item, "fingerprint" | "text"> & Partial<Item>

// With a chain context, setting `state` or `pin` also records what the chain
// above resolves for it at this moment (`basedOnState`, `basedOnPin`, §3.6);
// without one they are dropped when the field is set, as a record written
// before review of state and pin existed.
export function merge(
  records: readonly CustomizationRecord[],
  address: Address,
  fields: MergeFields,
  upstream: MergeUpstream,
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
  const setsState = fields.state !== undefined && fields.state !== null
  const setsPin = fields.pin !== undefined && fields.pin !== null
  const above =
    scopes !== undefined && (setsState || setsPin)
      ? resolve(upstreamInput(rest, address, upstream, scopes, splits ?? []))
      : undefined
  const aboveState = setsState && above !== undefined ? stateOf(above.enabled) : undefined
  const abovePin = setsPin ? above?.pinned : undefined
  const basedOnState = fields.state === undefined ? existing?.basedOnState : aboveState
  const basedOnPin = fields.pin === undefined ? existing?.basedOnPin : abovePin
  const next: CustomizationRecord = {
    type: "customization",
    level: address.level,
    agent: address.agent,
    ...(address.team !== undefined ? { team: address.team } : {}),
    ...catalogueField(address),
    item: address.item,
    section: address.section,
    ...(text === undefined ? {} : { text }),
    ...(state === undefined ? {} : { state }),
    ...(pin === undefined ? {} : { pin }),
    basedOn: existing?.basedOn ?? baseline.fingerprint,
    ...(existing?.basedOnText === undefined && text === undefined ? {} : { basedOnText: existing?.basedOnText ?? baseline.text }),
    ...(acknowledged === undefined ? {} : { acknowledged }),
    ...(state === undefined || basedOnState === undefined ? {} : { basedOnState }),
    ...(pin === undefined || basedOnPin === undefined ? {} : { basedOnPin }),
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
  prefix: { level: Level; agent: string | null; team?: TeamRef; item?: string },
): number {
  return entries
    .filter(
      (entry) =>
        entry.address.level === prefix.level &&
        entry.address.agent === prefix.agent &&
        sameTeam(entry.address.team, prefix.team) &&
        (prefix.item === undefined || entry.address.item === prefix.item),
    )
    .filter((entry) => entry.resolved.review).length
}

function resolveWhole(input: ChainInput): Resolved {
  const whole = wholeRecords(input)
  const chain = resolutionChain(input.address, input.scopes)
  const values = chain.map((node) => valueAt(input, whole, node, null))
  const textAt = values.findIndex((value) => value?.text !== undefined)
  const stateAt = values.findIndex((value) => value?.state !== undefined)
  const pinAt = values.findIndex((value) => value?.pin !== undefined)
  const sourceAt = values.findIndex(
    (value) => value?.text !== undefined || value?.state !== undefined || value?.pin !== undefined,
  )
  const fallback = fallbackOf(input)
  const text = textAt === -1 ? input.upstream.text : (values[textAt]?.text ?? "")
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
  const reviewOf = reviewParts(input, own, () => aboveWholeFingerprint(input, whole, chain))
  return {
    text,
    assembled: assembleWithOverrides(text, split, excluded, overridden),
    enabled: stateAt === -1 ? fallback.enabled : values[stateAt]?.state === "on",
    pinned: pinAt === -1 ? (input.upstream.pinned ?? false) : (values[pinAt]?.pin ?? false),
    source: sourceAt === -1 ? "upstream" : chain[sourceAt].level,
    from: stateAt === -1 ? fallback.from : chain[stateAt].from,
    textFrom: textAt === -1 ? { kind: "upstream" } : chain[textAt].from,
    pinFrom: pinAt === -1 ? { kind: "upstream" } : chain[pinAt].from,
    overriddenHere: own !== undefined && (own.text !== undefined || own.state !== undefined || own.pin !== undefined),
    modified: own?.text !== undefined,
    review: reviewOf.length > 0,
    reviewOf,
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
  const values = chain.map((node) => valueAt(input, sectioned, node, id))
  const textAt = values.findIndex((value) => value?.text !== undefined)
  const stateAt = values.findIndex((value) => value?.state !== undefined)
  const upstreamSlice = definition === undefined ? "" : slice(whole.text, definition)
  const text = textAt === -1 ? upstreamSlice : (values[textAt]?.text ?? "")
  const own = at(sectioned, input.address)
  const sourceNode = textAt === -1 ? (stateAt === -1 ? undefined : chain[stateAt]) : chain[textAt]
  const reviewOf = reviewParts(input, own, () => aboveSectionFingerprint(input, id))
  return {
    text,
    assembled: text,
    enabled: stateAt === -1 ? whole.enabled : values[stateAt]?.state === "on",
    pinned: whole.pinned,
    source: sourceNode?.level ?? "upstream",
    from: stateAt === -1 ? whole.from : chain[stateAt].from,
    textFrom: textAt === -1 ? whole.textFrom : chain[textAt].from,
    pinFrom: whole.pinFrom,
    overriddenHere: own !== undefined && (own.text !== undefined || own.state !== undefined),
    modified: own?.text !== undefined,
    review: reviewOf.length > 0,
    reviewOf,
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

// A stored node answers from its record; a shipped node from the preset
// catalogue (computed, never stored).
function valueAt(
  input: ChainInput,
  records: readonly CustomizationRecord[],
  node: ChainNode,
  section: string | null,
): ShippedValue | undefined {
  if (node.shipped === undefined) return at(records, node)
  return input.scopes.presets?.shipped(node.shipped, input.address.item, section, input.upstream)
}

// §3.3: native agents (and a team's Special agents), items the agent owns and
// Native presets fall back to the item's upstream state; everything else —
// Defaults "for every agent" included — falls back to off. A context without
// `native` keeps the pre-preset rule: everything falls back to upstream. An
// MCP server row is server configuration, not an agent's setting (apply reads
// it at Defaults for every agent only), so it keeps its upstream state.
function fallbackOf(input: ChainInput): { enabled: boolean; from: From } {
  const kind = fallbackKind(input)
  return { enabled: kind === "off" ? false : input.upstream.enabled, from: { kind } }
}

function fallbackKind(input: ChainInput): "native" | "upstream" | "off" {
  const native = input.scopes.native
  const agent = input.address.agent
  if (native === undefined) return "upstream"
  if (input.upstream.kind === "mcp") return "upstream"
  if (input.upstream.kind === "setting" || input.upstream.kind === "compaction") return "upstream"
  if (agent === null) return "off"
  if (input.address.level === "preset") {
    if (input.address.team !== undefined) return "off"
    return presetOrigin(input.scopes, { kind: "agent", id: agent }) === "native" ? "native" : "off"
  }
  if (native.has(agent)) return "native"
  if (input.upstream.agents?.includes(agent) || input.upstream.ownedBy === agent) return "upstream"
  return "off"
}

function aboveWholeText(input: ChainInput, whole: readonly CustomizationRecord[]): string {
  const above = aboveOwn(resolutionChain(input.address, input.scopes), input.address)
    .map((node) => valueAt(input, whole, node, null)?.text)
    .find((text) => text !== undefined)
  return above ?? input.upstream.text
}

function aboveWholeFingerprint(
  input: ChainInput,
  whole: readonly CustomizationRecord[],
  chain?: readonly ChainNode[],
): string {
  const above = aboveOwn(chain ?? resolutionChain(input.address, input.scopes), input.address)
    .map((node) => valueAt(input, whole, node, null)?.text)
    .find((text) => text !== undefined)
  return above === undefined ? input.upstream.fingerprint : fingerprint(above)
}

function aboveSectionText(input: ChainInput, id: string): string {
  const ancestor = aboveOwn(resolutionChain(input.address, input.scopes), input.address)
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

// The chain without the address's own node: what "above" reads. The own node
// is first except for a member row (`memberOf`), whose team-scoped node
// `L/A@T` comes before its own per-agent node.
function aboveOwn(chain: readonly ChainNode[], address: Address): ChainNode[] {
  return chain.filter((node) => node.shipped !== undefined || !scopedTo(node, address))
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
    const override = chain.map((node) => sectionTextAt(input, node, section.id)).find((text) => text !== undefined)
    if (override === undefined) continue
    out.set(section.id, override)
  }
  return out
}

function sectionTextAt(input: ChainInput, node: ChainNode, id: string): string | undefined {
  return valueAt(input, sectionRecords(input, id), node, id)?.text
}

function effectiveWholeText(input: ChainInput): string {
  const whole = wholeRecords(input)
  const text = resolutionChain(input.address, input.scopes)
    .map((node) => valueAt(input, whole, node, null)?.text)
    .find((value) => value !== undefined)
  return text ?? input.upstream.text
}

function baselineForMerge(
  records: readonly CustomizationRecord[],
  address: Address,
  upstream: MergeUpstream,
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
  upstream: MergeUpstream,
  scopes: Scopes,
  splits: readonly SplitRecord[],
): ChainInput {
  // Every field the caller knows is kept (the fallback reads `agents`,
  // `ownedBy` and the item's kind); only the missing required ones default.
  return {
    upstream: {
      ...upstream,
      id: address.item,
      kind: upstream.kind ?? "system",
      group: upstream.group ?? "none",
      title: upstream.title ?? address.item,
      enabled: upstream.enabled ?? true,
    },
    records,
    splits,
    scopes,
    address,
  }
}

function sectionState(input: ChainInput, chain: readonly ChainNode[], id: string): "on" | "off" | undefined {
  const sectioned = sectionRecords(input, id)
  return chain.map((node) => valueAt(input, sectioned, node, id)?.state).find((state) => state !== undefined)
}

// §3.6. Text: `modified` is text-only and a text override is "to review" when
// the text above moved past both `basedOn` and `acknowledged`. State and pin:
// an override that recorded the value above when it was set (`basedOnState`,
// `basedOnPin`) is "to review" when the value above now differs; records
// without them (written before) never flag.
function reviewParts(
  input: ChainInput,
  own: CustomizationRecord | undefined,
  aboveFingerprint: () => string,
): ReviewPart[] {
  if (own === undefined) return []
  const state = own.state !== undefined && own.basedOnState !== undefined
  const pin = own.pin !== undefined && own.basedOnPin !== undefined
  const above = state || pin ? resolveAbove(input, own) : undefined
  return [
    ...(isReview(own, aboveFingerprint) ? (["text"] as const) : []),
    ...(state && above !== undefined && stateOf(above.enabled) !== own.basedOnState ? (["state"] as const) : []),
    ...(pin && above !== undefined && above.pinned !== own.basedOnPin ? (["pin"] as const) : []),
  ]
}

/** The address's own record and what the chain above it resolves now: the two sides of a state/pin review (§3.6). */
export function ownAndAbove(input: ChainInput): { readonly own: CustomizationRecord; readonly above: Resolved } | undefined {
  const own = input.records.find((record) => sameNode(record, input.address))
  if (own === undefined) return undefined
  return { own, above: resolveAbove(input, own) }
}

// What the chain above `own` resolves: the same address with `own` removed.
function resolveAbove(input: ChainInput, own: CustomizationRecord): Resolved {
  return resolve({ ...input, records: input.records.filter((record) => record !== own) })
}

function isReview(own: CustomizationRecord, current: () => string): boolean {
  if (own.text === undefined) return false
  const now = current()
  if (now === own.basedOn) return false
  return now !== own.acknowledged
}

function stateOf(enabled: boolean): "on" | "off" {
  return enabled ? "on" : "off"
}

export interface ChainNode {
  readonly level: Level
  readonly agent: string | null
  readonly team?: TeamRef
  readonly catalogue?: Catalogue
  /** Virtual node carrying a Native/Plus preset's shipped content; no stored record belongs to it. */
  readonly shipped?: PresetRef
  /** What the node stands for, as shown to the human ("from preset X", "from default X"). */
  readonly from: From
}

/**
 * Resolution chain, most specific first (DESIGN §3.1); text, state, pin and
 * the active model each take the first node that sets them.
 *
 * For an agent or member A (team T optional) at project/global:
 *   1. L/A@T, L/A, global/A (L = project and a Global A exists)
 *   2. expand(nearest link among the step-1 nodes)
 *   3. matching Defaults entries, most specific first (§4) — a native agent's
 *      own Defaults node counts as an exact entry — each followed by expand(its link)
 *   4. defaults/null of the address's catalogue
 * A Defaults node `defaults/E`: defaults/E, expand(link of E), defaults/null.
 * A preset `preset/P`: expand(P), defaults/null. `defaults/null`: itself.
 * expand(P) = preset/P, shipped/P (Native and Plus only), expand(link of P);
 * a preset seen once is not expanded again, which cuts cycles. The fallback
 * after the last node is the resolver's (fallbackOf).
 */
export function resolutionChain(address: Address, scopes: Scopes): ChainNode[] {
  // A member row reads exactly the chain apply runs for the member of that
  // team; only what it writes (its own node, `L/A`) differs.
  if (address.memberOf !== undefined && address.team === undefined)
    return resolutionChain(
      {
        level: address.level,
        agent: address.agent,
        item: address.item,
        section: address.section,
        team: address.memberOf,
        catalogue: address.catalogue ?? "teams",
      },
      scopes,
    )
  const catalogue = catalogueForAddress(address)
  const visited = new Set<string>()
  const tail = address.level === "defaults" && address.agent === null ? [] : [everyone(catalogue)]
  if (address.level === "preset" && address.agent !== null) {
    const ref: PresetRef =
      address.team === undefined
        ? { kind: "agent", id: address.agent }
        : { kind: "member", team: address.team.team, id: address.agent }
    return distinct([...expand(scopes, catalogue, ref, visited), ...tail])
  }
  const own = ownNodes(address, scopes, catalogue)
  // The nearest link among the agent's own nodes, the team-scoped node first:
  // a team-less member address (the tree's) reads its team-scoped link before
  // its unscoped ones, exactly as the team-scoped address (apply's) does.
  const link = memberLink(address, scopes, catalogue) ?? own.map((node) => linkAt(scopes, node)).find((ref) => ref !== undefined)
  const linked = expand(scopes, catalogue, link, visited)
  const entries =
    address.level === "defaults"
      ? []
      : entryNodes(address, scopes, catalogue).flatMap((node) => [
          node,
          ...expand(scopes, catalogue, linkAt(scopes, node), visited),
        ])
  return distinct([...own, ...linked, ...entries, ...tail])
}

/** `*` and `%` match any run of characters (including none); the whole name must match, ignoring case. */
export function matchesName(pattern: string, name: string): boolean {
  const cached = patterns.get(pattern)
  if (cached !== undefined) return cached.test(name)
  const source = [...pattern]
    .map((char) => (char === "*" || char === "%" ? ".*" : char.replace(/[.+?^${}()|[\]\\/-]/g, "\\$&")))
    .join("")
  const compiled = new RegExp(`^${source}$`, "is")
  patterns.set(pattern, compiled)
  return compiled.test(name)
}

const patterns = new Map<string, RegExp>()

export interface EntryName {
  readonly name: string
  /** Teams entries: the team pattern (absent = every team). */
  readonly team?: string
}

/**
 * §4 order of matching Defaults entries, most specific first: an exact name
 * before a pattern, then more literal characters, then name order. Teams
 * entries: member exactness, team exactness, member literals, team literals,
 * then member and team name order.
 */
export function entrySpecificity(left: EntryName, right: EntryName): number {
  const leftTeam = left.team ?? "*"
  const rightTeam = right.team ?? "*"
  const ranked = [
    Number(wild(left.name)) - Number(wild(right.name)),
    Number(wild(leftTeam)) - Number(wild(rightTeam)),
    literals(right.name) - literals(left.name),
    literals(rightTeam) - literals(leftTeam),
    compareText(left.name.toLowerCase(), right.name.toLowerCase()),
    compareText(leftTeam.toLowerCase(), rightTeam.toLowerCase()),
    compareText(left.name, right.name),
    compareText(leftTeam, rightTeam),
  ].find((difference) => difference !== 0)
  return ranked ?? 0
}

function compareText(left: string, right: string): number {
  if (left === right) return 0
  return left < right ? -1 : 1
}

function wild(pattern: string): boolean {
  return pattern.includes("*") || pattern.includes("%")
}

function literals(pattern: string): number {
  return [...pattern].filter((char) => char !== "*" && char !== "%").length
}

function ownNodes(address: Address, scopes: Scopes, catalogue: Catalogue): ChainNode[] {
  const own: ChainNode = { level: address.level, agent: address.agent, catalogue, from: ownFrom(address.level, address.agent) }
  if (address.team === undefined) {
    if (address.level !== "project" || address.agent === null || !scopes.global.has(address.agent)) return [own]
    return [own, { level: "global", agent: address.agent, catalogue, from: { kind: "level", level: "global" } }]
  }
  const scoped: ChainNode = {
    level: address.level,
    agent: address.agent,
    team: address.team,
    catalogue,
    from: ownFrom(address.level, address.agent, address.team.team),
  }
  // A Teams entry is its own node only: it never reads the Agents entry or
  // native Defaults node that shares its member name.
  if (teamsEntry(address, scopes)) return [scoped]
  if (address.level !== "project" || address.agent === null || !scopes.global.has(address.agent)) return [scoped, own]
  return [scoped, own, { level: "global", agent: address.agent, catalogue, from: { kind: "level", level: "global" } }]
}

function ownFrom(level: Level, agent: string | null, team?: string): From {
  if (level !== "defaults") return { kind: "level", level }
  if (agent === null) return { kind: "defaults-everyone" }
  return { kind: "default", name: agent, ...(team === undefined ? {} : { team }) }
}

function teamsEntry(address: Address, scopes: Scopes): boolean {
  if (address.level !== "defaults" || address.team === undefined) return false
  const team = address.team.team
  return (scopes.entries ?? []).some(
    (entry) => entry.catalogue === "teams" && entry.name === address.agent && (entry.team ?? "*") === team,
  )
}

// §4: Agents-catalogue entries match a stand-alone agent; Teams-catalogue
// entries match a member whose team name matches the entry's team pattern.
// The native agent's own Defaults node (`scopes.defaults`) is an exact
// Agents-catalogue name; a team-scoped native agent reads it after its Teams
// entries.
function entryNodes(address: Address, scopes: Scopes, catalogue: Catalogue): ChainNode[] {
  const agent = address.agent
  if (agent === null) return []
  const entries = scopes.entries ?? []
  const own: EntryName[] = scopes.defaults.has(agent) ? [{ name: agent }] : []
  if (catalogue === "agents") {
    const named = entries.filter((entry) => entry.catalogue === "agents" && matchesName(entry.name, agent))
    return [...named.map((entry) => ({ name: entry.name })), ...own]
      .toSorted(entrySpecificity)
      .map((entry) => defaultsNode(entry, catalogue))
  }
  const teams = address.team === undefined ? (scopes.memberTeams?.get(agent) ?? []) : [address.team.team]
  const named = entries.filter(
    (entry) =>
      entry.catalogue === "teams" &&
      matchesName(entry.name, agent) &&
      teams.some((team) => matchesName(entry.team ?? "*", team)),
  )
  return [
    ...named
      .map((entry) => ({ name: entry.name, team: entry.team ?? "*" }))
      .toSorted(entrySpecificity)
      .map((entry) => defaultsNode(entry, catalogue)),
    ...own.map((entry) => defaultsNode(entry, catalogue)),
  ]
}

function defaultsNode(entry: EntryName, catalogue: Catalogue): ChainNode {
  return {
    level: "defaults",
    agent: entry.name,
    ...(entry.team === undefined ? {} : { team: { level: "defaults" as const, team: entry.team } }),
    catalogue,
    from: { kind: "default", name: entry.name, ...(entry.team === undefined ? {} : { team: entry.team }) },
  }
}

function everyone(catalogue: Catalogue): ChainNode {
  return { level: "defaults", agent: null, catalogue, from: { kind: "defaults-everyone" } }
}

function expand(scopes: Scopes, catalogue: Catalogue, ref: PresetRef | undefined, visited: Set<string>): ChainNode[] {
  if (ref === undefined || ref.kind === "team") return []
  const key = presetKey(ref)
  if (visited.has(key)) return []
  visited.add(key)
  const team = ref.kind === "member" ? ref.team : undefined
  const scope = {
    level: "preset" as const,
    agent: ref.id,
    ...(team === undefined ? {} : { team: { level: "preset" as const, team } }),
    catalogue,
  }
  const from = { kind: "preset" as const, id: ref.id, ...(team === undefined ? {} : { team }) }
  const origin = presetOrigin(scopes, ref)
  const link = linkAt(scopes, scope) ?? scopes.presets?.links.find((record) => scopedTo(record, scope))?.preset
  return [
    { ...scope, from: { ...from, shipped: false } },
    ...(origin === "native" || origin === "plus" ? [{ ...scope, shipped: ref, from: { ...from, shipped: true } }] : []),
    ...expand(scopes, catalogue, link, visited),
  ]
}

function linkAt(scopes: Scopes, node: RecordScope): PresetRef | undefined {
  return scopes.links?.find((record) => scopedTo(record, node))?.preset
}

// A member's link carries its team (`L/A@T`), but the tree addresses a member
// by id in the Teams catalogue without one. `memberTeams` names the member's
// teams, so that address reads the same team-scoped link apply reads, and
// with the same precedence: before the unscoped `L/A` and `global/A` links.
function memberLink(address: Address, scopes: Scopes, catalogue: Catalogue): PresetRef | undefined {
  const agent = address.agent
  if (agent === null || address.team !== undefined || catalogue !== "teams") return undefined
  const teams = scopes.memberTeams?.get(agent) ?? []
  return scopes.links?.find(
    (record) =>
      record.level === address.level &&
      record.agent === agent &&
      record.team !== undefined &&
      teams.includes(record.team.team),
  )?.preset
}

/** The origin of a known preset; undefined when the catalogue does not know it. */
export function presetOrigin(scopes: Scopes, ref: PresetRef): PresetOrigin | undefined {
  return scopes.presets?.presets.find((preset) => presetKey(preset.ref) === presetKey(ref))?.origin
}

/** One string per preset: `agent:<id>`, `member:<team>/<id>`, `team:<id>`. */
export function presetKey(ref: PresetRef): string {
  if (ref.kind === "member") return `member:${ref.team}/${ref.id}`
  return `${ref.kind}:${ref.id}`
}

// A node reached twice (an explicit exact entry and a native agent's own
// Defaults node, say) keeps its first, most specific place.
function distinct(nodes: readonly ChainNode[]): ChainNode[] {
  const seen = new Set<string>()
  return nodes.filter((node) => {
    const key = [
      node.shipped === undefined ? "" : presetKey(node.shipped),
      node.level,
      String(node.agent),
      node.team === undefined ? "" : `${node.team.level}:${node.team.team}`,
    ].join("\u0000")
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function at(
  records: readonly CustomizationRecord[],
  node: RecordScope & { readonly shipped?: PresetRef },
): CustomizationRecord | undefined {
  return records.find((record) => scopedTo(record, node))
}

function sameNode(
  record: { level: Level; agent: string | null; item: string; section: string | null; team?: TeamRef; catalogue?: Catalogue },
  address: Address,
): boolean {
  return record.item === address.item && record.section === address.section && scopedTo(record, address)
}

function withoutUndefined(record: CustomizationRecord): CustomizationRecord {
  return Object.fromEntries(Object.entries(record).filter(([, value]) => value !== undefined)) as CustomizationRecord
}

function now(): string {
  return new Date().toISOString()
}
