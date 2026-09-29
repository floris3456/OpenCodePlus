import { createContext, useContext } from "solid-js"

export interface ComposerHint {
  label: string
  shortcut: string
}

/**
 * The height in rows of a composer tab's body: the native tabs' body is a
 * `<scrollbox maxHeight={5}>`, which lays out at five rows whatever it holds.
 * Plugin bodies are clipped to the same height so switching tabs never
 * changes the composer's height.
 */
export const COMPOSER_TAB_BODY_HEIGHT = 5

export interface ComposerTab {
  id: string
  label: string
  hints?: () => ComposerHint[]
  onClose?: () => void
}

export const ComposerContext = createContext<{
  register: (tab: ComposerTab) => () => void
  active: (id: string) => boolean
  close: () => void
}>()

export function useComposerTab() {
  const ctx = useContext(ComposerContext)
  if (!ctx) throw new Error("useComposerTab must be used within a Composer")
  return ctx
}
