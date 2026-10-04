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
  return createHash("sha256").update(input).digest("hex")
}

function nameSystemPart(
  text: string,
  idx: number,
  namedParts?: ReadonlyArray<NamedSystemPart>,
): string {
  if (namedParts && namedParts.length > 0) {
    const match = namedParts.find((p) => p.text === text || sha256(p.text) === sha256(text))
    if (match) return match.name
    if (namedParts[idx] && namedParts.length === 1) return namedParts[0]!.name
  }
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
  const cacheControls: CacheControlMarker[] = []

  // System parts
  const rawSystem = body.system
  if (typeof rawSystem === "string") {
    systemParts.push({
      source: nameSystemPart(rawSystem, 0, namedParts),
      hash: sha256(rawSystem),
      chars: rawSystem.length,
      estimatedTokens: estimateTokens(rawSystem.length),
    })
  } else if (Array.isArray(rawSystem)) {
    rawSystem.forEach((part, idx) => {
      if (typeof part === "string") {
        systemParts.push({
          source: nameSystemPart(part, idx, namedParts),
          hash: sha256(part),
          chars: part.length,
          estimatedTokens: estimateTokens(part.length),
        })
      } else if (part && typeof part === "object") {
        const textPart = (part as { text?: unknown }).text
        const textStr = typeof textPart === "string" ? textPart : JSON.stringify(part)
        systemParts.push({
          source: nameSystemPart(textStr, idx, namedParts),
          hash: sha256(textStr),
          chars: textStr.length,
          estimatedTokens: estimateTokens(textStr.length),
        })
        const cc = (part as { cache_control?: unknown }).cache_control
        if (cc && typeof cc === "object") {
          cacheControls.push({
            target: `system[${idx}]`,
            type: String((cc as { type?: unknown }).type ?? "ephemeral"),
            ttl: typeof (cc as { ttl?: unknown }).ttl === "string" ? String((cc as { ttl?: unknown }).ttl) : undefined,
          })
        }
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
    const cc = t.cache_control
    if (cc && typeof cc === "object") {
      cacheControls.push({
        target: `tool:${name}`,
        type: String((cc as { type?: unknown }).type ?? "ephemeral"),
        ttl: typeof (cc as { ttl?: unknown }).ttl === "string" ? String((cc as { ttl?: unknown }).ttl) : undefined,
      })
    }
  })

  // Options
  const optionKeys = ["thinking", "output_config", "max_tokens", "temperature", "top_p", "top_k", "service_tier", "container"]
  const optionsKeys: Record<string, string> = {}
  optionKeys.forEach((key) => {
    if (body[key] !== undefined) {
      optionsKeys[key] = sha256(canonicalJson(body[key]))
    }
  })
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

    // Check message content for cache_control
    if (Array.isArray(m.content)) {
      m.content.forEach((block, bIdx) => {
        if (block && typeof block === "object") {
          const cc = (block as { cache_control?: unknown }).cache_control
          if (cc && typeof cc === "object") {
            cacheControls.push({
              target: `message[${idx}].content[${bIdx}]`,
              type: String((cc as { type?: unknown }).type ?? "ephemeral"),
            })
          }
        }
      })
    }

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

  const topCacheControl = body.cache_control
  if (topCacheControl && typeof topCacheControl === "object") {
    cacheControls.push({
      target: "top",
      type: String((topCacheControl as { type?: unknown }).type ?? "ephemeral"),
    })
  }

  return {
    protocol: "anthropic-messages",
    systemParts,
    tools,
    optionsHash,
    optionsKeys,
    messagePrefixes,
    cacheControl: cacheControls.length > 0 ? cacheControls : undefined,
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
    systemParts.push({
      source: nameSystemPart(body.instructions, 0, namedParts),
      hash: sha256(body.instructions),
      chars: body.instructions.length,
      estimatedTokens: estimateTokens(body.instructions.length),
    })
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
    "reasoning",
    "temperature",
    "top_p",
    "presence_penalty",
    "frequency_penalty",
    "max_output_tokens",
    "service_tier",
    "text",
    "parallel_tool_calls",
  ]
  const optionsKeys: Record<string, string> = {}
  optionKeys.forEach((key) => {
    if (body[key] !== undefined) {
      optionsKeys[key] = sha256(canonicalJson(body[key]))
    }
  })
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

  const cacheKey = typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : undefined

  return {
    protocol: "openai-responses",
    systemParts,
    tools,
    optionsHash,
    optionsKeys,
    messagePrefixes,
    cacheKey,
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
      const text = typeof m.content === "string" ? m.content : JSON.stringify(m.content ?? "")
      systemParts.push({
        source: nameSystemPart(text, systemParts.length, namedParts),
        hash: sha256(text),
        chars: text.length,
        estimatedTokens: estimateTokens(text.length),
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
  ]
  const optionsKeys: Record<string, string> = {}
  optionKeys.forEach((key) => {
    if (body[key] !== undefined) {
      optionsKeys[key] = sha256(canonicalJson(body[key]))
    }
  })
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

  const cacheKey = typeof body.prompt_cache_key === "string" ? body.prompt_cache_key : undefined

  return {
    protocol: "openai-chat",
    systemParts,
    tools,
    optionsHash,
    optionsKeys,
    messagePrefixes,
    cacheKey,
    bodyHash,
  }
}
