// Duplicate (ctrl+d, instructions_clipboard action duplicate): which rows can
// exist twice, the name a copy gets, and the stored configuration it carries.
// The writes themselves go through the existing create operations and one
// guarded layout write (tools.ts duplicateRow).
//
// A copy holds only changes: it follows the preset its original follows (a
// built-in agent's or a shipped preset's copy follows that shipped preset)
// and carries the original's own records, re-addressed (ownerRecordsCopy).
// It is never linked to its original, and nothing it inherits is written.

import { recordIdentity } from "./delta.js"
import { folderSlug } from "./folders.js"
import { aboveActiveModelKey, presetOrigin, sameTeam, type Level, type PresetOrigin, type PresetRef, type Scopes, type TeamRef } from "./model.js"
import type { LayoutRecords } from "./ops.js"
import { rowTeamOf, wholeOf } from "./resolve-memo.js"
import { agentsMdItemId, isAgentsFile, isModelPrompt, toolsItemId } from "./system-order.js"
import { lazyPath, type Memo, type MemoInput } from "./tree.js"

export type DuplicateSource =
  | { readonly kind: "folder"; readonly row: string; readonly name: string; readonly parent: string; readonly siblings: readonly string[] }
  | { readonly kind: "system"; readonly row: string; readonly item: string; readonly title: string; readonly text: string; readonly models?: readonly string[] }
  | { readonly kind: "skill"; readonly row: string; readonly skill: string; readonly text: string; readonly scope: "project" | "global" | "defaults" | "preset"; readonly preset?: string }
  | { readonly kind: "agent"; readonly row: string; readonly level: "project" | "global"; readonly scope: "project" | "global"; readonly agent: string; readonly file: boolean }
  | { readonly kind: "member"; readonly row: string; readonly level: "project" | "global"; readonly team: string; readonly agent: string }
  | { readonly kind: "team"; readonly row: string; readonly level: "project" | "global"; readonly team: string }
  | { readonly kind: "preset"; readonly row: string; readonly ref: PresetRef; readonly origin: PresetOrigin }

/** What a row duplicates as, or why it cannot exist twice. */
export function duplicateSource(memo: Memo, rowId: string): DuplicateSource | { readonly refusal: string } {
  const path = lazyPath(memo, rowId)
  const row = path.at(-1)
  if (row === undefined) return { refusal: "That row no longer exists" }
  if (row.kind === "group" && row.id.includes(":folder:")) {
    const parent = path.at(-2)
    if (parent === undefined) return { refusal: `"${row.label}" has no category to copy it into` }
    const siblings = parent.children().filter((entry) => entry.kind === "group" && entry.id.includes(":folder:")).map((entry) => entry.label)
    return { kind: "folder", row: row.id, name: row.label, parent: parent.id, siblings }
  }
  if (row.address !== undefined) {
    if (row.kind === "section" || row.address.section !== null) return { refusal: `"${row.label}" is part of a row's text: copy it (ctrl+c) and paste it (ctrl+v) onto a text row instead` }
    const address = row.address
    const item = memo.ctx.items.find((entry) => entry.id === address.item)
    if (item?.kind === "system") {
      const refusal = systemRefusal(address.item, row.label)
      if (refusal !== undefined) return { refusal }
      // A user System row is one file for every agent: its copy carries the
      // file text and each agent's records (itemRecordsCopy).
      if (item.userSystem === true) return { kind: "system", row: row.id, item: item.id, title: item.title, text: item.text, ...(item.models === undefined ? {} : { models: item.models }) }
      // A built-in row exists in the request, not in a file: its copy is a
      // user System row with the text this owner sees now.
      const resolved = wholeOf(memo, address.level, address.agent, item, address.catalogue, rowTeamOf(address))
      return { kind: "system", row: row.id, item: item.id, title: item.title, text: resolved.fullText ?? resolved.text }
    }
    if (item?.kind === "base") return { refusal: `"${row.label}" is a base prompt: it fills the request's first slot, together with Role/persona, so it exists once` }
    if (item?.kind === "skill") {
      return {
        kind: "skill",
        row: row.id,
        skill: item.id.slice("skill:".length),
        text: item.text,
        scope: item.skillScope ?? "project",
        ...(item.skillPreset === undefined ? {} : { preset: item.skillPreset }),
      }
    }
    return { refusal: `"${row.label}" exists once for each agent: copy it (ctrl+c) and paste it (ctrl+v) onto another agent instead` }
  }
  const owner = row.owner
  if (owner === undefined && (row.kind === "agent" || row.kind === "team")) return { refusal: `Duplicate "${row.label}" at Project or Global, where agents and team members are files` }
  if (owner === undefined) return { refusal: `"${row.label}" is a fixed part of the screen and cannot be duplicated` }
  if (owner.preset !== undefined) {
    const ref = owner.preset.ref
    if (ref.kind === "member" && !memo.ctx.listing.some((entry) => entry.ref.kind === "team" && entry.ref.id === ref.team && entry.origin === "user"))
      return { refusal: `The members of the built-in team preset ${ref.team} are fixed: duplicate the team preset instead` }
    return { kind: "preset", row: row.id, ref, origin: owner.preset.origin }
  }
  if (owner.entry !== undefined) return { refusal: `"${row.label}" is a Defaults entry: it matches agents by name; add another entry with a` }
  if (owner.level !== "project" && owner.level !== "global") return { refusal: `Duplicate "${row.label}" at Project or Global, where agents and team members are files` }
  const level = owner.level
  if (row.kind === "team" && owner.agent === null) {
    const team = owner.team?.team
    if (team === undefined || !memo.ctx.teams.some((entry) => entry.level === level && entry.team === team))
      return { refusal: `"${row.label}" cannot be duplicated: it has no team of files at this level` }
    return { kind: "team", row: row.id, level, team }
  }
  if (owner.agent === null) return { refusal: `"${row.label}" cannot be duplicated` }
  if (row.kind === "team") {
    const team = owner.team?.team
    const known = memo.ctx.teams.find((entry) => entry.level === level && entry.team === team)
    if (team === undefined || known === undefined || !known.agents.includes(owner.agent))
      return { refusal: `${owner.agent} is built into team ${team ?? ""}; only members with a file of their own can be duplicated` }
    return { kind: "member", row: row.id, level, team, agent: owner.agent }
  }
  const agent = owner.agent
  const source = memo.ctx.agents.find((entry) => entry.id === agent && entry.team === undefined && entry.scope === level) ?? memo.ctx.agents.find((entry) => entry.id === agent && entry.team === undefined)
  if (source?.origin === "special") return { refusal: `${agent} is a built-in Special agent and cannot be duplicated` }
  const file = source?.path !== undefined && (source.scope === "project" || source.scope === "global")
  return { kind: "agent", row: row.id, level, scope: file ? (source.scope as "project" | "global") : level, agent, file }
}

// The System rows that cannot exist twice in the request: one part each, or
// OpenCode's own slot. Every other built-in row copies as a user System row.
function systemRefusal(item: string, label: string): string | undefined {
  if (item === "system:role") return `"${label}" is the agent's own prompt: the request carries one Role/persona`
  if (item === toolsItemId) return `"${label}" always comes first: the request has one tool definitions part`
  if (item === agentsMdItemId || isAgentsFile(item)) return `"${label}" is an AGENTS.md file: OpenCode sends them as one part, which cannot exist twice`
  if (isModelPrompt(item)) return `"${label}" is a model prompt: all model prompts fill one part of the request; add another one with a`
  return undefined
}

/** `<base> copy`, then `<base> copy 2`, … (`-copy`, `-copy-2` for ids), the first one not taken. */
export function copyName(base: string, taken: ReadonlySet<string>, separator: " " | "-"): string {
  const first = `${base}${separator}copy`
  if (!taken.has(first)) return first
  return Array.from({ length: taken.size + 1 }, (_, index) => `${first}${separator}${index + 2}`).find((name) => !taken.has(name)) ?? `${first}${separator}${taken.size + 2}`
}

/** The name a copy gets when none is given: what the rename prompt offers. */
export function duplicateName(memo: Memo, source: DuplicateSource): string {
  if (source.kind === "folder") return copyName(source.name, new Set(source.siblings), " ")
  if (source.kind === "system") return copyName(source.title, new Set(userSystemTitles(memo)), " ")
  if (source.kind === "skill") return copyName(source.skill, new Set(skillIds(memo)), "-")
  if (source.kind === "agent") return copyName(source.agent, new Set(memo.ctx.agents.filter((agent) => agent.team === undefined).map((agent) => agent.id)), "-")
  if (source.kind === "member") return copyName(source.agent, new Set(memo.ctx.teams.find((entry) => entry.level === source.level && entry.team === source.team)?.agents ?? []), "-")
  if (source.kind === "team") return copyName(source.team, new Set(memo.ctx.teams.filter((entry) => entry.level === source.level).map((entry) => entry.team)), "-")
  const ref = source.ref
  const taken = memo.ctx.listing.filter((entry) => ref.kind === "member" ? entry.ref.kind === "member" && entry.ref.team === ref.team : entry.ref.kind === ref.kind).map((entry) => entry.ref.id)
  return copyName(ref.id, new Set(taken), "-")
}

/** A System row copy's file id: its title as a slug, made unique among the System rows. */
export function systemCopyId(memo: Memo, title: string): string {
  const slug = folderSlug(title)
  const taken = new Set(memo.ctx.items.filter((item) => item.kind === "system").map((item) => item.id.slice("system:".length)))
  return taken.has(slug) ? copyName(slug, taken, "-") : slug
}

function userSystemTitles(memo: Memo): string[] {
  return memo.ctx.items.filter((item) => item.kind === "system" && item.userSystem === true).map((item) => item.title)
}

function skillIds(memo: Memo): string[] {
  return memo.ctx.items.filter((item) => item.kind === "skill").map((item) => item.id.slice("skill:".length))
}

type StoredRow = MemoInput["records"][number]

/**
 * One chain node of the original whose stored records go to one node of its
 * copy. `agent` absent matches every owner of the team (a team's copy takes
 * its team-scoped rows, its Special agents' and its members' alike); in `to`
 * it keeps each record's own.
 */
export interface NodeCopy {
  readonly from: { readonly level: Level; readonly agent?: string | null; readonly team?: TeamRef }
  readonly to: { readonly level: Level; readonly agent?: string | null; readonly team?: TeamRef }
}

/**
 * Where an agent's or a member's own records go in its copy, most specific
 * node first: a member's team-scoped node (`L/A@T`), then its own node
 * (`L/A`), then the Global node a project agent also reads when an agent of
 * that name is global. The copy has the same nodes under its own name; a
 * Global node the copy does not read (a built-in agent's copy is a project
 * file) folds into its most specific own node. A member's own rows are stored
 * per name today, so a member that keeps its name (a team's copy) already
 * shares them: those nodes map onto themselves and need nothing written.
 */
export function ownNodeCopies(
  scopes: Scopes,
  source: { readonly level: "project" | "global"; readonly agent: string; readonly team?: TeamRef },
  copy: { readonly agent: string; readonly team?: TeamRef; readonly global: boolean },
): NodeCopy[] {
  const levels = (global: boolean): Level[] => (source.level === "project" && global ? ["project", "global"] : [source.level])
  const to = levels(copy.global)
  return [
    ...(source.team === undefined || copy.team === undefined
      ? []
      : [{ from: { level: source.level, agent: source.agent, team: source.team }, to: { level: source.level, agent: copy.agent, team: copy.team } }]),
    ...levels(scopes.global.has(source.agent)).map((level) => ({
      from: { level, agent: source.agent },
      to: { level: to.includes(level) ? level : to[0]!, agent: copy.agent },
    })),
  ]
}

/**
 * The original's own records re-addressed to its copy: its row edits,
 * sections, models, rules and links between its rows, nothing it inherits.
 * Item ids are shared, so only the owner (level, agent, team) changes. Each
 * address gets one record: two of the original's nodes landing on one node of
 * the copy merge field by field with the more specific one winning, which is
 * how the chain reads them; two records at one address of one node keep the
 * first, the one the chain reads.
 */
export function ownerRecordsCopy(records: readonly StoredRow[], nodes: readonly NodeCopy[], updated: string): StoredRow[] {
  // `active`: the original node a model's active flag comes from, which a merge
  // can make another than the node of the record it lands on.
  const merged = new Map<string, { record: StoredRow; rank: number; active?: number }>()
  nodes.forEach((node, rank) => {
    if (sameNode(node.from, node.to)) return
    records.forEach((record) => {
      if (!owns(node.from, record)) return
      const next = readdressed(record, node.to, updated)
      const key = recordIdentity(next)
      const known = merged.get(key)
      const active = next.type === "model" && next.active === true ? rank : undefined
      if (known === undefined) return void merged.set(key, { record: next, rank, ...(active === undefined ? {} : { active }) })
      // A second record at one address of the same node is one the chain never reads.
      if (known.rank === rank && next.type !== "model") return
      merged.set(key, { ...known, record: mergedRecord(known.record, next), ...(known.active === undefined && active !== undefined ? { active } : {}) })
    })
  })
  // One active model per node: the most specific original node's.
  const active = new Map<string, number>()
  for (const entry of merged.values())
    if (entry.active !== undefined) {
      const owner = ownerKey(entry.record)
      active.set(owner, Math.min(active.get(owner) ?? Infinity, entry.active))
    }
  return [...merged.values()].map((entry) =>
    entry.record.type === "model" && entry.record.active === true && active.get(ownerKey(entry.record)) !== entry.active
      ? withoutKeys(entry.record, ["active", "basedOn"])
      : entry.record,
  )
}

/**
 * A copy's active models, based on what the copy inherits. An active model
 * records the one active above it (`basedOn`) to ask for review once that
 * changes; the original's records name what is above the original, and a
 * copy can inherit another (a built-in's copy reads no Global node and
 * follows the shipped preset). So each is based on what the chain above it
 * resolves now, in `memo`, the store with the copy and its link in it, as
 * activating it there would record.
 */
export function copyActiveModelsRebased(copied: readonly StoredRow[], memo: Memo, records: readonly StoredRow[], memberOf?: TeamRef): StoredRow[] {
  const models = records.filter((record) => record.type === "model")
  return copied.map((record) => {
    if (record.type !== "model" || record.active !== true || record.basedOn === undefined) return record
    const agents = memo.ctx.agents
    const upstream = agents.find((entry) => entry.id === record.agent && entry.scope === record.level)?.model ?? agents.find((entry) => entry.id === record.agent)?.model
    const basedOn = aboveActiveModelKey({
      models,
      scopes: memo.ctx.scopes,
      level: record.level,
      agent: record.agent,
      ...(record.team === undefined ? (memberOf === undefined ? {} : { memberOf }) : { team: record.team }),
      ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
      ...(upstream === undefined ? {} : { upstream }),
    })
    return basedOn === record.basedOn ? record : { ...record, basedOn }
  })
}

/** The records without any a copy's node held before (an earlier agent of that name left them): the copy starts from its original's alone. */
export function withoutCopyNodes<R extends { readonly level: Level; readonly agent: string | null; readonly team?: TeamRef }>(records: readonly R[], nodes: readonly NodeCopy[]): R[] {
  const targets = nodes.filter((node) => !sameNode(node.from, node.to)).map((node) => node.to)
  return records.filter((record) => !targets.some((to) => owns(to, record)))
}

function owns(from: NodeCopy["from"], record: { readonly level: Level; readonly agent: string | null; readonly team?: TeamRef }): boolean {
  return record.level === from.level && (from.agent === undefined || record.agent === from.agent) && sameTeam(record.team, from.team)
}

function sameNode(from: NodeCopy["from"], to: NodeCopy["to"]): boolean {
  return from.level === to.level && (to.agent === undefined || from.agent === to.agent) && sameTeam(from.team, to.team)
}

function readdressed(record: StoredRow, to: NodeCopy["to"], updated: string): StoredRow {
  return {
    ...withoutKeys(record, ["team"]),
    level: to.level,
    ...(to.agent === undefined ? {} : { agent: to.agent }),
    ...(to.team === undefined ? {} : { team: to.team }),
    updated,
  } as StoredRow
}

function ownerKey(record: StoredRow): string {
  return JSON.stringify([record.level, record.agent, record.team?.level ?? null, record.team?.team ?? null, record.catalogue ?? null])
}

// The fields that go together: a text with what it was based on, a state or
// pin with the value it was set against.
const fieldGroups = [["text", "basedOnText", "acknowledged"], ["state", "basedOnState"], ["pin", "basedOnPin"], ["requires"]] as const

// `specific` is from a more specific node of the original than `general`.
function mergedRecord(specific: StoredRow, general: StoredRow): StoredRow {
  if (specific.type === "customization" && general.type === "customization")
    return fieldGroups.reduce<StoredRow>((record, group) => {
      const own = record as unknown as Record<string, unknown>
      const other = general as unknown as Record<string, unknown>
      if (own[group[0]] !== undefined || other[group[0]] === undefined) return record
      return { ...record, ...Object.fromEntries(group.flatMap((key) => (other[key] === undefined ? [] : [[key, other[key]]]))) }
    }, specific)
  // A model row's settings are read field by field down the chain; whether it
  // is hidden is its most specific record's.
  if (specific.type === "model" && general.type === "model") {
    const filled = Object.fromEntries(Object.entries(general).filter(([key, value]) => key !== "removed" && value !== undefined && (specific as unknown as Record<string, unknown>)[key] === undefined))
    return { ...specific, ...filled }
  }
  return specific
}

function withoutKeys(record: StoredRow, keys: readonly string[]): StoredRow {
  return Object.fromEntries(Object.entries(record).filter(([key]) => !keys.includes(key))) as unknown as StoredRow
}

/**
 * The preset a copy follows: the original's own link — the nearest of its own
 * nodes, as the chain finds it — or, for a built-in agent or a shipped preset
 * that has none, the shipped preset of that name itself. A copy is never linked
 * to a user original.
 */
export function copyLink(scopes: Scopes, nodes: readonly NodeCopy[], shipped?: PresetRef): PresetRef | undefined {
  const own = nodes.map((node) => scopes.links?.find((link) => owns(node.from, link) && node.from.agent !== undefined)?.preset).find((ref) => ref !== undefined)
  if (own !== undefined) return own
  if (shipped === undefined) return undefined
  const origin = presetOrigin(scopes, shipped)
  return origin === "native" || origin === "plus" ? shipped : undefined
}

const NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]*$/

/**
 * Why a copy cannot take `name`: a name with characters an id cannot carry,
 * or one an agent already has. Agent and member copies refuse every agent's
 * name, built-in ones included, and a member's every member's at its level:
 * a member's own rows are stored per name, so it would share another's rows.
 */
export function copyNameRefusal(memo: Memo, source: DuplicateSource, name: string): string | undefined {
  if (source.kind === "folder" || source.kind === "system" || source.kind === "skill") return undefined
  const nested = source.kind === "agent" && name.split("/").every((part) => NAME.test(part))
  if (!NAME.test(name) && !nested)
    return `name.invalid: "${name}" cannot name a copy: use letters, digits, ".", "_" and "-" (no spaces)`
  if (source.kind === "agent") {
    const taken = memo.ctx.agents.find((agent) => agent.id === name && agent.team === undefined)
    if (taken !== undefined)
      return `name.taken: an agent named "${name}" exists already${taken.origin === "native" || taken.origin === "special" || taken.origin === "plus" ? " (a built-in agent)" : ""}; give the copy another name`
  }
  if (source.kind === "member") {
    const team = memo.ctx.teams.find((entry) => entry.level === source.level && entry.agents.includes(name))
    if (team !== undefined) return `name.taken: team ${team.team} has a member named "${name}" already; give the copy another name`
    if (memo.ctx.agents.some((agent) => agent.id === name && agent.team === undefined))
      return `name.taken: an agent named "${name}" exists already, and a member's own rows are stored by its name; give the copy another name`
  }
  return undefined
}

/** A team's member list order, stored for `group:team:<level>:<team>`, carried to its copy. */
export function teamLayoutCopy(layout: LayoutRecords, level: "project" | "global", from: string, to: string, updated: string): LayoutRecords {
  const scope = `group:team:${level}:${from}`
  const copy = `group:team:${level}:${to}`
  return {
    folders: layout.folders,
    orders: [...layout.orders, ...layout.orders.filter((order) => order.scope === scope).map((order) => ({ ...order, scope: copy, items: [...order.items], updated }))],
  }
}

/** Every record of a System row, for every owner, re-addressed to the copy's item; links naming it follow too. */
export function itemRecordsCopy(records: readonly StoredRow[], from: string, to: string): StoredRow[] {
  return records.flatMap((record): StoredRow[] => {
    if (record.type === "rowlink") {
      if (record.item !== from && record.target !== from) return []
      return [{ ...record, item: record.item === from ? to : record.item, target: record.target === from ? to : record.target }]
    }
    if ((record.type === "customization" || record.type === "split") && record.item === from) return [{ ...record, item: to }]
    return []
  })
}

/**
 * An owner's folders and list orders, copied to a new owner whose tab ids
 * differ only in the owner segment (`group:<level>:<owner>:<tab>`).
 */
export function ownerLayoutCopy(layout: LayoutRecords, from: string, to: string, updated: string): LayoutRecords {
  const swap = (value: string) => value.split(from).join(to)
  const folders = layout.folders.filter((folder) => folder.owner?.startsWith(from) === true).map((folder) => ({
    ...folder,
    owner: swap(folder.owner!),
    id: swap(folder.id),
    ...(folder.parent === undefined ? {} : { parent: swap(folder.parent) }),
    items: folder.items.map(swap),
    updated,
  }))
  const orders = layout.orders.filter((order) => order.scope.includes(from)).map((order) => ({ ...order, scope: swap(order.scope), items: order.items.map(swap), updated }))
  return { folders: [...layout.folders, ...folders], orders: [...layout.orders, ...orders] }
}

/** Every stored System order that lists `item` lists its copy right after it. */
export function systemOrderCopy(layout: LayoutRecords, item: string, copy: string, updated: string): LayoutRecords {
  return {
    folders: layout.folders,
    orders: layout.orders.map((order) => order.items.includes(item) && !order.items.includes(copy)
      ? { ...order, items: order.items.flatMap((entry) => (entry === item ? [entry, copy] : [entry])), updated }
      : order),
  }
}
