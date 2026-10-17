import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import { userSystemDir, userSystemFile } from "../instructions/paths.js"
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
}

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

export async function createSystemRow(id: string, title: string, text: string): Promise<SystemRowResult> {
  const validated = validateSystemId(id)
  if (!validated.ok) return { ok: false, reason: "invalid", id, message: validated.reason }
  const target = userSystemFile(validated.id)
  if (await Bun.file(target).exists()) return { ok: false, reason: "exists", id: validated.id }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, text)
  await writeIndexEntry(userSystemDir(), validated.id, title.trim().length === 0 ? validated.id : title.trim())
  return { ok: true, id: validated.id }
}

export async function deleteSystemRow(id: string): Promise<SystemRowDeleteResult> {
  const validated = validateSystemId(id)
  if (!validated.ok) return { ok: false, reason: "invalid", id, message: validated.reason }
  const target = userSystemFile(validated.id)
  if (!(await Bun.file(target).exists())) return { ok: false, reason: "missing", id: validated.id }
  await fs.rm(target, { force: true })
  await removeIndexEntry(userSystemDir(), validated.id)
  return { ok: true, id: validated.id }
}

// Synchronous like the base template read: discovery awaits it, and the
// directory is tiny. A missing directory means no rows.
export function readUserSystemRowsSync(): UserSystemRow[] {
  const dir = userSystemDir()
  const entries = (() => {
    try {
      return fsSync.readdirSync(dir)
    } catch {
      return []
    }
  })()
  return entries
    .filter((entry) => entry.endsWith(".md") && validateSystemId(entry.slice(0, -".md".length)).ok)
    .toSorted()
    .flatMap((entry) => {
      const id = entry.slice(0, -".md".length)
      const text = readUserBaseTextSync(path.join(dir, entry))
      if (text === undefined) return []
      return [{ id, title: readUserBaseTitleSync(path.join(dir, "index.json"), id, id), text }]
    })
}
