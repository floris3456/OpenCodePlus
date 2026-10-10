// Vendored from opencode-pacer@35cfeff (src/core/models.ts).
// CPA's model catalogue as host-neutral facts. Each host adapter spells
// packages and reasoning variants its own way.
//
// Primary source: `GET /v1/models?details=true` (schema
// `cliproxyapi.model-details/1`), which states per model the reasoning control
// CPA applies: `levels` (validated list), `none` (stripped) or `passthrough`
// (forwarded unvalidated: no levels are invented). A CPA without it answers
// with the plain list (IDs and owners only).

import type { Price } from "./protocol.js"

export const DETAILS_SCHEMA = "cliproxyapi.model-details/1"
/** Effort names variants are created for, in display order. */
export const EFFORTS = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const
export const FAST_TIER = "priority"

const MODALITIES = new Set(["text", "image", "audio", "video", "pdf"])
const IMAGE_ID = /(^|\/)(gpt-image|grok-imagine)/

export interface CatalogModel {
  id: string
  name: string
  kind: "chat" | "image"
  ownedBy?: string
  /** CPA providers serving it (claude, codex, antigravity, ...). */
  providers: string[]
  /** Whole window: prompt + reply. */
  context?: number
  /** Largest prompt, when smaller than `context` (Codex: 272k prompt of a 400k window). */
  inputLimit?: number
  output?: number
  input: string[]
  outputModalities: string[]
  reasoning: { mode: "levels" | "none" | "passthrough"; levels: string[] }
  tiers: string[]
  /** Pacer's price, when Pacer has one. */
  price?: Price
}

export interface Catalogue {
  source: "details" | "plain"
  models: CatalogModel[]
}

const positive = (v: unknown) => (typeof v === "number" && Number.isFinite(v) && v > 0 ? Math.floor(v) : undefined)
const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [])
const efforts = (levels: string[]) => EFFORTS.filter((e) => levels.some((l) => l.toLowerCase() === e))
function modalities(values: unknown, fallback: string[]) {
  const out = strings(values)
    .map((v) => v.toLowerCase())
    .filter((v) => MODALITIES.has(v))
  return out.length ? [...new Set(out)] : [...fallback]
}

export function parseCatalogue(body: { details: boolean; data: unknown[] }): Catalogue {
  const models: CatalogModel[] = []
  for (const raw of body.data) {
    if (!raw || typeof raw !== "object") continue
    const item = raw as Record<string, unknown>
    const id = typeof item.id === "string" ? item.id.trim() : ""
    if (!id || id.length > 256) continue
    const ownedBy = typeof item.owned_by === "string" && item.owned_by ? item.owned_by.toLowerCase() : undefined
    if (!body.details) {
      const kind = IMAGE_ID.test(id) ? "image" : "chat"
      models.push({
        id,
        name: id,
        kind,
        ownedBy,
        providers: [],
        input: ["text"],
        outputModalities: kind === "image" ? ["image"] : ["text"],
        reasoning: kind === "image" ? { mode: "none", levels: [] } : { mode: "passthrough", levels: [] },
        tiers: [],
      })
      continue
    }
    const kind = item.kind === "image" ? "image" : "chat"
    const r = (item.reasoning ?? {}) as Record<string, unknown>
    const reasoning: CatalogModel["reasoning"] =
      kind === "image" || r.mode === "none"
        ? { mode: "none", levels: [] }
        : r.mode === "levels"
          ? { mode: "levels", levels: efforts(strings(r.levels)) }
          : { mode: "passthrough", levels: [] }
    const context = positive(item.context_length)
    const inputLimit = positive(item.input_length)
    models.push({
      id,
      name: (typeof item.display_name === "string" && item.display_name.trim()) || id,
      kind,
      ownedBy,
      providers: strings(item.providers),
      context,
      inputLimit: inputLimit !== undefined && (context === undefined || inputLimit < context) ? inputLimit : undefined,
      output: positive(item.max_completion_tokens),
      input: modalities(item.input_modalities, ["text"]),
      outputModalities: kind === "image" ? ["image"] : modalities(item.output_modalities, ["text"]),
      reasoning,
      tiers: strings(item.service_tiers),
    })
  }
  models.sort((a, b) => a.id.localeCompare(b.id))
  return { source: body.details ? "details" : "plain", models }
}

/** Adds Pacer's prices to the catalogue (models without a price keep none). */
export function withPrices(catalogue: Catalogue, prices: Record<string, Price> | undefined): Catalogue {
  if (!prices) return catalogue
  return { ...catalogue, models: catalogue.models.map((m) => (prices[m.id] ? { ...m, price: prices[m.id] } : m)) }
}

export function isClaude(model: { id: string; ownedBy?: string }): boolean {
  return model.ownedBy === "anthropic" || model.id.toLowerCase().startsWith("claude-")
}

/** opencode's cost fields (USD per million tokens) for a price; a fast price for `-fast` models. */
export function costOf(price: Price | undefined, fast = false) {
  if (!price) return undefined
  const p = fast && price.fast ? price.fast : price
  return {
    input: p.input,
    output: p.output,
    cache_read: p.cache_read ?? 0,
    cache_write: p.cache_write ?? 0,
  }
}
