import path from "node:path"
import { Schema } from "effect"
import type { RunRecord } from "./run.js"
import { readJson } from "./store.js"
import { toolError } from "./schema.js"
import { editRefusal, type PermissionTable } from "../instructions/permission-enforce.js"

const Scope = Schema.Struct({ paths: Schema.Array(Schema.String), forbidden: Schema.Array(Schema.String) })
export type RunScope = typeof Scope.Type

export function isScopePath(candidate: string): boolean {
  const base = candidate.endsWith("/*") ? candidate.slice(0, -2) : candidate
  return base.length > 0 && !path.isAbsolute(base) && !base.endsWith("/") &&
    !base.split("/").some((part) => part === "." || part === ".." || part === "" || [".git", ".cairn", ".beads", ".opencodeplus"].includes(part)) &&
    !/[?*\[\]\\\u0000]/.test(base)
}

export async function runScope(root: string, run: RunRecord): Promise<RunScope> {
  const brief = await readJson<{ scope?: unknown }>(path.join(root, "runs", run.id, "brief.json"))
  // Older runs retain their positive scope in run.json. Exclusions, when a
  // brief exists, always come from that authoritative admission payload.
  const scope = Schema.decodeUnknownSync(Scope)(brief?.scope ?? { paths: run.paths, forbidden: [] })
  if (![...scope.paths, ...scope.forbidden].every(isScopePath))
    throw toolError("E_SCOPE", `Run ${run.id} has an invalid stored scope; delegate fresh from current parent.`)
  return scope
}

/** A path no run may commit: protected state (.git, .opencodeplus, …), a glob, or one leaving the checkout. */
export function protectedStateRefusal(file: string): string | undefined {
  if (!isScopePath(file) || file.includes("*"))
    return `"${file}" is protected state or not a plain repository-relative path.`
  return undefined
}

// A chat run commits what its agent may edit; the refusal names the edit row.
export function chatEditRefusal(
  table: PermissionTable | undefined,
  agent: string,
  directory: string,
  file: string,
): string | undefined {
  const refusal = editRefusal(table, agent, directory, file)
  return refusal === undefined ? undefined : `"${file}" is not a file ${agent} may edit: ${refusal}`
}

export function scopeRefusal(scope: RunScope, file: string): string | undefined {
  const matches = (pattern: string) => pattern.endsWith("/*")
    ? file === pattern.slice(0, -2) || file.startsWith(`${pattern.slice(0, -2)}/`)
    : file === pattern
  if (!isScopePath(file) || file.includes("*") || scope.forbidden.some(matches))
    return `"${file}" is forbidden by this run's scope or is protected state. Report it in needs=[{kind:"path"...}].`
  if (!scope.paths.some(matches))
    return `"${file}" is outside your scope.paths [${scope.paths.join(", ")}]. Report it in needs=[{kind:"path"...}].`
  return undefined
}
