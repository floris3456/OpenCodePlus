import { describe, expect } from "bun:test"
import { LanguageModel } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Bus } from "@opencode/core/bus"
import { Database } from "@opencode/core/database/database"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { Instructions } from "@opencode/core/instructions/index"
import { AbsolutePath } from "@opencode/core/schema"
import { SessionHistory } from "@opencode/core/session/history"
import { InstructionState } from "@opencode/core/session/instruction-state"
import { SessionModelRequest } from "@opencode/core/session/model-request"
import { SessionProjector } from "@opencode/core/session/projector"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { SessionSchema } from "@opencode/core/session/schema"
import { SessionTable } from "@opencode/core/session/sql"
import { ProjectTable } from "@opencode/core/project/sql"
import { Tool } from "@opencode/core/tool"
import { Agent } from "@opencode/schema/agent"
import { Event } from "@opencode/schema/event"
import { Project } from "@opencode/schema/project"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer, Schema } from "effect"
import { testEffect } from "./lib/effect"
import { readInitial, readUpdate, state } from "./lib/instructions"

const model = LanguageModel.make({ id: "parts-model", provider: "test", route: OpenAIChat.route })
const resolved = SessionRunnerModel.resolved(model, {
  capabilities: { tools: true, input: ["text"], output: ["text"] },
  cost: [],
  limit: { context: 200_000, output: 32_000 },
})

// Compiled directly instead of through AppNodeBuilder: the builder imports the
// plugin supervisor graph, which currently fails to load on a broken
// `@opencode/plus` import. These nodes need no Location provisioning.
const discoveryOnly = testEffect(
  LayerNode.compile(LayerNode.group([InstructionDiscovery.node]), {
    replacements: [
      Bus.node.replace(
        Layer.mock(Bus.Service, {
          publish: (definition, data) => {
            // `Payload<D>` is per-call-site; a generic mock body cannot produce it without a cast.
            const event = {
              id: Event.ID.create(),
              created: Date.now(),
              type: definition.type,
              data,
            } as Event.Payload<typeof definition>
            return Effect.succeed(event)
          },
        }),
      ),
    ],
  }),
)

// Full session request assembly: durable baseline persisted through the real
// InstructionState projection, then loaded through SessionHistory and
// assembled into one SystemPart per source file.
const assembledOnly = testEffect(
  LayerNode.compile(
    LayerNode.group([Database.node, Bus.node, InstructionDiscovery.node, SessionProjector.node]),
    {
      replacements: [Bus.node.replace(Bus.configured({ persist: true }))],
    },
  ),
)

const file = (path: string, content: string) =>
  new InstructionDiscovery.File({ path: AbsolutePath.make(path), content })

// The real runner calls baseTranscript with an explicit Agent.Info. The
// agent's own system prompt stays the first assembled part; the instruction
// baseline follows after it.
const agent = { ...Agent.Info.default(Agent.ID.make("build")), system: "agent" }

const tools: Tool.Snapshot = {
  definitions: [],
  execute: () => Effect.die(new Error("assembly never dispatches tools")),
}

const assemble = (initial: ReadonlyArray<string | Instructions.Part>) =>
  SessionModelRequest.baseTranscript({ agent, model: resolved, tools, initial, messages: [] }).system

const setupSession = Effect.fnUntraced(function* (sessionID: SessionSchema.ID) {
  const { db } = yield* Database.Service
  const bus = yield* Bus.Service
  yield* db
    .insert(ProjectTable)
    .values({ id: Project.ID.global, worktree: AbsolutePath.make("/project"), sandboxes: [] })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
  yield* db
    .insert(SessionTable)
    .values({
      id: sessionID,
      project_id: Project.ID.global,
      slug: "instruction-parts",
      directory: "/project",
      title: "Instruction parts",
      version: "test",
    })
    .run()
    .pipe(Effect.orDie)
  return { db, bus }
})

const parts = (instructions: Instructions.List) =>
  Effect.gen(function* () {
    const admission = yield* Instructions.read(instructions).pipe(Effect.flatMap(Instructions.diff))
    const values = Object.fromEntries(
      Object.entries(admission.delta).flatMap(([key, hash]) =>
        hash === "removed" ? [] : [[key, admission.blobs[hash]]],
      ),
    )
    // Same mapping the model request applies: one SystemPart per instruction source.
    return assemble(Instructions.renderInitialParts(instructions, values)).slice(1)
  })

describe("InstructionDiscovery per-file parts", () => {
  discoveryOnly.effect("assembles one system part per instruction file", () =>
    Effect.gen(function* () {
      const discovery = yield* InstructionDiscovery.Service
      yield* discovery.transform((editor) => {
        editor.add(file("/repo/AGENTS.md", "root"))
        editor.add(file("/repo/packages/AGENTS.md", "package"))
      })

      const assembled = yield* parts(yield* discovery.load())
      expect(assembled).toHaveLength(2)
      expect(assembled[0]?.text).toBe("Instructions from: /repo/AGENTS.md\nroot")
      expect(assembled[1]?.text).toBe("Instructions from: /repo/packages/AGENTS.md\npackage")
      expect(assembled.map((part) => part.text).join("\n\n")).toContain("root")
      expect(assembled.map((part) => part.text).join("\n\n")).toContain("package")
    }),
  )

  discoveryOnly.effect("assembles a single file into a single part", () =>
    Effect.gen(function* () {
      const discovery = yield* InstructionDiscovery.Service
      yield* discovery.transform((editor) => {
        editor.add(file("/repo/AGENTS.md", "only"))
      })

      const assembled = yield* parts(yield* discovery.load())
      expect(assembled).toHaveLength(1)
      expect(assembled[0]?.text).toBe("Instructions from: /repo/AGENTS.md\nonly")
    }),
  )

  discoveryOnly.effect("removing one file through the transform removes exactly its part", () =>
    Effect.gen(function* () {
      const discovery = yield* InstructionDiscovery.Service
      yield* discovery.transform((editor) => {
        editor.add(file("/repo/AGENTS.md", "root"))
        editor.add(file("/repo/packages/AGENTS.md", "package"))
      })
      const before = yield* readInitial(yield* discovery.load())
      expect(before.text).toContain("Instructions from: /repo/AGENTS.md\nroot")

      yield* discovery.transform((editor) => {
        editor.remove("/repo/AGENTS.md")
      })
      const assembled = yield* parts(yield* discovery.load())
      expect(assembled).toHaveLength(1)
      expect(assembled[0]?.text).toBe("Instructions from: /repo/packages/AGENTS.md\npackage")

      const update = yield* readUpdate(yield* discovery.load(), before)
      expect(update.text).toBe("The instructions from /repo/AGENTS.md no longer apply.")
    }),
  )
  discoveryOnly.effect("keys one source per file path", () =>
    Effect.gen(function* () {
      const discovery = yield* InstructionDiscovery.Service
      yield* discovery.transform((editor) => {
        editor.add(file("/repo/AGENTS.md", "root"))
        editor.add(file("/repo/packages/AGENTS.md", "package"))
      })

      const observed = yield* Instructions.read(yield* discovery.load())
      const keys = observed.map((entry) => entry.key).sort()
      expect(keys).toHaveLength(2)
      expect(new Set(keys).size).toBe(2)
      for (const key of keys) expect(key.startsWith("core/instructions/")).toBe(true)
      // Keys stay stable across rebuilds so unchanged files admit no delta.
      expect(yield* Instructions.read(yield* discovery.load()).pipe(Effect.map((rows) => rows.map((row) => row.key).sort()))).toEqual(keys)
      const initial = yield* readInitial(yield* discovery.load())
      expect(Object.values(initial.values)).toEqual([
        { path: "/repo/AGENTS.md", content: "root" },
        { path: "/repo/packages/AGENTS.md", content: "package" },
      ])
    }),
  )

  discoveryOnly.effect("retains unavailable reads without admitting new parts", () =>
    Effect.gen(function* () {
      const discovery = yield* InstructionDiscovery.Service
      yield* discovery.transform((editor) => {
        editor.add(file("/repo/AGENTS.md", "root"))
        editor.unavailable()
      })
      // An old aggregate row is retained through the outage, like any stored value.
      expect(
        (
          yield* readUpdate(
            yield* discovery.load(),
            state({ "core/instructions": [{ path: "/repo/AGENTS.md", content: "old" }] }),
          )
        ).changed,
      ).toBe(false)
    }),
  )

  assembledOnly.effect("an unavailable read retains admitted per-file instructions in the request", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.create()
      const { db, bus } = yield* setupSession(sessionID)
      const discovery = yield* InstructionDiscovery.Service
      yield* discovery.transform((editor) => {
        editor.add(file("/repo/AGENTS.md", "root"))
        editor.add(file("/repo/packages/AGENTS.md", "package"))
      })
      yield* InstructionState.prepare(db, bus, yield* discovery.load(), sessionID)
      const before = yield* SessionHistory.entriesForRunner(db, sessionID, yield* discovery.load(), "local")

      yield* discovery.transform((editor) => {
        editor.unavailable()
      })
      const history = yield* SessionHistory.entriesForRunner(db, sessionID, yield* discovery.load(), "local")
      const system = assemble(history.initial)
      expect(system.map((part) => part.text)).toEqual(assemble(before.initial).map((part) => part.text))
      expect(system.map((part) => part.text)).toEqual([
        "agent",
        "Instructions from: /repo/AGENTS.md\nroot",
        "Instructions from: /repo/packages/AGENTS.md\npackage",
      ])
    }),
  )

  assembledOnly.effect("instruction parts carry their source file identity", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.create()
      const { db, bus } = yield* setupSession(sessionID)
      const discovery = yield* InstructionDiscovery.Service
      yield* discovery.transform((editor) => {
        editor.add(file("/repo/AGENTS.md", "root"))
        editor.add(file("/repo/packages/AGENTS.md", "package"))
      })
      yield* InstructionState.prepare(db, bus, yield* discovery.load(), sessionID)

      const history = yield* SessionHistory.entriesForRunner(db, sessionID, yield* discovery.load(), "local")
      const system = assemble(history.initial)
      expect(system.slice(1).map((part) => part.metadata)).toEqual(
        (yield* discovery.load()).map((source) => ({ instruction: { key: source.key, path: source.path } })),
      )
      expect(system.slice(1).map((part) => (part.metadata?.instruction as { path?: string }).path)).toEqual([
        "/repo/AGENTS.md",
        "/repo/packages/AGENTS.md",
      ])
    }),
  )

  discoveryOnly.effect("every initial part carries its source key, and only file-backed parts a path", () =>
    Effect.gen(function* () {
      const discovery = yield* InstructionDiscovery.Service
      yield* discovery.transform((editor) => {
        editor.add(file("/repo/AGENTS.md", "root"))
      })
      const text = (key: string, value: string) =>
        Instructions.make({
          key: Instructions.Key.make(key),
          codec: Schema.String,
          read: Effect.succeed(value),
          render: { initial: (current) => current, changed: (_, current) => current },
        })
      const files = yield* discovery.load()
      const system = yield* parts(
        Instructions.combine([text("core/codemode", "catalog"), files, text("core/date", "today"), text("api/note", "note")]),
      )
      expect(system.map((part) => part.metadata)).toEqual([
        { instruction: { key: "core/codemode" } },
        { instruction: { key: files[0]?.key, path: "/repo/AGENTS.md" } },
        { instruction: { key: "core/date" } },
        { instruction: { key: "api/note" } },
      ])
      // The agent's own prompt stays a plain first part.
      expect(assemble([])[0]?.metadata).toBeUndefined()
    }),
  )
})

describe("InstructionDiscovery session request assembly", () => {
  assembledOnly.effect("assembles one system part per file through the durable baseline", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.create()
      const { db, bus } = yield* setupSession(sessionID)
      const discovery = yield* InstructionDiscovery.Service
      yield* discovery.transform((editor) => {
        editor.add(file("/repo/AGENTS.md", "root"))
        editor.add(file("/repo/packages/AGENTS.md", "package"))
      })
      yield* InstructionState.prepare(db, bus, yield* discovery.load(), sessionID)

      const history = yield* SessionHistory.entriesForRunner(db, sessionID, yield* discovery.load(), "local")
      const system = assemble(history.initial)
      expect(system.map((part) => part.text)).toEqual([
        "agent",
        "Instructions from: /repo/AGENTS.md\nroot",
        "Instructions from: /repo/packages/AGENTS.md\npackage",
      ])
    }),
  )

  assembledOnly.effect("dropping one file removes exactly its assembled part", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.create()
      const { db, bus } = yield* setupSession(sessionID)
      const discovery = yield* InstructionDiscovery.Service
      yield* discovery.transform((editor) => {
        editor.add(file("/repo/AGENTS.md", "root"))
        editor.add(file("/repo/packages/AGENTS.md", "package"))
      })
      yield* InstructionState.prepare(db, bus, yield* discovery.load(), sessionID)

      yield* discovery.transform((editor) => {
        editor.remove("/repo/AGENTS.md")
      })
      yield* InstructionState.prepare(db, bus, yield* discovery.load(), sessionID)

      const history = yield* SessionHistory.entriesForRunner(db, sessionID, yield* discovery.load(), "local")
      expect(assemble(history.initial).map((part) => part.text)).toEqual([
        "agent",
        "Instructions from: /repo/packages/AGENTS.md\npackage",
      ])
    }),
  )

  assembledOnly.effect("a move keeps the baseline and records which files apply now", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.create()
      const { db, bus } = yield* setupSession(sessionID)
      const inA = yield* folder(["/config/AGENTS.md", "/ws/a/AGENTS.md", "/ws/AGENTS.md"])
      yield* InstructionState.prepare(db, bus, inA, sessionID)
      const before = assemble((yield* SessionHistory.entriesForRunner(db, sessionID, inA, "local")).initial)
      expect(before.map((part) => part.text)).toEqual([
        "agent",
        "Instructions from: /config/AGENTS.md\nglobal",
        "Instructions from: /ws/a/AGENTS.md\na",
        "Instructions from: /ws/AGENTS.md\nws",
      ])

      // The destination serves its own nearest file; the source folder's is not among its sources.
      const inB = yield* folder(["/config/AGENTS.md", "/ws/b/AGENTS.md", "/ws/AGENTS.md"])
      yield* InstructionState.prepare(db, bus, inB, sessionID)
      const history = yield* SessionHistory.entriesForRunner(db, sessionID, inB, "local")
      expect(assemble(history.initial)).toEqual(before)
      const updates = history.entries.flatMap((entry) => (entry.message.type === "system" ? [entry.message.text] : []))
      expect(updates).toEqual([
        "The instructions from /ws/a/AGENTS.md no longer apply.\n\nInstructions from: /ws/b/AGENTS.md\nb",
      ])

      // Recorded once: the next boundary in the destination admits nothing more.
      yield* InstructionState.prepare(db, bus, inB, sessionID)
      const again = yield* SessionHistory.entriesForRunner(db, sessionID, inB, "local")
      expect(again.entries.filter((entry) => entry.message.type === "system")).toHaveLength(1)
      expect(assemble(again.initial)).toEqual(before)

      // Moving back: the file applies again, the baseline still has not changed.
      yield* InstructionState.prepare(db, bus, inA, sessionID)
      const back = yield* SessionHistory.entriesForRunner(db, sessionID, inA, "local")
      expect(assemble(back.initial)).toEqual(before)
      expect(back.entries.flatMap((entry) => (entry.message.type === "system" ? [entry.message.text] : [])).at(-1)).toBe(
        "Instructions from: /ws/a/AGENTS.md\na\n\nThe instructions from /ws/b/AGENTS.md no longer apply.",
      )
    }),
  )

  assembledOnly.effect("a move after a compaction keeps the moved-in file where it rendered", () =>
    Effect.gen(function* () {
      const sessionID = SessionSchema.ID.create()
      const { db, bus } = yield* setupSession(sessionID)
      yield* InstructionState.prepare(
        db,
        bus,
        yield* folder(["/config/AGENTS.md", "/ws/a/AGENTS.md", "/ws/AGENTS.md"]),
        sessionID,
      )
      const inB = yield* folder(["/config/AGENTS.md", "/ws/b/AGENTS.md", "/ws/AGENTS.md"])
      yield* InstructionState.prepare(db, bus, inB, sessionID)
      // A compaction makes the current values the baseline: b was stored last but renders in list order.
      yield* InstructionState.advanceEpoch(db, sessionID, 1_000)
      const before = assemble((yield* SessionHistory.entriesForRunner(db, sessionID, inB, "local")).initial)
      expect(before.map((part) => part.text)).toEqual([
        "agent",
        "Instructions from: /config/AGENTS.md\nglobal",
        "Instructions from: /ws/b/AGENTS.md\nb",
        "Instructions from: /ws/AGENTS.md\nws",
      ])

      const inC = yield* folder(["/config/AGENTS.md", "/ws/c/AGENTS.md", "/ws/AGENTS.md"])
      yield* InstructionState.prepare(db, bus, inC, sessionID)
      expect(assemble((yield* SessionHistory.entriesForRunner(db, sessionID, inC, "local")).initial)).toEqual(before)
    }),
  )
})

const contents: Record<string, string> = {
  "/config/AGENTS.md": "global",
  "/ws/AGENTS.md": "ws",
  "/ws/a/AGENTS.md": "a",
  "/ws/b/AGENTS.md": "b",
  "/ws/c/AGENTS.md": "c",
}

// The sources one folder serves, in its discovery order (global, then nearest
// folder first). Files of other folders are simply not among them.
const folder = (paths: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const discovery = yield* InstructionDiscovery.Service
    yield* discovery.transform((editor) => {
      for (const [path, content] of Object.entries(contents))
        if (!editor.list().some((existing) => existing.path === path)) editor.add(file(path, content))
    })
    const all = yield* discovery.load()
    return paths.flatMap((path) => all.filter((source) => source.path === path))
  })
