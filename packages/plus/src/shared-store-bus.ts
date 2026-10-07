// Process-wide notification that the shared (global) Plus store moved.
//
// Every Location runs its own Plus instance in one server process, but the
// host Bus is Location-filtered: a Global/Defaults change made through one
// Location never reaches the others' `watchHostEvents` subscriber. This bus is
// the cheap in-process seam for that: any publish that changed the shared
// store notifies every subscriber, and each subscriber re-reads the store and
// republishes (which is what makes the host emit `agent.updated` per Location).
//
// It carries no payload: the store revision is already durable in the records
// file, so a listener just refreshes and lets the normal stale check decide.
// The file watcher in index.ts covers the same signal across separate server
// processes (the standalone dev topology), where module state is not shared.
// `source` is the notifying instance (it skips its own notice); `force` marks
// a change that writes no record (a team directory), which the listeners must
// rediscover even though the store revisions did not move.
type Listener = (source?: unknown, force?: boolean) => void

const listeners = new Set<Listener>()

export function notifySharedStoreChanged(source?: unknown, force?: boolean): void {
  for (const listener of [...listeners]) listener(source, force)
}

export function onSharedStoreChanged(listener: Listener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam: drop every subscription a suite left behind. */
export function resetSharedStoreListeners(): void {
  listeners.clear()
}