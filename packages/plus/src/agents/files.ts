import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type Scope = "project" | "global"

export interface AgentPermissionRule {
  action: string
  resource: string
  effect: "allow" | "deny" | "ask"
}

export interface AgentFields {
  model?: string
  variant?: string
  request?: Record<string, unknown>
  description?: string
  mode?: "subagent" | "primary" | "all"
  hidden?: boolean
  color?: string
  steps?: number
  disabled?: boolean
  permissions?: readonly AgentPermissionRule[]
}

export interface CreateInput {
  scope: Scope
  projectDirectory: string
  id: string
  fields?: AgentFields
  prompt: string
}

export interface CreateSuccess {
  ok: true
  path: string
}

export interface CreateAlreadyExists {
  ok: false
  reason: "already-exists"
  path: string
}

export type CreateResult = CreateSuccess | CreateAlreadyExists

export interface RenameInput {
  scope: Scope
  projectDirectory: string
  from: string
  to: string
}

export interface RenameSuccess {
  ok: true
  fromPath: string
  toPath: string
}

export interface RenameMissingSource {
  ok: false
  reason: "missing-source"
  path: string
}

export interface RenameAlreadyExists {
  ok: false
  reason: "already-exists"
  path: string
}

export type RenameResult = RenameSuccess | RenameMissingSource | RenameAlreadyExists

export interface RemoveInput {
  scope: Scope
  projectDirectory: string
  id: string
}

export interface RemoveSuccess {
  ok: true
  path: string
}

export type RemoveResult = RemoveSuccess

const ALLOWED_KEYS = [
  "model",
  "variant",
  "request",
  "description",
  "mode",
  "hidden",
  "color",
  "steps",
  "disabled",
  "permissions",
] as const

export async function resolveDirectory(scope: Scope, projectDirectory: string): Promise<string> {
  const base = configDirectory(scope, projectDirectory)
  const agentsDir = path.join(base, "agents")
  if (await isDirectory(agentsDir)) return agentsDir
  return path.join(base, "agent")
}

export async function agentPath(scope: Scope, projectDirectory: string, id: string): Promise<string> {
  const dir = await resolveDirectory(scope, projectDirectory)
  return confinedPath(dir, id)
}

export function validateAgentId(raw: string): { ok: true; id: string } | { ok: false; reason: string } {
  const id = raw.trim()
  if (id.length === 0) return { ok: false, reason: "Agent id cannot be empty" }
  if (id.includes("\\"))
    return { ok: false, reason: `Invalid agent id "${id}": backslashes are not allowed (use / for nesting)` }
  if (id.includes("\0")) return { ok: false, reason: `Invalid agent id "${id}": null bytes are not allowed` }
  const segments = id.split("/")
  if (segments.some((segment) => segment.length === 0))
    return {
      ok: false,
      reason: `Invalid agent id "${id}": empty path segment (check for leading, trailing, or double slashes)`,
    }
  if (segments.some((segment) => segment === "." || segment === ".."))
    return { ok: false, reason: `Invalid agent id "${id}": "." and ".." segments are not allowed` }
  if (/^(agent|agents|mode|modes)\//.test(id))
    return {
      ok: false,
      reason: `Invalid agent id "${id}": ids starting with agent/, agents/, mode/ or modes/ do not round-trip`,
    }
  return { ok: true, id }
}

export function idFromPath(directory: string, filepath: string): string {
  return path
    .relative(directory, filepath)
    .replaceAll("\\", "/")
    .replace(/^(agent|agents|mode|modes)\//, "")
    .replace(/\.md$/, "")
}

export async function create(input: CreateInput): Promise<CreateResult> {
  const target = await agentPath(input.scope, input.projectDirectory, input.id)
  const file = Bun.file(target)
  if (await file.exists()) return { ok: false, reason: "already-exists", path: target }
  await fs.mkdir(path.dirname(target), { recursive: true })
  const content = formatMarkdown(input.fields, input.prompt)
  await Bun.write(target, content)
  return { ok: true, path: target }
}

export async function rename(input: RenameInput): Promise<RenameResult> {
  const fromPath = await existingAgentPath(input.scope, input.projectDirectory, input.from)
  const toPath = await agentPath(input.scope, input.projectDirectory, input.to)
  const source = Bun.file(fromPath)
  if (!(await source.exists())) return { ok: false, reason: "missing-source", path: fromPath }
  const dest = Bun.file(toPath)
  if (await dest.exists()) return { ok: false, reason: "already-exists", path: toPath }
  await fs.mkdir(path.dirname(toPath), { recursive: true })
  await fs.rename(fromPath, toPath)
  return { ok: true, fromPath, toPath }
}

export async function remove(input: RemoveInput): Promise<RemoveResult> {
  const target = await existingAgentPath(input.scope, input.projectDirectory, input.id)
  const file = Bun.file(target)
  if (await file.exists()) {
    await fs.rm(target, { force: true })
  }
  return { ok: true, path: target }
}

// Discovery scans agent/ before agents/; operations on an existing id must
// resolve the same file instead of following resolveDirectory's creation
// preference for agents/.
async function existingAgentPath(scope: Scope, projectDirectory: string, id: string): Promise<string> {
  const base = configDirectory(scope, projectDirectory)
  for (const name of ["agent", "agents"]) {
    const candidate = confinedPath(path.join(base, name), id)
    if (await Bun.file(candidate).exists()) return candidate
  }
  return confinedPath(await resolveDirectory(scope, projectDirectory), id)
}

function confinedPath(directory: string, id: string): string {
  const root = path.resolve(directory)
  const resolved = path.resolve(root, `${id}.md`)
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) throw new Error(`Invalid agent id "${id}"`)
  return resolved
}

export function formatMarkdown(fields: AgentFields | undefined, prompt: string): string {
  const frontmatter = serializeFrontmatter(fields)
  if (frontmatter.length === 0) return prompt
  return `---\n${frontmatter}\n---\n${prompt}`
}

export function serializeFrontmatter(fields?: AgentFields): string {
  if (!fields) return ""
  const lines: string[] = []
  for (const key of ALLOWED_KEYS) {
    const value = fields[key]
    if (value === undefined) continue
    if (key === "permissions") {
      if (Array.isArray(value)) {
        lines.push(...serializePermissions(value))
      }
      continue
    }
    if (key === "request") {
      if (isRecord(value)) {
        lines.push("request:")
        lines.push(...serializeObject(value, "  "))
      }
      continue
    }
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
      lines.push(`${key}: ${serializeYamlScalar(value)}`)
    }
  }
  return lines.join("\n")
}

function configDirectory(scope: Scope, projectDirectory: string): string {
  if (scope === "global") {
    return (
      process.env.OPENCODE_CONFIG_DIR ??
      path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config"), "opencode")
    )
  }
  return path.join(projectDirectory, ".opencode")
}

async function isDirectory(target: string): Promise<boolean> {
  const stat = await fs.stat(target).catch(() => undefined)
  return stat !== undefined && stat.isDirectory()
}

function serializePermissions(rules: readonly AgentPermissionRule[]): string[] {
  if (rules.length === 0) return ["permissions: []"]
  const lines: string[] = ["permissions:"]
  for (const rule of rules) {
    lines.push(`  - action: ${serializeYamlScalar(rule.action)}`)
    lines.push(`    resource: ${serializeYamlScalar(rule.resource)}`)
    lines.push(`    effect: ${serializeYamlScalar(rule.effect)}`)
  }
  return lines
}

function serializeObject(obj: Record<string, unknown>, indent: string): string[] {
  const lines: string[] = []
  const keys = Object.keys(obj).sort()
  for (const key of keys) {
    const val = obj[key]
    if (val === undefined) continue
    if (isRecord(val)) {
      lines.push(`${indent}${key}:`)
      lines.push(...serializeObject(val, `${indent}  `))
      continue
    }
    if (typeof val === "string" || typeof val === "number" || typeof val === "boolean") {
      lines.push(`${indent}${key}: ${serializeYamlScalar(val)}`)
    }
  }
  return lines
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

function serializeYamlScalar(value: string | number | boolean): string {
  if (typeof value === "boolean") return value ? "true" : "false"
  if (typeof value === "number") return value.toString()
  return serializeYamlString(value)
}

function serializeYamlString(value: string): string {
  if (value === "") return '""'
  const isReserved = /^(true|false|yes|no|on|off|null|~)$/i.test(value)
  const isNumber = /^[+-]?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(value) || /^0[xob][0-9a-fA-F]+$/.test(value)
  const isSafe = /^[a-zA-Z0-9_\-\./]+$/.test(value) && !value.startsWith("-") && !isReserved && !isNumber
  if (isSafe) return value
  return JSON.stringify(value)
}
