// A generated long Anthropic chat for the Monitor's golden test: about 1,500
// requests whose history grows to about 1,500 messages, with the wire shape the
// fingerprints record for rolling cache breakpoints (the marker sits on each
// request's last history message, so the message it marked differs on the next
// request). It mixes the cases the verdicts depend on: keep-alive pings (some
// failing), idle gaps past the 5-minute cache lifetime, a compaction, a system
// prompt edit, model and agent switches, an account switch, a partial read
// drop, an errored step, a title request and a step still running.
//
// Hashes and sizes come from a seeded generator, so every run writes the same
// ledger rows. The expected verdicts in fixtures/monitor-golden-anthropic.json
// were recorded from the Monitor before its 1.1.18 speed-up.
import { canonicalJson, sha256, type MessagePrefixFingerprint } from "../src/monitor/fingerprint.js"
import type { Ledger, RequestFingerprintData } from "../src/monitor/ledger.js"

export const GOLDEN_SESSION = "ses_golden_anthropic"
const PROVIDER = "cliproxyapi"
const MODEL = "claude-opus-5-5"
const VARIANT = "xhigh"
const T0 = 1_760_000_000_000
const SECOND = 1000
const MINUTE = 60 * SECOND

// mulberry32: small, fast and deterministic.
function random(seed: number) {
  let state = seed
  return () => {
    state = (state + 0x6d2b79f5) | 0
    let t = Math.imul(state ^ (state >>> 15), 1 | state)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

interface Message {
  readonly entry: MessagePrefixFingerprint
  readonly content: string
}

export interface GoldenOptions {
  readonly requests?: number
  readonly seed?: number
}

/** Writes the generated chat into `db` and returns the ids of its requests in order. */
export function writeGoldenSession(db: Ledger, options: GoldenOptions = {}): string[] {
  const total = options.requests ?? 1500
  const next = random(options.seed ?? 1118)
  const ids: string[] = []
  const tools = Array.from({ length: 6 }, (_, i) => ({
    name: `tool${i}`,
    descHash: sha256(`tool${i} description`),
    schemaHash: sha256(`tool${i} schema`),
    chars: 2000,
    estimatedTokens: 500,
  }))
  const optionsKeys = {
    max_tokens: sha256(canonicalJson(32000)),
    thinking: sha256(canonicalJson({ type: "enabled", budget_tokens: 16000 })),
    "thinking.type": sha256(canonicalJson("enabled")),
    "thinking.budget_tokens": sha256(canonicalJson(16000)),
  }
  const fixedTokens = 10_000 + 200 + tools.length * 500
  let system = 0
  let history: Message[] = []
  let chain = ""
  let at = T0
  let lastWarmAt = 0
  let agent = "build"

  const systemParts = () => [
    { source: "base template", hash: sha256(`system v${system}`), chars: 40_000, estimatedTokens: 10_000 },
    { source: "date/environment block", hash: sha256("environment"), chars: 800, estimatedTokens: 200 },
  ]
  const addMessage = () => {
    const idx = history.length
    const content = `m${idx}:${Math.floor(next() * 1e9)}`
    chain = sha256(`${chain}:${content}`)
    const chars = 200 + Math.floor(next() * 3800)
    history.push({
      content,
      entry: {
        idx,
        role: idx % 2 === 0 ? "user" : "assistant",
        kind: idx % 2 === 0 ? "tool_result" : "text+tool_use",
        prefixHash: chain,
        chars,
        estimatedTokens: Math.ceil(chars / 4),
      },
    })
  }
  const resetHistory = () => {
    history = []
    chain = ""
  }
  // Tokens through message `k` (inclusive): the prefix a breakpoint there caches.
  const prefixTokens = (k: number) => fixedTokens + history.slice(0, k + 1).reduce((n, m) => n + m.entry.estimatedTokens, 0)
  // The request's messages: history with the marker on its last message, then an uncached tail.
  const fingerprint = (id: string, tail?: string): RequestFingerprintData => {
    const k = history.length - 1
    const previous = k > 0 ? history[k - 1]!.entry.prefixHash : ""
    const marked = { ...history[k]!.entry, prefixHash: sha256(`${previous}:${history[k]!.content}#cache_control`) }
    const prefixes = [...history.slice(0, k).map((m) => m.entry), marked]
    if (tail !== undefined)
      prefixes.push({ idx: k + 1, role: "user", kind: "text", prefixHash: sha256(`${marked.prefixHash}:${tail}`), chars: 120, estimatedTokens: 30 })
    return {
      requestID: id,
      sessionID: GOLDEN_SESSION,
      protocol: "anthropic-messages",
      systemParts: systemParts(),
      tools,
      optionsHash: sha256(canonicalJson(optionsKeys)),
      optionsKeys,
      messagePrefixes: prefixes,
      cacheControl: [
        { target: "system[0]", type: "ephemeral" },
        { target: `messages[${k}].content[0]`, type: "ephemeral" },
      ],
      bodyHash: sha256(id),
      created: at,
    }
  }
  const record = (input: {
    readonly kind: "step" | "ping" | "compaction" | "title"
    readonly read: number
    readonly write: number
    readonly input?: number
    readonly error?: boolean
    readonly running?: boolean
    readonly model?: string
    readonly provider?: string
    readonly tail?: string
    readonly noFingerprint?: boolean
  }) => {
    const id = `${GOLDEN_SESSION}-${String(ids.length).padStart(5, "0")}`
    ids.push(id)
    db.requestStarted({
      id,
      sessionID: GOLDEN_SESSION,
      messageID: `msg-${id}`,
      kind: input.kind,
      isTitle: input.kind === "title",
      agent,
      provider: input.provider ?? PROVIDER,
      model: input.model ?? MODEL,
      variant: input.model === undefined ? VARIANT : undefined,
      started: at,
    })
    if (!input.noFingerprint) db.requestFingerprint(fingerprint(id, input.tail))
    if (input.running) return
    const duration = 2 * SECOND + Math.floor(next() * 8 * SECOND)
    db.requestEnded(id, {
      ended: at + duration,
      duration,
      status: input.error ? "error" : "completed",
      ...(input.error ? { error: "upstream overloaded" } : {}),
      ...(input.error
        ? {}
        : {
            usage: {
              input: input.input ?? 3,
              output: 200 + Math.floor(next() * 800),
              reasoning: 0,
              cacheRead: input.read,
              cacheWrite: input.write,
              cost: (input.read * 0.5 + input.write * 6.25) / 1_000_000,
            },
          }),
    })
    if (!input.error && (input.read > 0 || input.write > 0) && input.model === undefined) lastWarmAt = at
  }
  const fact = (kind: string, detail: Record<string, unknown> = {}) =>
    db.contextFact({ sessionID: GOLDEN_SESSION, at, kind, detail })

  db.session({ id: GOLDEN_SESSION, agent, directory: "/golden", title: "Golden Anthropic chat" }, T0)
  fact("pricing", { provider: PROVIDER, model: MODEL, rates: [{ input: 5, output: 25, cache: { read: 0.5, write: 6.25 } }] })
  addMessage()
  addMessage()
  record({ kind: "title", read: 0, write: 0, input: 400, provider: PROVIDER, model: "Qwen3.6-35B-A3B-NInfer-MTP3", noFingerprint: true })

  // A step: the cache held the prefix through the previous marker unless it went cold.
  let markedTokens = 0
  const step = (change?: { read?: number; write?: number }) => {
    const k = history.length - 1
    const full = prefixTokens(k)
    const cold = at - lastWarmAt > 5 * MINUTE
    const read = change?.read ?? (cold ? 0 : markedTokens)
    record({ kind: "step", read, write: change?.write ?? full - read })
    markedTokens = full
  }

  while (ids.length < total - 1) {
    const n = ids.length
    at += 2 * SECOND + Math.floor(next() * 38 * SECOND)
    if (n === 40) {
      // A compaction summarises the history; the next step starts a new prefix.
      record({ kind: "compaction", read: markedTokens, write: 900, tail: "summarize" })
      at += 20 * SECOND
      fact("compaction")
      resetHistory()
      addMessage()
      markedTokens = 0
      lastWarmAt = 0
      at += SECOND
      step()
      continue
    }
    if (n === 300) {
      // An instruction edit rewrites the system prompt: only the tools stay cached.
      fact("instruction_update", { keys: ["AGENTS.md"] })
      system++
      at += SECOND
      addMessage()
      step({ read: tools.length * 500, write: prefixTokens(history.length - 1) - tools.length * 500 })
      continue
    }
    if (n === 500) {
      // One step on another model, then back.
      record({ kind: "step", read: 0, write: 0, input: 60_000, provider: PROVIDER, model: "Qwen3.6-35B-A3B-NInfer-MTP3", noFingerprint: true })
      continue
    }
    if (n === 700 || n === 702) {
      agent = n === 700 ? "plan" : "build"
      addMessage()
      step()
      continue
    }
    if (n === 900) {
      fact("account_switch", { from: "Small", to: "Large" })
      at += SECOND
      addMessage()
      step({ read: 0 })
      continue
    }
    if (n === 1100) {
      addMessage()
      step({ read: Math.max(0, markedTokens - 5000) })
      continue
    }
    if (n === 1200) {
      addMessage()
      record({ kind: "step", read: 0, write: 0, error: true })
      continue
    }
    if (next() < 0.035) {
      // An idle gap: keep-alives every 4 minutes, some failing, then the user returns.
      fact("warming", { state: "on", phase: "activity", since: at, until: at + 50 * MINUTE })
      const pings = 1 + Math.floor(next() * 4)
      for (let i = 0; i < pings && ids.length < total - 2; i++) {
        at += 4 * MINUTE
        const failed = next() < 0.15
        record({ kind: "ping", read: failed ? 0 : markedTokens, write: failed ? 0 : 30, input: 10, error: failed, tail: "keep-alive" })
        fact("warming", { state: failed ? "failed" : "on", phase: "warmed", since: at, until: at + 50 * MINUTE })
      }
      at += Math.floor(next() * 7 * MINUTE)
    }
    addMessage()
    if (next() < 0.3) addMessage()
    step()
  }
  at += 5 * SECOND
  addMessage()
  record({ kind: "step", read: 0, write: 0, running: true })
  return ids
}
