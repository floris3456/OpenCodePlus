import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import type { Boundary } from "./sections.js"
import type { CustomizationRecord, Level, SplitRecord } from "./model.js"
import { globalRecordsPath, projectRecordsPath } from "./paths.js"

export type { CustomizationRecord, SplitRecord }
export type StoredRecord = CustomizationRecord | SplitRecord
export type RecordState = "on" | "off"

export type { Level }

export interface Loaded {
  readonly revision: number
  readonly records: readonly StoredRecord[]
  readonly migrated: boolean
}

export interface SaveInput {
  readonly expectedRevision: number
  readonly records: readonly StoredRecord[]
}

export interface SaveSuccess {
  readonly ok: true
  readonly revision: number
}

export interface SaveStale {
  readonly ok: false
  readonly reason: "stale"
  readonly current: Loaded
}

export type SaveResult = SaveSuccess | SaveStale

const VERSION = 2

const LevelSchema = Schema.Union([Schema.Literal("defaults"), Schema.Literal("global"), Schema.Literal("project")])

const BoundarySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  start: Schema.Number,
})

const V2Customization = Schema.Struct({
  type: Schema.Literal("customization"),
  level: LevelSchema,
  agent: Schema.Union([Schema.String, Schema.Null]),
  item: Schema.String,
  section: Schema.Union([Schema.String, Schema.Null]),
  text: Schema.optional(Schema.String),
  state: Schema.optional(Schema.Union([Schema.Literal("on"), Schema.Literal("off")])),
  basedOn: Schema.String,
  basedOnText: Schema.optional(Schema.String),
  acknowledged: Schema.optional(Schema.String),
  updated: Schema.String,
})

const V2Split = Schema.Struct({
  type: Schema.Literal("split"),
  level: LevelSchema,
  agent: Schema.Union([Schema.String, Schema.Null]),
  item: Schema.String,
  boundaries: Schema.Array(BoundarySchema),
  updated: Schema.String,
})

const V2Record = Schema.Union([V2Customization, V2Split])

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

const gates = new Map<string, Promise<void>>()

export async function load(projectDir: string): Promise<Loaded> {
  const project = await readFile(projectRecordsPath(projectDir))
  const global = await readFile(globalRecordsPath())
  const projectParsed = parseFile(project)
  const globalParsed = parseFile(global)
  if (!projectParsed.migrated && !globalParsed.migrated) return combine(projectParsed, globalParsed)
  // A v1 project file may hold defaults-level records (old `agent: "*"` rows);
  // those route into the global store, not the project file.
  const routed = route(projectParsed.records.concat(globalParsed.records))
  return {
    revision: Math.max(projectParsed.revision, globalParsed.revision),
    records: routed.project.concat(routed.global),
    migrated: true,
  }
}

export async function save(projectDir: string, input: SaveInput): Promise<SaveResult> {
  return withLock(projectDir, () => write(projectDir, input))
}

async function write(projectDir: string, input: SaveInput): Promise<SaveResult> {
  const current = await load(projectDir)
  if (input.expectedRevision !== current.revision) return { ok: false, reason: "stale", current }
  // An unchanged save is a no-op — except after a migrating load, when the
  // first save must write v2 to both stores so no v1 file is left in use.
  if (!current.migrated && same(current.records, input.records)) return { ok: true, revision: current.revision }
  const next = current.revision + 1
  const routed = route(input.records)
  await writeStore(projectRecordsPath(projectDir), next, routed.project)
  await writeStore(globalRecordsPath(), next, routed.global)
  return { ok: true, revision: next }
}

async function writeStore(target: string, revision: number, records: readonly StoredRecord[]): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, serialize(revision, records))
}

async function withLock<T>(directory: string, task: () => Promise<T>): Promise<T> {
  const key = path.resolve(directory)
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

function combine(project: Loaded, global: Loaded): Loaded {
  return {
    revision: Math.max(project.revision, global.revision),
    records: [...project.records, ...global.records],
    migrated: false,
  }
}

function route(records: readonly StoredRecord[]): { project: StoredRecord[]; global: StoredRecord[] } {
  const project = records.filter((record) => record.level === "project")
  const global = records.filter((record) => record.level !== "project")
  return { project: canonical(project), global: canonical(global) }
}

function parseFile(text: string | undefined): Loaded {
  if (text === undefined) return { revision: 0, records: [], migrated: false }
  const lines = text.split("\n").filter((line) => line.trim().length > 0)
  if (lines.length === 0) return { revision: 0, records: [], migrated: false }
  const v2 = Option.getOrUndefined(decodeV2Header(lines[0]))
  if (v2 !== undefined) return { revision: v2.revision, records: parseV2(lines.slice(1)), migrated: false }
  // Any header without "version" is v1 and must be migrated; never write v1 again.
  const v1 = Option.getOrUndefined(decodeV1Header(lines[0]))
  return { revision: v1?.revision ?? 0, records: lines.slice(1).flatMap(migrateLine), migrated: true }
}

function parseV2(lines: string[]): StoredRecord[] {
  return lines.flatMap((line): StoredRecord[] => {
    const record = Option.getOrUndefined(decodeV2Record(line))
    if (record === undefined) return []
    if (record.type === "split")
      return [
        {
          type: "split",
          level: record.level,
          agent: record.agent,
          item: record.item,
          boundaries: record.boundaries.map((boundary): Boundary => ({ ...boundary })),
          updated: record.updated,
        },
      ]
    return [
      {
        type: "customization",
        level: record.level,
        agent: record.agent,
        item: record.item,
        section: record.section,
        ...(record.text === undefined ? {} : { text: record.text }),
        ...(record.state === undefined ? {} : { state: record.state }),
        basedOn: record.basedOn,
        ...(record.basedOnText === undefined ? {} : { basedOnText: record.basedOnText }),
        ...(record.acknowledged === undefined ? {} : { acknowledged: record.acknowledged }),
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

function canonical(records: readonly StoredRecord[]): StoredRecord[] {
  return [...records].sort(compareRecords)
}

function compareRecords(left: StoredRecord, right: StoredRecord): number {
  const order = [left.type, right.type]
  if (order[0] !== order[1]) return order[0] < order[1] ? -1 : 1
  if (left.item !== right.item) return left.item < right.item ? -1 : 1
  if (String(left.agent) !== String(right.agent)) return String(left.agent) < String(right.agent) ? -1 : 1
  if (left.level !== right.level) return left.level < right.level ? -1 : 1
  const leftSection = left.type === "customization" ? String(left.section) : ""
  const rightSection = right.type === "customization" ? String(right.section) : ""
  if (leftSection !== rightSection) return leftSection < rightSection ? -1 : 1
  return 0
}

function stable(record: StoredRecord): StoredRecord {
  if (record.type === "split")
    return {
      type: "split",
      level: record.level,
      agent: record.agent,
      item: record.item,
      boundaries: record.boundaries.map((boundary) => ({ id: boundary.id, name: boundary.name, start: boundary.start })),
      updated: record.updated,
    }
  return {
    type: "customization",
    level: record.level,
    agent: record.agent,
    item: record.item,
    section: record.section,
    ...(record.text === undefined ? {} : { text: record.text }),
    ...(record.state === undefined ? {} : { state: record.state }),
    basedOn: record.basedOn,
    ...(record.basedOnText === undefined ? {} : { basedOnText: record.basedOnText }),
    ...(record.acknowledged === undefined ? {} : { acknowledged: record.acknowledged }),
    updated: record.updated,
  }
}

async function readFile(target: string): Promise<string | undefined> {
  const file = Bun.file(target)
  if (!(await file.exists())) return undefined
  return file.text()
}
