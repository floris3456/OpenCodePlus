// Duplicate (ctrl+d, instructions_clipboard action duplicate): which rows can
// exist twice, the name a copy gets, and the stored configuration it carries.
// The writes themselves go through the existing create operations and one
// guarded layout write (tools.ts duplicateRow).
//
// A copy is independent: it never inherits a preset link from the original,
// and it carries the original's effective configuration as its own records
// (tools.ts materializes them by pasting the original onto the copy).

import { folderSlug } from "./folders.js"
import { upstreamFor } from "./inherited.js"
import { parseModelItemId, resolveModelFields, scopedTo, type PresetOrigin, type PresetRef, type RecordScope } from "./model.js"
import type { LayoutRecords } from "./ops.js"
import { isValueRow } from "./permission-catalog.js"
import { rowTeamOf, splitOf, wholeOf } from "./resolve-memo.js"
import { gateAnswer, requiresGateRecords } from "./rowlinks.js"
import { resolveModelCompactionFields } from "./model-settings.js"
import { agentsMdItemId, isAgentsFile, isModelPrompt, toolsItemId } from "./system-order.js"
import { collectSkeleton, findLazy, lazyPath, type Memo, type MemoInput } from "./tree.js"

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

/** The records an owner holds at one level, re-addressed to a new agent id: its row edits, splits, models, rules and links between its rows. */
export function ownerRecordsCopy(records: readonly StoredRow[], from: RecordScope, agent: string): StoredRow[] {
  return records.filter((record) => scopedTo(record, from)).map((record) => ({ ...record, agent }))
}

/**
 * An owner's whole configuration as its copy's own records: every row of the
 * original's tree resolved to the values it shows now (text, on/off, pin, its
 * condition), its models with their effective settings and the active one, its
 * rules, and the links between its rows. Item ids are shared, so a copy needs
 * no remapping: only the owner (level, agent, team) changes. Nothing is left
 * pointing at the original or at a preset either of them followed.
 */
export function materializedOwnerRecords(
  memo: Memo,
  source: { readonly row: string; readonly level: RecordScope["level"]; readonly agent: string | null; readonly team?: RecordScope["team"] },
  copy: { readonly level: RecordScope["level"]; readonly agent: string | null; readonly team?: RecordScope["team"] },
  updated: string,
): StoredRow[] {
  const root = findLazy(memo, source.row)
  if (root === undefined) return []
  const owner = { level: source.level, agent: source.agent, ...(source.team === undefined ? {} : { team: source.team }) }
  const target = { level: copy.level, agent: copy.agent, ...(copy.team === undefined ? {} : { team: copy.team }) }
  const out: StoredRow[] = []
  for (const row of collectSkeleton([root])) {
    const address = row.address
    if (address === undefined || address.section !== null) continue
    const item = upstreamFor(memo.ctx.items, address)
    if (item === undefined) continue
    const at = { ...target, ...(address.catalogue === undefined ? {} : { catalogue: address.catalogue }) }
    const model = parseModelItemId(address.item)
    if (model !== undefined) {
      const chain = { ...address, models: memo.ctx.models, scopes: memo.ctx.scopes }
      const fields = { ...resolveModelFields(chain, model), ...resolveModelCompactionFields(chain, model) }
      out.push({
        type: "model", ...at, ...model,
        ...Object.fromEntries(Object.entries(fields).map(([field, resolved]) => [field, resolved?.value])),
        ...(row.partial().active === true ? { active: true } : {}),
        updated,
      })
      continue
    }
    const resolved = wholeOf(memo, address.level, address.agent, item, address.catalogue, rowTeamOf(address))
    const text = item.kind === "perm" && !isValueRow(item) ? undefined : row.actions.edit ? resolved.fullText ?? resolved.text : undefined
    const state = row.actions.toggle ? (resolved.enabled ? "on" as const : "off" as const) : undefined
    const pin = row.actions.pin ? resolved.pinned : undefined
    if (text !== undefined || state !== undefined || pin !== undefined)
      out.push({
        type: "customization", ...at, item: address.item, section: null,
        ...(text === undefined ? {} : { text }),
        ...(state === undefined ? {} : { state }),
        ...(pin === undefined ? {} : { pin }),
        basedOn: item.fingerprint,
        ...(text === undefined ? {} : { basedOnText: item.text }),
        updated,
      })
    if (row.actions.split) {
      const split = splitOf(memo, address.level, address.agent, item, address.catalogue, rowTeamOf(address))
      if (split.kind === "manual")
        out.push({ type: "split", ...at, item: address.item, boundaries: split.sections.map((section) => ({ id: section.id, name: section.name, start: section.start })), updated })
    }
    // "Shown when": the copy carries the condition the original resolves to,
    // as its own gate links (rowlinks.ts).
    const gate = memo.ctx.scopes.rowlinks === undefined ? undefined : gateAnswer(memo.ctx.scopes.rowlinks, memo.ctx.scopes, address)
    if (row.actions.requires === true && gate !== undefined && gate.ids.length > 0)
      out.push(...requiresGateRecords([], { ...at }, { item: address.item, section: null }, gate.ids, updated))
  }
  // The owner's own rules (a custom rule's patterns and words) and the links
  // between its rows move to the copy; inherited ones still resolve above it.
  out.push(...memo.ctx.rules.filter((record) => scopedTo(record, owner)).map((record) => ({ ...record, ...target, updated })))
  out.push(...(memo.ctx.scopes.rowlinks ?? []).filter((record) => scopedTo(record, owner)).map((record) => ({ ...record, ...target, updated })))
  return out
}

/** A team owner's records (its settings, rules and links), re-addressed to a new team name. */
export function teamRecordsCopy(records: readonly StoredRow[], level: "project" | "global", from: string, to: string): StoredRow[] {
  return records
    .filter((record) => scopedTo(record, { level, agent: null, team: { level, team: from } }))
    .map((record) => ({ ...record, team: { level, team: to } }))
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
