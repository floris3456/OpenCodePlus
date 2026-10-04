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
  readonly chars: number
  readonly estimatedTokens: number
}

export interface MessagePrefixFingerprint {
  readonly idx: number
  readonly role: string
  readonly kind?: string
  readonly messageId?: string
  readonly prefixHash: string
  readonly chars: number
  readonly estimatedTokens: number
}

export interface CacheControlMarker {
  readonly target: string
  readonly type: string
  readonly ttl?: string
}

export interface WireFingerprint {
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

function cacheMarkers(body: Record<string, unknown>): CacheControlMarker[] {
  const markers: CacheControlMarker[] = []
  const visit = (value: unknown, target: string) => {
    if (!value || typeof value !== "object") return
    if (Array.isArray(value)) return value.forEach((part, i) => visit(part, `${target}[${i}]`))
    const obj = value as Record<string, unknown>
    const cc = obj.cache_control as { type?: unknown; ttl?: unknown } | undefined
    if (cc && typeof cc === "object") markers.push({ target, type: String(cc.type ?? "ephemeral"), ...(typeof cc.ttl === "string" ? { ttl: cc.ttl } : {}) })
    Object.entries(obj).filter(([key]) => key !== "cache_control").forEach(([key, child]) => visit(child, target === "top" ? key : `${target}.${key}`))
  }
  visit(body, "top")
  return markers
}

function optionFingerprints(body: Record<string, unknown>, keys: readonly string[]) {
  const result: Record<string, string> = {}
  const visit = (key: string, value: unknown) => {
    if (value === undefined) return
    result[key] = sha256(canonicalJson(value))
    if (value !== null && typeof value === "object" && !Array.isArray(value))
      Object.entries(value).forEach(([name, child]) => visit(`${key}.${name}`, child))
  }
  keys.forEach((key) => visit(key, body[key]))
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

  if (Array.isArray(body.input)) return "openai-responses"
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
      chars: chunk.length,
      estimatedTokens: estimateTokens(chunk.length),
    })
  }
  return {
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
      chars: toolChars,
      estimatedTokens: estimateTokens(toolChars),
    })
  })

  // Options
  const optionKeys = ["thinking", "output_config", "max_tokens", "temperature", "top_p", "top_k", "service_tier", "container", "tool_choice", "context_management"]
  const optionsKeys = optionFingerprints(body, optionKeys)
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
    const canonical = canonicalJson(m)
    const prefixHash = sha256(`${prevHash}:${canonical}`)
    prevHash = prefixHash
    const chars = JSON.stringify(m).length

    messagePrefixes.push({
      idx,
      role,
      ...(kind ? { kind } : {}),
      ...(messageId ? { messageId } : {}),
      prefixHash,
      chars,
      estimatedTokens: estimateTokens(chars),
    })
  })

  return {
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
      chars: toolChars,
      estimatedTokens: estimateTokens(toolChars),
    })
  })

  // Options
  const optionKeys = [
    "prompt_cache_key",
    "prompt_cache_retention",
    "prompt_cache_options",
    "reasoning",
    "temperature",
    "top_p",
    "presence_penalty",
    "frequency_penalty",
    "max_output_tokens",
    "service_tier",
    "text",
    "parallel_tool_calls",
    "tool_choice",
  ]
  const optionsKeys = optionFingerprints(body, optionKeys)
  const optionsHash = sha256(canonicalJson(optionsKeys))

  // Messages from body.input
  const messagePrefixes: MessagePrefixFingerprint[] = []
  const rawInput = Array.isArray(body.input) ? body.input : []
  let prevHash = ""
  rawInput.forEach((item, idx) => {
    const m = (item && typeof item === "object" ? item : {}) as Record<string, unknown>
    const role = String(m.role ?? m.type ?? "user")
    const kind = typeof m.type === "string" ? m.type : undefined
    const messageId = typeof m.id === "string" ? m.id : typeof m.call_id === "string" ? m.call_id : undefined
    const canonical = canonicalJson(m)
    const prefixHash = sha256(`${prevHash}:${canonical}`)
    prevHash = prefixHash
    const chars = JSON.stringify(m).length
    messagePrefixes.push({
      idx,
      role,
      ...(kind ? { kind } : {}),
      ...(messageId ? { messageId } : {}),
      prefixHash,
      chars,
      estimatedTokens: estimateTokens(chars),
    })
  })

  const cacheKey = typeof body.prompt_cache_key === "string" ? sha256(body.prompt_cache_key) : undefined

  return {
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
  const chatMessages: Record<string, unknown>[] = []
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
      chatMessages.push(m)
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
      chars: toolChars,
      estimatedTokens: estimateTokens(toolChars),
    })
  })

  // Options
  const optionKeys = [
    "temperature",
    "top_p",
    "frequency_penalty",
    "presence_penalty",
    "seed",
    "max_tokens",
    "max_completion_tokens",
    "reasoning_effort",
    "service_tier",
    "prompt_cache_key",
    "tool_choice",
  ]
  const optionsKeys = optionFingerprints(body, [...optionKeys, "prompt_cache_retention", "prompt_cache_options"])
  const optionsHash = sha256(canonicalJson(optionsKeys))

  // Rolling prefix hashes per non-system message
  const messagePrefixes: MessagePrefixFingerprint[] = []
  let prevHash = ""
  chatMessages.forEach((m, idx) => {
    const role = String(m.role ?? "user")
    const kind = Array.isArray(m.tool_calls) ? "tool_calls" : typeof m.tool_call_id === "string" ? "tool_result" : "text"
    const messageId = typeof m.id === "string" ? m.id : typeof m.tool_call_id === "string" ? m.tool_call_id : undefined
    const canonical = canonicalJson(m)
    const prefixHash = sha256(`${prevHash}:${canonical}`)
    prevHash = prefixHash
    const chars = JSON.stringify(m).length
    messagePrefixes.push({
      idx,
      role,
      kind,
      ...(messageId ? { messageId } : {}),
      prefixHash,
      chars,
      estimatedTokens: estimateTokens(chars),
    })
  })

  const cacheKey = typeof body.prompt_cache_key === "string" ? sha256(body.prompt_cache_key) : undefined

  return {
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
