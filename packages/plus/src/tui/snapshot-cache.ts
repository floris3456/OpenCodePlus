import type { Snapshot } from "../rpc.js"

/**
 * One cached instructions snapshot per location directory.
 *
 * The Instructions screen renders an entry as soon as it can — stale or not —
 * and revalidates in the background; the dialogs and the agent actions read an
 * entry only while it is fresh, and fetch once when it is not. The cache is
 * plugin-level, so it survives closing and reopening the screen; while the
 * screen is closed a change event only marks the entry stale (nothing
 * refetches), and the next open both renders it and validates it.
 */
export interface SnapshotCacheEntry {
  readonly snapshot: Snapshot
  readonly stale: boolean
}

export interface SnapshotCache {
  /** The entry for a directory, stale or not, for a screen that renders it at once. */
  peek(directory: string | undefined): SnapshotCacheEntry | undefined
  /** The snapshot for a directory while it is fresh, or undefined. */
  fresh(directory: string | undefined): Snapshot | undefined
  /** Stores a snapshot as the fresh entry for a directory. */
  put(directory: string | undefined, snapshot: Snapshot): void
  /** Marks a directory's entry stale; an absent entry stays absent. */
  markStale(directory?: string | undefined): void
  dispose(): void
}

export interface SnapshotCacheOptions {
  /** The client's `instructions.changed` stream; the cache only marks entries stale. */
  readonly events?: {
    on(name: "instructions.changed", handler: () => void): () => void
  }
  /** The directory a change event belongs to: the plugin's current location. */
  readonly directory?: () => string | undefined
}

export function createSnapshotCache(options: SnapshotCacheOptions = {}): SnapshotCache {
  const entries = new Map<string, { snapshot: Snapshot; stale: boolean }>()
  // Implicit-local placement has no directory; the empty key still keeps it
  // apart from any real directory.
  const keyOf = (directory: string | undefined) => directory ?? ""
  const cache: SnapshotCache = {
    peek: (directory) => {
      const entry = entries.get(keyOf(directory))
      return entry === undefined ? undefined : { snapshot: entry.snapshot, stale: entry.stale }
    },
    fresh: (directory) => {
      const entry = entries.get(keyOf(directory))
      return entry === undefined || entry.stale ? undefined : entry.snapshot
    },
    put: (directory, snapshot) => {
      entries.set(keyOf(directory), { snapshot, stale: false })
    },
    markStale: (directory) => {
      const entry = entries.get(keyOf(directory))
      if (entry !== undefined) entry.stale = true
    },
    dispose: () => {},
  }
  if (options.events !== undefined)
    cache.dispose = options.events.on("instructions.changed", () => cache.markStale(options.directory?.()))
  return cache
}
