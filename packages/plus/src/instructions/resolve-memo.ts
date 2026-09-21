import { catalogueOf, resolve, resolveSplit, scopesOf } from "./model.js"
import type {
  Address,
  AgentSource,
  Catalogue,
  CustomizationRecord,
  Item,
  Level,
  ModelRecord,
  Resolved,
  RuleRecord,
  Scopes,
  SplitRecord,
} from "./model.js"
import type { Split } from "./sections.js"

export interface TeamInput {
  readonly level: Level
  readonly team: string
  readonly enabled: boolean
  readonly agents: readonly string[]
}

export interface MemoInput {
  readonly items: readonly Item[]
  readonly records: readonly (CustomizationRecord | SplitRecord | ModelRecord | RuleRecord)[]
  readonly agents: readonly AgentSource[]
  readonly teams?: readonly TeamInput[]
}

export interface BuildContext {
  readonly items: readonly Item[]
  readonly customizations: readonly CustomizationRecord[]
  readonly splits: readonly SplitRecord[]
  readonly models: readonly ModelRecord[]
  readonly rules: readonly RuleRecord[]
  readonly scopes: Scopes
  readonly agents: readonly AgentSource[]
  readonly teams: readonly TeamInput[]
}

export function contextOf(input: MemoInput): BuildContext {
  return {
    items: input.items,
    customizations: input.records.filter((record): record is CustomizationRecord => record.type === "customization"),
    splits: input.records.filter((record): record is SplitRecord => record.type === "split"),
    models: input.records.filter((record): record is ModelRecord => record.type === "model"),
    rules: input.records.filter((record): record is RuleRecord => record.type === "rule"),
    scopes: scopesOf(input.agents),
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

// One pass over customizations: review needs a stored text, so index which
// addresses have one and skip every resolve for addresses without.
function textIndex(ctx: BuildContext): Map<string, TextEntry> {
  const index = new Map<string, TextEntry>()
  ctx.customizations.forEach((record) => {
    if (record.text === undefined) return
    const key = textKey(record.level, record.agent, record.item, record.catalogue)
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
): TextEntry | undefined {
  return memo.texts.get(textKey(level, owner, item, catalogue))
}

// Index over raw records: only shared-inventory records carry a catalogue, so
// a per-agent record lands in one bucket both catalogues read.
function textKey(level: Level, owner: string | null, item: string, catalogue: Catalogue | undefined): string {
  return JSON.stringify([level, owner, item, owner === null ? catalogueOf(catalogue) : "agents"])
}

// Resolution keys always carry the catalogue: the same (level, owner, item)
// row resolves differently under Agents and Teams because the chain ends in a
// different shared inventory, so one cache entry would hand the team member
// the stand-alone answer.
function keyOf(
  level: Level,
  owner: string | null,
  item: string,
  section: string | null,
  catalogue: Catalogue | undefined,
): string {
  return JSON.stringify([level, owner, item, section, catalogueOf(catalogue)])
}

function addressOf(level: Level, owner: string | null, item: string, section: string | null, catalogue: Catalogue | undefined): Address {
  return { level, agent: owner, item, section, ...(catalogue === undefined ? {} : { catalogue }) }
}

export function wholeOf(memo: Memo, level: Level, owner: string | null, item: Item, catalogue?: Catalogue): Resolved {
  const key = keyOf(level, owner, item.id, null, catalogue)
  const cached = memo.whole.get(key)
  if (cached !== undefined) return cached
  const resolved = resolve({
    upstream: item,
    records: memo.ctx.customizations,
    splits: memo.ctx.splits,
    scopes: memo.ctx.scopes,
    address: addressOf(level, owner, item.id, null, catalogue),
  })
  memo.whole.set(key, resolved)
  return resolved
}

export function splitOf(memo: Memo, level: Level, owner: string | null, item: Item, catalogue?: Catalogue): Split {
  const key = keyOf(level, owner, item.id, null, catalogue)
  const cached = memo.split.get(key)
  if (cached !== undefined) return cached
  const whole = wholeOf(memo, level, owner, item, catalogue)
  const split = resolveSplit({
    text: whole.text,
    title: item.title,
    splits: memo.ctx.splits,
    scopes: memo.ctx.scopes,
    address: addressOf(level, owner, item.id, null, catalogue),
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
): Resolved {
  const key = keyOf(level, owner, item.id, section, catalogue)
  const cached = memo.section.get(key)
  if (cached !== undefined) return cached
  const resolved = resolve({
    upstream: item,
    records: memo.ctx.customizations,
    splits: memo.ctx.splits,
    scopes: memo.ctx.scopes,
    address: addressOf(level, owner, item.id, section, catalogue),
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
): boolean {
  const key = keyOf(level, owner, item.id, section, catalogue)
  const cached = memo.flag.get(key)
  if (cached !== undefined) return cached
  const entry = memo.texts.get(textKey(level, owner, item.id, catalogue))
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
      ? wholeOf(memo, level, owner, item, catalogue).review
      : sectionResolveOf(memo, level, owner, item, section, catalogue).review
  memo.flag.set(key, flag)
  return flag
}
