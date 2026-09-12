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
import type { VcsDomain } from "@opencode/plugin/effect/vcs"
import type { WebSearchDomain } from "@opencode/plugin/effect/websearch"
import type { WorktreeDomain } from "@opencode/plugin/effect/worktree"
import { Location } from "@opencode/schema/location"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { Effect, Stream } from "effect"

export type Overrides = Partial<Omit<Context, "options" | "session">> & {
  readonly session?: Partial<Context["session"]>
}

function die(message: string) {
  return () => Effect.die(message)
}

function agentDomain(): AgentDomain {
  return {
    get: die("unused agent.get"),
    list: die("unused agent.list"),
    transform: die("unused agent.transform"),
    reload: die("unused agent.reload"),
  }
}

function aisdkDomain(): AISDKDomain {
  return { hook: die("unused aisdk.hook") }
}

function catalogDomain(): CatalogDomain {
  return {
    provider: {
      list: die("unused catalog.provider.list"),
      get: die("unused catalog.provider.get"),
    },
    model: {
      list: die("unused catalog.model.list"),
      default: die("unused catalog.model.default"),
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
    transform: die("unused mcp.transform"),
    reload: die("unused mcp.reload"),
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
  return {
    list: die("unused skill.list"),
    transform: die("unused skill.transform"),
    reload: die("unused skill.reload"),
  }
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
    transform: die("unused tool.transform"),
    reload: die("unused tool.reload"),
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
    catalog: overrides.catalog ?? catalogDomain(),
    command: overrides.command ?? commandDomain(),
    event: overrides.event ?? eventDomain(),
    experimental: overrides.experimental ?? {
      terminal: { read: die("unused experimental.terminal.read") },
    },
    generate: overrides.generate ?? { text: die("unused generate.text") },
    integration: overrides.integration ?? integrationDomain(),
    mcp: overrides.mcp ?? mcpDomain(),
    permission: overrides.permission ?? permissionDomain(),
    plugin: overrides.plugin ?? { list: die("unused plugin.list") },
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
