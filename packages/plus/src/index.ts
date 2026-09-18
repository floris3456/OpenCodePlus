import { Plugin } from "@opencode/plugin/effect"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import type { RpcHandlers, RpcRegistration } from "@opencode/plugin/effect/rpc"
import { Agent } from "@opencode/schema/agent"
import { Config } from "@opencode/schema/config"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import { Skill } from "@opencode/schema/skill"
import { Effect, Exit, Scope, Semaphore, Stream } from "effect"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import { agentBody, discover, instructionCandidates, type BaseTemplate, type Discovered } from "./instructions/discover.js"
import { validateRuleInput } from "./instructions/tool-permissions.js"
import { create, remove, rename, validateAgentId, type AgentFields } from "./agents/files.js"
import { createBaseTemplate, deleteBaseTemplate, readUserBaseTextSync, readUserBaseTitleSync, userBaseDir, userBaseFile } from "./agents/base.js"
import { addMcp, projectConfigCandidates, removeMcp } from "./agents/mcp.js"
import { createSkill, deleteSkill, importSkill } from "./agents/skills.js"
import { apply, type ToolPlan } from "./instructions/apply.js"
import { installTeaching } from "./instructions/teaching.js"
import { registerInstructionTools } from "./tools.js"
import { createTeamApi } from "./teams/api.js"
import { registerTeamPermissions } from "./teams/permissions.js"
import { registerTeamTools } from "./teams/tools.js"
import { applyTeamAgent, dedupeAgents, installTeamAgents, parseTeamFields, type TeamFields } from "./instructions/teams-apply.js"
import { assembled } from "./instructions/assembled.js"
import { resolve, resolveActiveModel, scopesOf, type AgentSource, type CustomizationRecord, type Item, type Level, type ModelRecord, type RuleRecord, type Scopes, type SplitRecord } from "./instructions/model.js"
import { append, readBoth } from "./instructions/log.js"
import { globalConfigDir, globalLogPath, globalTeamsPath, projectLogPath, projectTeamsPath, resolveInstructionPath } from "./instructions/paths.js"
import { canonical, load, save, stable, type StoredRecord } from "./instructions/store.js"
import { builtinBody, discoverBuiltinTeams, discoverTeams, isTeamEnabled, resolveTeams, validateTeamName, type TeamLevel, type TeamRecord } from "./instructions/teams.js"
import { builtinTeams, type BuiltinTeam } from "./instructions/builtin-teams.js"
import type { ModelBaseline, ModelRefLike, PromptBaseline } from "./instructions/inventory.js"
import { matchesTeamApplied, sameModelRef } from "./instructions/inventory.js"
import { disable, enable, read } from "./project.js"
import { CreateAgentFields, Definition, type Plus } from "./rpc.js"

export interface PlusState {
  registration: RpcRegistration<typeof Definition> | undefined
  applied: Registration[]
  tooling: Registration[]
  teamTooling: Registration[]
  installedTools: readonly ToolPlan[]
  fingerprint: string | undefined
  projectRevision: number | undefined
  globalRevision: number | undefined
  baselines: Map<string, PromptBaseline>
  modelBaselines: Map<string, ModelBaseline>
  activeModels: Map<string, ModelRefLike>
  cachedAgents: readonly AgentSource[]
  cachedScopes: Scopes
  semaphore: Semaphore.Semaphore
}

export function createState(): PlusState {
  return {
    registration: undefined,
    applied: [],
    tooling: [],
    teamTooling: [],
    installedTools: [],
    fingerprint: undefined,
    projectRevision: undefined,
    globalRevision: undefined,
    baselines: new Map(),
    modelBaselines: new Map(),
    activeModels: new Map(),
    cachedAgents: [],
    cachedScopes: { global: new Set(), defaults: new Set() },
    semaphore: Effect.runSync(Semaphore.make(1)),
  }
}

export default Plugin.define({
  id: "opencode.plus",
  effect: (ctx) =>
    Effect.gen(function* () {
      const state = createState()
      // Applied registrations live on detached scopes, so without this
      // finalizer they outlive the plugin when core unloads or reactivates it.
      yield* Effect.addFinalizer(() => deactivate(state))
      const registration = yield* ctx.rpc.register(Definition, createHandlers(ctx, state)).pipe(Effect.orDie)
      state.registration = registration
      // Team tools exist in every Plus instance even with project mode off: a
      // child worktree has no .opencodeplus/project.json and still needs them,
      // so this stays out of activate/installTooling which require a project.
      yield* ensureTeamTooling(ctx, state)
      yield* activate(ctx, state).pipe(
        Effect.catchCause((cause) => Effect.logWarning("plus activation failed", { cause })),
      )
      yield* watchHostEvents(ctx, state)
    }),
})

export type SnapshotResult =
  | { ok: true; value: Plus.Snapshot }
  | { ok: false; error: { code: "project.disabled"; message: string; data: Plus.ProjectDisabled } }

export type RefreshResult = SnapshotResult

export type MutateResult =
  | { ok: true; value: Plus.MutateResult }
  | { ok: false; error: { code: "project.disabled"; message: string; data: Plus.ProjectDisabled } }

export type LogResult =
  | { ok: true; value: Plus.LogOutput }
  | { ok: false; error: { code: "project.disabled"; message: string; data: Plus.ProjectDisabled } }

export type AssembledResult =
  | { ok: true; value: Plus.Assembled }
  | {
      ok: false
      error:
        | { code: "project.disabled"; message: string; data: Plus.ProjectDisabled }
        | { code: "agent.unknown"; message: string; data: Plus.AgentUnknown }
    }

export type CreateAgentResult =
  | { ok: true; value: Plus.AgentRef }
  | {
      ok: false
      error:
        | { code: "project.disabled"; message: string; data: Plus.ProjectDisabled }
        | { code: "agent.exists"; message: string; data: Plus.AgentExists }
        | { code: "agent.invalid"; message: string; data: Plus.AgentInvalid }
    }

export type RenameAgentResult =
  | { ok: true; value: Plus.RenameAgentResult }
  | {
      ok: false
      error:
        | { code: "project.disabled"; message: string; data: Plus.ProjectDisabled }
        | { code: "agent.missing"; message: string; data: Plus.AgentMissing }
        | { code: "agent.exists"; message: string; data: Plus.AgentExists }
        | { code: "agent.invalid"; message: string; data: Plus.AgentInvalid }
    }

export type DeleteAgentResult =
  | { ok: true; value: Plus.AgentRef }
  | {
      ok: false
      error:
        | { code: "project.disabled"; message: string; data: Plus.ProjectDisabled }
        | { code: "agent.missing"; message: string; data: Plus.AgentMissing }
        | { code: "agent.invalid"; message: string; data: Plus.AgentInvalid }
    }

export type CreateSkillResult =
  | { ok: true; value: Plus.SkillRef }
  | {
      ok: false
      error:
        | { code: "project.disabled"; message: string; data: Plus.ProjectDisabled }
        | { code: "skill.exists"; message: string; data: Plus.SkillExists }
        | { code: "skill.invalid"; message: string; data: Plus.SkillInvalid }
    }

export type ImportSkillResult = CreateSkillResult

export type DeleteSkillResult =
  | { ok: true; value: Plus.SkillRef }
  | {
      ok: false
      error:
        | { code: "project.disabled"; message: string; data: Plus.ProjectDisabled }
        | { code: "skill.missing"; message: string; data: Plus.SkillMissing }
        | { code: "skill.invalid"; message: string; data: Plus.SkillInvalid }
    }

export type CreateBaseResult =
  | { ok: true; value: Plus.BaseRef }
  | {
      ok: false
      error:
        | { code: "project.disabled"; message: string; data: Plus.ProjectDisabled }
        | { code: "base.exists"; message: string; data: Plus.BaseExists }
        | { code: "base.invalid"; message: string; data: Plus.BaseInvalid }
    }

export type DeleteBaseResult =
  | { ok: true; value: Plus.BaseRef }
  | {
      ok: false
      error:
        | { code: "project.disabled"; message: string; data: Plus.ProjectDisabled }
        | { code: "base.missing"; message: string; data: Plus.BaseMissing }
        | { code: "base.invalid"; message: string; data: Plus.BaseInvalid }
    }

export type CreateInstructionApiResult =
  | { ok: true; value: Plus.InstructionRef }
  | {
      ok: false
      error:
        | { code: "project.disabled"; message: string; data: Plus.ProjectDisabled }
        | { code: "instruction.exists"; message: string; data: Plus.InstructionExists }
        | { code: "instruction.invalid"; message: string; data: Plus.InstructionInvalid }
    }

export type DeleteInstructionApiResult =
  | { ok: true; value: Plus.InstructionRef }
  | {
      ok: false
      error:
        | { code: "project.disabled"; message: string; data: Plus.ProjectDisabled }
        | { code: "instruction.missing"; message: string; data: Plus.InstructionMissing }
        | { code: "instruction.invalid"; message: string; data: Plus.InstructionInvalid }
    }

export type AddMcpResult =
  | { ok: true; value: Plus.McpRef }
  | {
      ok: false
      error:
        | { code: "project.disabled"; message: string; data: Plus.ProjectDisabled }
        | { code: "mcp.exists"; message: string; data: Plus.McpExists }
        | { code: "mcp.invalid"; message: string; data: Plus.McpInvalid }
    }

export type RemoveMcpResult =
  | { ok: true; value: Plus.McpRef }
  | {
      ok: false
      error:
        | { code: "project.disabled"; message: string; data: Plus.ProjectDisabled }
        | { code: "mcp.missing"; message: string; data: Plus.McpMissing }
        | { code: "mcp.invalid"; message: string; data: Plus.McpInvalid }
    }

export type SetTeamEnabledResult =
  | { ok: true; value: Plus.TeamRef }
  | {
      ok: false
      error:
        | { code: "project.disabled"; message: string; data: Plus.ProjectDisabled }
        | { code: "team.unknown"; message: string; data: Plus.TeamUnknown }
        | { code: "team.invalid"; message: string; data: Plus.TeamInvalid }
    }

export type CreateTeamResult =
  | { ok: true; value: Plus.TeamRef }
  | {
      ok: false
      error:
        | { code: "project.disabled"; message: string; data: Plus.ProjectDisabled }
        | { code: "team.exists"; message: string; data: Plus.TeamExists }
        | { code: "team.invalid"; message: string; data: Plus.TeamInvalid }
        | { code: "team.create"; message: string; data: Plus.TeamCreate }
    }

export type AddModelResult =
  | { ok: true; value: Plus.ModelRef }
  | {
      ok: false
      error:
        | { code: "project.disabled"; message: string; data: Plus.ProjectDisabled }
        | { code: "model.exists"; message: string; data: Plus.ModelExists }
        | { code: "model.invalid"; message: string; data: Plus.ModelInvalid }
    }

export type RemoveModelResult =
  | { ok: true; value: Plus.ModelRef }
  | {
      ok: false
      error:
        | { code: "project.disabled"; message: string; data: Plus.ProjectDisabled }
        | { code: "model.missing"; message: string; data: Plus.ModelMissing }
        | { code: "model.invalid"; message: string; data: Plus.ModelInvalid }
    }

export type CatalogModelsResult =
  | { ok: true; value: Plus.CatalogModelsOutput }
  | { ok: false; error: { code: "project.disabled"; message: string; data: Plus.ProjectDisabled } }

export type AddRuleResult =
  | { ok: true; value: Plus.RuleRef }
  | {
      ok: false
      error:
        | { code: "project.disabled"; message: string; data: Plus.ProjectDisabled }
        | { code: "rule.exists"; message: string; data: Plus.RuleExists }
        | { code: "rule.invalid"; message: string; data: Plus.RuleInvalid }
    }

export type RemoveRuleResult =
  | { ok: true; value: Plus.RuleRef }
  | {
      ok: false
      error:
        | { code: "project.disabled"; message: string; data: Plus.ProjectDisabled }
        | { code: "rule.missing"; message: string; data: Plus.RuleMissing }
        | { code: "rule.invalid"; message: string; data: Plus.RuleInvalid }
    }

export type UpdateRuleResult =
  | { ok: true; value: Plus.RuleRef }
  | {
      ok: false
      error:
        | { code: "project.disabled"; message: string; data: Plus.ProjectDisabled }
        | { code: "rule.invalid"; message: string; data: Plus.RuleInvalid }
    }

export interface PlusApi {
  readonly snapshot: () => Promise<SnapshotResult>
  readonly refresh: () => Promise<RefreshResult>
  readonly mutate: (input: Plus.MutateInput) => Promise<MutateResult>
  readonly log: (input: Plus.LogInput) => Promise<LogResult>
  readonly assembled: (input: Plus.AssembledInput) => Promise<AssembledResult>
  readonly catalogModels: () => Promise<CatalogModelsResult>
  readonly createAgent: (input: Plus.CreateAgentInput & { readonly actor?: Plus.Actor }) => Promise<CreateAgentResult>
  readonly renameAgent: (input: Plus.RenameAgentInput & { readonly actor?: Plus.Actor }) => Promise<RenameAgentResult>
  readonly deleteAgent: (input: Plus.DeleteAgentInput & { readonly actor?: Plus.Actor }) => Promise<DeleteAgentResult>
  readonly createSkill: (input: Plus.CreateSkillInput & { readonly actor?: Plus.Actor }) => Promise<CreateSkillResult>
  readonly importSkill: (input: Plus.ImportSkillInput & { readonly actor?: Plus.Actor }) => Promise<ImportSkillResult>
  readonly deleteSkill: (input: Plus.DeleteSkillInput & { readonly actor?: Plus.Actor }) => Promise<DeleteSkillResult>
  readonly createBase: (input: Plus.CreateBaseInput & { readonly actor?: Plus.Actor }) => Promise<CreateBaseResult>
  readonly deleteBase: (input: Plus.DeleteBaseInput & { readonly actor?: Plus.Actor }) => Promise<DeleteBaseResult>
  readonly createInstruction: (input: Plus.CreateInstructionInput & { readonly actor?: Plus.Actor }) => Promise<CreateInstructionApiResult>
  readonly deleteInstruction: (input: Plus.DeleteInstructionInput & { readonly actor?: Plus.Actor }) => Promise<DeleteInstructionApiResult>
  readonly addMcp: (input: Plus.AddMcpInput & { readonly actor?: Plus.Actor }) => Promise<AddMcpResult>
  readonly removeMcp: (input: Plus.McpRef & { readonly actor?: Plus.Actor }) => Promise<RemoveMcpResult>
  readonly createTeam: (input: Plus.CreateTeamInput & { readonly actor?: Plus.Actor }) => Promise<CreateTeamResult>
  readonly setTeamEnabled: (input: Plus.SetTeamEnabledInput & { readonly actor?: Plus.Actor }) => Promise<SetTeamEnabledResult>
  readonly addModel: (input: Plus.ModelAddInput & { readonly actor?: Plus.Actor }) => Promise<AddModelResult>
  readonly removeModel: (input: Plus.ModelRemoveInput & { readonly actor?: Plus.Actor }) => Promise<RemoveModelResult>
  readonly addRule: (input: Plus.RuleAddInput & { readonly actor?: Plus.Actor }) => Promise<AddRuleResult>
  readonly removeRule: (input: Plus.RuleRemoveInput & { readonly actor?: Plus.Actor }) => Promise<RemoveRuleResult>
  readonly updateRule: (input: Plus.RuleUpdateInput & { readonly actor?: Plus.Actor }) => Promise<UpdateRuleResult>
}

export interface PlusApiOptions {
  readonly builtins?: readonly BuiltinTeam[]
}

export function createPlusApi(ctx: Context, state: PlusState, options?: PlusApiOptions): PlusApi {
  const builtins = options?.builtins ?? builtinTeams
  return {
    snapshot: async () => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const stored = await load(directory)
      const loaded = { ...stored, protectedAgents: config.protectedAgents }
      const discovered = await discoverAll(ctx, loaded, state.baselines, state.modelBaselines)
      const teams = await snapshotTeams(directory, loaded.records, builtins)
      return { ok: true as const, value: toSnapshot(discovered, loaded, teams) }
    },
    refresh: async () => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const stored = await load(directory)
      const loaded = { ...stored, protectedAgents: config.protectedAgents }
      const discovered = await Effect.runPromise(publishFresh(ctx, state, loaded, builtins))
      const teams = await snapshotTeams(directory, loaded.records, builtins)
      return { ok: true as const, value: toSnapshot(discovered, loaded, teams) }
    },
    mutate: async (input) => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const stored = await load(directory)
      const loaded = { ...stored, protectedAgents: config.protectedAgents }
      const staleStore =
        input.expectedRevision !== loaded.projectRevision
          ? ("project" as const)
          : input.expectedGlobalRevision !== loaded.globalRevision
            ? ("global" as const)
            : undefined
      if (staleStore !== undefined) {
        const discovered = await discoverAll(ctx, loaded, state.baselines, state.modelBaselines)
        const staleTeams = await snapshotTeams(directory, loaded.records, builtins)
        return {
          ok: true as const,
          value: { ok: false as const, reason: "stale" as const, store: staleStore, snapshot: toSnapshot(discovered, loaded, staleTeams) },
        }
      }
      const records: StoredRecord[] = [
        ...input.records.map(toRecord),
        ...loaded.records.filter((record) => record.type === "team"),
      ]
      const saved = await save(directory, {
        expectedProjectRevision: loaded.projectRevision,
        expectedGlobalRevision: loaded.globalRevision,
        records,
      })
      if (!saved.ok) {
        const refreshed = { ...saved.current, protectedAgents: loaded.protectedAgents }
        const discovered = await discoverAll(ctx, refreshed, state.baselines, state.modelBaselines)
        const staleTeams = await snapshotTeams(directory, refreshed.records, builtins)
        return {
          ok: true as const,
          value: { ok: false as const, reason: "stale" as const, store: saved.store, snapshot: toSnapshot(discovered, refreshed, staleTeams) },
        }
      }
      await logMutate({
        directory,
        actor: normalizeActor(input.actor),
        before: loaded.records,
        after: records,
        projectRevision: saved.projectRevision,
        globalRevision: saved.globalRevision,
        projectChanged: saved.changed.project,
        globalChanged: saved.changed.global,
      })
      const reloaded = await load(directory)
      const next = { ...reloaded, protectedAgents: loaded.protectedAgents }
      const discovered = await Effect.runPromise(publishFresh(ctx, state, next, builtins))
      const teams = await snapshotTeams(directory, next.records, builtins)
      const snapshot = toSnapshot(discovered, next, teams)
      return { ok: true as const, value: { ok: true as const, revision: next.projectRevision, globalRevision: next.globalRevision, snapshot } }
    },
    log: async (input) => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const merged = await readBoth(directory, { ...(input.where === undefined ? {} : { where: input.where }) })
      const offset = input.offset === undefined || Number.isNaN(input.offset) ? 0 : Math.max(0, Math.floor(input.offset))
      const limit = input.limit === undefined || Number.isNaN(input.limit) ? undefined : Math.max(0, Math.floor(input.limit))
      const total = merged.length
      const entries = limit === undefined ? merged.slice(offset) : merged.slice(offset, offset + limit)
      return { ok: true as const, value: { entries: [...entries], total } }
    },
    assembled: async (input) => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const stored = await load(directory)
      const loaded = { ...stored, protectedAgents: config.protectedAgents }
      const discovered = await discoverAll(ctx, loaded, state.baselines, state.modelBaselines)
      const result = await assembled({
        ctx,
        agent: input.agent,
        items: discovered.items,
        agents: discovered.agents.map((agent) => ({ id: agent.id, level: scopeLevel(agent.scope) })),
        records: customizationsOf(loaded.records),
        splits: splitsOf(loaded.records),
        scopes: scopesOf(discovered.agents),
        installedTools: state.installedTools,
      })
      if ("ok" in result)
        return {
          ok: false as const,
          error: { code: "agent.unknown" as const, message: `Unknown agent ${input.agent}`, data: { agent: input.agent } },
        }
      return { ok: true as const, value: result }
    },
    createAgent: async (input) => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const validated = validateAgentId(input.id)
      if (!validated.ok)
        return {
          ok: false as const,
          error: { code: "agent.invalid" as const, message: validated.reason, data: { id: input.id, reason: validated.reason } },
        }
      if (config.protectedAgents.includes(validated.id))
        return {
          ok: false as const,
          error: {
            code: "agent.invalid" as const,
            message: `agent.protected: row belongs to protected agent "${validated.id}"`,
            data: { id: input.id, reason: `agent.protected: row belongs to protected agent "${validated.id}"` },
          },
        }
      const seed = input.template === undefined ? undefined : await readTemplate(ctx, directory, input.template as string)
      if (input.template !== undefined && seed === undefined)
        return {
          ok: false as const,
          error: {
            code: "agent.invalid" as const,
            message: `Unknown template ${input.template}`,
            data: { id: input.id, reason: `Unknown template ${input.template}` },
          },
        }
      const created = await create({
        scope: input.scope,
        projectDirectory: directory,
        id: validated.id,
        fields: seed?.fields ?? toAgentFields(input.fields),
        prompt: seed?.prompt ?? input.prompt,
      })
      if (!created.ok)
        return {
          ok: false as const,
          error: {
            code: "agent.exists" as const,
            message: `Agent ${validated.id} already exists at ${created.path}`,
            data: { path: created.path },
          },
        }
      await Effect.runPromise(ctx.agent.reload())
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins, true))
      await logFileOp({
        directory,
        actor: normalizeActor(input.actor),
        scope: input.scope,
        op: "agent.create",
        target: created.path,
        summary: `agent.create ${validated.id} (${input.scope})`,
      })
      return { ok: true as const, value: { id: validated.id, path: created.path } }
    },
    renameAgent: async (input) => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const from = validateAgentId(input.from)
      if (!from.ok)
        return {
          ok: false as const,
          error: { code: "agent.invalid" as const, message: from.reason, data: { id: input.from, reason: from.reason } },
        }
      const to = validateAgentId(input.to)
      if (!to.ok)
        return {
          ok: false as const,
          error: { code: "agent.invalid" as const, message: to.reason, data: { id: input.to, reason: to.reason } },
        }
      const renamed = await rename({ scope: input.scope, projectDirectory: directory, from: from.id, to: to.id })
      if (!renamed.ok && renamed.reason === "missing-source")
        return {
          ok: false as const,
          error: { code: "agent.missing" as const, message: `Agent ${from.id} does not exist at ${renamed.path}`, data: { path: renamed.path } },
        }
      if (!renamed.ok)
        return {
          ok: false as const,
          error: { code: "agent.exists" as const, message: `Agent ${to.id} already exists at ${renamed.path}`, data: { path: renamed.path } },
        }
      await Effect.runPromise(ctx.agent.reload())
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins, true))
      await logFileOp({
        directory,
        actor: normalizeActor(input.actor),
        scope: input.scope,
        op: "agent.rename",
        target: renamed.toPath,
        summary: `agent.rename ${from.id} to ${to.id} (${input.scope})`,
      })
      return { ok: true as const, value: { from: from.id, to: to.id, path: renamed.toPath } }
    },
    deleteAgent: async (input) => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const validated = validateAgentId(input.id)
      if (!validated.ok)
        return {
          ok: false as const,
          error: { code: "agent.invalid" as const, message: validated.reason, data: { id: input.id, reason: validated.reason } },
        }
      const removed = await remove({ scope: input.scope, projectDirectory: directory, id: validated.id })
      if (!removed.ok)
        return {
          ok: false as const,
          error: {
            code: "agent.missing" as const,
            message: `Agent ${validated.id} does not exist at ${removed.path}`,
            data: { path: removed.path },
          },
        }
      await Effect.runPromise(ctx.agent.reload())
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins, true))
      await logFileOp({
        directory,
        actor: normalizeActor(input.actor),
        scope: input.scope,
        op: "agent.delete",
        target: removed.path,
        summary: `agent.delete ${validated.id} (${input.scope})`,
      })
      return { ok: true as const, value: { id: validated.id, path: removed.path } }
    },
    createSkill: async (input) => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const result = await createSkill({ projectDirectory: directory, name: input.name, body: input.body })
      if (!result.ok && result.reason === "exists")
        return {
          ok: false as const,
          error: { code: "skill.exists" as const, message: `Skill ${result.id} already exists`, data: { id: result.id } },
        }
      if (!result.ok)
        return {
          ok: false as const,
          error: { code: "skill.invalid" as const, message: result.message, data: { id: result.id, reason: result.message } },
        }
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory))
      await logFileOp({ directory, actor: normalizeActor(input.actor), scope: "project", op: "skill.create", target: result.path, summary: `skill.create ${result.id}` })
      return { ok: true as const, value: { id: result.id, path: result.path } }
    },
    importSkill: async (input) => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const result = await importSkill({ projectDirectory: directory, path: input.path })
      if (!result.ok && result.reason === "exists")
        return {
          ok: false as const,
          error: { code: "skill.exists" as const, message: `Skill ${result.id} already exists`, data: { id: result.id } },
        }
      if (!result.ok)
        return {
          ok: false as const,
          error: { code: "skill.invalid" as const, message: result.message, data: { id: result.id, reason: result.message } },
        }
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory))
      await logFileOp({ directory, actor: normalizeActor(input.actor), scope: "project", op: "skill.import", target: result.path, summary: `skill.import ${result.id}` })
      return { ok: true as const, value: { id: result.id, path: result.path } }
    },
    deleteSkill: async (input) => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const result = await deleteSkill({ projectDirectory: directory, id: input.id })
      if (!result.ok && result.reason === "missing")
        return {
          ok: false as const,
          error: { code: "skill.missing" as const, message: `Skill ${result.id} does not exist`, data: { id: result.id } },
        }
      if (!result.ok)
        return {
          ok: false as const,
          error: { code: "skill.invalid" as const, message: result.message, data: { id: result.id, reason: result.message } },
        }
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory))
      await logFileOp({ directory, actor: normalizeActor(input.actor), scope: "project", op: "skill.delete", target: result.path, summary: `skill.delete ${result.id}` })
      return { ok: true as const, value: { id: result.id, path: result.path } }
    },
    createBase: async (input) => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const result = await createBaseTemplate(input.id, input.title, input.text)
      if (!result.ok && result.reason === "exists")
        return {
          ok: false as const,
          error: { code: "base.exists" as const, message: `Base template ${result.id} already exists`, data: { id: result.id } },
        }
      if (!result.ok)
        return {
          ok: false as const,
          error: { code: "base.invalid" as const, message: result.message, data: { id: result.id, reason: result.message } },
        }
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory))
      await logFileOp({
        directory,
        actor: normalizeActor(input.actor),
        scope: "global",
        op: "base.create",
        target: userBaseFile(result.id),
        summary: `base.create ${result.id}`,
      })
      return { ok: true as const, value: { id: result.id } }
    },
    deleteBase: async (input) => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const result = await deleteBaseTemplate(input.id)
      if (!result.ok && result.reason === "missing")
        return {
          ok: false as const,
          error: { code: "base.missing" as const, message: `Base template ${result.id} does not exist`, data: { id: result.id } },
        }
      if (!result.ok)
        return {
          ok: false as const,
          error: { code: "base.invalid" as const, message: result.message, data: { id: result.id, reason: result.message } },
        }
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory))
      await logFileOp({
        directory,
        actor: normalizeActor(input.actor),
        scope: "global",
        op: "base.delete",
        target: userBaseFile(result.id),
        summary: `base.delete ${result.id}`,
      })
      return { ok: true as const, value: { id: result.id } }
    },
    createInstruction: async (input) => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const result = await createInstruction({
        sessionDirectory: directory,
        projectDirectory: ctx.location.project.directory,
        name: input.name,
        text: input.text,
      })
      if (!result.ok && result.reason === "exists")
        return {
          ok: false as const,
          error: { code: "instruction.exists" as const, message: `Instruction already exists at ${result.path}`, data: { path: result.path } },
        }
      if (!result.ok)
        return {
          ok: false as const,
          error: { code: "instruction.invalid" as const, message: result.message, data: { name: input.name, reason: result.message } },
        }
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory))
      await logFileOp({
        directory,
        actor: normalizeActor(input.actor),
        scope: "project",
        op: "instruction.create",
        target: result.path,
        summary: `instruction.create ${input.name}`,
      })
      return { ok: true as const, value: { id: result.id, path: result.path } }
    },
    deleteInstruction: async (input) => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const result = await deleteInstruction({ projectDirectory: directory, name: input.name })
      if (!result.ok && result.reason === "missing")
        return {
          ok: false as const,
          error: { code: "instruction.missing" as const, message: `Instruction ${result.name} does not exist`, data: { name: result.name } },
        }
      if (!result.ok)
        return {
          ok: false as const,
          error: { code: "instruction.invalid" as const, message: result.message, data: { name: result.id, reason: result.message } },
        }
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory))
      await logFileOp({
        directory,
        actor: normalizeActor(input.actor),
        scope: "project",
        op: "instruction.delete",
        target: result.path,
        summary: `instruction.delete ${input.name}`,
      })
      return { ok: true as const, value: { id: result.id, path: result.path } }
    },
    addMcp: async (input) => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const result = await addMcp({ projectDirectory: directory, name: input.name, config: { ...input.config } })
      if (!result.ok && result.reason === "exists")
        return {
          ok: false as const,
          error: { code: "mcp.exists" as const, message: `MCP server ${result.name} already exists`, data: { name: result.name } },
        }
      if (!result.ok)
        return {
          ok: false as const,
          error: { code: "mcp.invalid" as const, message: result.message, data: { name: result.name, reason: result.message } },
        }
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory))
      const addedConfig = await mcpConfigTarget(directory)
      await logFileOp({ directory, actor: normalizeActor(input.actor), scope: "project", op: "mcp.add", target: addedConfig, summary: `mcp.add ${result.name}` })
      return { ok: true as const, value: { name: result.name } }
    },
    removeMcp: async (input) => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const result = await removeMcp({ projectDirectory: directory, name: input.name })
      if (!result.ok && result.reason === "missing")
        return {
          ok: false as const,
          error: { code: "mcp.missing" as const, message: `MCP server ${result.name} does not exist`, data: { name: result.name } },
        }
      if (!result.ok)
        return {
          ok: false as const,
          error: { code: "mcp.invalid" as const, message: result.message, data: { name: result.name, reason: result.message } },
        }
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory))
      const removedConfig = await mcpConfigTarget(directory)
      await logFileOp({ directory, actor: normalizeActor(input.actor), scope: "project", op: "mcp.remove", target: removedConfig, summary: `mcp.remove ${result.name}` })
      return { ok: true as const, value: { name: result.name } }
    },
    createTeam: async (input) => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const validated = validateTeamName(input.team)
      if (!validated.ok)
        return {
          ok: false as const,
          error: { code: "team.invalid" as const, message: validated.reason, data: { team: input.team, reason: validated.reason } },
        }
      if (input.level === "defaults") {
        const reason = `Team "${validated.team}" is built in and cannot be created`
        return {
          ok: false as const,
          error: { code: "team.invalid" as const, message: reason, data: { team: input.team, reason } },
        }
      }
      const root = input.level === "project" ? projectTeamsPath(directory) : globalTeamsPath()
      const ensured = await fs.mkdir(root, { recursive: true }).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      if (!ensured.ok) {
        const reason = messageOf(ensured.error)
        return {
          ok: false as const,
          error: { code: "team.create" as const, message: `Could not create team ${validated.team}: ${reason}`, data: { level: input.level, team: validated.team, reason } },
        }
      }
      const made = await fs.mkdir(path.join(root, validated.team)).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      if (!made.ok) {
        const code = typeof made.error === "object" && made.error !== null && "code" in made.error ? made.error.code : undefined
        if (code === "EEXIST")
          return {
            ok: false as const,
            error: { code: "team.exists" as const, message: `Team ${validated.team} already exists`, data: { level: input.level, team: validated.team } },
          }
        const reason = messageOf(made.error)
        return {
          ok: false as const,
          error: { code: "team.create" as const, message: `Could not create team ${validated.team}: ${reason}`, data: { level: input.level, team: validated.team, reason } },
        }
      }
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins))
      await logFileOp({
        directory,
        actor: normalizeActor(input.actor),
        scope: input.level,
        op: "team.create",
        target: `team:${input.level}:${validated.team}`,
        summary: `team.create ${validated.team} (${input.level})`,
      })
      return { ok: true as const, value: { level: input.level, team: validated.team, enabled: false } }
    },
    setTeamEnabled: async (input) => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const stored = await load(directory)
      const loaded = { ...stored, protectedAgents: config.protectedAgents }
      const validated = validateTeamName(input.team)
      if (!validated.ok)
        return {
          ok: false as const,
          error: { code: "team.invalid" as const, message: validated.reason, data: { team: input.team, reason: validated.reason } },
        }
      const known = await discoverTeams(input.level, directory, builtins)
      if (!known.some((team) => team.team === validated.team))
        return {
          ok: false as const,
          error: { code: "team.unknown" as const, message: `Unknown team ${validated.team}`, data: { level: input.level, team: validated.team } },
        }
      const saved = await saveTeamRecord(directory, loaded, input.level, validated.team, input.enabled)
      if (!saved.ok)
        return {
          ok: false as const,
          error: {
            code: "team.unknown" as const,
            message: `Team ${validated.team} changed concurrently; retry`,
            data: { level: input.level, team: validated.team },
          },
        }
      if (saved.changed)
        await append(input.level === "project" ? projectLogPath(directory) : globalLogPath(), {
          ts: new Date().toISOString(),
          actor: normalizeActor(input.actor),
          op: "team.setEnabled",
          target: `team:${input.level}:${validated.team}`,
          summary: `team.setEnabled ${validated.team} ${input.enabled ? "enabled" : "disabled"} (${input.level})`,
          revision: saved.revision,
        })
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins))
      return { ok: true as const, value: { level: input.level, team: validated.team, enabled: input.enabled } }
    },
    catalogModels: async () => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const catalog = await Effect.runPromise(
        ctx.catalog.model.list().pipe(Effect.catchCause(() => Effect.succeed({ data: [] as readonly Model.Info[] }))),
      )
      const models = catalog.data.flatMap((entry): Plus.CatalogModel[] => {
        const providerID = String(entry.providerID)
        const modelID = String(entry.id)
        const name = String(entry.name ?? entry.id)
        const base: Plus.CatalogModel = { providerID, modelID, name }
        const variants = (entry.variants ?? []).map(
          (variant): Plus.CatalogModel => ({
            providerID,
            modelID,
            variant: String(variant.id),
            name,
          }),
        )
        return [base, ...variants]
      })
      return { ok: true as const, value: { models } }
    },
    addModel: async (input) => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const validated = validateModelRef(input.providerID, input.modelID, input.variant)
      if (!validated.ok)
        return {
          ok: false as const,
          error: { code: "model.invalid" as const, message: validated.reason, data: { providerID: input.providerID, modelID: input.modelID, ...(input.variant === undefined ? {} : { variant: input.variant }), reason: validated.reason } },
        }
      if (input.agent === null && input.level !== "defaults") {
        const reason = "Shared model rows live at defaults only"
        return {
          ok: false as const,
          error: { code: "model.invalid" as const, message: reason, data: { providerID: validated.providerID, modelID: validated.modelID, ...(validated.variant === undefined ? {} : { variant: validated.variant }), reason } },
        }
      }
      const catalog = await Effect.runPromise(
        ctx.catalog.model.list().pipe(Effect.catchCause(() => Effect.succeed({ data: [] as readonly Model.Info[] }))),
      )
      if (!catalogHas(catalog.data, validated.providerID, validated.modelID, validated.variant)) {
        const reason = `Unknown model ${validated.providerID}/${validated.modelID}${validated.variant === undefined ? "" : `@${validated.variant}`}`
        return {
          ok: false as const,
          error: { code: "model.invalid" as const, message: reason, data: { providerID: validated.providerID, modelID: validated.modelID, ...(validated.variant === undefined ? {} : { variant: validated.variant }), reason } },
        }
      }
      const stored = await load(directory)
      const loaded = { ...stored, protectedAgents: config.protectedAgents }
      const existing = loaded.records.find(
        (record): record is ModelRecord =>
          record.type === "model" &&
          record.level === input.level &&
          record.agent === input.agent &&
          record.providerID === validated.providerID &&
          record.modelID === validated.modelID &&
          record.variant === validated.variant,
      )
      if (existing !== undefined)
        return {
          ok: false as const,
          error: {
            code: "model.exists" as const,
            message: `Model ${validated.providerID}/${validated.modelID} already exists`,
            data: { level: input.level, agent: input.agent, providerID: validated.providerID, modelID: validated.modelID, ...(validated.variant === undefined ? {} : { variant: validated.variant }) },
          },
        }
      const next: ModelRecord = {
        type: "model",
        level: input.level,
        agent: input.agent,
        providerID: validated.providerID,
        modelID: validated.modelID,
        ...(validated.variant === undefined ? {} : { variant: validated.variant }),
        updated: new Date().toISOString(),
      }
      const saved = await saveModelRecords(directory, loaded, [...loaded.records, next])
      if (!saved.ok) {
        const reason = `Model ${validated.providerID}/${validated.modelID} changed concurrently; retry`
        return {
          ok: false as const,
          error: { code: "model.invalid" as const, message: reason, data: { providerID: validated.providerID, modelID: validated.modelID, ...(validated.variant === undefined ? {} : { variant: validated.variant }), reason } },
        }
      }
      if (saved.changed)
        await append(input.level === "project" ? projectLogPath(directory) : globalLogPath(), {
          ts: new Date().toISOString(),
          actor: normalizeActor(input.actor),
          op: "model.add",
          target: modelRecordTarget(next),
          summary: `model.add ${validated.providerID}/${validated.modelID} (${input.level})`,
          revision: saved.revision,
        })
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins))
      return {
        ok: true as const,
        value: {
          level: next.level,
          agent: next.agent,
          providerID: next.providerID,
          modelID: next.modelID,
          ...(next.variant === undefined ? {} : { variant: next.variant }),
        },
      }
    },
    removeModel: async (input) => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const validated = validateModelRef(input.providerID, input.modelID, input.variant)
      if (!validated.ok)
        return {
          ok: false as const,
          error: { code: "model.invalid" as const, message: validated.reason, data: { providerID: input.providerID, modelID: input.modelID, ...(input.variant === undefined ? {} : { variant: input.variant }), reason: validated.reason } },
        }
      const stored = await load(directory)
      const loaded = { ...stored, protectedAgents: config.protectedAgents }
      const existing = loaded.records.find(
        (record): record is ModelRecord =>
          record.type === "model" &&
          record.level === input.level &&
          record.agent === input.agent &&
          record.providerID === validated.providerID &&
          record.modelID === validated.modelID &&
          record.variant === validated.variant,
      )
      if (existing === undefined)
        return {
          ok: false as const,
          error: {
            code: "model.missing" as const,
            message: `Model ${validated.providerID}/${validated.modelID} does not exist`,
            data: { level: input.level, agent: input.agent, providerID: validated.providerID, modelID: validated.modelID, ...(validated.variant === undefined ? {} : { variant: validated.variant }) },
          },
        }
      const next = loaded.records.filter((record) => record !== existing)
      const saved = await saveModelRecords(directory, loaded, next)
      if (!saved.ok) {
        const reason = `Model ${validated.providerID}/${validated.modelID} changed concurrently; retry`
        return {
          ok: false as const,
          error: { code: "model.invalid" as const, message: reason, data: { providerID: validated.providerID, modelID: validated.modelID, ...(validated.variant === undefined ? {} : { variant: validated.variant }), reason } },
        }
      }
      if (saved.changed)
        await append(input.level === "project" ? projectLogPath(directory) : globalLogPath(), {
          ts: new Date().toISOString(),
          actor: normalizeActor(input.actor),
          op: "model.remove",
          target: modelRecordTarget(existing),
          summary: `model.remove ${validated.providerID}/${validated.modelID} (${input.level})`,
          revision: saved.revision,
        })
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins))
      return {
        ok: true as const,
        value: {
          level: existing.level,
          agent: existing.agent,
          providerID: existing.providerID,
          modelID: existing.modelID,
          ...(existing.variant === undefined ? {} : { variant: existing.variant }),
        },
      }
    },
    addRule: async (input) => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const validated = validateRuleRef(input.tool, input.id, input.label, input.patterns, input.keywords)
      if (!validated.ok)
        return {
          ok: false as const,
          error: { code: "rule.invalid" as const, message: validated.reason, data: { tool: input.tool, id: input.id, reason: validated.reason } },
        }
      const stored = await load(directory)
      const loaded = { ...stored, protectedAgents: config.protectedAgents }
      const existing = loaded.records.find(
        (record): record is RuleRecord => record.type === "rule" && record.tool === validated.tool && record.id === validated.id,
      )
      if (existing !== undefined)
        return {
          ok: false as const,
          error: {
            code: "rule.exists" as const,
            message: `Rule ${validated.tool}:${validated.id} already exists`,
            data: { level: existing.level, agent: existing.agent, tool: validated.tool, id: validated.id },
          },
        }
      const next: RuleRecord = {
        type: "rule",
        level: input.level,
        agent: input.agent,
        tool: validated.tool,
        id: validated.id,
        label: validated.label,
        patterns: validated.patterns,
        keywords: validated.keywords,
        updated: new Date().toISOString(),
      }
      const saved = await saveRuleRecords(directory, loaded, [...loaded.records, next])
      if (!saved.ok) {
        const reason = `Rule ${validated.tool}:${validated.id} changed concurrently; retry`
        return {
          ok: false as const,
          error: { code: "rule.invalid" as const, message: reason, data: { tool: validated.tool, id: validated.id, reason } },
        }
      }
      if (saved.changed)
        await append(input.level === "project" ? projectLogPath(directory) : globalLogPath(), {
          ts: new Date().toISOString(),
          actor: normalizeActor(input.actor),
          op: "rule.add",
          target: ruleRecordTarget(next),
          summary: `rule.add ${validated.tool}:${validated.id} (${input.level})`,
          revision: saved.revision,
        })
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins))
      return { ok: true as const, value: { level: next.level, agent: next.agent, tool: next.tool, id: next.id, label: next.label } }
    },
    removeRule: async (input) => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const validated = validateRuleIdentity(input.tool, input.id)
      if (!validated.ok)
        return {
          ok: false as const,
          error: { code: "rule.invalid" as const, message: validated.reason, data: { tool: input.tool, id: input.id, reason: validated.reason } },
        }
      const stored = await load(directory)
      const loaded = { ...stored, protectedAgents: config.protectedAgents }
      const existing = loaded.records.find(
        (record): record is RuleRecord => record.type === "rule" && record.tool === validated.tool && record.id === validated.id,
      )
      if (existing === undefined)
        return {
          ok: false as const,
          error: {
            code: "rule.missing" as const,
            message: `Rule ${validated.tool}:${validated.id} does not exist`,
            data: { level: input.level, agent: input.agent, tool: validated.tool, id: validated.id },
          },
        }
      const protectedRefusal = ruleProtectedRefusal(loaded.protectedAgents, existing)
      if (protectedRefusal !== undefined)
        return {
          ok: false as const,
          error: { code: "rule.invalid" as const, message: protectedRefusal, data: { tool: validated.tool, id: validated.id, reason: protectedRefusal } },
        }
      const next = loaded.records.filter((record) => record !== existing)
      const saved = await saveRuleRecords(directory, loaded, next)
      if (!saved.ok) {
        const reason = `Rule ${validated.tool}:${validated.id} changed concurrently; retry`
        return {
          ok: false as const,
          error: { code: "rule.invalid" as const, message: reason, data: { tool: validated.tool, id: validated.id, reason } },
        }
      }
      if (saved.changed)
        await append(existing.level === "project" ? projectLogPath(directory) : globalLogPath(), {
          ts: new Date().toISOString(),
          actor: normalizeActor(input.actor),
          op: "rule.remove",
          target: ruleRecordTarget(existing),
          summary: `rule.remove ${validated.tool}:${validated.id} (${existing.level})`,
          revision: saved.revision,
        })
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins))
      return { ok: true as const, value: { level: existing.level, agent: existing.agent, tool: existing.tool, id: existing.id, label: existing.label } }
    },
    updateRule: async (input) => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const validated = validateRuleRef(input.tool, input.id, input.label, input.patterns, input.keywords)
      if (!validated.ok)
        return {
          ok: false as const,
          error: { code: "rule.invalid" as const, message: validated.reason, data: { tool: input.tool, id: input.id, reason: validated.reason } },
        }
      const stored = await load(directory)
      const loaded = { ...stored, protectedAgents: config.protectedAgents }
      const existing = loaded.records.find(
        (record): record is RuleRecord => record.type === "rule" && record.tool === validated.tool && record.id === validated.id,
      )
      const refusal = ruleProtectedRefusal(loaded.protectedAgents, existing)
      if (refusal !== undefined)
        return {
          ok: false as const,
          error: { code: "rule.invalid" as const, message: refusal, data: { tool: validated.tool, id: validated.id, reason: refusal } },
        }
      const next: RuleRecord = {
        type: "rule",
        level: existing === undefined ? input.level : existing.level,
        agent: existing === undefined ? input.agent : existing.agent,
        tool: validated.tool,
        id: validated.id,
        label: validated.label,
        patterns: validated.patterns,
        keywords: validated.keywords,
        updated: new Date().toISOString(),
      }
      const nextRecords = existing === undefined ? [...loaded.records, next] : loaded.records.map((record) => (record === existing ? next : record))
      const saved = await saveRuleRecords(directory, loaded, nextRecords)
      if (!saved.ok) {
        const reason = `Rule ${validated.tool}:${validated.id} changed concurrently; retry`
        return {
          ok: false as const,
          error: { code: "rule.invalid" as const, message: reason, data: { tool: validated.tool, id: validated.id, reason } },
        }
      }
      if (saved.changed)
        await append(next.level === "project" ? projectLogPath(directory) : globalLogPath(), {
          ts: new Date().toISOString(),
          actor: normalizeActor(input.actor),
          op: "rule.update",
          target: ruleRecordTarget(next),
          summary: `rule.update ${validated.tool}:${validated.id} (${next.level})`,
          revision: saved.revision,
        })
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins))
      return { ok: true as const, value: { level: next.level, agent: next.agent, tool: next.tool, id: next.id, label: next.label } }
    },
  }
}

export function createHandlers(ctx: Context, state: PlusState, options?: PlusApiOptions): RpcHandlers<typeof Definition> {
  const api = createPlusApi(ctx, state, options)
  return {
    "project.status": () =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        const config = yield* Effect.promise(() => read(directory))
        return {
          enabled: config !== undefined,
          directory,
        }
      }),
    "project.enable": () =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        yield* Effect.promise(() => enable(directory))
        const status: Plus.Status = {
          enabled: true,
          directory,
        }
        if (state.registration) {
          yield* state.registration.events.emit("project.changed", status).pipe(Effect.orDie)
        }
        yield* activate(ctx, state)
        return status
      }),
    "project.disable": () =>
      Effect.gen(function* () {
        const directory = ctx.location.directory
        yield* Effect.promise(() => disable(directory))
        const status: Plus.Status = {
          enabled: false,
          directory,
        }
        if (state.registration) {
          yield* state.registration.events.emit("project.changed", status).pipe(Effect.orDie)
        }
        yield* deactivate(state)
        return status
      }),
    "instructions.snapshot": (_input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.snapshot())
        if (!result.ok) return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
        return result.value
      }),
    "instructions.refresh": (_input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.refresh())
        if (!result.ok) return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
        return result.value
      }),
    "instructions.mutate": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.mutate(input))
        if (!result.ok) return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
        return result.value
      }),
    "instructions.log": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.log(input))
        if (!result.ok) return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
        return result.value
      }),
    "instructions.assembled": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.assembled(input))
        if (!result.ok) {
          if (result.error.code === "project.disabled")
            return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("agent.unknown", result.error.message, result.error.data))
        }
        return result.value
      }),
    "agent.create": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.createAgent(input))
        if (!result.ok) {
          if (result.error.code === "project.disabled")
            return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
          if (result.error.code === "agent.exists")
            return yield* Effect.fail(context.error("agent.exists", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("agent.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "agent.rename": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.renameAgent(input))
        if (!result.ok) {
          if (result.error.code === "project.disabled")
            return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
          if (result.error.code === "agent.missing")
            return yield* Effect.fail(context.error("agent.missing", result.error.message, result.error.data))
          if (result.error.code === "agent.exists")
            return yield* Effect.fail(context.error("agent.exists", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("agent.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "agent.delete": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.deleteAgent(input))
        if (!result.ok) {
          if (result.error.code === "project.disabled")
            return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
          if (result.error.code === "agent.missing")
            return yield* Effect.fail(context.error("agent.missing", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("agent.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "skill.create": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.createSkill(input))
        if (!result.ok) {
          if (result.error.code === "project.disabled")
            return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
          if (result.error.code === "skill.exists")
            return yield* Effect.fail(context.error("skill.exists", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("skill.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "skill.import": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.importSkill(input))
        if (!result.ok) {
          if (result.error.code === "project.disabled")
            return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
          if (result.error.code === "skill.exists")
            return yield* Effect.fail(context.error("skill.exists", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("skill.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "skill.delete": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.deleteSkill(input))
        if (!result.ok) {
          if (result.error.code === "project.disabled")
            return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
          if (result.error.code === "skill.missing")
            return yield* Effect.fail(context.error("skill.missing", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("skill.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "base.create": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.createBase(input))
        if (!result.ok) {
          if (result.error.code === "project.disabled")
            return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
          if (result.error.code === "base.exists")
            return yield* Effect.fail(context.error("base.exists", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("base.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "base.delete": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.deleteBase(input))
        if (!result.ok) {
          if (result.error.code === "project.disabled")
            return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
          if (result.error.code === "base.missing")
            return yield* Effect.fail(context.error("base.missing", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("base.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "instruction.create": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.createInstruction(input))
        if (!result.ok) {
          if (result.error.code === "project.disabled")
            return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
          if (result.error.code === "instruction.exists")
            return yield* Effect.fail(context.error("instruction.exists", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("instruction.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "instruction.delete": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.deleteInstruction(input))
        if (!result.ok) {
          if (result.error.code === "project.disabled")
            return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
          if (result.error.code === "instruction.missing")
            return yield* Effect.fail(context.error("instruction.missing", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("instruction.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "mcp.add": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.addMcp(input))
        if (!result.ok) {
          if (result.error.code === "project.disabled")
            return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
          if (result.error.code === "mcp.exists")
            return yield* Effect.fail(context.error("mcp.exists", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("mcp.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "mcp.remove": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.removeMcp(input))
        if (!result.ok) {
          if (result.error.code === "project.disabled")
            return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
          if (result.error.code === "mcp.missing")
            return yield* Effect.fail(context.error("mcp.missing", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("mcp.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "team.create": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.createTeam(input))
        if (!result.ok) {
          if (result.error.code === "project.disabled")
            return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
          if (result.error.code === "team.exists")
            return yield* Effect.fail(context.error("team.exists", result.error.message, result.error.data))
          if (result.error.code === "team.invalid")
            return yield* Effect.fail(context.error("team.invalid", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("team.create", result.error.message, result.error.data))
        }
        return result.value
      }),
    "team.setEnabled": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.setTeamEnabled(input))
        if (!result.ok) {
          if (result.error.code === "project.disabled")
            return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
          if (result.error.code === "team.invalid")
            return yield* Effect.fail(context.error("team.invalid", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("team.unknown", result.error.message, result.error.data))
        }
        return result.value
      }),
    "model.add": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.addModel(input))
        if (!result.ok) {
          if (result.error.code === "project.disabled")
            return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
          if (result.error.code === "model.exists")
            return yield* Effect.fail(context.error("model.exists", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("model.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "model.remove": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.removeModel(input))
        if (!result.ok) {
          if (result.error.code === "project.disabled")
            return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
          if (result.error.code === "model.missing")
            return yield* Effect.fail(context.error("model.missing", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("model.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "rule.add": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.addRule(input))
        if (!result.ok) {
          if (result.error.code === "project.disabled")
            return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
          if (result.error.code === "rule.exists")
            return yield* Effect.fail(context.error("rule.exists", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("rule.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "rule.remove": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.removeRule(input))
        if (!result.ok) {
          if (result.error.code === "project.disabled")
            return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
          if (result.error.code === "rule.missing")
            return yield* Effect.fail(context.error("rule.missing", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("rule.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "rule.update": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.updateRule(input))
        if (!result.ok) {
          if (result.error.code === "project.disabled")
            return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("rule.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "catalog.models": (_input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.catalogModels())
        if (!result.ok) return yield* Effect.fail(context.error("project.disabled", result.error.message, result.error.data))
        return result.value
      }),
  }
}

interface LoadedStores {
  readonly projectRevision: number
  readonly globalRevision: number
  readonly records: readonly StoredRecord[]
  readonly protectedAgents: readonly string[]
}

function disabledMessage(directory: string): string {
  return `Project mode is not enabled for ${directory}`
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message
  return String(error)
}

// Write one team record through the same save() path instructions.mutate
// uses, with the caller's expected revisions. Only the matching (level,
// team) record is replaced; every other record passes through unchanged, so
// customization and split records are never clobbered and an unchanged toggle
// stays a no-op. A stale save retries once against a fresh read — the toggle
// intent is an absolute value, so re-applying it onto fresh records is safe —
// and a second stale result reports failure to the caller.
async function saveTeamRecord(
  directory: string,
  loaded: LoadedStores,
  level: TeamRecord["level"],
  team: string,
  enabled: boolean,
): Promise<{ ok: true; changed: boolean; revision: number } | { ok: false }> {
  const attempt = (records: readonly StoredRecord[]) => {
    const existing = records.find(
      (record): record is TeamRecord => record.type === "team" && record.level === level && record.team === team,
    )
    if (existing !== undefined && existing.enabled === enabled) return undefined
    const next: TeamRecord = { type: "team", level, team, enabled, updated: new Date().toISOString() }
    return [
      ...records.filter((record) => !(record.type === "team" && record.level === level && record.team === team)),
      next,
    ] as readonly StoredRecord[]
  }
  const revisionOf = (projectRevision: number, globalRevision: number) =>
    level === "project" ? projectRevision : globalRevision
  const changedOf = (changed: { readonly project: boolean; readonly global: boolean }) =>
    level === "project" ? changed.project : changed.global
  const first = attempt(loaded.records)
  if (first === undefined) return { ok: true, changed: false, revision: revisionOf(loaded.projectRevision, loaded.globalRevision) }
  const saved = await save(directory, {
    expectedProjectRevision: loaded.projectRevision,
    expectedGlobalRevision: loaded.globalRevision,
    records: first,
  })
  if (saved.ok) return { ok: true, changed: changedOf(saved.changed), revision: revisionOf(saved.projectRevision, saved.globalRevision) }
  const fresh = await load(directory)
  const second = attempt(fresh.records)
  if (second === undefined) return { ok: true, changed: false, revision: revisionOf(fresh.projectRevision, fresh.globalRevision) }
  const retried = await save(directory, {
    expectedProjectRevision: fresh.projectRevision,
    expectedGlobalRevision: fresh.globalRevision,
    records: second,
  })
  if (retried.ok)
    return { ok: true, changed: changedOf(retried.changed), revision: revisionOf(retried.projectRevision, retried.globalRevision) }
  return { ok: false }
}

function isTeamRecord(record: StoredRecord): record is TeamRecord {
  return record.type === "team"
}

function modelsOf(records: readonly StoredRecord[]): ModelRecord[] {
  return records.filter((record): record is ModelRecord => record.type === "model")
}

function rulesOf(records: readonly StoredRecord[]): RuleRecord[] {
  return records.filter((record): record is RuleRecord => record.type === "rule")
}

function modelRecordTarget(record: ModelRecord): string {
  return `model:${record.level}:${record.agent ?? ""}:${record.providerID}/${record.modelID}${record.variant === undefined ? "" : `@${record.variant}`}`
}

function ruleRecordTarget(record: RuleRecord): string {
  return `rule:${record.level}:${record.agent ?? ""}:${record.tool}:${record.id}`
}

function validateRuleRef(
  tool: string,
  id: string,
  label: string,
  patterns: readonly string[],
  keywords?: readonly string[],
): { ok: true; tool: string; id: string; label: string; patterns: string[]; keywords: string[] } | { ok: false; reason: string } {
  return validateRuleInput({ tool, id, label, patterns, ...(keywords === undefined ? {} : { keywords }) })
}

function validateRuleIdentity(
  tool: string,
  id: string,
): { ok: true; tool: string; id: string } | { ok: false; reason: string } {
  const trimmedTool = tool.trim()
  const trimmedId = id.trim()
  if (trimmedTool.length === 0) return { ok: false, reason: "Rule tool cannot be empty" }
  if (trimmedTool.includes(":") || trimmedTool.includes("/") || trimmedTool.includes(" ") || trimmedTool.includes("*") || trimmedTool.includes("?"))
    return { ok: false, reason: `Invalid rule tool "${tool}"` }
  if (trimmedId.length === 0) return { ok: false, reason: "Rule id cannot be empty" }
  if (trimmedId.includes("\n") || trimmedId.includes("\0")) return { ok: false, reason: `Invalid rule id "${id}"` }
  return { ok: true, tool: trimmedTool, id: trimmedId }
}

// Shared protected-agent guard for rule writes: protection follows the matched
// record's owner, not the caller's row address, so a protected agent's custom
// rule cannot be deleted or updated through another agent's globally displayed
// row. Both removeRule and updateRule call this at the same PlusApi boundary
// so the tools API, the RPC, and the TUI all inherit it.
function ruleProtectedRefusal(protectedAgents: readonly string[], existing: RuleRecord | undefined): string | undefined {
  if (existing === undefined) return undefined
  if (existing.agent !== null && protectedAgents.includes(existing.agent))
    return `agent.protected: row belongs to protected agent "${existing.agent}"`
  return undefined
}

function validateModelRef(
  providerID: string,
  modelID: string,
  variant?: string,
): { ok: true; providerID: string; modelID: string; variant?: string } | { ok: false; reason: string } {
  const provider = providerID.trim()
  const model = modelID.trim()
  const trimmedVariant = variant === undefined ? undefined : variant.trim()
  if (provider.length === 0) return { ok: false, reason: "Model providerID cannot be empty" }
  if (model.length === 0) return { ok: false, reason: "Model modelID cannot be empty" }
  if (provider.includes("/") || provider.includes("@") || provider.includes(":")) return { ok: false, reason: `Invalid providerID "${providerID}"` }
  if (model.includes("@")) return { ok: false, reason: `Invalid modelID "${modelID}"` }
  if (trimmedVariant !== undefined && trimmedVariant.length === 0) return { ok: false, reason: "Model variant cannot be empty" }
  if (trimmedVariant === undefined) return { ok: true, providerID: provider, modelID: model }
  return { ok: true, providerID: provider, modelID: model, variant: trimmedVariant }
}

function catalogHas(
  models: readonly Model.Info[],
  providerID: string,
  modelID: string,
  variant?: string,
): boolean {
  const found = models.find((entry) => String(entry.providerID) === providerID && String(entry.id) === modelID)
  if (found === undefined) return false
  if (variant === undefined) return true
  return (found.variants ?? []).some((entry) => String(entry.id) === variant)
}

async function saveModelRecords(
  directory: string,
  loaded: LoadedStores,
  next: readonly StoredRecord[],
): Promise<{ ok: true; changed: boolean; revision: number } | { ok: false }> {
  const level = nextLevelOf(next, loaded.records)
  const revisionOf = (projectRevision: number, globalRevision: number) =>
    level === "project" ? projectRevision : globalRevision
  const changedOf = (changed: { readonly project: boolean; readonly global: boolean }) =>
    level === "project" ? changed.project : changed.global
  const saved = await save(directory, {
    expectedProjectRevision: loaded.projectRevision,
    expectedGlobalRevision: loaded.globalRevision,
    records: next,
  })
  if (saved.ok) return { ok: true, changed: changedOf(saved.changed), revision: revisionOf(saved.projectRevision, saved.globalRevision) }
  const fresh = await load(directory)
  const retried = await save(directory, {
    expectedProjectRevision: fresh.projectRevision,
    expectedGlobalRevision: fresh.globalRevision,
    records: mergeModelInto(fresh.records, next, loaded.records),
  })
  if (retried.ok)
    return { ok: true, changed: changedOf(retried.changed), revision: revisionOf(retried.projectRevision, retried.globalRevision) }
  return { ok: false }
}

function nextLevelOf(next: readonly StoredRecord[], previous: readonly StoredRecord[]): Level {
  const delta = deltaRows(previous, next)
  const first = delta.find((record) => record.type === "model")
  if (first !== undefined && first.level === "project") return "project"
  if (first !== undefined) return "global"
  return "global"
}

function mergeModelInto(
  fresh: readonly StoredRecord[],
  next: readonly StoredRecord[],
  previous: readonly StoredRecord[],
): readonly StoredRecord[] {
  const previousModels = new Set(modelsOf(previous).map((record) => modelRecordTarget(record)))
  const nextModels = new Map(modelsOf(next).map((record) => [modelRecordTarget(record), record] as const))
  const removed = [...previousModels].filter((target) => !nextModels.has(target))
  const kept = fresh.filter((record) => {
    if (record.type !== "model") return true
    return !removed.includes(modelRecordTarget(record))
  })
  const freshTargets = new Set(modelsOf(kept).map((record) => modelRecordTarget(record)))
  const added = [...nextModels.values()].filter((record) => !freshTargets.has(modelRecordTarget(record)))
  return [...kept, ...added]
}

async function saveRuleRecords(
  directory: string,
  loaded: LoadedStores,
  next: readonly StoredRecord[],
): Promise<{ ok: true; changed: boolean; revision: number } | { ok: false }> {
  const level = nextRuleLevelOf(next, loaded.records)
  const revisionOf = (projectRevision: number, globalRevision: number) =>
    level === "project" ? projectRevision : globalRevision
  const changedOf = (changed: { readonly project: boolean; readonly global: boolean }) =>
    level === "project" ? changed.project : changed.global
  const saved = await save(directory, {
    expectedProjectRevision: loaded.projectRevision,
    expectedGlobalRevision: loaded.globalRevision,
    records: next,
  })
  if (saved.ok) return { ok: true, changed: changedOf(saved.changed), revision: revisionOf(saved.projectRevision, saved.globalRevision) }
  const fresh = await load(directory)
  const merged = mergeRuleInto(fresh.records, next, loaded.records)
  if (merged === undefined) return { ok: false }
  const retried = await save(directory, {
    expectedProjectRevision: fresh.projectRevision,
    expectedGlobalRevision: fresh.globalRevision,
    records: merged,
  })
  if (retried.ok)
    return { ok: true, changed: changedOf(retried.changed), revision: revisionOf(retried.projectRevision, retried.globalRevision) }
  return { ok: false }
}

function nextRuleLevelOf(next: readonly StoredRecord[], previous: readonly StoredRecord[]): Level {
  const delta = deltaRows(previous, next)
  const first = delta.find((record) => record.type === "rule")
  if (first !== undefined && first.level === "project") return "project"
  if (first !== undefined) return "global"
  return "global"
}

function mergeRuleInto(
  fresh: readonly StoredRecord[],
  next: readonly StoredRecord[],
  previous: readonly StoredRecord[],
): readonly StoredRecord[] | undefined {
  const previousByTarget = new Map(rulesOf(previous).map((record) => [ruleRecordTarget(record), record] as const))
  const nextRules = new Map(rulesOf(next).map((record) => [ruleRecordTarget(record), record] as const))
  // The actual delta this call intends, relative to the state it loaded:
  // additions are next targets absent from previous (not next absent from
  // fresh, which resurrects unrelated concurrent deletions), removals are
  // previous targets absent from next, and edits are same-target content
  // changes. Re-apply only that delta onto fresh; every other fresh row
  // (including concurrent edits elsewhere) passes through untouched. A target
  // the caller intended to create that someone else created first is a
  // conflict when the contents differ (return undefined so the caller reports
  // a concurrent-change error instead of success for values that were not
  // persisted); identical contents are idempotent and succeed.
  const addedTargets = new Set([...nextRules.keys()].filter((target) => !previousByTarget.has(target)))
  const removedTargets = new Set([...previousByTarget.keys()].filter((target) => !nextRules.has(target)))
  const updatedTargets = new Set(
    [...nextRules.entries()]
      .filter(([target, intended]) => {
        const before = previousByTarget.get(target)
        if (before === undefined) return false
        return JSON.stringify(stable(before)) !== JSON.stringify(stable(intended))
      })
      .map(([target]) => target),
  )
  const kept = fresh.filter((record) => {
    if (record.type !== "rule") return true
    return !removedTargets.has(ruleRecordTarget(record))
  })
  // Concurrent creation of the same target this call intended to add: when
  // fresh already carries it with different contents, report a conflict so
  // the caller never reports success for values that were not persisted.
  // Identical contents are idempotent and succeed.
  const freshByTarget = new Map(rulesOf(kept).map((record) => [ruleRecordTarget(record), record] as const))
  for (const target of addedTargets) {
    const intended = nextRules.get(target)
    const concurrent = freshByTarget.get(target)
    if (intended === undefined || concurrent === undefined) continue
    if (JSON.stringify(stable(concurrent)) !== JSON.stringify(stable(intended))) return undefined
  }
  // Concurrent creation under a different level/agent still collides on the
  // rule identity (tool + id), which addRule enforces across all levels.
  const freshByRule = new Map(rulesOf(kept).map((record) => [`${record.tool}:${record.id}`, record] as const))
  for (const target of addedTargets) {
    const intended = nextRules.get(target)
    if (intended === undefined) continue
    const concurrent = freshByRule.get(`${intended.tool}:${intended.id}`)
    if (concurrent === undefined) continue
    if (ruleRecordTarget(concurrent) !== target) return undefined
  }
  const mergedKept = kept.map((record) => {
    if (record.type !== "rule") return record
    const target = ruleRecordTarget(record)
    const intended = nextRules.get(target)
    if (intended === undefined) return record
    if (updatedTargets.has(target)) return intended
    return record
  })
  const keptTargets = new Set(rulesOf(mergedKept).map((record) => ruleRecordTarget(record)))
  const missing = [...addedTargets, ...updatedTargets].filter((target) => !keptTargets.has(target))
  const appended = missing.flatMap((target) => {
    const intended = nextRules.get(target)
    if (intended === undefined) return []
    return [intended]
  })
  return [...mergedKept, ...appended]
}

// A missing actor means the TUI; strip explicit undefined keys so the stored
// line (and any RPC envelope) never carries a present-but-undefined value.
function normalizeActor(actor: Plus.Actor | undefined): Plus.Actor {
  if (actor === undefined) return { type: "tui" }
  return {
    type: actor.type,
    ...(actor.agent === undefined ? {} : { agent: actor.agent }),
    ...(actor.sessionID === undefined ? {} : { sessionID: actor.sessionID }),
    ...(actor.messageID === undefined ? {} : { messageID: actor.messageID }),
  }
}

// Tree row id for a stored record: customizations and splits address
// item:<level>:<agent|''>:<itemId> (sectioned rows add their section),
// teams address team:<level>:<name>.
function recordTarget(record: StoredRecord): string {
  if (record.type === "team") return `team:${record.level}:${record.team}`
  if (record.type === "model")
    return `model:${record.level}:${record.agent ?? ""}:${record.providerID}/${record.modelID}${record.variant === undefined ? "" : `@${record.variant}`}`
  if (record.type === "rule") return `rule:${record.level}:${record.agent ?? ""}:${record.tool}:${record.id}`
  const agent = record.agent ?? ""
  if (record.type === "split") return `item:${record.level}:${agent}:${record.item}`
  if (record.section !== null) return `section:${record.level}:${agent}:${record.item}:${record.section}`
  return `item:${record.level}:${agent}:${record.item}`
}

function mutateTarget(rows: readonly StoredRecord[]): string {
  const first = rows[0]
  if (first === undefined) return "records"
  return recordTarget(first)
}

// Multiset difference keyed by row identity (type plus level/agent/item/
// section, or level/team): a row counts as changed when it was added,
// removed, or its stored content differs, and a modified row is named once
// (the after version). Content compares on the store's canonical serialized
// form. Team rows merged back verbatim cancel out, so a pure mutate never
// names them.
function deltaRows(before: readonly StoredRecord[], after: readonly StoredRecord[]): StoredRecord[] {
  const beforeGroups = groupByIdentity(before)
  const afterGroups = groupByIdentity(after)
  const changed: StoredRecord[] = []
  for (const key of new Set([...beforeGroups.keys(), ...afterGroups.keys()])) {
    const olds = sortByContent(beforeGroups.get(key) ?? [])
    const news = sortByContent(afterGroups.get(key) ?? [])
    const paired = Math.min(olds.length, news.length)
    for (let index = 0; index < paired; index++) {
      const oldRow = olds[index]
      const newRow = news[index]
      if (oldRow === undefined || newRow === undefined) continue
      if (contentOf(oldRow) !== contentOf(newRow)) changed.push(newRow)
    }
    for (let index = paired; index < olds.length; index++) {
      const removed = olds[index]
      if (removed !== undefined) changed.push(removed)
    }
    for (let index = paired; index < news.length; index++) {
      const added = news[index]
      if (added !== undefined) changed.push(added)
    }
  }
  return changed
}

function groupByIdentity(records: readonly StoredRecord[]): Map<string, StoredRecord[]> {
  const groups = new Map<string, StoredRecord[]>()
  for (const record of records) {
    // NUL separates the type from the row id, written as an escape so the
    // source stays plain text. It keeps a customization and a split over the
    // same coordinates distinct, and the id validators reject NUL bytes, so
    // it cannot collide with row-id content.
    const key = `${record.type}\\u0000${recordTarget(record)}`
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [record])
    else group.push(record)
  }
  return groups
}

function contentOf(record: StoredRecord): string {
  return JSON.stringify(stable(record))
}

function sortByContent(records: readonly StoredRecord[]): StoredRecord[] {
  return [...records].sort((left, right) => {
    const leftKey = contentOf(left)
    const rightKey = contentOf(right)
    if (leftKey === rightKey) return 0
    return leftKey < rightKey ? -1 : 1
  })
}

function mutateSummary(changed: readonly StoredRecord[], level: string): string {
  const first = changed[0]
  // A reported-changed store with an empty delta is the v1→v2 migration
  // rewrite: same logical rows, new serialization, both files rewritten.
  if (first === undefined) return `mutate (${level}, migrated records)`
  if (changed.length === 1) return `mutate ${recordTarget(first)}`
  return `mutate ${changed.length} rows (${level}): ${changed.map(recordTarget).join(", ")}`
}

// One log line per store actually changed, naming only the rows that changed
// in that store; a no-op or stale save logs nothing. The revision is the
// store's revision after the write — logging never bumps a revision, never
// enters the records file, and never feeds the publish fingerprint.
async function logMutate(input: {
  directory: string
  actor: Plus.Actor
  before: readonly StoredRecord[]
  after: readonly StoredRecord[]
  projectRevision: number
  globalRevision: number
  projectChanged: boolean
  globalChanged: boolean
}): Promise<void> {
  const ts = new Date().toISOString()
  const delta = deltaRows(input.before, input.after)
  if (input.projectChanged) {
    const rows = canonical(delta.filter((record) => record.level === "project"))
    await append(projectLogPath(input.directory), {
      ts,
      actor: { ...input.actor },
      op: "mutate",
      target: mutateTarget(rows),
      summary: mutateSummary(rows, "project"),
      revision: input.projectRevision,
    })
  }
  if (input.globalChanged) {
    const rows = canonical(delta.filter((record) => record.level !== "project"))
    await append(globalLogPath(), {
      ts,
      actor: { ...input.actor },
      op: "mutate",
      target: mutateTarget(rows),
      summary: mutateSummary(rows, "global"),
      revision: input.globalRevision,
    })
  }
}

// File operations and team toggles log to the store that owns the file:
// agent.* follows the caller's scope; skills and instructions are
// project-rooted by their directory helpers; base templates live under the
// global config dir (userBaseDir); MCP servers live in the project's own
// .opencode config. Only successful operations log; the revision is the
// owning store's current revision, which the file write never moves.
async function logFileOp(input: {
  directory: string
  actor: Plus.Actor
  scope: "project" | "global"
  op: string
  target: string
  summary: string
}): Promise<void> {
  const stored = await load(input.directory)
  await append(input.scope === "project" ? projectLogPath(input.directory) : globalLogPath(), {
    ts: new Date().toISOString(),
    actor: { ...input.actor },
    op: input.op,
    target: input.target,
    summary: input.summary,
    revision: input.scope === "project" ? stored.projectRevision : stored.globalRevision,
  })
}

// The config file addMcp/removeMcp actually edited: the first existing
// project candidate (opencode.json preferred), else a new opencode.json.
async function mcpConfigTarget(projectDirectory: string): Promise<string> {
  const candidates = await projectConfigCandidates(projectDirectory)
  const first = candidates[0]
  if (first !== undefined) return first
  return path.join(projectDirectory, ".opencode", "opencode.json")
}

function customizationsOf(records: readonly StoredRecord[]): CustomizationRecord[] {
  return records.filter((record): record is CustomizationRecord => record.type === "customization")
}

function splitsOf(records: readonly StoredRecord[]): SplitRecord[] {
  return records.filter((record): record is SplitRecord => record.type === "split")
}

function toRecord(record: Plus.SnapshotRecord): StoredRecord {
  if (record.type === "split")
    return {
      type: "split",
      level: record.level,
      agent: record.agent,
      item: record.item,
      boundaries: record.boundaries.map((boundary) => ({ ...boundary })),
      updated: record.updated,
    }
  if (record.type === "model")
    return {
      type: "model",
      level: record.level,
      agent: record.agent,
      providerID: record.providerID,
      modelID: record.modelID,
      ...(record.variant === undefined ? {} : { variant: record.variant }),
      ...(record.active === undefined ? {} : { active: record.active }),
      updated: record.updated,
    }
  if (record.type === "rule")
    return {
      type: "rule",
      level: record.level,
      agent: record.agent,
      tool: record.tool,
      id: record.id,
      label: record.label,
      patterns: [...record.patterns],
      keywords: [...record.keywords],
      updated: record.updated,
    }
  return {
    type: "customization",
    level: record.level,
    agent: record.agent,
    item: record.item,
    section: record.section,
    ...(record.text === undefined ? {} : { text: record.text }),
    ...(record.state === undefined ? {} : { state: record.state }),
    ...(record.pin === undefined ? {} : { pin: record.pin }),
    basedOn: record.basedOn,
    ...(record.basedOnText === undefined ? {} : { basedOnText: record.basedOnText }),
    ...(record.acknowledged === undefined ? {} : { acknowledged: record.acknowledged }),
    updated: record.updated,
  }
}

// The plugin Context prompt domain exposes the host's base prompt
// templates (`ctx.prompt.templates()` / `ctx.prompt.active(model)`); the
// local table below is only the template fallback when the host reports
// none. Classification always comes from the host: the agent's catalog
// model resolves through `resolveCatalogModel`, then `ctx.prompt.active`
// answers. User templates created via `base.create` are layered on top so
// discover lists them alongside the built-ins in BOTH paths, not only the
// zero-template fallback. User data wins over upstream the way the rest of
// Plus layers it (custom records override discovered text, project shadows
// global shadows defaults): on an id collision the user entry wins and the
// host entry is dropped. Builtin ids are reserved at creation (base.create
// refuses them as base.invalid), so new collisions cannot form; a legacy
// builtin-id shadow file still on disk keeps shadowing until deleted through
// base.delete, which restores the host template. Application is still gated
// by the host: only the template `ctx.prompt.active` answers for the agent's
// model is applied, so a non-builtin user id the host never reports as active
// stays listable and editable but is never applied — which is why the tree
// marks exactly those rows `inactive`. Host templates pass through verbatim:
// the bundled
// text is raw, and core's optimize plugins render it
// into `system[0]` before Plus's later (`post`) hook overwrites it with
// stored custom text.
async function resolveBaseTemplates(ctx: Context): Promise<{ templates: BaseTemplate[]; active: (agent: Agent.Info) => string | undefined }> {
  const templates = await Effect.runPromise(ctx.prompt.templates())
  const user = readUserBaseTemplates().map((template) => ({ ...template, user: true as const }))
  const userIds = new Set(user.map((template) => template.id))
  const listed =
    templates.length === 0
      ? [...fallbackBaseTemplates().filter((template) => !userIds.has(template.id)), ...user]
      : [...templates.filter((template) => !userIds.has(template.id)).map((template) => ({ ...template })), ...user]
  const catalog = await Effect.runPromise(
    ctx.catalog.model.list().pipe(Effect.catchCause(() => Effect.succeed({ data: [] as readonly Model.Info[] }))),
  )
  const fallback = await Effect.runPromise(
    ctx.catalog.model
      .default()
      .pipe(Effect.catchCause(() => Effect.succeed({ data: undefined as Model.Info | undefined }))),
  )
  const active = (agent: Agent.Info): string | undefined => {
    const model = resolveCatalogModel(agent, catalog.data, fallback.data)
    return Effect.runSync(ctx.prompt.active(model))
  }
  return { templates: listed, active }
}

// Resolve an agent's configured model the way the core optimize plugin does
// (core/src/plugin/optimize.ts lines 59-62): look the agent's model ref up in
// the catalog list, defaulting to a bare ref (name = id, like
// `Model.Info.default`) when the catalog has no entry. The result matches the
// host's `active` input shape `{ id, name }`.
function resolveCatalogModel(
  agent: Agent.Info,
  models: readonly Model.Info[],
  fallback?: Model.Info | undefined,
): { id: string; name: string } {
  const ref = agent.model ?? fallback
  if (ref === undefined) return { id: "", name: "" }
  const found = models.find((model) => model.providerID === ref.providerID && model.id === ref.id)
  if (found !== undefined) return { id: found.id, name: found.name }
  return { id: ref.id, name: ref.id }
}

const FALLBACK_BASE_IDS = ["gpt", "claude", "muse", "gemini", "general", "kimi", "trinity"] as const

function fallbackBaseTemplates(): BaseTemplate[] {
  return FALLBACK_BASE_IDS.map((id) => ({ id, title: `${id}.txt`, text: `${id} base prompt` }))
}

function readUserBaseTemplates(): BaseTemplate[] {
  return readUserBaseTemplatesSync()
}

function readUserBaseTemplatesSync(): BaseTemplate[] {
  // Synchronous read: discover runs inside publishFresh where every caller
  // already awaits, and the directory is tiny. A missing dir means none.
  const dir = userBaseDir()
  let entries: string[]
  try {
    entries = fsSync.readdirSync(dir)
  } catch {
    return []
  }
  return entries
    .filter((entry) => entry.endsWith(".txt"))
    .toSorted()
    .map((entry) => {
      const id = entry.slice(0, -".txt".length)
      const text = readUserBaseTextSync(path.join(dir, entry))
      if (text === undefined) return undefined
      const title = readUserBaseTitleSync(path.join(dir, "index.json"), id)
      return { id, title, text }
    })
    .filter((template): template is BaseTemplate => template !== undefined)
}

async function discoverAll(
  ctx: Context,
  loaded: LoadedStores,
  baselines: ReadonlyMap<string, PromptBaseline>,
  modelBaselines?: ReadonlyMap<string, ModelBaseline>,
): Promise<Discovered> {
  const resolved = await resolveBaseTemplates(ctx)
  return discover({
    ctx,
    records: customizationsOf(loaded.records),
    baselines,
    baseTemplates: resolved.templates,
    activeBase: (agent) => resolved.active(agent),
    modelRecords: modelsOf(loaded.records),
    ruleRecords: rulesOf(loaded.records),
    ...(modelBaselines === undefined ? {} : { modelBaselines }),
  })
}

function scopeLevel(scope: "project" | "global" | "defaults"): Level {
  if (scope === "global") return "global"
  if (scope === "defaults") return "defaults"
  return "project"
}

// Per-agent active-model cache: the answer to "what model should this agent
// use?" computed where the work already happens (publishFresh holds the
// discovered agents, scopes, and stored records). Only non-upstream winners
// are cached; a missing entry means no switch, preserving the upstream guard.
export function buildActiveModels(
  agents: readonly AgentSource[],
  models: readonly ModelRecord[],
  scopes: Scopes,
): Map<string, ModelRefLike> {
  const next = new Map<string, ModelRefLike>()
  for (const agent of dedupeAgents(agents)) {
    const winner = resolveActiveModel({ models, scopes, level: scopeLevel(agent.scope), agent: agent.id })
    if (winner === undefined) continue
    if (winner.source === "upstream") continue
    next.set(agent.id, {
      providerID: winner.providerID,
      modelID: winner.modelID,
      ...(winner.variant === undefined ? {} : { variant: winner.variant }),
    })
  }
  return next
}

async function readTemplate(
  ctx: Context,
  directory: string,
  template: string,
): Promise<{ fields?: AgentFields; prompt: string; model?: string } | undefined> {
  const validated = validateAgentId(template)
  if (!validated.ok) return undefined
  const candidates = [
    path.join(directory, ".opencode", "agent", `${validated.id}.md`),
    path.join(directory, ".opencode", "agents", `${validated.id}.md`),
    path.join(globalConfigDir(), "agent", `${validated.id}.md`),
    path.join(globalConfigDir(), "agents", `${validated.id}.md`),
  ]
  for (const candidate of candidates) {
    const file = Bun.file(candidate)
    if (!(await file.exists())) continue
    const text = await file.text()
    return { fields: templateFields(text), prompt: agentBody(text) }
  }
  return readDefaultsTemplate(ctx, validated.id)
}

// Defaults-tree agents are built-ins with no backing file, so seeding from
// one reads the discovered host view: prompt from the live system text and
// frontmatter fields from the same data discover reports for that agent.
// Records are never copied; the new agent inherits through the chain.
async function readDefaultsTemplate(
  ctx: Context,
  id: string,
): Promise<{ fields?: AgentFields; prompt: string; model?: string } | undefined> {
  const listed = await Effect.runPromise(ctx.agent.list())
  const current = listed.data.find((entry) => String(entry.id) === id) as Agent.Info | undefined
  if (current === undefined) return undefined
  const fields: AgentFields = {
    ...(current.model === undefined ? {} : { model: formatModel(current.model) }),
    ...(current.description === undefined ? {} : { description: current.description }),
    ...(current.mode === undefined ? {} : { mode: current.mode }),
  }
  return {
    ...(Object.keys(fields).length === 0 ? {} : { fields }),
    prompt: current.system ?? "",
  }
}

function formatModel(model: { readonly providerID: string; readonly id: string; readonly variant?: string }): string {
  if (model.variant === undefined) return `${model.providerID}/${model.id}`
  return `${model.providerID}/${model.id}#${model.variant}`
}

function templateFields(markdown: string): AgentFields | undefined {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match) return undefined
  try {
    const data = Bun.YAML.parse(match[1] ?? "")
    if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined
    const fields = data as Record<string, unknown>
    const picked: AgentFields = {
      ...(typeof fields.model === "string" ? { model: fields.model } : {}),
      ...(typeof fields.description === "string" ? { description: fields.description } : {}),
      ...(fields.mode === "subagent" || fields.mode === "primary" || fields.mode === "all" ? { mode: fields.mode } : {}),
    }
    if (Object.keys(picked).length === 0) return undefined
    return picked
  } catch {
    return undefined
  }
}

interface BaseTemplateSuccess {
  readonly ok: true
  readonly id: string
}

interface BaseTemplateExists {
  readonly ok: false
  readonly reason: "exists"
  readonly id: string
}

interface BaseTemplateInvalid {
  readonly ok: false
  readonly reason: "invalid"
  readonly id: string
  readonly message: string
}

type BaseTemplateResult = BaseTemplateSuccess | BaseTemplateExists | BaseTemplateInvalid

// Instruction create result types stay local to index.ts; deletion reuses the
// path-confined helpers from instructions/paths.ts.
interface CreateInstructionSuccess {
  readonly ok: true
  readonly id: string
  readonly path: string
}

interface CreateInstructionExists {
  readonly ok: false
  readonly reason: "exists"
  readonly id: string
  readonly path: string
}

interface CreateInstructionInvalid {
  readonly ok: false
  readonly reason: "invalid"
  readonly id: string
  readonly path: string
  readonly message: string
}

type CreateInstructionResult = CreateInstructionSuccess | CreateInstructionExists | CreateInstructionInvalid

async function createInstruction(input: {
  sessionDirectory: string
  projectDirectory: string
  name: string
  text: string
}): Promise<CreateInstructionResult> {
  const name = input.name.trim()
  if (name.length === 0) return { ok: false, reason: "invalid", id: input.name, path: "", message: "Instruction name cannot be empty" }
  if (name.includes("\0") || name.includes(".."))
    return { ok: false, reason: "invalid", id: input.name, path: "", message: `Invalid instruction name "${input.name}"` }
  const relative = name.endsWith(".md") ? name : `${name}.md`
  const session = path.resolve(input.sessionDirectory)
  const root = path.resolve(input.projectDirectory)
  const target = path.resolve(session, relative)
  if (target === root || !target.startsWith(`${root}${path.sep}`))
    return { ok: false, reason: "invalid", id: input.name, path: "", message: `Invalid instruction name "${input.name}"` }
  // Validate the resolved file against discovery's own candidate list: core
  // only ever delivers the global config AGENTS.md plus AGENTS.md files
  // walking from the session directory up to the stop directory, so any other
  // name would report success yet never be observed. instructionCandidates is
  // the single source of truth — do not duplicate the AGENTS.md rule here.
  const observable = new Set(instructionCandidates(session, root).map((candidate) => path.resolve(candidate)))
  if (!observable.has(target))
    return {
      ok: false,
      reason: "invalid",
      id: input.name,
      path: "",
      message: `Only AGENTS.md files on the session ancestor path are discovered; "${input.name}" would never be delivered. Accepted names: AGENTS.md`,
    }
  if (await Bun.file(target).exists()) return { ok: false, reason: "exists", id: relative, path: target }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, input.text.endsWith("\n") ? input.text : `${input.text}\n`)
  return { ok: true, id: `system:${path.relative(root, target)}`, path: target }
}

interface InstructionMissing {
  readonly ok: false
  readonly reason: "missing"
  readonly id: string
  readonly path: string
  readonly name: string
}

interface InstructionDeleteInvalid {
  readonly ok: false
  readonly reason: "invalid"
  readonly id: string
  readonly path: string
  readonly message: string
}

type InstructionDeleteResult = CreateInstructionSuccess | InstructionMissing | InstructionDeleteInvalid

async function deleteInstruction(input: { projectDirectory: string; name: string }): Promise<InstructionDeleteResult> {
  const resolved = resolveInstructionPath(input.projectDirectory, input.name)
  if (!resolved.ok) return { ok: false, reason: "invalid", id: input.name, path: "", message: resolved.message }
  if (!(await Bun.file(resolved.path).exists()))
    return { ok: false, reason: "missing", id: `system:${resolved.relative}`, path: resolved.path, name: input.name }
  await fs.rm(resolved.path, { force: true })
  return { ok: true, id: `system:${resolved.relative}`, path: resolved.path }
}

function activate(ctx: Context, state: PlusState): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    const config = yield* Effect.promise(() => read(ctx.location.directory))
    if (config === undefined) return
    yield* ensureTooling(ctx, state)
    const stored = yield* Effect.promise(() => loadCurrent(ctx.location.directory))
    yield* publishFresh(ctx, state, stored)
  })
}

// Tooling (teaching instruction/skill plus the instructions tool namespace)
// lives outside state.applied so ordinary publishes never replace it, and
// activate is re-entry safe: a second call while tooling is installed is a
// no-op instead of a duplicate registration.
function ensureTooling(ctx: Context, state: PlusState): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    if (state.tooling.length > 0) return
    const installed = yield* Effect.promise(() => installTooling(ctx, state)).pipe(
      Effect.catchCause((cause) => Effect.logWarning("plus tooling install failed", { cause }).pipe(Effect.as([] as Registration[]))),
    )
    state.tooling = [...state.tooling, ...installed]
  })
}

async function installTooling(ctx: Context, state: PlusState): Promise<Registration[]> {
  const api = createPlusApi(ctx, state)
  const teaching = await installTeaching(ctx)
  const tools = await registerInstructionTools(ctx, api)
  return [...teaching, tools]
}

function disposeTooling(state: PlusState): Effect.Effect<void> {
  return Effect.gen(function* () {
    const registrations = state.tooling
    state.tooling = []
    yield* Effect.forEach(registrations, (registration) => registration.dispose, { discard: true })
  })
}

function ensureTeamTooling(ctx: Context, state: PlusState): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    if (state.teamTooling.length > 0) return
    const installed = yield* Effect.promise(() => installTeamTooling(ctx, state)).pipe(
      Effect.catchCause((cause) => Effect.logWarning("plus team tooling install failed", { cause }).pipe(Effect.as([] as Registration[]))),
    )
    state.teamTooling = [...state.teamTooling, ...installed]
  })
}

async function installTeamTooling(ctx: Context, state: PlusState): Promise<Registration[]> {
  const api = createTeamApi(ctx, state)
  const tools = await registerTeamTools(ctx, api)
  const permissions = await registerTeamPermissions(ctx)
  return [tools, permissions]
}

function disposeTeamTooling(state: PlusState): Effect.Effect<void> {
  return Effect.gen(function* () {
    const registrations = state.teamTooling
    state.teamTooling = []
    yield* Effect.forEach(registrations, (registration) => registration.dispose, { discard: true })
  })
}

async function loadCurrent(directory: string): Promise<LoadedStores> {
  const config = await read(directory)
  const stored = await load(directory)
  return { ...stored, protectedAgents: config?.protectedAgents ?? [] }
}

export function deactivate(state: PlusState): Effect.Effect<void> {
  return state.semaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* disposeApplied(state)
      yield* disposeTooling(state)
      yield* disposeTeamTooling(state)
      state.fingerprint = undefined
      state.projectRevision = undefined
      state.globalRevision = undefined
      state.baselines = new Map()
      state.modelBaselines = new Map()
      state.activeModels = new Map()
      state.cachedAgents = []
      state.cachedScopes = { global: new Set(), defaults: new Set() }
    }),
  )
}

function refreshAfterFileChange(
  ctx: Context,
  state: PlusState,
  directory: string,
  builtins: readonly BuiltinTeam[] = builtinTeams,
  force = false,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const stored = yield* Effect.promise(() => loadCurrent(directory))
    yield* publishFresh(ctx, state, stored, builtins, force)
  })
}

// Only publishFresh and deactivate acquire the semaphore, and neither calls the
// other, so a caller never blocks on a permit it already holds.
function publishFresh(
  ctx: Context,
  state: PlusState,
  stored: LoadedStores,
  builtins: readonly BuiltinTeam[] = builtinTeams,
  force = false,
): Effect.Effect<Discovered> {
  return state.semaphore.withPermits(1)(
    Effect.gen(function* () {
      const discovered = yield* Effect.promise(() => discoverAll(ctx, stored, state.baselines, state.modelBaselines))
      // A newer publish already won; this read is stale, so leave the applied
      // registrations and the last emitted revision untouched.
      if (state.projectRevision !== undefined && stored.projectRevision < state.projectRevision) return discovered
      if (state.globalRevision !== undefined && stored.globalRevision < state.globalRevision) return discovered
      const customizations = customizationsOf(stored.records)
      const splits = splitsOf(stored.records)
      const modelRecords = modelsOf(stored.records)
      const scopes = scopesOf(discovered.agents)
      state.activeModels = buildActiveModels(discovered.agents, modelRecords, scopes)
      state.cachedAgents = discovered.agents.map((agent) => ({ ...agent }))
      state.cachedScopes = { global: new Set(scopes.global), defaults: new Set(scopes.defaults) }
      const view = yield* Effect.promise(() =>
        stablePublishView(discovered, stored.records, ctx.location.directory, builtins),
      )
      const fingerprint = JSON.stringify({
        items: view.items.filter((item) => item.kind !== "perm"),
        agents: view.agents,
        servers: discovered.servers,
        records: stored.records,
        teamBodies: view.teamBodies,
        scopes: { global: [...view.scopes.global].toSorted(), defaults: [...view.scopes.defaults].toSorted() },
      })
      if (state.projectRevision !== undefined && fingerprint === state.fingerprint) {
        if (!force) return discovered
        // Core debounces its own reload, so a just-written agent file cannot
        // move the fingerprint yet; the file mutation itself is the change.
        yield* emitChanged(state, stored.projectRevision, stored.globalRevision)
        return discovered
      }
      // Install the replacement before disposing the superseded registrations.
      // Core rebuilds and reconciles on every registration change, so disposing
      // first would expose the un-transformed upstream state between the two
      // steps: an MCP server Plus keeps disabled would genuinely start, then
      // stop again once the replacement reinstalls disabled = true. Core replays
      // transforms in registration order with last write wins; every Plus
      // transform overwrites the same key (agent.system, disabled = true, skill
      // rules with a presence check, session tools by agent), so the briefly
      // doubled callback ends with the new value.
      const applied = yield* Effect.promise(() =>
        apply(ctx, {
          items: discovered.items,
          // First entry per id wins downstream: discover returns the effective
          // agent followed by its shadowed scope identities, and apply loops
          // iterate agents in order with last write winning — applying every
          // identity would let the shadowed copy overwrite the effective one.
          // Discovery keeps the shadows for scope resolution and the UI.
          agents: dedupeAgents(discovered.agents).map((agent) => ({
            id: agent.id,
            level: scopeLevel(agent.scope),
            base: agent.base,
          })),
          records: customizations,
          splits,
          scopes: scopesOf(discovered.agents),
          models: modelRecords,
        }),
      )
      // Enabled teams become real core-visible agents: resolve the enabled
      // teams (on-disk project/global plus built-in defaults) against the
      // unmasked regular sources (Plus team output never feeds back as a
      // regular to shadow its own team; resolveTeams already favours an
      // established same-level regular, so losing team copies never reach the
      // installer) and register each winner's markdown body with the host.
      // Built-in members install from the source registry with no filesystem
      // path. Team registrations install after apply's own and dispose with
      // the same superseded set when the next publish replaces them.
      const teamAgents = view.teamAgents
      const fileAgents = teamAgents.filter((agent) => agent.path !== undefined)
      const builtinWinners = teamAgents.filter((agent) => agent.path === undefined)
      const teamApplied = yield* Effect.promise(() => installTeamAgents(ctx, fileAgents))
      const builtinApplied = yield* Effect.promise(() => installBuiltinTeamAgents(ctx, builtinWinners, builtins))
      const previous = state.applied
      state.applied = [...applied.registrations, ...teamApplied.registrations, ...builtinApplied.registrations]
      state.installedTools = applied.tools
      state.fingerprint = fingerprint
      state.projectRevision = stored.projectRevision
      state.globalRevision = stored.globalRevision
      captureBaselines(ctx, state, discovered, customizations, splits, modelRecords)
      yield* Effect.forEach(previous, (registration) => registration.dispose, { discard: true })
      yield* emitChanged(state, stored.projectRevision, stored.globalRevision)
      return discovered
    }),
  )
}

// Capture what Plus just installed: read the host back after apply and
// retain (applied, upstream) pairs wherever the host now shows Plus output.
// The next discovery unmasks those keys back to upstream via unmaskText, so
// the publish fingerprint stays stable instead of storming. Agent roles key
// by agent id (file-backed agents additionally reread their markdown body:
// `file` records that body as observed at baseline time via discovered.bodies,
// so a later file edit is trusted only while the file still owned the prompt);
// tools and skills key by item id. Models retain (applied, upstream) per
// agent the same way: once applyModels sets agent.model the host
// reports Plus's own output, so the next discovery unmasks it back. File
// agents whose frontmatter defines a model never consult the host, so their
// baseline is unused; file agents without a defining model fall through to
// the host like non-file agents and need the same baseline, so baselines are
// captured for every agent with a non-upstream winner.
export function captureBaselines(
  ctx: Context,
  state: PlusState,
  discovered: Discovered,
  records: readonly CustomizationRecord[],
  splits: readonly SplitRecord[],
  modelRecords?: readonly ModelRecord[],
): void {
  void ctx
  void splits
  const next = new Map<string, PromptBaseline>()
  const scopes = scopesOf(discovered.agents)
  for (const item of discovered.items) {
    const key = baselineKey(item)
    if (item.id === "system:role") {
      const owner = item.agents?.[0]
      if (owner === undefined) continue
      const level = scopeLevel(discovered.agents.find((agent) => agent.id === owner)?.scope ?? "defaults")
      const resolved = resolve({ upstream: item, records, splits, scopes, address: { level, agent: owner, item: item.id, section: null } })
      if (resolved.assembled === item.text) continue
      const source = discovered.agents.find((agent) => agent.id === owner)
      const fileBacked = source?.path !== undefined
      const file = fileBacked ? discovered.bodies.get(owner) : undefined
      next.set(key, {
        applied: resolved.assembled,
        upstream: item.text,
        fileBacked,
        ...(file === undefined ? {} : { file }),
      })
      continue
    }
    if (item.kind !== "tool" && item.kind !== "skill") continue
    const resolved = resolve({ upstream: item, records, splits, scopes, address: { level: "defaults", agent: null, item: item.id, section: null } })
    if (resolved.assembled === item.text) continue
    next.set(key, { applied: resolved.assembled, upstream: item.text, fileBacked: false })
  }
  state.baselines = next
  const models = modelRecords ?? []
  if (models.length === 0) {
    state.modelBaselines = new Map()
    return
  }
  const modelNext = new Map<string, ModelBaseline>()
  const effective = dedupeAgents(discovered.agents)
  for (const agent of effective) {
    const level = scopeLevel(agent.scope)
    const upstream = discovered.modelUpstream.get(agent.id)
    const winner = resolveActiveModel({ models, scopes, level, agent: agent.id })
    if (winner === undefined) continue
    if (winner.source === "upstream") continue
    if (sameModelRef(winner, upstream)) continue
    modelNext.set(agent.id, {
      applied: { providerID: winner.providerID, modelID: winner.modelID, ...(winner.variant === undefined ? {} : { variant: winner.variant }) },
      upstream,
    })
  }
  state.modelBaselines = modelNext
}

function baselineKey(item: { id: string; agents?: readonly string[] }): string {
  if (item.id === "system:role") return item.agents?.[0] ?? item.id
  return item.id
}

function disposeApplied(state: PlusState): Effect.Effect<void> {
  return Effect.gen(function* () {
    const registrations = state.applied
    state.applied = []
    state.installedTools = []
    yield* Effect.forEach(registrations, (registration) => registration.dispose, { discard: true })
  })
}

function emitChanged(state: PlusState, revision: number, globalRevision: number): Effect.Effect<void> {
  const registration = state.registration
  if (!registration) return Effect.void
  return registration.events.emit("instructions.changed", { revision, globalRevision }).pipe(Effect.orDie)
}

// The publish fingerprint covers what publish installs: the unmasked upstream
// discovery plus the customization and split records (and the scopes derived
// from the discovered agents), plus the resolved team agents. Discovery
// already unmasks Plus's own output back to upstream, so a self-triggered
// refresh keeps an identical fingerprint and stays a no-op instead of a
// dispose/reinstall loop. An enable/disable toggle changes nothing in apply's
// own inputs, so only the resolved team winners (with their markdown bodies,
// file-backed or built-in) make the toggle change the fingerprint. Perm items
// are view-time data like sections (curated ∪ mined, most-mentioned first):
// they are derived from upstream text Plus already holds, so including them
// would unmask Plus's own scrubbed output into a dispose/reinstall loop.
// Only user-toggled (CustomizationRecord off) or user-added (RuleRecord)
// rules enter the fingerprint via `records`.
//
// Team output needs the same unmask: discovery reads the host AFTER Plus's
// team transforms are installed, so a team member's own description/mode/
// permissions would otherwise report Plus output as upstream and flip the
// fingerprint every pass. Prompt/model baselines do not cover those fields,
// so the fingerprint narrows to exactly the Plus-applied team fields here:
// while a defaults host entry still shows the enabled member's body plus
// every defined field (permissions as a superset), it reports upstream
// (absent) — its agent, role, and model rows are filtered and it never feeds
// back as a regular to shadow its own team. Any divergence is a genuine
// upstream edit and flows through, so the team correctly loses to it.
interface TeamApplied {
  readonly team: string
  readonly level: TeamLevel
  readonly body: string
  readonly fields: TeamFields
}

async function enabledTeamApplied(
  directory: string,
  teamRecords: readonly TeamRecord[],
  builtins: readonly BuiltinTeam[],
): Promise<Map<string, TeamApplied>> {
  const applied = new Map<string, TeamApplied>()
  for (const team of builtins) {
    if (!isTeamEnabled(teamRecords, "defaults", team.name)) continue
    for (const member of team.members) {
      if (applied.has(member.id)) continue
      applied.set(member.id, { team: team.name, level: "defaults", body: agentBody(member.body), fields: member.fields ?? { permissions: [] } })
    }
  }
  const disk = await Promise.all([discoverTeams("project", directory), discoverTeams("global", directory)])
  for (const discovered of [...disk[0], ...disk[1]]) {
    if (!isTeamEnabled(teamRecords, discovered.level, discovered.team)) continue
    for (const member of discovered.agents) {
      if (member.path === undefined) continue
      if (applied.has(member.id)) continue
      const text = await readTeamBody(member.path)
      if (text === undefined) continue
      applied.set(member.id, { team: discovered.team, level: discovered.level, body: agentBody(text), fields: parseTeamFields(text) })
    }
  }
  return applied
}

function plusTeamOutputIds(discovered: Discovered, applied: ReadonlyMap<string, TeamApplied>): Set<string> {
  const output = new Set<string>()
  for (const [id, entry] of applied) {
    const sources = discovered.agents.filter((agent) => agent.id === id)
    if (sources.length > 0 && sources.some((agent) => agent.path !== undefined)) continue
    const unbacked = sources.filter((agent) => agent.scope === "defaults" && agent.path === undefined)
    if (unbacked.length === 0) continue
    const host = discovered.hosts.find((agent) => String(agent.id) === id)
    if (host === undefined) continue
    if (!matchesTeamApplied(host, entry.body, entry.fields)) continue
    output.add(id)
  }
  return output
}

function filteredPublishAgents(agents: readonly AgentSource[], outputIds: ReadonlySet<string>): AgentSource[] {
  return agents.filter((agent) => !(outputIds.has(agent.id) && agent.scope === "defaults" && agent.path === undefined))
}

function filteredPublishItems(items: readonly Item[], outputIds: ReadonlySet<string>): Item[] {
  return items.flatMap((item): Item[] => {
    if (item.id === "system:role") {
      const owner = item.agents?.[0]
      if (owner !== undefined && outputIds.has(owner)) return []
      return [item]
    }
    if (item.kind === "model" && item.agents !== undefined) {
      const kept = item.agents.filter((id) => !outputIds.has(id))
      if (kept.length === 0) return []
      if (kept.length !== item.agents.length) return [{ ...item, agents: kept }]
      return [item]
    }
    return [item]
  })
}

async function stablePublishView(
  discovered: Discovered,
  records: readonly StoredRecord[],
  directory: string,
  builtins: readonly BuiltinTeam[],
): Promise<{ agents: AgentSource[]; items: Item[]; scopes: Scopes; teamAgents: readonly AgentSource[]; teamBodies: { id: string; scope: AgentSource["scope"]; body: string | undefined }[]; outputIds: Set<string> }> {
  const teamRecords = records.filter(isTeamRecord)
  const applied = await enabledTeamApplied(directory, teamRecords, builtins)
  const outputIds = plusTeamOutputIds(discovered, applied)
  const agents = filteredPublishAgents(discovered.agents, outputIds)
  const items = filteredPublishItems(discovered.items, outputIds)
  const scopes = scopesOf(agents)
  const teamAgents = await resolveAllTeamAgents(directory, teamRecords, agents, builtins)
  const teamBodies = await Promise.all(
    teamAgents.map(async (agent) => ({
      id: agent.id,
      scope: agent.scope,
      body:
        agent.path !== undefined
          ? await readTeamBody(agent.path)
          : agent.team === undefined
            ? undefined
            : builtinBody(builtins, agent.team, agent.id),
    })),
  )
  return { agents, items, scopes, teamAgents, teamBodies, outputIds }
}

async function fingerprintPublish(
  discovered: Discovered,
  records: readonly StoredRecord[],
  directory: string,
  builtins: readonly BuiltinTeam[] = builtinTeams,
): Promise<string> {
  const view = await stablePublishView(discovered, records, directory, builtins)
  return JSON.stringify({
    items: view.items.filter((item) => item.kind !== "perm"),
    agents: view.agents,
    servers: discovered.servers,
    records,
    teamBodies: view.teamBodies,
    scopes: { global: [...view.scopes.global].toSorted(), defaults: [...view.scopes.defaults].toSorted() },
  })
}

async function readTeamBody(file: string): Promise<string | undefined> {
  return fs.readFile(file, "utf8").catch(() => undefined)
}

// All three tiers merged for publishing: on-disk project/global plus
// built-in defaults, resolved with the project-over-global-over-defaults
// rule. Injectable so behaviour tests supply fixture built-ins.
async function resolveAllTeamAgents(
  directory: string,
  records: readonly TeamRecord[],
  regular: readonly AgentSource[],
  builtins: readonly BuiltinTeam[] = builtinTeams,
): Promise<readonly AgentSource[]> {
  const disk = await Promise.all([discoverTeams("project", directory), discoverTeams("global", directory)])
  const builtin = discoverBuiltinTeams(builtins)
  return resolveTeams([...disk[0], ...disk[1], ...builtin], records, regular).agents
}

// Built-in winners carry no path, so they install from the source registry
// instead of the filesystem. One registration per member so a later failure
// unwinds the earlier members, mirroring installTeamAgents.
async function installBuiltinTeamAgents(
  ctx: Context,
  agents: readonly AgentSource[],
  builtins: readonly BuiltinTeam[],
): Promise<{ registrations: Registration[] }> {
  const installed: Registration[] = []
  try {
    for (const agent of agents) {
      if (agent.team === undefined) continue
      const body = builtinBody(builtins, agent.team, agent.id)
      if (body === undefined) continue
      const fields: TeamFields = builtins.find((entry) => entry.name === agent.team)?.members.find((member) => member.id === agent.id)?.fields ?? { permissions: [] }
      installed.push(await runBuiltinRegistration(ctx, agent.id, agentBody(body), fields))
    }
    if (installed.length > 0) await Effect.runPromise(ctx.agent.reload())
    return { registrations: [...installed] }
  } catch (error) {
    const reversed = installed.slice().reverse()
    for (const registration of reversed) {
      await Effect.runPromise(registration.dispose).catch(() => {})
    }
    throw error
  }
}

async function runBuiltinRegistration(ctx: Context, id: string, body: string, fields: TeamFields): Promise<Registration> {
  return Effect.runPromise(
    Effect.gen(function* () {
      const scope = yield* Scope.make()
      return yield* Effect.suspend(() =>
        ctx.agent.transform((editor: AgentEditor) => applyTeamAgent(editor, id, body, fields)),
      ).pipe(
        Effect.provideService(Scope.Scope, scope),
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause)).pipe(Effect.ignoreCause)),
      )
    }),
  )
}

// The canonical event names, not string guesses: agent and skill reloads
// publish their Updated events, and config reloads publish Updated whenever
// the merged config changes. Tool and MCP-config drift arrives through the
// same config reloads, so these three cover every host change we snapshot.
// Our own apply calls reload(), which republishes agent.updated, but the
// fingerprint above is unchanged then, so the refresh is a no-op instead of
// a loop.
const RefreshEvents: Set<string> = new Set([
  Agent.Event.Updated.type,
  Skill.Event.Updated.type,
  Config.Event.Updated.type,
])

const SessionModelEvents: Set<string> = new Set(["session.created", "session.agent.selected"])

function watchHostEvents(ctx: Context, state: PlusState): Effect.Effect<void, never, Scope.Scope> {
  const refresh = ctx.event.subscribe().pipe(
    Stream.filter((event) => RefreshEvents.has(event.type)),
    Stream.runForEach((event) =>
      refreshFromHost(ctx, state).pipe(
        Effect.catchCause((cause) => Effect.logWarning("plus refresh failed", { cause, type: event.type })),
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
    Effect.asVoid,
  )
  const sessions = ctx.event.subscribe().pipe(
    Stream.filter((event) => SessionModelEvents.has(event.type)),
    Stream.runForEach((event) =>
      applySessionModel(ctx, state, event).pipe(
        Effect.catchCause((cause) => Effect.logWarning("plus session model failed", { cause, type: event.type })),
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
    Effect.asVoid,
  )
  return Effect.gen(function* () {
    yield* refresh
    yield* sessions
  })
}

// A session created with, or switched to, an agent adopts that agent's active
// model via switchModel, and only when the session's current model differs.
// Manual mid-session picks emit session.model.selected, which we never
// subscribe to, so user choices are never overridden. The wanted model comes
// from the publishFresh cache, refreshed cheaply when the shared stores moved
// (another live Location may have published Global/Defaults changes that Bus
// never delivers here, since Bus.subscribe is Location-filtered and
// RefreshEvents covers only host agent/skill/config events). The refresh is
// two small file reads plus a cache rebuild from the last discovery's agents:
// no host lists, no discovery run here.
export function applySessionModel(
  ctx: Context,
  state: PlusState,
  event: { type: string; properties?: Record<string, unknown>; data?: unknown },
): Effect.Effect<void> {
  return Effect.gen(function* () {
    const directory = ctx.location.directory
    const config = yield* Effect.promise(() => read(directory))
    if (config === undefined) return
    yield* Effect.promise(() => refreshActiveModelsIfStale(directory, state))
    const payload = (event.properties ?? event.data ?? {}) as Record<string, unknown>
    const sessionID = payload.sessionID
    if (typeof sessionID !== "string" || sessionID.length === 0) return
    const agentID = typeof payload.agent === "string" ? payload.agent : undefined
    const targetAgent = agentID ?? (yield* Effect.promise(() => currentSessionAgent(ctx, sessionID)))
    if (targetAgent === undefined) return
    const wanted = state.activeModels.get(targetAgent)
    if (wanted === undefined) return
    const current = yield* Effect.promise(() => currentSessionModel(ctx, sessionID))
    if (current !== undefined && sameModelRef(current, wanted)) return
    yield* ctx.session.switchModel({ sessionID: Session.ID.make(sessionID), model: toHostModelRef(wanted) }).pipe(
      Effect.catchCause(() => Effect.void),
    )
  })
}

async function refreshActiveModelsIfStale(directory: string, state: PlusState): Promise<void> {
  if (state.projectRevision === undefined || state.globalRevision === undefined) return
  const stored = await load(directory).catch(() => undefined)
  if (stored === undefined) return
  if (stored.projectRevision === state.projectRevision && stored.globalRevision === state.globalRevision) return
  state.activeModels = buildActiveModels(state.cachedAgents, modelsOf(stored.records), state.cachedScopes)
  state.projectRevision = stored.projectRevision
  state.globalRevision = stored.globalRevision
}

function toHostModelRef(wanted: ModelRefLike): Model.Ref {
  return Model.Ref.make({
    providerID: Provider.ID.make(wanted.providerID),
    id: Model.ID.make(wanted.modelID),
    ...(wanted.variant === undefined ? {} : { variant: Model.VariantID.make(wanted.variant) }),
  })
}

async function currentSessionAgent(ctx: Context, sessionID: string): Promise<string | undefined> {
  const session = await Effect.runPromise(ctx.session.get({ sessionID: Session.ID.make(sessionID) })).catch(() => undefined)
  const agent = (session as { agent?: unknown } | undefined)?.agent
  if (typeof agent === "string" && agent.length > 0) return agent
  // Core accepts an omitted agent and resolves the default itself
  // (core/src/session.ts create without agent, core/src/agent.ts
  // resolve/select put the selected default first in list). Mirror that here
  // so a default-agent session still adopts the default agent's model.
  const listed = await Effect.runPromise(ctx.agent.list()).catch(() => undefined)
  const data = (listed as { data?: readonly { id?: unknown }[] } | undefined)?.data
  const first = data?.[0]?.id
  if (typeof first === "string" && first.length > 0) return first
  if (first !== undefined && first !== null) {
    const text = String(first)
    if (text.length > 0) return text
  }
  return undefined
}

async function currentSessionModel(ctx: Context, sessionID: string): Promise<ModelRefLike | undefined> {
  const session = await Effect.runPromise(ctx.session.get({ sessionID: Session.ID.make(sessionID) })).catch(() => undefined)
  const model = (session as { model?: { providerID?: unknown; id?: unknown; variant?: unknown } } | undefined)?.model
  if (model === undefined) return undefined
  const providerID = typeof model.providerID === "string" ? model.providerID : String(model.providerID ?? "")
  const modelID = typeof model.id === "string" ? model.id : String(model.id ?? "")
  if (providerID.length === 0 || modelID.length === 0) return undefined
  if (typeof model.variant === "string" && model.variant.length > 0) return { providerID, modelID, variant: model.variant }
  return { providerID, modelID }
}

function refreshFromHost(ctx: Context, state: PlusState): Effect.Effect<void> {
  return Effect.gen(function* () {
    const directory = ctx.location.directory
    const config = yield* Effect.promise(() => read(directory))
    if (config === undefined) {
      yield* deactivate(state)
      return
    }
    const stored = yield* Effect.promise(() => loadCurrent(directory))
    yield* publishFresh(ctx, state, stored)
  })
}

function toSnapshot(discovered: Discovered, loaded: LoadedStores, teams: readonly Plus.TeamEntry[]): Plus.Snapshot {
  return {
    revision: loaded.projectRevision,
    globalRevision: loaded.globalRevision,
    agents: discovered.agents.map((agent) => ({
      id: agent.id,
      scope: agent.scope,
      ...(agent.path === undefined ? {} : { path: agent.path }),
      ...(agent.base === undefined ? {} : { base: agent.base }),
      ...(agent.model === undefined
        ? {}
        : {
            model: {
              providerID: agent.model.providerID,
              modelID: agent.model.modelID,
              ...(agent.model.variant === undefined ? {} : { variant: agent.model.variant }),
            },
          }),
      fileBacked: agent.path !== undefined,
    })),
    // Perm items ship in phase 3 with their rule metadata; model rows shipped in phase 2.
    items: discovered.items.map((item): Plus.SnapshotItem => {
      return {
        id: item.id,
        kind: item.kind,
        group: item.group,
        ...(item.server === undefined ? {} : { server: item.server }),
        title: item.title,
        text: item.text,
        enabled: item.enabled,
        fingerprint: item.fingerprint,
        ...(item.agents === undefined ? {} : { agents: [...item.agents] }),
        ...(item.order === undefined ? {} : { order: item.order }),
        ...(item.userBase === undefined ? {} : { userBase: item.userBase }),
        ...(item.codemode === undefined ? {} : { codemode: item.codemode }),
        ...(item.namespace === undefined ? {} : { namespace: item.namespace }),
        ...(item.pinned === undefined ? {} : { pinned: item.pinned }),
        ...(item.execute === undefined ? {} : { execute: item.execute }),
        ...(item.permTool === undefined ? {} : { permTool: item.permTool }),
        ...(item.permAction === undefined ? {} : { permAction: item.permAction }),
        ...(item.ruleId === undefined ? {} : { ruleId: item.ruleId }),
        ...(item.patterns === undefined ? {} : { patterns: [...item.patterns] }),
        ...(item.keywords === undefined ? {} : { keywords: [...item.keywords] }),
        ...(item.provenance === undefined ? {} : { provenance: [...item.provenance] }),
        ...(item.custom === undefined ? {} : { custom: item.custom }),
      }
    }),
    records: loaded.records.flatMap((record): Plus.SnapshotRecord[] => {
      if (record.type === "split")
        return [
          {
            type: "split" as const,
            level: record.level,
            agent: record.agent,
            item: record.item,
            boundaries: record.boundaries.map((boundary) => ({ ...boundary })),
            updated: record.updated,
          },
        ]
      if (record.type === "model")
        return [
          {
            type: "model" as const,
            level: record.level,
            agent: record.agent,
            providerID: record.providerID,
            modelID: record.modelID,
            ...(record.variant === undefined ? {} : { variant: record.variant }),
            ...(record.active === undefined ? {} : { active: record.active }),
            updated: record.updated,
          },
        ]
      if (record.type === "rule")
        return [
          {
            type: "rule" as const,
            level: record.level,
            agent: record.agent,
            tool: record.tool,
            id: record.id,
            label: record.label,
            patterns: [...record.patterns],
            keywords: [...record.keywords],
            updated: record.updated,
          },
        ]
      // Team records stay out of `records`: clients read enablement through
      // `teams` instead, and instructions.mutate re-merges stored team
      // records so a client that cannot see them cannot delete them.
      if (record.type === "team") return []
      return [
        {
          type: "customization" as const,
          level: record.level,
          agent: record.agent,
          item: record.item,
          section: record.section,
          ...(record.text === undefined ? {} : { text: record.text }),
          ...(record.state === undefined ? {} : { state: record.state }),
          ...(record.pin === undefined ? {} : { pin: record.pin }),
          basedOn: record.basedOn,
          ...(record.basedOnText === undefined ? {} : { basedOnText: record.basedOnText }),
          ...(record.acknowledged === undefined ? {} : { acknowledged: record.acknowledged }),
          updated: record.updated,
        },
      ]
    }),
    teams: teams.map((team) => ({ level: team.level, team: team.team, enabled: team.enabled, agents: [...team.agents] })),
    servers: discovered.servers.map((server) => ({ name: server.name, enabled: server.enabled })),
    protectedAgents: [...loaded.protectedAgents],
  }
}

// Snapshot.teams keeps membership and enablement on their separate sources:
// disk discovery lists project/global members, the built-in registry lists
// defaults members with no filesystem path, stored team records decide
// enabled. A discovered team with no record reads DISABLED; a record with no
// matching team never surfaces.
async function snapshotTeams(
  directory: string,
  records: readonly StoredRecord[],
  builtins: readonly BuiltinTeam[] = builtinTeams,
): Promise<Plus.TeamEntry[]> {
  const teamRecords = records.filter((record): record is TeamRecord => record.type === "team")
  const disk = await Promise.all([discoverTeams("project", directory), discoverTeams("global", directory)])
  const builtin = discoverBuiltinTeams(builtins)
  return [...disk[0], ...disk[1], ...builtin]
    .map((team): Plus.TeamEntry => ({
      level: team.level,
      team: team.team,
      enabled: isTeamEnabled(teamRecords, team.level, team.team),
      agents: team.agents.map((agent) => agent.id),
    }))
    .toSorted(compareTeams)
}

function compareTeams(left: Plus.TeamEntry, right: Plus.TeamEntry): number {
  if (left.level !== right.level) return left.level < right.level ? -1 : 1
  if (left.team !== right.team) return left.team < right.team ? -1 : 1
  return 0
}

function toAgentFields(fields: CreateAgentFields | undefined): AgentFields | undefined {
  if (fields === undefined) return undefined
  return {
    ...(fields.model === undefined ? {} : { model: fields.model }),
    ...(fields.variant === undefined ? {} : { variant: fields.variant }),
    ...(fields.request === undefined ? {} : { request: { ...fields.request } }),
    ...(fields.description === undefined ? {} : { description: fields.description }),
    ...(fields.mode === undefined ? {} : { mode: fields.mode }),
    ...(fields.hidden === undefined ? {} : { hidden: fields.hidden }),
    ...(fields.color === undefined ? {} : { color: fields.color }),
    ...(fields.steps === undefined ? {} : { steps: fields.steps }),
    ...(fields.disabled === undefined ? {} : { disabled: fields.disabled }),
    ...(fields.permissions === undefined ? {} : { permissions: fields.permissions }),
  }
}
