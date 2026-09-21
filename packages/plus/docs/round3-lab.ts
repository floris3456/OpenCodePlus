// Round 3 deterministic loopback model transport (lab evidence only).
//
// This is not a product change and not an external LLM. It is a tiny
// OpenAI-compatible `/v1/chat/completions` endpoint (SSE and non-streaming)
// that an isolated tui-lab host points at through the V2
// `@opencode/ai/providers/openai-compatible` package, so the round-3 live
// proofs run with no credentials and no network. `docs/round3-lab.md` has the
// exact config and the walkthrough.
//
// Privacy and safety rules, enforced here:
//   - bind 127.0.0.1 only, port 0 by default;
//   - print only the bound URL, once, at startup;
//   - never log or store prompts, tools, request bodies or auth headers; the
//     only state kept is a handful of counters and one boolean.
//
// Behaviour:
//   normal          -> one deterministic short reply, SSE or JSON;
//   ROUND3_HOLD     -> an SSE response that stays open for ~90 s and keeps
//                      emitting short content tokens so the host shows
//                      `working`;
//   ROUND3_REFUSAL  -> one native `shell` tool call (`printf round3-denied`)
//                      while the current exchange has no matching tool result.
//                      When a later request in that exchange carries the
//                      result, record whether it contains the exact sentinel
//                      `Round3 sentinel command is denied.` and answer with a
//                      short acknowledgment. The fixture never pre-generates a
//                      refusal: the sentinel only appears if the host's own
//                      permission layer put it in the model-visible result.
//   GET  /proof     -> the counters; POST /reset -> clear them;
//   POST /shutdown  -> owned cleanup.

export const HOLD_MARKER = "ROUND3_HOLD"
export const REFUSAL_MARKER = "ROUND3_REFUSAL"
export const REFUSAL_SENTINEL = "Round3 sentinel command is denied."
export const REFUSAL_CALL_ID = "call_round3_refusal"
export const REFUSAL_TOOL = "shell"
export const REFUSAL_COMMAND = "printf round3-denied"
export const REFUSAL_ARGUMENTS = JSON.stringify({ command: REFUSAL_COMMAND })
export const REPLY = "Round3 fixture reply."
export const HOLD_REPLY = "Round3 fixture hold."
export const RECEIVED_SENTINEL = "Round3 fixture: received the tool result with the refusal sentinel."
export const RECEIVED_MISSING = "Round3 fixture: received the tool result without the refusal sentinel."
export const DEFAULT_HOLD_MS = 90_000
export const HOLD_TOKEN_INTERVAL_MS = 2_000

const COMPLETION_ID = "chatcmpl-round3"
const encoder = new TextEncoder()

export interface Proof {
  readonly requests: number
  readonly streams: number
  readonly holds: number
  readonly refusals: number
  readonly refusalResults: number
  readonly sentinelSeen: boolean
}

export interface LabProviderOptions {
  /** 0 (the default) binds an ephemeral port. */
  readonly port?: number
  /** How long a ROUND3_HOLD stream stays open; tests shorten it. */
  readonly holdMs?: number
}

export interface LabProvider {
  readonly url: string
  readonly port: number
  readonly proof: () => Proof
  readonly stop: () => void
}

interface Counters {
  requests: number
  streams: number
  holds: number
  refusals: number
  refusalResults: number
  sentinelSeen: boolean
}

interface Exchange {
  readonly latestUserText: string
  readonly refusalResult: { readonly hasSentinel: boolean } | undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null
}

function messageText(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((part): part is { text: string } => isRecord(part) && typeof part.text === "string")
    .map((part) => part.text)
    .join("")
}

// Only the last user message and a matching refusal result after it are read;
// nothing is persisted and no other content is inspected.
function readExchange(messages: unknown): Exchange {
  const list = Array.isArray(messages) ? messages.filter(isRecord) : []
  const lastUser = list.findLastIndex((message) => message.role === "user")
  const afterUser = lastUser === -1 ? [] : list.slice(lastUser + 1)
  const result = afterUser.findLast(
    (message) => message.role === "tool" && message.tool_call_id === REFUSAL_CALL_ID,
  )
  return {
    latestUserText: lastUser === -1 ? "" : messageText(list[lastUser]?.content),
    refusalResult:
      result === undefined ? undefined : { hasSentinel: messageText(result.content).includes(REFUSAL_SENTINEL) },
  }
}

function chunk(model: string, delta: unknown, finishReason: string | null): string {
  return `data: ${JSON.stringify({
    id: COMPLETION_ID,
    object: "chat.completion.chunk",
    created: 0,
    model,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  })}\n\n`
}

function done(): string {
  return "data: [DONE]\n\n"
}

function completion(model: string, message: unknown, finishReason: string): unknown {
  return {
    id: COMPLETION_ID,
    object: "chat.completion",
    created: 0,
    model,
    choices: [{ index: 0, message, finish_reason: finishReason }],
    usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
  }
}

async function* textEvents(model: string, text: string): AsyncGenerator<string> {
  yield chunk(model, { role: "assistant" }, null)
  yield chunk(model, { content: text }, null)
  yield chunk(model, {}, "stop")
  yield done()
}

async function* refusalEvents(model: string): AsyncGenerator<string> {
  yield chunk(model, { role: "assistant" }, null)
  yield chunk(
    model,
    {
      tool_calls: [
        { index: 0, id: REFUSAL_CALL_ID, type: "function", function: { name: REFUSAL_TOOL, arguments: "" } },
      ],
    },
    null,
  )
  yield chunk(
    model,
    { tool_calls: [{ index: 0, function: { arguments: REFUSAL_ARGUMENTS } }] },
    null,
  )
  yield chunk(model, {}, "tool_calls")
  yield done()
}

async function* holdEvents(model: string, holdMs: number, signal: AbortSignal): AsyncGenerator<string> {
  const intervalMs = Math.max(25, Math.min(HOLD_TOKEN_INTERVAL_MS, Math.floor(holdMs / 4)))
  yield chunk(model, { role: "assistant" }, null)
  yield chunk(model, { content: HOLD_REPLY }, null)
  const started = Date.now()
  let count = 0
  while (Date.now() - started < holdMs) {
    await Bun.sleep(intervalMs)
    if (signal.aborted) return
    count += 1
    yield chunk(model, { content: ` hold ${count}` }, null)
  }
  yield chunk(model, {}, "stop")
  yield done()
}

function sseResponse(events: AsyncGenerator<string>): Response {
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await events.next()
      if (next.done) {
        controller.close()
        return
      }
      controller.enqueue(encoder.encode(next.value))
    },
    async cancel() {
      await events.return(undefined)
    },
  })
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache" },
  })
}

function refusalMessage(): unknown {
  return {
    role: "assistant",
    content: null,
    tool_calls: [{ id: REFUSAL_CALL_ID, type: "function", function: { name: REFUSAL_TOOL, arguments: REFUSAL_ARGUMENTS } }],
  }
}

function snapshot(counters: Counters): Proof {
  return { ...counters }
}

function resetCounters(counters: Counters): void {
  counters.requests = 0
  counters.streams = 0
  counters.holds = 0
  counters.refusals = 0
  counters.refusalResults = 0
  counters.sentinelSeen = false
}

async function completionResponse(
  request: Request,
  counters: Counters,
  holdMs: number,
): Promise<Response> {
  counters.requests += 1
  const body: unknown = await request.json().catch(() => undefined)
  const record = isRecord(body) ? body : {}
  const stream = record.stream === true
  const model = typeof record.model === "string" ? record.model : "fixture"
  const exchange = readExchange(record.messages)
  if (stream) counters.streams += 1

  if (exchange.latestUserText.includes(HOLD_MARKER)) {
    counters.holds += 1
    if (!stream) return Response.json(completion(model, { role: "assistant", content: HOLD_REPLY }, "stop"))
    return sseResponse(holdEvents(model, holdMs, request.signal))
  }

  if (exchange.latestUserText.includes(REFUSAL_MARKER)) {
    if (exchange.refusalResult === undefined) {
      counters.refusals += 1
      if (!stream) return Response.json(completion(model, refusalMessage(), "tool_calls"))
      return sseResponse(refusalEvents(model))
    }
    counters.refusalResults += 1
    counters.sentinelSeen = counters.sentinelSeen || exchange.refusalResult.hasSentinel
    const text = exchange.refusalResult.hasSentinel ? RECEIVED_SENTINEL : RECEIVED_MISSING
    if (!stream) return Response.json(completion(model, { role: "assistant", content: text }, "stop"))
    return sseResponse(textEvents(model, text))
  }

  if (!stream) return Response.json(completion(model, { role: "assistant", content: REPLY }, "stop"))
  return sseResponse(textEvents(model, REPLY))
}

export function startLabProvider(options: LabProviderOptions = {}): LabProvider {
  const holdMs = options.holdMs ?? DEFAULT_HOLD_MS
  const counters: Counters = {
    requests: 0,
    streams: 0,
    holds: 0,
    refusals: 0,
    refusalResults: 0,
    sentinelSeen: false,
  }
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 0,
    async fetch(request) {
      const url = new URL(request.url)
      if (request.method === "GET" && url.pathname === "/proof") return Response.json(snapshot(counters))
      if (request.method === "POST" && url.pathname === "/reset") {
        resetCounters(counters)
        return Response.json({ ok: true, ...snapshot(counters) })
      }
      if (request.method === "POST" && url.pathname === "/shutdown") {
        // Give the response time to flush, then close the owned listener.
        setTimeout(() => server.stop(true), 50)
        return Response.json({ ok: true })
      }
      if (request.method === "POST" && url.pathname === "/v1/chat/completions")
        return completionResponse(request, counters, holdMs)
      return new Response("not found", { status: 404 })
    },
  })
  const port = server.port
  if (port === undefined) throw new Error("round3-lab: the lab provider did not bind a port")
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    proof: () => snapshot(counters),
    stop: () => server.stop(true),
  }
}

export interface LabArgs {
  readonly help: boolean
  readonly port: number | undefined
  readonly holdMs: number | undefined
}

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (value === undefined || value === "") throw new Error(`${flag} needs a value`)
  return value
}

function nonNegativeInt(raw: string, flag: string): number {
  const value = Number(raw)
  if (!Number.isInteger(value) || value < 0) throw new Error(`${flag} needs a non-negative integer; got "${raw}"`)
  return value
}

export function parseArgs(argv: readonly string[]): LabArgs {
  let help = false
  let port: number | undefined
  let holdMs: number | undefined
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === "--help" || flag === "-h") {
      help = true
      continue
    }
    if (flag === "--port") {
      port = nonNegativeInt(takeValue(argv, index, flag), flag)
      index++
      continue
    }
    if (flag === "--hold-ms") {
      holdMs = nonNegativeInt(takeValue(argv, index, flag), flag)
      index++
      continue
    }
    throw new Error(`unknown flag "${flag}"; run with --help`)
  }
  return { help, port, holdMs }
}

export function usage(): string {
  return `round3-lab — deterministic loopback model transport for the isolated tui-lab

Usage:
  bun docs/round3-lab.ts [--port <n>] [--hold-ms <n>]

Prints one line: the bound loopback URL, for example http://127.0.0.1:51000.
Point the lab's global config at <url>/v1 as provider "round3", model
"fixture"; docs/round3-lab.md has the exact JSON. No credentials are used.

Options:
  --port <n>      bind 127.0.0.1:<n>; default 0 picks an ephemeral port
  --hold-ms <n>   how long ROUND3_HOLD keeps the SSE stream open (default ${DEFAULT_HOLD_MS})
  --help          this text

Routes:
  POST /v1/chat/completions   OpenAI-compatible chat completions (SSE and JSON)
  GET  /proof                 counters and the refusal sentinel boolean
  POST /reset                 clear the counters
  POST /shutdown              stop this owned server

The server never logs prompts, tools, request bodies or auth headers.`
}

export async function main(argv: readonly string[] = Bun.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv)
  if (args.help) {
    console.log(usage())
    return 0
  }
  const provider = startLabProvider({ port: args.port, holdMs: args.holdMs })
  console.log(provider.url)
  return 0
}

if (import.meta.main) {
  main().catch((error: unknown) => {
    console.error(`round3-lab: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  })
}