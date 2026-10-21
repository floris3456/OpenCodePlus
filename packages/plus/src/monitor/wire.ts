// Content-addressed store of the bodies Plus sends to providers. Each top-level
// field and each element of the system/tools/messages/input arrays is stored
// once by hash; a request is an ordered list of those hashes. Consecutive
// requests of a chat repeat nearly all of their history, so this stores each
// item once instead of re-archiving the whole conversation on every request,
// and a request's rows, its changes against the previous request and any
// single item are indexed lookups.
//
// The store holds full prompt text, so it lives in the private transcript
// directory (0700, file 0600), never in monitor.db.
import { Database } from "bun:sqlite"
import fs from "node:fs"
import path from "node:path"
import type { MonitorPrompt, MonitorPromptInput, MonitorPromptRow } from "../rpc.js"
import { detectProtocol, sha256 } from "./fingerprint.js"
import type { Ledger } from "./ledger.js"

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
type JsonObject = { [key: string]: Json }

/** One displayed row: a content block of a stored element. */
interface Block {
  readonly kind: string
  readonly summary: string
  readonly chars: number
  /** Where the block sits inside its element, for the detail view. */
  readonly select: readonly (string | number)[]
  readonly call?: string
  readonly name?: string
  readonly error?: boolean
  readonly marker?: boolean
}

interface Part {
  readonly path: string
  readonly key: string
  readonly context: string
  readonly value: Json
  readonly json: string
}

const ARRAYS = new Set(["system", "tools", "messages", "input", "contents"])
const SUMMARY = 160
const stores = new WeakMap<Ledger, Database>()

const schema = `
create table if not exists element (
  hash text primary key,
  content text not null,
  body text not null,
  blocks text not null
);
create table if not exists wire (
  request_id text primary key,
  source text not null,
  session_id text not null,
  at integer not null,
  protocol text not null,
  bytes integer not null,
  exact integer not null
);
create index if not exists wire_session on wire(session_id, at, request_id);
create index if not exists wire_at on wire(at, request_id);
create index if not exists wire_source on wire(source);
create table if not exists wire_row (
  source text not null,
  position integer not null,
  path text not null,
  hash text not null,
  primary key (source, position)
) without rowid;
create index if not exists wire_row_hash on wire_row(hash);
`

export function wireStore(ledger: Ledger) {
  const existing = stores.get(ledger)
  if (existing) return existing
  // An in-memory ledger keeps its transcripts in memory too, instead of in a
  // ":memory:.transcripts" folder in the working directory.
  const memory = ledger.path === ":memory:"
  const directory = `${ledger.path}.transcripts`
  if (!memory) fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  const file = memory ? ":memory:" : path.join(directory, "wire.db")
  const db = new Database(file, { create: true })
  // SQLite gives the WAL and shared-memory files the database file's mode.
  if (!memory) fs.chmodSync(file, 0o600)
  db.exec("pragma journal_mode = wal")
  db.exec("pragma synchronous = normal")
  db.exec("pragma busy_timeout = 2000")
  db.exec(schema)
  stores.set(ledger, db)
  return db
}

export function closeWireStore(ledger: Ledger) {
  stores.get(ledger)?.close()
  stores.delete(ledger)
}

/**
 * Store one sent body. Returns false when the body is not a JSON object or
 * cannot be rebuilt byte-for-byte from its items; the caller then keeps an
 * exact compressed copy as well.
 */
export function storeWire(ledger: Ledger, input: { requestID: string; sessionID: string; at: number; body: string; url?: string }) {
  const body = parseObject(input.body)
  if (!body) return false
  const parts = split(body)
  const exact = rebuild(parts) === input.body
  const db = wireStore(ledger)
  const known = db.query<{ found: number }, [string]>("select 1 found from element where hash = ?")
  const addElement = db.query("insert or ignore into element (hash, content, body, blocks) values (?, ?, ?, ?)")
  const addRow = db.query("insert into wire_row (source, position, path, hash) values (?, ?, ?, ?)")
  db.transaction(() => {
    db.query("delete from wire_row where source = ?").run(input.requestID)
    parts.forEach((part, position) => {
      const hash = sha256(`${part.context}\0${part.json}`)
      if (!known.get(hash)) {
        addElement.run(hash, sha256(`${part.context}\0${JSON.stringify(stripMarkers(part.value))}`), part.json, JSON.stringify(describe(part)))
      }
      addRow.run(input.requestID, position, part.path, hash)
    })
    db.query(`insert into wire (request_id, source, session_id, at, protocol, bytes, exact) values (?, ?, ?, ?, ?, ?, ?)
      on conflict(request_id) do update set source = excluded.source, session_id = excluded.session_id, at = excluded.at,
        protocol = excluded.protocol, bytes = excluded.bytes, exact = excluded.exact`)
      .run(input.requestID, input.requestID, input.sessionID, input.at, detectProtocol(body, input.url), input.body.length, exact ? 1 : 0)
  })()
  return exact
}

/** A multi-exchange invocation reuses the body its final exchange sent. */
export function aliasWire(ledger: Ledger, requestID: string, from: string) {
  wireStore(ledger).query(`insert or ignore into wire (request_id, source, session_id, at, protocol, bytes, exact)
    select ?, source, session_id, at, protocol, bytes, exact from wire where request_id = ?`).run(requestID, from)
}

/** The sent body rebuilt from its items, or undefined when it is not stored. */
export function wireBody(ledger: Ledger, requestID: string) {
  const db = wireStore(ledger)
  const source = db.query<{ source: string }, [string]>("select source from wire where request_id = ?").get(requestID)?.source
  if (!source) return
  const rows = db.query<{ path: string; body: string }, [string]>(`select r.path, e.body from wire_row r join element e on e.hash = r.hash
    where r.source = ? order by r.position`).all(source)
  return rebuild(rows.map((row) => ({ path: row.path, key: topKey(row.path), json: row.body })))
}

export function pruneWire(ledger: Ledger, before: number) {
  const db = wireStore(ledger)
  db.transaction(() => {
    db.query("delete from wire where at < ?").run(before)
    db.query("delete from wire_row where source not in (select source from wire)").run()
    db.query("delete from element where hash not in (select hash from wire_row)").run()
  })()
}

/**
 * One request's rows with their change against the session's previous request.
 * `known` lets a poll that already shows the latest request return at once.
 */
export function queryPrompt(ledger: Ledger, input: MonitorPromptInput): MonitorPrompt {
  const db = wireStore(ledger)
  const target = resolve(db, input)
  if (!target) return { count: 0 }
  if (input.known === target.request_id && input.row === undefined) return { requestID: target.request_id, unchanged: true }
  const neighbour = (direction: "<" | ">") => db.query<{ request_id: string }, [string, number, number, string]>(`
    select request_id from wire where session_id = ? and (at ${direction} ? or (at = ? and request_id ${direction} ?))
    order by at ${direction === "<" ? "desc" : "asc"}, request_id ${direction === "<" ? "desc" : "asc"} limit 1`)
    .get(target.session_id, target.at, target.at, target.request_id)?.request_id
  const older = neighbour("<")
  const newer = neighbour(">")
  const position = db.query<{ n: number }, [string, number, number, string]>(`select count(*) n from wire
    where session_id = ? and (at < ? or (at = ? and request_id < ?))`).get(target.session_id, target.at, target.at, target.request_id)!.n
  const count = db.query<{ n: number }, [string]>("select count(*) n from wire where session_id = ?").get(target.session_id)!.n
  const rows = elements(db, target.source)
  const previous = older ? db.query<{ source: string }, [string]>("select source from wire where request_id = ?").get(older)?.source : undefined
  const before = previous ? new Map(elements(db, previous).map((row) => [row.path, row])) : undefined
  const blocks = rows.flatMap((row) => row.blocks.map((block, index) => ({ row, block, index })))
  const names = new Map(blocks.filter((entry) => entry.block.call && entry.block.name).map((entry) => [entry.block.call!, entry.block.name!]))
  const out = blocks.map((entry): MonitorPromptRow => {
    const prior = before?.get(entry.row.path)
    const change = !before ? "first" : !prior ? "new" : prior.hash === entry.row.hash ? "same" : prior.content === entry.row.content ? "marker" : "changed"
    const named = entry.block.kind === "result" ? names.get(entry.block.call ?? "") ?? entry.block.name : undefined
    return {
      path: entry.block.select.length ? `${entry.row.path}${pathOf(entry.block.select)}` : entry.row.path,
      kind: entry.block.kind,
      summary: [entry.block.error ? "error" : undefined, named, entry.block.summary].filter(Boolean).join(" · "),
      chars: entry.block.chars,
      change,
      ...(entry.block.marker ? { marker: true } : {}),
    }
  })
  const request = ledger.db.query<{ kind: string; provider: string | null; model: string | null; agent: string | null; is_title: number }, [string]>(
    "select kind, provider, model, agent, is_title from request where id = ?").get(target.request_id)
  const verdict = ledger.db.query<{ verdict: string }, [string]>("select verdict from cache_result where request_id = ?").get(target.request_id)?.verdict
  const selected = input.row === undefined ? undefined : blocks[input.row]
  return {
    requestID: target.request_id,
    sessionID: target.session_id,
    at: target.at,
    protocol: target.protocol,
    bytes: target.bytes,
    exact: target.exact === 1,
    position,
    count,
    ...(older ? { older } : {}),
    ...(newer ? { newer } : {}),
    ...(request ? { kind: request.is_title ? "title" : request.kind } : {}),
    ...(request?.model ? { model: request.provider ? `${request.provider}/${request.model}` : request.model } : {}),
    ...(request?.agent ? { agent: request.agent } : {}),
    ...(verdict ? { verdict } : {}),
    rows: out,
    ...(selected && input.row !== undefined ? { detail: detailOf(db, selected.row.hash, selected.block, input.row, out[input.row]!.path) } : {}),
  }
}

function resolve(db: Database, input: MonitorPromptInput) {
  type Target = { request_id: string; source: string; session_id: string; at: number; protocol: string; bytes: number; exact: number }
  const byID = (id: string) => db.query<Target, [string]>("select * from wire where request_id = ?").get(id)
  if (input.requestID) {
    const current = byID(input.requestID)
    if (!current || !input.direction) return current ?? undefined
    const direction = input.direction === "older" ? "<" : ">"
    return db.query<Target, [string, number, number, string]>(`select * from wire where session_id = ?
      and (at ${direction} ? or (at = ? and request_id ${direction} ?))
      order by at ${direction === "<" ? "desc" : "asc"}, request_id ${direction === "<" ? "desc" : "asc"} limit 1`)
      .get(current.session_id, current.at, current.at, current.request_id) ?? current
  }
  if (input.sessionID) return db.query<Target, [string]>("select * from wire where session_id = ? order by at desc, request_id desc limit 1").get(input.sessionID) ?? undefined
  return db.query<Target, []>("select * from wire order by at desc, request_id desc limit 1").get() ?? undefined
}

function elements(db: Database, source: string) {
  return db.query<{ path: string; hash: string; content: string; blocks: string }, [string]>(`
    select r.path, r.hash, e.content, e.blocks from wire_row r join element e on e.hash = r.hash
    where r.source = ? order by r.position`).all(source)
    .map((row) => ({ path: row.path, hash: row.hash, content: row.content, blocks: JSON.parse(row.blocks) as Block[] }))
}

function detailOf(db: Database, hash: string, block: Block, row: number, at: string) {
  const body = db.query<{ body: string }, [string]>("select body from element where hash = ?").get(hash)!.body
  const value = block.select.reduce<Json | undefined>((current, key) =>
    current === null || typeof current !== "object" ? undefined : (current as Record<string, Json>)[key as string], JSON.parse(body) as Json) ?? null
  return { row, path: at, json: JSON.stringify(value, null, 2), text: readable(value).join("\n") }
}

function parseObject(text: string) {
  const value = (() => {
    try {
      return JSON.parse(text) as Json
    } catch {
      return undefined
    }
  })()
  return value !== null && typeof value === "object" && !Array.isArray(value) ? value : undefined
}

function split(body: JsonObject): Part[] {
  return Object.entries(body).flatMap(([key, value]): Part[] => {
    if (ARRAYS.has(key) && Array.isArray(value) && value.length > 0) {
      return value.map((item, index) => ({ path: `${key}[${index}]`, key, context: key, value: item, json: JSON.stringify(item) }))
    }
    return [{ path: key, key, context: `option:${key}`, value, json: JSON.stringify(value) }]
  })
}

function topKey(at: string) {
  return /^([^[]+)\[\d+\]$/.exec(at)?.[1] ?? at
}

/** The compact JSON body these parts came from; equal to the sent bytes when `exact`. */
function rebuild(parts: readonly { path: string; key: string; json: string }[]) {
  const groups: { key: string; element: boolean; values: string[] }[] = []
  parts.forEach((part) => {
    const element = part.path !== part.key
    const last = groups.at(-1)
    if (element && last?.element && last.key === part.key) {
      last.values.push(part.json)
      return
    }
    groups.push({ key: part.key, element, values: [part.json] })
  })
  return `{${groups.map((group) => `${JSON.stringify(group.key)}:${group.element ? `[${group.values.join(",")}]` : group.values[0]}`).join(",")}}`
}

function stripMarkers(value: Json): Json {
  if (Array.isArray(value)) return value.map(stripMarkers)
  if (value === null || typeof value !== "object") return value
  return Object.fromEntries(Object.entries(value).filter(([key]) => key !== "cache_control").map(([key, entry]) => [key, stripMarkers(entry)]))
}

function pathOf(select: readonly (string | number)[]) {
  return select.map((key) => typeof key === "number" ? `[${key}]` : `.${key}`).join("")
}

// ---- Deterministic summaries ------------------------------------------------

function describe(part: Part): Block[] {
  const value = part.value
  if (part.context.startsWith("option:")) {
    if (part.key === "system" || part.key === "instructions") return [textBlock("system", value, [])]
    if (part.key === "input" && typeof value === "string") return [textBlock("prompt", value, [])]
    return [{ kind: "option", summary: `${part.key} = ${clip(JSON.stringify(value))}`, chars: part.json.length, select: [] }]
  }
  if (part.key === "tools") return [toolBlock(value)]
  if (part.key === "system") return [textBlock("system", value, [])]
  return message(value)
}

function message(value: Json): Block[] {
  if (!isObject(value)) return [textBlock("other", value, [])]
  const role = typeof value.role === "string" ? value.role : undefined
  const type = typeof value.type === "string" ? value.type : undefined
  if (type === "function_call" || type === "custom_tool_call") return [callBlock(value, [], value.call_id, value.name, value.arguments ?? value.input)]
  if (type === "function_call_output" || type === "custom_tool_call_output") return [resultBlock(value, [], value.call_id, value.output)]
  if (type === "reasoning") return [reasoningBlock(value, [])]
  if (role === "tool") return [resultBlock(value, [], value.tool_call_id, value.content)]
  const content = value.content ?? value.parts
  const blocks: Block[] = Array.isArray(content)
    ? content.map((entry, index) => contentBlock(entry, role, [value.content === undefined ? "parts" : "content", index]))
    : content === undefined || content === null ? [] : [contentBlock(content, role, ["content"])]
  const calls = Array.isArray(value.tool_calls)
    ? value.tool_calls.map((call, index) => isObject(call) && isObject(call.function)
      ? callBlock(call, ["tool_calls", index], call.id, call.function.name, call.function.arguments)
      : textBlock("other", call, ["tool_calls", index]))
    : []
  const all = [...blocks, ...calls]
  if (all.length) return all
  return [textBlock(roleKind(role), value, [])]
}

function contentBlock(entry: Json, role: string | undefined, select: (string | number)[]): Block {
  if (typeof entry === "string") return textBlock(roleKind(role, entry), entry, select)
  if (!isObject(entry)) return textBlock("other", entry, select)
  const marker = entry.cache_control !== undefined
  const type = typeof entry.type === "string" ? entry.type : undefined
  const withMarker = (block: Block): Block => (marker ? { ...block, marker } : block)
  if (type === "tool_use" || type === "server_tool_use") return withMarker(callBlock(entry, select, entry.id, entry.name, entry.input))
  if (type === "tool_result") return withMarker(resultBlock(entry, select, entry.tool_use_id, entry.content, entry.is_error === true))
  if (type === "thinking" || type === "redacted_thinking") {
    const text = typeof entry.thinking === "string" ? entry.thinking : ""
    return withMarker({ kind: "thinking", summary: text ? clip(collapse(text)) : `redacted · ${size(entry)} chars`, chars: size(entry), select })
  }
  if (type === "image" || type === "input_image" || type === "image_url") return withMarker({ kind: "image", summary: mediaOf(entry), chars: size(entry), select })
  if (type === "document" || type === "input_file" || type === "file") return withMarker({ kind: "file", summary: mediaOf(entry), chars: size(entry), select })
  const text = typeof entry.text === "string" ? entry.text : undefined
  if (text !== undefined) return withMarker(textBlock(roleKind(role, text), text, select, size(entry)))
  return withMarker(textBlock("other", entry, select))
}

function roleKind(role: string | undefined, text?: string) {
  if (role === "system" || role === "developer") return "system"
  if (role === "assistant" || role === "model") return "assistant"
  if (role === "user") return text?.trimStart().startsWith("<system-reminder>") ? "reminder" : "prompt"
  return "other"
}

function textBlock(kind: string, value: Json, select: (string | number)[], chars?: number): Block {
  const text = typeof value === "string" ? value
    : Array.isArray(value) ? value.map((entry) => isObject(entry) && typeof entry.text === "string" ? entry.text : "").join("\n")
    : isObject(value) && typeof value.text === "string" ? value.text : JSON.stringify(value)
  const marker = isObject(value) && value.cache_control !== undefined
  const shown = kind === "reminder" ? text.replace(/<\/?system-reminder>/g, " ") : text
  return {
    kind,
    summary: kind === "system" ? clip(firstLine(shown)) : clip(collapse(shown)),
    chars: chars ?? (typeof value === "string" ? value.length : JSON.stringify(value).length),
    select,
    ...(marker ? { marker } : {}),
  }
}

function toolBlock(value: Json): Block {
  if (!isObject(value)) return textBlock("tool", value, [])
  const fn = isObject(value.function) ? value.function : value
  const name = typeof fn.name === "string" ? fn.name : typeof value.type === "string" ? value.type : "?"
  const description = typeof fn.description === "string" ? firstSentence(fn.description) : ""
  return {
    kind: "tool",
    summary: clip(description ? `${name} — ${description}` : name),
    chars: size(value),
    select: [],
    ...(value.cache_control !== undefined ? { marker: true } : {}),
  }
}

function callBlock(value: JsonObject, select: (string | number)[], id: Json | undefined, name: Json | undefined, args: Json | undefined): Block {
  const tool = typeof name === "string" ? name : "?"
  const parsed = typeof args === "string" ? parseObject(args) ?? args : args
  return {
    kind: "call",
    summary: clip(`${tool} ${argumentSummary(parsed)}`.trim()),
    chars: size(value),
    select,
    ...(typeof id === "string" ? { call: id } : {}),
    name: tool,
  }
}

const ARGUMENT_KEYS = ["command", "filePath", "file_path", "path", "pattern", "url", "query", "id", "agent", "description", "prompt", "code"]

function argumentSummary(args: Json | undefined) {
  if (args === undefined || args === null) return ""
  if (typeof args === "string") return collapse(args)
  if (!isObject(args)) return JSON.stringify(args)
  const key = ARGUMENT_KEYS.find((name) => typeof args[name] === "string")
  if (key) return collapse(args[key] as string)
  return JSON.stringify(args)
}

function resultBlock(value: JsonObject, select: (string | number)[], id: Json | undefined, output: Json | undefined, error = false): Block {
  const text = typeof output === "string" ? output
    : Array.isArray(output) ? output.map((entry) => isObject(entry) && typeof entry.text === "string" ? entry.text : isObject(entry) ? `[${entry.type ?? "item"}]` : "").join("\n")
    : output === undefined ? "" : JSON.stringify(output)
  return {
    kind: "result",
    summary: clip(`${text.length.toLocaleString("en-US")} chars · ${firstLine(text)}`),
    chars: size(value),
    select,
    ...(typeof id === "string" ? { call: id } : {}),
    ...(error ? { error } : {}),
    ...(value.cache_control !== undefined ? { marker: true } : {}),
  }
}

function reasoningBlock(value: JsonObject, select: (string | number)[]): Block {
  const summary = Array.isArray(value.summary)
    ? value.summary.map((entry) => isObject(entry) && typeof entry.text === "string" ? entry.text : "").join(" ")
    : ""
  const encrypted = typeof value.encrypted_content === "string" ? value.encrypted_content.length : 0
  return {
    kind: "thinking",
    summary: summary ? clip(collapse(summary)) : encrypted ? `encrypted · ${encrypted.toLocaleString("en-US")} chars` : "empty",
    chars: size(value),
    select,
  }
}

function mediaOf(entry: JsonObject) {
  const source = isObject(entry.source) ? entry.source : entry
  const media = typeof source.media_type === "string" ? source.media_type : typeof entry.type === "string" ? entry.type : "media"
  const data = typeof source.data === "string" ? source.data.length : 0
  const url = typeof source.url === "string" ? source.url : typeof entry.image_url === "string" ? entry.image_url : undefined
  return url && !url.startsWith("data:") ? `${media} · ${clip(url, 80)}` : `${media} · ${Math.round((data * 3) / 4 / 1024)} KB`
}

/**
 * Indented, human-readable rendering: strings print as their own lines, and
 * strings holding a JSON object (tool arguments) print as that object.
 */
export function readable(value: Json, indent = ""): string[] {
  if (typeof value === "string") {
    const nested = value.startsWith("{") ? parseObject(value) : undefined
    if (nested) return readable(nested, indent)
    return value.split("\n").map((line) => `${indent}${line}`)
  }
  if (value === null || typeof value !== "object") return [`${indent}${JSON.stringify(value)}`]
  const entries: [string, Json][] = Array.isArray(value) ? value.map((entry, index) => [`[${index}]`, entry]) : Object.entries(value)
  if (!entries.length) return [`${indent}${Array.isArray(value) ? "[]" : "{}"}`]
  return entries.flatMap(([key, entry]) => {
    const scalar = entry === null || typeof entry !== "object"
    const short = typeof entry === "string" && !entry.includes("\n") && entry.length <= 100 && !(entry.startsWith("{") && parseObject(entry))
    if ((scalar && typeof entry !== "string") || short) return [`${indent}${key}: ${typeof entry === "string" ? entry : JSON.stringify(entry)}`]
    return [`${indent}${key}:`, ...readable(entry, `${indent}  `)]
  })
}

function isObject(value: Json | undefined): value is JsonObject {
  return value !== null && value !== undefined && typeof value === "object" && !Array.isArray(value)
}

function size(value: Json) {
  return JSON.stringify(value).length
}

function collapse(text: string) {
  return text.replace(/\s+/g, " ").trim()
}

function firstLine(text: string) {
  return collapse(text.split("\n").find((line) => line.trim() !== "") ?? "")
}

function firstSentence(text: string) {
  const line = firstLine(text)
  const end = line.search(/[.!?](\s|$)/)
  return end > 0 ? line.slice(0, end + 1) : line
}

function clip(text: string, max = SUMMARY) {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
