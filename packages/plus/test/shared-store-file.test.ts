import { describe, expect, test } from "bun:test"
import { Effect, Exit, Scope } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { acquireSharedStoreWatch, sharedStoreWatchCount } from "../src/shared-store-file.js"

async function tempRoot(): Promise<string> {
  return fs.mkdtemp(path.join(os.tmpdir(), "plus-shared-store-file-"))
}

describe("acquireSharedStoreWatch", () => {
  test("one native pair serves every subscriber and closes on last release", async () =>
    Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          const root = yield* Effect.promise(tempRoot)
          const dirs = [
            { path: root, force: false },
            { path: path.join(root, "teams"), force: true },
          ]
          yield* Effect.promise(() => fs.mkdir(dirs[1].path, { recursive: true }))
          const seen: boolean[][] = [[], []]
          const scopeA = yield* Scope.make()
          const scopeB = yield* Scope.make()
          yield* Scope.provide(acquireSharedStoreWatch(dirs, (force) => void seen[0].push(force)), scopeA)
          // A second subscriber adds no native watcher.
          yield* Scope.provide(acquireSharedStoreWatch(dirs, (force) => void seen[1].push(force)), scopeB)
          expect(sharedStoreWatchCount()).toBe(2)
          // Both subscribers hear a write either target.
          yield* Effect.promise(() => fs.writeFile(path.join(root, "records.json"), "{}")).pipe(
            Effect.andThen(() => Effect.sleep("300 millis")),
          )
          expect(seen[0].length).toBeGreaterThan(0)
          expect(seen[1].length).toBeGreaterThan(0)
          // Releasing one subscriber keeps the pair; releasing both closes it.
          yield* Scope.close(scopeA, Exit.void)
          expect(sharedStoreWatchCount()).toBe(2)
          yield* Scope.close(scopeB, Exit.void)
          expect(sharedStoreWatchCount()).toBe(0)
          yield* Effect.promise(() => fs.rm(root, { recursive: true, force: true }))
        }),
      ),
    ),
  )
})
