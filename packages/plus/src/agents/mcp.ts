import fs from "node:fs/promises"
import path from "node:path"

export interface McpSuccess {
  readonly ok: true
  readonly name: string
}

export interface McpExists {
  readonly ok: false
  readonly reason: "exists"
  readonly name: string
}

export interface McpMissing {
  readonly ok: false
  readonly reason: "missing"
  readonly name: string
}

export interface McpInvalid {
  readonly ok: false
  readonly reason: "invalid"
  readonly name: string
  readonly message: string
}

export type McpAddResult = McpSuccess | McpExists | McpInvalid
export type McpRemoveResult = McpSuccess | McpMissing | McpInvalid

export function validateMcpName(raw: string): { ok: true; name: string } | { ok: false; reason: string } {
  const name = raw.trim()
  if (name.length === 0) return { ok: false, reason: "MCP server name cannot be empty" }
  if (name.includes("/") || name.includes("\\") || name.includes("\0"))
    return { ok: false, reason: `Invalid MCP server name "${name}": path separators are not allowed` }
  if (name === "." || name === "..") return { ok: false, reason: `Invalid MCP server name "${name}"` }
  return { ok: true, name }
}

// The project's own OpenCode config file: the first readable
// <project>/.opencode/opencode.{json,jsonc} (json preferred), else a new
// opencode.json. Discover reads servers from this file through the merged
// config, so add/remove here is what the next discover observes.
export function projectConfigPath(projectDirectory: string): string {
  return path.join(projectDirectory, ".opencode", "opencode.json")
}

export function validateMcpConfig(config: Record<string, unknown>): { ok: true } | { ok: false; reason: string } {
  if (config.type !== "local" && config.type !== "remote")
    return { ok: false, reason: `Invalid MCP config: type must be "local" or "remote"` }
  if (config.type === "local") {
    if (!Array.isArray(config.command) || config.command.length === 0 || config.command.some((part) => typeof part !== "string"))
      return { ok: false, reason: `Invalid MCP config: local servers need a non-empty string command array` }
    return { ok: true }
  }
  if (typeof config.url !== "string" || config.url.length === 0)
    return { ok: false, reason: `Invalid MCP config: remote servers need a url` }
  return { ok: true }
}

export async function addMcp(input: {
  projectDirectory: string
  name: string
  config: Record<string, unknown>
}): Promise<McpAddResult> {
  const validated = validateMcpName(input.name)
  if (!validated.ok) return { ok: false, reason: "invalid", name: input.name, message: validated.reason }
  const configCheck = validateMcpConfig(input.config)
  if (!configCheck.ok) return { ok: false, reason: "invalid", name: validated.name, message: configCheck.reason }
  const target = await resolveProjectConfig(input.projectDirectory)
  const document = await readDocument(target)
  const servers = serversOf(document)
  if (Object.hasOwn(servers, validated.name)) return { ok: false, reason: "exists", name: validated.name }
  servers[validated.name] = { ...input.config }
  await writeDocument(target, document)
  return { ok: true, name: validated.name }
}

export async function removeMcp(input: { projectDirectory: string; name: string }): Promise<McpRemoveResult> {
  const validated = validateMcpName(input.name)
  if (!validated.ok) return { ok: false, reason: "invalid", name: input.name, message: validated.reason }
  const target = await resolveProjectConfig(input.projectDirectory)
  const document = await readDocument(target)
  const servers = serversOf(document)
  if (!Object.hasOwn(servers, validated.name)) return { ok: false, reason: "missing", name: validated.name }
  delete servers[validated.name]
  await writeDocument(target, document)
  return { ok: true, name: validated.name }
}

async function resolveProjectConfig(projectDirectory: string): Promise<string> {
  const root = path.resolve(projectDirectory)
  for (const name of ["opencode.json", "opencode.jsonc"]) {
    const candidate = path.join(root, ".opencode", name)
    if (await Bun.file(candidate).exists()) return candidate
  }
  return path.join(root, ".opencode", "opencode.json")
}

async function readDocument(target: string): Promise<Record<string, unknown>> {
  const file = Bun.file(target)
  if (!(await file.exists())) return {}
  const text = await file.text()
  if (text.trim().length === 0) return {}
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}
    return parsed as Record<string, unknown>
  } catch {
    return {}
  }
}

function serversOf(document: Record<string, unknown>): Record<string, unknown> {
  const mcp = document.mcp
  if (typeof mcp !== "object" || mcp === null || Array.isArray(mcp)) {
    const servers: Record<string, unknown> = {}
    document.mcp = { servers }
    return servers
  }
  const holder = mcp as Record<string, unknown>
  const servers = holder.servers
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    const fresh: Record<string, unknown> = {}
    holder.servers = fresh
    return fresh
  }
  return servers as Record<string, unknown>
}

async function writeDocument(target: string, document: Record<string, unknown>): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, `${JSON.stringify(document, undefined, 2)}\n`)
}
