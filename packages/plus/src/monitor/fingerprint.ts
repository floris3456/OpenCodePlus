import { createHash } from "node:crypto"
import { estimateTokens } from "./attribution.js"

export interface NamedSystemPart {
  readonly name: string
  readonly text: string
}

export interface SystemPartFingerprint {
  readonly source: string
  readonly hash: string
  readonly chars: number
  readonly estimatedTokens: number
}

export interface ToolFingerprint {
  readonly name: string
  readonly descHash: string
  readonly schemaHash: string
  /** Complete ordered tool definition, not just description/schema. */
  readonly wireHash?: string
  readonly chars: number
  readonly estimatedTokens: number
}

export interface MessagePrefixFingerprint {
  readonly idx: number
  readonly role: string
  readonly kind?: string
  readonly messageId?: string
  readonly prefixHash: string
  /** Independent identity for edit explanations; prefixHash is cumulative. */
  readonly contentHash?: string
  readonly chars: number
  readonly estimatedTokens: number
}

export interface CacheControlMarker {
  readonly target: string
  readonly type: string
  readonly ttl?: string
  readonly wireHash?: string
}

export interface WireFingerprint {
  /** Absent on schema-2 legacy rows; never infer the current meaning. */
  readonly fingerprintVersion?: number
  readonly policyVersion?: number
  /** Wire system shape, independent of source annotations and text splitting. */
  readonly systemHash?: string
  readonly protocol: "openai-responses" | "openai-chat" | "anthropic-messages" | "fallback"
  readonly systemParts: readonly SystemPartFingerprint[]
  readonly tools: readonly ToolFingerprint[]
  readonly optionsHash: string
  readonly optionsKeys: Record<string, string>
  readonly messagePrefixes: readonly MessagePrefixFingerprint[]
  readonly cacheKey?: string
  readonly previousResponseId?: string
  readonly cacheControl?: readonly CacheControlMarker[]
  readonly bodyHash: string
}

export const FINGERPRINT_VERSION = 2
export const FINGERPRINT_POLICY_VERSION = 1

/** Local wire comparison only. No deployment eligibility, minimum or TTL claims.
 * Unknown settings remain comparison constraints, not established miss causes.
 * Even generation settings are retained: a proxy may render them into its prompt.
 */
export const fingerprintPolicy = {
  version: FINGERPRINT_POLICY_VERSION,
  eligibility: "unknown",
  ordering: "wire-only",
  generation: ["temperature", "top_p", "top_k", "max_tokens", "max_completion_tokens", "max_output_tokens", "seed", "frequency_penalty", "presence_penalty"],
  unknown: "retain",
} as const

function wireOptions(body: Record<string, unknown>, structural: readonly string[]) {
  return optionFingerprints(body, Object.keys(body).filter((key) => !structural.includes(key)))
}

// Breakpoints are separately fingerprinted. Moving one is not a content edit.
function contentJson(value: unknown, path = ""): string {
  if (value === null || typeof value !== "object") return canonicalJson(value)
  if (Array.isArray(value)) return `[${value.map((part) => contentJson(part, `${path}[]`)).join(",")}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj).filter((key) => key !== "cache_control" || !["", "[]", "content[]"].includes(path)).sort().map((key) => `${JSON.stringify(key)}:${contentJson(obj[key], path ? `${path}.${key}` : key)}`).join(",")}}`
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null"
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`
}

export function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex").slice(0, 16)
}

/** Provider errors may echo prompts, URLs or credentials. Never persist their text. */
export function errorFingerprint(error: unknown): string {
  const value = error !== null && typeof error === "object" ? error as Record<string, unknown> : {}
  const message = typeof error === "string" ? error : String(value.message ?? "")
  const name = String(value.type ?? value.name ?? "Error")
  return JSON.stringify({
    type: /^[\w.:-]{1,64}$/.test(name) ? name : "Error",
    ...(typeof value.status === "number" ? { status: value.status } : {}),
    hash: sha256(message), chars: message.length,
  })
}

function systemFingerprints(text: string, idx: number, namedParts?: ReadonlyArray<NamedSystemPart>): SystemPartFingerprint[] {
  const parts: SystemPartFingerprint[] = []
  const add = (text: string, source: string) => {
    if (text.length) parts.push({ source, hash: sha256(text), chars: text.length, estimatedTokens: estimateTokens(text.length) })
  }
  let offset = 0
  for (const part of namedParts ?? []) {
    if (!part.text) continue
    const start = text.indexOf(part.text, offset)
    if (start < 0) continue
    add(text.slice(offset, start), `system remainder:${idx}:${parts.length}`)
    add(part.text, part.name)
    offset = start + part.text.length
  }
  add(text.slice(offset), parts.length ? `system remainder:${idx}:${parts.length}` : nameSystemPart(text, idx))
  return parts
}

const markerPathTokens = new Set(["system", "tools", "messages", "input", "content", "function"])

function cacheMarkers(body: Record<string, unknown>): CacheControlMarker[] {
  const markers: CacheControlMarker[] = []
  const visit = (value: unknown, target: string) => {
    if (!value || typeof value !== "object") return
    if (Array.isArray(value)) return value.forEach((part, i) => visit(part, `${target}[${i}]`))
    const obj = value as Record<string, unknown>
    const cc = obj.cache_control as { type?: unknown; ttl?: unknown } | undefined
    if (cc && typeof cc === "object") markers.push({
      target,
      type: cc.type === "ephemeral" ? "ephemeral" : "unknown",
      ...(cc.ttl === "5m" || cc.ttl === "1h" ? { ttl: cc.ttl } : {}),
      wireHash: sha256(canonicalJson(cc)),
    })
    Object.entries(obj).filter(([key]) => key !== "cache_control").forEach(([key, child]) => {
      const label = markerPathTokens.has(key) ? key : `unknown[${sha256(key)}]`
      visit(child, target === "top" ? label : `${target}.${label}`)
    })
  }
  visit(body, "top")
  return markers
}

// Only these wire fields may become readable diagnostic labels. Schemas and
// unknown subtrees stay whole hashes: their keys are authored content too.
const optionPaths = new Set([
  "model", "prompt_cache_key", "prompt_cache_retention", "prompt_cache_options",
  "reasoning", "temperature", "top_p", "top_k", "presence_penalty", "frequency_penalty",
  "max_output_tokens", "max_tokens", "max_completion_tokens", "service_tier", "seed",
  "text", "parallel_tool_calls", "tool_choice", "thinking", "output_config", "container",
  "context_management", "compaction", "reasoning_effort", "response_format",
  "prompt_cache_options.ttl", "prompt_cache_options.comparison_response_id",
  "reasoning.effort", "reasoning.summary", "text.verbosity", "text.format",
  "text.format.type", "text.format.name", "text.format.strict", "text.format.schema",
  "response_format.type", "response_format.json_schema", "response_format.json_schema.name",
  "response_format.json_schema.strict", "response_format.json_schema.schema",
  "thinking.type", "thinking.budget_tokens", "output_config.effort", "output_config.format",
  "output_config.format.type", "output_config.format.schema", "tool_choice.type",
  "tool_choice.name", "tool_choice.function", "tool_choice.function.name",
  "tool_choice.disable_parallel_tool_use",
])
const optionContainers = new Set([
  "prompt_cache_options", "reasoning", "text", "text.format", "response_format",
  "response_format.json_schema", "thinking", "output_config", "output_config.format",
  "tool_choice", "tool_choice.function",
])

function optionFingerprints(body: Record<string, unknown>, keys: readonly string[]) {
  const result: Record<string, string> = {}
  const visit = (path: string | undefined, label: string, value: unknown) => {
    if (value === undefined) return
    result[label] = sha256(canonicalJson(value))
    if (path === undefined || !optionContainers.has(path) || value === null || typeof value !== "object" || Array.isArray(value)) return
    Object.entries(value).forEach(([name, child]) => {
      const next = `${path}.${name}`
      const readable = !name.includes(".") && optionPaths.has(next)
      visit(readable ? next : undefined, readable ? next : `${label}.unknown[${sha256(name)}]`, child)
    })
  }
  keys.forEach((key) => {
    const readable = !key.includes(".") && optionPaths.has(key)
    visit(readable ? key : undefined, readable ? key : `unknown[${sha256(key)}]`, body[key])
  })
  return result
}

function nameSystemPart(
  text: string,
  idx: number,
): string {
  if (text.includes("<env>") || text.includes("<environment>") || text.includes("Today's date:") || text.includes("Platform:")) {
    return "date/environment block"
  }
  if (text.includes("${OPENCODE_TOOL_GUIDANCE}") || text.includes("guidance") || text.includes("Rules and Guidance")) {
    return "Plus guidance row"
  }
  if (idx === 0) {
    return "base template"
  }
  return `system:${idx}`
}

function parseBody(raw: unknown): { text: string; json?: Record<string, unknown> } {
  let text = ""
  if (typeof raw === "string") {
    text = raw
  } else if (raw instanceof Uint8Array || (typeof Buffer !== "undefined" && Buffer.isBuffer(raw))) {
    text = new TextDecoder().decode(raw)
  } else if (raw !== null && typeof raw === "object") {
    text = JSON.stringify(raw)
    return { text, json: raw as Record<string, unknown> }
  } else {
    text = String(raw ?? "")
  }
  try {
    const parsed = JSON.parse(text)
    if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
      return { text, json: parsed as Record<string, unknown> }
    }
  } catch {
    // not valid JSON object
  }
  return { text }
}

export function detectProtocol(
  body: Record<string, unknown> | undefined,
  url?: string,
): "openai-responses" | "openai-chat" | "anthropic-messages" | "fallback" {
  if (!body) return "fallback"
  if (url && /\/responses(\?|$)/.test(url)) return "openai-responses"
  if (url && /\/messages(\?|$)/.test(url)) return "anthropic-messages"
  if (url && /\/chat\/completions(\?|$)/.test(url)) return "openai-chat"

  if (Array.isArray(body.input) || typeof body.input === "string") return "openai-responses"
  if (Array.isArray(body.messages)) {
    if (body.system !== undefined && body.max_tokens !== undefined) return "anthropic-messages"
    if (body.thinking !== undefined) return "anthropic-messages"
    return "openai-chat"
  }
  return "fallback"
}

export function fingerprintWireBody(
  rawBody: unknown,
  options: {
    readonly url?: string
    readonly protocol?: "openai-responses" | "openai-chat" | "anthropic-messages" | "fallback"
    readonly namedSystemParts?: ReadonlyArray<NamedSystemPart>
  } = {},
): WireFingerprint {
  const { text, json } = parseBody(rawBody)
  const bodyHash = sha256(text)
  const protocol = options.protocol ?? detectProtocol(json, options.url)

  if (!json || protocol === "fallback") {
    return fallbackFingerprint(text, bodyHash)
  }

  // Unsupported wire shapes cannot silently become an empty known prefix.
  if ((protocol !== "openai-responses" && !Array.isArray(json.messages)) ||
    (protocol === "openai-responses" && json.input !== undefined && typeof json.input !== "string" && !Array.isArray(json.input)) ||
    (json.tools !== undefined && (!Array.isArray(json.tools) || json.tools.some((tool) => !tool || typeof tool !== "object" || Array.isArray(tool)))))
    return fallbackFingerprint(text, bodyHash)

  if (protocol === "anthropic-messages") {
    return fingerprintAnthropic(json, bodyHash, options.namedSystemParts)
  }

  if (protocol === "openai-responses") {
    return fingerprintOpenAIResponses(json, bodyHash, options.namedSystemParts)
  }

  return fingerprintOpenAIChat(json, bodyHash, options.namedSystemParts)
}

function fallbackFingerprint(bodyText: string, bodyHash: string): WireFingerprint {
  const CHUNK_SIZE = 1024
  const messagePrefixes: MessagePrefixFingerprint[] = []
  let prevHash = ""
  for (let i = 0, idx = 0; i < bodyText.length; i += CHUNK_SIZE, idx++) {
    const chunk = bodyText.slice(i, i + CHUNK_SIZE)
    const prefixHash = sha256(`${prevHash}:${chunk}`)
    prevHash = prefixHash
    messagePrefixes.push({
      idx,
      role: "chunk",
      prefixHash,
      contentHash: sha256(chunk),
      chars: chunk.length,
      estimatedTokens: estimateTokens(chunk.length),
    })
  }
  return {
    fingerprintVersion: FINGERPRINT_VERSION,
    policyVersion: FINGERPRINT_POLICY_VERSION,
    protocol: "fallback",
    systemParts: [],
    tools: [],
    optionsHash: "",
    optionsKeys: {},
    messagePrefixes,
    bodyHash,
  }
}

function fingerprintAnthropic(
  body: Record<string, unknown>,
  bodyHash: string,
  namedParts?: ReadonlyArray<NamedSystemPart>,
): WireFingerprint {
  const systemParts: SystemPartFingerprint[] = []

  // System parts
  const rawSystem = body.system
  if (typeof rawSystem === "string") {
    systemParts.push(...systemFingerprints(rawSystem, 0, namedParts))
  } else if (Array.isArray(rawSystem)) {
    rawSystem.forEach((part, idx) => {
      if (typeof part === "string") {
        systemParts.push(...systemFingerprints(part, idx, namedParts))
      } else if (part && typeof part === "object") {
        const textPart = (part as { text?: unknown }).text
        const textStr = typeof textPart === "string" ? textPart : JSON.stringify(part)
        systemParts.push(...systemFingerprints(textStr, idx, namedParts))
      }
    })
  }

  // Tools
  const tools: ToolFingerprint[] = []
  const rawTools = Array.isArray(body.tools) ? body.tools : []
  rawTools.forEach((tool, idx) => {
    if (!tool || typeof tool !== "object") return
    const t = tool as Record<string, unknown>
    const name = String(t.name ?? `tool:${idx}`)
    const descStr = typeof t.description === "string" ? t.description : ""
    const schemaObj = t.input_schema ?? {}
    const toolChars = JSON.stringify(tool).length
    tools.push({
      name,
      descHash: sha256(descStr),
      schemaHash: sha256(canonicalJson(schemaObj)),
      wireHash: sha256(contentJson(tool)),
      chars: toolChars,
      estimatedTokens: estimateTokens(toolChars),
    })
  })

  // Options
  const optionsKeys = wireOptions(body, ["system", "tools", "messages"])
  const optionsHash = sha256(canonicalJson(optionsKeys))

  // Messages with rolling prefix hash
  const messagePrefixes: MessagePrefixFingerprint[] = []
  const rawMessages = Array.isArray(body.messages) ? body.messages : []
  let prevHash = ""
  rawMessages.forEach((msg, idx) => {
    const m = (msg && typeof msg === "object" ? msg : {}) as Record<string, unknown>
    const role = String(m.role ?? "user")
    const kind = Array.isArray(m.content)
      ? m.content.map((c) => (c && typeof c === "object" ? (c as { type?: unknown }).type : "text")).join("+")
      : typeof m.content === "string"
        ? "text"
        : undefined
    const messageId = typeof m.id === "string" ? m.id : undefined
    const canonical = contentJson(msg)
    const prefixHash = sha256(`${prevHash}:${canonical}`)
    prevHash = prefixHash
    const chars = JSON.stringify(msg).length

    messagePrefixes.push({
      idx,
      role,
      ...(kind ? { kind } : {}),
      ...(messageId ? { messageId } : {}),
      prefixHash,
      contentHash: sha256(canonical),
      chars,
      estimatedTokens: estimateTokens(chars),
    })
  })

  return {
    fingerprintVersion: FINGERPRINT_VERSION,
    policyVersion: FINGERPRINT_POLICY_VERSION,
    systemHash: sha256(contentJson(body.system ?? null)),
    protocol: "anthropic-messages",
    systemParts,
    tools,
    optionsHash,
    optionsKeys,
    messagePrefixes,
    cacheControl: cacheMarkers(body),
    bodyHash,
  }
}

function fingerprintOpenAIResponses(
  body: Record<string, unknown>,
  bodyHash: string,
  namedParts?: ReadonlyArray<NamedSystemPart>,
): WireFingerprint {
  const systemParts: SystemPartFingerprint[] = []

  // System parts from instructions
  if (typeof body.instructions === "string") {
    systemParts.push(...systemFingerprints(body.instructions, 0, namedParts))
  }

  // Tools
  const tools: ToolFingerprint[] = []
  const rawTools = Array.isArray(body.tools) ? body.tools : []
  rawTools.forEach((tool, idx) => {
    if (!tool || typeof tool !== "object") return
    const t = tool as Record<string, unknown>
    const name = String(t.name ?? (t.function as { name?: unknown } | undefined)?.name ?? `tool:${idx}`)
    const descStr = typeof t.description === "string" ? t.description : typeof (t.function as { description?: unknown } | undefined)?.description === "string" ? String((t.function as { description: unknown }).description) : ""
    const schemaObj = t.parameters ?? (t.function as { parameters?: unknown } | undefined)?.parameters ?? {}
    const toolChars = JSON.stringify(tool).length
    tools.push({
      name,
      descHash: sha256(descStr),
      schemaHash: sha256(canonicalJson(schemaObj)),
      wireHash: sha256(contentJson(tool)),
      chars: toolChars,
      estimatedTokens: estimateTokens(toolChars),
    })
  })

  // Options
  const optionsKeys = wireOptions(body, ["instructions", "tools", "input", "previous_response_id"])
  const optionsHash = sha256(canonicalJson(optionsKeys))

  // Messages from body.input
  const messagePrefixes: MessagePrefixFingerprint[] = []
  const rawInput = Array.isArray(body.input) ? body.input : body.input === undefined ? [] : [body.input]
  let prevHash = ""
  rawInput.forEach((item, idx) => {
    const m = (item && typeof item === "object" ? item : {}) as Record<string, unknown>
    const role = String(m.role ?? m.type ?? "user")
    const kind = typeof m.type === "string" ? m.type : undefined
    const messageId = typeof m.id === "string" ? m.id : typeof m.call_id === "string" ? m.call_id : undefined
    const canonical = contentJson(item)
    const prefixHash = sha256(`${prevHash}:${canonical}`)
    prevHash = prefixHash
    const chars = JSON.stringify(item).length
    messagePrefixes.push({
      idx,
      role,
      ...(kind ? { kind } : {}),
      ...(messageId ? { messageId } : {}),
      prefixHash,
      contentHash: sha256(canonical),
      chars,
      estimatedTokens: estimateTokens(chars),
    })
  })

  const cacheKey = typeof body.prompt_cache_key === "string" ? sha256(body.prompt_cache_key) : undefined

  return {
    fingerprintVersion: FINGERPRINT_VERSION,
    policyVersion: FINGERPRINT_POLICY_VERSION,
    systemHash: sha256(contentJson(body.instructions ?? null)),
    protocol: "openai-responses",
    systemParts,
    tools,
    optionsHash,
    optionsKeys,
    messagePrefixes,
    cacheKey,
    ...(typeof body.previous_response_id === "string" ? { previousResponseId: sha256(body.previous_response_id) } : {}),
    bodyHash,
  }
}

function fingerprintOpenAIChat(
  body: Record<string, unknown>,
  bodyHash: string,
  namedParts?: ReadonlyArray<NamedSystemPart>,
): WireFingerprint {
  const systemParts: SystemPartFingerprint[] = []
  const rawMessages = Array.isArray(body.messages) ? body.messages : []

  // Separate system messages from chat messages
  const chatMessages: unknown[] = []
  rawMessages.forEach((msg, idx) => {
    const m = (msg && typeof msg === "object" ? msg : {}) as Record<string, unknown>
    const role = String(m.role ?? "user")
    if (role === "system" || role === "developer") {
      const parts = Array.isArray(m.content) ? m.content : [m.content ?? ""]
      parts.forEach((part) => {
        const text = typeof part === "string" ? part : typeof part?.text === "string" ? part.text : canonicalJson(part)
        systemParts.push(...systemFingerprints(text, systemParts.length, namedParts))
      })
    } else {
      chatMessages.push(msg)
    }
  })

  // Tools
  const tools: ToolFingerprint[] = []
  const rawTools = Array.isArray(body.tools) ? body.tools : []
  rawTools.forEach((tool, idx) => {
    if (!tool || typeof tool !== "object") return
    const t = tool as Record<string, unknown>
    const fn = (t.function ?? {}) as Record<string, unknown>
    const name = String(fn.name ?? t.name ?? `tool:${idx}`)
    const descStr = typeof fn.description === "string" ? fn.description : typeof t.description === "string" ? t.description : ""
    const schemaObj = fn.parameters ?? t.parameters ?? {}
    const toolChars = JSON.stringify(tool).length
    tools.push({
      name,
      descHash: sha256(descStr),
      schemaHash: sha256(canonicalJson(schemaObj)),
      wireHash: sha256(contentJson(tool)),
      chars: toolChars,
      estimatedTokens: estimateTokens(toolChars),
    })
  })

  // Options
  const optionsKeys = wireOptions(body, ["messages", "tools"])
  const optionsHash = sha256(canonicalJson(optionsKeys))

  // Rolling prefix hashes per non-system message
  const messagePrefixes: MessagePrefixFingerprint[] = []
  let prevHash = ""
  chatMessages.forEach((msg, idx) => {
    const m = (msg && typeof msg === "object" ? msg : {}) as Record<string, unknown>
    const role = String(m.role ?? "user")
    const kind = Array.isArray(m.tool_calls) ? "tool_calls" : typeof m.tool_call_id === "string" ? "tool_result" : "text"
    const messageId = typeof m.id === "string" ? m.id : typeof m.tool_call_id === "string" ? m.tool_call_id : undefined
    const canonical = contentJson(msg)
    const prefixHash = sha256(`${prevHash}:${canonical}`)
    prevHash = prefixHash
    const chars = JSON.stringify(msg).length
    messagePrefixes.push({
      idx,
      role,
      kind,
      ...(messageId ? { messageId } : {}),
      prefixHash,
      contentHash: sha256(canonical),
      chars,
      estimatedTokens: estimateTokens(chars),
    })
  })

  const cacheKey = typeof body.prompt_cache_key === "string" ? sha256(body.prompt_cache_key) : undefined

  return {
    fingerprintVersion: FINGERPRINT_VERSION,
    policyVersion: FINGERPRINT_POLICY_VERSION,
    systemHash: sha256(canonicalJson(rawMessages.flatMap((msg, idx) => {
      const m = msg && typeof msg === "object" ? msg as Record<string, unknown> : {}
      return m.role === "system" || m.role === "developer" ? [{ idx, messageHash: sha256(contentJson(m)) }] : []
    }))),
    protocol: "openai-chat",
    cacheControl: cacheMarkers(body),
    systemParts,
    tools,
    optionsHash,
    optionsKeys,
    messagePrefixes,
    cacheKey,
    bodyHash,
  }
}
