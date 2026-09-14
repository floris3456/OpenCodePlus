import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { LogEntry, type Plus } from "../rpc.js"
import { globalLogPath, projectLogPath } from "./paths.js"

const decodeLogEntry = Schema.decodeUnknownOption(Schema.fromJsonString(LogEntry))

export interface ReadOptions {
  readonly where?: string
  readonly limit?: number
  readonly offset?: number
}

export interface ReadResult {
  readonly entries: readonly Plus.LogEntry[]
  readonly total: number
}

// Append one entry as a single JSON line. The summary is capped at 200 chars
// with newlines stripped so every entry stays one small line; the file is
// only ever appended to, never rewritten. Logging never touches revisions,
// the records file, or the publish fingerprint.
export async function append(logPath: string, entry: Plus.LogEntry): Promise<void> {
  const line = JSON.stringify({ ...entry, summary: capSummary(entry.summary) })
  await fs.mkdir(path.dirname(logPath), { recursive: true })
  await fs.appendFile(logPath, `${line}\n`)
}

// Read one log file oldest-first. A corrupt line is skipped, never fatal; a
// missing file reads as empty. Total counts the filtered entries before
// offset/limit slicing.
export async function read(logPath: string, options?: ReadOptions): Promise<ReadResult> {
  const file = Bun.file(logPath)
  if (!(await file.exists())) return { entries: [], total: 0 }
  const lines = (await file.text()).split("\n").filter((line) => line.trim().length > 0)
  const decoded = lines.flatMap((line): Plus.LogEntry[] => {
    const entry = Option.getOrUndefined(decodeLogEntry(line))
    if (entry === undefined) return []
    return [entry]
  })
  const filtered = decoded.filter((entry) => matchesWhere(entry, options?.where))
  const total = filtered.length
  const offset = normalizeOffset(options?.offset)
  const limit = normalizeLimit(options?.limit)
  const entries = limit === undefined ? filtered.slice(offset) : filtered.slice(offset, offset + limit)
  return { entries, total }
}

// Read both logs merged newest-first for the instructions.log RPC. Same-file
// ties break towards the later line; cross-file ties are deterministic by
// read order (global entries sort after project entries).
export async function readBoth(projectDir: string, options?: { readonly where?: string }): Promise<readonly Plus.LogEntry[]> {
  const project = await read(projectLogPath(projectDir), { where: options?.where })
  const global = await read(globalLogPath(), { where: options?.where })
  let sequence = 0
  const sequenced = [...project.entries, ...global.entries].map((entry) => ({ entry, sequence: sequence++ }))
  sequenced.sort((left, right) => timeOf(right.entry) - timeOf(left.entry) || right.sequence - left.sequence)
  return sequenced.map((row) => row.entry)
}

// `where` grammar: space-separated tokens, ANDed together, `!` negates one
// token. A bare word is a case-insensitive substring over op, target, summary
// and actor.agent. Keyed tokens: actor:tui|tool (exact actor type),
// agent:<text> (substring over actor.agent), op:<text> (substring over op),
// target:<prefix> (prefix over target), session:<text> (substring over
// actor.sessionID), since:<instant> / before:<instant> over the entry ts,
// where an instant is an ISO date or a `<number><s|m|h|d|w>` age before now.
// An unknown key or an unparseable instant matches nothing (keyed) or falls
// back to bare-word matching (unknown key only).
function matchesWhere(entry: Plus.LogEntry, where: string | undefined): boolean {
  if (where === undefined || where.trim().length === 0) return true
  return where
    .split(/\s+/)
    .filter((token) => token.length > 0)
    .every((token) => matchesToken(entry, token))
}

function matchesToken(entry: Plus.LogEntry, token: string): boolean {
  if (token.startsWith("!")) return !matchesToken(entry, token.slice(1))
  return matchesAtom(entry, token)
}

function matchesAtom(entry: Plus.LogEntry, token: string): boolean {
  const colon = token.indexOf(":")
  if (colon > 0) {
    const key = token.slice(0, colon).toLowerCase()
    const value = token.slice(colon + 1)
    if (key === "actor") return entry.actor.type.toLowerCase() === value.toLowerCase()
    if (key === "agent") return (entry.actor.agent ?? "").toLowerCase().includes(value.toLowerCase())
    if (key === "op") return entry.op.toLowerCase().includes(value.toLowerCase())
    if (key === "target") return entry.target.startsWith(value)
    if (key === "session") return (entry.actor.sessionID ?? "").includes(value)
    if (key === "since") {
      const instant = parseInstant(value)
      return instant !== undefined && timeOf(entry) >= instant
    }
    if (key === "before") {
      const instant = parseInstant(value)
      return instant !== undefined && timeOf(entry) < instant
    }
    return matchesBare(entry, token)
  }
  return matchesBare(entry, token)
}

function matchesBare(entry: Plus.LogEntry, word: string): boolean {
  const needle = word.toLowerCase()
  return (
    entry.op.toLowerCase().includes(needle) ||
    entry.target.toLowerCase().includes(needle) ||
    entry.summary.toLowerCase().includes(needle) ||
    (entry.actor.agent ?? "").toLowerCase().includes(needle)
  )
}

function parseInstant(value: string): number | undefined {
  const age = value.match(/^(\d+(?:\.\d+)?)(s|m|h|d|w)$/)
  if (age !== null) {
    const amount = Number(age[1])
    const unit = age[2]
    const factor = unit === "s" ? 1000 : unit === "m" ? 60_000 : unit === "h" ? 3_600_000 : unit === "d" ? 86_400_000 : 604_800_000
    return Date.now() - amount * factor
  }
  const parsed = Date.parse(value)
  if (Number.isNaN(parsed)) return undefined
  return parsed
}

function timeOf(entry: Plus.LogEntry): number {
  const parsed = Date.parse(entry.ts)
  if (Number.isNaN(parsed)) return Number.NEGATIVE_INFINITY
  return parsed
}

function capSummary(summary: string): string {
  return summary.replaceAll(/[\r\n]+/g, " ").slice(0, 200)
}

function normalizeOffset(offset: number | undefined): number {
  if (offset === undefined || Number.isNaN(offset)) return 0
  return Math.max(0, Math.floor(offset))
}

function normalizeLimit(limit: number | undefined): number | undefined {
  if (limit === undefined || Number.isNaN(limit)) return undefined
  return Math.max(0, Math.floor(limit))
}
