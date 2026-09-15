import { Plugin } from "@opencode/plugin/effect"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import type { RpcHandlers, RpcRegistration } from "@opencode/plugin/effect/rpc"
import { Agent } from "@opencode/schema/agent"
import { Config } from "@opencode/schema/config"
import { Model } from "@opencode/schema/model"
import { Skill } from "@opencode/schema/skill"
import { Effect, Semaphore, Stream } from "effect"
import type { Scope } from "effect"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import { agentBody, discover, instructionCandidates, type BaseTemplate, type Discovered } from "./instructions/discover.js"
import { create, remove, rename, validateAgentId, type AgentFields } from "./agents/files.js"
import { createBaseTemplate, deleteBaseTemplate, readUserBaseTextSync, readUserBaseTitleSync, userBaseDir, userBaseFile } from "./agents/base.js"
import { addMcp, projectConfigCandidates, removeMcp } from "./agents/mcp.js"
import { createSkill, deleteSkill, importSkill } from "./agents/skills.js"
import { apply, type ToolPlan } from "./instructions/apply.js"
import { installTeaching } from "./instructions/teaching.js"
import { registerInstructionTools } from "./tools.js"
import { dedupeAgents, installTeamAgents, resolveTeamAgents } from "./instructions/teams-apply.js"
import { assembled } from "./instructions/assembled.js"
import { resolve, scopesOf, type CustomizationRecord, type Level, type SplitRecord } from "./instructions/model.js"
import { append, readBoth } from "./instructions/log.js"
import { globalConfigDir, globalLogPath, projectLogPath, resolveInstructionPath } from "./instructions/paths.js"
import { canonical, load, save, stable, type StoredRecord } from "./instructions/store.js"
import { discoverTeams, isTeamEnabled, validateTeamName, type TeamRecord } from "./instructions/teams.js"
import type { PromptBaseline } from "./instructions/inventory.js"
import { disable, enable, read } from "./project.js"
import { CreateAgentFields, Definition, type Plus } from "./rpc.js"

export interface PlusState {
  registration: RpcRegistration<typeof Definition> | undefined
  applied: Registration[]
  tooling: Registration[]
  installedTools: readonly ToolPlan[]
  fingerprint: string | undefined
  projectRevision: number | undefined
  globalRevision: number | undefined
  baselines: Map<string, PromptBaseline>
  semaphore: Semaphore.Semaphore
}

export function createState(): PlusState {
  return {
    registration: undefined,
    applied: [],
    tooling: [],
    installedTools: [],
    fingerprint: undefined,
    projectRevision: undefined,
    globalRevision: undefined,
    baselines: new Map(),
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

export interface PlusApi {
  readonly snapshot: () => Promise<SnapshotResult>
  readonly refresh: () => Promise<RefreshResult>
  readonly mutate: (input: Plus.MutateInput) => Promise<MutateResult>
  readonly log: (input: Plus.LogInput) => Promise<LogResult>
  readonly assembled: (input: Plus.AssembledInput) => Promise<AssembledResult>
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
  readonly setTeamEnabled: (input: Plus.SetTeamEnabledInput & { readonly actor?: Plus.Actor }) => Promise<SetTeamEnabledResult>
}

export function createPlusApi(ctx: Context, state: PlusState): PlusApi {
  return {
    snapshot: async () => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const stored = await load(directory)
      const loaded = { ...stored, protectedAgents: config.protectedAgents }
      const discovered = await discoverAll(ctx, loaded, state.baselines)
      const teams = await snapshotTeams(directory, loaded.records)
      return { ok: true as const, value: toSnapshot(discovered, loaded, teams) }
    },
    refresh: async () => {
      const directory = ctx.location.directory
      const config = await read(directory)
      if (config === undefined)
        return { ok: false as const, error: { code: "project.disabled" as const, message: disabledMessage(directory), data: { directory } } }
      const stored = await load(directory)
      const loaded = { ...stored, protectedAgents: config.protectedAgents }
      const discovered = await Effect.runPromise(publishFresh(ctx, state, loaded))
      const teams = await snapshotTeams(directory, loaded.records)
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
        const discovered = await discoverAll(ctx, loaded, state.baselines)
        const staleTeams = await snapshotTeams(directory, loaded.records)
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
        const discovered = await discoverAll(ctx, refreshed, state.baselines)
        const staleTeams = await snapshotTeams(directory, refreshed.records)
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
      const discovered = await Effect.runPromise(publishFresh(ctx, state, next))
      const teams = await snapshotTeams(directory, next.records)
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
      const discovered = await discoverAll(ctx, loaded, state.baselines)
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
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory))
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
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory))
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
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory))
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
      const known = await discoverTeams(input.level, directory)
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
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory))
      return { ok: true as const, value: { level: input.level, team: validated.team, enabled: input.enabled } }
    },
  }
}

export function createHandlers(ctx: Context, state: PlusState): RpcHandlers<typeof Definition> {
  const api = createPlusApi(ctx, state)
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
  return {
    type: "customization",
    level: record.level,
    agent: record.agent,
    item: record.item,
    section: record.section,
    ...(record.text === undefined ? {} : { text: record.text }),
    ...(record.state === undefined ? {} : { state: record.state }),
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

async function discoverAll(ctx: Context, loaded: LoadedStores, baselines: ReadonlyMap<string, PromptBaseline>): Promise<Discovered> {
  const resolved = await resolveBaseTemplates(ctx)
  return discover({
    ctx,
    records: customizationsOf(loaded.records),
    baselines,
    baseTemplates: resolved.templates,
    activeBase: (agent) => resolved.active(agent),
  })
}

function scopeLevel(scope: "project" | "global" | "defaults"): Level {
  if (scope === "global") return "global"
  if (scope === "defaults") return "defaults"
  return "project"
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
      state.fingerprint = undefined
      state.projectRevision = undefined
      state.globalRevision = undefined
      state.baselines = new Map()
    }),
  )
}

function refreshAfterFileChange(ctx: Context, state: PlusState, directory: string): Effect.Effect<void> {
  return Effect.gen(function* () {
    const stored = yield* Effect.promise(() => loadCurrent(directory))
    yield* publishFresh(ctx, state, stored)
  })
}

// Only publishFresh and deactivate acquire the semaphore, and neither calls the
// other, so a caller never blocks on a permit it already holds.
function publishFresh(ctx: Context, state: PlusState, stored: LoadedStores): Effect.Effect<Discovered> {
  return state.semaphore.withPermits(1)(
    Effect.gen(function* () {
      const discovered = yield* Effect.promise(() => discoverAll(ctx, stored, state.baselines))
      // A newer publish already won; this read is stale, so leave the applied
      // registrations and the last emitted revision untouched.
      if (state.projectRevision !== undefined && stored.projectRevision < state.projectRevision) return discovered
      if (state.globalRevision !== undefined && stored.globalRevision < state.globalRevision) return discovered
      const customizations = customizationsOf(stored.records)
      const splits = splitsOf(stored.records)
      const fingerprint = yield* Effect.promise(() => fingerprintPublish(discovered, stored.records, ctx.location.directory))
      if (state.projectRevision !== undefined && fingerprint === state.fingerprint) {
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
        }),
      )
      // Enabled teams become real core-visible agents: resolve the enabled
      // teams against the discovered regular sources (resolveTeams already
      // favours an established same-level regular, so losing team copies never
      // reach the installer) and register each winner's markdown body with the
      // host. Team registrations install after apply's own and dispose with
      // the same superseded set when the next publish replaces them.
      const teamAgents = yield* Effect.promise(() =>
        resolveTeamAgents(ctx.location.directory, stored.records.filter(isTeamRecord), discovered.agents),
      )
      const teamApplied = yield* Effect.promise(() => installTeamAgents(ctx, teamAgents))
      const previous = state.applied
      state.applied = [...applied.registrations, ...teamApplied.registrations]
      state.installedTools = applied.tools
      state.fingerprint = fingerprint
      state.projectRevision = stored.projectRevision
      state.globalRevision = stored.globalRevision
      captureBaselines(ctx, state, discovered, customizations, splits)
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
// tools and skills key by item id.
export function captureBaselines(
  ctx: Context,
  state: PlusState,
  discovered: Discovered,
  records: readonly CustomizationRecord[],
  splits: readonly SplitRecord[],
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
// own inputs, so only the resolved team winners (with their markdown bodies)
// make the toggle change the fingerprint.
async function fingerprintPublish(
  discovered: Discovered,
  records: readonly StoredRecord[],
  directory: string,
): Promise<string> {
  const scopes = scopesOf(discovered.agents)
  const teamAgents = await resolveTeamAgents(directory, records.filter(isTeamRecord), discovered.agents)
  const teamBodies = await Promise.all(
    teamAgents.map(async (agent) => ({
      id: agent.id,
      scope: agent.scope,
      body: agent.path === undefined ? undefined : await readTeamBody(agent.path),
    })),
  )
  return JSON.stringify({
    items: discovered.items,
    agents: discovered.agents,
    servers: discovered.servers,
    records,
    teamBodies,
    scopes: { global: [...scopes.global].toSorted(), defaults: [...scopes.defaults].toSorted() },
  })
}

async function readTeamBody(file: string): Promise<string | undefined> {
  return fs.readFile(file, "utf8").catch(() => undefined)
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

function watchHostEvents(ctx: Context, state: PlusState): Effect.Effect<void, never, Scope.Scope> {
  return ctx.event.subscribe().pipe(
    Stream.filter((event) => RefreshEvents.has(event.type)),
    Stream.runForEach((event) =>
      refreshFromHost(ctx, state).pipe(
        Effect.catchCause((cause) => Effect.logWarning("plus refresh failed", { cause, type: event.type })),
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
    Effect.asVoid,
  )
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
      fileBacked: agent.path !== undefined,
    })),
    items: discovered.items.map((item) => ({
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
      ...(item.userBase === true ? { userBase: true as const } : {}),
      ...(item.codemode === true ? { codemode: true as const } : {}),
    })),
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
// disk discovery lists the members, stored team records decide enabled. A
// discovered team with no record reads DISABLED; a record with no matching
// directory never surfaces — the toggle requires a known directory first.
async function snapshotTeams(directory: string, records: readonly StoredRecord[]): Promise<Plus.TeamEntry[]> {
  const teamRecords = records.filter((record): record is TeamRecord => record.type === "team")
  const discovered = await Promise.all([discoverTeams("project", directory), discoverTeams("global", directory)])
  return discovered
    .flat()
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
