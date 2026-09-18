// Team tool handlers are scaffolding to be replaced: every method below
// returns E_NOT_IMPLEMENTED until the handler task fills in the bodies one
// by one. This interface is the shared surface a later RPC layer will reuse,
// so it stays free of any Tool.Context type; callers pass plain input only.
import type { Context } from "@opencode/plugin/effect/plugin"
import type { PlusState } from "../index.js"

export interface TeamApiError {
  readonly code: string
  readonly message: string
  readonly accepted?: unknown
}

export type TeamApiResult<T = unknown> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: TeamApiError }

export interface TeamApi {
  readonly delegate: (input: unknown) => Promise<TeamApiResult>
  readonly finish: (input: unknown) => Promise<TeamApiResult>
  readonly followup: (input: unknown) => Promise<TeamApiResult>
  readonly review: (input: unknown) => Promise<TeamApiResult>
  readonly integrate: (input: unknown) => Promise<TeamApiResult>
  readonly checkpoint: (input: unknown) => Promise<TeamApiResult>
  readonly set_checks: (input: unknown) => Promise<TeamApiResult>
  readonly supersede: (input: unknown) => Promise<TeamApiResult>
  readonly shutdown_request: (input: unknown) => Promise<TeamApiResult>
  readonly stop: (input: unknown) => Promise<TeamApiResult>
  readonly resume: (input: unknown) => Promise<TeamApiResult>
  readonly prepare: (input: unknown) => Promise<TeamApiResult>
  readonly plan_handoff: (input: unknown) => Promise<TeamApiResult>
  readonly status: (input: unknown) => Promise<TeamApiResult>
  readonly wait: (input: unknown) => Promise<TeamApiResult>
  readonly diff: (input: unknown) => Promise<TeamApiResult>
  readonly list: (input: unknown) => Promise<TeamApiResult>
  readonly get_context: (input: unknown) => Promise<TeamApiResult>
  readonly check: (input: unknown) => Promise<TeamApiResult>
  readonly metrics: (input: unknown) => Promise<TeamApiResult>
  readonly exa_code_search: (input: unknown) => Promise<TeamApiResult>
  readonly tavily_search: (input: unknown) => Promise<TeamApiResult>
  readonly tavily_extract: (input: unknown) => Promise<TeamApiResult>
}

function notImplemented(tool: string): TeamApiResult {
  return { ok: false, error: { code: "E_NOT_IMPLEMENTED", message: `${tool} is not implemented yet`, accepted: null } }
}

export function createTeamApi(ctx: Context, state: PlusState): TeamApi {
  void ctx
  void state
  return {
    delegate: async () => notImplemented("delegate"),
    finish: async () => notImplemented("finish"),
    followup: async () => notImplemented("followup"),
    review: async () => notImplemented("review"),
    integrate: async () => notImplemented("integrate"),
    checkpoint: async () => notImplemented("checkpoint"),
    set_checks: async () => notImplemented("set_checks"),
    supersede: async () => notImplemented("supersede"),
    shutdown_request: async () => notImplemented("shutdown_request"),
    stop: async () => notImplemented("stop"),
    resume: async () => notImplemented("resume"),
    prepare: async () => notImplemented("prepare"),
    plan_handoff: async () => notImplemented("plan_handoff"),
    status: async () => notImplemented("status"),
    wait: async () => notImplemented("wait"),
    diff: async () => notImplemented("diff"),
    list: async () => notImplemented("list"),
    get_context: async () => notImplemented("get_context"),
    check: async () => notImplemented("check"),
    metrics: async () => notImplemented("metrics"),
    exa_code_search: async () => notImplemented("exa_code_search"),
    tavily_search: async () => notImplemented("tavily_search"),
    tavily_extract: async () => notImplemented("tavily_extract"),
  }
}
