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

import type { Address, Catalogue, ChainNode, From, Level, Scopes, TeamRef } from "./model.js"
import { catalogueForAddress, resolutionChain, sameTeam, scopedTo } from "./model.js"

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

/** Two addresses in the same owner/level view (B11): both ends of a link must share it. */
export function sameOwnerView(left: Address, right: Address): boolean {
  return (
    left.level === right.level &&
    left.agent === right.agent &&
    sameTeam(left.team, right.team) &&
    sameTeam(left.memberOf, right.memberOf) &&
    catalogueForAddress(left) === catalogueForAddress(right)
  )
}

/** The stored view of one effective link: the wire shape the link tool reports. */
export interface RowlinkView {
  readonly direction: "outgoing" | "incoming"
  /** The primary endpoint (the switch, or the gate's condition row). */
  readonly item: string
  readonly section: string | null
  /** The connected endpoint (switched off, or gated). */
  readonly target: string
  readonly targetSection: string | null
  readonly type: RowlinkType
  /** false is a tombstone that masks the pair at its level. */
  readonly enabled: boolean
  readonly level: Level
  readonly agent: string | null
  readonly team?: TeamRef
  readonly catalogue?: Catalogue
  /** True for a shipped `<!-- requires -->` marker link read from the target's text. */
  readonly shipped: boolean
  /** Where a shipped pair is grounded; one of the row's chain levels, or "text". */
  readonly from: From | "text"
  readonly updated: string
}

function viewOf(link: RowlinkRecord, from: From | "text", shipped: boolean): Omit<RowlinkView, "direction"> {
  return {
    item: link.item,
    section: link.section,
    target: link.target,
    targetSection: link.targetSection,
    type: link.link,
    enabled: link.enabled !== false,
    level: link.level,
    agent: link.agent,
    ...(link.team === undefined ? {} : { team: link.team }),
    ...(link.catalogue === undefined ? {} : { catalogue: link.catalogue }),
    shipped,
    from,
    updated: link.updated,
  }
}

/**
 * Every effective link touching `endpoint`, as the tool's inspect view reports
 * it: stored links (a tombstone still reported, marked disabled) plus the
 * shipped `<!-- requires -->` marker links on the endpoint's own text, so
 * inspect and request assembly give the same effective answer (B43). The
 * internal replacement barrier never appears as a user link.
 */
export function rowlinkView(
  links: readonly RowlinkRecord[],
  scopes: Scopes,
  address: Address,
  endpoint: RowlinkEndpoint,
  markerIds: readonly string[] = [],
): RowlinkView[] {
  const visible = links.filter((link) => !isReplacementBarrier(link))
  const { live, masked } = effectiveRowlinks(visible, scopes, address)
  const chain = resolutionChain(address, scopes)
  const fromOf = (link: RowlinkRecord): From | "text" => chain.find((node) => scopedTo(link, node))?.from ?? { kind: "upstream" }
  const stored = [...live, ...masked].flatMap((link): RowlinkView[] => {
    const direction = sameEndpoint(endpoint, link.item, link.section)
      ? "outgoing"
      : sameEndpoint(endpoint, link.target, link.targetSection)
        ? "incoming"
        : undefined
    if (direction === undefined) return []
    return [{ direction, ...viewOf(link, fromOf(link), false) }]
  })
  const shipped = markerView(markerIds, endpoint, live, masked)
  return [...stored, ...shipped]
}

// The shipped marker pairs of an inspected endpoint: each marker id is an
// incoming condition on the endpoint unless a stored live/tombstone pair
// already speaks for that exact pair.
function markerView(
  markerIds: readonly string[],
  endpoint: RowlinkEndpoint,
  live: readonly RowlinkRecord[],
  masked: readonly RowlinkRecord[],
): RowlinkView[] {
  if (markerIds.length === 0) return []
  const covered = new Set([...live, ...masked].map((link) => rowlinkKey(link)))
  return markerIds.flatMap((raw): RowlinkView[] => {
    const off = raw.startsWith("!")
    const bare = off ? raw.slice(1) : raw
    const key = JSON.stringify([bare, null, endpoint.item, endpoint.section])
    if (covered.has(key)) return []
    return [
      {
        direction: "incoming",
        item: bare,
        section: null,
        target: endpoint.item,
        targetSection: endpoint.section,
        type: off ? "shownWhenOff" : "shownWhenOn",
        enabled: true,
        level: "defaults",
        agent: null,
        shipped: true,
        from: "text",
        updated: "",
      },
    ]
  })
}

/**
 * The new link list after upserting the pair `primary`↔`target` at `address`.
 * Any record this same level already holds for the pair is replaced, so the
 * pair stays one record and the change is a single upsert in the delta write.
 * `enabled === false` stores a tombstone, which masks an upstream link of the
 * same pair at this level.
 */
export function writeRowlink(
  links: readonly RowlinkRecord[],
  address: { readonly level: Level; readonly agent: string | null; readonly team?: TeamRef; readonly catalogue?: Catalogue },
  primary: RowlinkEndpoint,
  target: RowlinkEndpoint,
  link: RowlinkType,
  enabled: boolean | undefined,
  updated: string,
): RowlinkRecord[] {
  const record: RowlinkRecord = {
    type: "rowlink",
    level: address.level,
    agent: address.agent,
    ...(address.team === undefined ? {} : { team: address.team }),
    ...(address.catalogue === undefined ? {} : { catalogue: address.catalogue }),
    item: primary.item,
    section: primary.section,
    target: target.item,
    targetSection: target.section,
    link,
    ...(enabled === false ? { enabled: false } : {}),
    updated,
  }
  const key = rowlinkKey(record)
  return [...links.filter((existing) => !(scopedTo(existing, address) && rowlinkKey(existing) === key)), record]
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

/** One effective gate pair: the primary condition row and the gated endpoint. */
export interface GatePair {
  readonly item: string
  readonly section: string | null
  readonly target: string
  readonly targetSection: string | null
  readonly link: RowlinkType
  readonly enabled: boolean
  /** True for a shipped `<!-- requires -->` marker read from the target's own text. */
  readonly shipped: boolean
}

/** The effective gate answer for one endpoint: the condition ids and provenance. */
export interface GateAnswer {
  readonly ids: readonly string[]
  readonly from: ChainNode["from"] | "text"
  readonly here: boolean
  /** A target-local replacement barrier defines the whole list at its level. */
  readonly barrier: boolean
  /** Every effective pair, lowest level first; shipped marker pairs included. */
  readonly pairs: readonly GatePair[]
}

// A target-local replacement barrier (the migrated `requires` list or
// `set({requires})`): a `shownAlways` link whose two endpoints are the target
// itself. It says "this level defines the whole condition list; do not AND in
// anything inherited or shipped below". It is not a public link type and never
// shows as a user link.
export function isReplacementBarrier(link: RowlinkRecord): boolean {
  return (
    link.link === "shownAlways" &&
    link.item === link.target &&
    link.section === link.targetSection
  )
}

function barrierOf(link: RowlinkRecord, item: string, section: string | null): boolean {
  return isReplacementBarrier(link) && link.item === item && link.section === section
}

function sameGateTarget(link: RowlinkRecord, item: string, section: string | null): boolean {
  return link.target === item && link.targetSection === section
}

// The shipped `<!-- requires -->` marker conditions for the endpoint, as pairs.
function markerPairs(
  ids: readonly string[],
  item: string,
  section: string | null,
): { readonly key: string; readonly id: string; readonly pair: GatePair }[] {
  return ids.map((raw) => {
    const off = raw.startsWith("!")
    const bare = off ? raw.slice(1) : raw
    return {
      key: JSON.stringify([bare, null, item, section]),
      id: raw,
      pair: {
        item: bare,
        section: null,
        target: item,
        targetSection: section,
        link: off ? "shownWhenOff" : "shownWhenOn",
        enabled: true,
        shipped: true,
      },
    }
  })
}

function pairOfStored(link: RowlinkRecord): GatePair {
  return {
    item: link.item,
    section: link.section,
    target: link.target,
    targetSection: link.targetSection,
    link: link.link,
    enabled: link.enabled !== false,
    shipped: false,
  }
}

/**
 * The effective gate answer for the endpoint at `address`: for each directed
 * pair, the nearest chain node that says anything about it decides (a live
 * gate, or a tombstone that masks it), so a nearer pair override/tombstone
 * never erases unrelated inherited gates on the same target. A target-local
 * replacement barrier masks everything below. Shipped `markerIds` (the
 * target's own `<!-- requires -->` line) AND in with the stored pairs unless a
 * stored tombstone masks that exact pair. Undefined when nothing at all speaks
 * for the endpoint, so the caller reads the text's own marker.
 */
export function gateAnswer(
  links: readonly RowlinkRecord[],
  scopes: Scopes,
  address: Address,
  markerIds: readonly string[] = [],
): GateAnswer | undefined {
  const item = address.item
  const section = address.section
  const gates = links.filter(isGate)
  const marker = markerPairs(markerIds, item, section)
  if (gates.length === 0 && marker.length === 0) return undefined
  const chain = resolutionChain(address, scopes)
  // A live barrier at the nearest level that holds one defines the whole list.
  for (const node of chain) {
    const barrier = gates.find((link) => scopedTo(link, node) && barrierOf(link, item, section))
    if (barrier === undefined || barrier.enabled === false) continue
    const list = gates.filter(
      (link) =>
        !barrierOf(link, item, section) && sameGateTarget(link, item, section) && link.enabled !== false && scopedTo(link, node),
    )
    return {
      ids: conditionIds(list),
      from: node.from,
      here: scopedTo(barrier, address),
      barrier: true,
      pairs: list.map(pairOfStored),
    }
  }
  const byPair = new Map<string, { readonly link: RowlinkRecord; readonly depth: number }>()
  for (const link of gates) {
    if (barrierOf(link, item, section) || !sameGateTarget(link, item, section)) continue
    const depth = chain.findIndex((node) => scopedTo(link, node))
    if (depth === -1) continue
    const key = rowlinkKey(link)
    const seen = byPair.get(key)
    if (seen === undefined || depth < seen.depth) byPair.set(key, { link, depth })
  }
  const entries = [...byPair.values()]
  const live = entries.filter((entry) => entry.link.enabled !== false)
  const masked = entries.filter((entry) => entry.link.enabled === false)
  const maskedKeys = new Set(masked.map((entry) => rowlinkKey(entry.link)))
  const shipped = marker.filter((pair) => !maskedKeys.has(pair.key))
  if (live.length === 0 && masked.length === 0 && shipped.length === 0) return undefined
  const nearest = live.reduce<{ readonly link: RowlinkRecord; readonly depth: number } | undefined>(
    (best, entry) => (best === undefined || entry.depth < best.depth ? entry : best),
    undefined,
  )
  const from: ChainNode["from"] | "text" =
    nearest === undefined ? (masked.length > 0 ? chain[masked[0]!.depth]!.from : "text") : chain[nearest.depth]!.from
  return {
    ids: conditionIds(live.map((entry) => entry.link)).concat(shipped.map((pair) => pair.id)),
    from,
    here: live.some((entry) => scopedTo(entry.link, address)),
    barrier: false,
    pairs: [...live.map((entry) => pairOfStored(entry.link)), ...shipped.map((pair) => pair.pair)],
  }
}

/** The stored-only gate summary, kept for callers that do not read a text marker. */
export function gatedConditions(
  links: readonly RowlinkRecord[],
  scopes: Scopes,
  address: Address,
): { readonly ids: readonly string[]; readonly from: ChainNode["from"] | "text"; readonly here: boolean } | undefined {
  const answer = gateAnswer(links, scopes, address)
  if (answer === undefined) return undefined
  return { ids: answer.ids, from: answer.from, here: answer.here }
}

/**
 * The rowlinks after the legacy `set({requires})` adapter: non-null replaces
 * the target's condition list at this level (a target-local barrier plus one
 * gate per id; `[]` is barrier only, meaning always), null removes every local
 * gate for the target so the level above decides again. Only the target is
 * touched: links the link tool stored for other pairs stay.
 */
export function requiresGateRecords(
  links: readonly RowlinkRecord[],
  address: { readonly level: Level; readonly agent: string | null; readonly team?: TeamRef; readonly catalogue?: Catalogue },
  target: RowlinkEndpoint,
  ids: readonly string[] | null,
  updated: string,
): RowlinkRecord[] {
  const local = (link: RowlinkRecord): boolean =>
    scopedTo(link, address) && isGate(link) && sameGateTarget(link, target.item, target.section)
  const rest = links.filter((link) => !local(link))
  if (ids === null) return rest
  const barrier: RowlinkRecord = {
    type: "rowlink",
    level: address.level,
    agent: address.agent,
    ...(address.team === undefined ? {} : { team: address.team }),
    ...(address.catalogue === undefined ? {} : { catalogue: address.catalogue }),
    item: target.item,
    section: target.section,
    target: target.item,
    targetSection: target.section,
    link: "shownAlways",
    updated,
  }
  return [
    ...rest,
    barrier,
    ...ids.map(
      (token): RowlinkRecord => ({
        ...barrier,
        item: token.startsWith("!") ? token.slice(1) : token,
        section: null,
        link: token.startsWith("!") ? "shownWhenOff" : "shownWhenOn",
      }),
    ),
  ]
}

/**
 * The connected endpoints a switch turns off when `toggled` turns on. `either`
 * fires whichever end is toggled; `oneway` fires only its primary. Only the
 * effective links fire: the nearest chain node that says anything about a pair
 * decides it, so a tombstone or gate at this level masks an upstream switch
 * (`effectiveRowlinks`), exactly as the tool's view reports. No cascade:
 * callers write exactly these rows off and never follow their links.
 */
export function switchedOff(
  links: readonly RowlinkRecord[],
  scopes: Scopes,
  address: Address,
  toggled: RowlinkEndpoint,
): RowlinkEndpoint[] {
  return effectiveRowlinks(links, scopes, address)
    .live.filter((link) => link.link === "either" || link.link === "oneway")
    .flatMap((link): RowlinkEndpoint[] => {
      const primary = { item: link.item, section: link.section }
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
  return effectiveRowlinks(links, scopes, address).live.flatMap(
    (link): { readonly direction: "outgoing" | "incoming"; readonly link: RowlinkRecord }[] => {
      if (sameEndpoint(endpoint, link.item, link.section)) return [{ direction: "outgoing", link }]
      if (sameEndpoint(endpoint, link.target, link.targetSection)) return [{ direction: "incoming", link }]
      return []
    },
  )
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
      // An empty list is "always": a target-local barrier that masks any
      // upstream marker and inherits nothing.
      rowlinks.push({
        ...owner,
        item: carrier.item,
        section: carrier.section,
        link: "shownAlways",
      })
    } else {
      // A non-empty list replaces the target's list at this level: the
      // barrier plus one pair per token, so the whole list is local and
      // unrelated upstream pairs on the same target do not leak in.
      rowlinks.push({ ...owner, item: carrier.item, section: carrier.section, link: "shownAlways" })
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