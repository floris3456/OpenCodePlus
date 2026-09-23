import type { ExperimentalApi, GenerateApi, PluginApi } from "@opencode/client/effect/api"
import type { Location } from "@opencode/schema/location"
import type { ReleaseRequest, ReleaseRequestStatus } from "@opencode/schema/release"
import type { Effect, Scope } from "effect"
import type { PluginOptions } from "../options.js"
import type { App } from "../app.js"
import type { AgentDomain } from "./agent.js"
import type { AISDKDomain } from "./aisdk.js"
import type { CatalogDomain } from "./catalog.js"
import type { CommandDomain } from "./command.js"
import type { EventDomain } from "./event.js"
import type { IntegrationDomain } from "./integration.js"
import type { InstructionDomain } from "./instruction.js"
import type { MCPDomain } from "./mcp.js"
import type { PermissionDomain } from "./permission.js"
import type { PromptDomain } from "./prompt.js"
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

/**
 * The bounded release surface a plugin may reach inside the host process. A
 * plugin can record an intent and read it back; it can never present authority
 * or change the admission fence. Those operations stay on the host's durable
 * release store, reachable from the operator surfaces only.
 */
export interface ReleaseRefusal {
  readonly ok: false
  /** Refusal vocabulary owned by the host's release store, e.g. `request_conflict`. */
  readonly reason: string
  readonly message: string
}

export interface ReleaseRecorded {
  readonly ok: true
  readonly status: ReleaseRequestStatus
  /** True when the host found the recorded request instead of producing a new one. */
  readonly reconciled: boolean
}

export type ReleaseResult = ReleaseRecorded | ReleaseRefusal

export interface ReleaseSubmitInput {
  readonly request: ReleaseRequest
  readonly now?: number
}

export interface ReleaseDomain {
  readonly submit: (input: ReleaseSubmitInput) => Effect.Effect<ReleaseResult>
  readonly status: (requestID: string) => Effect.Effect<ReleaseResult>
}

export interface Context {
  readonly app: App
  readonly location: Location.Info
  readonly options: PluginOptions
  readonly agent: AgentDomain
  readonly aisdk: AISDKDomain
  readonly catalog: CatalogDomain
  readonly command: CommandDomain
  readonly event: EventDomain
  readonly experimental: {
    readonly terminal: Pick<ExperimentalApi<unknown>["persistentPty"], "read">
  }
  readonly integration: IntegrationDomain
  readonly instruction: InstructionDomain
  readonly mcp: MCPDomain
  readonly generate: GenerateApi<unknown>
  readonly permission: PermissionDomain
  readonly plugin: Pick<PluginApi<unknown>, "list">
  readonly prompt: PromptDomain
  readonly reference: ReferenceDomain
  /**
   * The in-process release seam, backed by the host's durable release store.
   * Optional because a host that cannot provide that store must report no
   * capability rather than a second, process-local one. A plugin may submit a
   * request and read its status; authorizing a permit and settling a transition
   * change the admission fence and are deliberately absent here.
   */
  readonly release?: ReleaseDomain
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

export interface Plugin<R = Scope.Scope> {
  readonly id: string
  readonly effect: (context: Context) => Effect.Effect<void, never, R>
}

export function define<R = Scope.Scope>(plugin: Plugin<R>) {
  return plugin
}
