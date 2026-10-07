import { Effect, type Scope } from "effect"
import fsSync from "node:fs"

// The cross-process half of shared-store watching: one service-wide fs watch
// pair, not one per folder. The targets (the shared records directory and the
// global teams root) are global, so every loaded folder shares the same two
// native watchers through a process-wide refcount. Each subscriber still gets
// every change and runs its own coalescing timer; a subscriber whose folders
// were all evicted releases its hold, and the last one out closes the
// watchers. A missing target simply contributes no watcher until the first
// write creates it.
const shared = {
  watchers: undefined as fsSync.FSWatcher[] | undefined,
  subscribers: new Set<(force: boolean) => void>(),
}

export function acquireSharedStoreWatch(
  directories: readonly { readonly path: string; readonly force: boolean }[],
  onChange: (force: boolean) => void,
): Effect.Effect<void, never, Scope.Scope> {
  return Effect.acquireRelease(
    Effect.sync(() => {
      shared.subscribers.add(onChange)
      if (shared.watchers !== undefined) return
      const watchers: fsSync.FSWatcher[] = []
      for (const target of directories) {
        try {
          const watcher = fsSync.watch(target.path, { persistent: false }, () =>
            shared.subscribers.forEach((notify) => notify(target.force)),
          )
          watcher.on("error", () => undefined)
          watchers.push(watcher)
        } catch {
          // Missing target: no watcher until the first write creates it.
        }
      }
      shared.watchers = watchers
    }),
    () =>
      Effect.sync(() => {
        shared.subscribers.delete(onChange)
        if (shared.subscribers.size > 0) return
        shared.watchers?.forEach((watcher) => watcher.close())
        shared.watchers = undefined
      }),
  )
}

/** Test seam: how many native watchers the shared pair currently holds. */
export function sharedStoreWatchCount(): number {
  return shared.watchers?.length ?? 0
}
