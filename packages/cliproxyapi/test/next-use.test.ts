import { expect, test } from "bun:test"
import { createNextUse } from "../src/quota/next-use.js"

test("Plus preview reuses its own private capability, coalesces reads and clears failures", async () => {
  let now = 1000
  let calls = 0
  let unavailable = false
  const input = { sessionID: "chat", providerID: "cliproxyapi", modelID: "claude-opus", all: false }
  const server = Bun.serve({
    port: 0,
    fetch(request) {
      calls++
      const url = new URL(request.url)
      expect(url.searchParams.get("model")).toBe("cliproxyapi/claude-opus")
      expect(request.headers.get("authorization")).toBe("Bearer private-capability")
      if (unavailable) return new Response("unavailable", { status: 503 })
      return Response.json({
        view: "usage",
        credentials: [],
        next_use: {
          v: 1,
          at_ms: now,
          expires_ms: now + 30000,
          mode: "dry-run",
          provider: "claude",
          model: "claude-opus",
          auth: "b",
          reason: "cold_move",
          forced: false,
        },
      })
    },
  })
  try {
    const read = createNextUse({
      now: () => now,
      fetch,
      read: async (key) => {
        expect(key).toBe("quota/chat/cliproxyapi/claude-opus")
        return { replay: false, capability: "private-capability", cursor: 0, generation: 0, retryIntent: "" }
      },
    })
    expect(await read(undefined, input)).toBeUndefined()
    expect(await read(server.url.href, { ...input, sessionID: undefined })).toBeUndefined()
    expect(calls).toBe(0)
    const results = await Promise.all([read(server.url.href, input), read(server.url.href, input)])
    expect(results.map((value) => value?.auth)).toEqual(["b", "b"])
    expect(calls).toBe(1)
    now += 16000
    unavailable = true
    expect(await read(server.url.href, input)).toBeUndefined()
    expect(calls).toBe(2)
    const unbound = createNextUse({ now: () => now, fetch, read: async () => undefined })
    expect(await unbound(server.url.href, input)).toBeUndefined()
    expect(calls).toBe(2)
  } finally {
    server.stop(true)
  }
})
