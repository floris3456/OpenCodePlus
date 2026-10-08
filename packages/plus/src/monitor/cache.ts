// Query-time explanations, not another durable model. No prompt content is read.
import type { MonitorRequest, MonitorRequestDetail } from "../rpc.js"
import { Model } from "@opencode/schema/model"
import { Option, Schema } from "effect"
import { canonicalJson, sha256, type CacheControlMarker } from "./fingerprint.js"
import type { ContextFactRow, Ledger, RequestFingerprintData, RequestRow } from "./ledger.js"

type Segment = {
  name: string
  kind: MonitorRequestDetail["segments"][number]["kind"]
  hash: string
  chars: number
  tokens: number
  /** The zero-based message index the name spells ("message 3 (…)" is 2); undefined for other parts. */
  index: number | undefined
}

export const promptTokens = (r: RequestRow) => r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens
export const isMiss = (r: MonitorRequest) => r.verdict === "miss" || r.verdict === "partial"

export function causeWords(cause: string | undefined, changedPart?: string): string {
  if (cause === "compacted") return "after compaction (expected)"
  if (cause === "model-switch") return "model switched"
  if (cause === "agent-switch") return "agent switched"
  if (cause === "prefix-changed") return changedPart ? `prompt changed · ${changedPart}` : "prompt changed"
  if (cause === "cache-expired") return "cache expired"
  if (cause === "account-changed") return "account changed"
  if (cause === "account-changed-compacted-first") return "account changed · compacted first"
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
  const system = fp.systemParts.map((p) => ({
    name: `system part ${p.source}`,
    kind: "system" as const,
    hash: p.hash,
    chars: p.chars,
    tokens: p.estimatedTokens,
    index: undefined,
  }))
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
      const name = `message ${p.idx + 1} (${p.kind ?? p.role})`
      return {
        name,
        kind: "message" as const,
        hash: p.prefixHash,
        chars: p.chars,
        tokens: p.estimatedTokens,
        // A plain index spells itself; anything else is read back from the name.
        index: Number.isSafeInteger(p.idx) && p.idx >= 0 ? p.idx : messageIndex(name),
      }
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
    if (a[i]!.name !== b[j]!.name || a[i]!.hash !== b[j]!.hash) return false
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
function reusableOf(before: RequestFingerprintData | undefined, after: RequestFingerprintData | undefined): boolean {
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
  if (last >= 0 && (a[last]!.hash !== b[last]!.hash || a[last]!.name !== b[last]!.name)) return false
  return a.every((part, i) => part.hash === b[i]!.hash && part.name === b[i]!.name)
}

export function prefixDiff(before: RequestFingerprintData | undefined, after: RequestFingerprintData | undefined) {
  if (!before || !after) {
    return { known: false, append: false, reusable: false, common: 0, changes: [] as MonitorRequestDetail["segments"] }
  }
  const aInfo = getSegmentInfo(before)
  const bInfo = getSegmentInfo(after)
  const a = aInfo.segments
  const b = bInfo.segments

  if (before.previousResponseId && !after.previousResponseId) {
    return { known: true, append: false, reusable: false, common: 0, changes: [{
      name: "previous_response_id", kind: "marker" as const, change: "removed" as const,
      before: { hash: before.previousResponseId, chars: 0, tokens: 0 },
    }] }
  }

  if (after.protocol === "openai-responses" && after.previousResponseId) {
    if (before.responseId === after.previousResponseId) {
      if (samePrefix(aInfo, bInfo))
        return { known: true, append: true, reusable: true, common: aInfo.totalTokens, changes: [] }
    } else {
      return { known: true, append: false, reusable: false, common: 0, changes: [{
        name: "previous_response_id", kind: "marker" as const, change: "changed" as const,
        ...(before.previousResponseId ? { before: { hash: before.previousResponseId, chars: 0, tokens: 0 } } : {}),
        after: { hash: after.previousResponseId, chars: 0, tokens: 0 },
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

  const end = a.findIndex((p, i) => p.hash !== b[i]?.hash || p.name !== b[i]?.name)
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
            after: { hash: p.hash, chars: p.chars, tokens: p.tokens },
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

  // Parts before the first difference are equal.
  for (let i = commonIdx; i < a.length; i++) {
    const p = a[i]!
    const next = b[i]
    if (p.name === next?.name && p.hash === next.hash) continue
    changes.push({
      name: p.name,
      kind: p.kind,
      change: next?.name === p.name ? "changed" : "removed",
      before: value(p),
      ...(next?.name === p.name ? { after: value(next) } : {}),
    })
    if (next && next.name !== p.name) {
      changes.push({ name: next.name, kind: next.kind, change: "added", after: value(next) })
    }
  }

  for (let i = a.length; i < b.length; i++) {
    const p = b[i]!
    if (p.kind !== "message") {
      changes.push({
        name: p.name,
        kind: p.kind,
        change: "added",
        after: { hash: p.hash, chars: p.chars, tokens: p.tokens },
      })
    }
  }

  return {
    known: true,
    append: false,
    reusable: false,
    common,
    changes,
  }
}

/** Conservative idle lifetime, per README; unknown/disk-cache TTL stays unknown. */
export function cacheLifetime(r: RequestRow, fp?: RequestFingerprintData): number | undefined {
  const ttl = fp?.optionsKeys["prompt_cache_options.ttl"]
  if (ttl === sha256(canonicalJson("24h"))) return 86_400_000
  if (ttl === sha256(canonicalJson("1h"))) return 3_600_000
  if (ttl === sha256(canonicalJson("30m"))) return 1_800_000
  if (fp?.cacheControl?.some((m) => m.ttl === "1h")) return 3_600_000
  if (/anthropic/i.test(r.provider ?? "") || fp?.protocol === "anthropic-messages") return 300_000
  if (/deepseek|gemini|google|zai|mistral/i.test(`${r.provider}/${r.model}`)) return undefined
  if (fp?.optionsKeys.prompt_cache_retention === sha256(canonicalJson("24h"))) return 86_400_000
  if (r.provider === "openai" && /gpt-(?:[6-9]|5\.[6-9])/.test(r.model ?? "")) return 1_800_000
  if (/openai|cliproxy|cpa/i.test(r.provider ?? "") || fp?.protocol.startsWith("openai")) return 300_000
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

// The reusable prefix a completed request left behind: the tokens it actually
// read back, or — when it only created the prefix (a cold write) — the tokens
// it wrote. An errored or usage-less request leaves nothing.
function warmPrefixTokens(previous: RequestRow | undefined): number {
  if (!previous) return 0
  return previous.cacheReadTokens > 0 ? previous.cacheReadTokens : previous.cacheWriteTokens
}

type Diff = ReturnType<typeof prefixDiff>

// One diff per pair of fingerprint objects. An analysis compares a request with
// its previous, last real and refreshing requests and every write with its
// later reads; a session's unchanged fingerprints keep their objects across
// incremental analyses, so their diffs are reused too.
const diffCache = new WeakMap<RequestFingerprintData, WeakMap<RequestFingerprintData, Diff>>()
// Where only reuse matters (a refreshing request, a write's later reads), the verdict alone.
const reuseCache = new WeakMap<RequestFingerprintData, WeakMap<RequestFingerprintData, boolean>>()

function diffOf(before: RequestFingerprintData | undefined, after: RequestFingerprintData | undefined): Diff {
  if (!before || !after) return prefixDiff(before, after)
  const known = diffCache.get(before) ?? new WeakMap<RequestFingerprintData, Diff>()
  diffCache.set(before, known)
  const cached = known.get(after)
  if (cached) return cached
  const diff = prefixDiff(before, after)
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
  previousWarm: RequestRow | undefined,
): DiffStep {
  const diff = diffOf(previous && previousFp, fp)
  const warm = warmPrefixTokens(previousWarm)
  const expected = !diff.known
    ? undefined
    : diff.append && previous && promptTokens(previous) > 0
      ? promptTokens(previous)
      : // A reused prefix measured by the earlier request's actual cache read is
        // the honest size when its uncached tail (a ping's private prompt) was
        // replaced: the provider cached exactly that much.
        diff.reusable && previous && previous.cacheReadTokens > 0
        ? previous.cacheReadTokens
        : // The last request that reported cache usage measured the prefix the
          // provider actually holds; a segment estimate is a lower bound. Take
          // whichever is larger, so rolling markers (common 0) and a partial
          // diff both report the real reusable size.
          warm > diff.common
          ? warm
          : diff.common
  return { diff, expected, changed: reusablePrefixChanged(diff.changes, previousFp, fp) }
}

// The last completed request of the same identity that reported any cache
// usage. It is the baseline for a full or partial bust: an errored ping or a
// usage-less request cannot have warmed or measured the prefix.
function previousWarmRequest(r: RequestRow, earlier: readonly RequestRow[]): RequestRow | undefined {
  return earlier.findLast(
    (p) =>
      p.status === "completed" &&
      p.ended !== undefined &&
      !p.isTitle &&
      p.provider === r.provider &&
      p.model === r.model &&
      p.variant === r.variant &&
      p.agent === r.agent &&
      (p.cacheReadTokens > 0 || p.cacheWriteTokens > 0),
  )
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
  // Only a genuinely completed, successful request of the same provider, model,
  // variant and agent can have refreshed the reusable prefix. A running
  // (unfinished) or error ping, or one under a different identity, cannot.
  const healthyCompatible = (p: RequestRow) =>
    p.status === "completed" &&
    p.ended !== undefined &&
    p.provider === r.provider &&
    p.model === r.model &&
    p.variant === r.variant &&
    p.agent === r.agent
  // Rolling Anthropic breakpoints move to the newest message on every step, so
  // no two wire bodies ever compare as reusable and the fingerprint link below
  // finds nothing. A completed request that reported cache usage still warmed
  // the provider's prefix, so it anchors the idle gap when no reusable link is
  // known. An errored or usage-less request did not.
  const lastWarmIndex = earlier.findLastIndex(
    (p) => healthyCompatible(p) && (p.cacheReadTokens > 0 || p.cacheWriteTokens > 0),
  )
  const lastWarm = earlier[lastWarmIndex]
  // The gap runs from the latest start among the refreshing request, a
  // keep-alive that read the cache back and the last warm request. Rows are in
  // start order, so a refreshing request at or before the last warm one cannot
  // move that start: it is searched for only after it (searching all of them
  // diffed every pair of requests). A keep-alive that read the cache is itself
  // a warm request, so it never moves the start either.
  const refreshes = (p: RequestRow) => healthyCompatible(p) && reusableOf(fingerprints.get(p.id), fp)
  const refreshed = previous && refreshes(previous) ? previous : findLastAfter(earlier, lastWarmIndex, refreshes)
  const gap = previous
    ? r.started -
      // Prefer the latest request that can actually have refreshed the prefix.
      // Only when none can (a session's first request) fall back to the
      // previous request's start.
      (Math.max(refreshed?.started ?? 0, lastWarm?.started ?? 0) || previous.started)
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

// The last row after position `after` that matches.
function findLastAfter(rows: readonly RequestRow[], after: number, match: (row: RequestRow) => boolean) {
  for (let i = rows.length - 1; i > after; i--) {
    if (match(rows[i]!)) return rows[i]
  }
  return undefined
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
  /** Exact reusable tokens not read when the drop-based partial rule applies. */
  readonly missOverride: number | undefined
}

function causeStep(
  r: RequestRow,
  previous: RequestRow | undefined,
  last: RequestRow | undefined,
  earlier: readonly RequestRow[],
  between: readonly ContextFactRow[],
  diff: ReturnType<typeof prefixDiff>,
  changed: boolean,
  expected: number | undefined,
  warm: RequestRow | undefined,
  timing: TimingStep,
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
  const compacted = compactions.length > 0
  const quotaSwitchCompacted = compacted && compactions.some((f) => f.detail?.["quota.switch"] === true)
  const switched =
    last !== undefined && (last.provider !== r.provider || last.model !== r.model || last.variant !== r.variant)
  const agent = last !== undefined && last.agent !== r.agent
  const cold = !previous || compacted || switched || agent
  // A request still running has no usage yet. Judging its zero cache read
  // against the expected prefix called every in-flight step a miss, so an
  // agent querying its own chat always saw its current step as one.
  if (!cold && r.status === "running")
    return {
      accounts,
      instructions,
      reverts,
      verdict: "none",
      cause: "unknown",
      causeText: "unknown",
      confidence: "unknown",
      evidence: "Request still running; no usage reported yet",
      missOverride: undefined,
    }
  // An errored request carries an error and no usage: it is neither a hit nor
  // a cache verdict. Give it its own outcome so it is excluded from the hit
  // rate and never counted as a cache win.
  if (r.status === "error")
    return {
      accounts,
      instructions,
      reverts,
      verdict: "error",
      cause: undefined,
      causeText: "unknown",
      confidence: "unknown",
      evidence: "Request failed; no cache usage was reported",
      missOverride: undefined,
    }

  const reported =
    r.cacheReadTokens > 0 ||
    r.cacheWriteTokens > 0 ||
    earlier.some(
      (p) => p.provider === r.provider && p.model === r.model && (p.cacheReadTokens > 0 || p.cacheWriteTokens > 0),
    )

  // The reusable prefix the last successful request left behind, whether it
  // read it back or only created it with a cold write. Rolling Anthropic
  // breakpoints mean reads only ever grow along a session's prefix, so a
  // smaller read this time is prefix the provider did not reuse.
  const warmRead = warm ? warmPrefixTokens(warm) : 0
  const drop = warmRead > 0 ? warmRead - r.cacheReadTokens : 0
  const expired =
    !cold && timing.gap !== undefined && timing.lifetime !== undefined && timing.gap > timing.lifetime
  const pingsFailed = timing.pings.filter((p) => p.status === "error").length

  const verdict: MonitorRequest["verdict"] = cold
    ? "cold"
    : !reported
      ? "none"
      : // A full bust: the previous warm prefix was not read at all, so the
        // provider reused none of it (whether it reported the rewrite as fresh
        // input or as a cache write).
        r.cacheReadTokens === 0 && warmRead > 0
        ? "miss"
        : // A partial bust: the prefix shrank. A small drop (below one
          // cacheable block) is rounding, not a lost prefix.
          drop >= 1024
          ? "partial"
          : expected !== undefined && expected >= 1024 && r.cacheReadTokens < expected * 0.5
            ? "miss"
            : expected !== undefined && expected >= 1024 && r.cacheReadTokens < expected * 0.9
              ? "partial"
              : "hit"

  const cause: MonitorRequest["cause"] = quotaSwitchCompacted
    ? "account-changed-compacted-first"
    : compacted
      ? "compacted"
      : switched
        ? "model-switch"
        : agent
          ? "agent-switch"
          : changed
            ? "prefix-changed"
            : expired && verdict !== "hit" && (diff.reusable || warmRead > 0)
              ? "cache-expired"
              : accounts.length
                ? "account-changed"
                : "unknown"

  const confidence: MonitorRequest["confidence"] =
    cause === "unknown" ? "unknown" : cause === "cache-expired" || cause === "account-changed" ? "likely" : "certain"

  const firstNamed = diff.changes.find((c) => c.name !== "cache markers") ?? diff.changes[0]
  const causeText = causeWords(cause, firstNamed?.name)
  const evidence =
    cause === "account-changed-compacted-first"
      ? "First request after compaction armed by provider account switch; cold start expected"
      : cause === "compacted"
        ? "First request after compaction; cold start expected"
      : cause === "model-switch"
        ? `Model / variant switched: ${last?.provider}/${last?.model}/${last?.variant ?? "default"} → ${r.provider}/${r.model}/${r.variant ?? "default"}`
        : cause === "agent-switch"
          ? `Agent switched: ${last?.agent} → ${r.agent}`
          : cause === "prefix-changed"
            ? `${firstNamed?.name} ${firstNamed?.change}${instructions.length ? `; instruction update: ${instructions.flatMap((i) => i.keys).join(", ")}` : ""}${reverts.length ? "; revert coincides" : ""}`
            : cause === "cache-expired"
              ? `Reusable prefix unchanged; gap ${timing.gap}ms since the last successful request exceeds lifetime ${timing.lifetime}ms; keep-alive pings ${timing.pings.length === 0 ? "none" : `${pingsFailed}/${timing.pings.length} failed`}; warming ${timing.warming ?? "not recorded"}`
              : cause === "account-changed"
                ? "Provider account changed between requests"
                : verdict === "miss" && r.cacheReadTokens === 0 && warmRead > 0
                  ? `Reusable prefix of ${warmRead} tokens read 0 times (${r.cacheWriteTokens} written); provider-side eviction or routing`
                  : !previous
                    ? "First recorded request; cold start expected"
                    : !diff.known
                      ? "Fingerprint unavailable; provider-side eviction or routing cannot be determined"
                      : `Reusable prefix not fully reused${timing.gap !== undefined && timing.lifetime !== undefined && timing.gap <= timing.lifetime ? ", within cache lifetime" : ""}; provider-side eviction or routing`

  return {
    accounts,
    instructions,
    reverts,
    verdict,
    cause,
    causeText,
    confidence,
    evidence,
    // A partial bust's exact unreused prefix is the read drop; the segment
    // estimate would undercount it because the provider rewrote far less. A
    // full bust needs no override: `expected` already carries the warm prefix.
    missOverride: verdict === "partial" && drop >= 1024 ? drop : undefined,
  }
}

interface CostStep {
  readonly missing: number
  readonly missCost: number | undefined
}

function costStep(
  r: RequestRow,
  verdict: MonitorRequest["verdict"],
  expected: number | undefined,
  missOverride: number | undefined,
  facts: Facts,
): CostStep {
  const missing =
    verdict === "miss" || verdict === "partial"
      ? missOverride ?? Math.min(r.inputTokens + r.cacheWriteTokens, Math.max(0, (expected ?? 0) - r.cacheReadTokens))
      : 0
  // Nothing missed costs nothing; the recorded pricing is read only for a miss.
  if (missing === 0) return { missing, missCost: 0 }
  const pricing = lastFact(
    facts,
    r.started,
    (f) =>
      f.kind === "pricing" && f.at <= r.started && f.detail?.provider === r.provider && f.detail?.model === r.model,
  )
  const rates = Option.getOrUndefined(Schema.decodeUnknownOption(Schema.Array(Model.Cost))(pricing?.detail?.rates))
  const rate = rates
    ?.filter((c) => !c.tier || promptTokens(r) > c.tier.size)
    .toSorted((a, b) => (b.tier?.size ?? 0) - (a.tier?.size ?? 0))[0]
  const written = Math.min(missing, r.cacheWriteTokens)
  const missCost =
    missing === 0 ? 0 : rate ? (written * rate.cache.write + (missing - written) * rate.input) / 1_000_000 : undefined

  return { missing, missCost }
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
  readonly details: MonitorRequestDetail[]
  readonly unstable: readonly UnstableStreak[]
  readonly fingerprints: Map<string, RequestFingerprintData | undefined>
  readonly writes: readonly UnreadWrite[]
  readonly reads: readonly UnreadRead[]
}

export interface CompatibleRead {
  readonly at: number
  readonly gained: number
  readonly isTitle: boolean
}

interface UnreadWrite {
  readonly at: number
  readonly tokens: number
  readonly cacheRead: number
  readonly lifetime: number
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly agent: string | undefined
  readonly isTitle: boolean
  readonly fp: RequestFingerprintData | undefined
  readonly reads: readonly CompatibleRead[]
}

interface UnreadRead {
  readonly at: number
  readonly cacheRead: number
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly agent: string | undefined
  readonly isTitle: boolean
  readonly fp: RequestFingerprintData | undefined
}

function findFirstReadAfter(reads: readonly UnreadRead[], time: number): number {
  let low = 0
  let high = reads.length
  while (low < high) {
    const mid = (low + high) >> 1
    if (reads[mid]!.at <= time) {
      low = mid + 1
    } else {
      high = mid
    }
  }
  return low
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
  const sessionFps = rows[0] ? ledger.getFingerprints(rows[0].sessionID) : []
  return sessionFps.length
    ? { perRequest: false, fingerprints: new Map<string, RequestFingerprintData | undefined>(sessionFps.map((fp) => [fp.requestID, fp])) }
    : { perRequest: true, fingerprints: new Map(rows.map((r) => [r.id, ledger.getFingerprint(r.id)])) }
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
  const details: MonitorRequestDetail[] = point ? resume!.previous.analysis.details.slice(0, from) : []
  const unstable: UnstableStreak[] = point ? resume!.previous.analysis.unstable.slice(0, point.unstable) : []
  const points: ResumePoint[] = point ? resume!.previous.resume.slice(0, from) : []
  // Each name keeps the number it got when it first changed, which orders the
  // unstable entries one row records; names first changed after `from` are renumbered.
  const names = new Map(point ? [...resume!.previous.names].filter(([, order]) => order < point.named) : [])
  let streaks: ReadonlyMap<string, number> = point?.streaks ?? new Map()
  const ordered = factsOf(facts)
  const earlier = rows.slice(0, from)

  for (const r of rows.slice(from)) {
    const fp = fingerprints.get(r.id)
    const linked = fp?.previousResponseId
      ? earlier.findLast((p) => p.provider === r.provider && p.model === r.model && fingerprints.get(p.id)?.responseId === fp.previousResponseId)
      : undefined
    const previous = linked ?? earlier.findLast((p) => p.provider === r.provider && p.model === r.model)
    const lastRealIndex = earlier.findLastIndex((p) => p.kind !== "ping" && !p.isTitle)
    const lastReal = earlier[lastRealIndex]
    const last = r.kind === "ping" || r.isTitle ? earlier.at(-1) : lastReal
    const between = factsBetween(ordered, last?.started ?? 0, r.started)

    // 1. Diff: calculate prefix diff and expected tokens
    const warm = previousWarmRequest(r, earlier)
    const { diff, expected, changed } = diffStep(
      previous,
      previous ? fingerprints.get(previous.id) : undefined,
      fp,
      warm,
    )

    // 2. Timing: compute gap, cache lifetime, pings and warming status
    const timing = timingStep(r, earlier, lastReal, lastRealIndex, fingerprints, fp, ordered, previous)

    // 3. Cause: determine cache verdict, root cause, confidence and evidence
    const cause = causeStep(r, previous, last, earlier, between, diff, changed, expected, warm, timing)

    // 4. Cost: compute miss tokens and re-read cost from recorded pricing
    const cost = costStep(r, cause.verdict, expected, cause.missOverride, ordered)

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
      ...(cause.cause === undefined || (cause.verdict === "hit" && cause.cause === "unknown") ? {} : { cause: cause.cause }),
      causeText: cause.causeText,
      confidence: cause.verdict === "hit" && expected !== undefined ? "certain" : cause.confidence,
      evidence:
        cause.verdict === "hit" && cause.cause === "unknown"
          ? `Cache read ${r.cacheReadTokens}; expected reusable prefix ${expected ?? "unknown"} tokens${expected !== undefined && expected < 1024 ? "; below the 1024-token miss threshold" : ""}`
          : cause.evidence,
      ...(expected === undefined ? {} : { expected }),
      missTokens: cost.missing,
      ...(cost.missCost === undefined ? {} : { missCost: cost.missCost }),
    }

    const lines = [
      request.evidence ?? cause.evidence,
      `Expected reusable prefix: ${expected ?? "unknown"} tokens (${diff.append ? "previous real prompt usage" : diff.reusable ? "measured through the marked cache boundary" : "segment-size estimate"}); actual cache read: ${r.cacheReadTokens}`,
      `Session ${r.sessionID}; message ${r.messageID ?? "unrecorded"}; request ${r.id}`,
      `Gap ${timing.gap ?? "unknown"}ms; lifetime ${timing.lifetime ?? "unknown"}ms; warming ${timing.warming ?? "not recorded"}`,
      cost.missCost === undefined
        ? "Miss cost unavailable: per-token pricing was not recorded"
        : `Miss tokens ${cost.missing}; processing cost USD ${cost.missCost} (not net savings)`,
    ]

    details.push({
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
      lines,
      segments: diff.changes,
      ...(diff.changes[0] ? { firstDivergence: diff.changes[0].name } : {}),
      timing: {
        ...(timing.gap === undefined ? {} : { gapMs: timing.gap }),
        ...(timing.lifetime === undefined ? {} : { lifetimeMs: timing.lifetime }),
        ...(timing.pings.at(-1) ? { lastPingAt: timing.pings.at(-1)!.started } : {}),
        ...(timing.warming === undefined ? {} : { warming: timing.warming }),
      },
      pings: timing.pings.map((p) => ({
        at: p.started,
        cacheRead: p.cacheReadTokens,
        cost: p.cost,
        ...(p.error ? { error: p.error } : {}),
      })),
      accounts: cause.accounts,
      instructions: cause.instructions,
      reverts: cause.reverts,
      ...(expected === undefined ? {} : { expectedTokens: expected }),
      actualCacheRead: r.cacheReadTokens,
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
  }

  const reads: UnreadRead[] = []
  for (const r of rows) {
    if (r.cacheReadTokens <= 0) continue
    reads.push({
      at: r.started,
      cacheRead: r.cacheReadTokens,
      provider: r.provider,
      model: r.model,
      agent: r.agent,
      isTitle: r.isTitle,
      fp: fingerprints.get(r.id),
    })
  }

  // Precompute immutable write/read compatibility and token gains inside the
  // revision fold. Report-time windowedSessionSignals applies cutoff, window,
  // title inclusion, and identity filters cheaply over these numeric records.
  const writes: UnreadWrite[] = []
  for (const r of rows) {
    if (r.cacheWriteTokens <= 0) continue
    const fp = fingerprints.get(r.id)
    const lifetime = cacheLifetime(r, fp)
    if (lifetime === undefined) continue

    const compatibleReads: CompatibleRead[] = []
    const startIdx = findFirstReadAfter(reads, r.started)
    for (let i = startIdx; i < reads.length; i++) {
      const read = reads[i]!
      if (read.at > r.started + lifetime) break
      if (read.provider !== r.provider || read.model !== r.model) continue
      const gained = read.cacheRead - r.cacheReadTokens
      if (gained <= 0) continue
      if (reusableOf(fp, read.fp)) {
        compatibleReads.push({
          at: read.at,
          gained,
          isTitle: read.isTitle,
        })
        if (!read.isTitle && gained >= r.cacheWriteTokens) break
      }
    }

    writes.push({
      at: r.started,
      tokens: r.cacheWriteTokens,
      cacheRead: r.cacheReadTokens,
      lifetime,
      provider: r.provider,
      model: r.model,
      agent: r.agent,
      isTitle: r.isTitle,
      fp,
      reads: compatibleReads,
    })
  }

  return {
    analysis: { details, unstable, fingerprints, writes, reads },
    rows,
    facts,
    resume: points,
    names,
  }
}

export interface WindowedPings {
  readonly sent: number
  readonly cost: number
  readonly followedByHit: number
  readonly followedByMiss: number
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
    let maxRead = 0
    for (const read of write.reads) {
      if (read.at >= window.until) break
      if (!included(read.isTitle)) continue
      if (read.gained > maxRead) maxRead = read.gained
      if (maxRead >= write.tokens) break
    }
    unread += Math.max(0, write.tokens - maxRead)
  }

  const inWindow = analysis.details.filter(
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
  let cost = 0
  for (const ping of pings) {
    cost += ping.request.cost
    // Only a next request inside this window under the same selection describes
    // the ping's effect; an excluded request belongs to another query.
    const next = inWindow.find(
      (d) => d.request.at > ping.request.at && d.request.kind !== "ping" && d.request.kind !== "title",
    )
    if (next?.request.verdict === "hit") followedByHit++
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
    pings: { sent: pings.length, cost, followedByHit, followedByMiss },
  }
}
