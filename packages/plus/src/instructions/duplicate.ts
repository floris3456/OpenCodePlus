// Duplicate (ctrl+d, instructions_clipboard action duplicate): which rows can
// exist twice, the name a copy gets, and the stored configuration it carries.
// The writes themselves go through the existing create operations and one
// guarded layout write (tools.ts duplicateRow).

import { folderSlug } from "./folders.js"
import { scopedTo, type PresetOrigin, type PresetRef, type RecordScope } from "./model.js"
import type { LayoutRecords } from "./ops.js"
import { lazyPath, type Memo, type MemoInput } from "./tree.js"

export type DuplicateSource =
  | { readonly kind: "folder"; readonly row: string; readonly name: string; readonly parent: string; readonly siblings: readonly string[] }
  | { readonly kind: "system"; readonly row: string; readonly item: string; readonly title: string; readonly text: string; readonly models?: readonly string[] }
  | { readonly kind: "agent"; readonly row: string; readonly level: "project" | "global"; readonly scope: "project" | "global"; readonly agent: string; readonly file: boolean; readonly link?: PresetRef }
  | { readonly kind: "member"; readonly row: string; readonly level: "project" | "global"; readonly team: string; readonly agent: string; readonly link?: PresetRef }
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
    const item = memo.ctx.items.find((entry) => entry.id === row.address!.item)
    if (item?.kind === "system" && item.userSystem === true)
      return { kind: "system", row: row.id, item: item.id, title: item.title, text: item.text, ...(item.models === undefined ? {} : { models: item.models }) }
    if (item?.kind === "system") return { refusal: `"${row.label}" is built in and exists once; add your own System row with a` }
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
  if (row.kind === "team" && owner.agent === null) return { refusal: `Teams cannot be duplicated; duplicate their members, or add a team (a) from a team preset` }
  if (owner.agent === null) return { refusal: `"${row.label}" cannot be duplicated` }
  if (row.kind === "team") {
    const team = owner.team?.team
    const known = memo.ctx.teams.find((entry) => entry.level === level && entry.team === team)
    if (team === undefined || known === undefined || !known.agents.includes(owner.agent))
      return { refusal: `${owner.agent} is built into team ${team ?? ""}; only members with a file of their own can be duplicated` }
    return { kind: "member", row: row.id, level, team, agent: owner.agent, ...(owner.link === undefined ? {} : { link: owner.link }) }
  }
  const agent = owner.agent
  const source = memo.ctx.agents.find((entry) => entry.id === agent && entry.team === undefined && entry.scope === level) ?? memo.ctx.agents.find((entry) => entry.id === agent && entry.team === undefined)
  if (source?.origin === "special") return { refusal: `${agent} is a built-in Special agent and cannot be duplicated` }
  const file = source?.path !== undefined && (source.scope === "project" || source.scope === "global")
  // A built-in agent has no file to copy: its copy is a user agent created
  // from the preset it ships as (Native build, plan, …).
  const shipped = memo.ctx.listing.some((entry) => entry.ref.kind === "agent" && entry.ref.id === agent) ? { kind: "agent" as const, id: agent } : undefined
  const link = owner.link ?? (file ? undefined : shipped)
  if (!file && link === undefined) return { refusal: `${agent} is built in and has no preset to start a copy from` }
  return { kind: "agent", row: row.id, level, scope: file ? (source.scope as "project" | "global") : level, agent, file, ...(link === undefined ? {} : { link }) }
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
  if (source.kind === "agent") return copyName(source.agent, new Set(memo.ctx.agents.filter((agent) => agent.team === undefined).map((agent) => agent.id)), "-")
  if (source.kind === "member") return copyName(source.agent, new Set(memo.ctx.teams.find((entry) => entry.level === source.level && entry.team === source.team)?.agents ?? []), "-")
  const ref = source.ref
  const taken = memo.ctx.listing.filter((entry) => ref.kind === "member" ? entry.ref.kind === "member" && entry.ref.team === ref.team : entry.ref.kind === ref.kind).map((entry) => entry.ref.id)
  return copyName(ref.id, new Set(taken), "-")
}

/** A System row copy's file id: its title as a slug, made unique among the System rows (model prompts keep their `model/` prefix). */
export function systemCopyId(memo: Memo, source: Extract<DuplicateSource, { kind: "system" }>, title: string): string {
  const prefix = source.item.startsWith("system:model/") ? "model/" : ""
  const slug = folderSlug(title)
  const taken = new Set(memo.ctx.items.filter((item) => item.kind === "system").map((item) => item.id.slice("system:".length)))
  return taken.has(`${prefix}${slug}`) ? `${prefix}${copyName(slug, new Set([...taken].filter((id) => id.startsWith(prefix)).map((id) => id.slice(prefix.length))), "-")}` : `${prefix}${slug}`
}

function userSystemTitles(memo: Memo): string[] {
  return memo.ctx.items.filter((item) => item.kind === "system" && item.userSystem === true).map((item) => item.title)
}

type StoredRow = MemoInput["records"][number]

/** The records an owner holds at one level, re-addressed to a new agent id: its row edits, splits, models, rules and links between its rows. */
export function ownerRecordsCopy(records: readonly StoredRow[], from: RecordScope, agent: string): StoredRow[] {
  return records.filter((record) => scopedTo(record, from)).map((record) => ({ ...record, agent }))
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
