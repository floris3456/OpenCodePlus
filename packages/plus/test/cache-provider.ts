// Owned loopback-only C3 provider. Run with an evidence directory argument.
import { fingerprintWireBody, canonicalJson, sha256 } from "../src/monitor/fingerprint.js"

const directory = process.argv[2]
if (!directory) throw new Error("Supply an owned evidence directory")
const cached = new Map<string, number>()
const records: unknown[] = []
const eviction = { marker: process.env.CACHE_STUB_DROP_ON, done: false }
const server = Bun.serve({
  hostname: "127.0.0.1", port: 0,
  async fetch(request) {
    const url = new URL(request.url)
    if (request.method === "GET") return Response.json({ id: "fixture-model", capabilities: { compaction: { supported: true } } })
    const body = await request.json() as Record<string, unknown>
    // Deterministic upstream-loss control for the cache screen's live acceptance.
    if (!eviction.done && eviction.marker && JSON.stringify(body.messages).includes(eviction.marker)) {
      cached.clear()
      eviction.done = true
    }
    const messages = body.messages as { role: string; content: { type: string; text?: string; content?: string; signature?: string; cache_control?: unknown }[] }[]
    const management = body.context_management as { edits?: { type: string; trigger?: { value: number } }[] } | null | undefined
    const threshold = management?.edits?.find((edit) => edit.type === "compact_20260112")
    const signed = messages?.some((m) => m.content.some((b) => b.type === "compaction" && b.signature))
    if (body.compaction && management != null || threshold && signed)
      return Response.json({ error: { type: "invalid_request_error", message: "incompatible compaction and context_management" } }, { status: 400 })
    const parts: { value: unknown; marked: boolean }[] = []
    for (const tool of (body.tools ?? []) as { cache_control?: unknown }[]) parts.push({ value: tool, marked: !!tool.cache_control })
    if (threshold) parts.push({ value: ["threshold-rendering", threshold.trigger?.value], marked: false })
    for (const system of (body.system ?? []) as { cache_control?: unknown }[]) parts.push({ value: system, marked: !!system.cache_control })
    for (const message of messages ?? []) for (const block of message.content) parts.push({ value: [message.role, block], marked: !!block.cache_control })
    let prefix = ""
    let total = 0
    let read = 0
    let frontier = 0
    const marks: [string, number][] = []
    for (const part of parts) {
      const encoded = canonicalJson(JSON.parse(JSON.stringify(part.value, (key, value) => key === "cache_control" ? undefined : value)))
      prefix = sha256(prefix + encoded)
      total += Math.ceil(encoded.length / 4)
      read = Math.max(read, cached.get(prefix) ?? 0)
      if (part.marked) { marks.push([prefix, total]); frontier = total }
    }
    marks.forEach(([key, tokens]) => cached.set(key, tokens))
    const write = Math.max(0, frontier - read)
    const compacting = !!body.compaction
    const summary = messages?.at(-1)?.content.some((b) => b.text?.includes("summary") || b.text?.includes("Summarize"))
    const content = compacting
      ? { type: "compaction", content: "## Objective\nContinue the synthetic cache experiment.", signature: "stub-signed-summary" }
      : { type: "text", text: summary ? "## Objective\nContinue the synthetic cache experiment." : "Synthetic response." }
    const usage = { input_tokens: total - read - write, output_tokens: 12, cache_read_input_tokens: read, cache_creation_input_tokens: write }
    records.push({ sequence: records.length + 1, compaction: compacting, input: total, read, write,
      fingerprint: fingerprintWireBody(body, { protocol: "anthropic-messages" }) })
    await Bun.write(`${directory}/stub-requests.json`, JSON.stringify(records, null, 2))
    const events = [
      { type: "message_start", message: { id: `stub-${records.length}`, usage: { input_tokens: 0, output_tokens: 0 } } },
      { type: "content_block_start", index: 0, content_block: compacting ? content : { type: "text", text: "" } },
      ...(!compacting ? [{ type: "content_block_delta", index: 0, delta: { type: "text_delta", text: content.text } }] : []),
      { type: "content_block_stop", index: 0 },
      { type: "message_delta", delta: { stop_reason: compacting ? "compaction" : "end_turn" }, usage: compacting ? { input_tokens: 0, output_tokens: 0, iterations: [{ type: "compaction", ...usage }] } : usage },
      { type: "message_stop" },
    ]
    return new Response(events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""), { headers: { "content-type": "text/event-stream" } })
  },
})
await Bun.write(`${directory}/stub-address.json`, JSON.stringify({ url: server.url.toString(), pid: process.pid }))
console.log(`Stub listening on ${server.url}`)
