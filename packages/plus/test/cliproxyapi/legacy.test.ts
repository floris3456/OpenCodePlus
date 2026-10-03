import { expect, test } from "bun:test"
import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { Effect } from "effect"
import { migratingStorage } from "../../src/cliproxyapi/legacy.js"

function memory(initial: Record<string, unknown> = {}) {
  const data = new Map(Object.entries(initial))
  const storage = {
    get: (key: string) => Effect.sync(() => data.get(key) as never),
    set: (key: string, value: unknown) => Effect.sync(() => void data.set(key, value)),
    remove: (key: string) => Effect.sync(() => void data.delete(key)),
    scan: () => Effect.succeed({ items: [] } as never),
  } as unknown as StorageDomain
  return { data, storage }
}

test("quota entries stored by the Plus plugin are copied on first read; other keys are not", async () => {
  const own = memory({ "quota/kept": "own" })
  const legacy = { "quota/installation": "a".repeat(48), "quota/ses/cpa/m": { capability: "c" }, "catalog/cpa": "x" }
  const reads: string[] = []
  const storage = migratingStorage(own.storage, async (key) => {
    reads.push(key)
    return legacy[key as keyof typeof legacy]
  })
  expect(await Effect.runPromise(storage.get("quota/installation"))).toBe("a".repeat(48))
  expect(own.data.get("quota/installation")).toBe("a".repeat(48))
  expect(await Effect.runPromise(storage.get("quota/kept"))).toBe("own")
  expect(await Effect.runPromise(storage.get("catalog/cpa"))).toBeUndefined()
  expect(await Effect.runPromise(storage.get("quota/missing"))).toBeUndefined()
  expect(own.data.has("quota/missing")).toBe(false)
  // A migrated entry is read from this plugin's storage afterwards.
  await Effect.runPromise(storage.get("quota/installation"))
  expect(reads).toEqual(["quota/installation", "quota/missing"])
})
