import { ConfigWarming } from "@opencode/schema/config/warming"
import { Duration, Option, Schema } from "effect"
import { cacheLifetime } from "../monitor/cache.js"
import { BUILT_IN_IMAGES, choicesOf, IMAGE_FIELD_LABELS, IMAGE_FIELDS, imageFieldOf, imageValueOf, type ImageField } from "../image-settings.js"
import {
  formatDuration,
  formatWarming,
  parseInterval,
  parseModelItemId,
  parsePrompt,
  parseWarming,
  addModelRecord,
  resolveModelField,
  scopedTo,
  WARMING_MAX_MS,
  type Level,
  type ModelInput,
  type ModelRecord,
  type ModelRefLike,
  type RecordScope,
  type ModelWarmingFields,
  type ResolvedModelFields,
} from "./model.js"

// Defaults › Models: the model settings every agent, team member and preset
// falls back to when its own model row does not set them. One "Every model"
// row and one row per model. For one agent on one model a setting resolves
//
//   the agent's model row (down its chain: project → global → … → defaults)
//   > Defaults › Models › <that model>
//   > Defaults › Models › Every model
//   > opencode.json for that model or its provider (shown, never written)
//   > the built-in defaults (opencode.json's top-level `warming` folds into
//     the runtime base core proposes)
//
// field by field, so a row that sets only the interval still inherits the
// warming time. A chat's own on/off switch overrides whether warming runs.

export interface ModelSettingsRecord extends ModelCompactionFields {
  readonly type: "modelSettings"
  readonly level: "defaults"
  /** Absent together with modelID: the Every model row. */
  readonly providerID?: string
  readonly modelID?: string
  /** "off", "on" or a total time such as "30m"; absent inherits. */
  readonly warming?: string
  /** Time between keep-alive requests such as "4m" or "3m30s"; absent inherits. */
  readonly interval?: string
  /** The keep-alive request's text; absent inherits. */
  readonly prompt?: string
  /** Variant used when an agent's model row names no variant; absent inherits. */
  readonly effort?: string
  readonly updated: string
}

export type ModelSettingsField = "warming" | "interval" | "prompt" | "effort"
export const MODEL_SETTINGS_FIELDS: readonly ModelSettingsField[] = ["warming", "interval", "prompt", "effort"]

/** A Defaults › Models row: one model, or every model when both ids are absent. */
export interface ModelSettingsKey {
  readonly providerID?: string
  readonly modelID?: string
}

/** The host's own warming for one model (opencode.json provider or model settings), in milliseconds. */
export interface HostWarming {
  /** False when the host disables warming for this model; true when it enables it. */
  readonly on: boolean
  readonly duration?: number
  readonly interval?: number
  readonly prompt?: string
}

/** A catalog model as Defaults › Models needs it: its variants and the host's warming. */
export interface HostModel {
  readonly providerID: string
  readonly modelID: string
  /** Display name from the host catalog when it has one. */
  readonly name?: string
  readonly variants: readonly string[]
  readonly warming?: HostWarming
}

/** Core's defaults (core/src/config/warming.ts); off unless something turns warming on. */
export const BUILT_IN_WARMING = {
  on: false,
  prompt: "This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK",
  interval: 4 * 60 * 1000,
  duration: 30 * 60 * 1000,
} as const

/**
 * Where an effective value came from: an agent row's level, this model's
 * Defaults row (`model`), opencode.json for this model (`config`), the Every
 * model row (`every`), what the host proposed at runtime (`host`), the
 * built-in default, or the chat's own switch.
 */
export type SettingFrom = Level | "model" | "config" | "every" | "host" | "built-in" | "chat"

/**
 * Compaction also inherits the agent's agent-wide rows (`agent`, the old
 * Compaction tab) and the shared Defaults rows for every agent (`agents`).
 */
export type CompactionFrom = SettingFrom | "agent" | "agents"

export interface Effective<T> {
  readonly value: T
  readonly from: SettingFrom
}

export interface EffectiveWarming {
  readonly on: Effective<boolean>
  readonly duration: Effective<number>
  readonly interval: Effective<number>
  readonly prompt: Effective<string>
}

/** What sits below Every model: the host's proposal at runtime, the built-in defaults otherwise. */
export interface WarmingBase {
  readonly on: boolean
  readonly duration: number
  readonly interval: number
  readonly prompt: string
  readonly from: SettingFrom
}

export const BUILT_IN_BASE: WarmingBase = { ...BUILT_IN_WARMING, from: "built-in" }

interface Layer {
  readonly from: SettingFrom
  readonly on?: boolean
  readonly duration?: number
  readonly interval?: number
  readonly prompt?: string
}

export function effectiveWarming(input: {
  readonly row?: ResolvedModelFields
  readonly model?: ModelSettingsRecord
  readonly host?: HostWarming
  readonly every?: ModelSettingsRecord
  readonly base?: WarmingBase
}): EffectiveWarming {
  const base = input.base ?? BUILT_IN_BASE
  const layers: Layer[] = [
    ...rowLayers(input.row),
    ...(input.model === undefined ? [] : [recordLayer(input.model, "model")]),
    ...(input.every === undefined ? [] : [recordLayer(input.every, "every")]),
    ...(input.host === undefined ? [] : [{ from: "config" as const, ...input.host }]),
  ]
  const pick = <K extends "on" | "duration" | "interval" | "prompt">(key: K): Effective<NonNullable<Layer[K]>> => {
    const layer = layers.find((entry) => entry[key] !== undefined)
    if (layer === undefined) return { value: base[key] as NonNullable<Layer[K]>, from: base.from }
    return { value: layer[key] as NonNullable<Layer[K]>, from: layer.from }
  }
  const interval = pick("interval")
  const duration = pick("duration")
  return {
    on: pick("on"),
    duration: { ...duration, value: roundWarming(duration.value, interval.value) },
    interval,
    prompt: pick("prompt"),
  }
}

/**
 * A warming time is a whole number of keep-alive intervals, rounded up: 30m
 * with a 4m interval warms 32m, so the window ends on a keep-alive instead of
 * part-way to the next one. The fields may come from different layers, so
 * this applies wherever they meet.
 */
export function roundWarming(duration: number, interval: number): number {
  if (!(interval > 0) || duration % interval === 0) return duration
  const up = Math.ceil(duration / interval) * interval
  // Past the 24h ceiling a stored time would no longer parse: round down there.
  if (up <= WARMING_MAX_MS || duration > WARMING_MAX_MS) return up
  return Math.max(interval, Math.floor(WARMING_MAX_MS / interval) * interval)
}

function rowLayers(row: ResolvedModelFields | undefined): Layer[] {
  if (row === undefined) return []
  const warming = row.warming === undefined ? undefined : warmingLayer(row.warming.value, row.warming.level)
  const interval = row.interval === undefined ? undefined : intervalOf(row.interval.value)
  return [
    ...(warming === undefined ? [] : [warming]),
    ...(row.interval === undefined || interval === undefined ? [] : [{ from: row.interval.level, interval }]),
    ...(row.prompt === undefined ? [] : [{ from: row.prompt.level, prompt: row.prompt.value }]),
  ]
}

function recordLayer(record: ModelSettingsRecord, from: SettingFrom): Layer {
  const warming = record.warming === undefined ? undefined : warmingLayer(record.warming, from)
  const interval = record.interval === undefined ? undefined : intervalOf(record.interval)
  return {
    from,
    ...(warming?.on === undefined ? {} : { on: warming.on }),
    ...(warming?.duration === undefined ? {} : { duration: warming.duration }),
    ...(interval === undefined ? {} : { interval }),
    ...(record.prompt === undefined ? {} : { prompt: record.prompt }),
  }
}

// A stored value that no longer parses (hand-edited, or from a newer release)
// sets nothing, so the level below decides.
function warmingLayer(text: string, from: SettingFrom): Layer | undefined {
  const parsed = parseWarming(text)
  if ("error" in parsed) return undefined
  if (!parsed.on) return { from, on: false }
  return { from, on: true, ...(parsed.duration === undefined ? {} : { duration: parsed.duration }) }
}

function intervalOf(text: string): number | undefined {
  const parsed = parseInterval(text)
  return "error" in parsed ? undefined : parsed.interval
}

/**
 * The variant an agent's model row without one runs with: this model's
 * Defaults row, else Every model's when this model has that variant. A
 * model's own effort is kept when its variants are unknown; one it does not
 * have is ignored.
 */
export function defaultEffort(input: {
  readonly model?: ModelSettingsRecord
  readonly every?: ModelSettingsRecord
  readonly variants?: readonly string[]
}): Effective<string> | undefined {
  const variants = input.variants
  const own = input.model?.effort
  if (own !== undefined && (variants === undefined || variants.length === 0 || variants.includes(own)))
    return { value: own, from: "model" }
  const every = input.every?.effort
  if (every !== undefined && variants !== undefined && variants.includes(every)) return { value: every, from: "every" }
  return undefined
}

// The stored form is the Scoped encoding; decode it into durations with the union itself.
const decodeScopedWarming = Schema.decodeUnknownOption(ConfigWarming.Warming)

/**
 * The host's opencode.json warming for one model, decoded from the catalog's
 * settings (provider and model levels merged, the same value core's warming
 * plugin reads). Undefined when no config sets it.
 */
export function decodeHostWarming(value: unknown): HostWarming | undefined {
  const decoded = Option.getOrUndefined(decodeScopedWarming(value))
  if (decoded === undefined) return undefined
  if (decoded === false) return { on: false }
  if (decoded === true) return { on: true }
  return {
    on: true,
    ...(decoded.duration === undefined ? {} : { duration: Duration.toMillis(decoded.duration) }),
    ...(decoded.interval === undefined ? {} : { interval: Duration.toMillis(decoded.interval) }),
    ...(decoded.prompt === undefined ? {} : { prompt: decoded.prompt }),
  }
}

/** The Every model row: both ids absent. A half-keyed row (hand-edited) matches nothing. */
export function isEvery(key: ModelSettingsKey): boolean {
  return key.providerID === undefined && key.modelID === undefined
}

export function sameSettingsKey(record: ModelSettingsKey, key: ModelSettingsKey): boolean {
  if (isEvery(key)) return isEvery(record)
  if (isEvery(record)) return false
  return record.providerID === key.providerID && record.modelID === key.modelID
}

export function settingsFor(records: readonly ModelSettingsRecord[], key: ModelSettingsKey): ModelSettingsRecord | undefined {
  return records.find((record) => sameSettingsKey(record, key))
}

export function everySettings(records: readonly ModelSettingsRecord[]): ModelSettingsRecord | undefined {
  return settingsFor(records, {})
}

export function hostModelOf(
  hostModels: readonly HostModel[],
  key: { readonly providerID: string; readonly modelID: string },
): HostModel | undefined {
  return hostModels.find((entry) => entry.providerID === key.providerID && entry.modelID === key.modelID)
}

/**
 * Set fields on a Defaults › Models row (null clears one); a row left with no
 * field is removed. Fields the call does not name, the compaction fields
 * included, are kept.
 */
export function setModelSettingsRecord(
  records: readonly ModelSettingsRecord[],
  key: ModelSettingsKey,
  fields: { readonly [field in ModelSettingsField]?: string | null } & ModelCompactionFieldValues,
  updated: string,
): ModelSettingsRecord[] {
  const current = settingsFor(records, key)
  const named: readonly (ModelSettingsField | ModelCompactionField)[] = [...MODEL_SETTINGS_FIELDS, ...MODEL_COMPACTION_FIELDS]
  const values: Record<string, string | readonly string[]> = Object.fromEntries(
    named.flatMap((field) => {
      const next = fields[field] === undefined ? current?.[field] : fields[field]
      return next === undefined || next === null ? [] : [[field, next]]
    }),
  )
  const rest = records.filter((record) => !sameSettingsKey(record, key))
  if (Object.keys(values).length === 0) return rest
  const unchanged = current !== undefined && named.every((field) => sameFieldValue(current[field], values[field]))
  if (unchanged) return [...records]
  return [
    ...rest,
    {
      type: "modelSettings",
      level: "defaults",
      ...(isEvery(key) ? {} : { providerID: key.providerID, modelID: key.modelID }),
      ...values,
      updated,
    },
  ]
}

/**
 * A row's own warming time rounded up to a whole number of the interval it
 * resolves to (its own, else the rows below it), in stored form; undefined
 * when the row sets no time or the time is already whole. Saving rounds, so
 * the row reads what warming does.
 */
export function roundedWarmingFor(
  records: readonly ModelSettingsRecord[],
  key: ModelSettingsKey,
  host?: HostWarming,
): string | undefined {
  const record = settingsFor(records, key)
  const parsed = record?.warming === undefined ? undefined : parseWarming(record.warming)
  const duration = parsed === undefined || "error" in parsed || !parsed.on ? undefined : parsed.duration
  if (duration === undefined) return undefined
  const every = isEvery(key) ? undefined : everySettings(records)
  const interval = effectiveWarming({
    model: record,
    ...(every === undefined ? {} : { every }),
    ...(host === undefined ? {} : { host }),
  }).interval.value
  const rounded = roundWarming(duration, interval)
  return rounded === duration ? undefined : formatDuration(rounded)
}

/**
 * Validate what a person typed for warming fields: "" clears a field (null),
 * text is parsed and stored in canonical form, absent leaves it alone.
 */
export function warmingFieldsOf(input: {
  readonly warming?: string
  readonly interval?: string
  readonly prompt?: string
}): { readonly fields: ModelWarmingFields } | { readonly error: string } {
  const warming = input.warming === undefined ? undefined : warmingField(input.warming)
  if (warming !== undefined && typeof warming === "object" && warming !== null) return warming
  const interval = input.interval === undefined ? undefined : intervalField(input.interval)
  if (interval !== undefined && typeof interval === "object" && interval !== null) return interval
  const prompt = input.prompt === undefined ? undefined : promptField(input.prompt)
  if (prompt !== undefined && typeof prompt === "object" && prompt !== null) return prompt
  return {
    fields: {
      ...(warming === undefined ? {} : { warming }),
      ...(interval === undefined ? {} : { interval }),
      ...(prompt === undefined ? {} : { prompt }),
    },
  }
}

function warmingField(text: string): string | null | { readonly error: string } {
  if (text.trim().length === 0) return null
  const parsed = parseWarming(text)
  if ("error" in parsed) return parsed
  return formatWarming(parsed)
}

function intervalField(text: string): string | null | { readonly error: string } {
  if (text.trim().length === 0) return null
  const parsed = parseInterval(text)
  if ("error" in parsed) return parsed
  return formatDuration(parsed.interval)
}

function promptField(text: string): string | null | { readonly error: string } {
  if (text.trim().length === 0) return null
  const parsed = parsePrompt(text)
  if ("error" in parsed) return parsed
  return parsed.prompt
}

// Compaction per model. An agent, member or preset model row and a Defaults ›
// Models row carry the same optional fields; absent inherits, so a store
// without them behaves, and sends, exactly as before. Text fields are stored
// in canonical form, the cold-cache models as a list in try order.

/** The compaction fields of a model row and of a Defaults › Models row. */
export interface ModelCompactionFields {
  /** Absolute early token thresholds; "off" suppresses inheritance, absent inherits. */
  readonly compactionInput?: string
  readonly compactionOutput?: string
  /** Compact before cold for chats on this model: "on" or "off". */
  readonly compactWarm?: string
  /**
   * The old per-model cold-compaction switch, "on" or "off": still read from
   * stored rows and cleared by a reset, never consulted or written. The global
   * Settings › OpenCodePlus › Compact cold chats first replaced it.
   */
  readonly coldCompact?: string
  /** The models that compact a cold cache, "provider/model[#variant]", in try order. */
  readonly coldModels?: readonly string[]
  /** "auto", "local" or "remote". */
  readonly compactionStrategy?: string
  /** The model that writes the summary, "provider/model[#variant]". */
  readonly compactionModel?: string
  /** The summary request's instructions; "" is an empty prompt. */
  readonly compactionInstructions?: string
  /** Images › Convert large image: "webp-90", "webp-75", "webp-lossless" or "original" (image-settings.ts). */
  readonly imageConvert?: string
  /** Images › Shrink large image: the longest edge in pixels. */
  readonly imageShrink?: string
  /** Images › When image context is full: "compact", "leave-out" or "error". */
  readonly imagesFull?: string
}

// `ModelRecord` is declared in model.ts; its compaction fields are declared
// here, next to their validation and resolution.
declare module "./model.js" {
  interface ModelRecord extends ModelCompactionFields {}
}

export type ModelCompactionField = keyof ModelCompactionFields
export const MODEL_COMPACTION_FIELDS: readonly ModelCompactionField[] = [
  "compactionInput",
  "compactionOutput",
  "compactWarm",
  "coldCompact",
  "coldModels",
  "compactionStrategy",
  "compactionModel",
  "compactionInstructions",
  ...IMAGE_FIELDS,
]

/** A Defaults › Models field row: the warming fields plus the compaction fields. */
export type ModelDefaultField = ModelSettingsField | ModelCompactionField
export const MODEL_DEFAULT_FIELDS: readonly ModelDefaultField[] = [...MODEL_SETTINGS_FIELDS, ...MODEL_COMPACTION_FIELDS]

/** The switch fields a model row toggles with Space (never edited as text). */
export const MODEL_SWITCH_FIELDS: readonly ModelCompactionField[] = ["compactWarm"]

/** One save's compaction fields in stored form: a value sets, null clears (the level below decides again), absent leaves alone. */
export type ModelCompactionFieldValues = {
  readonly [field in ModelCompactionField]?: NonNullable<ModelCompactionFields[field]> | null
}

export type CompactionStrategy = "auto" | "local" | "remote"
export const COMPACTION_STRATEGIES: readonly CompactionStrategy[] = ["auto", "local", "remote"]

// The form the compaction model has always taken: provider/model[#variant].
const MODEL_REF = /^[^/\s#]+\/[^\s#]+(?:#[^\s#]+)?$/

/**
 * Validate compaction fields as a person typed them or a tool sent them.
 * Text is trimmed into canonical form. "" clears a field (null), except the
 * instructions, where "" is an explicit empty prompt; null always clears. The
 * cold-cache models take a list or comma-separated text; an explicit empty
 * list is this level's own "no models", over any list inherited from below.
 */
export function compactionFieldsOf(input: {
  readonly compactionInput?: string | null
  readonly compactionOutput?: string | null
  readonly compactWarm?: string | null
  readonly coldCompact?: string | null
  readonly coldModels?: string | readonly string[] | null
  readonly compactionStrategy?: string | null
  readonly compactionModel?: string | null
  readonly compactionInstructions?: string | null
  readonly imageConvert?: string | null
  readonly imageShrink?: string | null
  readonly imagesFull?: string | null
}): { readonly fields: ModelCompactionFieldValues } | { readonly error: string } {
  const checked = {
    compactionInput: thresholdField(input.compactionInput),
    compactionOutput: thresholdField(input.compactionOutput),
    compactWarm: switchField(input.compactWarm, "Compact before cold"),
    coldCompact: retiredColdSwitch(input.coldCompact),
    coldModels: coldModelsField(input.coldModels),
    compactionStrategy: strategyField(input.compactionStrategy),
    compactionModel: modelRefField(input.compactionModel),
    compactionInstructions: input.compactionInstructions,
    imageConvert: imageFieldOf("imageConvert", input.imageConvert),
    imageShrink: imageFieldOf("imageShrink", input.imageShrink),
    imagesFull: imageFieldOf("imagesFull", input.imagesFull),
  }
  const error = Object.values(checked).find((value): value is { readonly error: string } => typeof value === "object" && value !== null && "error" in value)
  if (error !== undefined) return error
  return { fields: Object.fromEntries(Object.entries(checked).filter(([, value]) => value !== undefined)) as ModelCompactionFieldValues }
}

function thresholdField(text: string | null | undefined) {
  if (text === undefined || text === null) return text
  const value = text.trim().toLowerCase()
  if (value.length === 0) return null
  if (thresholdOf(value) !== undefined) return value === "off" ? value : String(Number(value))
  return { error: "Compaction threshold must be a positive whole token count or off; empty inherits" }
}

/** Zero represents an explicit disabled early trigger, distinct from inheritance. */
function thresholdOf(value: string | readonly string[]): number | undefined {
  if (value === "off") return 0
  if (typeof value !== "string" || !/^\d+$/.test(value)) return undefined
  const count = Number(value)
  return Number.isSafeInteger(count) && count > 0 ? count : undefined
}

function switchField(text: string | null | undefined, label: string): string | null | undefined | { readonly error: string } {
  if (text === undefined || text === null) return text
  const value = text.trim().toLowerCase()
  if (value.length === 0) return null
  if (value === "on" || value === "off") return value
  return { error: `${label} must be on or off, got "${text.trim()}"` }
}

// Clearing the old per-model switch is allowed; setting it is not.
function retiredColdSwitch(text: string | null | undefined): null | undefined | { readonly error: string } {
  if (text === undefined || text === null || text.trim().length === 0) return text === undefined ? undefined : null
  return { error: COLD_SWITCH_MOVED }
}

export const COLD_SWITCH_MOVED =
  "Cold-chat compaction is switched on or off for every chat in Settings › OpenCodePlus › Compact cold chats first; a model row holds only its cold-cache models (coldModels)"

function strategyField(text: string | null | undefined): string | null | undefined | { readonly error: string } {
  if (text === undefined || text === null) return text
  const value = text.trim().toLowerCase()
  if (value.length === 0) return null
  if (COMPACTION_STRATEGIES.some((strategy) => strategy === value)) return value
  return { error: `Compaction strategy must be auto, local or remote, got "${text.trim()}"` }
}

function modelRefField(text: string | null | undefined): string | null | undefined | { readonly error: string } {
  if (text === undefined || text === null) return text
  const value = text.trim()
  if (value.length === 0) return null
  if (MODEL_REF.test(value)) return value
  return { error: `A compaction model is provider/model with an optional #variant, got "${value}"` }
}

function coldModelsField(
  value: string | readonly string[] | null | undefined,
): readonly string[] | null | undefined | { readonly error: string } {
  if (value === undefined || value === null) return value
  if (typeof value === "string" && value.trim().length === 0) return null
  const models = (typeof value === "string" ? value.split(",") : value).map((entry) => entry.trim())
  const bad = models.find((entry) => !MODEL_REF.test(entry))
  if (bad !== undefined) return { error: `A cold-cache model is provider/model with an optional #variant, got "${bad}"` }
  const twice = models.find((entry, index) => models.indexOf(entry) !== index)
  if (twice !== undefined) return { error: `"${twice}" is listed twice; each model is tried once` }
  return models
}

/** What each compaction field resolves to in an agent's model rows, with the level that set it. */
export type ResolvedCompactionFields = {
  readonly [field in ModelCompactionField]?: { readonly value: NonNullable<ModelCompactionFields[field]>; readonly level: Level }
}

/**
 * The compaction fields an agent's model rows set for `target`, down the
 * agent's chain exactly as its warming fields resolve: the first record for
 * that model (same variant, else the variant-less row) that sets the field,
 * tombstones hiding. The cold-cache list resolves as a whole: the first row
 * that sets a list wins.
 */
export function resolveModelCompactionFields(input: ModelInput, target: ModelRefLike): ResolvedCompactionFields {
  return Object.fromEntries(
    MODEL_COMPACTION_FIELDS.flatMap((field) => {
      // model.ts owns the chain walk; each record that sets `field` stands in
      // for it with its own index in the warming slot.
      const found = resolveModelField(
        { ...input, models: input.models.map((record, index) => ({ ...record, warming: record[field] === undefined ? undefined : String(index) })) },
        target,
        "warming",
      )
      return found === undefined ? [] : [[field, { value: input.models[Number(found.value)][field], level: found.level }]]
    }),
  )
}

/**
 * Set (or with null clear) compaction fields on the candidate at this
 * address, planting an inactive candidate row when the model is only
 * inherited here, as setModelSettings does for the warming fields. Every
 * other field of the row is kept. Clearing only fields no record here sets
 * returns an identical list.
 */
export function setModelCompaction(
  models: readonly ModelRecord[],
  address: RecordScope,
  target: { readonly providerID: string; readonly modelID: string; readonly variant?: string },
  fields: ModelCompactionFieldValues,
  updated: string,
): ModelRecord[] {
  const wanted = (record: ModelRecord) =>
    record.removed !== true &&
    scopedTo(record, address) &&
    record.providerID === target.providerID &&
    record.modelID === target.modelID &&
    record.variant === target.variant
  const named = MODEL_COMPACTION_FIELDS.filter((field) => fields[field] !== undefined)
  const sets = named.some((field) => fields[field] !== null)
  if (!sets && !models.some((record) => wanted(record) && named.some((field) => record[field] !== undefined))) return [...models]
  return addModelRecord(models, address, target, updated).map((record) => {
    if (!wanted(record)) return record
    const kept = Object.entries(record).filter(([key]) => !named.some((field) => field === key))
    const set = named.flatMap((field) => (fields[field] === null ? [] : [[field, fields[field]]]))
    return { ...Object.fromEntries([...kept, ...set]), updated } as ModelRecord
  })
}

/**
 * Compaction settings Plus reads but does not own per model, in their stored
 * text form: an agent's agent-wide `compaction:*` rows (the old Compaction
 * tab), the shared Defaults rows for every agent, or what opencode.json and
 * the compaction maintenance agent configure. A model of "" inherits.
 */
export interface CompactionDefaults {
  readonly strategy?: string
  readonly model?: string
  readonly instructions?: string
}

export interface CompactionEffective<T> {
  readonly value: T
  readonly from: CompactionFrom
}

export interface EffectiveCompaction {
  readonly compactionInput: CompactionEffective<number | undefined>
  readonly compactionOutput: CompactionEffective<number | undefined>
  readonly compactWarm: CompactionEffective<boolean>
  /** The cold-cache models in try order; only armed while the global cold-chat switch is on. */
  readonly coldModels: CompactionEffective<readonly string[]>
  readonly strategy: CompactionEffective<CompactionStrategy>
  /** Undefined when no layer names one: the maintenance compaction model, else the chat's own model. */
  readonly model: CompactionEffective<string | undefined>
  /** Undefined when no layer sets them: the maintenance compaction agent's prompt. */
  readonly instructions: CompactionEffective<string | undefined>
}

/** Where a compaction value came from, in words for the inspector, the tools and the footer. */
export function compactionFromWords(from: CompactionFrom): string {
  if (from === "agent") return "this agent's Compaction rows (agent-wide)"
  if (from === "agents") return "Defaults › Compaction (every agent)"
  if (from === "config") return "opencode.json or the compaction agent"
  return fromWords(from)
}

/**
 * The compaction settings for one agent on one model, field by field.
 *
 *   token thresholds, compact before cold, cold-cache list: the agent's model row
 *   (down its chain) > Defaults › Models › this model > Every model > built-in
 *   (no early thresholds, off, no models)
 *
 *   strategy, model, instructions: the agent's model row > the agent's
 *   agent-wide rows > Defaults › Models › this model > Every model > the
 *   shared Defaults rows for every agent > opencode.json or the maintenance
 *   agent > built-in (auto, none, none)
 *
 * A stored value that no longer parses sets nothing, so the level below decides.
 */
export function effectiveCompaction(input: {
  readonly row?: ResolvedCompactionFields
  readonly agent?: CompactionDefaults
  readonly model?: ModelSettingsRecord
  readonly every?: ModelSettingsRecord
  readonly agents?: CompactionDefaults
  readonly config?: CompactionDefaults
}): EffectiveCompaction {
  const row = input.row ?? {}
  const own = <F extends ModelCompactionField>(field: F) => [
    [row[field]?.level ?? "defaults", row[field]?.value] as const,
    ["model", input.model?.[field]] as const,
    ["every", input.every?.[field]] as const,
  ]
  const shared = (key: keyof CompactionDefaults, field: ModelCompactionField) => {
    const [fromRow, fromModel, fromEvery] = own(field)
    return [
      fromRow,
      ["agent", input.agent?.[key]] as const,
      fromModel,
      fromEvery,
      ["agents", input.agents?.[key]] as const,
      ["config", input.config?.[key]] as const,
    ]
  }
  return {
    compactionInput: firstSet<number | undefined>(own("compactionInput"), thresholdOf, undefined),
    compactionOutput: firstSet<number | undefined>(own("compactionOutput"), thresholdOf, undefined),
    compactWarm: firstSet(own("compactWarm"), switchOf, false),
    coldModels: firstSet(own("coldModels"), (value) => (Array.isArray(value) ? value.filter((entry) => MODEL_REF.test(entry)) : undefined), []),
    strategy: firstSet(shared("strategy", "compactionStrategy"), (value) => COMPACTION_STRATEGIES.find((strategy) => strategy === value), "auto"),
    model: firstSet<string | undefined>(shared("model", "compactionModel"), (value) => (typeof value === "string" && MODEL_REF.test(value) ? value : undefined), undefined),
    instructions: firstSet<string | undefined>(shared("instructions", "compactionInstructions"), (value) => (typeof value === "string" ? value : undefined), undefined),
  }
}

/**
 * The image settings for one agent on one model, field by field: the agent's model row (down its chain) > Defaults ›
 * Models › this model > Every model > built-in. A stored value that no longer parses sets nothing.
 */
export function effectiveImages(input: {
  readonly row?: ResolvedCompactionFields
  readonly model?: ModelSettingsRecord
  readonly every?: ModelSettingsRecord
}): Record<ImageField, CompactionEffective<string>> {
  const row = input.row ?? {}
  const of = (field: ImageField) =>
    firstSet(
      [
        [row[field]?.level ?? "defaults", row[field]?.value],
        ["model", input.model?.[field]],
        ["every", input.every?.[field]],
      ],
      (value) => (typeof value === "string" ? imageValueOf(field, value) : undefined),
      BUILT_IN_IMAGES[field],
    )
  return { imageConvert: of("imageConvert"), imageShrink: of("imageShrink"), imagesFull: of("imagesFull") }
}

// The first layer whose stored value parses, else the built-in value.
function firstSet<T>(
  layers: readonly (readonly [CompactionFrom, string | readonly string[] | undefined])[],
  parse: (value: string | readonly string[]) => T | undefined,
  builtIn: T,
): CompactionEffective<T> {
  for (const [from, stored] of layers) {
    const value = stored === undefined ? undefined : parse(stored)
    if (value !== undefined) return { value, from }
  }
  return { value: builtIn, from: "built-in" }
}

function switchOf(value: string | readonly string[]): boolean | undefined {
  if (value === "on") return true
  if (value === "off") return false
  return undefined
}

function sameFieldValue(left: string | readonly string[] | undefined, right: string | readonly string[] | undefined): boolean {
  if (Array.isArray(left) && Array.isArray(right)) return left.length === right.length && left.every((entry, index) => entry === right[index])
  return left === right
}

/** Where one layer's value shows in a compact row summary. */
export function sourceWord(from: SettingFrom): string {
  if (from === "config") return "opencode.json"
  if (from === "every") return "every model"
  if (from === "model") return "this row"
  if (from === "host") return "host"
  return "built-in"
}

export interface ModelDefaultView {
  readonly on: Effective<boolean>
  readonly duration: Effective<number>
  readonly interval: Effective<number>
  readonly prompt: Effective<string>
  readonly effort?: Effective<string>
  /** The row itself sets at least one field (the rest may still come from below). */
  readonly own: boolean
}

/** What one Defaults › Models row resolves to now, field by field, with each field's source. */
export function modelDefaultView(input: {
  readonly record?: ModelSettingsRecord
  readonly every?: ModelSettingsRecord
  readonly host?: HostWarming
  readonly variants?: readonly string[]
}): ModelDefaultView {
  const effective = effectiveWarming({ model: input.record, host: input.host, every: input.every })
  const effort = defaultEffort({ model: input.record, every: input.every, variants: input.variants })
  return {
    on: effective.on,
    duration: effective.duration,
    interval: effective.interval,
    prompt: effective.prompt,
    ...(effort === undefined ? {} : { effort }),
    own: input.record !== undefined,
  }
}

/**
 * The row's one-line summary: "warm 30m · every 4m", "warming off", the
 * default effort, and — for a row that sets nothing itself — where the values
 * come from ("opencode.json", "every model", "built-in").
 */
export function modelDefaultValue(view: ModelDefaultView): string {
  const core = view.on.value ? `warm ${formatDuration(view.duration.value)} · every ${formatDuration(view.interval.value)}` : "warming off"
  const effort = view.effort === undefined ? "" : ` · effort ${view.effort.value}`
  return `${core}${effort}${view.own ? "" : sourceSuffix(view)}`
}

const SOURCE_RANK: Record<SettingFrom, number> = {
  model: 1,
  project: 1,
  global: 1,
  defaults: 1,
  preset: 1,
  every: 2,
  config: 3,
  host: 3,
  "built-in": 4,
  chat: 0,
}

// The distinct sources of the values the summary prints (warming, interval and
// the effort), most specific first, so a mixed row reads "every model ·
// opencode.json" and a wholly inherited one "built-in". The prompt's source
// stays in the inspector's per-field detail.
function sourceSuffix(view: ModelDefaultView): string {
  const sources = new Set<SettingFrom>(
    [view.on, view.duration, view.interval, ...(view.effort === undefined ? [] : [view.effort])].map((field) => field.from),
  )
  const named = [...sources].filter((from) => from !== "built-in").toSorted((left, right) => SOURCE_RANK[left] - SOURCE_RANK[right])
  if (named.length === 0) return " · built-in"
  return ` · ${named.map(sourceWord).join(" · ")}`
}

/**
 * Every Defaults › Models row: "Every model" is implicit; the rest are every
 * model the host catalogue offers (`hostModels`, the same list `/models`
 * shows), stored records and agent models, sorted by provider/model. Listing
 * a model here writes nothing: it is only the surface that names a model's
 * keep-alive defaults (warming, interval, prompt, effort).
 */
export function modelDefaultKeys(input: {
  readonly modelSettings: readonly ModelSettingsRecord[]
  readonly models: readonly { readonly providerID: string; readonly modelID: string }[]
  readonly agents: readonly { readonly model?: { readonly providerID: string; readonly modelID: string } }[]
  readonly hostModels: readonly HostModel[]
}): ModelSettingsKey[] {
  const keys = new Map<string, ModelSettingsKey>()
  const add = (providerID: string, modelID: string) => {
    keys.set(`${providerID}/${modelID}`, { providerID, modelID })
  }
  for (const record of input.modelSettings)
    if (record.providerID !== undefined && record.modelID !== undefined) add(record.providerID, record.modelID)
  for (const model of input.models) add(model.providerID, model.modelID)
  for (const agent of input.agents) if (agent.model !== undefined) add(agent.model.providerID, agent.model.modelID)
  for (const host of input.hostModels) add(host.providerID, host.modelID)
  return [...keys.values()].toSorted((left, right) => {
    if (left.providerID !== right.providerID) return left.providerID! < right.providerID! ? -1 : 1
    if (left.modelID !== right.modelID) return left.modelID! < right.modelID! ? -1 : 1
    return 0
  })
}

/** Where a value came from, in words for the inspector and the tools. */
export function fromWords(from: SettingFrom): string {
  if (from === "model") return "Defaults › Models (this model)"
  if (from === "every") return "Defaults › Models › Every model"
  if (from === "config") return "opencode.json (this model or its provider)"
  if (from === "host") return "opencode.json (top-level warming) or built-in"
  if (from === "built-in") return "built-in default"
  if (from === "chat") return "this chat's switch"
  if (from === "defaults") return "Defaults"
  if (from === "global") return "Global"
  if (from === "project") return "Project"
  return "Presets"
}

// Row ids: `item:defaults:/models:modeldefault:*` for Every model and
// `item:defaults:/models:modeldefault:<provider>/<model>` per model. The
// `/models` owner segment cannot collide with an agent id (agent ids never
// start with `/`), and `modeldefault:` is not `model:`, so model-row code that
// matches `:model:` never takes these rows.
export const MODELS_OWNER = "/models"
export const MODELS_GROUP_ID = `group:defaults:${MODELS_OWNER}`
export const MODEL_DEFAULT_PREFIX = "modeldefault:"

export function modelDefaultItemId(key: ModelSettingsKey): string {
  if (isEvery(key)) return `${MODEL_DEFAULT_PREFIX}*`
  return `${MODEL_DEFAULT_PREFIX}${key.providerID}/${key.modelID}`
}

export function modelDefaultRowId(key: ModelSettingsKey): string {
  return `item:defaults:${MODELS_OWNER}:${modelDefaultItemId(key)}`
}

export function parseModelDefaultItemId(item: string): ModelSettingsKey | undefined {
  if (!item.startsWith(MODEL_DEFAULT_PREFIX)) return undefined
  const rest = item.slice(MODEL_DEFAULT_PREFIX.length)
  if (rest === "*") return {}
  const slash = rest.indexOf("/")
  if (slash <= 0 || slash === rest.length - 1) return undefined
  return { providerID: rest.slice(0, slash), modelID: rest.slice(slash + 1) }
}

export function isModelDefaultRowId(rowId: string): boolean {
  return rowId.startsWith(`item:defaults:${MODELS_OWNER}:${MODEL_DEFAULT_PREFIX}`)
}

// A Defaults › Models row opens into one row per field:
// `item:defaults:/models:modelsetting:<field>:*` or
// `…:modelsetting:<field>:<provider>/<model>`. The field leads so a model id
// with a colon still parses, and `modelsetting:` is not `modeldefault:`, so
// code that handles the whole row never takes a field row.
export const MODEL_SETTING_PREFIX = "modelsetting:"

export function modelSettingItemId(key: ModelSettingsKey, field: ModelDefaultField): string {
  return `${MODEL_SETTING_PREFIX}${field}:${modelDefaultItemId(key).slice(MODEL_DEFAULT_PREFIX.length)}`
}

export function modelSettingRowId(key: ModelSettingsKey, field: ModelDefaultField): string {
  return `item:defaults:${MODELS_OWNER}:${modelSettingItemId(key, field)}`
}

export function parseModelSettingItemId(
  item: string,
): { readonly key: ModelSettingsKey; readonly field: ModelDefaultField } | undefined {
  if (!item.startsWith(MODEL_SETTING_PREFIX)) return undefined
  const rest = item.slice(MODEL_SETTING_PREFIX.length)
  const colon = rest.indexOf(":")
  const field = MODEL_DEFAULT_FIELDS.find((entry) => entry === rest.slice(0, colon))
  if (colon === -1 || field === undefined) return undefined
  const key = parseModelDefaultItemId(`${MODEL_DEFAULT_PREFIX}${rest.slice(colon + 1)}`)
  return key === undefined ? undefined : { key, field }
}

export function isModelSettingRowId(rowId: string): boolean {
  return rowId.startsWith(`item:defaults:${MODELS_OWNER}:${MODEL_SETTING_PREFIX}`)
}

/** The Defaults › Models row a field row belongs to. */
export function modelSettingParentRowId(rowId: string): string | undefined {
  const parsed = parseModelSettingItemId(rowId.slice(`item:defaults:${MODELS_OWNER}:`.length))
  return parsed === undefined ? undefined : modelDefaultRowId(parsed.key)
}

/** The cold-cache group's own label; its summary is the list. */
export const COLD_COMPACT_LABEL = "Cold-cache models"

export const MODEL_SETTING_LABELS: Record<ModelDefaultField, string> = {
  compactionInput: "Input token threshold",
  compactionOutput: "Output token threshold",
  warming: "Warming",
  interval: "Ping every",
  prompt: "Keep-alive prompt",
  effort: "Effort",
  compactWarm: "Compact before cold",
  coldCompact: COLD_COMPACT_LABEL,
  coldModels: "Cold-cache models",
  compactionStrategy: "Strategy",
  compactionModel: "Model",
  compactionInstructions: "Instructions",
  ...IMAGE_FIELD_LABELS,
}

/** Whether a Defaults field row is a switch (Space) rather than a text/cycle row. */
export function isDefaultSwitchField(field: ModelDefaultField): field is "compactWarm" {
  return field === "compactWarm"
}

// An agent/member/preset model row opens into the same field rows as a
// Defaults › Models row, grouped: Model, Effort under the row, the Warming
// group (Warming, Ping every, Keep-alive prompt, Compact before cold and the
// cold-cache list), the Compaction group (Strategy, token thresholds, Model, Instructions) and the Images group
// (Convert large image, Shrink large image, When image context is full).
// The item id carries the field and the candidate, so
// `item:<level>:<owner>:modelfield:<field>:<provider>/<model>[@variant]`
// never collides with a `model:` row or a Defaults `modelsetting:` row.
export type ModelFieldName =
  | "compactionInput"
  | "compactionOutput"
  | "model"
  | "effort"
  | "warming"
  | "interval"
  | "prompt"
  | "compactWarm"
  | "coldCompact"
  | "compactionStrategy"
  | "compactionModel"
  | "compactionInstructions"
  | ImageField
export const MODEL_FIELD_NAMES: readonly ModelFieldName[] = [
  "compactionInput",
  "compactionOutput",
  "model",
  "effort",
  "warming",
  "interval",
  "prompt",
  "compactWarm",
  "coldCompact",
  "compactionStrategy",
  "compactionModel",
  "compactionInstructions",
  ...IMAGE_FIELDS,
]
export const MODEL_FIELD_PREFIX = "modelfield:"

export const MODEL_FIELD_LABELS: Record<ModelFieldName, string> = {
  compactionInput: "Input token threshold",
  compactionOutput: "Output token threshold",
  model: "Model",
  effort: "Effort",
  warming: "Warming",
  interval: "Ping every",
  prompt: "Keep-alive prompt",
  compactWarm: "Compact before cold",
  coldCompact: COLD_COMPACT_LABEL,
  compactionStrategy: "Strategy",
  compactionModel: "Model",
  compactionInstructions: "Instructions",
  ...IMAGE_FIELD_LABELS,
}

export function modelFieldItemId(
  target: { readonly providerID: string; readonly modelID: string; readonly variant?: string },
  field: ModelFieldName,
): string {
  const base = `${target.providerID}/${target.modelID}`
  return `${MODEL_FIELD_PREFIX}${field}:${target.variant === undefined ? base : `${base}@${target.variant}`}`
}

export function parseModelFieldItemId(
  item: string,
): { readonly target: { readonly providerID: string; readonly modelID: string; readonly variant?: string }; readonly field: ModelFieldName } | undefined {
  if (!item.startsWith(MODEL_FIELD_PREFIX)) return undefined
  const rest = item.slice(MODEL_FIELD_PREFIX.length)
  const colon = rest.indexOf(":")
  if (colon <= 0) return undefined
  const field = MODEL_FIELD_NAMES.find((entry) => entry === rest.slice(0, colon))
  if (field === undefined) return undefined
  const target = parseModelItemId(`model:${rest.slice(colon + 1)}`)
  return target === undefined ? undefined : { target, field }
}

export function isModelFieldItemId(item: string): boolean {
  return item.startsWith(MODEL_FIELD_PREFIX)
}

export function isModelFieldRowId(rowId: string): boolean {
  return rowId.includes(`:${MODEL_FIELD_PREFIX}`)
}

/** One field row's value as the list shows it: the effective value and, when inherited, where from. */
export function modelSettingValue(view: ModelDefaultView, field: ModelSettingsField, own: ModelSettingsRecord | undefined): string {
  const found = modelSettingEffective(view, field)
  if (found === undefined) return "none"
  // The keep-alive text is a sentence; the row keeps its start and the inspector shows all of it.
  const effective = field === "prompt" && found.text.length > 24 ? { ...found, text: `${found.text.slice(0, 23)}…` } : found
  if (own?.[field] === undefined) return `${effective.text} · ${sourceWord(effective.from)}`
  // "on" keeps the total time of the level below.
  if (field === "warming" && own.warming === "on") return `on · ${effective.text}`
  return effective.text
}

/** One field's effective value in words, with its source. */
export function modelSettingEffective(
  view: ModelDefaultView,
  field: ModelSettingsField,
): { readonly text: string; readonly from: SettingFrom } | undefined {
  if (field === "warming")
    return { text: view.on.value ? formatDuration(view.duration.value) : "off", from: view.on.value ? view.duration.from : view.on.from }
  if (field === "interval") return { text: formatDuration(view.interval.value), from: view.interval.from }
  if (field === "prompt") return { text: view.prompt.value, from: view.prompt.from }
  return view.effort === undefined ? undefined : { text: view.effort.value, from: view.effort.from }
}

// The cold-cache list under the model rows. Its rows are numbered by try
// order; `a` appends through the catalogue picker, `d` removes, `m` moves.
// The ids hang off the model row so they never collide with a field row:
// `item:<level>:<owner>:model:<target>:cold:<n>`, and their address carries a
// `coldmodel:`/`colddefault:` item with the target (or Defaults key) and index.
export const COLD_ITEM_SEGMENT = "cold"

export function coldListRowId(modelRowId: string, index: number): string {
  return `${modelRowId}:${COLD_ITEM_SEGMENT}:${index}`
}

export function parseColdListIndex(rowId: string): number | undefined {
  const at = rowId.lastIndexOf(`:${COLD_ITEM_SEGMENT}:`)
  if (at === -1) return undefined
  const index = Number(rowId.slice(at + COLD_ITEM_SEGMENT.length + 2))
  return Number.isInteger(index) && index >= 0 ? index : undefined
}

export function isColdListRowId(rowId: string): boolean {
  return parseColdListIndex(rowId) !== undefined
}

// An agent cold-list row's address item: `coldmodel:<target>:<index>`.
export const COLD_MODEL_PREFIX = "coldmodel:"

export function coldModelItemId(target: { readonly providerID: string; readonly modelID: string; readonly variant?: string }, index: number): string {
  const base = `${target.providerID}/${target.modelID}`
  return `${COLD_MODEL_PREFIX}${target.variant === undefined ? base : `${base}@${target.variant}`}:${index}`
}

export function parseColdModelItemId(
  item: string,
): { readonly target: { providerID: string; modelID: string; variant?: string }; readonly index: number } | undefined {
  if (!item.startsWith(COLD_MODEL_PREFIX)) return undefined
  const rest = item.slice(COLD_MODEL_PREFIX.length)
  const colon = rest.lastIndexOf(":")
  if (colon <= 0) return undefined
  const index = Number(rest.slice(colon + 1))
  if (!Number.isInteger(index) || index < 0) return undefined
  const target = parseModelItemId(`model:${rest.slice(0, colon)}`)
  return target === undefined ? undefined : { target, index }
}

export function isColdModelItemId(item: string): boolean {
  return item.startsWith(COLD_MODEL_PREFIX)
}

// A Defaults cold-list row's address item: `colddefault:<key or *>:<index>`.
export const COLD_DEFAULT_PREFIX = "colddefault:"

export function coldDefaultItemId(key: ModelSettingsKey, index: number): string {
  return `${COLD_DEFAULT_PREFIX}${modelDefaultItemId(key).slice(MODEL_DEFAULT_PREFIX.length)}:${index}`
}

export function parseColdDefaultItemId(
  item: string,
): { readonly key: ModelSettingsKey; readonly index: number } | undefined {
  if (!item.startsWith(COLD_DEFAULT_PREFIX)) return undefined
  const rest = item.slice(COLD_DEFAULT_PREFIX.length)
  const colon = rest.lastIndexOf(":")
  if (colon <= 0) return undefined
  const index = Number(rest.slice(colon + 1))
  if (!Number.isInteger(index) || index < 0) return undefined
  const key = parseModelDefaultItemId(`${MODEL_DEFAULT_PREFIX}${rest.slice(0, colon)}`)
  return key === undefined ? undefined : { key, index }
}

export function isColdDefaultItemId(item: string): boolean {
  return item.startsWith(COLD_DEFAULT_PREFIX)
}

/** One cold-cache list row's summary: its position in try order. */
export function coldListValue(index: number, model: string): string {
  return `${index + 1} ${model}`
}

/** The cold-cache group's one-line summary: its models in try order. */
export function coldCompactSummary(models: readonly string[]): string {
  if (models.length === 0) return "none · a adds one"
  return models.join(" → ")
}

/** The cache lifetime the monitor assumes for a model row's provider and model; undefined for Every model or when unknown. */
export function cacheLifetimeOf(key: ModelSettingsKey): number | undefined {
  if (key.providerID === undefined || key.modelID === undefined) return undefined
  return cacheLifetime({ provider: key.providerID, model: key.modelID })
}

/** Ping every's dropdown values: the times below the cache lifetime. An unknown lifetime gets the 5m list. */
export function pingChoices(lifetime: number | undefined): readonly string[] {
  if (lifetime !== undefined && lifetime >= 3_600_000) return ["10m", "20m", "30m", "45m", "55m"]
  if (lifetime !== undefined && lifetime >= 1_800_000) return ["5m", "10m", "15m", "20m", "25m"]
  return ["1m", "2m", "3m", "4m", "4m30s"]
}

/** Warming's fixed totals; Custom… types any other time from 1m to 24h. */
export const WARMING_TIMES: readonly string[] = ["15m", "30m", "45m", "1h", "1h30m", "2h", "4h", "8h"]

/** The dropdown value that opens the one-line prompt; no time or variant is spelled this way. */
export const CUSTOM_CHOICE = "custom…"

export interface ModelFieldChoice {
  readonly title: string
  /** "" inherits (clears the field); CUSTOM_CHOICE asks for text. */
  readonly value: string
  readonly description?: string
}

/**
 * The dropdown for a Warming, Ping every or Effort field on any model row:
 * Inherit (clears), the fixed values, and Custom… for the prompt. `now` is
 * the value Inherit falls back to; `variants` are the model's own variants.
 */
export function modelFieldChoices(
  field: "warming" | "interval" | "effort",
  input: { readonly now: string; readonly lifetime?: number; readonly variants?: readonly string[]; readonly everyModel: boolean },
): ModelFieldChoice[] {
  if (field === "warming")
    return [
      { title: "Inherit", value: "" },
      { title: "Off", value: "off" },
      { title: "On", value: "on", description: "keeps the time below" },
      ...WARMING_TIMES.map((time) => ({ title: time, value: time })),
      { title: "Custom…", value: CUSTOM_CHOICE },
    ]
  if (field === "interval")
    return [
      { title: `Inherit (now ${input.now})`, value: "" },
      ...pingChoices(input.lifetime).map((time) => ({ title: time, value: time })),
      { title: "Custom…", value: CUSTOM_CHOICE },
    ]
  return [
    { title: "(inherit / none)", value: "", description: "No variant of its own" },
    ...(input.variants ?? []).toSorted().map((variant) => ({ title: variant, value: variant })),
    ...(input.everyModel ? [{ title: "Custom…", value: CUSTOM_CHOICE }] : []),
  ]
}

/**
 * The dropdown for an Images field on any model row: Inherit (clears; `now` is what it falls back to), the choices
 * with what each does, and for the size Custom… to type one.
 */
export function imageFieldChoices(field: ImageField, now: string): ModelFieldChoice[] {
  return [
    { title: now.length === 0 ? "Inherit" : `Inherit (now ${now})`, value: "" },
    ...choicesOf(field).map((choice) => ({ title: choice.title, value: choice.value, description: choice.description })),
    ...(field === "imageShrink" ? [{ title: "Custom…", value: CUSTOM_CHOICE, description: "Your own size, e.g. for a self-hosted model." }] : []),
  ]
}
