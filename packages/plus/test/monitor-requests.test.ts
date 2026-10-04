import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Stream } from "effect"
import { createLedger, defaultLedgerPath, ledgerAt, type Ledger } from "../src/monitor/ledger.js"
import { fingerprintWireBody } from "../src/monitor/fingerprint.js"
import { watchMonitor } from "../src/monitor/plugin.js"
import { cleanupLedgers, collect, ledger, script, usage } from "./monitor-fixture.js"
import { context } from "./harness.js"

const priorData = process.env.XDG_DATA_HOME
const roots: string[] = []
const opened: string[] = []

const modelRef = (p: string, m: string) =>
  Model.Ref.make({ providerID: Provider.ID.make(p), id: Model.ID.make(m) })

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
  expect(fpResponses.cacheKey).toBe("ses_resp_123")
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
  expect(fpAnthropic.cacheControl?.some((cc) => cc.target === "tool:bash")).toBe(true)
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
          })
        }
        c2.observe({ type: "session.step.ended", data: { sessionID: "ses_ord2", assistantMessageID: "m2", tokens: { input: 200, output: 40, reasoning: 0, cache: { read: 80, write: 0 } }, finish: "stop" } })

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
          })
        }
        const cRetry = collect(ledgerAt(), clock)
        cRetry.observe({ type: "session.step.started", data: { sessionID: "ses_retry", assistantMessageID: "m_retry", started: 3_000 } })
        cRetry.observe({ type: "session.step.ended", data: { sessionID: "ses_retry", assistantMessageID: "m_retry", tokens: { input: 350, output: 60, reasoning: 0, cache: { read: 0, write: 0 } }, finish: "stop" } })

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

test("generate usage hook records request and warming warmed relabels it to ping, clipping errors to 160 chars", async () => {
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
        expect(errRequests[0]?.error).toBe("E".repeat(160))
      }),
    ),
  )
})
