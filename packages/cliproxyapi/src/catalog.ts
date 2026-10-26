import type { ProviderEditor } from "@opencode/plugin/effect/provider"
import type { Model } from "@opencode/schema/model"
import { Money } from "@opencode/schema/money"
import type { Price } from "./pacer/protocol.js"
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
 *
 * Last fallback: the plain OpenAI model list (`/models`), IDs and owners only.
 * A CPA without the details catalogue answers `details=true` with that list.
 */
export const DETAILS_SCHEMA = "cliproxyapi.model-details/1"
export const CODEX_CLIENT_VERSION = "0.300.0"

export interface CatalogModel {
  readonly price?: Price
  readonly id: string
  readonly name: string
  readonly kind: "chat" | "image"
  readonly ownedBy?: string
  /** The CPA providers serving it (claude, codex, antigravity, …), when the catalogue says. */
  readonly providers?: readonly string[]
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
  readonly source: "details" | "codex" | "plain"
  readonly hash: string
  readonly models: readonly CatalogModel[]
}

const DetailModel = Schema.Struct({
  id: Schema.String,
  owned_by: Schema.optional(Schema.NullOr(Schema.String)),
  providers: Schema.optional(Schema.NullOr(Schema.Array(Schema.String))),
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

const Plain = Schema.Struct({
  data: Schema.Array(Schema.Struct({ id: Schema.String, owned_by: Schema.optional(Schema.NullOr(Schema.String)) })),
})

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
      ...(item.providers?.length ? { providers: item.providers.map((provider) => provider.toLowerCase()) } : {}),
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

/**
 * The plain list states no levels, limits or modalities: chat models get text
 * in and out with reasoning passed through, and Core's defaults for the rest.
 */
export function parsePlainList(raw: unknown, hash: string): Catalogue | undefined {
  const decoded = Schema.decodeUnknownOption(Plain)(raw)
  if (decoded._tag === "None" || decoded.value.data.length === 0) return undefined
  const models = decoded.value.data.map((item): CatalogModel => {
    const kind = IMAGE_SLUG.test(item.id) ? "image" : "chat"
    return {
      id: item.id,
      name: item.id,
      kind,
      ownedBy: item.owned_by ? item.owned_by.toLowerCase() : undefined,
      input: ["text"],
      outputModalities: kind === "image" ? ["image"] : ["text"],
      reasoning: kind === "image" ? { mode: "none", levels: [] } : { mode: "passthrough", levels: [] },
      tiers: [],
    }
  })
  return { source: "plain", hash, models }
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

/** Prices participate in the sync hash, so price-only changes reload model costs. */
export function withCataloguePrices(catalogue: Catalogue, prices: Record<string, Price> | undefined): Catalogue {
  if (!prices) return catalogue
  return {
    ...catalogue,
    hash: new Bun.CryptoHasher("sha256").update(catalogue.hash + JSON.stringify(prices)).digest("hex"),
    models: catalogue.models.map((model) => (prices[model.id] ? { ...model, price: prices[model.id] } : model)),
  }
}

/** V2 costs are an array of USD/million-token tiers, not the V1 flat cost object. */
export function pacerCosts(price: Price, fast: boolean): Model.Cost[] {
  const body = fast && price.fast ? price.fast : price
  const cost = (value: Pick<Price, "input" | "output" | "cache_read" | "cache_write">): Model.Cost => ({
    input: Money.USDPerMillionTokens.make(value.input),
    output: Money.USDPerMillionTokens.make(value.output),
    cache: {
      read: Money.USDPerMillionTokens.make(Math.max(0, value.cache_read ?? 0)),
      write: Money.USDPerMillionTokens.make(Math.max(0, value.cache_write ?? 0)),
    },
  })
  return [
    cost(body),
    ...(fast && price.fast ? [] : (price.context_tiers ?? []))
      .filter((tier) => Number.isSafeInteger(tier.above_tokens) && tier.above_tokens > 0)
      .map((tier) => ({ ...cost(tier.price), tier: { type: "context" as const, size: tier.above_tokens } })),
  ]
}

/**
 * Spell effort variants the way Core spells them for the provider's protocol
 * package (packages/core/src/variant.ts). Unknown packages get no variants.
 * Anthropic packages are model-aware, so they go through `anthropicVariants`.
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

const ANTHROPIC_COMPATIBLE = "@opencode/ai/providers/anthropic-compatible"

/** Packages that use the Anthropic Messages protocol and so can honor native compaction. */
const ANTHROPIC_PACKAGES = new Set([ANTHROPIC_COMPATIBLE, "@opencode/ai/providers/anthropic"])

/** The model facts Core uses to decide Anthropic thinking (packages/core/src/variant.ts). */
export interface AnthropicModel {
  readonly id: string
  readonly modelID?: string
  readonly limit: { readonly output: number }
}

interface ClaudeInfo {
  readonly manual: boolean
  readonly opus45: boolean
}

function claudeInfo(model: AnthropicModel): ClaudeInfo {
  const id = model.modelID ?? model.id
  const familyFirst = /(?:claude-)?(opus|sonnet|haiku|fable|mythos)-(\d+)(?:[.-](\d+))?/i.exec(id)
  const versionFirst = /claude-(\d+)(?:[.-](\d+))?-(opus|sonnet|haiku|fable|mythos)/i.exec(id)
  const family = (familyFirst?.[1] ?? versionFirst?.[3])?.toLowerCase()
  const major = Number(familyFirst?.[2] ?? versionFirst?.[1])
  const minor = Number(familyFirst?.[3] ?? versionFirst?.[2] ?? 0)
  return {
    manual: (major === 3 && minor === 7) || (major === 4 && minor < 6),
    opus45: family === "opus" && major === 4 && minor === 5,
  }
}

/**
 * Anthropic-spelled effort variants for one model, mirroring Core's model-aware
 * choice: Claude 3.7 and 4.5 take explicit `enabled`+`budgetTokens` thinking,
 * newer models add `effort` to adaptive thinking. Existing variant ids are kept.
 */
export function anthropicVariants(model: AnthropicModel, levels: readonly string[]): Variants {
  if (levels.length === 0) return []
  const info = claudeInfo(model)
  const budget = Math.min(16_000, model.limit.output - 1)
  const manual = info.manual && !info.opus45
  if ((manual || info.opus45) && budget < 1024) return []
  return levels.map((effort) => {
    if (manual) return { id: effort, settings: { thinking: { type: "enabled", budgetTokens: budget } } }
    if (info.opus45)
      return {
        id: effort,
        settings: { thinking: { type: "enabled", budgetTokens: budget }, effort },
      }
    return {
      id: effort,
      settings: { thinking: { type: "adaptive", display: "summarized" }, effort },
    }
  })
}

/** Core-spelled variants for the model's package: Anthropic is model-aware, the rest is not. */
function variantsFor(model: AnthropicModel, pkg: string | undefined, levels: readonly string[]): Variants {
  if (pkg !== undefined && ANTHROPIC_PACKAGES.has(pkg)) return anthropicVariants(model, levels)
  return spellVariants(pkg, levels)
}

/**
 * Points one routed Claude model at CPA's Anthropic Messages relay: the
 * anthropic-compatible package and Anthropic-spelled variants. A user's own
 * package wins, so the relay leaves the model alone when it is set to anything
 * else.
 *
 * Compaction is only applied by the post-config pass (`compaction: true`),
 * after config has merged the user's per-model settings. That pass runs once
 * the final package is known, so a model repackaged away from the relay never
 * gets a relay-owned `settings.compaction` and a user's own compaction is never
 * removed. It also keeps the relay's native compaction on a route that can
 * honor it instead of leaving it on a route that cannot.
 */
export function relayClaudeModel(
  model: Types.DeepMutable<Model.Info>,
  options?: { readonly compaction?: boolean },
): void {
  if (!isClaude(model)) return
  if (model.package !== undefined && model.package !== ANTHROPIC_COMPATIBLE) return
  model.package = ANTHROPIC_COMPATIBLE
  const ids = (model.variants ?? []).map((variant) => String(variant.id))
  if (ids.length > 0) model.variants = anthropicVariants(model, ids) as never
  // A user's own compaction (any type) wins; the relay only fills an absent one.
  if (options?.compaction === true && model.settings?.compaction?.type === undefined)
    model.settings = { ...(model.settings ?? {}), compaction: { type: "native" } } as never
}

/** Packages Core spells with OpenAI Responses reasoning settings. */
const RESPONSES = new Set([
  "@opencode/ai/providers/openai",
  "@opencode/ai/providers/openai/responses",
  "@opencode/ai/providers/azure/responses",
])

export const FAST_SUFFIX = "-fast"
export const FAST_TIER = "priority"
/** Warming for the models CPA serves through Antigravity: Claude's built-in times (schema ConfigWarming.builtIn). */
export const ANTIGRAVITY_WARMING = { interval: "4 minutes", duration: "25 minutes" } as const

export function servedByAntigravity(model: Pick<CatalogModel, "ownedBy" | "providers">): boolean {
  return model.providers?.includes("antigravity") ?? model.ownedBy === "antigravity"
}

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
        if (item.price) model.cost = pacerCosts(item.price, fast)
        model.modelID = item.id as never
        const userPackage = model.package !== undefined && model.package !== ANTHROPIC_COMPATIBLE
        const relayed = relay && !userPackage
        if (relayed) model.package = ANTHROPIC_COMPATIBLE
        model.capabilities = {
          tools: item.kind === "chat",
          input: [...item.input],
          output: [...item.outputModalities],
        }
        // CPA owns the window: its input limit is set or cleared with the context.
        if (item.context !== undefined)
          model.limit = withInput({ ...model.limit, context: item.context }, item.inputLimit)
        if (item.output !== undefined) model.limit.output = item.output
        // Variants are spelled after the limit so model-aware Anthropic budgets see the output.
        if (!userPackage)
          model.variants =
            item.reasoning.mode === "levels"
              ? (structuredClone(
                  variantsFor(model, relayed ? ANTHROPIC_COMPATIBLE : pkg, item.reasoning.levels),
                ) as never)
              : ([] as never)
        if (fast) model.body = { ...(model.body ?? {}), service_tier: FAST_TIER } as never
        // A model setting: config's own warming for the model merges over it later, while a
        // provider-wide or top-level value does not reach it.
        if (servedByAntigravity(item) && model.settings?.warming === undefined)
          model.settings = { ...model.settings, warming: { ...ANTIGRAVITY_WARMING } }
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
  options?: { readonly compaction?: boolean },
) {
  for (const providerID of Object.keys(routes)) {
    if (anthropicRelay?.[providerID] === false) continue
    for (const model of models.list(providerID)) {
      if (!isClaude(model)) continue
      models.update(providerID, model.id, (draft) => relayClaudeModel(draft, options))
    }
  }
}

/** Applies Anthropic relay to Claude models on routed providers for legacy/existing models. */
export function applyRelayToExistingModels(
  providers: ProviderEditor,
  routes: Readonly<Record<string, string>>,
  anthropicRelay?: Readonly<Record<string, boolean>>,
  options?: { readonly compaction?: boolean },
) {
  for (const providerID of Object.keys(routes)) {
    if (anthropicRelay?.[providerID] === false) continue
    const record = providers.get(providerID)
    if (!record) continue
    for (const model of record.models.values()) {
      if (!isClaude(model)) continue
      providers.models.update(providerID, model.id, (draft) => relayClaudeModel(draft, options))
    }
  }
}
