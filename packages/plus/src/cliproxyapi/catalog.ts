import type { ProviderEditor } from "@opencode/plugin/effect/provider"
import { Schema } from "effect"

/**
 * CLIProxyAPI model catalogue → OpenCode models.
 *
 * Primary source: `GET <baseURL>/models?details=true` (schema
 * `cliproxyapi.model-details/1`), which states per model the reasoning control
 * CPA actually applies: `levels` (validated list), `none` (stripped) or
 * `passthrough` (forwarded unvalidated — no levels are invented for these).
 *
 * Fallback for CPA builds without it: the Codex model catalogue
 * (`/models?client_version=…`). It fills unknown models with template levels,
 * so its levels are marked approximate.
 */
export const DETAILS_SCHEMA = "cliproxyapi.model-details/1"
export const CODEX_CLIENT_VERSION = "0.300.0"

export interface CatalogModel {
  readonly id: string
  readonly name: string
  readonly kind: "chat" | "image"
  readonly context?: number
  readonly output?: number
  readonly input: readonly string[]
  readonly outputModalities: readonly string[]
  readonly reasoning: { readonly mode: "levels" | "none" | "passthrough"; readonly levels: readonly string[] }
  readonly tiers: readonly string[]
}

export interface Catalogue {
  readonly source: "details" | "codex"
  readonly hash: string
  readonly models: readonly CatalogModel[]
}

const DetailModel = Schema.Struct({
  id: Schema.String,
  display_name: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  context_length: Schema.optional(Schema.NullOr(Schema.Number)),
  max_completion_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
  input_modalities: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  output_modalities: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  reasoning: Schema.optional(
    Schema.Struct({ mode: Schema.String, levels: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))) }),
  ),
  service_tiers: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
})
const Details = Schema.Struct({ schema: Schema.String, hash: Schema.String, data: Schema.Array(DetailModel) })

const CodexModel = Schema.Struct({
  slug: Schema.String,
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
  context_window: Schema.optional(Schema.NullOr(Schema.Number)),
  max_context_window: Schema.optional(Schema.NullOr(Schema.Number)),
  visibility: Schema.optional(Schema.NullOr(Schema.String)),
  input_modalities: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
  supported_reasoning_levels: Schema.optional(
    Schema.NullOr(Schema.Array(Schema.Union([Schema.String, Schema.Struct({ effort: Schema.String })]))),
  ),
  service_tiers: Schema.optional(Schema.NullOr(Schema.Array(Schema.Struct({ id: Schema.String })))),
})
const Codex = Schema.Struct({ models: Schema.Array(CodexModel) })

/** Effort names OpenCode variants are created for, in display order. */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const
const MODALITIES = new Set(["text", "image", "audio", "video", "pdf"])
const IMAGE_SLUG = /(^|\/)(gpt-image|grok-imagine)/

const positive = (value: number | null | undefined) =>
  typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : undefined
const efforts = (levels: readonly string[]) =>
  EFFORTS.filter((effort) => levels.some((level) => level.toLowerCase() === effort))
const modalities = (values: readonly string[] | null | undefined, fallback: readonly string[]) => {
  const out = (values ?? []).map((value) => value.toLowerCase()).filter((value) => MODALITIES.has(value))
  return out.length ? [...new Set(out)] : [...fallback]
}

export function parseDetails(raw: unknown): Catalogue | undefined {
  const decoded = Schema.decodeUnknownOption(Details)(raw)
  if (decoded._tag === "None" || decoded.value.schema !== DETAILS_SCHEMA) return undefined
  const models = decoded.value.data.map((item): CatalogModel => {
    const kind = item.kind === "image" ? "image" : "chat"
    const mode = item.reasoning?.mode
    const reasoning =
      kind === "image" || mode === "none"
        ? { mode: "none" as const, levels: [] }
        : mode === "levels"
          ? { mode: "levels" as const, levels: efforts(item.reasoning?.levels ?? []) }
          : { mode: "passthrough" as const, levels: [] }
    return {
      id: item.id,
      name: item.display_name?.trim() || item.id,
      kind,
      context: positive(item.context_length),
      output: positive(item.max_completion_tokens),
      input: modalities(item.input_modalities, ["text"]),
      outputModalities: kind === "image" ? ["image"] : modalities(item.output_modalities, ["text"]),
      reasoning,
      tiers: [...(item.service_tiers ?? [])],
    }
  })
  return { source: "details", hash: decoded.value.hash, models }
}

export function parseCodexCatalogue(raw: unknown, hash: string): Catalogue | undefined {
  const decoded = Schema.decodeUnknownOption(Codex)(raw)
  if (decoded._tag === "None") return undefined
  const models = decoded.value.models.map((item): CatalogModel => {
    const kind = IMAGE_SLUG.test(item.slug) ? "image" : "chat"
    const levels = (item.supported_reasoning_levels ?? []).map((level) =>
      typeof level === "string" ? level : level.effort,
    )
    return {
      id: item.slug,
      name: item.display_name?.trim() || item.slug,
      kind,
      context: positive(item.max_context_window) ?? positive(item.context_window),
      output: undefined,
      input: modalities(item.input_modalities, ["text"]),
      outputModalities: kind === "image" ? ["image"] : ["text"],
      reasoning:
        kind === "image" || levels.length === 0
          ? { mode: "none", levels: [] }
          : { mode: "levels", levels: efforts(levels) },
      tiers: (item.service_tiers ?? []).map((tier) => tier.id),
    }
  })
  return { source: "codex", hash, models }
}

type Variants = { id: string; settings?: Record<string, unknown> }[]

/**
 * Spell effort variants the way Core spells them for the provider's protocol
 * package (packages/core/src/variant.ts). Unknown packages get no variants.
 */
export function spellVariants(pkg: string | undefined, levels: readonly string[]): Variants {
  if (levels.length === 0) return []
  if (pkg !== undefined && RESPONSES.has(pkg))
    return levels.map((effort) => ({
      id: effort,
      settings: { reasoningEffort: effort, reasoningSummary: "auto", include: ["reasoning.encrypted_content"] },
    }))
  if (pkg === "@opencode/ai/providers/openai-compatible")
    return levels.map((effort) => ({ id: effort, settings: { reasoningEffort: effort } }))
  return []
}

/** Packages Core spells with OpenAI Responses reasoning settings. */
const RESPONSES = new Set([
  "@opencode/ai/providers/openai",
  "@opencode/ai/providers/openai/responses",
  "@opencode/ai/providers/azure/responses",
])

export const FAST_SUFFIX = "-fast"
export const FAST_TIER = "priority"

/** Adds the catalogue's models (and a `-fast` alias per Fast-capable model) to one provider. */
export function applyCatalogue(
  providers: ProviderEditor,
  providerID: string,
  catalogue: Catalogue,
  pkg: string | undefined,
) {
  if (pkg)
    providers.update(providerID, (provider) => {
      provider.package ??= pkg
    })
  const ids = new Set(catalogue.models.map((model) => model.id))
  for (const item of catalogue.models) {
    const variants = item.reasoning.mode === "levels" ? spellVariants(pkg, item.reasoning.levels) : []
    const define = (id: string, name: string, fast: boolean) =>
      providers.models.update(providerID, id, (model) => {
        model.name = name
        model.modelID = item.id as never
        model.capabilities = {
          tools: item.kind === "chat",
          input: [...item.input],
          output: [...item.outputModalities],
        }
        if (item.context !== undefined) model.limit.context = item.context
        if (item.output !== undefined) model.limit.output = item.output
        model.variants = structuredClone(variants) as never
        if (fast) model.body = { ...(model.body ?? {}), service_tier: FAST_TIER } as never
      })
    // Image models answer only on CPA's images endpoint (image.generate tool), not in chat.
    define(item.id, item.kind === "image" ? `${item.name} (images)` : item.name, false)
    const fastID = `${item.id}${FAST_SUFFIX}`
    if (item.kind === "chat" && item.tiers.includes(FAST_TIER) && !ids.has(fastID))
      define(fastID, `${item.name} (Fast)`, true)
  }
}
