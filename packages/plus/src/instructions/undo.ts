import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { Actor, type Plus } from "../rpc.js"
import { contentOf, recordIdentity, recordTarget } from "./delta.js"
import { globalLogPath, projectLogPath } from "./paths.js"
import type { StoredRecord } from "./store.js"

// What `undo` takes back: for every store write that changed records, the
// records it changed as they were before and after, beside that store's change
// log (`undo.jsonl`, appended like the log, never rewritten). One call writes
// one entry per store it changed, both with the log entry's ts, so undo of a
// ts takes back the whole call.
export interface UndoEntry {
  readonly ts: string
  readonly store: "project" | "global"
  readonly revision: number
  readonly actor: Plus.Actor
  readonly summary: string
  readonly before: readonly StoredRecord[]
  readonly after: readonly StoredRecord[]
}

const UndoLine = Schema.Struct({
  ts: Schema.String,
  store: Schema.Literals(["project", "global"]),
  revision: Schema.Number,
  actor: Actor,
  summary: Schema.String,
  before: Schema.Array(Schema.Unknown),
  after: Schema.Array(Schema.Unknown),
})
const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(UndoLine))

export function undoPath(directory: string, store: "project" | "global"): string {
  return path.join(path.dirname(store === "project" ? projectLogPath(directory) : globalLogPath()), "undo.jsonl")
}

/** The records a write changed in one store (delta is deltaRows of the write), before and after; undefined when it changed none there. */
export function changedSides(
  before: readonly StoredRecord[],
  after: readonly StoredRecord[],
  delta: readonly StoredRecord[],
  store: "project" | "global",
): { before: StoredRecord[]; after: StoredRecord[] } | undefined {
  const inStore = (record: StoredRecord) => (record.level === "project") === (store === "project")
  const changed = new Set(delta.filter(inStore).map(recordIdentity))
  if (changed.size === 0) return undefined
  const pick = (records: readonly StoredRecord[]) => records.filter((record) => inStore(record) && changed.has(recordIdentity(record)))
  return { before: pick(before), after: pick(after) }
}

export async function appendUndo(directory: string, entry: UndoEntry): Promise<void> {
  const file = undoPath(directory, entry.store)
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.appendFile(file, `${JSON.stringify(entry)}\n`)
}

/** Both stores' entries, oldest first. */
export async function readUndo(directory: string): Promise<UndoEntry[]> {
  const read = async (store: "project" | "global") => {
    const file = Bun.file(undoPath(directory, store))
    if (!(await file.exists())) return []
    return (await file.text()).split("\n").flatMap((line) => {
      const entry = Option.getOrUndefined(decodeLine(line))
      // appendUndo wrote these records from the store's own StoredRecords.
      return entry === undefined ? [] : [{ ...entry, before: entry.before as StoredRecord[], after: entry.after as StoredRecord[] }]
    })
  }
  return [...(await read("project")), ...(await read("global"))].toSorted((left, right) => Date.parse(left.ts) - Date.parse(right.ts))
}

export interface UndoPlan {
  readonly records: StoredRecord[]
  readonly undone: string[]
  readonly kept: { readonly id: string; readonly reason: string }[]
}

// Each row the entries changed goes back to its value before them when it
// still holds the value they wrote; a row changed again since keeps that later
// value and is named with the write that changed it.
export function planUndo(current: readonly StoredRecord[], entries: readonly UndoEntry[], later: readonly UndoEntry[]): UndoPlan {
  const kept: { id: string; reason: string }[] = []
  const undone: string[] = []
  const restore = new Map<string, readonly StoredRecord[]>()
  const group = (records: readonly StoredRecord[], key: string) => records.filter((record) => recordIdentity(record) === key)
  const same = (left: readonly StoredRecord[], right: readonly StoredRecord[]) =>
    left.map(contentOf).toSorted().join("\n") === right.map(contentOf).toSorted().join("\n")
  for (const entry of entries) {
    for (const key of new Set([...entry.before, ...entry.after].map(recordIdentity))) {
      const name = recordTarget([...entry.after, ...entry.before].find((record) => recordIdentity(record) === key)!)
      if (!same(group(current, key), group(entry.after, key))) {
        const by = later.findLast((other) => [...other.after, ...other.before].some((record) => recordIdentity(record) === key))
        kept.push({ id: name, reason: by === undefined ? "changed again since (by a write without undo data)" : `changed again at ${by.ts} by ${actorLabel(by.actor)} (${by.summary})` })
        continue
      }
      restore.set(key, group(entry.before, key))
      undone.push(name)
    }
  }
  const records = [...current.filter((record) => !restore.has(recordIdentity(record))), ...[...restore.values()].flat()]
  return { records, undone, kept }
}

function actorLabel(actor: Plus.Actor): string {
  return actor.agent === undefined ? actor.type : `${actor.type} ${actor.agent}`
}
