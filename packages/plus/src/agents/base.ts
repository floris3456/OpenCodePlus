import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import { globalConfigDir } from "../instructions/paths.js"

export interface BaseTemplateSuccess {
  readonly ok: true
  readonly id: string
}

export interface BaseTemplateExists {
  readonly ok: false
  readonly reason: "exists"
  readonly id: string
}

export interface BaseTemplateInvalid {
  readonly ok: false
  readonly reason: "invalid"
  readonly id: string
  readonly message: string
}

export interface BaseTemplateMissing {
  readonly ok: false
  readonly reason: "missing"
  readonly id: string
}

export type BaseTemplateResult = BaseTemplateSuccess | BaseTemplateExists | BaseTemplateInvalid
export type BaseTemplateDeleteResult = BaseTemplateSuccess | BaseTemplateMissing | BaseTemplateInvalid

export function validateBaseId(raw: string): { ok: true; id: string } | { ok: false; reason: string } {
  const id = raw.trim()
  if (id.length === 0) return { ok: false, reason: "Base template id cannot be empty" }
  if (id.includes("/") || id.includes("\\") || id.includes("\0"))
    return { ok: false, reason: `Invalid base template id "${raw}"` }
  return { ok: true, id }
}

export function userBaseDir(): string {
  return path.join(globalConfigDir(), "opencodeplus", "instructions", "base")
}

export function userBaseFile(id: string): string {
  const root = path.resolve(userBaseDir())
  const target = path.resolve(root, `${id}.txt`)
  if (target === root || !target.startsWith(`${root}${path.sep}`)) throw new Error(`Invalid base template id "${id}"`)
  return target
}

// Built-in ids always resolve through the host prompt domain or the local
// fallback table, never through the user directory, so deleting one is
// refused as invalid rather than reported missing.
export function isBuiltinBaseId(id: string): boolean {
  return builtinBaseIds().has(id)
}

export function builtinBaseIds(): Set<string> {
  return new Set(["gpt", "claude", "muse", "gemini", "general", "kimi", "trinity"])
}

export async function createBaseTemplate(id: string, title: string, text: string): Promise<BaseTemplateResult> {
  const validated = validateBaseId(id)
  if (!validated.ok) return { ok: false, reason: "invalid", id, message: validated.reason }
  // Builtin ids are reserved: a user file with one would shadow the host
  // template in resolveBaseTemplates (user wins on collision) while
  // deleteBaseTemplate refuses those exact ids as builtin — pinning an
  // irreversible shadow that the host classifier can genuinely apply. Refuse
  // at creation so no new shadow can form.
  if (isBuiltinBaseId(validated.id))
    return {
      ok: false,
      reason: "invalid",
      id: validated.id,
      message: `Base template "${validated.id}" is built in; choose another id`,
    }
  const target = userBaseFile(validated.id)
  if (await Bun.file(target).exists()) return { ok: false, reason: "exists", id: validated.id }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, text)
  await writeBaseIndexEntry(validated.id, title)
  return { ok: true, id: validated.id }
}

export async function deleteBaseTemplate(id: string): Promise<BaseTemplateDeleteResult> {
  const validated = validateBaseId(id)
  if (!validated.ok) return { ok: false, reason: "invalid", id, message: validated.reason }
  const target = userBaseFile(validated.id)
  if (!(await Bun.file(target).exists())) {
    // No user file: a builtin id names the host template itself, which Plus
    // must not delete; any other id is simply unknown.
    if (isBuiltinBaseId(validated.id))
      return { ok: false, reason: "invalid", id: validated.id, message: `Base template "${validated.id}" is built in and cannot be deleted` }
    return { ok: false, reason: "missing", id: validated.id }
  }
  // A user file exists — including a builtin-id shadow predating the creation
  // refusal — so remove it. Deleting a shadow restores the host template in
  // the next discovery.
  await fs.rm(target, { force: true })
  await removeBaseIndexEntry(validated.id)
  return { ok: true, id: validated.id }
}

export function readUserBaseTextSync(target: string): string | undefined {
  try {
    return fsSync.readFileSync(target, "utf8")
  } catch {
    return undefined
  }
}

export function readUserBaseTitleSync(index: string, id: string): string {
  try {
    const parsed: unknown = JSON.parse(fsSync.readFileSync(index, "utf8"))
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return `${id}.txt`
    const title = (parsed as Record<string, unknown>)[id]
    if (typeof title !== "string" || title.length === 0) return `${id}.txt`
    return title
  } catch {
    return `${id}.txt`
  }
}

// The small index next to the <id>.txt files so discover (and a future core
// prompt domain) can list user templates with their titles alongside the
// built-ins. Best-effort: a missing index only loses titles, never templates.
async function writeBaseIndexEntry(id: string, title: string): Promise<void> {
  const target = path.join(userBaseDir(), "index.json")
  const current = await readBaseIndex(target)
  current[id] = title
  await Bun.write(target, `${JSON.stringify(current, undefined, 2)}\n`)
}

async function removeBaseIndexEntry(id: string): Promise<void> {
  const target = path.join(userBaseDir(), "index.json")
  const current = await readBaseIndex(target)
  if (!(id in current)) return
  delete current[id]
  await Bun.write(target, `${JSON.stringify(current, undefined, 2)}\n`)
}

async function readBaseIndex(target: string): Promise<Record<string, string>> {
  const file = Bun.file(target)
  if (!(await file.exists())) return {}
  try {
    const parsed: unknown = await file.json()
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
    const entries = Object.entries(parsed as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    )
    return Object.fromEntries(entries)
  } catch {
    return {}
  }
}
