import { expect, test } from "bun:test"
import { cacheOf, createChatView, createNextUse, nextUseOf } from "../src/quota/next-use.js"

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
          mode: "active",
          provider: "claude",
          model: "claude-opus",
          auth: "b",
          reason: "cold_move",
          forced: false,
          warm: true,
          force_auth: "c",
          force_alias: "C",
          force_reason: "soon",
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
    // The preview passes on Pacer's view of the chat's cache and its forced-move target.
    expect(results[0]).toMatchObject({ warm: true, force_auth: "c", force_alias: "C", force_reason: "soon" })
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

test("one read gives the preview and Pacer's cache warmth, on this clock; a newer answer is read when asked", async () => {
  let now = 1_000_000
  let calls = 0
  // Pacer's clock runs 40 s ahead of this process.
  const skew = 40_000
  let cache: Record<string, unknown> | undefined = { v: 1, provider: "claude", model: "claude-opus", auth: "a", warm: true, evidence: "confirmed", until_ms: now + skew + 120_000 }
  const input = { sessionID: "chat", providerID: "cliproxyapi", modelID: "claude-opus" }
  const server = Bun.serve({
    port: 0,
    fetch() {
      calls++
      return Response.json({
        view: "usage",
        now_ms: now + skew,
        credentials: [],
        next_use: { v: 1, at_ms: now + skew, expires_ms: now + skew + 30_000, mode: "active", provider: "claude", model: "claude-opus", reason: "warm", forced: false },
        ...(cache === undefined ? {} : { cache }),
      })
    },
  })
  try {
    const view = createChatView({
      now: () => now,
      fetch,
      read: async () => ({ replay: false, capability: "private-capability", cursor: 0, generation: 0, retryIntent: "" }),
    })
    const read = await view(server.url.href, input)
    expect(cacheOf(read, "claude-opus")).toEqual({ warm: true, evidence: "confirmed", until: now + 120_000, at: now })
    expect(nextUseOf(await view(server.url.href, input), "claude-opus", now)?.reason).toBe("warm")
    expect(calls).toBe(1)
    // An answer about another model says nothing about this one.
    expect(cacheOf(read, "claude-sonnet")).toBeUndefined()
    // A caller that needs an answer from after a moment reads again; a newer cached one is reused.
    now += 5_000
    cache = { ...cache, warm: false, until_ms: now + skew - 1_000 }
    const fresh = await view(server.url.href, input, now)
    expect(calls).toBe(2)
    expect(cacheOf(fresh, "claude-opus")).toEqual({ warm: false, evidence: "confirmed", until: now - 1_000, at: now })
    await view(server.url.href, input, now - 1)
    expect(calls).toBe(2)
    // An older Pacer sends no cache field.
    cache = undefined
    now += 16_000
    expect(cacheOf(await view(server.url.href, input), "claude-opus")).toBeUndefined()
    expect(calls).toBe(3)
  } finally {
    server.stop(true)
  }
})
