import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import { parseModelPatterns } from "../instructions/model-patterns.js"
import { modelPromptDir, userSystemDir, userSystemFile } from "../instructions/paths.js"
import { readUserBaseTextSync, readUserBaseTitleSync, removeIndexEntry, writeIndexEntry } from "./base.js"

export type SystemRowResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: "exists"; readonly id: string }
  | { readonly ok: false; readonly reason: "invalid"; readonly id: string; readonly message: string }

export type SystemRowDeleteResult =
  | { readonly ok: true; readonly id: string }
  | { readonly ok: false; readonly reason: "missing"; readonly id: string }
  | { readonly ok: false; readonly reason: "invalid"; readonly id: string; readonly message: string }

export interface UserSystemRow {
  readonly id: string
  readonly title: string
  readonly text: string
  /** Model prompts only: the models the row is sent for (model-patterns.ts). */
  readonly models?: readonly string[]
  /** The row starts off for every agent (a duplicate's copy, so its text is not sent twice). */
  readonly off?: true
}

// A model prompt is a System row id `model/<slug>`: its file sits in the model
// prompt folder and its patterns in models.json there.
const modelPrefix = "model/"

// The built-in System rows own these ids (`system:<id>`).
const reserved = new Set(["role", "opencodeplus", "tools-and-rules"])

// A slug keeps `system:<id>` apart from the AGENTS.md rows' `system:<path>`
// ids, which always carry a dot.
export function validateSystemId(raw: string): { ok: true; id: string } | { ok: false; reason: string } {
  const id = raw.trim()
  if (id.length === 0) return { ok: false, reason: "System row id cannot be empty" }
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id))
    return { ok: false, reason: `Invalid System row id "${raw}": use lowercase letters, digits and hyphens` }
  if (reserved.has(id)) return { ok: false, reason: `System row "${id}" is built in; choose another id` }
  return { ok: true, id }
}

export async function createSystemRow(id: string, title: string, text: string, models?: readonly string[], off = false): Promise<SystemRowResult> {
  if (models !== undefined) return createModelPrompt(id, title, text, models, off)
  const validated = validateSystemId(id)
  if (!validated.ok) return { ok: false, reason: "invalid", id, message: validated.reason }
  const target = userSystemFile(validated.id)
  if (await Bun.file(target).exists()) return { ok: false, reason: "exists", id: validated.id }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, text)
  await writeIndexEntry(userSystemDir(), validated.id, title.trim().length === 0 ? validated.id : title.trim())
  if (off) await writeOffEntry(userSystemDir(), validated.id, true)
  return { ok: true, id: validated.id }
}

export async function deleteSystemRow(id: string): Promise<SystemRowDeleteResult> {
  if (id.trim().startsWith(modelPrefix)) return deleteModelPrompt(id)
  const validated = validateSystemId(id)
  if (!validated.ok) return { ok: false, reason: "invalid", id, message: validated.reason }
  const target = userSystemFile(validated.id)
  if (!(await Bun.file(target).exists())) return { ok: false, reason: "missing", id: validated.id }
  await fs.rm(target, { force: true })
  await removeIndexEntry(userSystemDir(), validated.id)
  await writeOffEntry(userSystemDir(), validated.id, false)
  return { ok: true, id: validated.id }
}

/** Replace a model prompt's patterns (`model/<slug>`); at least one is needed. */
export async function setModelPromptModels(id: string, models: readonly string[]): Promise<SystemRowDeleteResult> {
  const slug = modelSlugOf(id)
  if (!slug.ok) return { ok: false, reason: "invalid", id, message: slug.reason }
  const patterns = parseModelPatterns(models.join(","))
  if (patterns.length === 0) return { ok: false, reason: "invalid", id, message: noModelsMessage }
  if (!(await Bun.file(modelPromptFile(slug.id)).exists())) return { ok: false, reason: "missing", id: `${modelPrefix}${slug.id}` }
  await writeModelsEntry(slug.id, patterns)
  return { ok: true, id: `${modelPrefix}${slug.id}` }
}

// Synchronous like the base template read: discovery awaits it, and the
// directory is tiny. A missing directory means no rows. Model prompts follow
// the System rows.
export function readUserSystemRowsSync(): UserSystemRow[] {
  const dir = userSystemDir()
  const off = readOffSync(dir)
  const rows = markdownIds(dir).map((id) => ({ id, text: readUserBaseTextSync(path.join(dir, `${id}.md`)), title: readUserBaseTitleSync(path.join(dir, "index.json"), id, id), ...(off.has(id) ? { off: true as const } : {}) }))
  const models = modelPromptDir()
  const patterns = readModelsIndexSync()
  const offPrompts = readOffSync(models)
  const prompts = markdownIds(models).map((id) => ({
    id: `${modelPrefix}${id}`,
    text: readUserBaseTextSync(path.join(models, `${id}.md`)),
    title: readUserBaseTitleSync(path.join(models, "index.json"), id, id),
    models: patterns[id] ?? [],
    ...(offPrompts.has(id) ? { off: true as const } : {}),
  }))
  return [...rows, ...prompts].flatMap((row) => (row.text === undefined ? [] : [{ ...row, text: row.text }]))
}

const noModelsMessage = "A model prompt needs at least one model, e.g. *opus-5-5* or cliproxyapi/claude-opus-5-5"

async function createModelPrompt(id: string, title: string, text: string, models: readonly string[], off: boolean): Promise<SystemRowResult> {
  const slug = modelSlugOf(id)
  if (!slug.ok) return { ok: false, reason: "invalid", id, message: slug.reason }
  const patterns = parseModelPatterns(models.join(","))
  if (patterns.length === 0) return { ok: false, reason: "invalid", id, message: noModelsMessage }
  const target = modelPromptFile(slug.id)
  if (await Bun.file(target).exists()) return { ok: false, reason: "exists", id: `${modelPrefix}${slug.id}` }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, text)
  await writeIndexEntry(modelPromptDir(), slug.id, title.trim().length === 0 ? slug.id : title.trim())
  await writeModelsEntry(slug.id, patterns)
  if (off) await writeOffEntry(modelPromptDir(), slug.id, true)
  return { ok: true, id: `${modelPrefix}${slug.id}` }
}

async function deleteModelPrompt(id: string): Promise<SystemRowDeleteResult> {
  const slug = modelSlugOf(id)
  if (!slug.ok) return { ok: false, reason: "invalid", id, message: slug.reason }
  const target = modelPromptFile(slug.id)
  if (!(await Bun.file(target).exists())) return { ok: false, reason: "missing", id: `${modelPrefix}${slug.id}` }
  await fs.rm(target, { force: true })
  await removeIndexEntry(modelPromptDir(), slug.id)
  await writeModelsEntry(slug.id, undefined)
  await writeOffEntry(modelPromptDir(), slug.id, false)
  return { ok: true, id: `${modelPrefix}${slug.id}` }
}

// `model/<slug>` or the bare slug; the slug follows the System row id rules.
function modelSlugOf(raw: string): { ok: true; id: string } | { ok: false; reason: string } {
  const trimmed = raw.trim()
  const validated = validateSystemId(trimmed.startsWith(modelPrefix) ? trimmed.slice(modelPrefix.length) : trimmed)
  if (!validated.ok) return { ok: false, reason: validated.reason.replace("System row", "Model prompt") }
  return validated
}

function modelPromptFile(slug: string): string {
  return path.join(modelPromptDir(), `${slug}.md`)
}

function markdownIds(dir: string): string[] {
  const entries = (() => {
    try {
      return fsSync.readdirSync(dir)
    } catch {
      return []
    }
  })()
  return entries
    .filter((entry) => entry.endsWith(".md") && validateSystemId(entry.slice(0, -".md".length)).ok)
    .map((entry) => entry.slice(0, -".md".length))
    .toSorted()
}

function readModelsIndexSync(): Record<string, readonly string[]> {
  try {
    const parsed: unknown = JSON.parse(fsSync.readFileSync(path.join(modelPromptDir(), "models.json"), "utf8"))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
    return Object.fromEntries(
      Object.entries(parsed).flatMap(([id, value]) =>
        Array.isArray(value) ? [[id, value.filter((pattern): pattern is string => typeof pattern === "string")]] : [],
      ),
    )
  } catch {
    return {}
  }
}

async function writeModelsEntry(slug: string, patterns: readonly string[] | undefined): Promise<void> {
  const current = { ...readModelsIndexSync() }
  if (patterns === undefined) delete current[slug]
  if (patterns !== undefined) current[slug] = patterns
  await fs.mkdir(modelPromptDir(), { recursive: true })
  await Bun.write(path.join(modelPromptDir(), "models.json"), `${JSON.stringify(current, undefined, 2)}\n`)
}

// `off.json` next to the files: the ids of rows that start off for every
// agent. Absent or unreadable means none.
function readOffSync(dir: string): ReadonlySet<string> {
  try {
    const parsed: unknown = JSON.parse(fsSync.readFileSync(path.join(dir, "off.json"), "utf8"))
    return new Set(Array.isArray(parsed) ? parsed.filter((id): id is string => typeof id === "string") : [])
  } catch {
    return new Set()
  }
}

async function writeOffEntry(dir: string, id: string, off: boolean): Promise<void> {
  const current = readOffSync(dir)
  if (current.has(id) === off) return
  const next = off ? [...current, id] : [...current].filter((entry) => entry !== id)
  await Bun.write(path.join(dir, "off.json"), `${JSON.stringify(next.toSorted(), undefined, 2)}\n`)
}
