import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Exit, Schema, Scope, Stream } from "effect"
import { createLedger, defaultLedgerPath, ledgerAt, type Ledger } from "../src/monitor/ledger.js"
import { fingerprintWireBody, sha256 } from "../src/monitor/fingerprint.js"
import { monitorFact, watchMonitor } from "../src/monitor/plugin.js"
import { cleanupLedgers, collect, ledger, script, usage } from "./monitor-fixture.js"
import { context, fullContext } from "./harness.js"
import plus, { createState, decideWarmingFor } from "../src/index.js"
import { warmingStore } from "../src/warming.js"
import { prefixDiff } from "../src/monitor/cache.js"

const priorData = process.env.XDG_DATA_HOME
const roots: string[] = []
const opened: string[] = []

const modelRef = (p: string, m: string) =>
  Model.Ref.make({ providerID: Provider.ID.make(p), id: Model.ID.make(m) })

test("joined Responses instructions and chat content arrays retain AGENTS.md as the changed source", () => {
  for (const protocol of ["openai-responses", "openai-chat"] as const) {
    const make = (rules: string) => {
      const parts = [{ name: "base template", text: "Base instructions" }, { name: "AGENTS.md", text: rules }]
      return { requestID: "r", sessionID: "s", ...fingerprintWireBody(protocol === "openai-responses"
        ? { instructions: parts.map((p) => p.text).join("\n\n"), input: [] }
        : { messages: [{ role: "system", content: parts.map((p) => ({ type: "text", text: p.text })) }] },
      { protocol, namedSystemParts: parts }) }
    }
    const diff = prefixDiff(make("old rules"), make("new rules"))
    expect(diff.changes.map((part) => part.name)).toEqual(["system part AGENTS.md"])
    expect(diff.append).toBe(false)
  }
})

test("cache-affecting tool choices, context management, chat cache markers and marker ttl are fingerprinted", () => {
  for (const protocol of ["openai-responses", "openai-chat", "anthropic-messages"] as const) {
    const original = { input: [], messages: [{ role: "system", content: [{ type: "text", text: "rules", cache_control: { type: "ephemeral", ttl: "5m" } }] }], tool_choice: "auto", context_management: { edits: [] } }
    const a = fingerprintWireBody(original, { protocol })
    const b = fingerprintWireBody({ ...original, tool_choice: "none" }, { protocol })
    expect(a.optionsKeys.tool_choice).not.toBe(b.optionsKeys.tool_choice)
    if (protocol === "openai-chat") expect(a.cacheControl).toContainEqual({ target: "messages[0].content[0]", type: "ephemeral", ttl: "5m" })
    if (protocol === "anthropic-messages") {
      expect(a.optionsKeys.context_management).toBeDefined()
      const c = fingerprintWireBody({ ...original, cache_control: { type: "ephemeral", ttl: "1h" } }, { protocol })
      expect(c.cacheControl).toContainEqual({ target: "top", type: "ephemeral", ttl: "1h" })
      expect(c.cacheControl).toContainEqual({ target: "messages[0].content[0]", type: "ephemeral", ttl: "5m" })
    }
  }
})

test("warmed is only a notification and leaves Plus warming state and settings unchanged", async () => {
  const state = createState()
  const before = JSON.stringify(state)
  const event: SessionHooks["warming"] = { sessionID: Session.ID.make("ses_warmed"), agent: Agent.ID.make("build"), model: modelRef("openai", "gpt-4o"), phase: "warmed", now: 2000, since: 1000, settings: { prompt: "ping", interval: 100, duration: 1000 } }
  await Effect.runPromise(decideWarmingFor(context(), state, event))
  expect(JSON.stringify(state)).toBe(before)
  expect(event.settings).toEqual({ prompt: "ping", interval: 100, duration: 1000 })
})

// #26: core runs the warming hooks in registration order on one event and
// uses the settings the last one leaves. The monitor's fact must record Plus's
// decision, not core's proposal, so the real entrypoint decides first.
test("the entrypoint's warming fact records Plus's decision: a chat switched off is stored as off", async () => {
  await dataHome()
  const project = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-monitor-warm-"))
  roots.push(project)
  const { hooks, hookFn } = makeHookRegistry()
  const ctx = {
    ...fullContext({ directory: project, session: { hook: hookFn as never } }),
    rpc: Object.assign(
      () => {
        throw new Error("unused rpc.client")
      },
      { register: () => Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } }) },
    ),
  } as Context
  const sessionID = Session.ID.make("ses_warming_off")
  await warmingStore.setChat(sessionID, "off")
  const scope = await Effect.runPromise(Scope.make())
  try {
    await Effect.runPromise(plus.effect(ctx).pipe(Effect.provideService(Scope.Scope, scope)))
    const event: SessionHooks["warming"] = {
      sessionID,
      agent: Agent.ID.make("build"),
      model: modelRef("openai", "gpt-4o"),
      phase: "activity",
      kind: "primary",
      since: 1000,
      now: 1000,
      settings: { prompt: "ping", interval: 60_000, duration: 300_000 },
    }
    for (const cb of hooks.warming ?? []) await Effect.runPromise(cb(event))
    expect(event.settings).toBeUndefined()
    const facts = ledgerAt().getContextFacts(sessionID).filter((fact) => fact.kind === "warming")
    expect(facts.map((fact) => fact.detail)).toEqual([{ state: "off", phase: "activity", since: 1000 }])
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void))
    await warmingStore.setChat(sessionID, "default")
  }
}, 30000)

test("delayed step A outcomes cannot consume request B; retries and both collectors are idempotent", async () => {
  const db = await ledger()
  const clock = { now: 9000 }
  const one = collect(db, clock)
  const two = collect(db, clock)
  const start = (id: string, at: number) => ({ type: "session.step.started", created: at, data: { sessionID: "s", assistantMessageID: id, started: at } })
  const end = (id: string, at: number) => ({ type: "session.step.ended", created: at, data: { sessionID: "s", assistantMessageID: id, finish: "stop", tokens: usage(100, 10) } })
  const events = [start("A", 100), start("B", 300), end("A", 200), end("B", 400)]
  one.observe(events[0]!)
  db.requestStarted({ id: "a1", sessionID: "s", kind: "step", started: 110 })
  db.requestStarted({ id: "a2", sessionID: "s", kind: "step", started: 150 })
  // Wire B can precede delivery of either durable event to the subscriber.
  db.requestStarted({ id: "b", sessionID: "s", kind: "step", started: 310 })
  one.observe(events[1]!)
  one.observe(events[2]!)
  expect(db.getRequest("b")?.ended).toBeUndefined()
  one.observe(events[3]!)
  const before = db.getRequests("s")
  expect(before.map((r) => [r.id, r.messageID, r.error, r.inputTokens])).toEqual([["a1", undefined, "retried", 0], ["a2", "A", undefined, 100], ["b", "B", undefined, 100]])
  for (const observer of [one, two]) events.forEach((event) => observer.observe(event))
  expect(db.getRequests("s")).toEqual(before)
})

test("compaction totals go to the final attempt, failures end requests, and replay changes nothing", async () => {
  const db = await ledger()
  const one = collect(db, { now: 9000 })
  const two = collect(db, { now: 9000 })
  const start = { type: "session.compaction.started", created: 100, data: { sessionID: "s" } }
  const end = { type: "session.compaction.ended", created: 200, data: { sessionID: "s", tokens: usage(700, 30) } }
  db.requestStarted({ id: "c1", sessionID: "s", kind: "compaction", started: 110 })
  db.requestStarted({ id: "c2", sessionID: "s", kind: "compaction", started: 120 })
  one.observe(start)
  one.observe(end)
  const failureStart = { ...start, created: 300 }
  const failure = { type: "session.compaction.failed", created: 400, data: { sessionID: "s", tokens: usage(10, 2), error: { type: "ProviderError", message: "PRIVATE COMPACTION TEXT" } } }
  one.observe(failureStart)
  db.requestStarted({ id: "c3", sessionID: "s", kind: "compaction", started: 310 })
  one.observe(failure)
  expect(db.getRequest("c1")?.error).toBe("retried")
  expect(db.getRequest("c1")?.inputTokens).toBe(0)
  expect(db.getRequest("c2")?.inputTokens).toBe(700)
  expect(db.getRequest("c3")?.status).toBe("error")
  expect(db.getRequest("c3")?.error).not.toContain("PRIVATE")
  const before = [db.getRequests("s"), db.getContextFacts("s"), db.db.query("select * from step").all()]
  for (const observer of [one, two]) [start, end, failureStart, failure].forEach((event) => observer.observe(event))
  expect([db.getRequests("s"), db.getContextFacts("s"), db.db.query("select * from step").all()]).toEqual(before)
})

test("final wire observers capture later HTTP and WebSocket transforms and hashed response lineage", async () => {
  const db = await ledger()
  const { hooks, hookFn } = makeHookRegistry()
  const ctx = context({ event: { subscribe: () => Stream.empty as never }, session: { hook: hookFn as never } })
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* watchMonitor(ctx, () => undefined, () => db)
    const common = { sessionID: Session.ID.make("ses_final"), agent: Agent.ID.make("build"), model: modelRef("openai", "gpt-4o"), kind: "primary" as const }
    const http: SessionHooks["http.request"] = { ...common, requestID: "http", started: 100, request: new Request("https://example.test/responses", { method: "POST", body: '{"input":[]}' }) }
    for (const cb of hooks["http.request"] ?? []) yield* cb(http)
    const final = '{"input":[],"instructions":"later plugin","tool_choice":"none"}'
    http.request = new Request(http.request.url, { method: "POST", body: final })
    for (const observe of http.observers ?? []) yield* observe(http.request)
    expect(db.getFingerprint("http")?.bodyHash).toBe(sha256(final))
    const response: SessionHooks["http.response"] = { ...common, request: http.request, response: new Response('data: {"type":"response.created","response":{"id":"private-response-id"}}\n\n') }
    for (const cb of hooks["http.response"] ?? []) yield* cb(response)
    yield* Effect.promise(() => response.response.text())
    expect(db.getFingerprint("http")?.responseId).toBe(sha256("private-response-id"))
    const ws: SessionHooks["experimental.ws.send"] = { ...common, requestID: "ws", started: 200, frame: '{"input":[]}' }
    for (const cb of hooks["experimental.ws.send"] ?? []) yield* cb(ws)
    ws.frame = '{"input":[],"previous_response_id":"private-response-id"}'
    for (const observe of ws.observers ?? []) yield* observe(ws.frame)
    for (const cb of hooks["experimental.ws.receive"] ?? []) yield* cb({ ...common, frame: '{"type":"response.created","response":{"id":"next-private-id"}}' })
    expect(db.getFingerprint("ws")?.bodyHash).toBe(sha256(ws.frame))
    expect(db.getFingerprint("ws")?.previousResponseId).toBe(sha256("private-response-id"))
    expect(db.getFingerprint("ws")?.responseId).toBe(sha256("next-private-id"))
    expect(JSON.stringify(db.getFingerprints("ses_final"))).not.toContain("private")
    // A denied monitor write must not break either transport at its final boundary.
    db.db.exec("pragma query_only = ON")
    for (const observe of http.observers ?? []) yield* observe(http.request)
    for (const observe of ws.observers ?? []) yield* observe(ws.frame)
    db.db.exec("pragma query_only = OFF")
  })))
})

test("title and generate outcomes choose oldest request inside their window and replay across instances is inert", async () => {
  const db = await ledger()
  const { hooks, hookFn } = makeHookRegistry()
  const ctx = context({ event: { subscribe: () => Stream.empty as never }, session: { hook: hookFn as never } })
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* watchMonitor(ctx, () => undefined, () => db)
    yield* watchMonitor(ctx, () => undefined, () => db)
    const common = { sessionID: Session.ID.make("ses_aux"), agent: Agent.ID.make("build"), model: modelRef("openai", "gpt-4o") }
    for (const kind of ["title", "generate"] as const) {
      const event: SessionHooks["http.request"] = { ...common, kind, started: 110, requestID: kind, request: new Request("https://example.test/responses", { method: "POST", body: '{"input":[]}' }) }
      for (const cb of hooks["http.request"] ?? []) yield* cb(event)
      db.requestStarted({ id: `${kind}-later`, sessionID: "ses_aux", kind, started: 310 })
      for (let replay = 0; replay < 2; replay++) for (const cb of hooks.generated ?? []) yield* cb({ ...common, kind, started: 100, ended: 200, usage: usage(100, 20, 500), cost: 0.01 })
      expect(db.getRequest(kind)).toMatchObject({ inputTokens: 100, cacheReadTokens: 500, cost: 0.01, status: "completed", isTitle: kind === "title" })
      expect(db.getRequest(`${kind}-later`)?.ended).toBeUndefined()
      for (const cb of hooks.generated ?? []) yield* cb({ ...common, kind, started: 300, ended: 400, error: "secret rejected prompt" })
      expect(db.getRequest(`${kind}-later`)?.status).toBe("error")
      expect(JSON.parse(db.getRequest(`${kind}-later`)!.error!)).toMatchObject({ hash: sha256("secret rejected prompt"), chars: 22 })
    }
    expect(db.getRequests("ses_aux")).toHaveLength(4)
    for (const cb of hooks.warming ?? []) yield* cb({ ...common, phase: "warmed", now: 400, since: 100, settings: undefined })
    expect(db.getRequest("generate-later")?.kind).toBe("ping")
    expect(db.getRequest("generate")?.kind).toBe("generate")
  })))
})

test("HTTP failures identify their own wire request and refuse to consume unrelated open rows", async () => {
  const db = await ledger()
  const { hooks, hookFn } = makeHookRegistry()
  const ctx = context({ event: { subscribe: () => Stream.empty as never }, session: { hook: hookFn as never } })
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* watchMonitor(ctx, () => undefined, () => db)
    const common = { sessionID: Session.ID.make("ses_http_failure"), agent: Agent.ID.make("build"), model: modelRef("openai", "gpt-4o"), kind: "primary" as const }
    db.requestStarted({ id: "older", sessionID: common.sessionID, kind: "step", started: 50 })
    const event: SessionHooks["http.request"] = { ...common, started: 100, requestID: "failure", request: new Request("https://example.test/responses", { method: "POST", body: '{"input":[]}' }) }
    for (const cb of hooks["http.request"] ?? []) yield* cb(event)
    for (const observe of event.observers ?? []) yield* observe(event.request)
    for (const cb of hooks["http.response"] ?? []) yield* cb({ ...common, request: event.request, response: new Response("PRIVATE ERROR BODY", { status: 429 }) })
    expect(JSON.parse(db.getRequest("failure")!.error!)).toMatchObject({ type: "HttpError", status: 429, hash: sha256(""), chars: 0 })
    for (const cb of hooks["http.response"] ?? []) yield* cb({ ...common, request: new Request("https://example.test/unknown"), response: new Response("PRIVATE ERROR BODY", { status: 500 }) })
    expect(db.getRequest("older")?.ended).toBeUndefined()
    expect(JSON.stringify(db.getRequests(common.sessionID))).not.toContain("PRIVATE")
  })))
})

afterEach(async () => {
  cleanupLedgers()
  opened.splice(0).forEach((file) => ledgerAt(file).close())
  if (priorData === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = priorData
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function dataHome(): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-monitor-req-"))
  roots.push(root)
  process.env.XDG_DATA_HOME = path.join(root, "data")
  opened.push(defaultLedgerPath())
  return root
}

type HookCallbackMap = {
  [K in keyof SessionHooks]?: Array<(event: SessionHooks[K]) => Effect.Effect<void, never, never>>
}

function makeHookRegistry() {
  const hooks: HookCallbackMap = {}
  const hookFn = <K extends keyof SessionHooks>(name: K, cb: (event: SessionHooks[K]) => Effect.Effect<void, never, never>) => {
    const list = (hooks[name] ?? []) as Array<(event: SessionHooks[K]) => Effect.Effect<void, never, never>>
    list.push(cb)
    hooks[name] = list as never
    return Effect.sync(() => ({
      dispose: Effect.sync(() => {
        const l = hooks[name]
        if (l) {
          const idx = l.indexOf(cb as never)
          if (idx !== -1) l.splice(idx, 1)
        }
      }),
    }))
  }
  return { hooks, hookFn }
}

test("every provider-path monitor hook and reusable fact writer contain ledger failures", async () => {
  const { hooks, hookFn } = makeHookRegistry()
  const ctx = context({ event: { subscribe: () => Stream.empty as never }, session: { hook: hookFn as never } })
  const refuse = () => { throw new Error("read-only file system") }
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* watchMonitor(ctx, () => undefined, refuse)
    const common = { sessionID: Session.ID.make("ses_fail"), agent: Agent.ID.make("build"), model: modelRef("openai", "gpt-4o") }
    for (const cb of hooks["http.request"] ?? []) yield* cb({ ...common, kind: "primary", request: new Request("https://example.test/chat/completions", { method: "POST", body: '{"messages":[]}' }) })
    for (const cb of hooks["http.response"] ?? []) yield* cb({ ...common, kind: "primary", request: new Request("https://example.test"), response: new Response("", { status: 500 }) })
    for (const cb of hooks.context ?? []) yield* cb({ ...common, system: [], messages: [], options: {}, tools: {} })
    for (const cb of hooks.context ?? []) yield* cb({ ...common, get system(): SessionHooks["context"]["system"] { throw new Error("context failed") }, messages: [], options: {}, tools: {} })
    for (const cb of hooks["experimental.ws.send"] ?? []) yield* cb({ ...common, kind: "primary", frame: '{"input":[]}' })
    for (const cb of hooks.generated ?? []) yield* cb({ ...common, error: "test error" })
    for (const cb of hooks.warming ?? []) yield* cb({ ...common, phase: "warmed", now: 1000, since: 0, settings: undefined })
    expect(hooks.context?.length).toBe(1)
    expect(hooks["http.request"]?.length).toBe(1)
  })))
  expect(() => monitorFact({ sessionID: "ses_fail", at: 1000, kind: "account_switch" }, refuse)).not.toThrow()
})

test("request hooks record model pricing once per change for historical miss costs", async () => {
  const db = await ledger()
  const { hooks, hookFn } = makeHookRegistry()
  const ctx = context({
    event: { subscribe: () => Stream.empty as never },
    session: { hook: hookFn as never },
    model: { ...context().model, list: () => Effect.succeed({ location: { directory: "/fixture" }, data: [{
      ...Model.Info.default(Provider.ID.make("openai"), Model.ID.make("gpt-4o")),
      cost: [Schema.decodeUnknownSync(Model.Cost)({ input: 2, output: 5, cache: { read: 0.1, write: 3 } })],
    }] }) as never },
  })
  await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    yield* watchMonitor(ctx, () => undefined, () => db)
    for (let i = 0; i < 2; i++) for (const cb of hooks["http.request"] ?? []) yield* cb({
      sessionID: Session.ID.make("ses_pricing"), agent: Agent.ID.make("build"), model: modelRef("openai", "gpt-4o"), kind: "primary",
      request: new Request("https://example.test/chat/completions", { method: "POST", body: '{"messages":[]}' }),
    })
  })))
  expect(db.getContextFacts("ses_pricing").filter((f) => f.kind === "pricing")).toHaveLength(1)
  expect(db.getContextFacts("ses_pricing")[0]?.detail).toMatchObject({ provider: "openai", model: "gpt-4o", rates: [{ input: 2, output: 5, cache: { read: 0.1, write: 3 } }] })
})

test("fingerprints from real request bodies for each protocol with short hashes", async () => {
  // 1. OpenAI Responses
  const openaiResponsesBody = {
    model: "gpt-4o",
    instructions: "You are an assistant. Date: 2026-10-04. <env>Platform: linux</env>",
    input: [
      { id: "msg_1", role: "user", content: [{ type: "text", text: "Hello" }] },
      { id: "msg_2", role: "assistant", content: [{ type: "text", text: "Hi there" }] },
      { id: "msg_3", role: "user", content: [{ type: "text", text: "Fix the bug" }] },
    ],
    tools: [
      {
        type: "function",
        name: "shell",
        description: "Run command in terminal",
        parameters: { type: "object", properties: { command: { type: "string" } }, required: ["command"] },
      },
    ],
    prompt_cache_key: "ses_resp_123",
    reasoning: { effort: "high" },
    temperature: 0.7,
    max_output_tokens: 4096,
  }

  const fpResponses = fingerprintWireBody(openaiResponsesBody, { url: "https://api.openai.com/v1/responses" })
  expect(fpResponses.protocol).toBe("openai-responses")
  expect(fpResponses.systemParts.length).toBe(1)
  expect(fpResponses.systemParts[0]?.source).toBe("date/environment block")
  expect(fpResponses.systemParts[0]?.chars).toBe(openaiResponsesBody.instructions.length)
  expect(fpResponses.systemParts[0]?.hash.length).toBe(16)
  expect(fpResponses.tools.length).toBe(1)
  expect(fpResponses.tools[0]?.name).toBe("shell")
  expect(fpResponses.tools[0]?.descHash.length).toBe(16)
  expect(fpResponses.tools[0]?.schemaHash.length).toBe(16)
  expect(fpResponses.tools[0]?.descHash).not.toBe(fpResponses.tools[0]?.schemaHash)
  expect(fpResponses.cacheKey).toBe(sha256("ses_resp_123"))
  expect(fpResponses.optionsKeys["prompt_cache_key"]?.length).toBe(16)
  expect(fpResponses.optionsKeys["reasoning"]?.length).toBe(16)
  expect(fpResponses.optionsKeys["temperature"]?.length).toBe(16)
  expect(fpResponses.optionsHash.length).toBe(16)
  expect(fpResponses.bodyHash.length).toBe(16)
  expect(fpResponses.messagePrefixes.length).toBe(3)
  expect(fpResponses.messagePrefixes[0]?.role).toBe("user")
  expect(fpResponses.messagePrefixes[0]?.messageId).toBe("msg_1")
  expect(fpResponses.messagePrefixes[0]?.prefixHash.length).toBe(16)
  expect(fpResponses.messagePrefixes[1]?.messageId).toBe("msg_2")
  expect(fpResponses.messagePrefixes[2]?.messageId).toBe("msg_3")

  // Rolling prefix hash verification: identical prefix gives identical rolling hash; diverging message diverges
  const divergingResponsesBody = {
    ...openaiResponsesBody,
    input: [
      openaiResponsesBody.input[0],
      openaiResponsesBody.input[1],
      { id: "msg_diverged", role: "user", content: [{ type: "text", text: "Different question" }] },
    ],
  }
  const fpDiverging = fingerprintWireBody(divergingResponsesBody, { url: "https://api.openai.com/v1/responses" })
  expect(fpDiverging.messagePrefixes[0]?.prefixHash).toBe(fpResponses.messagePrefixes[0]?.prefixHash)
  expect(fpDiverging.messagePrefixes[1]?.prefixHash).toBe(fpResponses.messagePrefixes[1]?.prefixHash)
  expect(fpDiverging.messagePrefixes[2]?.prefixHash).not.toBe(fpResponses.messagePrefixes[2]?.prefixHash)

  // 2. OpenAI Chat
  const openaiChatBody = {
    model: "gpt-4o",
    messages: [
      { role: "system", content: "You are a helpful coding assistant." },
      { role: "system", content: "<env>Platform: linux</env> Today's date: Sun Oct 04 2026" },
      { id: "chat_1", role: "user", content: "Implement monitor v2" },
      { id: "chat_2", role: "assistant", content: "Working on it" },
    ],
    tools: [
      {
        type: "function",
        function: {
          name: "read",
          description: "Read file",
          parameters: { type: "object", properties: { path: { type: "string" } } },
        },
      },
    ],
    temperature: 0.1,
    max_tokens: 8192,
  }
  const fpChat = fingerprintWireBody(openaiChatBody, { url: "https://api.openai.com/v1/chat/completions" })
  expect(fpChat.protocol).toBe("openai-chat")
  expect(fpChat.systemParts.length).toBe(2)
  expect(fpChat.systemParts[0]?.source).toBe("base template")
  expect(fpChat.systemParts[1]?.source).toBe("date/environment block")
  expect(fpChat.tools.length).toBe(1)
  expect(fpChat.tools[0]?.name).toBe("read")
  expect(fpChat.tools[0]?.descHash.length).toBe(16)
  expect(fpChat.tools[0]?.schemaHash.length).toBe(16)
  expect(fpChat.optionsKeys["temperature"]?.length).toBe(16)
  expect(fpChat.optionsKeys["max_tokens"]?.length).toBe(16)
  expect(fpChat.messagePrefixes.length).toBe(2)
  expect(fpChat.messagePrefixes[0]?.messageId).toBe("chat_1")
  expect(fpChat.messagePrefixes[0]?.prefixHash.length).toBe(16)

  // 3. Anthropic Messages
  const anthropicBody = {
    model: "claude-3-7-sonnet-20250219",
    system: [
      { type: "text", text: "You are Claude.", cache_control: { type: "ephemeral" } },
      { type: "text", text: "Follow coding conventions." },
    ],
    messages: [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      { role: "assistant", content: [{ type: "text", text: "Hi there" }] },
    ],
    tools: [
      {
        name: "bash",
        description: "Run command",
        input_schema: { type: "object", properties: { cmd: { type: "string" } } },
        cache_control: { type: "ephemeral" },
      },
    ],
    thinking: { type: "enabled", budget_tokens: 2048 },
    output_config: { effort: "high" },
    max_tokens: 16000,
  }
  const fpAnthropic = fingerprintWireBody(anthropicBody, { url: "https://api.anthropic.com/v1/messages" })
  expect(fpAnthropic.protocol).toBe("anthropic-messages")
  expect(fpAnthropic.systemParts.length).toBe(2)
  expect(fpAnthropic.tools.length).toBe(1)
  expect(fpAnthropic.tools[0]?.name).toBe("bash")
  expect(fpAnthropic.tools[0]?.descHash.length).toBe(16)
  expect(fpAnthropic.tools[0]?.schemaHash.length).toBe(16)
  expect(fpAnthropic.optionsKeys["thinking"]?.length).toBe(16)
  expect(fpAnthropic.optionsKeys["output_config"]?.length).toBe(16)
  expect(fpAnthropic.cacheControl).toBeDefined()
  expect(fpAnthropic.cacheControl?.some((cc) => cc.target === "system[0]")).toBe(true)
  expect(fpAnthropic.cacheControl?.some((cc) => cc.target === "tools[0]")).toBe(true)
  expect(fpAnthropic.messagePrefixes.length).toBe(2)

  // 4. Fallback for non-JSON or other formats
  const rawBody = "PLAIN_NON_JSON_WIRE_PAYLOAD_CHUNK_TEST_".repeat(50)
  const fpFallback = fingerprintWireBody(rawBody)
  expect(fpFallback.protocol).toBe("fallback")
  expect(fpFallback.messagePrefixes.length).toBeGreaterThan(0)
  expect(fpFallback.bodyHash.length).toBe(16)
})

test("system parts named by source wherever context hook names them", () => {
  const namedParts = [
    { name: "AGENTS.md", text: "# Project Rules\nAlways run tests." },
    { name: "Plus guidance row", text: "${OPENCODE_TOOL_GUIDANCE}\nUse read and edit." },
  ]
  const body = {
    model: "claude-3-7-sonnet",
    system: [
      { type: "text", text: "# Project Rules\nAlways run tests." },
      { type: "text", text: "${OPENCODE_TOOL_GUIDANCE}\nUse read and edit." },
      { type: "text", text: "Today's date: Sun Oct 04 2026. <env>Platform: linux</env>" },
    ],
    messages: [{ role: "user", content: "Hi" }],
    max_tokens: 1000,
  }
  const fp = fingerprintWireBody(body, { url: "/v1/messages", namedSystemParts: namedParts })
  expect(fp.systemParts[0]?.source).toBe("AGENTS.md")
  expect(fp.systemParts[1]?.source).toBe("Plus guidance row")
  expect(fp.systemParts[2]?.source).toBe("date/environment block")
})

test("v1 to v2 migration keeps v1 rows while creating empty v2 tables", async () => {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-v1-mig-"))
  const dbFile = path.join(dir, "monitor.db")
  const rawDb = new Database(dbFile, { create: true })

  // Construct v1 schema
  rawDb.exec(`
    create table session (id text primary key, parent_id text, agent text, title text, directory text, run_id text, role text, first_seen integer not null, last_seen integer not null);
    create table step (session_id text not null, message_id text not null, kind text not null, idx integer not null, epoch integer not null, agent text, provider text, model text, variant text, config text, started integer not null, ended integer, finish text, input integer not null default 0, output integer not null default 0, reasoning integer not null default 0, cache_read integer not null default 0, cache_write integer not null default 0, cost real not null default 0, primary key (session_id, message_id));
    create table call (session_id text not null, call_id text not null, message_id text not null, parent_call text, idx integer not null, epoch integer not null, agent text, model text, config text, tool text not null, target text, status text not null, error text, started integer not null, ended integer, input_chars integer not null default 0, result_chars integer not null default 0, call_tokens integer not null default 0, result_tokens integer not null default 0, measured integer not null default 0, primary key (session_id, call_id));
    create table call_hour (hour integer not null, session_id text not null, epoch integer not null, agent text not null, model text not null, config text not null, tool text not null, calls integer not null default 0, inner integer not null default 0, errors integer not null default 0, top_errors integer not null default 0, running integer not null default 0, call_tokens integer not null default 0, result_tokens integer not null default 0, result_idx integer not null default 0, estimated integer not null default 0, duration integer not null default 0, timed integer not null default 0, primary key (hour, session_id, epoch, agent, model, config, tool));
    create table epoch (session_id text not null, epoch integer not null, last_idx integer not null, primary key (session_id, epoch));
    create table mark (id integer primary key autoincrement, at integer not null, label text not null);
    create table meta (key text primary key, value text not null);
    insert into meta (key, value) values ('schema', '1');
  `)

  // Insert v1 rows
  rawDb.query("insert into session (id, agent, title, first_seen, last_seen) values ('ses_v1', 'build', 'v1 title', 100, 200)").run()
  rawDb.query("insert into step (session_id, message_id, kind, idx, epoch, started, input, output) values ('ses_v1', 'msg_v1', 'step', 0, 0, 100, 50, 20)").run()
  rawDb.query("insert into call (session_id, call_id, message_id, idx, epoch, tool, status, started, input_chars) values ('ses_v1', 'c_v1', 'msg_v1', 0, 0, 'read', 'completed', 100, 10)").run()
  rawDb.close()

  // Open through createLedger (migrates in place)
  const migrated = createLedger(dbFile)
  expect(migrated.db.query("select value from meta where key = 'schema'").get()).toEqual({ value: "2" })

  // Verify v1 rows are intact
  expect(migrated.db.query("select id, title from session where id = 'ses_v1'").get()).toEqual({ id: "ses_v1", title: "v1 title" })
  expect(migrated.db.query("select message_id, input from step where session_id = 'ses_v1'").get()).toEqual({ message_id: "msg_v1", input: 50 })
  expect(migrated.db.query("select call_id, tool from call where session_id = 'ses_v1'").get()).toEqual({ call_id: "c_v1", tool: "read" })

  // Verify new tables exist and start empty
  expect(migrated.db.query("select count(*) as count from request").get()).toEqual({ count: 0 })
  expect(migrated.db.query("select count(*) as count from request_fingerprint").get()).toEqual({ count: 0 })
  expect(migrated.db.query("select count(*) as count from context_fact").get()).toEqual({ count: 0 })

  migrated.close()
  await fs.rm(dir, { recursive: true, force: true })
})

test("privacy: no content stored (asserting on stored columns)", async () => {
  const db = await ledger()

  // Assert table schema columns
  const requestCols = db.db.query<{ name: string }, []>("pragma table_info(request)").all().map((r) => r.name)
  const fingerprintCols = db.db.query<{ name: string }, []>("pragma table_info(request_fingerprint)").all().map((r) => r.name)
  const factCols = db.db.query<{ name: string }, []>("pragma table_info(context_fact)").all().map((r) => r.name)

  const forbiddenColumns = ["prompt", "response", "content", "message", "body", "input_text", "output_text", "patch", "secret"]
  for (const forbidden of forbiddenColumns) {
    expect(requestCols).not.toContain(forbidden)
    expect(fingerprintCols).not.toContain(forbidden)
    expect(factCols).not.toContain(forbidden)
  }

  // Populate realistic records with sensitive secrets in wire payload
  const secretKey = "SECRET_API_KEY_12345"
  const sensitiveUserPrompt = "My secret banking password is password123"
  const wire = {
    model: "gpt-4o",
    prompt_cache_key: secretKey,
    messages: [{ role: "user", content: `${sensitiveUserPrompt} with key ${secretKey}` }],
  }
  const fp = fingerprintWireBody(wire, { url: "/v1/chat/completions" })

  db.requestStarted({
    id: "req_sec",
    sessionID: "ses_sec",
    kind: "step",
    started: 1000,
  })
  db.requestFingerprint({
    requestID: "req_sec",
    sessionID: "ses_sec",
    ...fp,
  })
  db.requestEnded("req_sec", { ended: 1001, status: "error", error: { type: "ProviderError", status: 400, message: sensitiveUserPrompt } })
  expect(JSON.parse(db.getRequest("req_sec")!.error!)).toEqual({ type: "ProviderError", status: 400, hash: sha256(sensitiveUserPrompt), chars: sensitiveUserPrompt.length })
  db.contextFact({
    sessionID: "ses_sec",
    at: 1000,
    kind: "instruction_update",
    detail: { keys: ["AGENTS.md"] },
  })

  // Inspect all stored data in request, request_fingerprint, context_fact
  const allRequests = JSON.stringify(db.db.query("select * from request").all())
  const allFingerprints = JSON.stringify(db.db.query("select * from request_fingerprint").all())
  const allFacts = JSON.stringify(db.db.query("select * from context_fact").all())

  expect(allRequests).not.toContain(secretKey)
  expect(allRequests).not.toContain(sensitiveUserPrompt)
  expect(allFingerprints).not.toContain(secretKey)
  expect(allFingerprints).not.toContain(sensitiveUserPrompt)
  expect(allFacts).not.toContain(secretKey)
  expect(allFacts).not.toContain(sensitiveUserPrompt)
})

test("context facts recorded and idempotent across multiple observations", async () => {
  const db = await ledger()
  const clock = { now: 1_000 }
  const collector = collect(db, clock)

  const instrEvent = {
    type: "session.instructions.updated",
    data: {
      sessionID: "ses_facts",
      delta: { "AGENTS.md": "new content", guidance: "active" },
    },
    created: 1_010,
  }

  // Observe instruction update twice
  collector.observe(instrEvent)
  collector.observe(instrEvent)

  // Step start and end with agent/model switch
  const s = script("ses_facts", clock)
  s.created({ agent: "build" })
  s.step("m1", "build", { id: "m1", providerID: "anthropic" })
  s.end("m1", "stop", usage(100, 10))
  s.step("m2", "reviewer", { id: "m2", providerID: "openai" })
  s.end("m2", "stop", usage(100, 10))
  s.compact(usage(500, 50))
  s.events.forEach((e) => collector.observe(e))

  // Revert committed observed twice
  const revertEvent = {
    type: "session.revert.committed",
    data: { sessionID: "ses_facts", to: "m1" },
    created: 1_200,
  }
  collector.observe(revertEvent)
  collector.observe(revertEvent)

  // Account switch and quota handoff inserted twice
  const switchFact = {
    sessionID: "ses_facts",
    at: 1_300,
    kind: "account_switch",
    detail: { alias: "acc_beta", previous: "acc_alpha" },
  }
  db.contextFact(switchFact)
  db.contextFact(switchFact)

  const handoffFact = {
    sessionID: "ses_facts",
    at: 1_400,
    kind: "quota_handoff",
    detail: { intent: "auto" },
  }
  db.contextFact(handoffFact)
  db.contextFact(handoffFact)

  const facts = db.getContextFacts("ses_facts")
  const kinds = facts.map((f) => f.kind)

  // Unique facts: exactly 1 entry per distinct occurrence
  expect(facts.filter((f) => f.kind === "instruction_update").length).toBe(1)
  expect(facts.filter((f) => f.kind === "revert").length).toBe(1)
  expect(facts.filter((f) => f.kind === "account_switch").length).toBe(1)
  expect(facts.filter((f) => f.kind === "quota_handoff").length).toBe(1)
  expect(kinds).toContain("agent_switch")
  expect(kinds).toContain("model_switch")
  expect(kinds).toContain("compaction")

  const instrFact = facts.find((f) => f.kind === "instruction_update")
  expect(instrFact?.detail?.keys).toEqual(["AGENTS.md", "guidance"])
})

test("hook path and event ordering in both orders yields exactly one row per request, and retries retire earlier open requests", async () => {
  await dataHome()
  const { hooks, hookFn } = makeHookRegistry()
  const clock = { now: 1_000 }

  const ctx = context({
    event: { subscribe: () => Stream.empty as never },
    session: {
      get: () => Effect.succeed({ id: Session.ID.make("ses_ord"), title: "Order test" }) as never,
      hook: hookFn as never,
    },
  })

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* watchMonitor(ctx, () => undefined)

        // ORDER 1: http.request hook runs FIRST, then step.started, then step.ended
        const req1 = new Request("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Order 1" }] }),
        })
        for (const cb of hooks["http.request"] ?? []) {
          yield* cb({
            sessionID: Session.ID.make("ses_ord1"),
            agent: Agent.ID.make("build"),
            model: modelRef("openai", "gpt-4o"),
            kind: "primary",
             request: req1,
            started: 1_000,
          })
        }
        const c1 = collect(ledgerAt(), clock)
        c1.observe({ type: "session.step.started", data: { sessionID: "ses_ord1", assistantMessageID: "m1", started: 1_000 } })
        c1.observe({ type: "session.step.ended", data: { sessionID: "ses_ord1", assistantMessageID: "m1", tokens: { input: 100, output: 20, reasoning: 0, cache: { read: 50, write: 0 } }, finish: "stop" } })

        // Assert Order 1 has exactly 1 row
        const ord1Requests = ledgerAt().getRequests("ses_ord1")
        expect(ord1Requests.length).toBe(1)
        expect(ord1Requests[0]?.kind).toBe("step")
        expect(ord1Requests[0]?.messageID).toBe("m1")
        expect(ord1Requests[0]?.status).toBe("completed")
        expect(ord1Requests[0]?.inputTokens).toBe(100)
        expect(ord1Requests[0]?.outputTokens).toBe(20)
        expect(ledgerAt().getFingerprint(ord1Requests[0]!.id)).toBeDefined()

        // ORDER 2: step.started runs FIRST, then http.request hook runs, then step.ended
        const c2 = collect(ledgerAt(), clock)
        c2.observe({ type: "session.step.started", data: { sessionID: "ses_ord2", assistantMessageID: "m2", started: 2_000 } })
        const req2 = new Request("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Order 2" }] }),
        })
        for (const cb of hooks["http.request"] ?? []) {
          yield* cb({
            sessionID: Session.ID.make("ses_ord2"),
            agent: Agent.ID.make("build"),
            model: modelRef("openai", "gpt-4o"),
            kind: "primary",
             request: req2,
            started: 2_000,
          })
        }
        c2.observe({ type: "session.step.ended", created: 2_100, data: { sessionID: "ses_ord2", assistantMessageID: "m2", tokens: { input: 200, output: 40, reasoning: 0, cache: { read: 80, write: 0 } }, finish: "stop" } })

        // Assert Order 2 has exactly 1 row
        const ord2Requests = ledgerAt().getRequests("ses_ord2")
        expect(ord2Requests.length).toBe(1)
        expect(ord2Requests[0]?.kind).toBe("step")
        expect(ord2Requests[0]?.messageID).toBe("m2")
        expect(ord2Requests[0]?.status).toBe("completed")
        expect(ord2Requests[0]?.inputTokens).toBe(200)
        expect(ledgerAt().getFingerprint(ord2Requests[0]!.id)).toBeDefined()

        // RETRIED ATTEMPT: attempt 1 open, then attempt 2 fires -> attempt 1 marked retried, attempt 2 completes
        const reqRetry1 = new Request("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Retry attempt 1" }] }),
        })
        for (const cb of hooks["http.request"] ?? []) {
          yield* cb({
            sessionID: Session.ID.make("ses_retry"),
            agent: Agent.ID.make("build"),
            model: modelRef("openai", "gpt-4o"),
            kind: "primary",
             request: reqRetry1,
            started: 3_000,
          })
        }
        // Second attempt arrives before step ends
        const reqRetry2 = new Request("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "Retry attempt 2" }] }),
        })
        for (const cb of hooks["http.request"] ?? []) {
          yield* cb({
            sessionID: Session.ID.make("ses_retry"),
            agent: Agent.ID.make("build"),
            model: modelRef("openai", "gpt-4o"),
            kind: "primary",
             request: reqRetry2,
            started: 3_001,
          })
        }
        const cRetry = collect(ledgerAt(), clock)
        cRetry.observe({ type: "session.step.started", data: { sessionID: "ses_retry", assistantMessageID: "m_retry", started: 3_000 } })
        cRetry.observe({ type: "session.step.ended", created: 3_100, data: { sessionID: "ses_retry", assistantMessageID: "m_retry", tokens: { input: 350, output: 60, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" } })

        const retryRequests = ledgerAt().getRequests("ses_retry")
        expect(retryRequests.length).toBe(2)
        expect(retryRequests[0]?.status).toBe("error")
        expect(retryRequests[0]?.error).toBe("retried")
        expect(retryRequests[1]?.status).toBe("completed")
        expect(retryRequests[1]?.inputTokens).toBe(350)
      }),
    ),
  )
})

test("generate transport joins exactly one completed fingerprinted row to its outcome, and warming relabels that same row to ping", async () => {
  await dataHome()
  const { hooks, hookFn } = makeHookRegistry()
  const ctx = context({
    event: { subscribe: () => Stream.empty as never },
    session: {
      get: () => Effect.succeed({ id: Session.ID.make("ses_join"), title: "Join" }) as never,
      hook: hookFn as never,
    },
  })
  const modelRefPinned = modelRef("openai", "gpt-4o")
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* watchMonitor(ctx, () => undefined)
        const sessionID = Session.ID.make("ses_join")
        const common = {
          sessionID,
          agent: Agent.ID.make("plan"),
          model: modelRefPinned,
        }
        // 1. The wire request carries the auxiliary generate kind (core sets it while
        //    running the primary content transforms), so it opens a generate row.
        const wire = new Request("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "ping" }] }),
        })
        for (const cb of hooks["http.request"] ?? []) {
          yield* cb({ ...common, kind: "generate", started: 1_000, requestID: "wire-join", request: wire })
        }
        // 2. The generated outcome must join the same wire row, not open a second one.
        for (const cb of hooks.generated ?? []) {
          yield* cb({
            ...common,
            kind: "generate",
            started: 1_000,
            ended: 1_200,
            usage: { input: 120, output: 15, reasoning: 0, cache: { read: 600, write: 0 } },
            cost: 0.001,
          })
        }

        const afterOutcome = ledgerAt().getRequests(String(sessionID))
        expect(afterOutcome).toHaveLength(1)
        expect(afterOutcome[0]).toMatchObject({
          id: "wire-join",
          kind: "generate",
          status: "completed",
          inputTokens: 120,
          cacheReadTokens: 600,
          cost: 0.001,
        })
        // The completed row keeps the final wire fingerprint and no orphan step row exists.
        expect(ledgerAt().getFingerprint("wire-join")).toBeDefined()
        expect(afterOutcome.some((row) => row.kind === "step")).toBe(false)

        // 3. The warming notification relabels that one row to ping; it does not add a row.
        for (const cb of hooks.warming ?? []) {
          yield* cb({ ...common, phase: "warmed", now: 1_300, since: 900, settings: undefined })
        }
        const afterWarm = ledgerAt().getRequests(String(sessionID))
        expect(afterWarm).toHaveLength(1)
        expect(afterWarm[0]).toMatchObject({ id: "wire-join", kind: "ping", status: "completed", inputTokens: 120 })
        expect(ledgerAt().getFingerprint("wire-join")?.bodyHash).toBeString()

        // Control: an unrelated open step row is never consumed by the warming relabel,
        // which only touches generate/ping rows, so no orphan step is relabeled.
        const db = ledgerAt()
        db.requestStarted({ id: "open-step", sessionID: String(sessionID), kind: "step", started: 2_000 })
        for (const cb of hooks.warming ?? []) {
          yield* cb({ ...common, phase: "warmed", now: 2_100, since: 1_900, settings: undefined })
        }
        expect(ledgerAt().getRequest("open-step")?.kind).toBe("step")
        expect(ledgerAt().getRequest("open-step")?.ended).toBeUndefined()
        // The earlier completed row is still the sole ping.
        expect(ledgerAt().getRequests(String(sessionID)).filter((row) => row.kind === "ping").map((row) => row.id)).toEqual(["wire-join"])

        // Refusal/error control: a failing outcome joins its wire row and hashes the error
        // text; the warming relabel still makes the same row ping, carrying the usage that
        // arrived with the outcome (none on failure).
        const errWire = '{"model":"gpt-4o","messages":[{"role":"user","content":"ping"}]}'
        for (const cb of hooks["http.request"] ?? []) {
          yield* cb({ ...common, kind: "generate", started: 3_000, requestID: "wire-err", request: new Request(wire.url, { method: "POST", body: errWire }) })
        }
        for (const cb of hooks.generated ?? []) {
          yield* cb({ ...common, kind: "generate", started: 3_000, ended: 3_100, error: "SECRET refusal text" })
        }
        for (const cb of hooks.warming ?? []) {
          yield* cb({ ...common, phase: "warmed", now: 3_200, since: 2_900, error: "SECRET refusal text", settings: undefined })
        }
        const errRow = ledgerAt().getRequest("wire-err")
        expect(errRow).toMatchObject({ kind: "ping", status: "error" })
        expect(JSON.stringify(errRow)).not.toContain("SECRET")
        expect(JSON.parse(errRow!.error!)).toMatchObject({ hash: sha256("SECRET refusal text") })

        // Pinned control: the row keeps the auxiliary generate request's pinned agent/model.
        expect(afterWarm[0]).toMatchObject({ agent: "plan", provider: "openai", model: "gpt-4o" })
      }),
    ),
  )
})

test("generate usage hook records request and warming warmed relabels it to ping, hashing errors without text", async () => {
  await dataHome()
  const { hooks, hookFn } = makeHookRegistry()

  const ctx = context({
    event: { subscribe: () => Stream.empty as never },
    session: {
      get: () => Effect.succeed({ id: Session.ID.make("ses_ping_test"), title: "Ping" }) as never,
      hook: hookFn as never,
    },
  })

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* watchMonitor(ctx, () => undefined)

        // 1. HTTP request hook fires for warming generate call
        const req = new Request("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "ping" }] }),
        })
        for (const cb of hooks["http.request"] ?? []) {
          yield* cb({
            sessionID: Session.ID.make("ses_ping_test"),
            agent: Agent.ID.make("build"),
            model: modelRef("openai", "gpt-4o"),
            kind: "generate",
            request: req,
          })
        }

        // 2. Core generate triggers "generated" hook
        for (const cb of hooks["generated"] ?? []) {
          yield* cb({
            sessionID: Session.ID.make("ses_ping_test"),
            agent: Agent.ID.make("build"),
            model: modelRef("openai", "gpt-4o"),
            usage: { input: 120, output: 15, reasoning: 0, cache: { read: 600, write: 0 } },
            cost: 0.001,
          })
        }

        // 3. Warming loop triggers "warming" hook with phase: "warmed"
        for (const cb of hooks["warming"] ?? []) {
          yield* cb({
            sessionID: Session.ID.make("ses_ping_test"),
            agent: Agent.ID.make("build"),
            model: modelRef("openai", "gpt-4o"),
            phase: "warmed",
            now: 4_000,
            since: 3_000,
            settings: undefined,
          })
        }

        const requests = ledgerAt().getRequests("ses_ping_test")
        expect(requests.length).toBe(1)
        expect(requests[0]?.kind).toBe("ping")
        expect(requests[0]?.status).toBe("completed")
        expect(requests[0]?.inputTokens).toBe(120)
        expect(requests[0]?.cacheReadTokens).toBe(600)
        expect(requests[0]?.cost).toBe(0.001)

        // Error clipping test: a long error string is clipped to 160 chars
        const longError = "E".repeat(300)
        const reqErr = new Request("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ model: "gpt-4o", messages: [{ role: "user", content: "err" }] }),
        })
        for (const cb of hooks["http.request"] ?? []) {
          yield* cb({
            sessionID: Session.ID.make("ses_ping_err"),
            agent: Agent.ID.make("build"),
            model: modelRef("openai", "gpt-4o"),
            kind: "generate",
            request: reqErr,
          })
        }
        for (const cb of hooks["generated"] ?? []) {
          yield* cb({
            sessionID: Session.ID.make("ses_ping_err"),
            agent: Agent.ID.make("build"),
            model: modelRef("openai", "gpt-4o"),
            error: longError,
          })
        }
        for (const cb of hooks["warming"] ?? []) {
          yield* cb({
            sessionID: Session.ID.make("ses_ping_err"),
            agent: Agent.ID.make("build"),
            model: modelRef("openai", "gpt-4o"),
            phase: "warmed",
            now: 5_000,
            since: 4_000,
            error: longError,
            settings: undefined,
          })
        }

        const errRequests = ledgerAt().getRequests("ses_ping_err")
        expect(errRequests.length).toBe(1)
        expect(errRequests[0]?.kind).toBe("ping")
        expect(errRequests[0]?.status).toBe("error")
        expect(errRequests[0]?.error?.length).toBeLessThanOrEqual(160)
        expect(JSON.parse(errRequests[0]!.error!)).toEqual({ type: "Error", hash: sha256("E".repeat(300)), chars: 300 })
      }),
    ),
  )
})
