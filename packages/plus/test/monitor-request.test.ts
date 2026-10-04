import { afterEach, expect, test } from "bun:test"
import { Database } from "bun:sqlite"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { Effect, Stream } from "effect"
import { createLedger, defaultLedgerPath, ledgerAt, type Ledger } from "../src/monitor/ledger.js"
import { fingerprintWireBody } from "../src/monitor/fingerprint.js"
import { watchMonitor } from "../src/monitor/plugin.js"
import { cleanupLedgers, collect, ledger, script, usage } from "./monitor-fixture.js"
import { context } from "./harness.js"

const priorData = process.env.XDG_DATA_HOME
const roots: string[] = []
const opened: string[] = []

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

test("fingerprints from real request bodies for each protocol", async () => {
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
  expect(fpResponses.tools.length).toBe(1)
  expect(fpResponses.tools[0]?.name).toBe("shell")
  expect(fpResponses.tools[0]?.descHash.length).toBe(64)
  expect(fpResponses.tools[0]?.schemaHash.length).toBe(64)
  expect(fpResponses.tools[0]?.descHash).not.toBe(fpResponses.tools[0]?.schemaHash)
  expect(fpResponses.cacheKey).toBe("ses_resp_123")
  expect(fpResponses.optionsKeys["prompt_cache_key"]).toBeDefined()
  expect(fpResponses.optionsKeys["reasoning"]).toBeDefined()
  expect(fpResponses.optionsKeys["temperature"]).toBeDefined()
  expect(fpResponses.messagePrefixes.length).toBe(3)
  expect(fpResponses.messagePrefixes[0]?.role).toBe("user")
  expect(fpResponses.messagePrefixes[0]?.messageId).toBe("msg_1")
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
  expect(fpChat.tools[0]?.descHash.length).toBe(64)
  expect(fpChat.tools[0]?.schemaHash.length).toBe(64)
  expect(fpChat.optionsKeys["temperature"]).toBeDefined()
  expect(fpChat.optionsKeys["max_tokens"]).toBeDefined()
  expect(fpChat.messagePrefixes.length).toBe(2)
  expect(fpChat.messagePrefixes[0]?.messageId).toBe("chat_1")

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
  expect(fpAnthropic.tools[0]?.descHash.length).toBe(64)
  expect(fpAnthropic.tools[0]?.schemaHash.length).toBe(64)
  expect(fpAnthropic.optionsKeys["thinking"]).toBeDefined()
  expect(fpAnthropic.optionsKeys["output_config"]).toBeDefined()
  expect(fpAnthropic.cacheControl).toBeDefined()
  expect(fpAnthropic.cacheControl?.some((cc) => cc.target === "system[0]")).toBe(true)
  expect(fpAnthropic.cacheControl?.some((cc) => cc.target === "tool:bash")).toBe(true)
  expect(fpAnthropic.messagePrefixes.length).toBe(2)

  // 4. Fallback for non-JSON or other formats
  const rawBody = "PLAIN_NON_JSON_WIRE_PAYLOAD_CHUNK_TEST_".repeat(50)
  const fpFallback = fingerprintWireBody(rawBody)
  expect(fpFallback.protocol).toBe("fallback")
  expect(fpFallback.messagePrefixes.length).toBeGreaterThan(0)
  expect(fpFallback.bodyHash).toBeDefined()
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

test("context facts recorded: account switch, quota handoff, instructions, compactions, switches, reverts", async () => {
  const db = await ledger()
  const clock = { now: 1_000 }
  const collector = collect(db, clock)

  // 1. Instructions updated with changed source keys
  collector.observe({
    type: "session.instructions.updated",
    data: {
      sessionID: "ses_facts",
      delta: { "AGENTS.md": "new content", guidance: "active" },
    },
    created: 1_010,
  })

  // 2. Model and Agent switch observed on step start
  const s = script("ses_facts", clock)
  s.created({ agent: "build" })
  s.step("m1", "build", { id: "m1", providerID: "anthropic" })
  s.end("m1", "stop", usage(100, 10))
  s.step("m2", "reviewer", { id: "m2", providerID: "openai" })
  s.end("m2", "stop", usage(100, 10))
  s.compact(usage(500, 50))
  s.events.forEach((e) => collector.observe(e))

  // 3. Revert committed
  collector.observe({
    type: "session.revert.committed",
    data: { sessionID: "ses_facts", to: "m1" },
    created: 1_200,
  })

  // 4. CPA account switch and quota handoff directly via ledger.contextFact
  db.contextFact({
    sessionID: "ses_facts",
    at: 1_300,
    kind: "account_switch",
    detail: { alias: "acc_beta", previous: "acc_alpha" },
  })
  db.contextFact({
    sessionID: "ses_facts",
    at: 1_400,
    kind: "quota_handoff",
    detail: { intent: "auto" },
  })

  const facts = db.getContextFacts("ses_facts")
  const kinds = facts.map((f) => f.kind)
  expect(kinds).toContain("instruction_update")
  expect(kinds).toContain("agent_switch")
  expect(kinds).toContain("model_switch")
  expect(kinds).toContain("compaction")
  expect(kinds).toContain("revert")
  expect(kinds).toContain("account_switch")
  expect(kinds).toContain("quota_handoff")

  const instrFact = facts.find((f) => f.kind === "instruction_update")
  expect(instrFact?.detail?.keys).toEqual(["AGENTS.md", "guidance"])

  const agentFact = facts.find((f) => f.kind === "agent_switch")
  expect(agentFact?.detail).toEqual({ from: "build", to: "reviewer" })

  const revertFact = facts.find((f) => f.kind === "revert")
  expect(revertFact?.detail).toEqual({ to: "m1" })
})

test("a keep-alive ping's usage lands as a ping request in the ledger", async () => {
  await dataHome()
  const hooks = new Map<string, Array<(event: any) => Effect.Effect<void, any, never>>>()
  const hookFn = (name: string, cb: (event: any) => Effect.Effect<void, any, never>) => {
    const list = hooks.get(name) ?? []
    list.push(cb)
    hooks.set(name, list)
    return Effect.sync(() => ({
      dispose: Effect.sync(() => {
        const l = hooks.get(name)
        if (l) {
          const idx = l.indexOf(cb)
          if (idx !== -1) l.splice(idx, 1)
        }
      }),
    }))
  }

  const ctx = context({
    event: { subscribe: () => Stream.empty as never },
    session: {
      get: () => Effect.succeed({ id: Session.ID.make("ses_ping"), title: "Ping chat" }) as never,
      hook: hookFn as never,
    },
  })

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* watchMonitor(ctx, () => undefined)
        for (const cb of hooks.get("warming") ?? []) {
          yield* cb({
            sessionID: "ses_ping",
            agent: Agent.ID.make("build"),
            model: { providerID: "anthropic", id: "claude-3-7-sonnet" },
            phase: "warmed",
            now: 2_000,
            since: 1_000,
            usage: {
              input: 150,
              output: 25,
              reasoning: 0,
              cache: { read: 800, write: 50 },
            },
          })
        }
      }),
    ),
  )

  const requests = ledgerAt().getRequests("ses_ping")
  expect(requests.length).toBe(1)
  expect(requests[0]?.kind).toBe("ping")
  expect(requests[0]?.agent).toBe("build")
  expect(requests[0]?.provider).toBe("anthropic")
  expect(requests[0]?.model).toBe("claude-3-7-sonnet")
  expect(requests[0]?.inputTokens).toBe(150)
  expect(requests[0]?.outputTokens).toBe(25)
  expect(requests[0]?.cacheReadTokens).toBe(800)
  expect(requests[0]?.cacheWriteTokens).toBe(50)
  expect(requests[0]?.status).toBe("completed")
})

test("wire request interception via http.request hooks records request and fingerprint", async () => {
  await dataHome()
  const hooks = new Map<string, Array<(event: any) => Effect.Effect<void, any, never>>>()
  const hookFn = (name: string, cb: (event: any) => Effect.Effect<void, any, never>) => {
    const list = hooks.get(name) ?? []
    list.push(cb)
    hooks.set(name, list)
    return Effect.sync(() => ({
      dispose: Effect.sync(() => {
        const l = hooks.get(name)
        if (l) {
          const idx = l.indexOf(cb)
          if (idx !== -1) l.splice(idx, 1)
        }
      }),
    }))
  }

  const ctx = context({
    event: { subscribe: () => Stream.empty as never },
    session: {
      get: () => Effect.succeed({ id: Session.ID.make("ses_http"), title: "Wire chat" }) as never,
      hook: hookFn as never,
    },
  })

  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        yield* watchMonitor(ctx, () => undefined)
        const wirePayload = {
          model: "gpt-4o",
          messages: [
            { role: "system", content: "You are an assistant." },
            { id: "msg_1", role: "user", content: "Hello" },
          ],
          tools: [
            {
              type: "function",
              function: { name: "read", description: "Read file", parameters: {} },
            },
          ],
        }
        const req = new Request("https://api.openai.com/v1/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify(wirePayload),
        })
        for (const cb of hooks.get("http.request") ?? []) {
          yield* cb({
            sessionID: "ses_http",
            agent: Agent.ID.make("build"),
            model: { providerID: "openai", id: "gpt-4o" },
            kind: "primary",
            request: req,
          })
        }
      }),
    ),
  )

  const requests = ledgerAt().getRequests("ses_http")
  expect(requests.length).toBe(1)
  expect(requests[0]?.kind).toBe("step")
  expect(requests[0]?.provider).toBe("openai")
  expect(requests[0]?.model).toBe("gpt-4o")

  const fp = ledgerAt().getFingerprint(requests[0]!.id)
  expect(fp).toBeDefined()
  expect(fp?.protocol).toBe("openai-chat")
  expect(fp?.tools.length).toBe(1)
  expect(fp?.tools[0]?.name).toBe("read")
  expect(fp?.messagePrefixes.length).toBe(1)
})
