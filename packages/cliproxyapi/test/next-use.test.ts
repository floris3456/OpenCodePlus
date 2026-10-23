import { expect, test } from "bun:test"
import { cacheOf, createChatView, createNextUse, nextUseOf, usedUpOf } from "../src/quota/next-use.js"

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

/** A chat view whose Pacer answers when the test says, on a clock the test moves. */
function scriptedView(start: number) {
  const clock = { now: start }
  const requests: Array<{
    url: URL
    signal: AbortSignal | null | undefined
    answer: (outcome: Response | Error) => void
  }> = []
  // A read starts with its binding lookup, synchronously, so `reads` counts the reads begun.
  const counts = { reads: 0 }
  const fake = Object.assign(
    (input: Parameters<typeof fetch>[0], init?: RequestInit) =>
      new Promise<Response>((resolve, reject) => {
        requests.push({
          url: new URL(String(input)),
          signal: init?.signal,
          answer: (outcome) => (outcome instanceof Error ? reject(outcome) : resolve(outcome)),
        })
      }),
    { preconnect: fetch.preconnect },
  )
  const view = createChatView({
    now: () => clock.now,
    fetch: fake,
    read: async () => {
      counts.reads++
      return { replay: false, capability: "private-capability", cursor: 0, generation: 0, retryIntent: "" }
    },
  })
  const requested = async (count: number) => {
    const deadline = Date.now() + 3000
    while (requests.length < count) {
      if (Date.now() > deadline) throw new Error("the read did not reach Pacer")
      await Bun.sleep(1)
    }
    return requests[count - 1]!
  }
  return { clock, requests, counts, view, requested }
}

const chat = { sessionID: "chat", providerID: "cliproxyapi", modelID: "claude-opus" }
const ORIGIN = "http://cpa.test"

test("one read per chat and model is in flight; a caller that needs a newer answer joins it", async () => {
  const pacer = scriptedView(1_000_000)
  const first = pacer.view(ORIGIN, chat)
  const request = await pacer.requested(1)
  expect(request.url.searchParams.get("model")).toBe("cliproxyapi/claude-opus")
  expect(request.signal).toBeInstanceOf(AbortSignal)
  // Pacer is slow: past the coalescing window, and asking for an answer from now, no second read starts.
  pacer.clock.now += 20_000
  expect(pacer.view(ORIGIN, chat, pacer.clock.now)).toBe(first)
  expect(pacer.counts.reads).toBe(1)
  // Another chat is read on its own.
  const other = pacer.view(ORIGIN, { ...chat, sessionID: "other" })
  expect(pacer.counts.reads).toBe(2)
  request.answer(Response.json({ view: "usage", credentials: [] }))
  expect(await first).toEqual({ at: pacer.clock.now, view: { view: "usage", credentials: [] } })
  // Once it has answered, an answer newer than that read is read again.
  const fresh = pacer.view(ORIGIN, chat, pacer.clock.now)
  expect(pacer.counts.reads).toBe(3)
  ;(await pacer.requested(2)).answer(Response.json({ view: "usage", credentials: [] }))
  ;(await pacer.requested(3)).answer(Response.json({ view: "usage", credentials: [] }))
  await Promise.all([other, fresh])
})

test("latest answers at once with the last answered read, starts a due read and keeps the answer through a failure", async () => {
  const pacer = scriptedView(1_000_000)
  const answer = { view: "usage", next_use: { reason: "first" } }
  // Nothing answered yet: no wait, and the read starts.
  expect(pacer.view.latest(ORIGIN, chat)).toBeUndefined()
  expect(pacer.counts.reads).toBe(1)
  // While it is pending, nothing waits and no second read starts.
  expect(pacer.view.latest(ORIGIN, chat)).toBeUndefined()
  expect(pacer.counts.reads).toBe(1)
  ;(await pacer.requested(1)).answer(Response.json(answer))
  expect(await pacer.view(ORIGIN, chat)).toEqual({ at: 1_000_000, view: answer })
  expect(pacer.view.latest(ORIGIN, chat)).toEqual({ at: 1_000_000, view: answer })
  expect(pacer.counts.reads).toBe(1)
  // Past the coalescing window a new read starts; until it answers, and after it fails, the last answer stays.
  pacer.clock.now += 15_000
  expect(pacer.view.latest(ORIGIN, chat)).toEqual({ at: 1_000_000, view: answer })
  expect(pacer.counts.reads).toBe(2)
  ;(await pacer.requested(2)).answer(new Response("busy", { status: 503 }))
  expect(await pacer.view(ORIGIN, chat)).toBeUndefined()
  expect(pacer.view.latest(ORIGIN, chat)).toEqual({ at: 1_000_000, view: answer })
  expect(pacer.counts.reads).toBe(2)
  // No route or no chat: nothing to read.
  expect(pacer.view.latest(undefined, chat)).toBeUndefined()
  expect(pacer.view.latest(ORIGIN, { ...chat, sessionID: undefined })).toBeUndefined()
  expect(pacer.counts.reads).toBe(2)
})

test("a failed read is not repeated for 15 s, doubling to 2 minutes, nor before Retry-After; an answer resets it", async () => {
  const start = 1_000_000
  const pacer = scriptedView(start)
  // At `at` ms from the start, asks for an answer from then. Returns whether a read started.
  const ask = (at: number) => {
    pacer.clock.now = start + at
    const before = pacer.counts.reads
    const result = pacer.view(ORIGIN, chat, pacer.clock.now)
    return { started: pacer.counts.reads > before, result }
  }
  const failAt = async (at: number, outcome: Response | Error) => {
    const asked = ask(at)
    expect(asked.started).toBe(true)
    ;(await pacer.requested(pacer.counts.reads)).answer(outcome)
    expect(await asked.result).toBeUndefined()
  }
  await failAt(0, new Response("busy", { status: 503 }))
  expect(ask(14_999).started).toBe(false)
  await failAt(15_000, Response.json({ error: "cache_records_busy" }, { status: 503 }))
  expect(ask(44_999).started).toBe(false)
  // Pacer's Retry-After is longer than the backoff (60 s by now).
  await failAt(45_000, new Response("busy", { status: 503, headers: { "Retry-After": "300" } }))
  expect(ask(344_999).started).toBe(false)
  // A timeout or no connection counts as a failure; the backoff stops doubling at 2 minutes.
  await failAt(345_000, new DOMException("The operation timed out.", "TimeoutError"))
  expect(ask(464_999).started).toBe(false)
  await failAt(
    465_000,
    new Response("slow down", {
      status: 429,
      headers: { "Retry-After": new Date(start + 465_000 + 600_000).toUTCString() },
    }),
  )
  expect(ask(1_064_999).started).toBe(false)
  // A chat in backoff holds back no other chat.
  const other = pacer.view(ORIGIN, { ...chat, sessionID: "other" })
  expect(pacer.counts.reads).toBe(6)
  ;(await pacer.requested(6)).answer(Response.json({ view: "usage", credentials: [] }))
  await other
  // An answer ends the backoff: the next failure waits 15 s again.
  const answered = ask(1_065_000)
  expect(answered.started).toBe(true)
  ;(await pacer.requested(7)).answer(Response.json({ view: "usage", credentials: [] }))
  expect((await answered.result)?.at).toBe(start + 1_065_000)
  await failAt(1_065_001, new Response("broken", { status: 500 }))
  expect(ask(1_080_000).started).toBe(false)
  expect(ask(1_080_001).started).toBe(true)
  ;(await pacer.requested(9)).answer(Response.json({ view: "usage", credentials: [] }))
})

test("only Pacer's forced move now marks the chat's account used up, with when it serves again", () => {
  const now = 1_000_000
  const read = (next: Record<string, unknown>) => ({
    at: now,
    view: {
      view: "usage",
      credentials: [],
      next_use: {
        v: 1,
        at_ms: now,
        expires_ms: now + 30_000,
        mode: "active",
        provider: "claude",
        model: "claude-opus",
        reason: "forced_move",
        forced: true,
        auth: "b",
        alias: "B",
        force_auth: "b",
        force_alias: "B",
        force_reason: "now",
        ...next,
      },
    },
  })
  // An older Pacer does not say when the account serves again.
  expect(usedUpOf(read({}), "claude-opus", now)).toEqual({})
  // Pacer's clock runs 40 s ahead: the reset 8 minutes after its preview is 8 minutes after this read.
  expect(usedUpOf(read({ at_ms: now + 40_000, expires_ms: now + 70_000, serves_at_ms: now + 40_000 + 8 * 60_000 }), "claude-opus", now)).toEqual({
    servesAt: now + 8 * 60_000,
  })
  // A meter near its floor still serves the next step.
  expect(usedUpOf(read({ reason: "cold_stay", forced: false, auth: undefined, alias: undefined, force_reason: "soon" }), "claude-opus", now)).toBeUndefined()
  // A dry-run Pacer moves nothing.
  expect(usedUpOf(read({ mode: "dry-run" }), "claude-opus", now)).toBeUndefined()
  // No other account can take the chat: Pacer names no move.
  expect(
    usedUpOf(
      read({ reason: "no_eligible", forced: false, auth: undefined, alias: undefined, force_auth: undefined, force_alias: undefined, force_reason: undefined }),
      "claude-opus",
      now,
    ),
  ).toBeUndefined()
  expect(usedUpOf(read({}), "claude-sonnet", now)).toBeUndefined()
  expect(usedUpOf(read({}), "claude-opus", now + 30_000)).toBeUndefined()
  expect(usedUpOf(undefined, "claude-opus", now)).toBeUndefined()
})
