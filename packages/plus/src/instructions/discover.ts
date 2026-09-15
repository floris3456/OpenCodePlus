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
import { idFromPath } from "../agents/files.js"
import { unmaskText, upstreamEnabled, type PromptBaseline } from "./inventory.js"
import {
  fingerprint,
  isCodeModeToolEntry,
  type AgentSource,
  type CustomizationRecord,
  type Item,
} from "./model.js"
import { globalConfigDir, teachingFilePath, teachingItemId, teachingSkillId } from "./paths.js"

export type { AgentScope, AgentSource } from "./model.js"
export type { PromptBaseline } from "./inventory.js"

export interface Discovered {
  readonly items: Item[]
  readonly agents: AgentSource[]
  readonly servers: { readonly name: string; readonly enabled: boolean }[]
  /** Markdown bodies reread from the resolved agent source files, by agent id. Exported so baseline capture can record the baseline-time body. */
  readonly bodies: ReadonlyMap<string, string>
}

export interface BaseTemplate {
  readonly id: string
  readonly title: string
  readonly text: string
  /** True when the template came from the user base directory (provenance known by the caller). */
  readonly user?: boolean
}

export interface DiscoverInput {
  readonly ctx: Context
  readonly records: readonly CustomizationRecord[]
  readonly baselines?: ReadonlyMap<string, PromptBaseline>
  /** Injected by the caller so discovery does not depend on where core exposes them. */
  readonly baseTemplates: readonly BaseTemplate[]
  /** Resolves the active template id for an agent, by that agent's configured model. */
  readonly activeBase: (agent: Agent.Info) => string | undefined
}

export async function discover(input: DiscoverInput): Promise<Discovered> {
  const directory = input.ctx.location.directory
  const projectDirectory = input.ctx.location.project.directory
  const agents = await yieldList(input.ctx.agent.list())
  const skills = await yieldList(input.ctx.skill.list())
  const tools = await readTransform(input.ctx.tool.transform, (editor) => editor.list())
  const servers = await readTransform(input.ctx.mcp.transform, (editor) => editor.list())
  const baselines = input.baselines ?? new Map<string, PromptBaseline>()
  const sources = await resolveAgentSources(directory, agents, input.activeBase)
  const bodies = await readAgentBodies(sources)
  const instructions = await discoverInstructionFiles(directory, projectDirectory)
  const teaching = await readTeachingFile()
  const mcp = mcpInventory(servers, input.records)
  const items = [
    ...toolItems(tools, baselines),
    ...baseItems(input.baseTemplates),
    ...skillItems(skills, directory, baselines),
    ...roleItems(agents, baselines, bodies),
    ...instructionFileItems(directory, instructions),
    ...teachingItems(teaching, instructions.length),
    ...mcp.items,
  ]
  return { items, agents: sources, servers: mcp.servers, bodies }
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
// suffix, matching core's decode; an agent with no matching file is a
// defaults template and is not file-backed.
async function resolveAgentSources(
  directory: string,
  agents: readonly Agent.Info[],
  activeBase: (agent: Agent.Info) => string | undefined,
): Promise<AgentSource[]> {
  const project = await scanAgentFiles(path.join(directory, ".opencode"))
  const global = await scanAgentFiles(globalConfigDir())
  const effective = agents.map((agent) => withBase(sourceFor(agent.id, project, global), agent, activeBase))
  return [...effective, ...shadowedSources(effective, agents, project, global, activeBase)]
}

function withBase(
  source: AgentSource,
  agent: Agent.Info,
  activeBase: (agent: Agent.Info) => string | undefined,
): AgentSource {
  const base = activeBase(agent)
  if (base === undefined) return source
  return { ...source, base }
}

// Core's agent registry is keyed by id, so when the same id exists at more
// than one scope only the winner (project, then global, then defaults)
// reaches agent.list. The shadowed scope identities still own records:
// without their own AgentSource entries scopesOf omits them and the
// resolution chain silently skips that level. Re-add them here so
// project/A -> global/A -> defaults/A -> shared resolves as designed.
function shadowedSources(
  effective: readonly AgentSource[],
  agents: readonly Agent.Info[],
  project: ReadonlyMap<string, string>,
  global: ReadonlyMap<string, string>,
  activeBase: (agent: Agent.Info) => string | undefined,
): AgentSource[] {
  const present = (id: string, scope: AgentSource["scope"]): boolean =>
    effective.some((source) => source.id === id && source.scope === scope)
  return agents.flatMap((agent) => {
    const projectPath = project.get(agent.id)
    const globalPath = global.get(agent.id)
    const shadowed: AgentSource[] = []
    if (projectPath !== undefined && globalPath !== undefined && !present(agent.id, "global"))
      shadowed.push(withBase({ id: agent.id, scope: "global", path: globalPath }, agent, activeBase))
    if (present(agent.id, "defaults")) return shadowed
    if (projectPath === undefined && globalPath === undefined) return shadowed
    if (!builtinAgentIds.includes(agent.id)) return shadowed
    return [...shadowed, withBase({ id: agent.id, scope: "defaults" }, agent, activeBase)]
  })
}

// Agents core registers without backing files: core/src/plugin/agent.ts
// (build, general, explore, compaction, title, summary) and
// core/src/plugin/plan.ts (plan). A file with the same id shadows the
// builtin in core's id-keyed registry, so the defaults identity needs its
// own entry here. Keep in sync with core.
const builtinAgentIds = ["build", "general", "explore", "compaction", "title", "summary", "plan"]

function sourceFor(id: string, project: Map<string, string>, global: Map<string, string>): AgentSource {
  const projectPath = project.get(id)
  if (projectPath !== undefined) return { id, scope: "project", path: projectPath }
  const globalPath = global.get(id)
  if (globalPath !== undefined) return { id, scope: "global", path: globalPath }
  return { id, scope: "defaults" }
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

// Tool.Info gains `origin?: { type: "mcp" | "plugin"; name: string }` in a
// parallel core change. It is optional, so tolerate it being absent at
// runtime. Never infer the server from the sanitized namespace — the
// namespace rewrites characters (core's McpTool.namespace replaces every
// [^a-zA-Z0-9_-] with "_"), so two distinct servers can share one namespace
// and a rewritten name never round-trips.
interface ToolOrigin {
  readonly type: "mcp" | "plugin"
  readonly name: string
}

type ToolEntry = Tool.Info & { readonly id: string; readonly origin?: ToolOrigin }

function toolOrigin(tool: Tool.Info & { readonly id: string }): ToolOrigin | undefined {
  return (tool as ToolEntry).origin
}

function toolGroup(origin: ToolOrigin | undefined): { group: Item["group"]; server?: string } {
  if (origin?.type === "mcp") return { group: "mcp", server: origin.name }
  if (origin?.type === "plugin" && origin.name === "opencode.plus") return { group: "plus" }
  return { group: "native" }
}

function toolItems(
  tools: readonly (Tool.Info & { readonly id: string })[],
  baselines: ReadonlyMap<string, PromptBaseline>,
): Item[] {
  const rows = tools.map((tool): Item => {
    const id = `tool:${tool.id}`
    const grouped = toolGroup(toolOrigin(tool))
    const text = unmaskText(tool.description, baselines.get(id))
    return {
      id,
      kind: "tool",
      group: grouped.group,
      ...(grouped.server === undefined ? {} : { server: grouped.server }),
      title: tool.name,
      text,
      enabled: upstreamEnabled(),
      fingerprint: fingerprint(text),
      ...(tool.options?.namespace === undefined ? {} : { namespace: tool.options.namespace }),
      ...(tool.options?.pinned === undefined ? {} : { pinned: tool.options.pinned }),
      ...(isCodeModeToolEntry(tool) ? { codemode: true as const } : {}),
    }
  })
  return [...rows, executeItem()]
}

// The host-owned Code Mode entry point is synthesized by core's
// `Tool.snapshot`, never present in the tool registry, so discovery emits it
// as a synthetic row alongside the discovered tools.
function executeItem(): Item {
  const text = "Host-owned Code Mode entry point: runs JavaScript that calls the tools in the Code Mode catalog."
  return {
    id: "tool:execute",
    kind: "tool",
    group: "native",
    title: "execute",
    text,
    enabled: upstreamEnabled(),
    fingerprint: fingerprint(text),
    codemode: false as const,
    execute: true as const,
  }
}

function baseItems(templates: readonly BaseTemplate[]): Item[] {
  return templates.map((template): Item => {
    const id = `base:${template.id}`
    return {
      id,
      kind: "base",
      group: "none",
      title: template.title,
      text: template.text,
      enabled: upstreamEnabled(),
      fingerprint: fingerprint(template.text),
      ...(template.user === true ? { userBase: true as const } : {}),
    }
  })
}

// Base templates carry their provenance from the caller: `resolveBaseTemplates`
// marks user-directory entries, so discovery never guesses from the id.

function skillOrigin(skill: Skill.Info): ToolOrigin | undefined {
  return (skill as Skill.Info & { readonly origin?: ToolOrigin }).origin
}

function skillGroup(skill: Skill.Info, directory: string): { group: Item["group"]; server?: string } {
  // The teaching skill is Plus inventory, matched by its own id: an `origin`
  // field would not survive core's skill state (core/src/plugin/host.ts adds
  // through Schema.decodeUnknownSync(Skill.Info), which drops undeclared
  // keys), so classification cannot rely on it. teaching.test.ts pins both
  // the stripping and this fallback.
  if (skill.id === teachingSkillId) return { group: "plus" }
  const grouped = toolGroup(skillOrigin(skill))
  if (grouped.group !== "native") return grouped
  if (isProjectSkill(skill.location, directory)) return { group: "project" }
  return { group: "native" }
}

// A skill discovered from the project's own skill directory
// (<project>/.opencode/skill*/**/SKILL.md) is "project"; everything else
// without a known origin is "native".
function isProjectSkill(location: string, directory: string): boolean {
  const relative = path.relative(path.join(directory, ".opencode"), location)
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return false
  const first = relative.split(path.sep)[0]
  if (!first.startsWith("skill")) return false
  return path.basename(location) === "SKILL.md"
}

function skillItems(
  skills: readonly Skill.Info[],
  directory: string,
  baselines: ReadonlyMap<string, PromptBaseline>,
): Item[] {
  return skills
    .filter((skill) => !isSkillCopyId(skill.id))
    .map((skill): Item => {
      const id = `skill:${skill.id}`
      const grouped = skillGroup(skill, directory)
      const text = unmaskText(skill.content, baselines.get(id))
      return {
        id,
        kind: "skill",
        group: grouped.group,
        ...(grouped.server === undefined ? {} : { server: grouped.server }),
        title: skill.name,
        text,
        enabled: upstreamEnabled(),
        fingerprint: fingerprint(text),
      }
    })
}

function roleItems(
  agents: readonly Agent.Info[],
  baselines: ReadonlyMap<string, PromptBaseline>,
  bodies: ReadonlyMap<string, string>,
): Item[] {
  return agents.map((agent): Item => {
    const text = upstreamPrompt(agent, baselines.get(agent.id), bodies.get(agent.id))
    return {
      id: "system:role",
      kind: "system",
      group: "none",
      title: "Role/persona",
      text,
      enabled: upstreamEnabled(),
      fingerprint: fingerprint(text),
      agents: [agent.id],
      order: 0,
    }
  })
}

// ctx.agent.list() returns the currently applied system prompt, which includes
// Plus's own transform output once a prompt override is installed. Reporting
// that output as the upstream item text would flip the publish fingerprint on
// every pass and pin promptUpdates' skip check (resolved.text === item.text),
// producing a permanent dispose/reinstall storm. While the host still shows
// exactly what Plus last wrote, unmask the upstream text independently of the
// post-transform host view: file-backed agents reread their markdown body
// (core decodes it as `system: body`), and defaults agents without a backing
// file retain the existing baseline behaviour. Unmasked host text means no
// override is installed for that agent, so it flows through untouched. A file
// body is only trusted when it matched the host upstream at baseline time;
// otherwise another config source owns the prompt and the file is ignored to
// avoid a spurious fingerprint change. A file appearing where the baseline had
// none is a source transition: the new body re-establishes ownership instead
// of being rejected against the stale defaults upstream.
function upstreamPrompt(
  agent: Agent.Info,
  baseline: PromptBaseline | undefined,
  fileBody: string | undefined,
): string {
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

// Plus's private per-agent skill copies live under "plus/<agent>/<skill>";
// they are apply output, never inventory.
function isSkillCopyId(id: string): boolean {
  return id.startsWith("plus/")
}

interface McpInventory {
  readonly items: Item[]
  readonly servers: { readonly name: string; readonly enabled: boolean }[]
}

function mcpInventory(
  servers: readonly [string, Mcp.ServerConfig][],
  records: readonly CustomizationRecord[],
): McpInventory {
  const entries = servers.map(([name, config]) => {
    const id = `mcp:${name}`
    const enabled = upstreamMcpAvailable(id, config, records)
    const sanitized = { ...config }
    delete (sanitized as { disabled?: boolean }).disabled
    const text = JSON.stringify(sanitized)
    const item: Item = {
      id,
      kind: "mcp",
      group: "none",
      title: name,
      text,
      enabled,
      fingerprint: fingerprint(text),
    }
    return { item, server: { name, enabled } }
  })
  return { items: entries.map((entry) => entry.item), servers: entries.map((entry) => entry.server) }
}

// Discovery reads config through Plus's own transform, so `config.disabled`
// reflects post-transform state rather than raw upstream. Upstream
// availability must reconstruct the pre-transform value by removing Plus's
// own known contribution: if a shared (`level: "defaults"`, `agent: null`)
// record for that item says `off`, upstream must have been enabled, so
// `true`; if it says `on`, upstream must have been disabled, so `false`;
// otherwise `config.disabled !== true`. This inference is load-bearing:
// otherwise a disabled server would report `enabled: false`, `mcpUpdates`
// would short-circuit on `enabled === item.enabled`, the disable would
// silently stop being reinstalled on the next publish, and the tree would
// report no customization so the user could not undo it. Serializing the
// item text from a copy without `disabled` ensures the fingerprint never
// incorporates Plus's own enablement contribution.
function upstreamMcpAvailable(
  id: string,
  config: Mcp.ServerConfig,
  records: readonly CustomizationRecord[],
): boolean {
  const shared = records.find(
    (record) => record.item === id && record.level === "defaults" && record.agent === null && record.section === null,
  )
  if (shared?.state === "off") return true
  if (shared?.state === "on") return false
  return config.disabled !== true
}

// The ambient set core applies (packages/core/src/config/plugin/
// instruction.ts): the global config AGENTS.md first, then project AGENTS.md
// files from the location upward to the stop directory
// (nearest-to-farthest). Descendant files, which core surfaces only as
// synthetic messages when read, are not inventory. Plus cannot reach core's
// internal project/global discovery flags, so both scopes are always
// included; a core deployment with either scope disabled applies a subset of
// what is listed here.
async function discoverInstructionFiles(
  directory: string,
  projectDirectory: string,
): Promise<{ path: string; text: string }[]> {
  const candidates = instructionCandidates(directory, projectDirectory)
  const texts = await Promise.all(candidates.map((file) => readText(file)))
  return candidates.flatMap((file, index) => {
    const text = texts[index]
    if (text === undefined) return []
    return [{ path: file, text }]
  })
}

export function instructionCandidates(directory: string, projectDirectory: string): string[] {
  const start = path.resolve(directory)
  const root = path.resolve(projectDirectory)
  const home = path.resolve(process.env.OPENCODE_TEST_HOME ?? os.homedir())
  const stop = contains(home, start) ? home : root
  const candidates = [path.join(globalConfigDir(), "AGENTS.md")]
  if (!contains(root, start)) return [...new Set(candidates)]
  return [...new Set([...candidates, ...ancestorFiles(start, stop)])]
}

// Ownership for the delete path: the session file (<session>/AGENTS.md) is
// the only instruction `instruction.delete` can reach — its resolver confines
// resolution to the project root, which the session file satisfies exactly
// when the session is the project root (the only layout `instruction.create`
// writes). The global-config AGENTS.md and ancestor files outside the session
// are ambient inventory: the tree must not offer `d` on them because the
// handler would reject the traversal. Group carries the signal so no model,
// RPC, or snapshot change is needed: `removable()` already grants delete to
// project-group items, and `instructionFileItems` sets it above.

function ancestorFiles(start: string, stop: string): string[] {
  const files: string[] = []
  let current = start
  while (true) {
    files.push(path.join(current, "AGENTS.md"))
    if (current === stop) break
    const parent = path.dirname(current)
    if (parent === current) break
    current = parent
  }
  return files
}

// Same containment semantics as FSUtil.contains: equal paths contain, and a
// relative result escaping with ".." does not.
function contains(parent: string, child: string): boolean {
  const relative = path.relative(parent, child)
  if (relative === "") return true
  if (path.isAbsolute(relative)) return false
  if (relative === "..") return false
  return !relative.startsWith(`..${path.sep}`)
}

async function readText(file: string): Promise<string | undefined> {
  return fs.readFile(file, "utf8").catch(() => undefined)
}

function instructionFileItems(
  directory: string,
  files: readonly { path: string; text: string }[],
): Item[] {
  const owned = path.resolve(directory, "AGENTS.md")
  return files.map((file, index): Item => {
    const relative = path.relative(directory, file.path) || file.path
    const id = `system:${relative}`
    return {
      id,
      kind: "system",
      group: path.resolve(file.path) === owned ? "project" : "none",
      title: relative,
      text: file.text,
      enabled: upstreamEnabled(),
      fingerprint: fingerprint(file.text),
      order: index,
    }
  })
}

// The seeded teaching file is ambient Plus inventory, not a core discovery
// candidate: it gets its own stable row so it is editable, sectionable, and
// toggleable per agent like any other instruction. It appears only while the
// file exists, so hosts that never seed it see no new row.
async function readTeachingFile(): Promise<{ path: string; text: string } | undefined> {
  const file = teachingFilePath()
  const text = await readText(file)
  if (text === undefined) return undefined
  return { path: file, text }
}

function teachingItems(teaching: { path: string; text: string } | undefined, order: number): Item[] {
  if (teaching === undefined) return []
  return [
    {
      id: teachingItemId,
      kind: "system",
      group: "plus",
      title: "OpenCodePlus",
      text: teaching.text,
      enabled: upstreamEnabled(),
      fingerprint: fingerprint(teaching.text),
      order,
    },
  ]
}
