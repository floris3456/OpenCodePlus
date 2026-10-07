import type { Effect } from "effect"

/**
 * The host config seam for plugins. Only reloading is exposed: reading or
 * editing config documents stays with the host. `/refresh` re-reads this
 * folder's config through it, so project file changes apply without a
 * per-folder file watcher.
 */
export interface ConfigDomain {
  readonly reload: (options?: { readonly force?: boolean }) => Effect.Effect<void>
}
