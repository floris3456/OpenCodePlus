// The tools each MCP server registered when Plus last saw it connected.
//
// A server's tools join core's tool registry only after it connects, which is
// after Plus's first discovery. Until a discovery lists them they have no
// rows, so an agent's "off" row denies nothing, and a chat whose first request
// comes before that discovery gets them in its catalog for good (the first
// catalog is the chat's instruction baseline). Discovery therefore lists, for
// an enabled server that has registered nothing yet, the tools it registered
// last time: their rows and denials exist from the first publish. Plus's own
// search server is known from its source before it ever ran. When the server
// registers, the registry watcher (index.ts watchToolRegistry) republishes
// with what it actually registered, and that is what is remembered next.
import type { Mcp } from "@opencode/schema/mcp"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Product } from "@opencode/util/product"
import { searchTools } from "../search/tools.js"

export interface KnownMcpTool {
  readonly name: string
  readonly description: string
  readonly input: unknown
}

/** Server name → the tools it registered. */
export type KnownMcpTools = ReadonlyMap<string, readonly KnownMcpTool[]>

type RegistryTool = Tool.Info & { readonly id: string }

export function knownMcpToolsPath(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  if (Product.namespace === "opencodeplus") return path.join(base, Product.namespace, "mcp-tools.json")
  return path.join(base, Product.namespace, "opencodeplus", "mcp-tools.json")
}

export async function loadKnownMcpTools(file: string = knownMcpToolsPath()): Promise<Map<string, readonly KnownMcpTool[]>> {
  const stored: unknown = await Bun.file(file).json().catch(() => undefined)
  if (typeof stored !== "object" || stored === null || Array.isArray(stored)) return new Map()
  return new Map(
    Object.entries(stored).flatMap(([server, tools]): [string, KnownMcpTool[]][] =>
      Array.isArray(tools) ? [[server, tools.filter(isKnownTool)]] : [],
    ),
  )
}

export async function saveKnownMcpTools(known: KnownMcpTools, file: string = knownMcpToolsPath()): Promise<void> {
  await fs.mkdir(path.dirname(file), { recursive: true })
  const temporary = `${file}.${process.pid}.tmp`
  await Bun.write(temporary, JSON.stringify(Object.fromEntries(known), null, 2))
  await fs.rename(temporary, file)
}

/**
 * What is known after this registry: every server with registered tools
 * replaces its entry with them. Undefined when nothing changed.
 */
export function learnMcpTools(known: KnownMcpTools, registry: readonly RegistryTool[]): Map<string, readonly KnownMcpTool[]> | undefined {
  const seen = new Map<string, KnownMcpTool[]>()
  for (const tool of registry) {
    if (tool.origin?.type !== "mcp") continue
    seen.set(tool.origin.name, [...(seen.get(tool.origin.name) ?? []), { name: tool.name, description: tool.description, input: tool.input }])
  }
  const changed = [...seen].filter(([server, tools]) => JSON.stringify(known.get(server)) !== JSON.stringify(tools))
  if (changed.length === 0) return undefined
  return new Map([...known, ...changed])
}

/**
 * Registry entries for the tools of enabled servers that have registered
 * none yet, from what is known about them. Never executed: discovery reads
 * them for rows only, and the server's own registration replaces them.
 */
export function pendingMcpTools(
  registry: readonly RegistryTool[],
  servers: readonly (readonly [string, Mcp.ServerConfig])[],
  known: KnownMcpTools,
): RegistryTool[] {
  const registered = new Set(registry.flatMap((tool) => (tool.origin?.type === "mcp" ? [tool.origin.name] : [])))
  return servers.flatMap(([server, config]) => {
    if (config.disabled === true || registered.has(server)) return []
    const tools = known.get(server) ?? (ownSearchServer(config) ? searchTools.map((tool) => ({ ...tool, input: {} })) : [])
    const namespace = sanitize(server)
    return tools.map(
      (tool): RegistryTool => ({
        // core's McpTool: registry id and permission action `<namespace>_<tool>`.
        id: `${namespace}_${sanitize(tool.name)}`,
        name: tool.name,
        description: tool.description,
        input: tool.input as Tool.Info["input"],
        options: { namespace, codemode: config.codemode !== false },
        origin: { type: "mcp", name: server },
        execute: () => Effect.fail(new Tool.Error({ message: `MCP server "${server}" has not connected yet` })),
      }),
    )
  })
}

// Plus writes its search server's config with its keys directory; a user's own
// "search" server is not Plus's and is only known once it has connected.
function ownSearchServer(config: Mcp.ServerConfig): boolean {
  return config.type === "local" && config.environment?.OPENCODEPLUS_SEARCH_KEYS_DIR !== undefined
}

// core's McpTool.namespace and tool name sanitising.
function sanitize(value: string): string {
  return value.replace(/[^a-zA-Z0-9_-]/g, "_")
}

function isKnownTool(value: unknown): value is KnownMcpTool {
  if (typeof value !== "object" || value === null) return false
  const tool = value as Record<string, unknown>
  return typeof tool.name === "string" && typeof tool.description === "string"
}
