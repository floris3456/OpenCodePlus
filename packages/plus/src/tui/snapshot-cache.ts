import type { Snapshot } from "../rpc.js"

/**
 * One cached instructions snapshot per location directory.
 *
 * The Instructions screen renders an entry as soon as it can — stale or not —
 * and revalidates in the background; the dialogs and the agent actions read an
 * entry only while it is fresh, and fetch once when it is not. The cache is
 * plugin-level, so it survives closing and reopening the screen.
 *
 * A change event carries no directory, and a global-level change moves every
 * directory's snapshot, so one event marks every entry stale; nothing refetches
 * until the next open or dialog read. A put marks every other directory stale
 * for the same reason: while the plugin sits on this directory the others are
 * unverifiable (the event stream may be location-scoped).
 *
 * A put also ignores a snapshot older than the entry it would replace, so a
 * dialog fetch that resolves after a newer route write cannot roll the entry
 * back.
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
  /** Stores a newer-or-equal snapshot for a directory and stales every other. */
  put(directory: string | undefined, snapshot: Snapshot): void
  /** Marks every entry stale. */
  markStale(): void
  dispose(): void
}

export interface SnapshotCacheOptions {
  /** The client's `instructions.changed` stream; one event marks every entry stale. */
  readonly events?: {
    on(name: "instructions.changed", handler: () => void): () => void
  }
}

export function createSnapshotCache(options: SnapshotCacheOptions = {}): SnapshotCache {
  const entries = new Map<string, { snapshot: Snapshot; stale: boolean }>()
  // Implicit-local placement has no directory; the empty key still keeps it
  // apart from any real directory.
  const keyOf = (directory: string | undefined) => directory ?? ""
  const markStale = () => {
    for (const entry of entries.values()) entry.stale = true
  }
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
      const key = keyOf(directory)
      const current = entries.get(key)?.snapshot
      if (current !== undefined && !isNewer(snapshot, current)) return
      markStale()
      entries.set(key, { snapshot, stale: false })
    },
    markStale,
    dispose: () => {},
  }
  if (options.events !== undefined) cache.dispose = options.events.on("instructions.changed", markStale)
  return cache
}

// Replace when either revision is newer, or both are equal; a snapshot behind
// in one revision and level in the other is an older answer.
function isNewer(next: Snapshot, current: Snapshot): boolean {
  if (next.revision > current.revision || next.globalRevision > current.globalRevision) return true
  return next.revision === current.revision && next.globalRevision === current.globalRevision
}
