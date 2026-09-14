export * as PromptTemplate from "./prompt-template.js"

import PROMPT_GENERAL from "./session/runner/prompt/system.txt"
import PROMPT_GPT from "./plugin/system-prompt/gpt.txt"
import PROMPT_KIMI from "./plugin/system-prompt/kimi.txt"
import PROMPT_META from "./plugin/system-prompt/meta.txt"
import PROMPT_TRINITY from "./plugin/system-prompt/trinity.txt"

export interface Info {
  readonly id: string
  readonly title: string
  readonly text: string
}

export const templates: readonly Info[] = [
  { id: "gpt", title: "GPT.txt", text: PROMPT_GPT },
  // This fork ships no Claude-specific template; the id resolves to the general text.
  { id: "claude", title: "Claude.txt", text: PROMPT_GENERAL },
  { id: "muse", title: "Muse.txt", text: PROMPT_META },
  // This fork ships no Gemini-specific template; the id resolves to the general text.
  { id: "gemini", title: "Gemini.txt", text: PROMPT_GENERAL },
  { id: "general", title: "General.txt", text: PROMPT_GENERAL },
  { id: "kimi", title: "Kimi.txt", text: PROMPT_KIMI },
  { id: "trinity", title: "Trinity.txt", text: PROMPT_TRINITY },
]

/** The template id an agent running this model resolves to. */
export function active(model: { readonly id: string; readonly name: string }) {
  const id = model.id.toLowerCase()
  if (id.includes("gpt")) return "gpt"
  if (id.includes("kimi")) return "kimi"
  if (id.includes("trinity")) return "trinity"
  if (id.includes("muse")) return "muse"
  return "general"
}
