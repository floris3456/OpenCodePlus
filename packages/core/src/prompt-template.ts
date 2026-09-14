export * as PromptTemplate from "./prompt-template.js"

import PROMPT_GENERAL from "./session/runner/prompt/system.txt"
import PROMPT_GPT from "./plugin/system-prompt/gpt.txt"
import PROMPT_ASTRA from "./plugin/system-prompt/gpt-astra.txt"
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

// The RAW template text the optimize plugins render for this model. This is
// the single owner of the gpt-6 -> astra selection: OpenAIPlugin renders
// exactly this, and the plugin host exposes it so Plus aligns tool guidance
// against what core actually rendered rather than the classification's
// canonical template. Family comes from active so the two cannot disagree;
// only gpt subdivides, and that rule lives here alone.
export function raw(model: { readonly id: string; readonly name: string }): string | undefined {
  const family = active(model)
  if (family === "gpt") return model.id.toLowerCase().includes("gpt-6") ? PROMPT_ASTRA : PROMPT_GPT
  if (family === "kimi") return PROMPT_KIMI
  if (family === "trinity") return PROMPT_TRINITY
  if (family === "muse") return PROMPT_META
  return undefined
}
