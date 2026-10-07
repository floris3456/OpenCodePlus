import type { Location } from "@opencode/schema/location"
import type { Effect } from "effect"

/**
 * Location administration for a plugin. A plugin that ends work in another
 * folder (a team run's worker worktree) can release that folder's cached
 * services now instead of waiting for the idle timeout.
 */
export interface LocationAdminDomain {
  /**
   * Evicts a loaded Location's cached services, unless a Session there is
   * active. Runs the same guarded path the idle sweep uses; a missing or
   * unloaded Location is a no-op.
   */
  readonly evict: (ref: Location.Ref) => Effect.Effect<void>
  /**
   * Whether a Location's services are loaded now. A caller that would boot a
   * folder as a side effect (a cache-warming ping) checks first and skips an
   * unloaded folder, which reads fresh state when it is next loaded.
   */
  readonly loaded: (ref: Location.Ref) => Effect.Effect<boolean>
}
