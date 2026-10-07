import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Deferred, Effect, Exit } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHandlers, createPlusApi, createState } from "../src/index.js"
import { projectRecordsPath } from "../src/instructions/paths.js"
import { load, loadedFromSave, save } from "../src/instructions/store.js"
import { deltaOf, recordIdentity, recordKeyOf } from "../src/instructions/delta.js"
import { memoBuildCounter, resetMemoBuildCounter } from "../src/instructions/resolve-memo.js"
import { expandedTree } from "../src/instructions/tree.js"
import { registerInstructionTools } from "../src/tools.js"
import { Plus } from "../src/rpc.js"
import { agentInfo, fullContext } from "./harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<{ project: string; config: string }> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-write-path-"))
  roots.push(root)
  const config = path.join(root, "config")
  process.env.OPENCODE_CONFIG_DIR = config
  const project = path.join(root, "project")
  return { project, config }
}

const UPDATED = "2026-01-01T00:00:00.000Z"

function customization(item: string, overrides?: Partial<Plus.SnapshotCustomizationRecord>): Plus.SnapshotCustomizationRecord {
  return {
    type: "customization",
    level: "project",
    agent: "alpha",
    item,
    section: null,
    basedOn: "",
    updated: UPDATED,
    ...overrides,
  }
}

function throwingContext(captured: { type?: string } = {}): { error: (type: string, message: string, data?: unknown) => never } {
  return {
    error: (type, message, data) => {
      captured.type = type
      throw data === undefined ? { type, message } : { type, message, data }
    },
  }
}

function capturedError(captured: { type?: string }): { error: (type: string, message: string, data?: unknown) => never } {
  return throwingContext(captured)
}

async function storeText(project: string): Promise<string> {
  return Bun.file(projectRecordsPath(project)).text()
}

test("a delta mutate changes only the named row and leaves every other stored row byte-identical", async () => {
  const { project } = await tempRoot()
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const seed = await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: 0,
        expectedGlobalRevision: 0,
        records: [customization("tool:a", { text: "one" }), customization("tool:b", { text: "two" })],
      },
      throwingContext(),
    ),
  )
  expect(seed.ok).toBe(true)
  if (!seed.ok) throw new Error("expected seed")
  const beforeRows = (await storeText(project)).split("\n").filter((line) => line.trim().length > 0).slice(1)

  const delta = await Effect.runPromise(
    handlers["instructions.mutate"]({ changes: { upsert: [customization("tool:a", { text: "changed" })], remove: [] } }, throwingContext()),
  )
  expect(delta.ok).toBe(true)
  if (!delta.ok) throw new Error("expected delta to succeed")
  expect(delta.snapshot).toBeUndefined()
  expect(delta.revision).toBe(seed.revision + 1)

  const afterRows = (await storeText(project)).split("\n").filter((line) => line.trim().length > 0).slice(1)
  expect(afterRows).toHaveLength(beforeRows.length)
  // The untouched row keeps its exact bytes; only tool:a's line changed.
  const untouched = beforeRows.filter((line) => !line.includes('"tool:a"'))
  expect(untouched).toHaveLength(1)
  expect(afterRows).toContain(untouched[0]!)
  expect(afterRows.find((line) => line.includes('"tool:a"'))).toContain('"text":"changed"')
})

test("a delta remove drops exactly the addressed row and no other", async () => {
  const { project } = await tempRoot()
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: 0,
        expectedGlobalRevision: 0,
        records: [customization("tool:a", { text: "one" }), customization("tool:b", { text: "two" })],
      },
      throwingContext(),
    ),
  )
  const removed = await Effect.runPromise(
    handlers["instructions.mutate"](
      { changes: { upsert: [], remove: [{ type: "customization", level: "project", agent: "alpha", item: "tool:a", section: null }] } },
      throwingContext(),
    ),
  )
  expect(removed.ok).toBe(true)
  if (!removed.ok) throw new Error("expected delta remove")
  const rows = (await load(project)).records.filter((record) => record.type === "customization")
  expect(rows).toHaveLength(1)
  expect(rows[0]?.type === "customization" ? rows[0].item : undefined).toBe("tool:b")
})

test("two concurrent delta writes to different rows both land with no stale refusal", async () => {
  const { project } = await tempRoot()
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: 0,
        expectedGlobalRevision: 0,
        records: [customization("tool:a", { text: "one" }), customization("tool:b", { text: "two" })],
      },
      throwingContext(),
    ),
  )
  const [first, second] = await Promise.all([
    Effect.runPromise(handlers["instructions.mutate"]({ changes: { upsert: [customization("tool:a", { text: "A" })], remove: [] } }, throwingContext())),
    Effect.runPromise(handlers["instructions.mutate"]({ changes: { upsert: [customization("tool:b", { text: "B" })], remove: [] } }, throwingContext())),
  ])
  expect(first.ok).toBe(true)
  expect(second.ok).toBe(true)
  if (!first.ok || !second.ok) throw new Error("expected both deltas to land")
  const stored = await load(project)
  const textOf = (item: string) => {
    const record = stored.records.find((candidate) => candidate.type === "customization" && candidate.item === item)
    return record?.type === "customization" ? record.text : undefined
  }
  expect(textOf("tool:a")).toBe("A")
  expect(textOf("tool:b")).toBe("B")
})

test("two delta writes to the same row are last-writer-wins", async () => {
  const { project } = await tempRoot()
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const first = await Effect.runPromise(
    handlers["instructions.mutate"]({ changes: { upsert: [customization("tool:a", { text: "first" })], remove: [] } }, throwingContext()),
  )
  const second = await Effect.runPromise(
    handlers["instructions.mutate"]({ changes: { upsert: [customization("tool:a", { text: "second" })], remove: [] } }, throwingContext()),
  )
  expect(first.ok).toBe(true)
  expect(second.ok).toBe(true)
  const row = (await load(project)).records.find((record) => record.type === "customization" && record.item === "tool:a")
  if (row?.type !== "customization") throw new Error("expected customization")
  expect(row.text).toBe("second")
})

test("a tool-actor delta touching a protected agent's row is refused and writes nothing", async () => {
  const { project } = await tempRoot()
  await fs.mkdir(path.join(project, ".opencodeplus"), { recursive: true })
  await Bun.write(
    path.join(project, ".opencodeplus", "project.json"),
    JSON.stringify({ version: 1, protectedAgents: ["alpha"] }),
  )
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  await Effect.runPromise(
    handlers["instructions.mutate"](
      { expectedRevision: 0, expectedGlobalRevision: 0, records: [customization("tool:a", { text: "one" })] },
      throwingContext(),
    ),
  )
  const before = await storeText(project)
  const captured: { type?: string } = {}
  const refused = await Effect.runPromiseExit(
    handlers["instructions.mutate"](
      { changes: { upsert: [customization("tool:a", { text: "tampered" })], remove: [] }, actor: { type: "tool" } },
      capturedError(captured),
    ),
  )
  expect(Exit.isFailure(refused)).toBe(true)
  expect(captured.type).toBe("agent.protected")
  expect(await storeText(project)).toBe(before)
})

test("snapshot:true returns a snapshot; the default delta answer carries none", async () => {
  const { project } = await tempRoot()
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const withSnapshot = await Effect.runPromise(
    handlers["instructions.mutate"](
      { changes: { upsert: [customization("tool:a", { text: "one" })], remove: [] }, snapshot: true },
      throwingContext(),
    ),
  )
  expect(withSnapshot.ok).toBe(true)
  if (!withSnapshot.ok) throw new Error("expected delta with snapshot")
  expect(withSnapshot.snapshot?.records.some((record) => record.type === "customization" && record.item === "tool:a")).toBe(true)

  const without = await Effect.runPromise(
    handlers["instructions.mutate"]({ changes: { upsert: [customization("tool:b", { text: "two" })], remove: [] } }, throwingContext()),
  )
  expect(without.ok).toBe(true)
  if (!without.ok) throw new Error("expected delta without snapshot")
  expect(without.snapshot).toBeUndefined()
})

test("api.snapshot returns the same cached object until the store changes", async () => {
  const { project } = await tempRoot()
  const state = createState()
  const api = createPlusApi(fullContext({ directory: project, agents: [agentInfo("alpha", "role")] }), state)
  const first = await api.snapshot()
  expect((await api.snapshot()).value).toBe(first.value)

  const written = await api.mutate({ changes: { upsert: [customization("tool:a", { text: "one" })], remove: [] } })
  expect(written.ok).toBe(true)
  if (!written.ok || !written.value.ok) throw new Error("expected write")
  const after = await api.snapshot()
  expect(after.value).not.toBe(first.value)
  expect(after.value.records.some((record) => record.type === "customization" && record.item === "tool:a")).toBe(true)
  expect((await api.snapshot()).value).toBe(after.value)
})

test("loadedFromSave matches a fresh load after a save", async () => {
  const { project } = await tempRoot()
  const seeded = await save(project, {
    expectedProjectRevision: 0,
    expectedGlobalRevision: 0,
    records: [
      {
        type: "customization",
        level: "project",
        agent: "alpha",
        item: "tool:a",
        section: null,
        state: "on",
        basedOn: "",
        updated: UPDATED,
      },
      {
        type: "customization",
        level: "defaults",
        agent: null,
        item: "tool:b",
        section: null,
        state: "on",
        basedOn: "",
        updated: UPDATED,
      },
    ] as never,
  })
  expect(seeded.ok).toBe(true)
  if (!seeded.ok) throw new Error("expected save")
  const written = (await load(project)).records
  const fromSave = loadedFromSave(seeded, written)
  const fresh = await load(project)
  expect(fromSave.projectRevision).toBe(fresh.projectRevision)
  expect(fromSave.globalRevision).toBe(fresh.globalRevision)
  expect(fromSave.records).toEqual(fresh.records)
})

test("the delta identity and key agree, and deltaOf reports only changed rows", () => {
  const before = [customization("tool:a", { text: "one" }), customization("tool:b", { text: "two" })] as unknown as Parameters<typeof deltaOf>[0]
  const after = [customization("tool:a", { text: "changed" }), customization("tool:b", { text: "two" })] as unknown as Parameters<typeof deltaOf>[0]
  const delta = deltaOf(before, after)
  expect(delta.upsert).toHaveLength(1)
  expect(delta.remove).toEqual([])
  const first = delta.upsert[0]
  expect(first?.type === "customization" ? first.item : undefined).toBe("tool:a")

  const row = {
    type: "customization" as const,
    level: "project" as const,
    agent: "alpha",
    item: "tool:a",
    section: null,
    basedOn: "",
    updated: UPDATED,
  }
  expect(recordIdentity(row)).toBe(`customization\u0000item:project:alpha:tool:a\u0000\u0000`)
  expect(recordIdentity(row)).toBe(recordIdentity({ ...row, team: undefined }))
  expect(recordKeyOf(row)).toEqual({ type: "customization", level: "project", agent: "alpha", item: "tool:a", section: null })
})

test("a tool set builds one resolution memo and sends a one-row delta", async () => {
  const { project } = await tempRoot()
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "role")],
    tools: [{ id: "reader", description: "read things", options: { codemode: false } }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const state = createState()
  const real = createPlusApi(ctx, state)
  const deltas: Plus.MutateInput[] = []
  const wrapped: Parameters<typeof registerInstructionTools>[1] = {
    ...real,
    mutate: async (input) => {
      deltas.push(input)
      return real.mutate(input)
    },
  }
  await registerInstructionTools(ctx, wrapped)
  const tools = await readTools(ctx)
  const snapshot = await real.snapshot()
  const memo = {
    items: snapshot.value.items.map((item) => ({
      id: item.id,
      kind: item.kind,
      group: item.group,
      title: item.title,
      text: item.text,
      enabled: item.enabled,
      fingerprint: item.fingerprint,
    })),
    records: snapshot.value.records
      .filter((record): record is Plus.SnapshotCustomizationRecord => record.type === "customization")
      .map((record) => ({
        type: "customization" as const,
        level: record.level,
        agent: record.agent,
        item: record.item,
        section: record.section,
        basedOn: record.basedOn,
        updated: record.updated,
      })),
    agents: snapshot.value.agents,
  }
  const row = expandedTree(memo).find((node) => node.address?.item === "tool:reader")
  if (row === undefined) throw new Error("missing reader row")

  resetMemoBuildCounter()
  const tool = tools.get("instructions_set")
  if (tool === undefined) throw new Error("missing set tool")
  await Effect.runPromise(tool.execute({ id: row.id }, toolContext()))
  expect(memoBuildCounter.count).toBe(1)
  const delta = deltas.find((input) => "changes" in input)
  if (delta === undefined || !("changes" in delta)) throw new Error("expected a delta write")
  expect(delta.changes.upsert).toHaveLength(1)
  expect(delta.changes.upsert[0]).toMatchObject({ type: "customization", item: "tool:reader" })
})

function toolContext(): Tool.Context {
  return {
    sessionID: Session.ID.make("ses_write_path"),
    agent: Agent.ID.make("alpha"),
    messageID: SessionMessage.ID.make("msg_write_path"),
    id: Tool.CallID.make("call_write_path"),
    progress: () => Effect.void,
  }
}

async function readTools(ctx: ReturnType<typeof fullContext>) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<readonly (Tool.Info & { readonly id: string })[], never>()
        yield* ctx.tool.transform((editor) => {
          Deferred.doneUnsafe(deferred, Effect.succeed([...editor.list()]))
        })
        const list = yield* Deferred.await(deferred)
        return new Map(list.map((tool) => [tool.id, tool]))
      }),
    ),
  )
}
