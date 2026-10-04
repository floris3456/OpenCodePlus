import type { ProviderEditor } from "@opencode/plugin/effect/provider"
import type { Model } from "@opencode/schema/model"
import { Schema, type Types } from "effect"

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
  readonly ownedBy?: string
  /** Whole window: prompt + reply. */
  readonly context?: number
  /** Largest prompt, when smaller than `context` (Codex: 272k prompt of a 400k GPT window). */
  readonly inputLimit?: number
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
  owned_by: Schema.optional(Schema.NullOr(Schema.String)),
  display_name: Schema.optional(Schema.String),
  kind: Schema.optional(Schema.String),
  context_length: Schema.optional(Schema.NullOr(Schema.Number)),
  input_length: Schema.optional(Schema.NullOr(Schema.Number)),
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
  owned_by: Schema.optional(Schema.NullOr(Schema.String)),
  display_name: Schema.optional(Schema.NullOr(Schema.String)),
  context_window: Schema.optional(Schema.NullOr(Schema.Number)),
  max_context_window: Schema.optional(Schema.NullOr(Schema.Number)),
  max_tokens: Schema.optional(Schema.NullOr(Schema.Number)),
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
    const context = positive(item.context_length)
    const inputLimit = positive(item.input_length)
    return {
      id: item.id,
      name: item.display_name?.trim() || item.id,
      kind,
      ownedBy: item.owned_by ? item.owned_by.toLowerCase() : undefined,
      context,
      inputLimit: inputLimit !== undefined && (context === undefined || inputLimit < context) ? inputLimit : undefined,
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
    // Codex sends prompts up to context_window; max_context_window is an opt-in ceiling that
    // CPA does not serve by default. The window is a prompt budget: the reply (CPA's
    // max_tokens) comes on top. Image models have no chat context.
    const window = kind === "image" ? undefined : (positive(item.context_window) ?? positive(item.max_context_window))
    const output = kind === "image" ? undefined : positive(item.max_tokens)
    return {
      id: item.slug,
      name: item.display_name?.trim() || item.slug,
      kind,
      ownedBy: item.owned_by ? item.owned_by.toLowerCase() : undefined,
      context: window !== undefined && output !== undefined ? window + output : window,
      inputLimit: window !== undefined && output !== undefined ? window : undefined,
      output,
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

function withInput<T extends { input?: number }>(limit: T, input: number | undefined): T {
  const { input: _, ...rest } = limit
  return (input === undefined ? rest : { ...rest, input }) as T
}

export function isClaude(model: {
  readonly id: string
  readonly modelID?: string
  readonly ownedBy?: string
  readonly owned_by?: string | null
}): boolean {
  const owner = model.ownedBy ?? model.owned_by
  if (owner?.toLowerCase() === "anthropic") return true
  const id = model.modelID ?? model.id
  return id.toLowerCase().startsWith("claude-") || model.id.toLowerCase().startsWith("claude-")
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
  if (pkg === "@opencode/ai/providers/anthropic" || pkg === ANTHROPIC_COMPATIBLE)
    return levels.map((effort) => ({
      id: effort,
      settings: { thinking: { type: "adaptive", display: "summarized" }, effort },
    }))
  return []
}

const ANTHROPIC_COMPATIBLE = "@opencode/ai/providers/anthropic-compatible"

/** Packages that use the Anthropic Messages protocol and so can honor native compaction. */
const ANTHROPIC_PACKAGES = new Set([ANTHROPIC_COMPATIBLE, "@opencode/ai/providers/anthropic"])

/**
 * Points one routed Claude model at CPA's Anthropic Messages relay: the
 * anthropic-compatible package, its Anthropic-spelled variants and native
 * compaction. A user's own package wins, so the relay leaves the model alone
 * when it is set to anything else. Existing variant ids keep their spelling
 * (ids are never invented) and a user compaction choice is kept.
 */
export function relayClaudeModel(model: Types.DeepMutable<Model.Info>): void {
  if (!isClaude(model)) return
  const userPackage = model.package !== undefined && model.package !== ANTHROPIC_COMPATIBLE
  if (userPackage) {
    // The relay owns a model only while it keeps the relay package. Config applies a
    // user's per-model package after an earlier relay pass, which would otherwise leave
    // the relay's native compaction on a route that cannot honor it. A user's own
    // Anthropic package can honor native, so it keeps whatever the user set.
    if (!ANTHROPIC_PACKAGES.has(model.package ?? "") && model.settings?.compaction?.type === "native")
      delete model.settings.compaction
    return
  }
  model.package = ANTHROPIC_COMPATIBLE
  const ids = (model.variants ?? []).map((variant) => String(variant.id))
  if (ids.length > 0) model.variants = spellVariants(ANTHROPIC_COMPATIBLE, ids) as never
  const userCompaction = model.settings?.compaction?.type ? model.settings.compaction : undefined
  model.settings = { ...(model.settings ?? {}), compaction: userCompaction ?? { type: "native" } } as never
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
  options?: { anthropicRelay?: boolean },
) {
  if (pkg)
    providers.update(providerID, (provider) => {
      provider.package ??= pkg
    })
  const ids = new Set(catalogue.models.map((model) => model.id))
  for (const item of catalogue.models) {
    const relay = options?.anthropicRelay !== false && isClaude(item)
    const define = (id: string, name: string, fast: boolean) =>
      providers.models.update(providerID, id, (model) => {
        model.name = name
        model.modelID = item.id as never
        const userPackage = model.package !== undefined && model.package !== ANTHROPIC_COMPATIBLE
        if (relay && !userPackage) {
          model.package = ANTHROPIC_COMPATIBLE
          const userCompaction = model.settings?.compaction?.type ? model.settings.compaction : undefined
          model.settings = { ...model.settings, compaction: userCompaction ?? { type: "native" } } as never
          model.variants =
            item.reasoning.mode === "levels"
              ? (structuredClone(spellVariants(ANTHROPIC_COMPATIBLE, item.reasoning.levels)) as never)
              : ([] as never)
        } else if (!userPackage) {
          model.variants =
            item.reasoning.mode === "levels"
              ? (structuredClone(spellVariants(pkg, item.reasoning.levels)) as never)
              : ([] as never)
        }
        model.capabilities = {
          tools: item.kind === "chat",
          input: [...item.input],
          output: [...item.outputModalities],
        }
        // CPA owns the window: its input limit is set or cleared with the context.
        if (item.context !== undefined)
          model.limit = withInput({ ...model.limit, context: item.context }, item.inputLimit)
        if (item.output !== undefined) model.limit.output = item.output
        if (fast) model.body = { ...(model.body ?? {}), service_tier: FAST_TIER } as never
      })
    // Image models answer only on CPA's images endpoint (image.generate tool), not in chat.
    define(item.id, item.kind === "image" ? `${item.name} (images)` : item.name, false)
    const fastID = `${item.id}${FAST_SUFFIX}`
    if (item.kind === "chat" && item.tiers.includes(FAST_TIER) && !ids.has(fastID))
      define(fastID, `${item.name} (Fast)`, true)
  }
}

/** Model-domain editor surface (`@opencode/plugin/effect/model` ModelEditor), structurally. */
export interface RelayModelEditor {
  readonly list: (providerID: string) => readonly Types.DeepMutable<Model.Info>[]
  readonly update: (
    providerID: string,
    modelID: Model.ID,
    update: (model: Types.DeepMutable<Model.Info>) => void,
  ) => void
}

/**
 * Applies Anthropic relay in the model domain, after every provider transform.
 * This reaches models that config creates after the plugin's provider
 * transform, such as the Claude models of a legacy quota-handoff route.
 */
export function applyRelayToModels(
  models: RelayModelEditor,
  routes: Readonly<Record<string, string>>,
  anthropicRelay?: Readonly<Record<string, boolean>>,
) {
  for (const providerID of Object.keys(routes)) {
    if (anthropicRelay?.[providerID] === false) continue
    for (const model of models.list(providerID)) {
      if (!isClaude(model)) continue
      models.update(providerID, model.id, (draft) => relayClaudeModel(draft))
    }
  }
}

/** Applies Anthropic relay to Claude models on routed providers for legacy/existing models. */
export function applyRelayToExistingModels(
  providers: ProviderEditor,
  routes: Readonly<Record<string, string>>,
  anthropicRelay?: Readonly<Record<string, boolean>>,
) {
  for (const providerID of Object.keys(routes)) {
    if (anthropicRelay?.[providerID] === false) continue
    const record = providers.get(providerID)
    if (!record) continue
    for (const model of record.models.values()) {
      if (!isClaude(model)) continue
      providers.models.update(providerID, model.id, (draft) => relayClaudeModel(draft))
    }
  }
}
