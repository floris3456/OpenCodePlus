import type { Transform } from "./registration.js"

export interface SnapshotEditor {
  readonly configure: (enabled: boolean) => void
}

/** A plugin can turn the Location's undo snapshots off, for example for folders whose work is committed some other way. */
export interface SnapshotDomain {
  readonly transform: Transform<SnapshotEditor>
}
