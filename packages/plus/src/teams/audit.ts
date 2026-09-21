import { appendFile, chmod, mkdir, readFile, writeFile } from "node:fs/promises"
import { createHash, createHmac, randomBytes } from "node:crypto"
import path from "node:path"
import { Effect, Option, Predicate, Schema } from "effect"
import { lock } from "./store.js"
import { errCode, io } from "./io.js"

export type ToolCallOutcome = "allowed" | "asked:allow" | "denied" | "asked:deny"

export interface AppendResult {
  seq: number
  at: string
  prev: string
  hmac: string
}

export interface VerifyResult {
  ok: boolean
  lines: number
  badLine?: number
  reason?: string
}

function sha256Hex(s: string): string {
  return createHash("sha256").update(s, "utf8").digest("hex")
}

const EMPTY_HASH = sha256Hex("")

function auditPath(root: string): string {
  return path.join(root, "audit.log")
}

function keyPath(root: string): string {
  return path.join(root, "audit.key")
}

function canonical(value: unknown): string {
  if (value === null || value === undefined) return "null"
  if (Array.isArray(value)) return `[${value.map((item) => canonical(item)).join(",")}]`
  if (Predicate.isObject(value)) {
    const parts: string[] = []
    for (const k of Object.keys(value).sort()) {
      const v = value[k]
      if (v !== undefined) parts.push(`${JSON.stringify(k)}:${canonical(v)}`)
    }
    return `{${parts.join(",")}}`
  }
  return JSON.stringify(value) as string
}

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

function lineSeq(raw: string): number {
  const parsed = Option.getOrUndefined(decodeJson(raw))
  if (!Predicate.isObject(parsed)) return 0
  return Predicate.isNumber(parsed.seq) ? parsed.seq : 0
}

function loadKey(root: string): Effect.Effect<string, unknown> {
  return Effect.gen(function* () {
    const keyFile = keyPath(root)
    const existing = yield* io(() => readFile(keyFile, "utf8")).pipe(
      Effect.map((raw) => raw.trim()),
      Effect.catchIf(
        (error) => errCode(error) === "ENOENT",
        () => Effect.succeed(undefined),
      ),
    )
    if (existing !== undefined && existing.length > 0) return existing
    yield* io(() => mkdir(path.dirname(keyFile), { recursive: true }))
    const key = randomBytes(32).toString("hex")
    const created = yield* io(() => writeFile(keyFile, key + "\n", { mode: 0o600, flag: "wx" })).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => errCode(error) === "EEXIST",
        () => Effect.succeed(false),
      ),
    )
    if (!created) {
      const raced = yield* io(() => readFile(keyFile, "utf8"))
      return raced.trim()
    }
    yield* Effect.ignore(io(() => chmod(keyFile, 0o600)))
    return key
  })
}

function computeHmac(key: string, prev: string, body: Record<string, unknown>): string {
  return createHmac("sha256", key).update(prev + canonical(body), "utf8").digest("hex")
}

function readLines(root: string): Effect.Effect<string[] | undefined, unknown> {
  return io(() => readFile(auditPath(root), "utf8")).pipe(
    Effect.map((content) => content.split("\n").filter((line) => line.length > 0)),
    Effect.catchIf(
      (error) => errCode(error) === "ENOENT",
      () => Effect.succeed(undefined),
    ),
  )
}

// Never write secrets into the audit chain: payloads carry ids, kinds and
// short status strings. The HMAC key never leaves the state root.
export async function append(root: string, kind: string, payload: Record<string, unknown>): Promise<AppendResult> {
  return lock(root, "state", "audit", () =>
    Effect.runPromise(
      Effect.gen(function* () {
        const key = yield* loadKey(root)
        yield* io(() => mkdir(root, { recursive: true }))
        const lines = (yield* readLines(root)) ?? []
        const prev = lines.length === 0 ? EMPTY_HASH : sha256Hex(lines[lines.length - 1])
        const seq = (lines.length === 0 ? 0 : lineSeq(lines[lines.length - 1])) + 1
        const at = new Date().toISOString()
        const body: Record<string, unknown> = { seq, at, kind, ...payload, prev }
        body.seq = seq
        body.at = at
        body.kind = kind
        body.prev = prev
        const hmac = computeHmac(key, prev, body)
        const line: Record<string, unknown> = { seq, at, kind, ...payload, prev, hmac }
        line.seq = seq
        line.at = at
        line.kind = kind
        line.prev = prev
        line.hmac = hmac
        yield* io(() => appendFile(auditPath(root), JSON.stringify(line) + "\n", { mode: 0o600 }))
        yield* Effect.ignore(io(() => chmod(auditPath(root), 0o600)))
        return { seq, at, prev, hmac }
      }),
    ),
  )
}

export async function verify(root: string): Promise<VerifyResult> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const lines = yield* readLines(root)
      if (lines === undefined || lines.length === 0) return { ok: true, lines: 0 }
      const key = yield* io(() => readFile(keyPath(root), "utf8")).pipe(
        Effect.map((raw) => raw.trim() as string | undefined),
        Effect.catchIf(
          (error) => errCode(error) === "ENOENT",
          () => Effect.succeed(undefined),
        ),
      )
      if (key === undefined) return { ok: false, lines: lines.length, badLine: 1, reason: "missing key" }
      for (let i = 0; i < lines.length; i++) {
        const raw = lines[i]
        const parsed = Option.getOrUndefined(decodeJson(raw))
        if (!Predicate.isObject(parsed))
          return { ok: false, lines: lines.length, badLine: i + 1, reason: "invalid JSON" }
        if (!Predicate.isString(parsed.prev))
          return { ok: false, lines: lines.length, badLine: i + 1, reason: "missing prev" }
        const wantPrev = i === 0 ? EMPTY_HASH : sha256Hex(lines[i - 1])
        if (parsed.prev !== wantPrev)
          return { ok: false, lines: lines.length, badLine: i + 1, reason: "prev mismatch" }
        if (!Predicate.isString(parsed.hmac))
          return { ok: false, lines: lines.length, badLine: i + 1, reason: "missing hmac" }
        const body: Record<string, unknown> = { ...parsed }
        delete body.hmac
        if (parsed.hmac !== computeHmac(key, parsed.prev, body))
          return { ok: false, lines: lines.length, badLine: i + 1, reason: "hmac mismatch" }
      }
      return { ok: true, lines: lines.length }
    }),
  )
}

export async function exportChain(root: string): Promise<string> {
  const lines = await Effect.runPromise(readLines(root))
  if (lines === undefined) return ""
  const out: string[] = []
  for (const raw of lines) {
    const parsed = Option.getOrUndefined(decodeJson(raw))
    if (!Predicate.isObject(parsed)) throw new Error("exportChain: audit.log holds a non-object line")
    const body: Record<string, unknown> = { ...parsed }
    delete body.hmac
    out.push(JSON.stringify(body))
  }
  return out.length > 0 ? out.join("\n") + "\n" : ""
}
