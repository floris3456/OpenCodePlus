// Query-time explanations, not another durable model. No prompt content is read.
import type { MonitorRequest, MonitorRequestDetail } from "../rpc.js"
import { Model } from "@opencode/schema/model"
import { Option, Schema } from "effect"
import { canonicalJson, sha256, FINGERPRINT_VERSION, FINGERPRINT_POLICY_VERSION, type CacheControlMarker } from "./fingerprint.js"
import type { ContextFactRow, Ledger, RequestFingerprintData, RequestRow } from "./ledger.js"
import { measurement } from "./measurement.js"
import { detectCache } from "./detection.js"
import { estimateTokens } from "./attribution.js"
import { foldUnread, unreadGain, type UnreadIndex, type UnreadKey, type UnreadKeyWork, type UnreadRead, type UnreadWrite } from "./unread-index.js"

type Segment = {
  name: string
  kind: MonitorRequestDetail["segments"][number]["kind"]
  hash: string
  prefixHash?: string
  chars: number
  tokens: number
  /** The zero-based message index the name spells ("message 3 (…)" is 2); undefined for other parts. */
  index: number | undefined
}

export const promptTokens = (r: RequestRow) => r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens
export const isMiss = (r: MonitorRequest) => r.verdict === "miss" || r.verdict === "partial"

export function causeWords(cause: string | undefined, changedPart?: string): string {
  if (cause === "compacted") return "compaction occurred"
  if (cause === "model-switch") return "model switched"
  if (cause === "agent-switch") return "agent switched"
  if (cause === "prefix-changed") return changedPart ? `prompt changed · ${changedPart}` : "prompt changed"
  if (cause === "cache-expired") return "cache expired"
  if (cause === "account-changed") return "account changed"
  if (cause === "account-changed-compacted-first") return "account changed · compacted first"
  if (cause === "revert") return "history reverted"
  if (cause === "instruction-update") return "instructions updated"
  return "unknown"
}

type SegmentInfo = {
  readonly segments: Segment[]
  readonly totalTokens: number
  /** The non-message parts, in order. */
  readonly prefix: Segment[]
  /**
   * Position of message 0 when the message parts hold indices 0, 1, 2… in
   * order (as every recorded wire body does), so message `i` sits at
   * `firstMessage + i`; -1 otherwise, and lookups search the whole list.
   */
  readonly firstMessage: number
  /** The cache-breakpoint message boundary (`markedMessageBoundary`). */
  readonly boundary: number
}

// Computed once per fingerprint object. A session analysis compares each
// request with several earlier ones, so per-call segment work dominated the
// Monitor's load time on long chats.
const segmentCache = new WeakMap<RequestFingerprintData, SegmentInfo>()
export const UNREAD_METADATA_CACHE_LIMIT = { entries: 4096, bytes: 1024 * 1024 } as const
const messageSegmentCache = new Map<string, { segment: Segment; bytes: number }>()
const unreadMetadataBytes = { segments: 2, append: 2 }

function getSegmentInfo(fp: RequestFingerprintData): SegmentInfo {
  const cached = segmentCache.get(fp)
  if (cached) return cached

  const segs = segments(fp)
  let totalTokens = 0
  for (let i = 0; i < segs.length; i++) {
    totalTokens += segs[i]!.tokens
  }
  const first = segs.length - fp.messagePrefixes.length
  const contiguous = segs.slice(first).every((part, i) => part.index === i)
  const info = {
    segments: segs,
    totalTokens,
    prefix: segs.filter((part) => part.kind !== "message"),
    firstMessage: contiguous ? first : -1,
    boundary: markedMessageBoundary(fp),
  }
  segmentCache.set(fp, info)
  return info
}

function segments(fp: RequestFingerprintData): Segment[] {
  const systemChars = fp.systemParts.reduce((sum, p) => sum + p.chars, 0)
  const system = [{
    name: "system wire",
    kind: "system" as const,
    hash: fp.systemHash ?? "",
    chars: systemChars,
    tokens: estimateTokens(systemChars),
    index: undefined,
  }]
  const tools = fp.tools.flatMap((p) => [
    {
      name: `tool ${p.name} description`,
      kind: "tool" as const,
      hash: p.descHash,
      chars: p.chars,
      tokens: p.estimatedTokens,
      index: undefined,
    },
    {
      name: `tool ${p.name} wire`,
      kind: "tool" as const,
      hash: p.wireHash ?? "",
      chars: 0,
      tokens: 0,
      index: undefined,
    },
    {
      name: `tool ${p.name} schema`,
      kind: "tool" as const,
      hash: p.schemaHash,
      chars: 0,
      tokens: 0,
      index: undefined,
    },
  ])

  const optionEntries = Object.entries(fp.optionsKeys)
    .filter(([name]) => !Object.keys(fp.optionsKeys).some((key) => key.startsWith(`${name}.`)))
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, hash]) => ({
      name: `option ${name}`,
      kind: "option" as const,
      hash,
      chars: 0,
      tokens: 0,
      index: undefined,
    }))

  return [
    { name: "protocol", kind: "marker", hash: sha256(fp.protocol), chars: 0, tokens: 0, index: undefined },
    ...optionEntries,
    {
      name: "cache markers",
      kind: "marker",
      hash: sha256(canonicalJson([fp.cacheKey ?? null, fp.cacheControl ?? []])),
      chars: 0,
      tokens: 0,
      index: undefined,
    },
    ...(fp.protocol === "anthropic-messages" ? [...tools, ...system] : [...system, ...tools]),
    ...fp.messagePrefixes.map((p) => {
      const identity = JSON.stringify([p.idx, p.kind ?? p.role, p.contentHash ?? p.prefixHash, p.prefixHash, p.chars, p.estimatedTokens])
      const cached = messageSegmentCache.get(identity)
      if (cached) return cached.segment
      const name = `message ${p.idx + 1} (${p.kind ?? p.role})`
      const segment = {
        name,
        kind: "message" as const,
        hash: p.contentHash ?? p.prefixHash,
        prefixHash: p.prefixHash,
        chars: p.chars,
        tokens: p.estimatedTokens,
        // A plain index spells itself; anything else is read back from the name.
        index: Number.isSafeInteger(p.idx) && p.idx >= 0 ? p.idx : messageIndex(name),
      }
      const bytes = Buffer.byteLength(JSON.stringify([identity, { segment, bytes: UNREAD_METADATA_CACHE_LIMIT.bytes }])) + 1
      // A large/irregular record is still analyzed; only its optional metadata
      // cache entry is refused. No fingerprint source objects are retained here.
      if (bytes > UNREAD_METADATA_CACHE_LIMIT.bytes) return segment
      messageSegmentCache.set(identity, { segment, bytes })
      unreadMetadataBytes.segments += bytes
      while (messageSegmentCache.size > UNREAD_METADATA_CACHE_LIMIT.entries || unreadMetadataBytes.segments > UNREAD_METADATA_CACHE_LIMIT.bytes) {
        const first = messageSegmentCache.entries().next().value!
        messageSegmentCache.delete(first[0])
        unreadMetadataBytes.segments -= first[1].bytes
      }
      return segment
    }),
  ]
}

// The cache-breakpoint message boundary named by the wire body's markers. The
// part of a request up to (and including) this message is the reusable prefix
// the provider was told to cache; whatever follows is the uncached tail.
function markedMessageBoundary(fp: RequestFingerprintData): number {
  let max = -1
  for (const marker of fp.cacheControl ?? []) {
    const match = /messages\[(\d+)\]/.exec(marker.target)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return max
}

function messageIndex(name: string): number | undefined {
  const match = /^message (\d+) /.exec(name)
  return match ? Number(match[1]) - 1 : undefined
}

// Whether `info` holds a part with this message part's name and hash. A
// message name spells its index, so in an in-order list the only candidate is
// at that index's position.
function hasMessage(info: SegmentInfo, part: Segment): boolean {
  if (info.firstMessage < 0)
    return info.segments.some((entry) => entry.name === part.name && entry.hash === part.hash)
  const entry = info.segments[info.firstMessage + part.index!]
  return entry !== undefined && entry.index === part.index && entry.name === part.name && entry.hash === part.hash
}

// Whether a message part of `from` past the boundary is missing from `to`.
function tailMissing(from: SegmentInfo, to: SegmentInfo, boundary: number): boolean {
  const start = from.firstMessage < 0 ? 0 : from.firstMessage + boundary + 1
  for (let i = start; i < from.segments.length; i++) {
    const part = from.segments[i]!
    if (part.index !== undefined && part.index > boundary && !hasMessage(to, part)) return true
  }
  return false
}

// Cache-control markers and prompt-cache key that belong to the reusable
// prefix (non-message markers and messages at or before the boundary). A
// change to these is a real cache-prefix change; the tail's own markers are
// replaced with the tail and must not be counted.
function reusableMarkerSignature(fp: RequestFingerprintData, boundary: number): string {
  const known = signatureCache.get(fp) ?? new Map<number, string>()
  signatureCache.set(fp, known)
  const cached = known.get(boundary)
  if (cached !== undefined) return cached
  const relevant = (fp.cacheControl ?? []).filter((marker) => {
    const match = /messages\[(\d+)\]/.exec(marker.target)
    return match === null || Number(match[1]) <= boundary
  })
  // canonicalJson([cacheKey, relevant]), with each marker's text computed once.
  const signature = `[${canonicalJson(fp.cacheKey ?? null)},[${relevant.map(markerJson).join(",")}]]`
  known.set(boundary, signature)
  return signature
}

function markerJson(marker: CacheControlMarker): string {
  const cached = markerCache.get(marker)
  if (cached !== undefined) return cached
  const json = canonicalJson(marker)
  markerCache.set(marker, json)
  return json
}

// Marker signatures per fingerprint (and boundary), and each marker's
// canonical text: each fingerprint is compared with several others.
const signatureCache = new WeakMap<RequestFingerprintData, Map<number, string>>()
const shapeCache = new WeakMap<RequestFingerprintData, string>()
const markerCache = new WeakMap<CacheControlMarker, string>()

// Everything the provider caches: non-message parts except the aggregate marker
// segment, and messages at or before the last common breakpoint. The reusable
// marker metadata is compared separately so a marker change is never masked.
function reusablePrefixEqual(a: Segment[], b: Segment[], boundary: number): boolean {
  const keep = (part: Segment) => (part.index !== undefined ? part.index <= boundary : part.name !== "cache markers")
  let i = 0
  let j = 0
  for (;;) {
    while (i < a.length && !keep(a[i]!)) i++
    while (j < b.length && !keep(b[j]!)) j++
    if (i >= a.length || j >= b.length) return i >= a.length && j >= b.length
    if (a[i]!.name !== b[j]!.name || (a[i]!.prefixHash ?? a[i]!.hash) !== (b[j]!.prefixHash ?? b[j]!.hash)) return false
    i++
    j++
  }
}

function tokensThroughBoundary(a: Segment[], boundary: number): number {
  let total = 0
  for (const part of a) {
    if (part.index !== undefined && part.index > boundary) break
    total += part.tokens
  }
  return total
}

// A linked Responses continuation keeps every non-message part.
function samePrefix(aInfo: SegmentInfo, bInfo: SegmentInfo): boolean {
  const prefix = aInfo.prefix
  const next = bInfo.prefix
  return prefix.length === next.length && prefix.every((part, index) => part.name === next[index]?.name && part.hash === next[index]?.hash)
}

// #13: a warming ping appends a private prompt after the history's last cache
// breakpoint; the next real step replaces that uncached tail with its own
// user input. When only the tail past the marked boundary differs, the
// reusable prefix is unchanged and this is not a certain prefix change.
function tailReplaced(
  before: RequestFingerprintData,
  after: RequestFingerprintData,
  aInfo: SegmentInfo,
  bInfo: SegmentInfo,
): boolean {
  if (before.protocol !== "anthropic-messages" || after.protocol !== "anthropic-messages") return false
  const boundary = Math.min(aInfo.boundary, bInfo.boundary)
  return (
    boundary >= 0 &&
    (tailMissing(aInfo, bInfo, boundary) || tailMissing(bInfo, aInfo, boundary)) &&
    reusableMarkerSignature(before, boundary) === reusableMarkerSignature(after, boundary) &&
    reusablePrefixEqual(aInfo.segments, bInfo.segments, boundary)
  )
}

/** `prefixDiff(before, after).reusable`, without building the change list. */
export function reusableOf(before: RequestFingerprintData | undefined, after: RequestFingerprintData | undefined): boolean {
  if (!before || !after) return false
  const full = diffCache.get(before)?.get(after)
  if (full) return full.reusable
  const known = reuseCache.get(before) ?? new WeakMap<RequestFingerprintData, boolean>()
  reuseCache.set(before, known)
  const cached = known.get(after)
  if (cached !== undefined) return cached
  const reusable = decideReusable(before, after)
  known.set(after, reusable)
  return reusable
}

// The same decisions as prefixDiff, in its order.
function decideReusable(before: RequestFingerprintData, after: RequestFingerprintData): boolean {
  if (!supportedFingerprint(before) || !supportedFingerprint(after) || before.protocol !== after.protocol) return false
  const aInfo = getSegmentInfo(before)
  const bInfo = getSegmentInfo(after)
  if (before.previousResponseId && !after.previousResponseId) return false
  if (after.protocol === "openai-responses" && after.previousResponseId) {
    if (before.responseId !== after.previousResponseId) return false
    if (samePrefix(aInfo, bInfo)) return true
  }
  if (tailReplaced(before, after, aInfo, bInfo)) return true
  // A pure append: every part of `before` sits unchanged at the same place in
  // `after`. Its last part is checked first; with rolling breakpoints that part
  // carried the marker and differs, which settles most comparisons at once.
  const a = aInfo.segments
  const b = bInfo.segments
  if (a.length > b.length || before.protocol !== after.protocol) return false
  const last = a.length - 1
  if (last >= 0 && ((a[last]!.prefixHash ?? a[last]!.hash) !== (b[last]!.prefixHash ?? b[last]!.hash) || a[last]!.name !== b[last]!.name)) return false
  return a.every((part, i) => (part.prefixHash ?? part.hash) === (b[i]!.prefixHash ?? b[i]!.hash) && part.name === b[i]!.name)
}

/** Version/policy are independent of storage schema. Legacy missing fields cannot
 * reconstruct omitted roles, strictness or strings. Fallback has no known policy.
 */
const supportedCache = new WeakMap<RequestFingerprintData, boolean>()

function supportedFingerprint(fp: RequestFingerprintData): boolean {
  const cached = supportedCache.get(fp)
  if (cached !== undefined) return cached
  const supported = fp.fingerprintVersion === FINGERPRINT_VERSION && fp.policyVersion === FINGERPRINT_POLICY_VERSION &&
    ["openai-chat", "openai-responses", "anthropic-messages"].includes(fp.protocol) &&
    typeof fp.systemHash === "string" && fp.tools.every((p) => typeof p.wireHash === "string") &&
    fp.messagePrefixes.every((p) => typeof p.contentHash === "string")
  supportedCache.set(fp, supported)
  return supported
}

export function prefixDiff(before: RequestFingerprintData | undefined, after: RequestFingerprintData | undefined, detail = true) {
  if (!before || !after || !supportedFingerprint(before) || !supportedFingerprint(after)) {
    return { known: false, append: false, reusable: false, common: 0, changes: [] as MonitorRequestDetail["segments"] }
  }
  const aInfo = getSegmentInfo(before)
  const bInfo = getSegmentInfo(after)
  const a = aInfo.segments
  const b = bInfo.segments

  if (before.previousResponseId && !after.previousResponseId) {
    return { known: true, append: false, reusable: false, common: 0, changes: [{
      name: "previous_response_id", kind: "marker" as const, change: "removed" as const,
      ...(detail ? { before: { hash: before.previousResponseId, chars: 0, tokens: 0 } } : {}),
    }] }
  }

  if (after.protocol === "openai-responses" && after.previousResponseId) {
    if (before.responseId === after.previousResponseId) {
      if (samePrefix(aInfo, bInfo))
        return { known: true, append: true, reusable: true, common: aInfo.totalTokens, changes: [] }
    } else {
      return { known: true, append: false, reusable: false, common: 0, changes: [{
        name: "previous_response_id", kind: "marker" as const, change: "changed" as const,
        ...(detail && before.previousResponseId ? { before: { hash: before.previousResponseId, chars: 0, tokens: 0 } } : {}),
        ...(detail ? { after: { hash: after.previousResponseId, chars: 0, tokens: 0 } } : {}),
      }] }
    }
  }

  if (tailReplaced(before, after, aInfo, bInfo)) {
    return {
      known: true,
      append: false,
      reusable: true,
      common: tokensThroughBoundary(a, Math.min(aInfo.boundary, bInfo.boundary)),
      changes: [],
    }
  }

  const end = a.findIndex((p, i) => (p.prefixHash ?? p.hash) !== (b[i]?.prefixHash ?? b[i]?.hash) || p.name !== b[i]?.name)
  const isPureAppend = end < 0 && a.length <= b.length && before.protocol === after.protocol

  if (isPureAppend) {
    const changes: MonitorRequestDetail["segments"][number][] = []
    if (a.length < b.length) {
      for (let i = a.length; i < b.length; i++) {
        const p = b[i]!
        if (p.kind !== "message") {
          changes.push({
            name: p.name,
            kind: p.kind,
            change: "added",
            ...(detail ? { after: { hash: p.hash, chars: p.chars, tokens: p.tokens } } : {}),
          })
        }
      }
    }
    return {
      known: true,
      append: true,
      reusable: true,
      common: aInfo.totalTokens,
      changes,
    }
  }

  const commonIdx = end < 0 ? a.length : end
  let common = 0
  for (let i = 0; i < commonIdx; i++) {
    common += a[i]!.tokens
  }

  const changes: MonitorRequestDetail["segments"][number][] = []
  const value = (s: Segment) => ({ hash: s.hash, chars: s.chars, tokens: s.tokens })

  // Align by identity, not position: inserting one option must not shift tools/history.
  const identity = (p: Segment) => p.index === undefined ? p.name : `message:${p.index}`
  const beforeParts = new Map(a.map((p) => [identity(p), p]))
  const afterParts = new Map(b.map((p) => [identity(p), p]))
  for (const p of a) {
    const next = afterParts.get(identity(p))
    if (next && p.hash === next.hash) continue
    changes.push({
      name: p.name,
      kind: p.kind,
      change: next ? "changed" : "removed",
      ...(detail ? { before: value(p) } : {}),
      ...(detail && next ? { after: value(next) } : {}),
    })
  }

  for (const p of b) {
    if (!beforeParts.has(identity(p))) {
      changes.push({
        name: p.name,
        kind: p.kind,
        change: "added",
        ...(detail ? { after: { hash: p.hash, chars: p.chars, tokens: p.tokens } } : {}),
      })
    }
  }
  const order = new Map([...b, ...a.filter((p) => !afterParts.has(identity(p)))].map((p, i) => [p.name, i]))
  changes.sort((a, b) => order.get(a.name)! - order.get(b.name)!)

  return {
    known: true,
    append: false,
    reusable: false,
    common,
    changes,
  }
}

/** Strict compaction contract, deliberately stricter than ordinary cache reuse. */
export function compactionAppend(before: RequestFingerprintData | undefined, after: RequestFingerprintData | undefined, strategy: "native" | "text-summary") {
  if (!before || !after || !supportedFingerprint(before) || !supportedFingerprint(after))
    return { valid: false, segment: "unavailable fingerprint" }
  const options = (fp: RequestFingerprintData) => Object.fromEntries(Object.entries(fp.optionsKeys).filter(([key, hash]) =>
    key !== "max_tokens" && key !== "compaction" && !(key === "context_management" && hash === sha256("null"))))
  const left = { ...before, optionsKeys: options(before) }
  const right = { ...after, optionsKeys: options(after) }
  const a = getSegmentInfo(left).segments
  const b = getSegmentInfo(right).segments
  const mismatch = a.find((part, i) => part.name !== b[i]?.name || part.hash !== b[i]?.hash)
  if (mismatch) return { valid: false, segment: prefixDiff(left, right).changes[0]?.name ?? mismatch.name }
  const added = b.slice(a.length)
  if (strategy === "native" ? added.length !== 0 : added.length !== 1 || added[0]?.kind !== "message" || after.messagePrefixes.at(-1)?.role !== "user")
    return { valid: false, segment: "history length" }
  return { valid: true }
}

/** Conservative idle lifetime, per README; unknown/disk-cache TTL stays unknown. */
export function cacheLifetime(_r: Pick<RequestRow, "provider" | "model">, fp?: RequestFingerprintData): number | undefined {
  const ttl = fp?.optionsKeys["prompt_cache_options.ttl"]
  if (ttl === sha256(canonicalJson("24h"))) return 86_400_000
  if (ttl === sha256(canonicalJson("1h"))) return 3_600_000
  if (ttl === sha256(canonicalJson("30m"))) return 1_800_000
  if (fp?.cacheControl?.some((m) => m.ttl === "1h")) return 3_600_000
  if (fp?.protocol === "anthropic-messages" && fp.cacheControl?.some((m) => m.type === "ephemeral")) return 300_000
  if (fp?.optionsKeys.prompt_cache_retention === sha256(canonicalJson("24h"))) return 86_400_000
  return undefined
}

// Segment labels use one-based message ordinals, unlike the stored prefix index.
const messageIndexIn = (name: string): number | undefined => {
  const match = /^message (\d+) /.exec(name)
  return match ? Number(match[1]) : undefined
}

// Cache markers are compared by shape (type, ttl) without their targets.
// Anthropic's rolling breakpoints move the last marker to the newest message on
// every step, which is not a cache-prefix change; a changed ttl or marker type
// is.
function markerShape(fp: RequestFingerprintData | undefined): string {
  const cached = fp && shapeCache.get(fp)
  if (cached !== undefined) return cached
  const shapes = (fp?.cacheControl ?? []).map((m) => `${m.type}\0${m.ttl ?? ""}`).sort()
  const shape = canonicalJson([fp?.cacheKey ?? null, shapes])
  if (fp) shapeCache.set(fp, shape)
  return shape
}

// A change to a non-message, non-marker segment is a real reusable-prefix edit
// (system part, tool, option or protocol). A genuine marker change is a shape
// change. A message's hash covers its own cache marker, so the message the
// previous request marked differs once the rolling marker moves on: a step's
// last message, or the history's last message before a keep-alive ping's
// uncached prompt. A growth step may also extend the last message. Only a
// change strictly before both that marked message and the end of the shorter
// history shifts the reusable prefix and is a historical edit.
function reusablePrefixChanged(
  changes: MonitorRequestDetail["segments"],
  before: RequestFingerprintData | undefined,
  after: RequestFingerprintData | undefined,
): boolean {
  if (changes.length === 0) return false
  if (changes.some((c) => c.name !== "cache markers" && messageIndexIn(c.name) === undefined)) return true
  if (changes.length > 0 && markerShape(before) !== markerShape(after)) return true
  const marked = before ? markedMessageBoundary(before) : -1
  const lastCommon = Math.min(
    before?.messagePrefixes.length ?? 0,
    after?.messagePrefixes.length ?? 0,
    ...(marked < 0 ? [] : [marked + 1]),
  )
  return changes.some((c) => {
    const index = messageIndexIn(c.name)
    return index !== undefined && index < lastCommon
  })
}

type Diff = ReturnType<typeof prefixDiff>

// One lean diff per pair of fingerprint objects. Full before/after values are
// expanded only by detail lookup. An analysis compares a request with
// its previous, last real and refreshing requests and every write with its
// later reads; a session's unchanged fingerprints keep their objects across
// incremental analyses, so their diffs are reused too.
const diffCache = new WeakMap<RequestFingerprintData, WeakMap<RequestFingerprintData, Diff>>()
// Where only reuse matters (a refreshing request, a write's later reads), the verdict alone.
const reuseCache = new WeakMap<RequestFingerprintData, WeakMap<RequestFingerprintData, boolean>>()

function diffOf(before: RequestFingerprintData | undefined, after: RequestFingerprintData | undefined): Diff {
  if (!before || !after) return prefixDiff(before, after, false)
  const known = diffCache.get(before) ?? new WeakMap<RequestFingerprintData, Diff>()
  diffCache.set(before, known)
  const cached = known.get(after)
  if (cached) return cached
  const diff = prefixDiff(before, after, false)
  known.set(after, diff)
  return diff
}

// Context facts as the ledger returns them, in time order, are searched by
// position; facts in any other order fall back to a scan with the same result.
interface Facts {
  readonly all: readonly ContextFactRow[]
  readonly ordered: boolean
}

function factsOf(all: readonly ContextFactRow[]): Facts {
  return { all, ordered: all.every((fact, i) => i === 0 || all[i - 1]!.at <= fact.at) }
}

// The first position whose fact is later than `at` (facts in time order).
function laterThan(facts: Facts, at: number): number {
  let low = 0
  let high = facts.all.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (facts.all[mid]!.at <= at) low = mid + 1
    else high = mid
  }
  return low
}

// Facts with `from < at <= to`, in their order.
function factsBetween(facts: Facts, from: number, to: number): readonly ContextFactRow[] {
  if (!facts.ordered) return facts.all.filter((f) => f.at > from && f.at <= to)
  return facts.all.slice(laterThan(facts, from), laterThan(facts, to))
}

// The last fact matching `match`, which only accepts facts at or before `to`.
function lastFact(facts: Facts, to: number, match: (fact: ContextFactRow) => boolean): ContextFactRow | undefined {
  if (!facts.ordered) return facts.all.findLast(match)
  for (let i = laterThan(facts, to) - 1; i >= 0; i--) {
    if (match(facts.all[i]!)) return facts.all[i]
  }
  return undefined
}

interface DiffStep {
  readonly diff: Diff
  readonly expected: number | undefined
  readonly changed: boolean
}

function diffStep(
  previous: RequestRow | undefined,
  previousFp: RequestFingerprintData | undefined,
  fp: RequestFingerprintData | undefined,
): DiffStep {
  const diff = diffOf(previous && previousFp, fp)
  const measured = previous && measurement(previous)
  // Common characters are not a lower bound in tokens. Only the selected,
  // compatible measured anchor can support a local shortfall estimate.
  const warm = measured?.state === "reported" && measured.read !== undefined && measured.write !== undefined
    ? measured.read + measured.write : undefined
  // Interior marked content can match while the private tail is replaced.
  // Aggregate usage does not locate a measured size at that interior boundary.
  const expected = warm
  return { diff, expected, changed: reusablePrefixChanged(diff.changes, previousFp, fp) }
}

interface TimingStep {
  readonly pings: RequestRow[]
  readonly gap: number | undefined
  readonly lifetime: number | undefined
  readonly warming: "ended" | "failed" | "off" | "on" | undefined
}

function timingStep(
  r: RequestRow,
  earlier: readonly RequestRow[],
  lastReal: RequestRow | undefined,
  lastRealIndex: number,
  fingerprints: Map<string, RequestFingerprintData | undefined>,
  fp: RequestFingerprintData | undefined,
  facts: Facts,
  previous: RequestRow | undefined,
): TimingStep {
  const pings = earlier.slice(lastRealIndex + 1).filter((p) => p.kind === "ping")
  // Age and size use the same basis. Completion is a conservative local
  // timing boundary, not a measurement of provider cache readiness.
  const gap = previous?.ended !== undefined
    ? r.started - previous.ended
    : undefined
  const lifetime = cacheLifetime(r, fp)
  const warmingFact = lastFact(
    facts,
    r.started,
    (f) =>
      f.kind === "warming" &&
      f.at <= r.started &&
      (f.detail?.phase !== "activity" || f.at <= (lastReal?.ended ?? lastReal?.started ?? 0)),
  )
  const warmingValue =
    warmingFact?.detail?.state === "on" &&
    typeof warmingFact.detail.until === "number" &&
    warmingFact.detail.until < r.started
      ? "ended"
      : warmingFact?.detail?.state
  const warming =
    warmingValue === "on" || warmingValue === "off" || warmingValue === "ended" || warmingValue === "failed"
      ? (warmingValue as "ended" | "failed" | "off" | "on")
      : pings.at(-1)?.error
        ? ("failed" as const)
        : undefined

  return { pings, gap, lifetime, warming }
}

interface CauseStep {
  readonly accounts: MonitorRequestDetail["accounts"]
  readonly instructions: MonitorRequestDetail["instructions"]
  readonly reverts: MonitorRequestDetail["reverts"]
  readonly verdict: MonitorRequest["verdict"]
  readonly cause: MonitorRequest["cause"]
  readonly causeText: string
  readonly confidence: MonitorRequest["confidence"]
  readonly evidence: string
}

function causeStep(
  r: RequestRow,
  previous: RequestRow | undefined,
  last: RequestRow | undefined,
  between: readonly ContextFactRow[],
  diff: ReturnType<typeof prefixDiff>,
  changed: boolean,
  expected: number | undefined,
  lifetime?: number,
): CauseStep {
  const accounts = between
    .filter((f) => f.kind === "account_switch" || f.kind === "quota_handoff")
    .map((f) => ({
      at: f.at,
      kind: f.kind,
      ...(typeof (f.detail?.from ?? f.detail?.previous) === "string"
        ? { from: String(f.detail?.from ?? f.detail?.previous) }
        : {}),
      ...(typeof (f.detail?.to ?? f.detail?.alias) === "string" ? { to: String(f.detail?.to ?? f.detail?.alias) } : {}),
    }))
  const instructions = between
    .filter((f) => f.kind === "instruction_update")
    .map((f) => ({
      at: f.at,
      keys: Array.isArray(f.detail?.keys) ? f.detail.keys.filter((k): k is string => typeof k === "string") : [],
    }))
  const reverts = between.filter((f) => f.kind === "revert").map((f) => ({ at: f.at }))
  const compactions = between.filter((f) => f.kind === "compaction")
  const compacted = r.kind !== "compaction" && ((!previous && last?.kind === "compaction") || compactions.length > 0)
  const quotaSwitchCompacted = compacted && compactions.some((f) => f.detail?.["quota.switch"] === true)
  const switched =
    last !== undefined && (last.provider !== r.provider || last.model !== r.model || last.variant !== r.variant)
  const agent = last !== undefined && last.agent !== r.agent
  // A request still running has no usage yet. Judging its zero cache read
  // against the expected prefix called every in-flight step a miss, so an
  // agent querying its own chat always saw its current step as one.
  if (r.status === "running")
    return {
      accounts,
      instructions,
      reverts,
      verdict: "none",
      cause: "unknown",
      causeText: "unknown",
      confidence: "unknown",
      evidence: "Request still running; no usage reported yet",
    }
  // An errored request carries an error and no usage: it is neither a hit nor
  // a cache verdict. Give it its own outcome so it is excluded from the hit
  // rate and never counted as a cache win.
  if (r.status === "error" && measurement(r).state !== "reported")
    return {
      accounts,
      instructions,
      reverts,
      verdict: "error",
      cause: undefined,
      causeText: "unknown",
      confidence: "unknown",
      evidence: "Request failed; cache measurement is independent of the execution outcome",
    }

  const measured = measurement(r)
  const usable = measured.state === "reported" && measured.input !== undefined && measured.read !== undefined
  const bounded = usable && expected !== undefined ? Math.min(expected, measured.input!) : undefined
  const shortfall = bounded === undefined ? 0 : Math.max(0, bounded - measured.read!)
  const verdict = detectCache({ reported: measured.state === "reported", input: measured.input, read: measured.read, predecessor: previous !== undefined, frontier: expected }).verdict
  const expired = previous?.ended !== undefined && lifetime !== undefined && r.started - previous.ended > lifetime

  const cause: MonitorRequest["cause"] = expired ? "cache-expired" : accounts.length || r.observation?.compaction?.trigger === "handoff" ? "account-changed" : reverts.length ? "revert" : quotaSwitchCompacted
    ? "account-changed-compacted-first"
    : compacted
      ? "compacted"
      : instructions.length ? "instruction-update" : switched
        ? "model-switch"
        : agent
          ? "agent-switch"
          : changed
            ? "prefix-changed"
            : accounts.length
                ? "account-changed"
                : "unknown"
  // These are co-occurring local facts, not a proved provider cause. Do not
  // choose the first differing option as an explanation of provider behavior.
  const observed = [
    ...(compacted ? ["Compaction occurred"] : []),
    ...(switched ? ["Model / variant switched"] : []),
    ...(agent ? ["Agent switched"] : []),
    ...(accounts.length ? ["Provider account changed"] : []),
    ...diff.changes.map((part) => `${part.name} ${part.change}`),
    ...(instructions.length ? ["Instruction update observed"] : []),
    ...(reverts.length ? ["Revert observed"] : []),
  ]
  const reported = measured.state === "legacy-unknown"
    ? `Legacy record: stored cache read ${r.cacheReadTokens}; field presence unknown`
    : measured.state !== "reported"
      ? `Cache read unavailable (${measured.state})`
      : `Reported cache read ${measured.read}${measured.input === undefined ? "; inclusive input unavailable" : ` / ${measured.input} input`}`
  const comparison = expected === undefined
    ? "No reliable reusable-token estimate; no comparable measured baseline"
    : !usable
      ? `Compatible measured anchor ${previous?.id}; local shortfall unavailable without complete current usage`
      : `Compatible measured anchor ${previous?.id}; local shortfall estimate ${shortfall} tokens (bounded by current input)`
  const evidence = [reported, comparison, ...observed, "Provider cause unavailable"].join("; ")

  return {
    accounts,
    instructions,
    reverts,
    verdict,
    cause,
      causeText: cause === "unknown" ? "provider cause unknown" : `observed: ${causeWords(cause, diff.changes[0]?.name)}`,
    confidence: "unknown",
    evidence,
  }
}

// Failed attempts and in-flight requests have not consumed the context boundary.
function contextBaseline(rows: readonly RequestRow[], current: RequestRow) {
  return rows.findLast((row) =>
    row.status === "completed" && row.ended !== undefined && row.ended <= current.started &&
    (current.kind === "ping" || current.isTitle || (row.kind !== "ping" && !row.isTitle)))
}

interface CostStep {
  readonly missing: number
  readonly missCost: number | undefined
  readonly pricing: NonNullable<MonitorRequest["pricing"]>
}

function costStep(
  r: RequestRow,
  expected: number | undefined,
  facts: Facts,
): CostStep {
  const measured = measurement(r)
  const shortfall =
    measured.state === "reported" && measured.input !== undefined && measured.read !== undefined
      ? measured.read === measured.input
        ? 0
        : expected === undefined
          ? undefined
          : Math.max(0, Math.min(expected, measured.input) - measured.read)
      : undefined
  // Keep the legacy numeric counter, but never present its unknown zero as a priced scenario.
  if (shortfall === undefined) return { missing: 0, missCost: undefined, pricing: { state: "unknown-shortfall", reason: "No complete comparable shortfall measurement" } }
  if (shortfall < 1024) return { missing: 0, missCost: 0, pricing: { state: "zero-shortfall", shortfall: 0 } }
  const pricing = lastFact(
    facts,
    r.started,
    (f) =>
      f.kind === "pricing" && f.at <= r.started && f.detail?.provider === r.provider && f.detail?.model === r.model,
  )
  const rates = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Array(Model.Cost))(pricing?.detail?.rates))
  const provenance = {
    shortfall,
    ...(pricing ? { source: "recorded-model-rates" as const, factAt: pricing.at } : {}),
    ...(r.provider ? { provider: r.provider } : {}),
    ...(r.model ? { model: r.model } : {}),
    inputBasis: "inclusive-measured" as const,
  }
  const refuse = (reason: string): CostStep => ({ missing: shortfall, missCost: undefined, pricing: { ...provenance, state: "unpriced", reason } })
  if (!rates?.length) return refuse("Applicable rates were not recorded")
  if (pricing?.detail?.variant !== undefined && r.variant !== pricing.detail.variant) return refuse("Recorded rates do not identify the request variant")
  // Model.Cost records one write rate, not duration buckets. Full mixed-TTL pricing is deferred.
  if (pricing?.detail?.writeDurationBuckets !== undefined || pricing?.detail?.mixedTTL === true) return refuse("Write-duration pricing is unsupported")
  if (measured.write === undefined) return refuse("Complete cache-write measurement unavailable")
  const rate = rates
    .filter((c) => !c.tier || measured.input! > c.tier.size)
    .toSorted((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0]
  if (!rate) return refuse("No recorded input tier applies")
  if ([rate.input, rate.cache.read, rate.cache.write].some((n) => !Number.isFinite(n) || n < 0)) return refuse("Invalid recorded rates")
  const written = Math.min(shortfall, measured.write)
  const missCost = (written * (rate.cache.write - rate.cache.read) + (shortfall - written) * (rate.input - rate.cache.read)) / 1_000_000
  return {
    missing: shortfall,
    missCost,
    pricing: {
      ...provenance,
      state: "priced",
      scenario: "shortfall-vs-cache-read",
      rates: { input: rate.input, read: rate.cache.read, write: rate.cache.write },
      ...(rate.tier ? { tierAbove: rate.tier.size } : {}),
      assumedWriteTokens: written,
      assumedNoncachedTokens: shortfall - written,
      writeBasis: "single-recorded-rate-no-duration-attribution",
    },
  }
}

export interface UnstableStreak {
  readonly segment: string
  readonly streak: number
  readonly at: number
  readonly requestID: string
  readonly agent?: string
  readonly provider?: string
  readonly model?: string
}

export interface SessionAnalysis {
  readonly summaries: readonly RequestSummary[]
  /** Explicit full-analysis compatibility view; polling must use summaries. */
  readonly details: MonitorRequestDetail[]
  readonly detail: (id: string) => MonitorRequestDetail | undefined
  readonly work: { details: number }
  readonly unstable: readonly UnstableStreak[]
  readonly fingerprints: Map<string, RequestFingerprintData | undefined>
  readonly writes: readonly UnreadWrite[]
  readonly reads: readonly UnreadRead[]
  readonly unreadIndex: UnreadIndex
}

export interface RequestSummary {
  readonly request: MonitorRequest
  readonly previous?: MonitorRequestDetail["previous"]
}

const unreadKeysCache = new WeakMap<RequestFingerprintData, { read: readonly UnreadKey[]; write: readonly UnreadKey[] }>()
const unreadKeyWeights = new WeakMap<RequestFingerprintData, number>()
const unreadObjectWeights = new WeakMap<object, number>()
// Identity-keyed metadata works for delta-decoded and legacy full-row records.
// FIFO eviction changes recomputation only, never the set of comparisons.
const unreadAppendCache = new Map<string, { prefix: string; mode: string; key: UnreadKey; bytes: number }>()

/** Process-wide optional metadata, independently bounded outside the per-Session
 * analysis LRU. Conservative UTF-8 table sizes include framing and the maximum
 * byte-counter width. These are not engine heap bytes.
 */
export function unreadMetadataCacheWeight() {
  return { bytes: unreadMetadataBytes.segments + unreadMetadataBytes.append, segments: messageSegmentCache.size, prefixes: unreadAppendCache.size }
}

/** Derived-key cache reachable through a retained fingerprint, including the
 * unused half when only a read or write requested keys. Never generates keys.
 * Counting this alongside write/read metadata is conservative (shared arrays).
 */
export function unreadFingerprintKeyWeight(fp: RequestFingerprintData): number {
  const keys = unreadKeysCache.get(fp)
  const cached = unreadKeyWeights.get(fp)
  // Exactly the original {read:[...],write:[...]} UTF-8 size, summing immutable
  // key-object sizes rather than reserializing every shared prefix per row.
  const bytes = cached ?? (keys ? 18 + [keys.read, keys.write].reduce((sum, list) => sum + 2 + list.reduce((sum, key) => sum + unreadObjectWeight(key), 0) + Math.max(0, list.length - 1), 0) : 0)
  if (keys && cached === undefined) unreadKeyWeights.set(fp, bytes)
  return bytes
}

function unreadObjectWeight(value: object): number {
  const cached = unreadObjectWeights.get(value)
  if (cached !== undefined) return cached
  const bytes = Buffer.byteLength(JSON.stringify(value))
  unreadObjectWeights.set(value, bytes)
  return bytes
}

/** Index the same three reuse cases as prefixDiff: ordered append, exact
 * Responses lineage, and Anthropic marked-prefix/private-tail replacement.
 * Hashes contain identity only; annotations and token sizes never enter keys.
 */
export function unreadFingerprintKeys(fp: RequestFingerprintData | undefined, write: boolean, work?: UnreadKeyWork): readonly UnreadKey[] {
  if (!fp || !supportedFingerprint(fp)) return []
  const cached = unreadKeysCache.get(fp)
  if (cached) return write ? cached.write : cached.read
  const info = getSegmentInfo(fp)
  const read: UnreadKey[] = []
  const writes: UnreadKey[] = []
  const mode = fp.protocol === "openai-responses" && fp.previousResponseId ? `linked:${fp.previousResponseId}` : fp.previousResponseId ? "present" : "none"
  const modes = fp.protocol === "openai-responses"
    ? [...(fp.previousResponseId ? [] : ["none"]), ...(fp.responseId ? [`linked:${fp.responseId}`] : [])]
    : fp.previousResponseId ? ["present"] : ["none", "present"]
  let prefix = ""
  for (const part of info.segments) {
    const hash = part.prefixHash ?? part.hash
    const identity = JSON.stringify([prefix, part.name, hash])
    const known = part.kind === "message" ? unreadAppendCache.get(identity) : undefined
    prefix = known?.prefix ?? new Bun.CryptoHasher("sha256").update(identity).digest("hex").slice(0, 16)
    if (work) {
      if (known) work.prefixHits++
      if (!known) work.prefixHashes++
    }
    const key = known?.mode === mode ? known.key : { key: `append:${mode}:${prefix}` }
    if (work && known?.mode === mode) work.sharedKeys++
    read.push(key)
    if (part.kind === "message" && known?.mode !== mode) {
      const bytes = Buffer.byteLength(JSON.stringify([identity, { prefix, mode, key, bytes: UNREAD_METADATA_CACHE_LIMIT.bytes }])) + 1
      if (bytes <= UNREAD_METADATA_CACHE_LIMIT.bytes) {
        unreadAppendCache.set(identity, { prefix, mode, key, bytes })
        unreadMetadataBytes.append += bytes - (known?.bytes ?? 0)
        while (unreadAppendCache.size > UNREAD_METADATA_CACHE_LIMIT.entries || unreadMetadataBytes.append > UNREAD_METADATA_CACHE_LIMIT.bytes) {
          const first = unreadAppendCache.entries().next().value!
          unreadAppendCache.delete(first[0])
          unreadMetadataBytes.append -= first[1].bytes
        }
      }
    }
  }
  modes.forEach((mode) => writes.push({ key: `append:${mode}:${prefix}` }))
  if (fp.protocol === "openai-responses") {
    const identity = sha256(canonicalJson(info.prefix.map((part) => [part.name, part.hash])))
    if (fp.previousResponseId) read.push({ key: `lineage:${fp.previousResponseId}:${identity}` })
    if (fp.responseId) writes.push({ key: `lineage:${fp.responseId}:${identity}` })
  }
  if (fp.protocol === "anthropic-messages" && info.boundary >= 0) {
    const messages = info.segments.filter((part) => part.index !== undefined)
    // Ordinary wire fingerprints have contiguous ordinals. The set fallback
    // preserves tailMissing's semantics for older irregular fingerprint lists.
    const tails = new Map<number, string>()
    let tail = ""
    for (const part of messages.toReversed()) {
      tails.set(part.index!, tail)
      tail = sha256(canonicalJson([part.name, part.hash, tail]))
    }
    let marked = ""
    for (const part of info.prefix.filter((part) => part.name !== "cache markers")) {
      marked = sha256(canonicalJson([marked, part.name, part.prefixHash ?? part.hash]))
    }
    for (let boundary = 0; boundary <= info.boundary; boundary++) {
      const part = messages[boundary]
      if (info.firstMessage >= 0 && part) marked = sha256(canonicalJson([marked, part.name, part.prefixHash ?? part.hash]))
      const identity = info.firstMessage >= 0 ? marked : info.segments
        .filter((part) => part.index === undefined ? part.name !== "cache markers" : part.index <= boundary)
        .reduce((hash, part) => sha256(canonicalJson([hash, part.name, part.prefixHash ?? part.hash])), "")
      const suffix = info.firstMessage >= 0 ? tails.get(boundary) ?? "" : messages
        .filter((part) => part.index! > boundary)
        .filter((part, index, parts) => parts.findIndex((other) => other.name === part.name && other.hash === part.hash) === index)
        .sort((a, b) => a.index! - b.index! || a.name.localeCompare(b.name) || a.hash.localeCompare(b.hash))
        .toReversed().reduce((hash, part) => sha256(canonicalJson([part.name, part.hash, hash])), "")
      const key = `${identity}:${sha256(reusableMarkerSignature(fp, boundary))}`
      read.push({ key: `tail:atLeast:${mode}:${key}`, tail: suffix })
      if (boundary === info.boundary) read.push({ key: `tail:exact:${mode}:${key}`, tail: suffix })
      modes.forEach((mode) => writes.push({ key: `tail:${boundary === info.boundary ? "atLeast" : "exact"}:${mode}:${key}`, tail: suffix }))
    }
  }
  const result = { read, write: writes }
  unreadKeysCache.set(fp, result)
  return write ? result.write : result.read
}

// The streak state after one row, so a later analysis can resume there.
interface ResumePoint {
  /** Segments changed on consecutive real requests up to this row, with their streak. */
  readonly streaks: ReadonlyMap<string, number>
  /** How many segment names had changed at least once by this row. */
  readonly named: number
  /** How many unstable entries this row and the ones before it recorded. */
  readonly unstable: number
}

/** A session analysis with what an incremental analysis of the same session needs. */
export interface SessionFold {
  readonly analysis: SessionAnalysis
  readonly rows: readonly RequestRow[]
  readonly facts: readonly ContextFactRow[]
  readonly resume: readonly ResumePoint[]
  /** Each segment name that changed, numbered in the order it first changed. */
  readonly names: ReadonlyMap<string, number>
}

/**
 * The session's fingerprints by request id: those stored under the session, or
 * when it has none, each request's own (`perRequest`).
 */
export function sessionFingerprints(ledger: Ledger, rows: readonly RequestRow[]) {
  const ids = new Set(rows.map((row) => row.id))
  const sessionFps = rows[0] ? ledger.getFingerprints(rows[0].sessionID).filter((fp) => ids.has(fp.requestID)) : []
  return sessionFps.length
    ? { perRequest: false, fingerprints: new Map<string, RequestFingerprintData | undefined>(sessionFps.map((fp) => [fp.requestID, fp])) }
    : { perRequest: true, fingerprints: new Map(rows.map((r) => {
      const fp = ledger.getFingerprint(r.id)
      return [r.id, fp?.sessionID === r.sessionID ? fp : undefined]
    })) }
}

// The analysis is a pure fold of the session's rows and facts; it never depends
// on the query window, so it can be cached and the windowed signals below are
// applied at report time.
export function analyzeSession(
  ledger: Ledger,
  rows: readonly RequestRow[],
  facts: readonly ContextFactRow[],
): SessionAnalysis {
  return foldSession(rows, facts, sessionFingerprints(ledger, rows).fingerprints).analysis
}

/**
 * Folds `rows` (in start order, as the ledger returns them). With `from`, rows
 * before that index keep their results from `previous`: a request's verdict
 * depends only on earlier rows, facts at or before its start and their
 * fingerprints, so the caller passes the first row where any of those changed.
 */
export function foldSession(
  rows: readonly RequestRow[],
  facts: readonly ContextFactRow[],
  fingerprints: Map<string, RequestFingerprintData | undefined>,
  resume?: { readonly previous: SessionFold; readonly from: number },
): SessionFold {
  const from = resume === undefined ? 0 : Math.max(0, Math.min(resume.from, rows.length, resume.previous.rows.length))
  const point = from > 0 ? resume?.previous.resume[from - 1] : undefined
  const summaries: RequestSummary[] = point ? resume!.previous.analysis.summaries.slice(0, from) : []
  const unstable: UnstableStreak[] = point ? resume!.previous.analysis.unstable.slice(0, point.unstable) : []
  const points: ResumePoint[] = point ? resume!.previous.resume.slice(0, from) : []
  // Each name keeps the number it got when it first changed, which orders the
  // unstable entries one row records; names first changed after `from` are renumbered.
  const names = new Map(point ? [...resume!.previous.names].filter(([, order]) => order < point.named) : [])
  let streaks: ReadonlyMap<string, number> = point?.streaks ?? new Map()
  const ordered = factsOf(facts)
  const earlier = rows.slice(0, from)
  const responses = new Map(earlier.flatMap((row) => {
    const id = fingerprints.get(row.id)?.responseId
    return id ? [[id, row] as const] : []
  }))

  for (const r of rows.slice(from)) {
    const fp = fingerprints.get(r.id)
    const lastCheckpoint = earlier.findLast((p) => p.kind === "compaction" && p.status === "completed" && p.ended !== undefined && p.ended <= r.started)
    // New observations carry the actual history epoch. Legacy rows can identify the
    // first useful step following a completed compaction without a fact-time join.
    const boundary = r.observation?.historyEpoch === undefined && r.kind !== "compaction" ? lastCheckpoint?.ended : undefined
    const eligible = (p: RequestRow) => p.sessionID === r.sessionID && p.provider === r.provider && p.model === r.model &&
      p.observation?.historyEpoch === r.observation?.historyEpoch && (boundary === undefined || p.started >= boundary) &&
      p.status === "completed" && p.ended !== undefined && p.ended <= r.started && !p.isTitle &&
      (p.kind !== "generate" || r.kind === "generate")
    // An explicit branch link never falls back to its sibling. Unlinked
    // lookup is deliberately bounded; missing older context remains unknown.
    const previous = earlier.filter(eligible).reduce<RequestRow | undefined>((latest, p) => !latest || p.ended! > latest.ended! ? p : latest, undefined)
    const lastRealIndex = earlier.findLastIndex((p) => p.kind !== "ping" && !p.isTitle)
    const lastReal = earlier[lastRealIndex]
    const last = contextBaseline(earlier, r)
    const between = factsBetween(ordered, last?.started ?? 0, r.started)

    // 1. Diff: calculate prefix diff and expected tokens
    const { diff, expected: anchor, changed } = diffStep(
      previous,
      previous ? fingerprints.get(previous.id) : undefined,
      fp,
    )
    const measured = measurement(r)
    const expected = anchor !== undefined
      ? measured.input === undefined ? anchor : Math.min(anchor, measured.input)
      : undefined

    // 3. Cause: determine cache verdict, root cause, confidence and evidence
    const cause = causeStep(r, previous, last, between, diff, changed, expected, cacheLifetime(r, fp))
    const compactionBase = r.kind === "compaction" ? earlier.findLast((p) => eligible(p) && p.kind === "step") : undefined
    const invariant = r.kind === "compaction" ? compactionAppend(compactionBase && fingerprints.get(compactionBase.id), fp,
      r.observation?.compaction?.selectedStrategy ?? (fp?.optionsKeys.compaction ? "native" : "text-summary")) : undefined

    // 4. Cost: compute miss tokens and re-read cost from recorded pricing
    const cost = costStep(r, expected, ordered)

    const request: MonitorRequest = {
      id: r.id,
      sessionID: r.sessionID,
      kind:
        r.kind === "step" || r.kind === "compaction" || r.kind === "ping" || r.kind === "title" ? r.kind : "generate",
      at: r.started,
      ...(r.messageID === undefined ? {} : { messageID: r.messageID }),
      ...(r.duration === undefined ? {} : { durationMs: r.duration }),
      ...(r.error === undefined ? {} : { error: r.error }),
      ...(r.agent === undefined ? {} : { agent: r.agent }),
      ...(r.provider === undefined ? {} : { provider: r.provider }),
      ...(r.model === undefined ? {} : { model: r.model }),
      ...(r.variant === undefined ? {} : { variant: r.variant }),
      input: r.inputTokens,
      output: r.outputTokens,
      reasoning: r.reasoningTokens,
      cacheRead: r.cacheReadTokens,
      cacheWrite: r.cacheWriteTokens,
      cost: r.cost,
      verdict: cause.verdict,
      outcome: r.status,
      ...(r.observation?.version === 1 && r.observation.compaction ? { compaction: r.observation.compaction } : {}),
      ...(r.observation?.version === 1 && r.observation.promptCacheDiagnostic ? { promptCacheDiagnostic: r.observation.promptCacheDiagnostic } : {}),
      measurement: measured,
      ...(cause.cause === undefined || (cause.verdict === "hit" && cause.cause === "unknown") ? {} : { cause: cause.cause }),
      causeText: cause.causeText,
      confidence: cause.confidence,
      evidence: invariant && !invariant.valid ? `${cause.evidence}; Compaction append invariant violated: ${invariant.segment}` : cause.evidence,
      ...(expected === undefined ? {} : { expected }),
      missTokens: cost.missing,
      ...(cost.missCost === undefined ? {} : { missCost: cost.missCost }),
      pricing: cost.pricing,
    }

    summaries.push({
      request,
      ...(previous
        ? {
            previous: {
              id: previous.id,
              at: previous.started,
              ...(previous.messageID ? { messageID: previous.messageID } : {}),
            },
          }
        : {}),
    })

    // A segment changed on this real request extends its streak; every other
    // segment's streak ends. Three in a row is an unstable prefix, recorded in
    // the order the segments first changed.
    if (r.kind !== "ping" && !r.isTitle) {
      const diffLastReal = lastReal === previous ? diff : diffOf(lastReal && fingerprints.get(lastReal.id), fp)
      const changed = new Set(diffLastReal.changes.filter((c) => c.change === "changed").map((c) => c.name))
      const next = new Map<string, number>()
      for (const name of changed) {
        next.set(name, (streaks.get(name) ?? 0) + 1)
        if (!names.has(name)) names.set(name, names.size)
      }
      streaks = next
      for (const [name, count] of [...next].filter(([, count]) => count >= 3).sort(([a], [b]) => names.get(a)! - names.get(b)!)) {
        unstable.push({
          segment: name,
          streak: count,
          at: r.started,
          requestID: r.id,
          ...(r.agent === undefined ? {} : { agent: r.agent }),
          ...(r.provider === undefined ? {} : { provider: r.provider }),
          ...(r.model === undefined ? {} : { model: r.model }),
        })
      }
    }
    points.push({ streaks, named: names.size, unstable: unstable.length })

    earlier.push(r)
    if (fp?.responseId) responses.set(fp.responseId, r)
  }

  const unread = foldUnread(rows, fingerprints, cacheLifetime, unreadFingerprintKeys, resume?.previous.analysis, from)

  const positions = new Map(rows.map((row, index) => [row.id, index]))
  const work = { details: 0 }
  const detail = (id: string) => {
    const index = positions.get(id)
    if (index === undefined) return
    work.details++
    return requestDetail(rows, ordered, fingerprints, summaries[index]!, index)
  }
  return {
    analysis: {
      summaries,
      detail,
      work,
      get details() { return summaries.map((entry) => detail(entry.request.id)!) },
      unstable, fingerprints, ...unread,
    },
    rows,
    facts,
    resume: points,
    names,
  }
}

function requestDetail(
  rows: readonly RequestRow[],
  facts: Facts,
  fingerprints: Map<string, RequestFingerprintData | undefined>,
  summary: RequestSummary,
  index: number,
): MonitorRequestDetail {
  const r = rows[index]!
  const request = summary.request
  const measured = measurement(r)
  const earlier = rows.slice(0, index)
  const previous = summary.previous ? earlier.find((row) => row.id === summary.previous!.id) : undefined
  const lastRealIndex = earlier.findLastIndex((row) => row.kind !== "ping" && !row.isTitle)
  const lastReal = earlier[lastRealIndex]
  const last = contextBaseline(earlier, r)
  const fp = fingerprints.get(r.id)
  const before = previous ? fingerprints.get(previous.id) : undefined
  const diff = prefixDiff(before, fp)
  const timing = timingStep(r, earlier, lastReal, lastRealIndex, fingerprints, fp, facts, previous)
  const cause = causeStep(r, previous, last, factsBetween(facts, last?.started ?? 0, r.started), diff, reusablePrefixChanged(diff.changes, before, fp), request.expected)
  return {
    ...summary,
    lines: [
      ...(request.promptCacheDiagnostic ? [
        `Provider-reported cache diagnostic (OpenAI Responses v1): ${request.promptCacheDiagnostic.outcome}; reported outcome ${request.promptCacheDiagnostic.reportedOutcome}; reason ${request.promptCacheDiagnostic.reason ?? "unknown"}`,
        `Provider comparison estimates (not actual usage or billing): reusable prefix ${request.promptCacheDiagnostic.comparisonReusableTokens ?? "unknown"}; missed ${request.promptCacheDiagnostic.cacheMissedTokens ?? "unknown"}; comparison baseline unrecorded. Best effort; first classified reason only; does not prove physical eviction or deployment support. Local facts remain independent.`,
      ] : []),
      ...(request.compaction ? [
        ...(request.compaction.configurationWarnings ?? []).map((warning) => `Compaction configuration warning: ${warning}`),
        `Compaction decision at execution: trigger ${request.compaction.trigger}; configured ${request.compaction.configuredStrategy} (${request.compaction.strategySource}); selected ${request.compaction.selectedStrategy}; reason ${request.compaction.selectionReason}; model source ${request.compaction.modelSource ?? "unrecorded"}; model policy ${request.compaction.modelPolicy ?? "unconfigured"}`,
      ] : []),
      ...(measured.scope ? [`Observation scope: ${measured.scope}; invocation ${measured.invocationID}; operation ${measured.operationID}; outcome ${r.status}`] : []),
      request.evidence ?? cause.evidence,
      `Reusable-token estimate: ${request.expected ?? "unknown"}; common content estimate: ${diff.common} tokens (characters, not a lower bound)`,
      `Session ${r.sessionID}; message ${r.messageID ?? "unrecorded"}; request ${r.id}`,
      `Gap ${timing.gap ?? "unknown"}ms; requested/nominal retention ${timing.lifetime ?? "unknown"}ms (not proof of expiry); warming configured ${timing.warming ?? "not recorded"}`,
      request.pricing?.state === "unknown-shortfall"
        ? "Local shortfall and cost scenario unavailable without a comparable measurement"
        : request.missCost === undefined
           ? `Cost scenario unavailable: ${request.pricing?.reason ?? "applicable pricing unknown"}`
           : `Local shortfall estimate ${request.pricing?.shortfall}; differential vs cache-read scenario USD ${request.missCost} (not billed loss or net savings)`,
      ...(request.pricing?.source ? [`Pricing source: ${request.pricing.source}; ${request.pricing.provider}/${request.pricing.model}; fact at ${request.pricing.factAt}; inclusive measured input tier above ${request.pricing.tierAbove ?? "base"}; input/read/write USD per million ${request.pricing.rates?.input ?? "unknown"}/${request.pricing.rates?.read ?? "unknown"}/${request.pricing.rates?.write ?? "unknown"}; ${request.pricing.writeBasis ?? "duration attribution unavailable"}`] : []),
      ...(request.pricing?.state === "priced" ? [`Scenario assumes ${request.pricing.assumedWriteTokens} write and ${request.pricing.assumedNoncachedTokens} noncached shortfall tokens versus the same tokens at the cache-read rate; this is not a measured prefix allocation. Output cost unchanged; full mixed-TTL pricing deferred.`] : []),
    ],
    segments: diff.changes,
    ...(diff.changes[0] ? { firstDivergence: diff.changes[0].name } : {}),
    timing: {
      ...(timing.gap === undefined ? {} : { gapMs: timing.gap }),
      ...(timing.lifetime === undefined ? {} : { lifetimeMs: timing.lifetime }),
      ...(timing.pings.at(-1) ? { lastPingAt: timing.pings.at(-1)!.started } : {}),
      ...(timing.warming === undefined ? {} : { warming: timing.warming }),
    },
    pings: timing.pings.map((p) => ({ at: p.started, cacheRead: p.cacheReadTokens, cost: p.cost, ...(p.error ? { error: p.error } : {}) })),
    accounts: cause.accounts,
    instructions: cause.instructions,
    reverts: cause.reverts,
    ...(request.expected === undefined ? {} : { expectedTokens: request.expected }),
    actualCacheRead: r.cacheReadTokens,
  }
}

export interface WindowedPings {
  readonly sent: number
  readonly cost: number
  readonly followedByHit: number
  readonly followedByMiss: number
  readonly followedByCold: number
  readonly unused: number
  readonly unknown: number
  readonly unknownReasons: Readonly<Record<string, number>>
}

// Windowed signals over a cached session analysis: which pings this window sent
// and whether the next request inside the window hit; and how many written
// tokens were never read before expiry by the as-of cutoff. Agent and model
// selections only count a ping or write whose own request matches them, so a
// filtered query never reports another identity's signal.
export function windowedSessionSignals(
  analysis: SessionAnalysis,
  window: { since: number; until: number },
  filter: { readonly agents?: readonly string[]; readonly models?: readonly string[]; readonly titles?: boolean } = {},
): {
  readonly unread: number
  readonly unstable: readonly { readonly segment: string; readonly streak: number }[]
  readonly pings: WindowedPings
} {
  const selectedModel = (provider: string | undefined, model: string | undefined) =>
    !filter.models?.length || filter.models.includes(`${provider ?? ""}/${model ?? ""}`)
  const selectedAgent = (agent: string | undefined) => !filter.agents?.length || filter.agents.includes(agent ?? "")
  // Titles are excluded unless asked for: an auxiliary title's writes and reads
  // must not inject unread counts for the main conversation.
  const included = (isTitle: boolean) => filter.titles === true || !isTitle
  let unread = 0
  for (const write of analysis.writes) {
    if (write.at < window.since || write.at >= window.until) continue
    if (!included(write.isTitle)) continue
    if (!selectedModel(write.provider, write.model) || !selectedAgent(write.agent)) continue
    // Not yet expired by the cutoff: it may still be read, so it is not unread.
    if (write.at + write.lifetime > window.until) continue
    const maxRead = unreadGain(analysis.unreadIndex, write, window.until, filter.titles === true)
    unread += Math.max(0, write.tokens - maxRead)
  }

  const inWindow = analysis.summaries.filter(
    (d) =>
      d.request.at >= window.since &&
      d.request.at < window.until &&
      (filter.titles === true || d.request.kind !== "title") &&
      selectedModel(d.request.provider, d.request.model) &&
      selectedAgent(d.request.agent),
  )
  const pings = inWindow.filter((d) => d.request.kind === "ping")
  let followedByHit = 0
  let followedByMiss = 0
  let followedByCold = 0
  let unused = 0
  let unknown = 0
  const unknownReasons: Record<string, number> = {}
  let cost = 0
  for (const ping of pings) {
    cost += ping.request.cost
    // Only a next request inside this window under the same selection describes
    // the ping's effect; an excluded request belongs to another query.
    const next = inWindow.find(
      (d) => d.request.at > ping.request.at && d.request.kind !== "ping" && d.request.kind !== "title",
    )
    if (!next) { unused++; continue }
    if (ping.request.outcome !== "completed" || ping.request.measurement?.state !== "reported" || next.request.verdict === "none" || next.request.verdict === "error") {
      unknown++
      const reason = ping.request.outcome !== "completed" ? "ping-failed" : ping.request.measurement?.state !== "reported" ? "ping-unmeasured" : "follow-up-unmeasured"
      unknownReasons[reason] = (unknownReasons[reason] ?? 0) + 1
      continue
    }
    if (next.request.verdict === "cold") { followedByCold++; continue }
    if (next.request.verdict === "hit") followedByHit++
    else if (next && isMiss(next.request)) followedByMiss++
  }

  // Unstable prefix: a segment changing on 3+ consecutive requests.
  // We retain each qualifying request's streak and identity, and for each
  // segment select the latest matching entry inside the selected window,
  // so future requests cannot overwrite or erase historical streaks.
  const latestUnstable = new Map<string, { segment: string; streak: number; at: number }>()
  for (const entry of analysis.unstable) {
    if (entry.at < window.since || entry.at >= window.until) continue
    if (!selectedModel(entry.provider, entry.model) || !selectedAgent(entry.agent)) continue
    const existing = latestUnstable.get(entry.segment)
    if (!existing || entry.at >= existing.at) {
      latestUnstable.set(entry.segment, { segment: entry.segment, streak: entry.streak, at: entry.at })
    }
  }

  return {
    unread,
    unstable: [...latestUnstable.values()].map((entry) => ({ segment: entry.segment, streak: entry.streak })),
    pings: { sent: pings.length, cost, followedByHit, followedByMiss, followedByCold, unused, unknown, unknownReasons },
  }
}
