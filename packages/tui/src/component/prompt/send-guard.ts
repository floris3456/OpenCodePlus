import type { PromptSendInput } from "@opencode/plugin/tui/context"

// Plugin checks that may hold a message the prompt is about to send
// (Plugin.Context ui.prompt.guard). Module-level like the composer plugin tabs:
// the prompt that sends and the plugin that registers never share a component.
const checks = new Set<(input: PromptSendInput) => boolean>()

export const promptSendGuards = {
  register(check: (input: PromptSendInput) => boolean): () => void {
    checks.add(check)
    return () => {
      checks.delete(check)
    }
  },
  /** Runs every check, so each sees every send; true when none holds it. */
  allows(input: PromptSendInput): boolean {
    return [...checks].map((check) => check(input)).every(Boolean)
  },
}
