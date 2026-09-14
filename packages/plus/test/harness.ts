import type { AgentDomain } from "@opencode/plugin/effect/agent"
import type { AISDKDomain } from "@opencode/plugin/effect/aisdk"
import type { CatalogDomain } from "@opencode/plugin/effect/catalog"
import type { CommandDomain } from "@opencode/plugin/effect/command"
import type { EventDomain } from "@opencode/plugin/effect/event"
import type { IntegrationDomain } from "@opencode/plugin/effect/integration"
import type { MCPDomain } from "@opencode/plugin/effect/mcp"
import type { PermissionDomain } from "@opencode/plugin/effect/permission"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { ReferenceDomain } from "@opencode/plugin/effect/reference"
import type { RpcDomain } from "@opencode/plugin/effect/rpc"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import type { ShellDomain } from "@opencode/plugin/effect/shell"
import type { SkillDomain } from "@opencode/plugin/effect/skill"
import type { StorageDomain } from "@opencode/plugin/effect/storage"
import type { ToolDomain } from "@opencode/plugin/effect/tool"
import type { InstructionDomain } from "@opencode/plugin/effect/instruction"
import type { PromptDomain } from "@opencode/plugin/effect/prompt"
import type { VcsDomain } from "@opencode/plugin/effect/vcs"
import type { WebSearchDomain } from "@opencode/plugin/effect/websearch"
import type { WorktreeDomain } from "@opencode/plugin/effect/worktree"
import { Location } from "@opencode/schema/location"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Skill } from "@opencode/schema/skill"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Schema, Stream, type Types } from "effect"

export type Overrides = Partial<Omit<Context, "options" | "session" | "catalog" | "prompt">> & {
  readonly session?: Partial<Context["session"]>
  readonly catalog?: Context["catalog"]
  readonly prompt?: Context["prompt"]
}

function die(message: string) {
  return () => Effect.die(message)
}

function agentDomain(): AgentDomain {
  return {
    get: die("unused agent.get"),
    list: () =>
      Effect.succeed({
        location: new Location.Info({
          directory: AbsolutePath.make("/workspace"),
          project: {
            id: Project.ID.global,
            directory: AbsolutePath.make("/workspace"),
            canonical: AbsolutePath.make("/workspace"),
          },
        }),
        data: [],
      }),
    transform: () => Effect.succeed({ dispose: Effect.void }),
    reload: () => Effect.void,
  }
}

function aisdkDomain(): AISDKDomain {
  return { hook: die("unused aisdk.hook") }
}

function catalogDomain(models: Model.Info[] = []): CatalogDomain {
  return {
    provider: {
      list: die("unused catalog.provider.list"),
      get: die("unused catalog.provider.get"),
    },
    model: {
      list: () =>
        Effect.succeed({
          location: new Location.Info({
            directory: AbsolutePath.make("/workspace"),
            project: {
              id: Project.ID.global,
              directory: AbsolutePath.make("/workspace"),
              canonical: AbsolutePath.make("/workspace"),
            },
          }),
          data: models,
        }),
      default: () =>
        Effect.succeed({
          location: new Location.Info({
            directory: AbsolutePath.make("/workspace"),
            project: {
              id: Project.ID.global,
              directory: AbsolutePath.make("/workspace"),
              canonical: AbsolutePath.make("/workspace"),
            },
          }),
          data: models[0],
        }),
    },
    transform: die("unused catalog.transform"),
    reload: die("unused catalog.reload"),
  }
}

function commandDomain(): CommandDomain {
  return {
    list: die("unused command.list"),
    transform: die("unused command.transform"),
    reload: die("unused command.reload"),
  }
}

function eventDomain(): EventDomain {
  return { subscribe: () => Stream.empty }
}

function instructionDomain(): InstructionDomain {
  const files = new Map<string, { path: string; content: string }>()
  return {
    transform: (callback) =>
      Effect.sync(() => {
        callback({
          list: () => Array.from(files.values()),
          add: (file) => {
            files.set(file.path, { ...file })
          },
          update: (target, update) => {
            const current = files.get(target)
            if (current === undefined) return
            const draft = { ...current }
            update(draft)
            files.set(target, { path: current.path, content: draft.content })
          },
          remove: (target) => {
            files.delete(target)
          },
        })
        return { dispose: Effect.void }
      }),
    reload: () => Effect.void,
  }
}

function integrationDomain(): IntegrationDomain {
  return {
    list: die("unused integration.list"),
    get: die("unused integration.get"),
    connect: { key: die("unused integration.connect.key") },
    oauth: {
      connect: die("unused integration.oauth.connect"),
      status: die("unused integration.oauth.status"),
      complete: die("unused integration.oauth.complete"),
      cancel: die("unused integration.oauth.cancel"),
    },
    command: {
      connect: die("unused integration.command.connect"),
      status: die("unused integration.command.status"),
      cancel: die("unused integration.command.cancel"),
    },
    connection: {
      active: die("unused integration.connection.active"),
      resolve: die("unused integration.connection.resolve"),
    },
    transform: die("unused integration.transform"),
    reload: die("unused integration.reload"),
  }
}

function mcpDomain(): MCPDomain {
  return {
    list: die("unused mcp.list"),
    transform: (callback) =>
      Effect.sync(() => {
        callback({
          list: () => [],
          get: () => undefined,
          set: () => undefined,
          update: () => undefined,
          remove: () => undefined,
        } as never)
        return { dispose: Effect.void }
      }),
    reload: () => Effect.void,
  }
}

function permissionDomain(): PermissionDomain {
  return {
    list: die("unused permission.list"),
    get: die("unused permission.get"),
    reply: die("unused permission.reply"),
    rules: die("unused permission.rules"),
    hook: die("unused permission.hook"),
  }
}

export type PromptClassificationTable =
  | ReadonlyMap<string, string>
  | Readonly<Record<string, string>>

export type PromptRawTable = ReadonlyMap<string, string> | Readonly<Record<string, string>>

export const defaultHostTemplates: readonly { readonly id: string; readonly title: string; readonly text: string }[] = [
  { id: "gpt", title: "GPT.txt", text: "gpt base prompt" },
  { id: "claude", title: "Claude.txt", text: "claude base prompt" },
  { id: "muse", title: "Muse.txt", text: "muse base prompt" },
  { id: "gemini", title: "Gemini.txt", text: "gemini base prompt" },
  { id: "general", title: "General.txt", text: "general base prompt" },
  { id: "kimi", title: "Kimi.txt", text: "kimi base prompt" },
  { id: "trinity", title: "Trinity.txt", text: "trinity base prompt" },
]

export function promptDomain(
  templates: readonly { id: string; title: string; text: string }[] = defaultHostTemplates,
  classifications: PromptClassificationTable = new Map([["", "general"]]),
  raws: PromptRawTable = {},
): PromptDomain {
  const table =
    classifications instanceof Map
      ? new Map(classifications)
      : new Map(Object.entries(classifications))
  const rawTable = raws instanceof Map ? new Map(raws) : new Map(Object.entries(raws))
  const listed = templates.map((template) => ({ ...template }))
  return {
    templates: () => Effect.succeed(listed),
    active: (model) => {
      const target =
        table.get(model.id) ??
        (model.name ? table.get(model.name) : undefined) ??
        (model.id === "" && model.name === "" ? table.get("") : undefined)
      if (target !== undefined) return Effect.succeed(target)
      return Effect.die(`promptDomain: no classification explicitly supplied for model "${model.id || model.name || "<unspecified>"}"`)
    },
    // The host answers the per-request raw template from explicitly
    // supplied fixtures only. It never derives this from the templates
    // list or the classification table: that derivation is core's gpt-6
    // selection, and reimplementing it here would hide the exact drift
    // this seam exists to prevent. No fixture means an older host without
    // the seam, so answer undefined and let the caller fall back.
    raw: (model) => Effect.succeed(rawTable.get(model.id) ?? (model.name ? rawTable.get(model.name) : undefined)),
  }
}

function referenceDomain(): ReferenceDomain {
  return {
    list: die("unused reference.list"),
    transform: die("unused reference.transform"),
    reload: die("unused reference.reload"),
  }
}

function rpcDomain(): RpcDomain {
  return Object.assign(
    () => {
      throw new Error("unused rpc.client")
    },
    { register: die("unused rpc.register") },
  )
}

function shellDomain(): ShellDomain {
  return { hook: die("unused shell.hook") }
}

function skillDomain(): SkillDomain {
  return recordingSkillDomain(new Map(), [])
}

export interface SkillHarness {
  readonly domain: SkillDomain
  readonly state: Map<string, Types.DeepMutable<Skill.Info>>
  readonly added: Skill.Info[]
}

// A stateful skill domain on the shared recording editor: Plus's private
// copies persist in the visible registry (core filters plus/ ids out of
// discovery itself), exactly like the agent harness's live map.
export function skillHarness(initial: Skill.Info[] = []): SkillHarness {
  const state = new Map(
    initial.map((skill) => [skill.id, structuredClone(skill) as Types.DeepMutable<Skill.Info>]),
  )
  const added: Skill.Info[] = []
  return { domain: recordingSkillDomain(state, added), state, added }
}

export function recordingSkillDomain(
  state: Map<string, Types.DeepMutable<Skill.Info>> = new Map(),
  added: Skill.Info[] = [],
): SkillDomain {
  const upstream = new Map(state)
  const installed: Array<Parameters<SkillDomain["transform"]>[0]> = []
  function rebuild() {
    state.clear()
    added.length = 0
    for (const [id, skill] of upstream) state.set(id, structuredClone(skill) as Types.DeepMutable<Skill.Info>)
    const editor = {
      list: () => Array.from(state.values()),
      get: (id: string) => state.get(id),
      add: (skill: Skill.Info) => {
        added.push(skill)
        state.set(skill.id, structuredClone(skill) as Types.DeepMutable<Skill.Info>)
      },
      update: (id: string, update: (skill: Types.DeepMutable<Skill.Info>) => void) => {
        const current = state.get(id)
        if (current) update(current)
      },
      remove: (id: string) => {
        state.delete(id)
      },
    }
    for (const transform of installed) transform(editor)
  }
  return {
    list: () =>
      Effect.succeed({
        location: new Location.Info({
          directory: AbsolutePath.make("/workspace"),
          project: {
            id: Project.ID.global,
            directory: AbsolutePath.make("/workspace"),
            canonical: AbsolutePath.make("/workspace"),
          },
        }),
        data: Array.from(state.values()),
      }),
    transform: (callback) =>
      Effect.sync(() => {
        installed.push(callback)
        rebuild()
        return {
          dispose: Effect.sync(() => {
            const index = installed.indexOf(callback)
            if (index === -1) return
            installed.splice(index, 1)
            rebuild()
          }),
        }
      }),
    reload: () => Effect.void,
  }
}

export interface AgentHarness {
  readonly domain: AgentDomain
  readonly state: Map<string, Types.DeepMutable<Agent.Info>>
  readonly transforms: number
  readonly disposes: number
  readonly reloads: number
}
// A stateful agent domain mirroring core's transform/rebuild semantics: each
// transform installs one callback, and every read rebuilds the visible state
// from upstream plus the installed callbacks. While a callback overwrites a
// prompt, host edits underneath stay invisible until the callback is disposed,
// exactly as in core. Upstream itself changes only through setUpstream,
// modeling a real host edit outside Plus.
export function agentHarness(
  initial: Agent.Info[],
): AgentHarness & { setUpstream(id: string, system: string): void; upstream(id: string): string | undefined } {
  const upstream = new Map(initial.map((agent) => [agent.id, structuredClone(agent)]))
  const live = new Map<string, Types.DeepMutable<Agent.Info>>()
  const installed: Array<Parameters<AgentDomain["transform"]>[0]> = []
  const counts = { installs: 0, disposes: 0, reloads: 0 }
  function rebuild() {
    live.clear()
    for (const [id, agent] of upstream) live.set(id, structuredClone(agent) as Types.DeepMutable<Agent.Info>)
    const editor = {
      list: () => Array.from(live.values()),
      get: (id: string) => live.get(id),
      default: () => undefined,
      update: (id: string, update: (agent: Types.DeepMutable<Agent.Info>) => void) => {
        const key = Agent.ID.make(id)
        const current = live.get(key) ?? Agent.Info.default(key)
        if (!live.has(key)) live.set(key, current)
        update(current)
        current.id = key
      },
      remove: (id: string) => {
        live.delete(id)
      },
    }
    for (const transform of installed) transform(editor)
  }
  rebuild()
  return {
    domain: {
      get: () => Effect.die("unused agent.get"),
      list: () =>
        Effect.sync(() => ({
          location: new Location.Info({
            directory: AbsolutePath.make("/workspace"),
            project: {
              id: Project.ID.global,
              directory: AbsolutePath.make("/workspace"),
              canonical: AbsolutePath.make("/workspace"),
            },
          }),
          data: Array.from(live.values()),
        })),
      transform: (callback) =>
        Effect.sync(() => {
          counts.installs++
          installed.push(callback)
          rebuild()
          return {
            dispose: Effect.sync(() => {
              const index = installed.indexOf(callback)
              if (index === -1) return
              counts.disposes++
              installed.splice(index, 1)
              rebuild()
            }),
          }
        }),
      reload: () =>
        Effect.sync(() => {
          counts.reloads++
          rebuild()
        }),
    } satisfies AgentDomain,
    state: live,
    get transforms() {
      return counts.installs
    },
    get disposes() {
      return counts.disposes
    },
    get reloads() {
      return counts.reloads
    },
    setUpstream: (id: string, system: string) => {
      const current = upstream.get(Agent.ID.make(id))
      if (!current) return
      upstream.set(current.id, { ...current, system })
      rebuild()
    },
    upstream: (id: string) => upstream.get(Agent.ID.make(id))?.system,
  }
}

export function toolInfo(id: string, description: string, options?: Tool.Info["options"]): Tool.Info & { readonly id: string } {
  return {
    id,
    name: id,
    description,
    input: Schema.Void,
    ...(options === undefined ? {} : { options }),
    execute: () => Effect.die("unused tool.execute"),
  }
}

export interface ToolHarness {
  readonly domain: ToolDomain
  readonly tools: Map<string, Tool.Info & { readonly id: string }>
}

function effectiveToolId(name: string, namespace: string | undefined): string {
  const normalized = name.replace(/[^A-Za-z0-9_-]/g, "_")
  if (namespace === undefined) return normalized
  return `${namespace.replaceAll(".", "_")}_${normalized}`
}

export function toolHarness(entries: readonly { id: string; description: string; options?: Tool.Info["options"] }[] = []): ToolHarness {
  const upstream = new Map(
    entries.map((entry) => {
      const info = toolInfo(entry.id, entry.description, entry.options)
      const id = effectiveToolId(info.name, info.options?.namespace)
      return [id, { ...info, id }] as const
    }),
  )
  const live = new Map<string, Tool.Info & { readonly id: string }>(upstream)
  const namespaces = new Map<string, { name: string; description: string }>()
  const installed: Array<Parameters<ToolDomain["transform"]>[0]> = []
  function rebuild() {
    live.clear()
    for (const [id, info] of upstream) live.set(id, { ...info, id })
    namespaces.clear()
    const editor = {
      list: () => Array.from(live.values()),
      get: (id: string) => live.get(id),
      namespace: (namespace: { name: string; description: string }) => {
        namespaces.set(namespace.name, { ...namespace })
      },
      add: (tool: Tool.Info) => {
        const id = effectiveToolId(tool.name, tool.options?.namespace)
        live.set(id, { ...tool, id } as Tool.Info & { readonly id: string })
      },
      update: (id: string, update: (tool: Types.Mutable<Tool.Info>) => void) => {
        const current = live.get(id)
        if (current === undefined) return
        const draft = { ...current, options: current.options && { ...current.options } } as Types.Mutable<Tool.Info> & { id: string }
        update(draft)
        draft.name = current.name
        if (draft.options?.namespace !== current.options?.namespace)
          draft.options = { ...draft.options, namespace: current.options?.namespace } as Tool.Info["options"]
        live.set(id, { ...draft, id } as Tool.Info & { readonly id: string })
      },
      remove: (id: string) => {
        live.delete(id)
      },
    }
    for (const transform of installed) transform(editor)
  }
  return {
    domain: {
      transform: (callback) =>
        Effect.sync(() => {
          installed.push(callback)
          rebuild()
          return {
            dispose: Effect.sync(() => {
              const index = installed.indexOf(callback)
              if (index === -1) return
              installed.splice(index, 1)
              rebuild()
            }),
          }
        }),
      reload: () =>
        Effect.sync(() => {
          rebuild()
        }),
      hook: die("unused tool.hook"),
    },
    tools: live,
  }
}

export interface McpHarness {
  readonly domain: MCPDomain
  readonly starts: number
  readonly disabled: (name: string) => boolean | undefined
}

// A stateful MCP domain mirroring core's transform/rebuild/reconcile
// semantics: each transform installs one callback, and every registration
// change rebuilds the visible config from upstream plus the installed
// callbacks in order, then reconciles exactly like core's State notify. An
// enabled server counts one start per reconcile that observes it enabled,
// modeling McpClient.connect on every replaceServer; a server that stays
// disabled across the rebuild never starts. Discovery reads inside
// readTransform observe the rebuilt list.
export function mcpHarness(initial: [string, { type: "remote"; url: string; disabled?: boolean }][]): McpHarness {
  const upstream = new Map(initial.map(([name, config]) => [name, structuredClone(config)]))
  const installed: Array<Parameters<MCPDomain["transform"]>[0]> = []
  const counts = { starts: 0 }
  function visible(): Map<string, { type: "remote"; url: string; disabled?: boolean }> {
    const servers = new Map<string, { type: "remote"; url: string; disabled?: boolean }>()
    for (const [name, config] of upstream) servers.set(name, structuredClone(config))
    const editor = {
      list: () => Array.from(servers.entries()),
      get: (name: string) => servers.get(name),
      set: (name: string, config: { type: "remote"; url: string; disabled?: boolean }) => {
        servers.set(name, structuredClone(config))
      },
      update: (name: string, update: (config: { type: "remote"; url: string; disabled?: boolean }) => void) => {
        const current = servers.get(name)
        if (current) update(current)
      },
      remove: (name: string) => {
        servers.delete(name)
      },
    }
    for (const transform of installed) transform(editor as never)
    return servers
  }
  function reconcile() {
    for (const config of visible().values()) {
      if (config.disabled === true) continue
      counts.starts++
    }
  }
  reconcile()
  return {
    domain: {
      list: () => Effect.die("unused mcp.list"),
      transform: (callback) =>
        Effect.sync(() => {
          installed.push(callback)
          reconcile()
          return {
            dispose: Effect.sync(() => {
              const index = installed.indexOf(callback)
              if (index === -1) return
              installed.splice(index, 1)
              reconcile()
            }),
          }
        }),
      reload: () =>
        Effect.sync(() => {
          reconcile()
        }),
    } satisfies MCPDomain,
    get starts() {
      return counts.starts
    },
    disabled: (name: string) => visible().get(name)?.disabled,
  }
}

export function promptHarness(
  templates: readonly { id: string; title: string; text: string }[],
  classifications?: PromptClassificationTable,
  raws?: PromptRawTable,
): PromptDomain {
  return promptDomain(templates, classifications, raws)
}

export function catalogHarness(models: Model.Info[]): CatalogDomain {
  return catalogDomain(models)
}

export function skillInfo(id: string, content: string, locationPath = `/skills/${id}.md`): Skill.Info {
  return Skill.Info.make({
    id: Skill.ID.make(id),
    name: Skill.Name.make(id),
    location: AbsolutePath.make(locationPath),
    content,
  })
}

export function agentInfo(id: string, system = "", model?: Model.Ref): Agent.Info {
  return {
    ...Agent.Info.default(Agent.ID.make(id)),
    system,
    ...(model === undefined ? {} : { model }),
  }
}

export function modelInfo(providerID: string, id: string, name?: string): Model.Info {
  const base = Model.Info.default(Provider.ID.make(providerID), Model.ID.make(id))
  return name === undefined ? base : { ...base, name }
}

export function modelRef(providerID: string, id: string): Model.Ref {
  return Model.Ref.make({ providerID: Provider.ID.make(providerID), id: Model.ID.make(id) })
}

export function fullContext(options: {
  directory: string
  agents?: Agent.Info[]
  skills?: Skill.Info[]
  tools?: { id: string; description: string; options?: Tool.Info["options"] }[]
  servers?: [string, { type: "remote"; url: string; disabled?: boolean }][]
  hooks?: { current: number }
  models?: Model.Info[]
  templates?: { id: string; title: string; text: string }[]
  classifications?: PromptClassificationTable
  raws?: PromptRawTable
  session?: Partial<Context["session"]>
}): Context {
  const agents = options.agents ?? []
  const skills = options.skills ?? []
  const entries = options.tools ?? []
  const servers = options.servers ?? []
  const models = options.models ?? []
  const templates = options.templates ?? defaultHostTemplates
  const classifications = options.classifications ?? new Map([["", "general"]])
  const location = new Location.Info({
    directory: AbsolutePath.make(options.directory),
    project: {
      id: Project.ID.global,
      directory: AbsolutePath.make(options.directory),
      canonical: AbsolutePath.make(options.directory),
    },
  })
  const tools = toolHarness(entries)
  const mcp = mcpHarness(servers)
  const skillState = skillHarness(skills)
  const agentState = agentHarness(agents)
  const skillDomain = {
    ...skillState.domain,
    list: () => Effect.succeed({ location, data: Array.from(skillState.state.values()) }),
  }
  return context({
    location,
    agent: agentState.domain,
    catalog: catalogDomain(models),
    prompt: promptDomain(templates, classifications, options.raws),
    skill: skillDomain,
    tool: tools.domain,
    mcp: mcp.domain,
    session: options.session ?? (options.hooks === undefined ? {} : {
      hook: () =>
        Effect.sync(() => {
          if (options.hooks) options.hooks.current++
          return { dispose: Effect.sync(() => { if (options.hooks) options.hooks.current-- }) }
        }),
    }),
  })
}

function storageDomain(): StorageDomain {
  return {
    get: die("unused storage.get"),
    set: die("unused storage.set"),
    remove: die("unused storage.remove"),
    scan: die("unused storage.scan"),
  }
}

function toolDomain(): ToolDomain {
  return {
    transform: (callback) =>
      Effect.sync(() => {
        callback({
          list: () => [],
          get: () => undefined,
          namespace: () => undefined,
          add: () => undefined,
          update: () => undefined,
          remove: () => undefined,
        })
        return { dispose: Effect.void }
      }),
    reload: () => Effect.void,
    hook: die("unused tool.hook"),
  }
}

function vcsDomain(): VcsDomain {
  return {
    get: die("unused vcs.get"),
    base: die("unused vcs.base"),
    branches: die("unused vcs.branches"),
    status: die("unused vcs.status"),
    diff: die("unused vcs.diff"),
    transform: die("unused vcs.transform"),
    reload: die("unused vcs.reload"),
  }
}

function websearchDomain(): WebSearchDomain {
  return {
    providers: die("unused websearch.providers"),
    query: die("unused websearch.query"),
    transform: die("unused websearch.transform"),
    reload: die("unused websearch.reload"),
  }
}

function worktreeDomain(): WorktreeDomain {
  return {
    list: die("unused worktree.list"),
    create: die("unused worktree.create"),
    remove: die("unused worktree.remove"),
    refresh: die("unused worktree.refresh"),
    transform: die("unused worktree.transform"),
    reload: die("unused worktree.reload"),
  }
}

function sessionDomain(overrides: Partial<SessionDomain> = {}): SessionDomain {
  return {
    create: overrides.create ?? die("unused session.create"),
    get: overrides.get ?? die("unused session.get"),
    switchAgent: overrides.switchAgent ?? die("unused session.switchAgent"),
    switchModel: overrides.switchModel ?? die("unused session.switchModel"),
    prompt: overrides.prompt ?? die("unused session.prompt"),
    generate: overrides.generate ?? die("unused session.generate"),
    command: overrides.command ?? die("unused session.command"),
    rename: overrides.rename ?? die("unused session.rename"),
    move: overrides.move ?? die("unused session.move"),
    synthetic: overrides.synthetic ?? die("unused session.synthetic"),
    interrupt: overrides.interrupt ?? die("unused session.interrupt"),
    wait: overrides.wait ?? die("unused session.wait"),
    context: overrides.context ?? die("unused session.context"),
    hook: overrides.hook ?? die("unused session.hook"),
  }
}

export function context(overrides: Overrides = {}): Context {
  return {
    app: overrides.app ?? { name: "test", version: "test", channel: "test" },
    location:
      overrides.location ??
      new Location.Info({
        directory: AbsolutePath.make("/workspace"),
        project: {
          id: Project.ID.global,
          directory: AbsolutePath.make("/workspace"),
          canonical: AbsolutePath.make("/workspace"),
        },
      }),
    options: {},
    agent: overrides.agent ?? agentDomain(),
    aisdk: overrides.aisdk ?? aisdkDomain(),
    catalog: overrides.catalog ?? catalogDomain([]),
    command: overrides.command ?? commandDomain(),
    event: overrides.event ?? eventDomain(),
    experimental: overrides.experimental ?? {
      terminal: { read: die("unused experimental.terminal.read") },
    },
    generate: overrides.generate ?? { text: die("unused generate.text") },
    integration: overrides.integration ?? integrationDomain(),
    instruction: overrides.instruction ?? instructionDomain(),
    mcp: overrides.mcp ?? mcpDomain(),
    permission: overrides.permission ?? permissionDomain(),
    plugin: overrides.plugin ?? { list: die("unused plugin.list") },
    prompt: overrides.prompt ?? promptDomain(defaultHostTemplates, new Map([["", "general"]])),
    reference: overrides.reference ?? referenceDomain(),
    rpc: overrides.rpc ?? rpcDomain(),
    session: sessionDomain(overrides.session),
    shell: overrides.shell ?? shellDomain(),
    skill: overrides.skill ?? skillDomain(),
    storage: overrides.storage ?? storageDomain(),
    tool: overrides.tool ?? toolDomain(),
    vcs: overrides.vcs ?? vcsDomain(),
    websearch: overrides.websearch ?? websearchDomain(),
    worktree: overrides.worktree ?? worktreeDomain(),
  }
}
