// Panel widths for the wide Instructions workspace
// (docs/instructions-workspace-followup.md §5): fixed Owners and Inspector
// widths around a flexible middle list, clamped so both panels and the list
// stay usable. Pure functions, so every boundary is unit-testable and the
// route only owns the storage and the drag state.

/** Today's sidebar width, and the double-click reset for the left panel. */
export const OWNERS_DEFAULT = 30
export const OWNERS_MIN = 24
export const INSPECTOR_MIN = 24
/** The middle list never shrinks below this, dividers included. */
export const MIN_LIST = 30
/** One divider column per resizable boundary. */
export const DIVIDER_WIDTH = 1
export const DIVIDERS = DIVIDER_WIDTH * 2

/** The durable client-local key; the host namespaces it per plugin. */
export const PANELS_STORAGE_KEY = "opencode.plus.instructions.panels"

export interface PanelPreferences {
  readonly owners?: number
  readonly inspector?: number
}

export interface PanelWidths {
  readonly owners: number
  readonly inspector: number
  /** The middle list: the columns left after both panels and the dividers. */
  readonly list: number
}

/** The inspector default: two fifths of the space right of Owners. */
export function defaultInspector(width: number, owners: number): number {
  return Math.max(0, Math.floor(((width - owners) * 2) / 5))
}

function clamp(size: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, Math.round(size)))
}

/** Owners stays above its minimum and leaves the list and the peer enough room. */
export function clampOwners(size: number, width: number, inspector: number): number {
  return clamp(size, OWNERS_MIN, Math.max(OWNERS_MIN, width - inspector - MIN_LIST - DIVIDERS))
}

/** The inspector's symmetric clamp: the list and Owners keep their room. */
export function clampInspector(size: number, width: number, owners: number): number {
  return clamp(size, INSPECTOR_MIN, Math.max(INSPECTOR_MIN, width - owners - MIN_LIST - DIVIDERS))
}

/**
 * The effective widths at this terminal width. Saved preferences are clamped
 * against each other's minimums; the inspector falls back to its 2/5 default
 * until the user sets one. Owners clamps first, so when the terminal cannot
 * honour both preferences the inspector yields the remaining space.
 */
export function panelWidths(width: number, preferred: PanelPreferences = {}): PanelWidths {
  const owners = clampOwners(preferred.owners ?? OWNERS_DEFAULT, width, INSPECTOR_MIN)
  const inspector = clampInspector(preferred.inspector ?? defaultInspector(width, owners), width, owners)
  return { owners, inspector, list: Math.max(0, width - owners - inspector - DIVIDERS) }
}