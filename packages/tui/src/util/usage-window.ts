import type { UsageWindowInput } from "@opencode/plugin/tui/context"
import { createSignal } from "solid-js"

type Provider = (input: UsageWindowInput) => number | undefined

// Plugin providers of the window a chat's context usage is measured against
// (Plugin.Context ui.usage.window). Module-level like the prompt's send guards:
// the footer and the plugin that registers never share a component.
const [providers, setProviders] = createSignal<readonly Provider[]>([])

export const usageWindows = {
  register(provider: Provider): () => void {
    setProviders((list) => [...list, provider])
    return () => setProviders((list) => list.filter((entry) => entry !== provider))
  },
  /** The smallest positive answer, or undefined when no provider answers. Reactive. */
  of(input: UsageWindowInput): number | undefined {
    const answers = providers()
      .map((provider) => provider(input))
      .filter((answer): answer is number => answer !== undefined && answer > 0)
    return answers.length === 0 ? undefined : Math.min(...answers)
  },
}
