import { ConfigWarming } from "@opencode/schema/config/warming"
import { Duration, Option, Schema } from "effect"
import {
  formatDuration,
  formatWarming,
  parseInterval,
  parsePrompt,
  parseWarming,
  WARMING_MAX_MS,
  type Level,
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

export interface ModelSettingsRecord {
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

/** Set fields on a Defaults › Models row (null clears one); a row left with no field is removed. */
export function setModelSettingsRecord(
  records: readonly ModelSettingsRecord[],
  key: ModelSettingsKey,
  fields: { readonly [field in ModelSettingsField]?: string | null },
  updated: string,
): ModelSettingsRecord[] {
  const current = settingsFor(records, key)
  const values = Object.fromEntries(
    MODEL_SETTINGS_FIELDS.flatMap((field) => {
      const next = fields[field] === undefined ? current?.[field] : fields[field]
      return next === undefined || next === null ? [] : [[field, next]]
    }),
  )
  const rest = records.filter((record) => !sameSettingsKey(record, key))
  if (Object.keys(values).length === 0) return rest
  const unchanged = current !== undefined && MODEL_SETTINGS_FIELDS.every((field) => current[field] === values[field])
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

/** Where one layer's value shows in a compact row summary. */
function sourceWord(from: SettingFrom): string {
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
 * Every Defaults › Models row: "Every model" is implicit; the rest are the
 * models Plus knows from stored records, agent models, and opencode.json
 * warming, sorted by provider/model.
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
  for (const host of input.hostModels) if (host.warming !== undefined) add(host.providerID, host.modelID)
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

export function modelSettingItemId(key: ModelSettingsKey, field: ModelSettingsField): string {
  return `${MODEL_SETTING_PREFIX}${field}:${modelDefaultItemId(key).slice(MODEL_DEFAULT_PREFIX.length)}`
}

export function modelSettingRowId(key: ModelSettingsKey, field: ModelSettingsField): string {
  return `item:defaults:${MODELS_OWNER}:${modelSettingItemId(key, field)}`
}

export function parseModelSettingItemId(
  item: string,
): { readonly key: ModelSettingsKey; readonly field: ModelSettingsField } | undefined {
  if (!item.startsWith(MODEL_SETTING_PREFIX)) return undefined
  const rest = item.slice(MODEL_SETTING_PREFIX.length)
  const colon = rest.indexOf(":")
  const field = MODEL_SETTINGS_FIELDS.find((entry) => entry === rest.slice(0, colon))
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

export const MODEL_SETTING_LABELS: Record<ModelSettingsField, string> = {
  warming: "Warming",
  interval: "Ping every",
  prompt: "Keep-alive prompt",
  effort: "Effort",
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
