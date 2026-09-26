import { catalogueOf, resolve, resolveSplit } from "./model.js"
import { chainContext, presetLabels, presetListing, withOwnerRoles, type PresetEntry, type PresetState } from "./presets.js"
import type {
  Address,
  AgentSource,
  Catalogue,
  CustomizationRecord,
  EntryRecord,
  Item,
  Level,
  ModelRecord,
  Resolved,
  RuleRecord,
  Scopes,
  SplitRecord,
  TeamRef,
} from "./model.js"
import type { Split } from "./sections.js"
import type { TeamLevel } from "./teams.js"

export interface TeamInput {
  /** Teams exist at project, global and defaults; team presets are not TeamInputs. */
  readonly level: TeamLevel
  readonly team: string
  readonly enabled: boolean
  readonly agents: readonly string[]
}

/** Links, Defaults entries and user presets ride next to the inventory records: the chain reads them, no row edits them yet. */
export interface MemoInput extends PresetState {
  readonly items: readonly Item[]
  readonly records: readonly (CustomizationRecord | SplitRecord | ModelRecord | RuleRecord)[]
  readonly agents: readonly AgentSource[]
  readonly teams?: readonly TeamInput[]
}

export interface BuildContext {
  /** The inventory plus a Role/persona row for every preset and Defaults entry (presets.ts withOwnerRoles). */
  readonly items: readonly Item[]
  readonly customizations: readonly CustomizationRecord[]
  readonly splits: readonly SplitRecord[]
  readonly models: readonly ModelRecord[]
  readonly rules: readonly RuleRecord[]
  readonly scopes: Scopes
  readonly agents: readonly AgentSource[]
  readonly teams: readonly TeamInput[]
  /** Every preset, in picker order (the Presets root lists these). */
  readonly listing: readonly PresetEntry[]
  /** presetKey → label, for "from preset X". */
  readonly labels: ReadonlyMap<string, string>
  readonly entries: readonly EntryRecord[]
}

export function contextOf(input: MemoInput): BuildContext {
  const listing = presetListing(input.presets)
  return {
    items: withOwnerRoles(input.items, input),
    listing,
    labels: presetLabels(listing),
    entries: input.entries ?? [],
    customizations: input.records.filter((record): record is CustomizationRecord => record.type === "customization"),
    splits: input.records.filter((record): record is SplitRecord => record.type === "split"),
    models: input.records.filter((record): record is ModelRecord => record.type === "model"),
    rules: input.records.filter((record): record is RuleRecord => record.type === "rule"),
    scopes: chainContext({
      agents: input.agents,
      items: input.items,
      ...(input.links === undefined ? {} : { links: input.links }),
      ...(input.entries === undefined ? {} : { entries: input.entries }),
      ...(input.presets === undefined ? {} : { presets: input.presets }),
      teams: input.teams ?? [],
    }),
    agents: input.agents,
    teams: input.teams ?? [],
  }
}

export interface Memo {
  readonly ctx: BuildContext
  readonly whole: Map<string, Resolved>
  readonly section: Map<string, Resolved>
  readonly split: Map<string, Split>
  readonly flag: Map<string, boolean>
  readonly kids: Map<string, readonly unknown[]>
  readonly texts: Map<string, TextEntry>
}

export interface TextEntry {
  whole: boolean
  readonly sections: Set<string>
}

export function memoOf(ctx: BuildContext): Memo {
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

export function buildMemo(input: MemoInput): Memo {
  return memoOf(contextOf(input))
}

// One pass over customizations: review needs a stored text, or a state or pin
// that recorded the value above it (§3.6), so index which addresses have one
// and skip every resolve for addresses without.
function textIndex(ctx: BuildContext): Map<string, TextEntry> {
  const index = new Map<string, TextEntry>()
  ctx.customizations.forEach((record) => {
    if (record.text === undefined && record.basedOnState === undefined && record.basedOnPin === undefined) return
    const key = textKey(record.level, record.agent, record.item, record.catalogue, record.team)
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

export function textEntryOf(
  memo: Memo,
  level: Level,
  owner: string | null,
  item: string,
  catalogue?: Catalogue,
  team?: RowTeam,
): TextEntry | undefined {
  return memo.texts.get(textKey(level, owner, item, catalogue, ownTeam(team)))
}

/**
 * A row's team: the `TeamRef` of a team-scoped node (a member preset, a Teams
 * entry, a team's Special agent), or `{ memberOf }` for an ordinary member row
 * — resolved as a member of that team, its own records per-agent
 * (model.ts Address.memberOf).
 */
export type RowTeam = TeamRef | { readonly memberOf: TeamRef }

/** The address fields a row's team sets. */
export function teamFields(team: RowTeam | undefined): { team?: TeamRef; memberOf?: TeamRef } {
  if (team === undefined) return {}
  if ("memberOf" in team) return { memberOf: team.memberOf }
  return { team }
}

/** A row address's team, the inverse of teamFields. */
export function rowTeamOf(address: Pick<Address, "team" | "memberOf">): RowTeam | undefined {
  if (address.team !== undefined) return address.team
  if (address.memberOf !== undefined) return { memberOf: address.memberOf }
  return undefined
}

// The team of the node a row's own records sit on: a member row's own node is
// per-agent.
function ownTeam(team: RowTeam | undefined): TeamRef | undefined {
  if (team === undefined || "memberOf" in team) return undefined
  return team
}

// Index over raw records: only shared-inventory records carry a catalogue, so
// a per-agent record lands in one bucket both catalogues read. A team-scoped
// node (`L/A@T`: a member preset, a Teams entry, a team's Special agent) is a
// bucket of its own.
function textKey(level: Level, owner: string | null, item: string, catalogue: Catalogue | undefined, team: TeamRef | undefined): string {
  return JSON.stringify([level, owner, item, owner === null ? catalogueOf(catalogue) : "agents", teamKey(team)])
}

// Resolution keys always carry the catalogue: the same (level, owner, item)
// row resolves differently under Agents and Teams because the chain ends in a
// different shared inventory, so one cache entry would hand the team member
// the stand-alone answer. The team does too: `preset/planner@starter` and
// `preset/planner@mine` are different nodes.
function keyOf(
  level: Level,
  owner: string | null,
  item: string,
  section: string | null,
  catalogue: Catalogue | undefined,
  team: RowTeam | undefined,
): string {
  return JSON.stringify([level, owner, item, section, catalogueOf(catalogue), teamKey(team)])
}

function teamKey(team: RowTeam | undefined): string | null {
  if (team === undefined) return null
  if ("memberOf" in team) return `member:${team.memberOf.level}:${team.memberOf.team}`
  return `${team.level}:${team.team}`
}

function addressOf(
  level: Level,
  owner: string | null,
  item: string,
  section: string | null,
  catalogue: Catalogue | undefined,
  team: RowTeam | undefined,
): Address {
  return {
    level,
    agent: owner,
    item,
    section,
    ...teamFields(team),
    ...(catalogue === undefined ? {} : { catalogue }),
  }
}

export function wholeOf(memo: Memo, level: Level, owner: string | null, item: Item, catalogue?: Catalogue, team?: RowTeam): Resolved {
  const key = keyOf(level, owner, item.id, null, catalogue, team)
  const cached = memo.whole.get(key)
  if (cached !== undefined) return cached
  const resolved = resolve({
    upstream: item,
    records: memo.ctx.customizations,
    splits: memo.ctx.splits,
    scopes: memo.ctx.scopes,
    address: addressOf(level, owner, item.id, null, catalogue, team),
  })
  memo.whole.set(key, resolved)
  return resolved
}

export function splitOf(memo: Memo, level: Level, owner: string | null, item: Item, catalogue?: Catalogue, team?: RowTeam): Split {
  const key = keyOf(level, owner, item.id, null, catalogue, team)
  const cached = memo.split.get(key)
  if (cached !== undefined) return cached
  const whole = wholeOf(memo, level, owner, item, catalogue, team)
  const split = resolveSplit({
    text: whole.text,
    title: item.title,
    splits: memo.ctx.splits,
    scopes: memo.ctx.scopes,
    address: addressOf(level, owner, item.id, null, catalogue, team),
  })
  memo.split.set(key, split)
  return split
}

export function sectionResolveOf(
  memo: Memo,
  level: Level,
  owner: string | null,
  item: Item,
  section: string,
  catalogue?: Catalogue,
  team?: RowTeam,
): Resolved {
  const key = keyOf(level, owner, item.id, section, catalogue, team)
  const cached = memo.section.get(key)
  if (cached !== undefined) return cached
  const resolved = resolve({
    upstream: item,
    records: memo.ctx.customizations,
    splits: memo.ctx.splits,
    scopes: memo.ctx.scopes,
    address: addressOf(level, owner, item.id, section, catalogue, team),
  })
  memo.section.set(key, resolved)
  return resolved
}

// Review is false wherever no customization stores text, so those addresses
// short-circuit with no resolve call at all.
export function flagOf(
  memo: Memo,
  level: Level,
  owner: string | null,
  item: Item,
  section: string | null,
  catalogue?: Catalogue,
  team?: RowTeam,
): boolean {
  const key = keyOf(level, owner, item.id, section, catalogue, team)
  const cached = memo.flag.get(key)
  if (cached !== undefined) return cached
  const entry = memo.texts.get(textKey(level, owner, item.id, catalogue, ownTeam(team)))
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
  const flag =
    section === null
      ? wholeOf(memo, level, owner, item, catalogue, team).review
      : sectionResolveOf(memo, level, owner, item, section, catalogue, team).review
  memo.flag.set(key, flag)
  return flag
}
