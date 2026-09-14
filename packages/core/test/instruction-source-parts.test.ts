import { describe, expect } from "bun:test"
import { SystemPart } from "@opencode/ai"
import { Bus } from "@opencode/core/bus"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { Instructions } from "@opencode/core/instructions/index"
import { AbsolutePath } from "@opencode/core/schema"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer } from "effect"
import { testEffect } from "./lib/effect"
import { readInitial, readUpdate, state } from "./lib/instructions"

// Compiled directly instead of through AppNodeBuilder: the builder imports the
// plugin supervisor graph, which currently fails to load on a broken
// `@opencode/plus` import. This node needs no Location provisioning.
const it = testEffect(
  LayerNode.compile(LayerNode.group([InstructionDiscovery.node]), {
    replacements: [Bus.node.replace(Layer.mock(Bus.Service, { publish: () => Effect.void }))],
  }),
)

const file = (path: string, content: string) =>
  new InstructionDiscovery.File({ path: AbsolutePath.make(path), content })

const parts = (instructions: Instructions.List) =>
  Effect.gen(function* () {
    const admission = yield* Instructions.read(instructions).pipe(Effect.flatMap(Instructions.diff))
    const values = Object.fromEntries(
      Object.entries(admission.delta).flatMap(([key, hash]) =>
        hash === "removed" ? [] : [[key, admission.blobs[hash]]],
      ),
    )
    // Same mapping the model request applies: one SystemPart per instruction source.
    return Instructions.renderInitialParts(instructions, values).map(SystemPart.make)
  })

describe("InstructionDiscovery per-file parts", () => {
  it.effect("assembles one system part per instruction file", () =>
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

  it.effect("assembles a single file into a single part", () =>
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

  it.effect("removing one file through the transform removes exactly its part", () =>
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

  it.effect("keys one source per file path", () =>
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

  it.effect("retains unavailable reads without admitting new parts", () =>
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
})
