import { expect, test } from "bun:test"
import { compactionAppend } from "../src/monitor/cache.js"
import { fingerprintWireBody } from "../src/monitor/fingerprint.js"

const body = {
  model: "fixture", max_tokens: 4096, tools: [{ name: "lookup", input_schema: { type: "object" } }],
  system: [{ type: "text", text: "system", cache_control: { type: "ephemeral" } }],
  messages: [{ role: "user", content: [{ type: "text", text: "history" }] }, { role: "assistant", content: [{ type: "thinking", thinking: "reasoning", signature: "signature" }, { type: "text", text: "reply", cache_control: { type: "ephemeral" } }] }],
}
const fp = (value: unknown) => ({ requestID: "fixture", sessionID: "fixture", ...fingerprintWireBody(value, { protocol: "anthropic-messages" }) })
test("C1 native and local compaction preserve all fingerprint segments except allowed additions", () => {
  const native = { ...body, max_tokens: 8192, context_management: null, compaction: { type: "summarize" } }
  const local = { ...body, messages: [...body.messages, { role: "user", content: [{ type: "text", text: "Summarize" }] }] }
  expect(compactionAppend(fp(body), fp(native), "native")).toEqual({ valid: true })
  expect(compactionAppend(fp(body), fp(local), "text-summary")).toEqual({ valid: true })
  for (const changed of [
    { ...native, context_management: { edits: [{ type: "compact_20260112" }] } },
    { ...native, tools: [] },
    { ...native, messages: [{ role: "user", content: "rebuilt transcript" }] },
  ]) expect(compactionAppend(fp(body), fp(changed), "native").valid).toBe(false)
})
