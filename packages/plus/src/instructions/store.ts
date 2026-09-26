import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import type { Boundary } from "./sections.js"
import type {
  Catalogue,
  CustomizationRecord,
  EntryRecord,
  Level,
  LinkRecord,
  ModelRecord,
  PresetRecord,
  PresetRef,
  RuleRecord,
  SplitRecord,
} from "./model.js"
import type { TeamRecord } from "./teams.js"
import { globalRecordsPath, linkedProjectsPath, projectRecordsPath } from "./paths.js"

export type { CustomizationRecord, SplitRecord }
export type { ModelRecord, RuleRecord }
export type { TeamRecord }
export type { EntryRecord, LinkRecord, PresetRecord }
export type StoredRecord =
  | CustomizationRecord
  | SplitRecord
  | TeamRecord
  | ModelRecord
  | RuleRecord
  | LinkRecord
  | EntryRecord
  | PresetRecord
export type RecordState = "on" | "off"

export type { Level }

export interface Loaded {
  readonly projectRevision: number
  readonly globalRevision: number
  readonly records: readonly StoredRecord[]
  readonly migrated: boolean
  /** True when this load duplicated pre-split shared rows into the Teams catalogue. */
  readonly cataloguesMigrated: boolean
}

export interface SaveInput {
  readonly expectedProjectRevision: number
  readonly expectedGlobalRevision: number
  readonly records: readonly StoredRecord[]
}

export interface SaveSuccess {
  readonly ok: true
  readonly projectRevision: number
  readonly globalRevision: number
  // Which stores the write actually moved. An unchanged save moves neither
  // and touches no file; callers use this to log one line per changed store.
  readonly changed: { readonly project: boolean; readonly global: boolean }
}

export interface SaveStale {
  readonly ok: false
  readonly reason: "stale"
  readonly store: "project" | "global"
  readonly current: Loaded
}

export type SaveResult = SaveSuccess | SaveStale

const VERSION = 2

const LevelSchema = Schema.Union([
  Schema.Literal("defaults"),
  Schema.Literal("global"),
  Schema.Literal("project"),
  Schema.Literal("preset"),
])

const V2TeamRef = Schema.Struct({
  level: LevelSchema,
  team: Schema.String,
})

// Shared-inventory rows only. Absent means the Agents catalogue, so every
// record written before the catalogue split keeps its exact bytes and meaning.
const CatalogueSchema = Schema.Union([Schema.Literal("agents"), Schema.Literal("teams")])

const BoundarySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  start: Schema.Number,
})

const V2Customization = Schema.Struct({
  type: Schema.Literal("customization"),
  level: LevelSchema,
  agent: Schema.Union([Schema.String, Schema.Null]),
  team: Schema.optional(V2TeamRef),
  catalogue: Schema.optional(CatalogueSchema),
  item: Schema.String,
  section: Schema.Union([Schema.String, Schema.Null]),
  text: Schema.optional(Schema.String),
  state: Schema.optional(Schema.Union([Schema.Literal("on"), Schema.Literal("off")])),
  pin: Schema.optional(Schema.Boolean),
  basedOn: Schema.String,
  basedOnText: Schema.optional(Schema.String),
  acknowledged: Schema.optional(Schema.String),
  basedOnState: Schema.optional(Schema.Union([Schema.Literal("on"), Schema.Literal("off")])),
  basedOnPin: Schema.optional(Schema.Boolean),
  updated: Schema.String,
})

const V2Split = Schema.Struct({
  type: Schema.Literal("split"),
  level: LevelSchema,
  agent: Schema.Union([Schema.String, Schema.Null]),
  team: Schema.optional(V2TeamRef),
  catalogue: Schema.optional(CatalogueSchema),
  item: Schema.String,
  boundaries: Schema.Array(BoundarySchema),
  updated: Schema.String,
})

// Teams persist at all three tiers, including defaults-level enablement
// records for built-in teams; anything else (a `preset` level included: team
// presets are PresetRecords) fails validation and the line is skipped like
// any malformed record.
const V2Team = Schema.Struct({
  type: Schema.Literal("team"),
  level: Schema.Union([Schema.Literal("defaults"), Schema.Literal("global"), Schema.Literal("project")]),
  team: Schema.String,
  enabled: Schema.Boolean,
  updated: Schema.String,
})

// Per-agent model selection. `active` is `true` or omitted, never `false`:
// records cross the RPC boundary as JSON, where a present-but-undefined key
// fails validation.
const V2Model = Schema.Struct({
  type: Schema.Literal("model"),
  level: LevelSchema,
  agent: Schema.Union([Schema.String, Schema.Null]),
  team: Schema.optional(V2TeamRef),
  catalogue: Schema.optional(CatalogueSchema),
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optional(Schema.String),
  active: Schema.optional(Schema.Literal(true)),
  basedOn: Schema.optional(Schema.String),
  updated: Schema.String,
})

const V2Rule = Schema.Struct({
  type: Schema.Literal("rule"),
  level: LevelSchema,
  agent: Schema.Union([Schema.String, Schema.Null]),
  team: Schema.optional(V2TeamRef),
  catalogue: Schema.optional(CatalogueSchema),
  tool: Schema.String,
  id: Schema.String,
  label: Schema.String,
  patterns: Schema.Array(Schema.String),
  keywords: Schema.Array(Schema.String),
  message: Schema.optional(Schema.String),
  updated: Schema.String,
})

const PresetRefSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("agent"), id: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("member"), team: Schema.String, id: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("team"), id: Schema.String }),
])

// "Created from preset X" (DESIGN §7): owned by an agent, member, team,
// Defaults entry or preset at any level; routes by level like any record.
const V2Link = Schema.Struct({
  type: Schema.Literal("link"),
  level: LevelSchema,
  agent: Schema.Union([Schema.String, Schema.Null]),
  team: Schema.optional(V2TeamRef),
  catalogue: Schema.optional(CatalogueSchema),
  preset: PresetRefSchema,
  updated: Schema.String,
})

// A Defaults entry named by an exact name or a wildcard pattern: always at
// level defaults, so it lives in the global file.
const V2Entry = Schema.Struct({
  type: Schema.Literal("entry"),
  level: Schema.Literal("defaults"),
  catalogue: CatalogueSchema,
  team: Schema.optional(Schema.String),
  name: Schema.String,
  updated: Schema.String,
})

// A user preset (Native and Plus presets are code): always at level preset,
// so it lives in the global file.
const V2Preset = Schema.Struct({
  type: Schema.Literal("preset"),
  level: Schema.Literal("preset"),
  kind: Schema.Union([Schema.Literal("agent"), Schema.Literal("team")]),
  id: Schema.String,
  team: Schema.optional(Schema.String),
  fields: Schema.optional(
    Schema.Struct({
      mode: Schema.optional(Schema.String),
      description: Schema.optional(Schema.String),
    }),
  ),
  updated: Schema.String,
})

const V2Record = Schema.Union([V2Customization, V2Split, V2Team, V2Model, V2Rule, V2Link, V2Entry, V2Preset])

const V2Header = Schema.Struct({
  version: Schema.Literal(2),
  revision: Schema.Number,
})

const V1Header = Schema.Struct({
  revision: Schema.Number,
})

// v1 records: { item, agent, text?, state, basedOn, reviewed?, updated }.
// `agent === "*"` meant the shared row; state was enabled|disabled|inherit.
const V1Record = Schema.Struct({
  item: Schema.String,
  agent: Schema.String,
  text: Schema.optional(Schema.String),
  state: Schema.Union([Schema.Literal("inherit"), Schema.Literal("enabled"), Schema.Literal("disabled")]),
  basedOn: Schema.String,
  reviewed: Schema.optional(Schema.String),
  updated: Schema.String,
})

const decodeV2Record = Schema.decodeUnknownOption(Schema.fromJsonString(V2Record))
const decodeV2Header = Schema.decodeUnknownOption(Schema.fromJsonString(V2Header))
const decodeV1Header = Schema.decodeUnknownOption(Schema.fromJsonString(V1Header))
const decodeV1Record = Schema.decodeUnknownOption(Schema.fromJsonString(V1Record))

export type StaleStore = "project" | "global"

const gates = new Map<string, Promise<void>>()

interface ParsedFile {
  readonly revision: number
  readonly records: readonly StoredRecord[]
  readonly migrated: boolean
}

export async function load(projectDir: string): Promise<Loaded> {
  const project = await readFile(projectRecordsPath(projectDir))
  const global = await readFile(globalRecordsPath())
  const projectParsed = parseFile(project)
  const globalParsed = parseFile(global)
  if (!projectParsed.migrated && !globalParsed.migrated) {
    const catalogues = migrateCatalogues([...projectParsed.records, ...globalParsed.records])
    return {
      projectRevision: projectParsed.revision,
      globalRevision: globalParsed.revision,
      records: catalogues.records,
      migrated: false,
      cataloguesMigrated: catalogues.migrated,
    }
  }
  // A v1 project file may hold defaults-level records (old `agent: "*"` rows);
  // those route into the global store, not the project file.
  const catalogues = migrateCatalogues(projectParsed.records.concat(globalParsed.records))
  const routed = route(catalogues.records)
  return {
    projectRevision: projectParsed.revision,
    globalRevision: globalParsed.revision,
    records: routed.project.concat(routed.global),
    migrated: true,
    cataloguesMigrated: catalogues.migrated,
  }
}

// The catalogue split: before it there was one shared "everyone" inventory at
// `{ level: "defaults", agent: null }`, and every agent — stand-alone or team
// member — resolved through it. After it there are two, and a team member
// reads only the Teams one. So a store with no catalogue anywhere is a
// pre-split store: copy each shared row into the Teams catalogue so everything
// that applied to everyone still applies to everyone.
//
// Idempotent by construction: the copies carry `catalogue: "teams"`, so the
// "no record carries a catalogue" test is false on every later load, and a
// store that already holds a Teams copy is returned untouched.
export function migrateCatalogues(records: readonly StoredRecord[]): {
  records: StoredRecord[]
  migrated: boolean
} {
  const shared = records.filter(isSharedDefaults)
  if (shared.length === 0) return { records: [...records], migrated: false }
  if (records.some((record) => isInventory(record) && record.catalogue !== undefined))
    return { records: [...records], migrated: false }
  return { records: [...records, ...shared.map((record) => ({ ...record, catalogue: "teams" as Catalogue }))], migrated: true }
}

// The record kinds the catalogue split applies to. Teams, links, Defaults
// entries and presets are not inventory rows and never take part in it.
type InventoryRecord = CustomizationRecord | SplitRecord | ModelRecord | RuleRecord

function isInventory(record: StoredRecord): record is InventoryRecord {
  return record.type === "customization" || record.type === "split" || record.type === "model" || record.type === "rule"
}

function isSharedDefaults(record: StoredRecord): record is InventoryRecord {
  if (!isInventory(record)) return false
  return record.level === "defaults" && record.agent === null && record.team === undefined
}

export async function save(projectDir: string, input: SaveInput): Promise<SaveResult> {
  // Fixed order (global then project) so two projects saving concurrently
  // cannot interleave: each save holds both gates across read+write.
  return withLock(globalGateKey(), () => withLock(projectGateKey(projectDir), () => write(projectDir, input)))
}

/**
 * Load, decide and save as one step under both write gates, so what `change`
 * checks — including other projects' stores and the linked-projects index,
 * which every in-process save writes under the same global gate — cannot
 * change between the check and the commit. `change` answers its result and,
 * to write, the next record list; without `records` nothing is written.
 * It runs inside the gates, so it must not call `save` or another gated
 * write; `gate.forget` drops index entries in place.
 */
export async function updateGated<T>(
  projectDir: string,
  change: (
    loaded: Loaded,
    gate: { forget: (projectDirs: readonly string[]) => Promise<void> },
  ) => Promise<{ readonly result: T; readonly records?: readonly StoredRecord[] }>,
): Promise<{ result: T; saved: SaveResult | undefined }> {
  return withLock(globalGateKey(), () =>
    withLock(projectGateKey(projectDir), async () => {
      const loaded = await load(projectDir)
      const decided = await change(loaded, { forget: dropLinkedProjects })
      if (decided.records === undefined) return { result: decided.result, saved: undefined }
      const saved = await write(projectDir, {
        expectedProjectRevision: loaded.projectRevision,
        expectedGlobalRevision: loaded.globalRevision,
        records: decided.records,
      })
      return { result: decided.result, saved }
    }),
  )
}

// Persist the catalogue duplication once, on the first load that sees a
// pre-split store, so the copies land in one revision the log can name. A
// store that needs nothing is read and left alone; a concurrent writer that
// wins the revision race simply migrates on its own next load.
export async function ensureCatalogues(
  projectDir: string,
): Promise<{ migrated: boolean; loaded: Loaded; revision: number }> {
  const current = await load(projectDir)
  if (!current.cataloguesMigrated) return { migrated: false, loaded: current, revision: current.globalRevision }
  const saved = await save(projectDir, {
    expectedProjectRevision: current.projectRevision,
    expectedGlobalRevision: current.globalRevision,
    records: current.records,
  })
  if (!saved.ok) return { migrated: false, loaded: saved.current, revision: saved.current.globalRevision }
  return { migrated: true, loaded: await load(projectDir), revision: saved.globalRevision }
}

async function write(projectDir: string, input: SaveInput): Promise<SaveResult> {
  const current = await load(projectDir)
  const projectStale = input.expectedProjectRevision !== current.projectRevision
  const globalStale = input.expectedGlobalRevision !== current.globalRevision
  if (projectStale || globalStale)
    return { ok: false, reason: "stale", store: projectStale ? "project" : "global", current }
  const routed = route(input.records)
  // A migrating load reroutes v1 rows across stores, so the first save must
  // write v2 to both stores even when the rerouted records already match. The
  // catalogue duplication is the same situation: both sides of `same` are
  // already migrated, so only this flag makes the copies reach disk.
  const forced = current.migrated || current.cataloguesMigrated
  const projectChanged = forced || !same(currentProjectRecords(current.records), routed.project)
  const globalChanged = forced || !same(currentGlobalRecords(current.records), routed.global)
  // An unchanged save is a no-op: neither file is touched, neither revision moves.
  if (!projectChanged && !globalChanged)
    return {
      ok: true,
      projectRevision: current.projectRevision,
      globalRevision: current.globalRevision,
      changed: { project: false, global: false },
    }
  const nextProject = projectChanged ? current.projectRevision + 1 : current.projectRevision
  const nextGlobal = globalChanged ? current.globalRevision + 1 : current.globalRevision
  if (projectChanged) await writeStore(projectRecordsPath(projectDir), nextProject, routed.project)
  if (globalChanged) await writeStore(globalRecordsPath(), nextGlobal, routed.global)
  if (projectChanged) await indexProjectLinks(projectDir, routed.project.some((record) => record.type === "link"))
  return {
    ok: true,
    projectRevision: nextProject,
    globalRevision: nextGlobal,
    changed: { project: projectChanged, global: globalChanged },
  }
}

// The global index of projects whose store holds a link (paths.ts
// linkedProjectsPath). Every save that writes a project store keeps it
// current under the global gate `save` holds. A listed project is only a
// place to look: its own store is the truth, so an entry for a project that
// moved, was deleted or dropped its links never answers for it (see
// projectLinks) and is forgotten by the next preset deletion.
const LinkedProjects = Schema.Struct({ version: Schema.Literal(1), projects: Schema.Array(Schema.String) })
const decodeLinkedProjects = Schema.decodeUnknownOption(Schema.fromJsonString(LinkedProjects))

/** Every project directory the index lists (absolute). */
export async function linkedProjects(): Promise<string[]> {
  const text = await readFile(linkedProjectsPath())
  if (text === undefined) return []
  return [...(Option.getOrUndefined(decodeLinkedProjects(text))?.projects ?? [])]
}

/** The project-level links a project's own store holds; undefined when it has no store (moved or deleted). */
export async function projectLinks(projectDir: string): Promise<LinkRecord[] | undefined> {
  const text = await readFile(projectRecordsPath(projectDir))
  if (text === undefined) return undefined
  return parseFile(text).records.filter((record): record is LinkRecord => record.type === "link" && record.level === "project")
}

// Drop projects from the index (entries that no longer answer). The caller
// holds the global gate (updateGated's `gate.forget`).
async function dropLinkedProjects(projectDirs: readonly string[]): Promise<void> {
  if (projectDirs.length === 0) return
  const drop = new Set(projectDirs.map((dir) => path.resolve(dir)))
  await writeLinkedProjects((await linkedProjects()).filter((dir) => !drop.has(dir)))
}

async function indexProjectLinks(projectDir: string, linked: boolean): Promise<void> {
  const directory = path.resolve(projectDir)
  const listed = await linkedProjects()
  if (listed.includes(directory) === linked) return
  await writeLinkedProjects(linked ? [...listed, directory].toSorted() : listed.filter((dir) => dir !== directory))
}

async function writeLinkedProjects(projects: readonly string[]): Promise<void> {
  const target = linkedProjectsPath()
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, `${JSON.stringify({ version: 1, projects })}\n`)
}

async function writeStore(target: string, revision: number, records: readonly StoredRecord[]): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, serialize(revision, records))
}

function globalGateKey(): string {
  return `global:${path.resolve(globalRecordsPath())}`
}

function projectGateKey(projectDir: string): string {
  return `project:${path.resolve(projectDir)}`
}

function currentProjectRecords(records: readonly StoredRecord[]): StoredRecord[] {
  return records.filter((record) => record.level === "project")
}

function currentGlobalRecords(records: readonly StoredRecord[]): StoredRecord[] {
  return records.filter((record) => record.level !== "project")
}

async function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = gates.get(key) ?? Promise.resolve()
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const entry = previous.then(() => gate)
  gates.set(key, entry)
  await previous
  try {
    return await task()
  } finally {
    release()
    if (gates.get(key) === entry) gates.delete(key)
  }
}

function parseFile(text: string | undefined): ParsedFile {
  if (text === undefined) return { revision: 0, records: [], migrated: false }
  const lines = text.split("\n").filter((line) => line.trim().length > 0)
  if (lines.length === 0) return { revision: 0, records: [], migrated: false }
  const v2 = Option.getOrUndefined(decodeV2Header(lines[0]))
  if (v2 !== undefined) return { revision: v2.revision, records: parseV2(lines.slice(1)), migrated: false }
  // Any header without "version" is v1 and must be migrated; never write v1 again.
  const v1 = Option.getOrUndefined(decodeV1Header(lines[0]))
  return { revision: v1?.revision ?? 0, records: lines.slice(1).flatMap(migrateLine), migrated: true }
}

// Teams route by level like any other record: project teams to the project
// file, global and defaults teams to the global file. No team ever lands in
// a defaults bucket: there is no defaults store file.
function route(records: readonly StoredRecord[]): { project: StoredRecord[]; global: StoredRecord[] } {
  const project = records.filter((record) => record.level === "project")
  const global = records.filter((record) => record.level !== "project")
  return { project: canonical(project), global: canonical(global) }
}

function parseV2(lines: string[]): StoredRecord[] {
  return lines.flatMap((line): StoredRecord[] => {
    const record = Option.getOrUndefined(decodeV2Record(line))
    if (record === undefined) return []
    if (record.type === "team")
      return [
        {
          type: "team",
          level: record.level,
          team: record.team,
          enabled: record.enabled,
          updated: record.updated,
        },
      ]
    if (record.type === "split")
      return [
        {
          type: "split",
          level: record.level,
          agent: record.agent,
          ...(record.team === undefined ? {} : { team: record.team }),
          ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
          item: record.item,
          boundaries: record.boundaries.map((boundary): Boundary => ({ ...boundary })),
          updated: record.updated,
        },
      ]
    if (record.type === "model")
      return [
        {
          type: "model",
          level: record.level,
          agent: record.agent,
          ...(record.team === undefined ? {} : { team: record.team }),
          ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
          providerID: record.providerID,
          modelID: record.modelID,
          ...(record.variant === undefined ? {} : { variant: record.variant }),
          ...(record.active === undefined ? {} : { active: record.active }),
          ...(record.basedOn === undefined ? {} : { basedOn: record.basedOn }),
          updated: record.updated,
        },
      ]
    if (record.type === "link" || record.type === "entry" || record.type === "preset") return [stable(record)]
    if (record.type === "rule")
      return [
        {
          type: "rule",
          level: record.level,
          agent: record.agent,
          ...(record.team === undefined ? {} : { team: record.team }),
          ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
          tool: record.tool,
          id: record.id,
          label: record.label,
          patterns: [...record.patterns],
          keywords: [...record.keywords],
          ...(record.message === undefined ? {} : { message: record.message }),
          updated: record.updated,
        },
      ]
    return [
      {
        type: "customization",
        level: record.level,
        agent: record.agent,
        ...(record.team === undefined ? {} : { team: record.team }),
        ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
        item: record.item,
        section: record.section,
        ...(record.text === undefined ? {} : { text: record.text }),
        ...(record.state === undefined ? {} : { state: record.state }),
        ...(record.pin === undefined ? {} : { pin: record.pin }),
        basedOn: record.basedOn,
        ...(record.basedOnText === undefined ? {} : { basedOnText: record.basedOnText }),
        ...(record.acknowledged === undefined ? {} : { acknowledged: record.acknowledged }),
        ...(record.basedOnState === undefined ? {} : { basedOnState: record.basedOnState }),
        ...(record.basedOnPin === undefined ? {} : { basedOnPin: record.basedOnPin }),
        updated: record.updated,
      },
    ]
  })
}

function migrateLine(line: string): StoredRecord[] {
  const record = Option.getOrUndefined(decodeV1Record(line))
  if (record === undefined) return []
  const item = migrateItem(record.item)
  if (record.agent === "*")
    return [
      {
        type: "customization",
        level: "defaults",
        agent: null,
        item,
        section: null,
        ...(record.text === undefined ? {} : { text: record.text }),
        ...(migrateState(record.state) === undefined ? {} : { state: migrateState(record.state) }),
        basedOn: record.basedOn,
        ...(record.reviewed === undefined ? {} : { acknowledged: record.reviewed }),
        updated: record.updated,
      },
    ]
  return [
    {
      type: "customization",
      level: "project",
      agent: record.agent,
      item,
      section: null,
      ...(record.text === undefined ? {} : { text: record.text }),
      ...(migrateState(record.state) === undefined ? {} : { state: migrateState(record.state) }),
      basedOn: record.basedOn,
      ...(record.reviewed === undefined ? {} : { acknowledged: record.reviewed }),
      updated: record.updated,
    },
  ]
}

function migrateItem(item: string): string {
  if (item.startsWith("prompt:")) return "system:role"
  if (item.startsWith("instruction:")) return `system:${item.slice("instruction:".length)}`
  return item
}

function migrateState(state: "inherit" | "enabled" | "disabled"): "on" | "off" | undefined {
  if (state === "enabled") return "on"
  if (state === "disabled") return "off"
  return undefined
}

function serialize(revision: number, records: readonly StoredRecord[]): string {
  const lines = canonical(records).map((record) => JSON.stringify(stable(record)))
  return [JSON.stringify({ version: VERSION, revision }), ...lines].join("\n") + "\n"
}

// Canonically ordered and stably keyed so an unchanged save is a no-op.
function same(left: readonly StoredRecord[], right: readonly StoredRecord[]): boolean {
  return JSON.stringify(canonical(left).map(stable)) === JSON.stringify(canonical(right).map(stable))
}

// Canonical order and stably keyed content for callers that diff record sets
// (the change log names added/removed/modified rows without reimplementing
// the comparison).
export function canonical(records: readonly StoredRecord[]): StoredRecord[] {
  return [...records].sort(compareRecords)
}

function compareRecords(left: StoredRecord, right: StoredRecord): number {
  const leftKey = sortKey(left)
  const rightKey = sortKey(right)
  for (let i = 0; i < leftKey.length; i++) {
    if (leftKey[i] !== rightKey[i]) return leftKey[i] < rightKey[i] ? -1 : 1
  }
  return 0
}

// Teams have no item/agent/section, so they order by team name first, then
// level; enabled and updated last keep the order total for identical keys.
// Models order by provider, model, and variant, then agent and level; rules
// order by tool and id, then agent and level. Both end with `updated` so the
// order is total and an unchanged save stays a no-op.
// Links order by owner then preset; Defaults entries by catalogue, team
// pattern and name; presets by kind, team and id. All end with `updated`.
function sortKey(record: StoredRecord): string[] {
  if (record.type === "team") return ["team", record.team, record.level, String(record.enabled), record.updated]
  if (record.type === "entry") return ["entry", record.catalogue, record.team ?? "", record.name, record.updated]
  if (record.type === "preset") return ["preset", record.kind, record.team ?? "", record.id, record.updated]
  const teamKey = record.team !== undefined ? `${record.team.level}:${record.team.team}` : ""
  const catalogueKey = record.catalogue ?? ""
  if (record.type === "link")
    return [
      "link",
      String(record.agent),
      teamKey,
      catalogueKey,
      record.level,
      record.preset.kind,
      record.preset.kind === "member" ? record.preset.team : "",
      record.preset.id,
      record.updated,
    ]
  if (record.type === "model")
    return [
      "model",
      record.providerID,
      record.modelID,
      record.variant ?? "",
      String(record.agent),
      teamKey,
      catalogueKey,
      record.level,
      record.active === true ? "active" : "",
      record.updated,
    ]
  if (record.type === "rule")
    return ["rule", record.tool, record.id, String(record.agent), teamKey, catalogueKey, record.level, record.updated]
  return [
    record.type,
    record.item,
    String(record.agent),
    teamKey,
    catalogueKey,
    record.level,
    record.type === "customization" ? String(record.section) : "",
  ]
}

export function stable(record: StoredRecord): StoredRecord {
  if (record.type === "link")
    return {
      type: "link",
      level: record.level,
      agent: record.agent,
      ...(record.team === undefined ? {} : { team: { level: record.team.level, team: record.team.team } }),
      ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
      preset: stablePreset(record.preset),
      updated: record.updated,
    }
  if (record.type === "entry")
    return {
      type: "entry",
      level: "defaults",
      catalogue: record.catalogue,
      ...(record.team === undefined ? {} : { team: record.team }),
      name: record.name,
      updated: record.updated,
    }
  if (record.type === "preset")
    return {
      type: "preset",
      level: "preset",
      kind: record.kind,
      id: record.id,
      ...(record.team === undefined ? {} : { team: record.team }),
      ...(record.fields === undefined
        ? {}
        : {
            fields: {
              ...(record.fields.mode === undefined ? {} : { mode: record.fields.mode }),
              ...(record.fields.description === undefined ? {} : { description: record.fields.description }),
            },
          }),
      updated: record.updated,
    }
  if (record.type === "team")
    return {
      type: "team",
      level: record.level,
      team: record.team,
      enabled: record.enabled,
      updated: record.updated,
    }
  if (record.type === "model")
    return {
      type: "model",
      level: record.level,
      agent: record.agent,
      ...(record.team === undefined ? {} : { team: record.team }),
      ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
      providerID: record.providerID,
      modelID: record.modelID,
      ...(record.variant === undefined ? {} : { variant: record.variant }),
      ...(record.active === undefined ? {} : { active: record.active }),
      ...(record.basedOn === undefined ? {} : { basedOn: record.basedOn }),
      updated: record.updated,
    }
  if (record.type === "rule")
    return {
      type: "rule",
      level: record.level,
      agent: record.agent,
      ...(record.team === undefined ? {} : { team: record.team }),
      ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
      tool: record.tool,
      id: record.id,
      label: record.label,
      patterns: [...record.patterns],
      keywords: [...record.keywords],
      ...(record.message === undefined ? {} : { message: record.message }),
      updated: record.updated,
    }
  if (record.type === "split")
    return {
      type: "split",
      level: record.level,
      agent: record.agent,
      ...(record.team === undefined ? {} : { team: record.team }),
      ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
      item: record.item,
      boundaries: record.boundaries.map((boundary) => ({ id: boundary.id, name: boundary.name, start: boundary.start })),
      updated: record.updated,
    }
  return {
    type: "customization",
    level: record.level,
    agent: record.agent,
    ...(record.team === undefined ? {} : { team: record.team }),
    ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
    item: record.item,
    section: record.section,
    ...(record.text === undefined ? {} : { text: record.text }),
    ...(record.state === undefined ? {} : { state: record.state }),
    ...(record.pin === undefined ? {} : { pin: record.pin }),
    basedOn: record.basedOn,
    ...(record.basedOnText === undefined ? {} : { basedOnText: record.basedOnText }),
    ...(record.acknowledged === undefined ? {} : { acknowledged: record.acknowledged }),
    ...(record.basedOnState === undefined ? {} : { basedOnState: record.basedOnState }),
    ...(record.basedOnPin === undefined ? {} : { basedOnPin: record.basedOnPin }),
    updated: record.updated,
  }
}

function stablePreset(ref: PresetRef): PresetRef {
  if (ref.kind === "member") return { kind: "member", team: ref.team, id: ref.id }
  return { kind: ref.kind, id: ref.id }
}

async function readFile(target: string): Promise<string | undefined> {
  const file = Bun.file(target)
  if (!(await file.exists())) return undefined
  return file.text()
}
