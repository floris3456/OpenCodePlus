import { expect, test } from "bun:test"

// Opt-in control against the loopback C3 stub, never a real provider.
const address = process.env.OPENCODE_CACHE_STUB_URL
test.skipIf(!address)("C3 prefix simulator catches threshold misses and rejects incompatible bodies", async () => {
  const url = new URL("v1/messages", address)
  if (url.hostname !== "127.0.0.1") throw new Error("C3 requires the owned loopback stub")
  const body = {
    model: "fixture-control", max_tokens: 1000,
    tools: [{ name: "fixture", input_schema: { type: "object" }, cache_control: { type: "ephemeral" } }],
    system: [{ type: "text", text: "control system ".repeat(1000), cache_control: { type: "ephemeral" } }],
    messages: [{ role: "user", content: [{ type: "text", text: "control history ".repeat(1000), cache_control: { type: "ephemeral" } }] }],
  }
  const send = async (value: object) => {
    const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(value) })
    const text = await response.text()
    const delta = text.split("\n").filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6))).find((event) => event.type === "message_delta")
    const usage = delta?.usage.iterations?.[0] ?? delta?.usage
    return { status: response.status, read: usage?.cache_read_input_tokens as number, write: usage?.cache_creation_input_tokens as number }
  }
  const warm = await send(body)
  const hit = await send(body)
  expect(hit.read).toBe(warm.write)
  const native = await send({ ...body, compaction: { type: "summarize" }, context_management: null })
  expect(native).toEqual({ status: 200, read: hit.read, write: 0 })
  const local = await send({ ...body, messages: [...body.messages, { role: "user", content: [{ type: "text", text: "Summarize" }] }] })
  expect(local.read).toBe(hit.read)
  const threshold = { edits: [{ type: "compact_20260112", trigger: { type: "input_tokens", value: 50000 } }] }
  const old = await send({ ...body, context_management: threshold })
  expect(old.read).toBeLessThan(hit.read - 1024)
  expect(old.write).toBeGreaterThan(1024)
  expect((await send({ ...body, compaction: { type: "summarize" }, context_management: { edits: [{ type: "clear_thinking", keep: "all" }] } })).status).toBe(400)
  expect((await send({ ...body, context_management: threshold, messages: [{ role: "assistant", content: [{ type: "compaction", content: "summary", signature: "signed" }] }] })).status).toBe(400)
})
