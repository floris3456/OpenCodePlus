// Row links (plus-1.2.0 B9–B12): one stored concept covers two behaviours.
//
// A *switch* is a durable on/off relationship between two rows, like model
// rows and teams being exclusive: turning A on saves the linked row B off in
// the same save, and B stays off until someone turns it on. `either` is
// symmetric (turning B on saves A off too); `oneway` only turns the target off
// when the primary turns on, never the other way. A switch acts one hop: the
// rows it turns off do not fire their own links (B10).
//
// A *gate* is the old `requires:` condition, now data: the target row (or a
// section of it) is sent only while the primary row is on (`shownWhenOn`), or
// only while it is off (`shownWhenOff`). Every condition of a target must hold
// (AND), exactly as `requires.ts` reads a marker list; no condition means it is
// always sent. A section's own `<!-- requires -->` marker is a shipped, i.e.
// upstream, link: the tool shows it, and a stored link (or a tombstone) at a
// level overrides it, just as a stored row override shadows an upstream row.
//
// Records inherit down the owner chain like every other record: the nearest
// level that says anything about a target decides it (its live links replace
// the levels below, and a lone tombstone masks them). Both ends of a link
// belong to one owner and level view; mixed owners never see each other.
//
// `shownAlways` is never accepted from the link tool: `requires: []` means
// "always" and migrates to it, so a level can say "sent with no condition"
// without falling back to an upstream marker.

import type { Address, Catalogue, ChainNode, Level, Scopes, TeamRef } from "./model.js"
import { resolutionChain, scopedTo } from "./model.js"

export type RowlinkType = "either" | "oneway" | "shownWhenOn" | "shownWhenOff" | "shownAlways"

/** The switch types: turning the primary on saves the connected row off. */
export const SWITCH_TYPES: readonly RowlinkType[] = ["either", "oneway"]
/** The gate types: the connected row is sent only while the primary is (not) on. */
export const GATE_TYPES: readonly RowlinkType[] = ["shownWhenOn", "shownWhenOff", "shownAlways"]

export interface RowlinkRecord {
  readonly type: "rowlink"
  readonly level: Level
  readonly agent: string | null
  readonly team?: TeamRef
  readonly catalogue?: Catalogue
  /** The primary endpoint's item id: the switch, or the gate's condition row. */
  readonly item: string
  /** The primary endpoint's section id; null means the whole row. */
  readonly section: string | null
  /** The connected endpoint's item id: switched off, or gated. */
  readonly target: string
  /** The connected endpoint's section id; null means the whole row. */
  readonly targetSection: string | null
  readonly link: RowlinkType
  /** false is a tombstone: the pair is masked at this level. Absent/true is live. */
  readonly enabled?: boolean
  readonly updated: string
}

export interface RowlinkEndpoint {
  readonly item: string
  readonly section: string | null
}

/** A pair's identity: the two endpoints, independent of the link type. */
export function rowlinkKey(record: Pick<RowlinkRecord, "item" | "section" | "target" | "targetSection">): string {
  return JSON.stringify([record.item, record.section, record.target, record.targetSection])
}

export function isGate(link: RowlinkRecord): boolean {
  return link.link === "shownWhenOn" || link.link === "shownWhenOff" || link.link === "shownAlways"
}

export function endpointOf(record: Pick<RowlinkRecord, "item" | "section">): RowlinkEndpoint {
  return { item: record.item, section: record.section }
}

export function sameEndpoint(endpoint: RowlinkEndpoint, item: string, section: string | null): boolean {
  return endpoint.item === item && endpoint.section === section
}

/** The row-id token a condition reads as (`tool:x`, `!perm:shell:git-push`), for the `requires` view. */
export function conditionToken(link: RowlinkRecord): string {
  return link.link === "shownWhenOff" ? `!${link.item}` : link.item
}

// The `requires` semantics a gate list keeps: every token must hold, `!id`
// means the row must be off, an empty list sends always. Shared with the
// migration so a migrated gate reads exactly as the marker it came from did.
export function conditionIds(links: readonly RowlinkRecord[]): string[] {
  if (links.some((link) => link.link === "shownAlways")) return []
  return links.map(conditionToken)
}

/**
 * The effective condition list for the endpoint gated by `links` at `address`,
 * or undefined when no stored link speaks for it (the caller then reads the
 * text's own marker). The nearest chain node that holds any gate link for the
 * endpoint wins entirely, matching `requires` inheritance; a node whose only
 * links are tombstones means "always".
 */
export function gatedConditions(
  links: readonly RowlinkRecord[],
  scopes: Scopes,
  address: Address,
): { readonly ids: readonly string[]; readonly from: ChainNode["from"]; readonly here: boolean } | undefined {
  const gates = links.filter(isGate)
  if (gates.length === 0) return undefined
  const chain = resolutionChain(address, scopes)
  for (const node of chain) {
    const at = gates.filter(
      (link) => link.target === address.item && link.targetSection === address.section && scopedTo(link, node),
    )
    if (at.length === 0) continue
    const live = at.filter((link) => link.enabled !== false)
    return { ids: conditionIds(live), from: node.from, here: live.some((link) => scopedTo(link, address)) }
  }
  return undefined
}

/**
 * The connected endpoints a switch turns off when `toggled` turns on. `either`
 * fires whichever end is toggled; `oneway` fires only its primary. No cascade:
 * callers write exactly these rows off and never follow their links.
 */
export function switchedOff(
  links: readonly RowlinkRecord[],
  scopes: Scopes,
  address: Address,
  toggled: RowlinkEndpoint,
): RowlinkEndpoint[] {
  const switches = links.filter((link) => link.link === "either" || link.link === "oneway")
  if (switches.length === 0) return []
  const chain = resolutionChain(address, scopes)
  const byKey = new Map<string, { link: RowlinkRecord; depth: number }>()
  for (const link of switches) {
    const depth = chain.findIndex((node) => scopedTo(link, node))
    if (depth === -1) continue
    const key = rowlinkKey(link)
    const seen = byKey.get(key)
    if (seen === undefined || depth < seen.depth) byKey.set(key, { link, depth })
  }
  return [...byKey.values()]
    .filter(({ link }) => link.enabled !== false)
    .flatMap(({ link }): RowlinkEndpoint[] => {
      const primary = link.section === null ? { item: link.item, section: null } : { item: link.item, section: link.section }
      const connected = { item: link.target, section: link.targetSection }
      if (sameEndpoint(toggled, connected.item, connected.section)) return link.link === "either" ? [primary] : []
      if (sameEndpoint(toggled, primary.item, primary.section)) return [connected]
      return []
    })
}

/** Every endpoint connected to `endpoint` by an effective switch, either direction (for the tool's view). */
export function switchPartners(
  links: readonly RowlinkRecord[],
  scopes: Scopes,
  address: Address,
  endpoint: RowlinkEndpoint,
): { readonly endpoint: RowlinkEndpoint; readonly link: RowlinkRecord }[] {
  const switches = links.filter((link) => link.link === "either" || link.link === "oneway")
  if (switches.length === 0) return []
  const chain = resolutionChain(address, scopes)
  const byKey = new Map<string, { link: RowlinkRecord; depth: number }>()
  for (const link of switches) {
    const depth = chain.findIndex((node) => scopedTo(link, node))
    if (depth === -1) continue
    const key = rowlinkKey(link)
    const seen = byKey.get(key)
    if (seen === undefined || depth < seen.depth) byKey.set(key, { link, depth })
  }
  return [...byKey.values()].flatMap(({ link }) => {
    if (link.enabled === false) return []
    const primary = { item: link.item, section: link.section }
    const connected = { item: link.target, section: link.targetSection }
    if (sameEndpoint(endpoint, primary.item, primary.section)) return [{ endpoint: connected, link }]
    if (link.link === "either" && sameEndpoint(endpoint, connected.item, connected.section)) return [{ endpoint: primary, link }]
    return []
  })
}

/** The gate links naming `endpoint` as their primary (the tool's incoming view). */
export function gateTargetsOf(
  links: readonly RowlinkRecord[],
  scopes: Scopes,
  address: Address,
  primary: RowlinkEndpoint,
): { readonly endpoint: RowlinkEndpoint; readonly link: RowlinkRecord }[] {
  const chain = resolutionChain(address, scopes)
  return links
    .filter((link) => isGate(link) && sameEndpoint(primary, link.item, link.section) && chain.some((node) => scopedTo(link, node)))
    .map((link) => ({ endpoint: { item: link.target, section: link.targetSection }, link }))
}

/**
 * The links in effect for `address`: for each endpoint pair, the nearest chain
 * node that says anything about it wins entirely (a live link, or a tombstone
 * that masks it). Used by the link tool's view and by the switch writer so one
 * answer decides what this level inherits.
 */
export function effectiveRowlinks(
  links: readonly RowlinkRecord[],
  scopes: Scopes,
  address: Address,
): { readonly live: RowlinkRecord[]; readonly masked: RowlinkRecord[] } {
  const chain = resolutionChain(address, scopes)
  const byPair = new Map<string, { link: RowlinkRecord; depth: number }>()
  for (const link of links) {
    const depth = chain.findIndex((node) => scopedTo(link, node))
    if (depth === -1) continue
    const key = rowlinkKey(link)
    const seen = byPair.get(key)
    if (seen === undefined || depth < seen.depth) byPair.set(key, { link, depth })
  }
  const live: RowlinkRecord[] = []
  const masked: RowlinkRecord[] = []
  for (const { link } of byPair.values()) {
    if (link.enabled === false) masked.push(link)
    else live.push(link)
  }
  return { live, masked }
}

/** Every effective link with `endpoint` as its primary (outgoing) or connected end (incoming). */
export function linksTouching(
  links: readonly RowlinkRecord[],
  scopes: Scopes,
  address: Address,
  endpoint: RowlinkEndpoint,
): { readonly direction: "outgoing" | "incoming"; readonly link: RowlinkRecord }[] {
  return effectiveRowlinks(links, scopes, address).live.flatMap((link) => {
    if (sameEndpoint(endpoint, link.item, link.section)) return [{ direction: "outgoing" as const, link }]
    if (sameEndpoint(endpoint, link.target, link.targetSection)) return [{ direction: "incoming" as const, link }]
    return []
  })
}


// ── the `requires` migration (B4) ─────────────────────────────────────────
//
// A customization's stored `requires` list was the pre-1.2.0 gate. Each entry
// becomes a gate link from the row it names to the customization's row (or
// section): `!id` is `shownWhenOff`, an empty list is `shownAlways`. The
// `requires` field is dropped in the same pass, so a store is never read from
// two places. Idempotent: a store with no `requires` field is returned as-is.

interface RequiresCarrier {
  readonly type: string
  readonly level: Level
  readonly agent: string | null
  readonly team?: TeamRef
  readonly catalogue?: Catalogue
  readonly item: string
  readonly section: string | null
  readonly requires?: readonly string[]
  readonly updated: string
}

export function migrateRequires<T extends { readonly type: string }>(records: readonly T[]): {
  records: T[]
  rowlinks: RowlinkRecord[]
  migrated: boolean
} {
  const rowlinks: RowlinkRecord[] = []
  let migrated = false
  const out = records.map((record): T => {
    const carrier = record as unknown as RequiresCarrier
    if (carrier.type !== "customization" || carrier.requires === undefined) return record
    migrated = true
    const owner = {
      type: "rowlink" as const,
      level: carrier.level,
      agent: carrier.agent,
      ...(carrier.team === undefined ? {} : { team: carrier.team }),
      ...(carrier.catalogue === undefined ? {} : { catalogue: carrier.catalogue }),
      target: carrier.item,
      targetSection: carrier.section,
      updated: carrier.updated,
    }
    if (carrier.requires.length === 0) {
      rowlinks.push({ ...owner, item: carrier.item, section: carrier.section, link: "shownAlways" })
    } else {
      for (const token of carrier.requires) {
        const off = token.startsWith("!")
        rowlinks.push({
          ...owner,
          item: off ? token.slice(1) : token,
          section: null,
          link: off ? "shownWhenOff" : "shownWhenOn",
        })
      }
    }
    const rest = { ...carrier }
    delete (rest as { requires?: unknown }).requires
    return rest as unknown as T
  })
  return { records: out, rowlinks, migrated }
}