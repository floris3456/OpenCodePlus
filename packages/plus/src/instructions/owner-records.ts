// An owner's stored records moved or merged onto other owner nodes: a copy's
// (duplicate.ts) and the move of team members' own rows onto their teams
// (memberRowsPerTeam, a load migration in store.ts).

import { recordIdentity } from "./delta.js"
import { stable } from "./store.js"
import { sameTeam, type CustomizationRecord, type LinkRecord, type Level, type ModelRecord, type RuleRecord, type SplitRecord, type TeamRef } from "./model.js"
import type { RowlinkRecord } from "./rowlinks.js"

/** The records an owner node (level, agent, team) holds. */
export type OwnedRecord = CustomizationRecord | SplitRecord | ModelRecord | RuleRecord | RowlinkRecord | LinkRecord

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
 * The original's own records re-addressed to its copy: its row edits,
 * sections, models, rules and links between its rows, nothing it inherits.
 * Item ids are shared, so only the owner (level, agent, team) changes. Each
 * address gets one record: two of the original's nodes landing on one node of
 * the copy merge field by field with the more specific one winning, which is
 * how the chain reads them; two records at one address of one node keep the
 * first, the one the chain reads. `updated` undefined keeps each record's own;
 * `withSame` also reads a node that maps onto itself (the most specific one of
 * a merge in place).
 */
export function ownerRecordsCopy<R extends OwnedRecord>(records: readonly R[], nodes: readonly NodeCopy[], updated: string | undefined, withSame = false): R[] {
  // `active`: the original node a model's active flag comes from, which a merge
  // can make another than the node of the record it lands on.
  const merged = new Map<string, { record: R; rank: number; active?: number }>()
  nodes.forEach((node, rank) => {
    if (!withSame && sameNode(node.from, node.to)) return
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

/** The records without any a copy's node held before (an earlier agent of that name left them): the copy starts from its original's alone. */
export function withoutCopyNodes<R extends { readonly level: Level; readonly agent: string | null; readonly team?: TeamRef }>(records: readonly R[], nodes: readonly NodeCopy[]): R[] {
  const targets = nodes.filter((node) => !sameNode(node.from, node.to)).map((node) => node.to)
  return records.filter((record) => !targets.some((to) => owns(to, record)))
}

/** A store's teams, as the member-rows migration reads them. */
export interface MemberTeams {
  readonly level: "project" | "global"
  readonly team: string
  readonly agents: readonly string[]
}

/**
 * Team members' own rows stored with their team. Before, a member's own
 * records were its name's (`L/A`), shared with the stand-alone agent of that
 * name and every member of that name at that level. Every member gets its
 * name's records at its team-scoped node (`L/A@T`), merged under what that
 * node holds already, the way the member's chain read them (`L/A@T` before
 * `L/A`), so it resolves as before; `L/A` keeps them for the stand-alone
 * agent. A member whose name has no records is left as it is.
 */
export function memberRowsPerTeam<R extends { readonly type: string }>(records: readonly R[], teams: readonly MemberTeams[]): { readonly records: R[]; readonly migrated: boolean } {
  const owned = records.filter((record): record is R & OwnedRecord => ownedTypes.has(record.type))
  const moves = teams.flatMap((team) =>
    team.agents.flatMap((agent) => {
      const name = { level: team.level, agent }
      if (!owned.some((record) => owns(name, record))) return []
      const node = { level: team.level, agent, team: { level: team.level, team: team.team } }
      return [{ node, merged: ownerRecordsCopy(owned, [{ from: node, to: node }, { from: name, to: node }], undefined, true) }]
    }),
  )
  // Already there (a store read again before its header is marked): nothing moves.
  const changed = moves.filter((move) => !sameRecords(move.merged, owned.filter((record) => owns(move.node, record))))
  if (changed.length === 0) return { records: [...records], migrated: false }
  const kept = records.filter((record) => !ownedTypes.has(record.type) || !changed.some((move) => owns(move.node, record as unknown as OwnedRecord)))
  return { records: [...kept, ...changed.flatMap((move) => move.merged)], migrated: true }
}

function sameRecords(left: readonly OwnedRecord[], right: readonly OwnedRecord[]): boolean {
  const key = (records: readonly OwnedRecord[]) => records.map((record) => JSON.stringify(stable(record))).toSorted().join("\n")
  return key(left) === key(right)
}

const ownedTypes = new Set(["customization", "split", "model", "rule", "rowlink", "link"])

export function owns(from: NodeCopy["from"], record: { readonly level: Level; readonly agent: string | null; readonly team?: TeamRef }): boolean {
  return record.level === from.level && (from.agent === undefined || record.agent === from.agent) && sameTeam(record.team, from.team)
}

function sameNode(from: NodeCopy["from"], to: NodeCopy["to"]): boolean {
  return from.level === to.level && (to.agent === undefined || from.agent === to.agent) && sameTeam(from.team, to.team)
}

function readdressed<R extends OwnedRecord>(record: R, to: NodeCopy["to"], updated: string | undefined): R {
  return {
    ...withoutKeys(record, ["team"]),
    level: to.level,
    ...(to.agent === undefined ? {} : { agent: to.agent }),
    ...(to.team === undefined ? {} : { team: to.team }),
    ...(updated === undefined ? {} : { updated }),
  } as R
}

function ownerKey(record: OwnedRecord): string {
  return JSON.stringify([record.level, record.agent, record.team?.level ?? null, record.team?.team ?? null, "catalogue" in record ? (record.catalogue ?? null) : null])
}

// The fields that go together: a text with what it was based on, a state or
// pin with the value it was set against.
const fieldGroups = [["text", "basedOnText", "acknowledged"], ["state", "basedOnState"], ["pin", "basedOnPin"], ["requires"]] as const

// `specific` is from a more specific node of the original than `general`.
function mergedRecord<R extends OwnedRecord>(specific: R, general: R): R {
  if (specific.type === "customization" && general.type === "customization")
    return fieldGroups.reduce<R>((record, group) => {
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

function withoutKeys<R>(record: R, keys: readonly string[]): R {
  return Object.fromEntries(Object.entries(record as object).filter(([key]) => !keys.includes(key))) as R
}
