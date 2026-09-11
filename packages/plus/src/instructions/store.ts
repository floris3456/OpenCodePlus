import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import type { Customization } from "./model.js"

export interface Stored {
  revision: number
  customizations: Customization[]
}

export interface SaveInput {
  expectedRevision: number
  customizations: Customization[]
}

export interface SaveSuccess {
  ok: true
  revision: number
}

export interface SaveStale {
  ok: false
  reason: "stale"
  current: Stored
}

export type SaveResult = SaveSuccess | SaveStale

const CustomizationRecord = Schema.Struct({
  item: Schema.String,
  agent: Schema.String,
  text: Schema.optional(Schema.String),
  state: Schema.Union([Schema.Literal("inherit"), Schema.Literal("enabled"), Schema.Literal("disabled")]),
  basedOn: Schema.String,
  reviewed: Schema.optional(Schema.String),
  updated: Schema.String,
})

const RevisionHeader = Schema.Struct({
  revision: Schema.Number,
})

const decodeCustomization = Schema.decodeUnknownOption(Schema.fromJsonString(CustomizationRecord))
const decodeRevisionHeader = Schema.decodeUnknownOption(Schema.fromJsonString(RevisionHeader))

const gates = new Map<string, Promise<void>>()

export async function load(directory: string): Promise<Stored> {
  const file = Bun.file(recordsPath(directory))
  const exists = await file.exists()
  if (!exists) return { revision: 0, customizations: [] }
  return parse(await file.text())
}

export async function save(directory: string, input: SaveInput): Promise<SaveResult> {
  return withLock(directory, () => write(directory, input))
}

async function write(directory: string, input: SaveInput): Promise<SaveResult> {
  const current = await load(directory)
  if (input.expectedRevision !== current.revision) return { ok: false, reason: "stale", current }
  if (same(current.customizations, input.customizations)) return { ok: true, revision: current.revision }
  const revision = current.revision + 1
  const target = recordsPath(directory)
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, serialize(revision, input.customizations))
  return { ok: true, revision }
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

function recordsPath(directory: string): string {
  return path.join(directory, ".opencodeplus", "instructions", "records.jsonl")
}

function parse(text: string): Stored {
  const lines = text.split("\n").filter((line) => line.trim().length > 0)
  if (lines.length === 0) return { revision: 0, customizations: [] }
  const header = Option.getOrUndefined(decodeRevisionHeader(lines[0]))
  return { revision: header?.revision ?? 0, customizations: parseCustomizations(lines.slice(1)) }
}

function parseCustomizations(lines: string[]): Customization[] {
  return lines
    .map((line): Customization | undefined => Option.getOrUndefined(decodeCustomization(line)))
    .filter((record): record is Customization => record !== undefined)
}

function serialize(revision: number, customizations: Customization[]): string {
  const lines = canonical(customizations).map((record) => JSON.stringify(record))
  return [JSON.stringify({ revision }), ...lines].join("\n") + "\n"
}

function same(left: Customization[], right: Customization[]): boolean {
  return JSON.stringify(canonical(left)) === JSON.stringify(canonical(right))
}

function canonical(customizations: Customization[]): Customization[] {
  return customizations
    .map((record) => ({
      item: record.item,
      agent: record.agent,
      text: record.text,
      state: record.state,
      basedOn: record.basedOn,
      reviewed: record.reviewed,
      updated: record.updated,
    }))
    .sort(compareRecords)
}

function compareRecords(left: Customization, right: Customization): number {
  if (left.item !== right.item) return left.item < right.item ? -1 : 1
  if (left.agent !== right.agent) return left.agent < right.agent ? -1 : 1
  return 0
}
