import type { OpenCodeClient } from "@opencode/client"
import type { GenerateApi, PluginApi } from "@opencode/client/promise/api"
import type { Location } from "@opencode/schema/location"
import type { PluginOptions } from "../options.js"
import type { App } from "../app.js"
import type { AgentDomain } from "./agent.js"
import type { AISDKDomain } from "./aisdk.js"
import type { CommandDomain } from "./command.js"
import type { EventDomain } from "./event.js"
import type { IntegrationDomain } from "./integration.js"
import type { MCPDomain } from "./mcp.js"
import type { ModelDomain } from "./model.js"
import type { PermissionDomain } from "./permission.js"
import type { ProviderDomain } from "./provider.js"
import type { ReferenceDomain } from "./reference.js"
import type { RpcDomain } from "./rpc.js"
import type { SessionDomain } from "./session.js"
import type { ShellDomain } from "./shell.js"
import type { SkillDomain } from "./skill.js"
import type { StorageDomain } from "./storage.js"
import type { ToolDomain } from "./tool.js"
import type { VcsDomain } from "./vcs.js"
import type { WebSearchDomain } from "./websearch.js"
import type { WorktreeDomain } from "./worktree.js"

export interface Context {
  readonly app: App
  readonly location: Location.Info
  readonly options: PluginOptions
  /**
   * Runs the function inside a state batch. Registry changes made inside coalesce
   * notifications so observers notify once at the end. Reads inside stay fresh.
   */
  readonly batch: <T>(fn: () => Promise<T>) => Promise<T>
  readonly agent: AgentDomain
  readonly aisdk: AISDKDomain
  readonly command: CommandDomain
  readonly event: EventDomain
  readonly experimental: {
    readonly terminal: Pick<OpenCodeClient["experimental"]["persistentPty"], "read">
  }
  readonly integration: IntegrationDomain
  readonly mcp: MCPDomain
  readonly model: ModelDomain
  readonly generate: GenerateApi
  readonly permission: PermissionDomain
  readonly plugin: Pick<PluginApi, "list">
  readonly locations: {
    /** Evicts a loaded Location's services unless a Session there is active. */
    readonly evict: (ref: Location.Ref) => Promise<void>
    /** Whether a Location's services are loaded now, without booting it. */
    readonly loaded: (ref: Location.Ref) => Promise<boolean>
  }
  readonly provider: ProviderDomain
  readonly reference: ReferenceDomain
  readonly rpc: RpcDomain
  readonly session: SessionDomain
  readonly shell: ShellDomain
  readonly skill: SkillDomain
  readonly storage: StorageDomain
  readonly tool: ToolDomain
  readonly vcs: VcsDomain
  readonly websearch: WebSearchDomain
  readonly worktree: WorktreeDomain
}

export type Cleanup = () => Promise<void> | void

export interface Plugin {
  readonly id: string
  readonly setup: (context: Context) => Promise<Cleanup | void> | Cleanup | void
}

export function define(plugin: Plugin) {
  return plugin
}
