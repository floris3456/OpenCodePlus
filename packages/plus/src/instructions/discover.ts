import type { Context } from "@opencode/plugin/effect/plugin"
import type { Transform } from "@opencode/plugin/effect/registration"
import type { Agent } from "@opencode/schema/agent"
import type { Mcp } from "@opencode/schema/mcp"
import type { Skill } from "@opencode/schema/skill"
import type { Tool } from "@opencode/schema/tool"
import { Deferred, Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { fingerprint, type Customization, type Item, type Snapshot } from "./model.js"
import { idFromPath } from "../agents/files.js"
import { isSkillCopy } from "./apply.js"

export type AgentScope = "project" | "global" | "builtin"

export interface AgentSource {
  readonly id: string
  readonly scope: AgentScope
  readonly path?: string
}

export interface PromptBaseline {
  readonly applied: string
  readonly upstream: string
  readonly file?: string
  readonly fileBacked: boolean
}

export interface ToolSource {
  readonly id: string
  readonly native: boolean
}

export interface Discovered {
  readonly snapshot: Snapshot
  readonly agents: AgentSource[]
  readonly tools: ToolSource[]
  readonly files: ReadonlyMap<string, string>
}

export async function discover(
  ctx: Context,
  stored: { revision: number; customizations: Customization[] },
  baselines: ReadonlyMap<string, PromptBaseline> = new Map(),
): Promise<Discovered> {
  const agents = yieldList(ctx.agent.list())
  const skills = yieldList(ctx.skill.list())
  const tools = await readTransform(ctx.tool.transform, (editor) => editor.list())
  const servers = await readTransform(ctx.mcp.transform, (editor) => editor.list())
  const resolvedAgents = await agents
  const sources = await resolveAgentSources(ctx.location.directory, resolvedAgents)
  const files = await readAgentBodies(sources)
  const instructions = await readProjectInstructions(ctx.location.directory)
  const toolSources = toolSourcesFor(tools)
  const items = [
    ...promptItems(resolvedAgents, baselines, files),
    ...skillItems(await skills),
    ...toolItems(tools),
    ...mcpItems(servers, stored.customizations),
    ...instructionItems(ctx.location.directory, instructions),
  ]
  return {
    snapshot: { revision: stored.revision, items, customizations: stored.customizations },
    agents: sources,
    tools: toolSources,
    files,
  }
}

async function yieldList<Data>(list: Effect.Effect<{ data: Data }, unknown, never>): Promise<Data> {
  return Effect.runPromise(list).then((output) => output.data)
}

function readTransform<Editor, Value>(
  transform: Transform<Editor>,
  read: (editor: Editor) => Value,
): Promise<Value> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<Value, never>()
        yield* transform((editor) => {
          Deferred.doneUnsafe(deferred, Effect.succeed(read(editor)))
        })
        return yield* Deferred.await(deferred)
      }),
    ),
  )
}

// Agent.Info carries no source path and the plugin context has no config
// domain, so scope is derived from the markdown files that define agents:
// project files live under <directory>/.opencode/{agent,agents}/**/*.md and
// global files under the same patterns beneath the global config dir. The
// agent id is the path relative to the agent directory without the .md
// suffix, matching core's decode; an agent with no matching file is
// builtin/plugin-provided and is not file-backed.
async function resolveAgentSources(directory: string, agents: readonly Agent.Info[]): Promise<AgentSource[]> {
  const project = await scanAgentFiles(path.join(directory, ".opencode"))
  const global = await scanAgentFiles(globalConfigDir())
  return agents.map((agent) => sourceFor(agent.id, project, global))
}

function sourceFor(id: string, project: Map<string, string>, global: Map<string, string>): AgentSource {
  const projectPath = project.get(id)
  if (projectPath !== undefined) return { id, scope: "project", path: projectPath }
  const globalPath = global.get(id)
  if (globalPath !== undefined) return { id, scope: "global", path: globalPath }
  return { id, scope: "builtin" }
}

async function scanAgentFiles(root: string): Promise<Map<string, string>> {
  const found = new Map<string, string>()
  for (const name of ["agent", "agents"]) {
    const directory = path.join(root, name)
    const entries = await scanMarkdown(directory)
    for (const file of entries) {
      const id = idFromPath(directory, file)
      if (!found.has(id)) found.set(id, file)
    }
  }
  return found
}

async function scanMarkdown(directory: string): Promise<string[]> {
  const entries = await readDirectory(directory)
  const nested = await Promise.all(
    entries.map((entry) => (entry.directory ? scanMarkdown(entry.path) : Promise.resolve([entry.path]))),
  )
  return nested.flat().toSorted()
}

interface DirectoryEntry {
  readonly path: string
  readonly directory: boolean
}

async function readDirectory(directory: string): Promise<DirectoryEntry[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => undefined)
  if (!entries) return []
  return entries.flatMap((entry): DirectoryEntry[] => {
    if (entry.isDirectory()) return [{ path: path.join(directory, entry.name), directory: true }]
    if (entry.isFile() && entry.name.endsWith(".md"))
      return [{ path: path.join(directory, entry.name), directory: false }]
    return []
  })
}

// Mirrors the global config resolution in @opencode/util without importing it:
// an explicit OPENCODE_CONFIG_DIR override, else <XDG_CONFIG_HOME>/opencode,
// else ~/.config/opencode.
function globalConfigDir(): string {
  const override = process.env.OPENCODE_CONFIG_DIR
  if (override) return override
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "opencode")
}

function promptItems(
  agents: readonly Agent.Info[],
  baselines: ReadonlyMap<string, PromptBaseline>,
  files: ReadonlyMap<string, string>,
): Item[] {
  return agents.map((agent) => {
    const text = upstreamPrompt(agent, baselines.get(agent.id), files.get(agent.id))
    return item(`prompt:${agent.id}`, "prompt", agent.id, agent.name, text, [agent.id])
  })
}

// ctx.agent.list() returns the currently applied system prompt, which includes
// Plus's own transform output once a prompt override is installed. Reporting
// that output as the upstream item text would flip the publish fingerprint on
// every pass and pin promptUpdates' skip check (resolved.text === item.text),
// producing a permanent dispose/reinstall storm. While the host still shows
// exactly what Plus last wrote, unmask the upstream text independently of the
// post-transform host view: file-backed agents reread their markdown body
// (core decodes it as `system: body`), and builtin agents without a backing
// file retain the existing baseline behaviour. Unmasked host text means no
// override is installed for that agent, so it flows through untouched. A file
// body is only trusted when it matched the host upstream at baseline time;
// otherwise another config source owns the prompt and the file is ignored to
// avoid a spurious fingerprint change. A file appearing where the baseline had
// none is a source transition: the new body re-establishes ownership instead
// of being rejected against the stale builtin upstream.
function upstreamPrompt(agent: Agent.Info, baseline: PromptBaseline | undefined, fileBody: string | undefined): string {
  const current = agent.system ?? ""
  if (baseline === undefined) return current
  if (current !== baseline.applied) return current
  if (fileBody === undefined) return baseline.upstream
  if (!baseline.fileBacked) return fileBody
  if (baseline.file === undefined) return baseline.upstream
  if (baseline.file !== baseline.upstream) return baseline.upstream
  return fileBody
}

// Core decodes a file-backed agent as `{...frontmatter, system: body}`, where
// body is the markdown content after the frontmatter block, trimmed (see
// core/src/config/plugin/agent.ts decode: `body = markdown.content.trim()`).
// Reread that body from the resolved source files so discovery observes
// upstream prompt edits even while Plus's transform masks the host view. The
// frontmatter fence mirrors gray-matter: an opening `---` line, a closing
// `---` line, then the body. Files without a valid fence are body-only.
async function readAgentBodies(sources: readonly AgentSource[]): Promise<Map<string, string>> {
  const bodies = new Map<string, string>()
  const texts = await Promise.all(sources.map((source) => (source.path === undefined ? undefined : readText(source.path))))
  sources.forEach((source, index) => {
    const text = texts[index]
    if (text === undefined) return
    bodies.set(source.id, agentBody(text))
  })
  return bodies
}

export function agentBody(markdown: string): string {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/)
  if (!match) return markdown.trim()
  return (match[2] ?? "").trim()
}

function skillItems(skills: readonly Skill.Info[]): Item[] {
  return skills
    .filter((skill) => !isSkillCopy(skill.id))
    .map((skill) => item(`skill:${skill.id}`, "skill", skill.id, skill.name, skill.content, []))
}

function toolItems(tools: readonly (Tool.Info & { readonly id: string })[]): Item[] {
  return tools.map((tool) => item(`tool:${tool.id}`, "tool", tool.id, tool.name, tool.description, []))
}

// Same rule as apply.ts readTools: only tools with options.codemode === false
// are individual keys of the session tool list. Everything else (codemode
// enabled or absent — the Code Mode inventory surfaced through execute) cannot
// be toggled or edited, so tree.ts marks those rows non-actionable.
function toolSourcesFor(tools: readonly (Tool.Info & { readonly id: string })[]): ToolSource[] {
  return tools.map((tool) => ({ id: tool.id, native: tool.options?.codemode === false }))
}

// Discovery reads config through Plus's own transform, so `config.disabled` reflects
// post-transform state rather than raw upstream. Upstream availability must reconstruct
// the pre-transform value by removing Plus's own known contribution: if a shared
// (`agent: "*"`) record for that item says `disabled`, upstream must have been enabled, so
// `true`; if it says `enabled`, upstream must have been disabled, so `false`; otherwise
// `config.disabled !== true`. This inference is load-bearing: otherwise a disabled server
// would report `available: false`, `mcpUpdates` would short-circuit on `enabled === item.available`,
// the disable would silently stop being reinstalled on the next publish, and `effective()`
// would report `customized: false` so the user could not undo it. Serializing the item text
// from a copy without `disabled` ensures the fingerprint never incorporates Plus's own
// enablement contribution.
function mcpItems(servers: readonly [string, Mcp.ServerConfig][], customizations: readonly Customization[]): Item[] {
  return servers.map(([name, config]) => {
    const id = `mcp:${name}`
    const available = upstreamMcpAvailable(id, config, customizations)
    const sanitized = { ...config }
    delete (sanitized as { disabled?: boolean }).disabled
    return item(id, "mcp", name, name, JSON.stringify(sanitized), [], available)
  })
}

function upstreamMcpAvailable(
  id: string,
  config: Mcp.ServerConfig,
  customizations: readonly Customization[],
): boolean {
  const shared = customizations.find((record) => record.item === id && record.agent === "*")
  if (shared?.state === "disabled") return true
  if (shared?.state === "enabled") return false
  return config.disabled !== true
}

async function readProjectInstructions(directory: string): Promise<{ path: string; text: string }[]> {
  const candidates = await walkInstructionFiles(directory)
  const texts = await Promise.all(candidates.map((file) => readText(file)))
  return candidates.flatMap((file, index) => {
    const text = texts[index]
    if (text === undefined) return []
    return [{ path: file, text }]
  })
}

async function walkInstructionFiles(directory: string): Promise<string[]> {
  const entries = await fs.readdir(directory, { withFileTypes: true }).catch(() => undefined)
  if (!entries) return []
  const nested = await Promise.all(
    entries.flatMap((entry) => {
      if (entry.name === "node_modules" || entry.name === ".git") return []
      const full = path.join(directory, entry.name)
      if (entry.isDirectory()) return [walkInstructionFiles(full)]
      if (entry.isFile() && entry.name === "AGENTS.md") return [Promise.resolve([full])]
      return []
    }),
  )
  return nested.flat().toSorted()
}

async function readText(file: string): Promise<string | undefined> {
  return fs.readFile(file, "utf8").catch(() => undefined)
}

function instructionItems(directory: string, files: { path: string; text: string }[]): Item[] {
  return files.map((file) => {
    const owner = path.relative(directory, file.path) || file.path
    return item(`instruction:${owner}`, "instruction", owner, owner, file.text, [])
  })
}

function item(
  id: string,
  kind: Item["kind"],
  owner: string,
  title: string,
  text: string,
  agents: string[],
  available = true,
): Item {
  return { id, kind, owner, title, text, agents, fingerprint: fingerprint(text), available }
}
