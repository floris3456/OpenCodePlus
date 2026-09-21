import { mkdir, readdir, rename, stat } from "node:fs/promises"
import type { Dirent } from "node:fs"
import { join } from "node:path"
import { Effect } from "effect"
import { Schema } from "effect"
import { toolError } from "./schema.js"
import { atomicJson, lock, readJson, ulid } from "./store.js"
import { errCode, io } from "./io.js"

export const DEFAULT_INBOX_UNREAD_BYTES = 262144

// child.settled is its own kind so a parent can tell an owned child's outcome
// from any other notify; it is synthetic like notify and system, so a parent
// reads a batch of settlements as one text.
export const InboxKind = Schema.Literals(["brief", "followup", "notify", "shutdown", "system", "child.settled"])
export type InboxKind = typeof InboxKind.Type

export const InboxItem = Schema.Struct({
  id: Schema.String,
  kind: InboxKind,
  from: Schema.String,
  text: Schema.String,
  at: Schema.Number,
})
export type InboxItem = typeof InboxItem.Type

export interface InboxBounds {
  inboxUnreadBytes?: number
}

export interface PutInboxInput {
  kind: InboxKind
  from: string
  text: string
  at?: number
  bounds?: InboxBounds
}

export interface InboxPartition {
  synthetic: InboxItem[]
  prompts: InboxItem[]
  shutdown: InboxItem[]
}

function inboxDir(root: string, runID: string): string {
  return join(root, "runs", runID, "inbox")
}

function isInboxFile(entry: Dirent): boolean {
  return entry.isFile() && !entry.name.startsWith(".") && entry.name.endsWith(".json")
}

function readInboxEntries(root: string, runID: string): Promise<Dirent[] | undefined> {
  return Effect.runPromise(
    io(() => readdir(inboxDir(root, runID), { withFileTypes: true })).pipe(
      Effect.catchIf((error) => errCode(error) === "ENOENT", () => Effect.succeed(undefined)),
    ),
  )
}

function statSize(root: string, runID: string, name: string): Promise<number> {
  return Effect.runPromise(
    io(() => stat(join(inboxDir(root, runID), name))).pipe(
      Effect.map((s) => s.size),
      Effect.catchIf((error) => errCode(error) === "ENOENT", () => Effect.succeed(0)),
    ),
  )
}

/** Total byte size of all pending (undelivered) inbox files for runID. */
export async function pendingBytes(root: string, runID: string): Promise<number> {
  const entries = await readInboxEntries(root, runID)
  if (entries === undefined) return 0
  let total = 0
  for (const entry of entries) {
    if (isInboxFile(entry)) total += await statSize(root, runID, entry.name)
  }
  return total
}

/** Writes <root>/runs/<runID>/inbox/<ulid>.json atomically under the state:<runID> lock. */
export async function put(
  root: string,
  runID: string,
  input: PutInboxInput,
  bounds?: InboxBounds | number,
): Promise<InboxItem> {
  const maxBytes =
    typeof bounds === "number" ? bounds : (bounds?.inboxUnreadBytes ?? input.bounds?.inboxUnreadBytes ?? DEFAULT_INBOX_UNREAD_BYTES)
  return lock(root, "state", runID, async () => {
    const n = await pendingBytes(root, runID)
    const id = ulid()
    const at = input.at ?? Date.now()
    const item: InboxItem = { id, kind: input.kind, from: input.from, text: input.text, at }
    const content = JSON.stringify(item, null, 2) + "\n"
    const thisBytes = Buffer.byteLength(content, "utf8")
    if (n + thisBytes > maxBytes) {
      const accepted = { maxBytes, pendingBytes: n, availableBytes: Math.max(0, maxBytes - n) }
      throw toolError(
        "E_INBOX_FULL",
        `Run ${runID} has ${n} bytes of undelivered inbox (max ${maxBytes}). Wait for it to read them, or supersede it.`,
        accepted,
      )
    }
    await atomicJson(join(inboxDir(root, runID), `${id}.json`), item)
    return item
  })
}

/** Pending inbox items for runID sorted by id (ULID -> time order). */
export async function peek(root: string, runID: string): Promise<InboxItem[]> {
  const entries = await readInboxEntries(root, runID)
  if (entries === undefined) return []
  const files = entries
    .filter(isInboxFile)
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b))
  const items: InboxItem[] = []
  for (const file of files) {
    const item = await readJson<InboxItem>(join(inboxDir(root, runID), file))
    if (item !== undefined) items.push(item)
  }
  items.sort((a, b) => a.id.localeCompare(b.id))
  return items
}

/** Returns pending items and moves each file into inbox/processed/ under the state lock. */
export async function take(root: string, runID: string): Promise<InboxItem[]> {
  return lock(root, "state", runID, async () => {
    const entries = await readInboxEntries(root, runID)
    if (entries === undefined) return []
    const files = entries
      .filter(isInboxFile)
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b))
    if (files.length === 0) return []
    await Effect.runPromise(io(() => mkdir(join(inboxDir(root, runID), "processed"), { recursive: true })))
    const readItems: Array<{ filename: string; item: InboxItem }> = []
    for (const file of files) {
      const item = await readJson<InboxItem>(join(inboxDir(root, runID), file))
      if (item !== undefined) readItems.push({ filename: file, item })
    }
    const taken: InboxItem[] = []
    for (const entry of readItems) {
      const moved = await Effect.runPromise(
        io(() => rename(join(inboxDir(root, runID), entry.filename), join(inboxDir(root, runID), "processed", entry.filename))).pipe(
          Effect.as(true),
          Effect.catchIf((error) => errCode(error) === "ENOENT", () => Effect.succeed(false)),
        ),
      )
      if (moved) taken.push(entry.item)
    }
    taken.sort((a, b) => a.id.localeCompare(b.id))
    return taken
  })
}

/** Partitions items into synthetic (notify + system + child.settled), prompts (brief + followup), and shutdown. */
export function partition(items: InboxItem[]): InboxPartition {
  const sorted = [...items].sort((a, b) => a.id.localeCompare(b.id))
  const synthetic: InboxItem[] = []
  const prompts: InboxItem[] = []
  const shutdown: InboxItem[] = []
  for (const item of sorted) {
    if (item.kind === "notify" || item.kind === "system" || item.kind === "child.settled") synthetic.push(item)
    else if (item.kind === "brief" || item.kind === "followup") prompts.push(item)
    else if (item.kind === "shutdown") shutdown.push(item)
  }
  return { synthetic, prompts, shutdown }
}

/** Joins all pending synthetic items into ONE text, one line per item in ULID order. */
export function batchNotify(items: InboxItem[]): { text: string; taken: InboxItem[] } {
  const split = partition(items)
  const text = split.synthetic.map((i) => i.text.replace(/\r?\n$/, "")).join("\n")
  const taken = [...split.synthetic]
  Object.defineProperties(taken, {
    synthetic: { value: split.synthetic, enumerable: false },
    prompts: { value: split.prompts, enumerable: false },
    shutdown: { value: split.shutdown, enumerable: false },
    untouched: { value: [...split.prompts, ...split.shutdown], enumerable: false },
  })
  return { text, taken }
}
