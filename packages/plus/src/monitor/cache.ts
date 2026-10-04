// Query-time explanations, not another durable model. No prompt content is read.
import type { MonitorRequest, MonitorRequestDetail } from "../rpc.js"
import { Model } from "@opencode/schema/model"
import { Option, Schema } from "effect"
import { canonicalJson, sha256 } from "./fingerprint.js"
import type { ContextFactRow, Ledger, RequestFingerprintData, RequestRow } from "./ledger.js"

type Segment = {
  name: string
  kind: MonitorRequestDetail["segments"][number]["kind"]
  hash: string
  chars: number
  tokens: number
}

export const promptTokens = (r: RequestRow) => r.inputTokens + r.cacheReadTokens + r.cacheWriteTokens
export const isMiss = (r: MonitorRequest) => r.verdict === "miss" || r.verdict === "partial"

type SegmentInfo = {
  readonly segments: Segment[]
  readonly totalTokens: number
}

const segmentCache = new WeakMap<RequestFingerprintData, SegmentInfo>()

function getSegmentInfo(fp: RequestFingerprintData): SegmentInfo {
  const cached = segmentCache.get(fp)
  if (cached) return cached

  const segs = segments(fp)
  let totalTokens = 0
  for (let i = 0; i < segs.length; i++) {
    totalTokens += segs[i]!.tokens
  }
  const info = { segments: segs, totalTokens }
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
  }))
  const tools = fp.tools.flatMap((p) => [
    {
      name: `tool ${p.name} description`,
      kind: "tool" as const,
      hash: p.descHash,
      chars: p.chars,
      tokens: p.estimatedTokens,
    },
    {
      name: `tool ${p.name} schema`,
      kind: "tool" as const,
      hash: p.schemaHash,
      chars: 0,
      tokens: 0,
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
    }))

  return [
    { name: "protocol", kind: "marker", hash: sha256(fp.protocol), chars: 0, tokens: 0 },
    ...optionEntries,
    {
      name: "cache markers",
      kind: "marker",
      hash: sha256(canonicalJson([fp.cacheKey ?? null, fp.cacheControl ?? []])),
      chars: 0,
      tokens: 0,
    },
    ...(fp.protocol === "anthropic-messages" ? [...tools, ...system] : [...system, ...tools]),
    ...fp.messagePrefixes.map((p) => ({
      name: `message ${p.idx + 1} (${p.kind ?? p.role})`,
      kind: "message" as const,
      hash: p.prefixHash,
      chars: p.chars,
      tokens: p.estimatedTokens,
    })),
  ]
}

export function prefixDiff(before: RequestFingerprintData | undefined, after: RequestFingerprintData | undefined) {
  if (!before || !after) {
    return { known: false, append: false, common: 0, changes: [] as MonitorRequestDetail["segments"] }
  }
  const aInfo = getSegmentInfo(before)
  const bInfo = getSegmentInfo(after)
  const a = aInfo.segments
  const b = bInfo.segments

  const end = a.findIndex((p, i) => p.name !== b[i]?.name || p.hash !== b[i]?.hash)
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

  for (let i = 0; i < a.length; i++) {
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

interface DiffStep {
  readonly diff: ReturnType<typeof prefixDiff>
  readonly expected: number | undefined
}

function diffStep(
  previous: RequestRow | undefined,
  previousFp: RequestFingerprintData | undefined,
  fp: RequestFingerprintData | undefined,
): DiffStep {
  const diff = prefixDiff(previous && previousFp, fp)
  const expected = !diff.known
    ? undefined
    : diff.append && previous && promptTokens(previous) > 0
      ? promptTokens(previous)
      : diff.common
  return { diff, expected }
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
  facts: readonly ContextFactRow[],
  previous: RequestRow | undefined,
  previousAppend: boolean,
): TimingStep {
  const pings = earlier.slice(lastRealIndex + 1).filter((p) => p.kind === "ping")
  const goodPing =
    pings.length > 0
      ? pings.findLast(
          (p) => p.status !== "error" && p.cacheReadTokens > 0 && prefixDiff(fingerprints.get(p.id), fp).append,
        )
      : undefined
  const refreshed =
    previous && previous.status !== "error" && previousAppend
      ? previous
      : earlier.findLast(
          (p) =>
            p.status !== "error" &&
            p.provider === r.provider &&
            p.model === r.model &&
            prefixDiff(fingerprints.get(p.id), fp).append,
        )
  const gap = previous
    ? r.started - Math.max(refreshed?.started ?? previous.started, goodPing?.started ?? 0)
    : undefined
  const lifetime = cacheLifetime(r, fp)
  const warmingFact = facts.findLast(
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
  readonly confidence: MonitorRequest["confidence"]
  readonly evidence: string
}

function causeStep(
  r: RequestRow,
  previous: RequestRow | undefined,
  last: RequestRow | undefined,
  earlier: readonly RequestRow[],
  between: readonly ContextFactRow[],
  diff: ReturnType<typeof prefixDiff>,
  expected: number | undefined,
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
  const compacted = between.some((f) => f.kind === "compaction")
  const switched =
    last !== undefined && (last.provider !== r.provider || last.model !== r.model || last.variant !== r.variant)
  const agent = last !== undefined && last.agent !== r.agent
  const cold = !previous || compacted || switched || agent

  const reported =
    r.cacheReadTokens > 0 ||
    r.cacheWriteTokens > 0 ||
    earlier.some(
      (p) => p.provider === r.provider && p.model === r.model && (p.cacheReadTokens > 0 || p.cacheWriteTokens > 0),
    )

  const verdict: MonitorRequest["verdict"] = cold
    ? "cold"
    : !reported
      ? "none"
      : expected !== undefined && expected >= 1024 && r.cacheReadTokens < expected * 0.5
        ? "miss"
        : expected !== undefined && expected >= 1024 && r.cacheReadTokens < expected * 0.9
          ? "partial"
          : "hit"

  const cause: MonitorRequest["cause"] = compacted
    ? "compacted"
    : switched
      ? "model-switch"
      : agent
        ? "agent-switch"
        : diff.changes.length
          ? "prefix-changed"
          : !cold &&
              diff.append &&
              timing.gap !== undefined &&
              timing.lifetime !== undefined &&
              timing.gap > timing.lifetime
            ? "cache-expired"
            : accounts.length
              ? "account-changed"
              : "unknown"

  const confidence: MonitorRequest["confidence"] =
    cause === "unknown" ? "unknown" : cause === "cache-expired" || cause === "account-changed" ? "likely" : "certain"

  const evidence =
    cause === "compacted"
      ? "First request after compaction; cold start expected"
      : cause === "model-switch"
        ? `Model / variant switched: ${last?.provider}/${last?.model}/${last?.variant ?? "default"} → ${r.provider}/${r.model}/${r.variant ?? "default"}`
        : cause === "agent-switch"
          ? `Agent switched: ${last?.agent} → ${r.agent}`
          : cause === "prefix-changed"
            ? `${diff.changes[0]?.name} ${diff.changes[0]?.change}${instructions.length ? `; instruction update: ${instructions.flatMap((i) => i.keys).join(", ")}` : ""}${reverts.length ? "; revert coincides" : ""}`
            : cause === "cache-expired"
              ? `Reusable prefix unchanged; gap ${timing.gap}ms exceeds lifetime ${timing.lifetime}ms; last ping ${timing.pings.at(-1)?.started ?? "none"}; warming ${timing.warming ?? "not recorded"}`
              : cause === "account-changed"
                ? "Provider account changed between requests"
                : !previous
                  ? "First recorded request; cold start expected"
                  : !diff.known
                    ? "Fingerprint unavailable; provider-side eviction or routing cannot be determined"
                    : `Reusable prefix unchanged${timing.gap !== undefined && timing.lifetime !== undefined && timing.gap <= timing.lifetime ? ", within cache lifetime" : ""}; provider-side eviction or routing`

  return { accounts, instructions, reverts, verdict, cause, confidence, evidence }
}

interface CostStep {
  readonly missing: number
  readonly missCost: number | undefined
}

function costStep(
  r: RequestRow,
  verdict: MonitorRequest["verdict"],
  expected: number | undefined,
  facts: readonly ContextFactRow[],
): CostStep {
  const missing =
    verdict === "miss" || verdict === "partial"
      ? Math.min(r.inputTokens + r.cacheWriteTokens, Math.max(0, (expected ?? 0) - r.cacheReadTokens))
      : 0
  const pricing = facts.findLast(
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

export function analyzeSession(ledger: Ledger, rows: readonly RequestRow[], facts: readonly ContextFactRow[]) {
  const sessionFps = rows[0] ? ledger.getFingerprints(rows[0].sessionID) : []
  const fingerprints = sessionFps.length
    ? new Map(sessionFps.map((fp) => [fp.requestID, fp]))
    : new Map(rows.map((r) => [r.id, ledger.getFingerprint(r.id)]))
  const details: MonitorRequestDetail[] = []
  const streaks = new Map<string, number>()
  const unstable = new Map<string, number>()
  const earlier: RequestRow[] = []

  for (const r of rows) {
    const previous = earlier.findLast((p) => p.provider === r.provider && p.model === r.model)
    const lastRealIndex = earlier.findLastIndex((p) => p.kind !== "ping" && !p.isTitle)
    const lastReal = earlier[lastRealIndex]
    const last = r.kind === "ping" || r.isTitle ? earlier.at(-1) : lastReal
    const between = facts.filter((f) => f.at > (last?.started ?? 0) && f.at <= r.started)
    const fp = fingerprints.get(r.id)

    // 1. Diff: calculate prefix diff and expected tokens
    const { diff, expected } = diffStep(previous, previous ? fingerprints.get(previous.id) : undefined, fp)

    // 2. Timing: compute gap, cache lifetime, pings and warming status
    const timing = timingStep(r, earlier, lastReal, lastRealIndex, fingerprints, fp, facts, previous, diff.append)

    // 3. Cause: determine cache verdict, root cause, confidence and evidence
    const cause = causeStep(r, previous, last, earlier, between, diff, expected, timing)

    // 4. Cost: compute miss tokens and re-read cost from recorded pricing
    const cost = costStep(r, cause.verdict, expected, facts)

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
      ...(cause.verdict === "hit" && cause.cause === "unknown" ? {} : { cause: cause.cause }),
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
      `Expected reusable prefix: ${expected ?? "unknown"} tokens (${diff.append ? "previous real prompt usage" : "segment-size estimate"}); actual cache read: ${r.cacheReadTokens}`,
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

    if (r.kind !== "ping" && !r.isTitle) {
      const diffLastReal = lastReal === previous ? diff : prefixDiff(lastReal && fingerprints.get(lastReal.id), fp)
      if (diffLastReal.changes.length > 0 || streaks.size > 0) {
        const changed = new Set(diffLastReal.changes.filter((c) => c.change === "changed").map((c) => c.name))
        for (const name of new Set([...streaks.keys(), ...changed])) {
          const count = changed.has(name) ? (streaks.get(name) ?? 0) + 1 : 0
          streaks.set(name, count)
          if (count >= 3) unstable.set(name, count)
        }
      }
    }

    earlier.push(r)
  }

  const qualifying = rows.filter((r) => r.cacheWriteTokens > 0)
  let unread = 0
  for (const r of qualifying) {
    const fp = fingerprints.get(r.id)
    const lifetime = cacheLifetime(r, fp)
    if (lifetime === undefined) continue
    let maxRead = 0
    for (const later of rows) {
      if (later.started <= r.started) continue
      if (later.started > r.started + lifetime) break
      if (later.cacheReadTokens <= 0 || later.provider !== r.provider || later.model !== r.model) continue
      if (prefixDiff(fp, fingerprints.get(later.id)).append) {
        const read = later.cacheReadTokens - r.cacheReadTokens
        if (read > maxRead) maxRead = read
        if (maxRead >= r.cacheWriteTokens) break
      }
    }
    unread += Math.max(0, r.cacheWriteTokens - maxRead)
  }

  const pingRows = rows.filter((r) => r.kind === "ping")
  let pingsFollowedByHit = 0
  let pingsFollowedByMiss = 0
  let pingCost = 0
  for (const p of pingRows) {
    pingCost += p.cost
    const next = rows.find((r) => r.started > p.started && r.kind !== "ping" && !r.isTitle)
    if (next) {
      const nextDetail = details.find((d) => d.request.id === next.id)
      if (nextDetail?.request.verdict === "hit") pingsFollowedByHit++
      else if (nextDetail && isMiss(nextDetail.request)) pingsFollowedByMiss++
    }
  }

  return {
    details,
    unstable: [...unstable].map(([segment, streak]) => ({
      sessionID: rows[0]!.sessionID,
      segment,
      streak,
    })),
    fingerprints,
    unread,
    pings: {
      sent: pingRows.length,
      cost: pingCost,
      followedByHit: pingsFollowedByHit,
      followedByMiss: pingsFollowedByMiss,
    },
  }
}
