// The AI lab a model comes from, for the provider › lab groups of the Models
// tabs and Defaults › Models (tree.ts). It reads the words of the model's
// display name, else of its id without the `org/` segments a provider puts in
// front (`deepseek-ai/`, `Qwen/`, `opencode-go/`). The first lab whose words
// match wins, so the order matters: CLIProxyAPI serves Claude and OpenAI's
// open-weight models under `gemini-` ids (`gemini-opus-4-6-thinking`,
// `gemini-oss-120b-medium`), so Claude and ChatGPT come before Gemini.

export const OTHER_LAB = "Other"

const LABS: readonly { readonly label: string; readonly words: RegExp }[] = [
  { label: "Claude", words: leading("claude|opus|sonnet|haiku") },
  // gpt-oss included; o1/o3/o4 stand alone, so `o4` never matches inside another word.
  { label: "ChatGPT", words: /(^|[^a-z])(chatgpt|gpt|codex|openai|oss-\d+b)|(^|[^a-z0-9])o[134]($|[^a-z0-9])/ },
  { label: "Gemini", words: leading("gemini|gemma") },
  { label: "Grok", words: leading("grok") },
  { label: "Qwen", words: leading("qwen|qwq") },
  { label: "DeepSeek", words: leading("deepseek") },
  { label: "GLM", words: leading("glm|chatglm") },
  { label: "Kimi", words: leading("kimi|moonshot") },
  { label: "MiniMax", words: leading("minimax") },
  { label: "MiMo", words: leading("mimo") },
  // Before Meta: NVIDIA's Nemotron models are often Llama-based and say so.
  { label: "Nemotron", words: leading("nemotron") },
  { label: "Meta", words: leading("llama|muse[- ]?spark") },
  { label: "Mistral", words: leading("mistral|mixtral|codestral|devstral|magistral|ministral|pixtral") },
  { label: "Hunyuan", words: leading("hunyuan|hy\\d") },
  { label: "LongCat", words: leading("longcat") },
  { label: "Step", words: leading("stepfun|step[- ]?\\d") },
]

/** The lab's label ("Claude", "ChatGPT", …), or "Other" when neither the name nor the id names one. */
export function modelLab(modelID: string, name: string | undefined): string {
  return labIn(name) ?? labIn(modelID.slice(modelID.lastIndexOf("/") + 1)) ?? OTHER_LAB
}

/** Labs in display order: by label, ignoring case, with Other last. */
export function compareLabs(left: string, right: string): number {
  if (left === right) return 0
  if (left === OTHER_LAB) return 1
  if (right === OTHER_LAB) return -1
  return left.toLowerCase() < right.toLowerCase() ? -1 : 1
}

// The groups' ids: `<Models group id>:provider=<provider>` and
// `…:provider=<provider>:lab=<lab>`. The provider is percent-encoded, so a `:`,
// `/`, `,` or space in it never splits the id, and `=` keeps the last segment
// from ever reading as a tab or another group's ending (a provider named
// `tools` or `models` would otherwise end like a tab).
export function modelProviderGroupId(models: string, providerID: string): string {
  return `${models}:provider=${encodeURIComponent(providerID)}`
}

export function modelLabGroupId(provider: string, lab: string): string {
  return `${provider}:lab=${lab.toLowerCase()}`
}

/** A provider or lab group id's parts: the Models group it sits in, the provider and, for a lab group, the lab's slug. */
export function parseModelGroupId(
  id: string,
): { readonly models: string; readonly providerID: string; readonly lab?: string } | undefined {
  const match = /^(.*[:/]models):provider=((?:[^:%]|%[0-9A-Fa-f]{2})*)(?::lab=([a-z]+))?$/.exec(id)
  if (match === null) return undefined
  const parts = { models: match[1]!, providerID: decodeURIComponent(match[2]!) }
  return match[3] === undefined ? parts : { ...parts, lab: match[3] }
}

function labIn(text: string | undefined): string | undefined {
  if (text === undefined) return undefined
  const lower = text.toLowerCase()
  return LABS.find((lab) => lab.words.test(lower))?.label
}

// A lab's word at the start of the text or after a non-letter (`qwen3`,
// `gpt-5`, `Grok 4.6`), never in the middle of a longer word.
function leading(words: string): RegExp {
  return new RegExp(`(^|[^a-z])(${words})`)
}
