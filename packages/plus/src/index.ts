import { pacerCache, pacerUsedUp, provideLegacyQuotaStorage, onQuotaFact } from "@opencodeplus/cliproxyapi/server"
import { Plugin } from "@opencode/plugin/effect"
import type { AgentEditor } from "@opencode/plugin/effect/agent"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import type { RpcHandlers, RpcRegistration } from "@opencode/plugin/effect/rpc"
import type { StorageDomain } from "@opencode/plugin/effect/storage"
import { Agent } from "@opencode/schema/agent"
import { Config } from "@opencode/schema/config"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { Skill } from "@opencode/schema/skill"
import { DateTime, Duration, Effect, Option, Queue, Scope, Schema, Semaphore, Stream } from "effect"
import fs from "node:fs/promises"
import fsSync from "node:fs"
import path from "node:path"
import { agentBody, discover, hostModelsFrom, instructionCandidates, type BaseTemplate, type Discovered } from "./instructions/discover.js"
import { validateRuleInput } from "./instructions/tool-permissions.js"
import { create, formatMarkdown, remove, rename, validateAgentId, type AgentFields } from "./agents/files.js"
import { createBaseTemplate, deleteBaseTemplate, readUserBaseTextSync, readUserBaseTitleSync, userBaseDir, userBaseFile } from "./agents/base.js"
import { createSystemRow, deleteSystemRow, setModelPromptModels } from "./agents/system.js"
import { addMcp, projectConfigCandidates, removeMcp } from "./agents/mcp.js"
import { createSkill, deleteSkill, importSkill, type SkillTarget } from "./agents/skills.js"
import { applyPublishParts, attentionRowsOf, roleUpdates, runRegistration, type AppliedPart, type ApplyAgent, type ApplyInput, type ToolPlan } from "./instructions/apply.js"
import { controlItems, controlRecordError } from "./instructions/agent-controls.js"
import { inPublishBatch } from "./instructions/publish-runtime.js"
import { installTeaching } from "./instructions/teaching.js"
import { INSTRUCTION_DISABLED, registerInstructionTools } from "./tools.js"
import { listOps, runOp, toolRegistry, withCliActor } from "./instructions-cli.js"
import { registerReleaseTools } from "./release/tools.js"
import { registerSearchMcp } from "./search/register.js"
import { createTeamApi } from "./teams/api.js"
import { buildRunTree, byDirectory, bySession, loadRun } from "./teams/run.js"
import { readJson } from "./teams/store.js"
import { onSessionEvent, slowWarning, startSweep } from "./teams/lifecycle.js"
import { RETRY_SCHEDULED, SessionRunEvents } from "./teams/session-events.js"
import { registerTeamTools } from "./teams/tools.js"
import { liveRunScopes, policyMembersOf, teamPolicyItems } from "./instructions/team-policy-rows.js"
import { enforcementState, type EnforcementState, type PermissionTable } from "./instructions/permission-enforce.js"
import { dedupeAgents, parseTeamFields, type TeamFields } from "./instructions/teams-apply.js"
import { assembled } from "./instructions/assembled.js"
import { memoInputOf } from "./instructions/snapshot.js"
import { ownRule, ruleAt } from "./instructions/rules.js"
import { pickModelRow, switchModelActivation, type ModelPick } from "./instructions/ops.js"
import {
  cacheLifetimeOf,
  compactionFieldsOf,
  effectiveCompaction,
  effectiveImages,
  everySettings,
  MODEL_DEFAULT_FIELDS,
  roundedWarmingFor,
  setModelSettingsRecord,
  settingsFor,
  warmingFieldsOf,
  type CompactionDefaults,
  type HostModel,
  type ModelSettingsRecord,
} from "./instructions/model-settings.js"
import { learnMcpTools, loadKnownMcpTools, saveKnownMcpTools, type KnownMcpTools } from "./instructions/mcp-tools.js"
import { activateModel, addModelRecord, catalogueField, catalogueMatches, fingerprint, hasModelActiveAt, modelItemId, parseMemberOwnerPath, permItemId, presetKey, resolve, resolveActiveModel, resolveModelFields, runtimeScope, sameTeam, scopedTo, scopesOf, type AgentSource, type Catalogue, type CustomizationRecord, type Item, type Level, type ModelRecord, type PresetRef, type RecordScope, type RuleRecord, type Scopes, type SplitRecord, type TeamRef } from "./instructions/model.js"
import { append, appendForLevel, readBoth } from "./instructions/log.js"
import { globalLogPath, globalRecordsPath, globalTeamsPath, projectTeamsPath, resolveInstructionPath, teamsDataDir, userSystemFile } from "./instructions/paths.js"
import { canonical, ensureCatalogues, linkedProjects, load, loadedFromSave, projectLinks, save, stable, updateGated, type EntryRecord, type FolderRecord, type LinkRecord, type OrderRecord, type PresetRecord, type StoredRecord } from "./instructions/store.js"
import { deltaRows, keyIdentity, recordIdentity, recordTarget } from "./instructions/delta.js"
import { layoutRefusal } from "./instructions/folders.js"
import { builtinBody, discoverAllTeams, discoverBuiltinTeams, discoverTeams, isTeamEnabled, rankOf, resolveTeams, validateTeamName, type DiscoveredTeam, type TeamLevel, type TeamRecord } from "./instructions/teams.js"
import type { BuiltinTeam } from "./instructions/builtin-teams.js"
import {
  chainContext,
  linkCycle,
  nativePresetIds,
  ownerRowId,
  presetListing,
  presetOwner,
  presetStateOf,
  presetUsers,
  targetsPreset,
  teamPresetMembers,
  validateEntryName,
  type PresetEntry,
} from "./instructions/presets.js"
import type { ModelBaseline, ModelRefLike, PromptBaseline } from "./instructions/inventory.js"
import { matchesTeamApplied, sameModelRef } from "./instructions/inventory.js"
import { ensure, read } from "./project.js"
import { mainCheckout, readProjectChecks, suggestChecks, writeProjectChecks } from "./teams/project-checks.js"
import { listRunsForNamespace } from "./teams/api-query.js"
import { stopRun } from "./teams/api-lifecycle.js"
import { Definition, type Plus } from "./rpc.js"
import { notifySharedStoreChanged, onSharedStoreChanged } from "./shared-store-bus.js"
import { acquireSharedStoreWatch } from "./shared-store-file.js"
import { consumeColdCompaction } from "./teams/cold-compaction.js"
import { warmingStore, type ChatCompactionDefaults, type WarmingRows, type WarmingStatus } from "./warming.js"
import { cacheLifetime } from "./monitor/cache.js"
import { monitorCache, monitorDismiss, monitorFact, monitorMark, monitorNotices, monitorPrompt, monitorQuery, monitorSessions, monitorStep, watchMonitor } from "./monitor/plugin.js"
import { ledgerAt, type Ledger, type RequestRow } from "./monitor/ledger.js"
import { coldStateOf, decideCompaction } from "./compaction/decide.js"
import { plusSettings } from "./plus-settings.js"
import { agentAttention, mergeAttention, type AttentionRow } from "./attention-settings.js"
import { attentionStore } from "./attention.js"
import { createAttentionWatcher } from "./attention-watch.js"
import { chooseImage } from "./image-settings.js"
import { armedColdListOf, compactionRowsOf, inputThresholdOf, modelRowContextOf, scopeLevel } from "./compaction/rows.js"
import { registerMonitorTools } from "./monitor/tools.js"
import { registerRefreshTool } from "./refresh-tool.js"
import type { SessionImage, SessionWarming } from "@opencode/plugin/effect/session"
import type { SessionCompactionDecision } from "@opencode/plugin/compaction-decision"
import { handlePromptBoundary, SessionPinManager, type PlanSet } from "./instructions/cache-safe.js"
import { chatModelForAgent, currentSessionAgent, currentSessionModel, toHostModelRef } from "./session-model.js"

export interface TeamOwnership {
  readonly team: string
  readonly level: TeamLevel
}

export interface PlusState {
  /** When this Location's Plus instance started: its folder's files were read then. */
  readonly loadedAt: number
  /** Chats that already had their first prompt here (a new chat re-reads the folder's files once). */
  readonly chatsSeen: Set<string>
  registration: RpcRegistration<typeof Definition> | undefined
  applied: Registration[]
  appliedParts: Map<string, AppliedPart>
  appliedPlans: Map<string, unknown>
  sessionPins: SessionPinManager
  currentPlanSet?: PlanSet
  tooling: Registration[]
  teamTooling: Registration[]
  installedTools: readonly ToolPlan[]
  fingerprint: string | undefined
  projectRevision: number | undefined
  globalRevision: number | undefined
  pendingHostChange: boolean
  /** A change with no record write (a team directory) is pending: rediscover even with unchanged revisions. */
  pendingForce: boolean
  pendingRefresh: boolean
  /**
   * Last time this Location was used (a prompt, a Plus RPC). A Location idle
   * longer than IDLE_REFRESH_MS, with no session running here, does not
   * refresh on another Location's write: it refreshes on next use. A warming
   * ping catches up first but is no use: a finished chat kept warm would
   * otherwise refresh on every write.
   */
  lastUsedAt: number
  /** Sessions running in this Location right now (execution started, not yet settled). */
  readonly running: Set<string>
  refreshTimer?: ReturnType<typeof setTimeout>
  activeRefresh?: Promise<void>
  /**
   * The last built snapshot for the current (projectRevision,
   * globalRevision, snapshotGeneration) key. The generation is bumped
   * whenever something outside the store can change what a snapshot contains
   * (host events, the tool registry, team changes, file changes), so a stale
   * read cannot answer while the key matches. `snapshot` returns the cached
   * value as-is; it is never mutated after being built.
   */
  snapshotCache?: { projectRevision: number; globalRevision: number; generation: number; value: Plus.Snapshot }
  snapshotGeneration: number
  baselines: Map<string, PromptBaseline>
  modelBaselines: Map<string, ModelBaseline>
  activeModels: Map<string, ModelRefLike>
  /** Model records from the last publish or refresh: cache warming reads each agent's model rows here. */
  cachedModels: readonly ModelRecord[]
  /** Defaults › Models rows from the same read: cache warming falls back to them per field. */
  cachedModelSettings: readonly ModelSettingsRecord[]
  /** When cache warming last checked the store for changes from another directory. */
  warmingCheckedAt: number
  cachedAgents: readonly AgentSource[]
  cachedScopes: Scopes
  teamOutputIds: Map<string, TeamOwnership>
  semaphore: Semaphore.Semaphore
  /** Every agent's resolved permission rows from the last publish; the team tools read their rows here. */
  permissions: PermissionTable | undefined
  /** Every agent's notification rows from the last publish, resolved down its chain (attention-watch.ts). */
  attentionRows: ReadonlyMap<string, Readonly<Partial<Record<AttentionRow, string>>>>
  /** Hook-side permission state that outlives one publish (pending approvals, "always" answers). */
  enforcement: EnforcementState
  agentObserver?: Registration
  agentUpstream?: readonly Agent.Info[]
  /** The tool registry's ids as the last discovery found them; a registry that lists others has changed under it. */
  discoveredTools?: ReadonlySet<string>
  /** The tools each MCP server registered when last connected (mcp-tools.ts). */
  knownMcpTools?: KnownMcpTools
  /**
   * The provider catalogue (models, variants, host warming) cached from the
   * first read. Navigation, snapshots and pickers reuse it instead of calling
   * `ctx.model.list()` each time; a host config/agent/skill refresh clears it,
   * as does a model.updated event, and the catalogue expires after five minutes.
   */
  hostModels?: readonly HostModel[]
  /** Last catalogue announced to open Instructions views, independent of installed agents. */
  publishedHostModels?: string
  /**
   * The raw provider catalogue the cached `hostModels` derive from, read in
   * the same call. Base-template classification, model validation and the
   * per-request classifier read it instead of listing the catalogue again.
   */
  hostCatalog?: readonly Model.Info[]
  /** When `hostCatalog` was read; past HOST_CATALOG_TTL_MS the next read lists again. */
  hostCatalogAt?: number
  /**
   * The in-flight `model.pick` save in this Plus instance, if any.
   * `applySessionModel` awaits it before comparing, so a session created right
   * after a pick cannot be reverted by the still-running pick.
   */
  pendingPick?: Promise<void>
}

export function createState(storage?: StorageDomain): PlusState {
  return {
    loadedAt: Date.now(),
    chatsSeen: new Set(),
    registration: undefined,
    applied: [],
    appliedParts: new Map(),
    appliedPlans: new Map(),
    sessionPins: new SessionPinManager(storage),
    currentPlanSet: undefined,
    tooling: [],
    teamTooling: [],
    installedTools: [],
    fingerprint: undefined,
    projectRevision: undefined,
    globalRevision: undefined,
    pendingHostChange: false,
    pendingForce: false,
    pendingRefresh: false,
    lastUsedAt: Date.now(),
    running: new Set(),
    refreshTimer: undefined,
    activeRefresh: undefined,
    snapshotGeneration: 0,
    baselines: new Map(),
    modelBaselines: new Map(),
    activeModels: new Map(),
    cachedModels: [],
    cachedModelSettings: [],
    warmingCheckedAt: 0,
    cachedAgents: [],
    cachedScopes: { global: new Set(), defaults: new Set() },
    teamOutputIds: new Map(),
    permissions: undefined,
    attentionRows: new Map(),
    enforcement: enforcementState(),
    semaphore: Effect.runSync(Semaphore.make(1)),
  }
}

export default Plugin.define({
  id: "opencode.plus",
  effect: (ctx) =>
    Effect.gen(function* () {
      // CPA features moved to the opencode.plus.cliproxyapi plugin; it migrates
      // quota bindings that earlier versions stored under this plugin's storage.
      provideLegacyQuotaStorage((key) => Effect.runPromise(ctx.storage.get(key)))
      // Receive account-switch and handoff facts from the CLIProxyAPI plugin.
      // Plus re-activates on config changes, so the finalizer below must remove
      // this listener before the next effect can register another.
      const disposeQuotaFacts = onQuotaFact(monitorFact)
      yield* Effect.addFinalizer(() => Effect.sync(() => disposeQuotaFacts()))
      const state = createState(ctx.storage)
      // Applied registrations live on detached scopes, so without this
      // finalizer they outlive the plugin when core unloads or reactivates it.
      yield* Effect.addFinalizer(() => deactivate(state))
      const registration = yield* ctx.rpc.register(Definition, usedHandlers(ctx, state, createHandlers(ctx, state))).pipe(Effect.orDie)
      state.registration = registration
      // Team tools exist in every Plus instance: a child worktree may carry no
      // project store of its own and still needs them, so this stays out of
      // activate/installTooling.
      yield* ensureTeamTooling(ctx, state)
      yield* activate(ctx, state).pipe(
        Effect.catchCause((cause) => Effect.logWarning("plus activation failed", { cause })),
      )
      // Keep-alives ask core what runs now (process-wide, the same set as
      // /api/session/active), so a missed session event cannot hold a chat's
      // waiting window.
      warmingStore.setActiveReader(() => activeSessionsOf(ctx))
      warmingStore.setCompactDefaultsReader((sessionID) => sessionCompactDefaults(ctx, state, sessionID))
      warmingStore.setCompactionReader((sessionID) =>
        Effect.runPromise(
          ctx.session.context({ sessionID: Session.ID.make(sessionID) }).pipe(
            Effect.map((messages) => {
              const compactionIdx = messages.findLastIndex(
                (m) => m.type === "compaction" && m.status === "completed",
              )
              if (compactionIdx === -1) return undefined
              const comp = messages[compactionIdx]
              const created = comp.time?.created
              const completedAt =
                typeof created === "number"
                  ? created
                  : created
                    ? DateTime.toEpochMillis(created)
                    : Date.now()
              const afterCompaction = messages.slice(compactionIdx + 1)
              const hasSubsequentRealRequest = afterCompaction.some(
                (m) => m.type === "user" || m.type === "assistant",
              )
              return { completedAt, hasSubsequentRealRequest }
            }),
            Effect.catchCause(() => Effect.succeed(undefined)),
          ),
        ),
      )
      yield* watchHostEvents(ctx, state)
      yield* watchAttention(ctx, state)
      yield* watchSharedStore(ctx, state)
      yield* ctx.session.hook("moved", (event) => transferSessionModel(ctx, state, event.source, event.destination))
      // Core runs warming hooks in registration order on one event, so Plus
      // decides before the monitor records the warming fact: registered the
      // other way round, the fact kept core's proposal ("on") after Plus had
      // turned warming off.
      // A warming ping replays this folder's prefix: bring it up to date first.
      yield* ctx.session.hook("warming", (event) => Effect.andThen(catchUp(ctx, state), decideWarmingFor(ctx, state, event)))
      // A location with a coalesced refresh pending applies it before a chat
      // request runs, so no request uses stale instructions.
      yield* ctx.session.hook("prompt", (event) =>
        Effect.gen(function* () {
          // The new-chat folder re-read runs beside the first request, not before it:
          // reloading config, instructions, agents, commands and skills costs seconds.
          if (event && event.sessionID)
            yield* Effect.forkDetach(refreshFolderForNewChat(ctx, state, String(event.sessionID)))
          yield* useLocation(ctx, state)
          if (event && event.sessionID) yield* handlePromptBoundary(ctx, state, String(event.sessionID))
        }).pipe(slowWarning("plus prompt hook", { sessionID: String(event?.sessionID ?? ""), directory: ctx.location.directory }, () => ({ refreshes: stuckRefreshes() }))),
      )
      yield* ctx.session.hook("compaction", (event) => state.sessionPins.markRebuild(String(event.sessionID)))
      yield* ctx.session.hook("compaction.decide", (event) => decideCompactionFor(ctx, state, event))
      // Instructions › a model › Images: how an image that arrives in a chat on that model is stored.
      yield* ctx.session.hook("image", (event) => chooseImageFor(ctx, state, event))
      // The monitor records every step and tool call this Location sees; a
      // ledger failure is logged and never takes the plugin down with it.
      yield* watchMonitor(ctx, () => configIdentity(state))
      // One tick, one place: dead-run reconciliation (and later GC) runs here
      // and nowhere else, cancelled with the plugin scope. One pass per process
      // at a time, whichever workspace's loop wins the sweep permit.
      yield* startSweep(ctx, teamsDataDir())
    }),
})

// Which instructions were in force, stored on every monitor step so windows can
// be compared across edits: the project and global store revisions, which move
// only when someone changes a row (the publish fingerprint also moves with
// derived run state, which would split one configuration into many).
function configIdentity(state: PlusState): string | undefined {
  if (state.projectRevision === undefined && state.globalRevision === undefined) return undefined
  return `p${state.projectRevision ?? 0}·g${state.globalRevision ?? 0}`
}

export type SnapshotResult = { ok: true; value: Plus.Snapshot }

export type RefreshResult = SnapshotResult

export type MutateResult =
  | { ok: true; value: Plus.MutateResult }
  | { ok: false; error: { code: "agent.protected"; message: string; data: Plus.AgentProtected } }
  | { ok: false; error: { code: "agent.invalid"; message: string; data: Plus.AgentInvalid } }

// What updateGated's change function decides for a delta mutate before the
// write: a refusal (nothing written), an invalid control row (nothing
// written), or the merged record list to write.
type DeltaDecision =
  | { kind: "refusal"; error: { code: "agent.protected"; message: string; data: Plus.AgentProtected } }
  | { kind: "invalid"; error: { code: "agent.invalid"; message: string; data: Plus.AgentInvalid } }
  | { kind: "ok"; records: readonly StoredRecord[] }

export type LogResult = { ok: true; value: Plus.LogOutput }

export type AssembledResult =
  | { ok: true; value: Plus.Assembled }
  | {
      ok: false
      error:
        | { code: "agent.unknown"; message: string; data: Plus.AgentUnknown }
    }

export type CreateAgentResult =
  | { ok: true; value: Plus.AgentRef }
  | {
      ok: false
      error:
        | { code: "agent.exists"; message: string; data: Plus.AgentExists }
        | { code: "agent.invalid"; message: string; data: Plus.AgentInvalid }
        | { code: "agent.protected"; message: string; data: Plus.AgentProtected }
        | { code: "preset.invalid"; message: string; data: Plus.PresetInvalid }
    }

type PresetInvalidError = { code: "preset.invalid"; message: string; data: Plus.PresetInvalid }
type EntryInvalidError = { code: "entry.invalid"; message: string; data: Plus.EntryInvalid }
type EntryExistsError = { code: "entry.exists"; message: string; data: Plus.EntryExists }
type EntryMissingError = { code: "entry.missing"; message: string; data: Plus.EntryMissing }
type PresetExistsError = { code: "preset.exists"; message: string; data: Plus.PresetExists }
type PresetReadonlyError = { code: "preset.readonly"; message: string; data: Plus.PresetReadonly }

export type CreateEntryResult =
  | { ok: true; value: Plus.EntryRef }
  | { ok: false; error: EntryInvalidError | EntryExistsError | PresetInvalidError }

export type DeleteEntryResult =
  | { ok: true; value: Plus.EntryRef }
  | { ok: false; error: EntryInvalidError | EntryMissingError }

export type RenameEntryResult =
  | { ok: true; value: Plus.EntryRef }
  | { ok: false; error: EntryInvalidError | EntryExistsError | EntryMissingError }

export type CreatePresetResult =
  | { ok: true; value: Plus.PresetResult }
  | { ok: false; error: PresetInvalidError | PresetExistsError }

export type AddPresetMemberResult =
  | { ok: true; value: Plus.PresetResult }
  | { ok: false; error: PresetInvalidError | PresetExistsError | PresetReadonlyError }

export type DeletePresetResult =
  | { ok: true; value: Plus.PresetResult }
  | {
      ok: false
      error:
        | PresetInvalidError
        | PresetReadonlyError
        | { code: "preset.inUse"; message: string; data: Plus.PresetInUse }
    }

export type SetLinkResult =
  | { ok: true; value: Plus.LinkResult }
  | {
      ok: false
      error:
        | PresetInvalidError
        | PresetReadonlyError
        | { code: "link.invalid"; message: string; data: Plus.LinkInvalid }
        | { code: "link.cycle"; message: string; data: Plus.LinkCycle }
        | { code: "agent.protected"; message: string; data: Plus.AgentProtected }
    }

export type RenameAgentResult =
  | { ok: true; value: Plus.RenameAgentResult }
  | {
      ok: false
      error:
        | { code: "agent.missing"; message: string; data: Plus.AgentMissing }
        | { code: "agent.exists"; message: string; data: Plus.AgentExists }
        | { code: "agent.invalid"; message: string; data: Plus.AgentInvalid }
        | { code: "agent.protected"; message: string; data: Plus.AgentProtected }
        | { code: "team.unknown"; message: string; data: Plus.TeamUnknown }
        | { code: "team.invalid"; message: string; data: Plus.TeamInvalid }
    }

export type DeleteAgentResult =
  | { ok: true; value: Plus.AgentRef }
  | {
      ok: false
      error:
        | { code: "agent.missing"; message: string; data: Plus.AgentMissing }
        | { code: "agent.invalid"; message: string; data: Plus.AgentInvalid }
        | { code: "agent.protected"; message: string; data: Plus.AgentProtected }
    }

export type CreateSkillResult =
  | { ok: true; value: Plus.SkillRef }
  | {
      ok: false
      error:
        | { code: "skill.exists"; message: string; data: Plus.SkillExists }
        | { code: "skill.invalid"; message: string; data: Plus.SkillInvalid }
    }

export type ImportSkillResult = CreateSkillResult

export type DeleteSkillResult =
  | { ok: true; value: Plus.SkillRef }
  | {
      ok: false
      error:
        | { code: "skill.missing"; message: string; data: Plus.SkillMissing }
        | { code: "skill.invalid"; message: string; data: Plus.SkillInvalid }
        | { code: "agent.protected"; message: string; data: Plus.AgentProtected }
    }

export type CreateBaseResult =
  | { ok: true; value: Plus.BaseRef }
  | {
      ok: false
      error:
        | { code: "base.exists"; message: string; data: Plus.BaseExists }
        | { code: "base.invalid"; message: string; data: Plus.BaseInvalid }
    }

export type DeleteBaseResult =
  | { ok: true; value: Plus.BaseRef }
  | {
      ok: false
      error:
        | { code: "base.missing"; message: string; data: Plus.BaseMissing }
        | { code: "base.invalid"; message: string; data: Plus.BaseInvalid }
        | { code: "agent.protected"; message: string; data: Plus.AgentProtected }
    }

export type CreateSystemResult =
  | { ok: true; value: Plus.SystemRef }
  | {
      ok: false
      error:
        | { code: "system.exists"; message: string; data: Plus.SystemExists }
        | { code: "system.invalid"; message: string; data: Plus.SystemInvalid }
    }

export type DeleteSystemResult =
  | { ok: true; value: Plus.SystemRef }
  | {
      ok: false
      error:
        | { code: "system.missing"; message: string; data: Plus.SystemMissing }
        | { code: "system.invalid"; message: string; data: Plus.SystemInvalid }
        | { code: "agent.protected"; message: string; data: Plus.AgentProtected }
    }

export type SetSystemModelsResult =
  | { ok: true; value: Plus.SystemRef }
  | {
      ok: false
      error:
        | { code: "system.missing"; message: string; data: Plus.SystemMissing }
        | { code: "system.invalid"; message: string; data: Plus.SystemInvalid }
    }

export type CreateInstructionApiResult =
  | { ok: true; value: Plus.InstructionRef }
  | {
      ok: false
      error:
        | { code: "instruction.exists"; message: string; data: Plus.InstructionExists }
        | { code: "instruction.invalid"; message: string; data: Plus.InstructionInvalid }
    }

export type DeleteInstructionApiResult =
  | { ok: true; value: Plus.InstructionRef }
  | {
      ok: false
      error:
        | { code: "instruction.missing"; message: string; data: Plus.InstructionMissing }
        | { code: "instruction.invalid"; message: string; data: Plus.InstructionInvalid }
    }

export type AddMcpResult =
  | { ok: true; value: Plus.McpRef }
  | {
      ok: false
      error:
        | { code: "mcp.exists"; message: string; data: Plus.McpExists }
        | { code: "mcp.invalid"; message: string; data: Plus.McpInvalid }
    }

export type RemoveMcpResult =
  | { ok: true; value: Plus.McpRef }
  | {
      ok: false
      error:
        | { code: "mcp.missing"; message: string; data: Plus.McpMissing }
        | { code: "mcp.invalid"; message: string; data: Plus.McpInvalid }
        | { code: "agent.protected"; message: string; data: Plus.AgentProtected }
    }

export type SetTeamEnabledResult =
  | { ok: true; value: Plus.TeamActivation }
  | {
      ok: false
      error:
        | { code: "team.unknown"; message: string; data: Plus.TeamUnknown }
        | { code: "team.invalid"; message: string; data: Plus.TeamInvalid }
    }

export type SetModelSettingsResult =
  | { ok: true; value: Plus.SetModelSettingsOutput }
  | { ok: false; error: { code: "modelSettings.invalid"; message: string; data: Plus.ModelSettingsInvalid } }

function invalidModelSettings(reason: string): SetModelSettingsResult {
  return { ok: false, error: { code: "modelSettings.invalid", message: reason, data: { reason } } }
}

export type LayoutWriteResult =
  | { ok: true; value: Plus.LayoutWriteOutput }
  | { ok: false; error: { code: "layout.invalid"; message: string; data: Plus.LayoutInvalid } }

function invalidLayout(reason: string): LayoutWriteResult {
  return { ok: false, error: { code: "layout.invalid", message: reason, data: { code: "layout.invalid", reason } } }
}

// A folder or order keeps its stored `updated` unless its content changed.
function stamped<T extends { readonly updated: string }>(next: T, previous: T | undefined, updated: string): T {
  if (previous !== undefined && JSON.stringify({ ...previous, updated: "" }) === JSON.stringify({ ...next, updated: "" })) return previous
  return { ...next, updated }
}

export type CreateTeamResult =
  | { ok: true; value: Plus.TeamRef }
  | {
      ok: false
      error:
        | { code: "team.exists"; message: string; data: Plus.TeamExists }
        | { code: "team.invalid"; message: string; data: Plus.TeamInvalid }
        | { code: "team.create"; message: string; data: Plus.TeamCreate }
        | { code: "agent.protected"; message: string; data: Plus.AgentProtected }
    }

export type AddTeamAgentResult =
  | { ok: true; value: Plus.AgentRef }
  | {
      ok: false
      error:
        | { code: "team.unknown"; message: string; data: Plus.TeamUnknown }
        | { code: "team.invalid"; message: string; data: Plus.TeamInvalid }
        | { code: "agent.exists"; message: string; data: Plus.AgentExists }
        | { code: "agent.invalid"; message: string; data: Plus.AgentInvalid }
        | { code: "agent.protected"; message: string; data: Plus.AgentProtected }
        | PresetInvalidError
        | EntryInvalidError
        | EntryExistsError
    }

export type RemoveTeamAgentResult =
  | { ok: true; value: Plus.AgentRef }
  | {
      ok: false
      error:
        | { code: "team.unknown"; message: string; data: Plus.TeamUnknown }
        | { code: "team.invalid"; message: string; data: Plus.TeamInvalid }
        | { code: "agent.invalid"; message: string; data: Plus.AgentInvalid }
        | { code: "agent.protected"; message: string; data: Plus.AgentProtected }
    }

export type DeleteTeamResult =
  | { ok: true; value: Plus.DeleteTeamResult }
  | {
      ok: false
      error:
        | { code: "team.unknown"; message: string; data: Plus.TeamUnknown }
        | { code: "team.invalid"; message: string; data: Plus.TeamInvalid }
        | { code: "agent.protected"; message: string; data: Plus.AgentProtected }
    }

export type RenameTeamResult =
  | { ok: true; value: Plus.RenameTeamResult }
  | {
      ok: false
      error:
        | { code: "team.unknown"; message: string; data: Plus.TeamUnknown }
        | { code: "team.exists"; message: string; data: Plus.TeamExists }
        | { code: "team.invalid"; message: string; data: Plus.TeamInvalid }
        | { code: "agent.protected"; message: string; data: Plus.AgentProtected }
    }

export type ListTeamsResult =
  | { ok: true; value: Plus.TeamListOutput }

export type AddModelResult =
  | { ok: true; value: Plus.ModelRef }
  | {
      ok: false
      error:
        | { code: "model.exists"; message: string; data: Plus.ModelExists }
        | { code: "model.invalid"; message: string; data: Plus.ModelInvalid }
        | { code: "agent.protected"; message: string; data: Plus.AgentProtected }
    }

export type RemoveModelResult =
  | { ok: true; value: Plus.ModelRef }
  | {
      ok: false
      error:
        | { code: "model.missing"; message: string; data: Plus.ModelMissing }
        | { code: "model.invalid"; message: string; data: Plus.ModelInvalid }
        | { code: "agent.protected"; message: string; data: Plus.AgentProtected }
    }

export type PickModelResult =
  | { ok: true; value: Plus.ModelPickOutput }
  | { ok: false; error: { code: "model.invalid"; message: string; data: Plus.ModelInvalid } }

export type CatalogModelsResult =
  | { ok: true; value: Plus.CatalogModelsOutput }

export type AddRuleResult =
  | { ok: true; value: Plus.RuleRef }
  | {
      ok: false
      error:
        | { code: "rule.exists"; message: string; data: Plus.RuleExists }
        | { code: "rule.invalid"; message: string; data: Plus.RuleInvalid }
        | { code: "agent.protected"; message: string; data: Plus.AgentProtected }
    }

export type RemoveRuleResult =
  | { ok: true; value: Plus.RuleRef }
  | {
      ok: false
      error:
        | { code: "rule.missing"; message: string; data: Plus.RuleMissing }
        | { code: "rule.invalid"; message: string; data: Plus.RuleInvalid }
        | { code: "agent.protected"; message: string; data: Plus.AgentProtected }
    }

export type UpdateRuleResult =
  | { ok: true; value: Plus.RuleRef }
  | {
      ok: false
      error:
        | { code: "rule.invalid"; message: string; data: Plus.RuleInvalid }
        | { code: "agent.protected"; message: string; data: Plus.AgentProtected }
    }

export interface PlusApi {
  readonly snapshot: () => Promise<SnapshotResult>
  readonly refresh: () => Promise<RefreshResult>
  readonly chatRefresh: (input: Schema.Schema.Type<typeof Plus.ChatRefreshInput>) => Promise<{ ok: true; value: Schema.Schema.Type<typeof Plus.ChatRefreshResult> }>
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
  readonly createSystem: (input: Plus.CreateSystemInput & { readonly actor?: Plus.Actor }) => Promise<CreateSystemResult>
  readonly deleteSystem: (input: Plus.DeleteSystemInput & { readonly actor?: Plus.Actor }) => Promise<DeleteSystemResult>
  readonly setSystemModels: (input: Plus.SetSystemModelsInput & { readonly actor?: Plus.Actor }) => Promise<SetSystemModelsResult>
  readonly createInstruction: (input: Plus.CreateInstructionInput & { readonly actor?: Plus.Actor }) => Promise<CreateInstructionApiResult>
  readonly deleteInstruction: (input: Plus.DeleteInstructionInput & { readonly actor?: Plus.Actor }) => Promise<DeleteInstructionApiResult>
  readonly addMcp: (input: Plus.AddMcpInput & { readonly actor?: Plus.Actor }) => Promise<AddMcpResult>
  readonly removeMcp: (input: Plus.McpRef & { readonly actor?: Plus.Actor }) => Promise<RemoveMcpResult>
  readonly createTeam: (input: Plus.CreateTeamInput & { readonly actor?: Plus.Actor }) => Promise<CreateTeamResult>
  readonly setTeamEnabled: (input: Plus.SetTeamEnabledInput & { readonly actor?: Plus.Actor }) => Promise<SetTeamEnabledResult>
  readonly setModelSettings: (input: Plus.SetModelSettingsInput & { readonly actor?: Plus.Actor }) => Promise<SetModelSettingsResult>
  readonly layoutWrite: (input: Plus.LayoutWriteInput & { readonly actor?: Plus.Actor }) => Promise<LayoutWriteResult>
  readonly addTeamAgent: (input: Plus.TeamAddAgentInput & { readonly actor?: Plus.Actor }) => Promise<AddTeamAgentResult>
  readonly removeTeamAgent: (input: Plus.TeamRemoveAgentInput & { readonly actor?: Plus.Actor }) => Promise<RemoveTeamAgentResult>
  readonly deleteTeam: (input: Plus.DeleteTeamInput & { readonly actor?: Plus.Actor }) => Promise<DeleteTeamResult>
  readonly renameTeam: (input: Plus.RenameTeamInput & { readonly actor?: Plus.Actor }) => Promise<RenameTeamResult>
  readonly listTeams: () => Promise<ListTeamsResult>
  readonly addModel: (input: Plus.ModelAddInput & { readonly actor?: Plus.Actor }) => Promise<AddModelResult>
  readonly removeModel: (input: Plus.ModelRemoveInput & { readonly actor?: Plus.Actor }) => Promise<RemoveModelResult>
  readonly pickModel: (input: Plus.ModelPickInput & { readonly actor?: Plus.Actor }) => Promise<PickModelResult>
  readonly addRule: (input: Plus.RuleAddInput & { readonly actor?: Plus.Actor }) => Promise<AddRuleResult>
  readonly removeRule: (input: Plus.RuleRemoveInput & { readonly actor?: Plus.Actor }) => Promise<RemoveRuleResult>
  readonly updateRule: (input: Plus.RuleUpdateInput & { readonly actor?: Plus.Actor }) => Promise<UpdateRuleResult>
  readonly createEntry: (input: Plus.EntryCreateInput) => Promise<CreateEntryResult>
  readonly deleteEntry: (input: Plus.EntryDeleteInput) => Promise<DeleteEntryResult>
  readonly renameEntry: (input: Plus.EntryRenameInput) => Promise<RenameEntryResult>
  readonly createPreset: (input: Plus.PresetCreateInput) => Promise<CreatePresetResult>
  readonly addPresetMember: (input: Plus.PresetAddMemberInput) => Promise<AddPresetMemberResult>
  readonly deletePreset: (input: Plus.PresetDeleteInput) => Promise<DeletePresetResult>
  readonly setLink: (input: Plus.LinkSetInput) => Promise<SetLinkResult>
}

export interface PlusApiOptions {
  /** Defaults-tier teams. None ship (the shipped teams are Plus team presets); tests inject fixtures. */
  readonly builtins?: readonly BuiltinTeam[]
}

// What a refresh costs: the input tokens of this chat's last request, which the
// next request re-reads whole when the rebuild invalidates the prefix. The
// Monitor's ledger holds the input token count per request.
async function chatRefreshCost(
  ctx: Context,
  sessionID: string | undefined,
): Promise<{ reReadTokens: number; withoutCache: boolean }> {
  if (sessionID === undefined || sessionID === "") return { reReadTokens: 0, withoutCache: false }
  const rows = ledgerAt().getRequests(sessionID)
  const last = rows.filter((row) => row.kind !== "generate" && row.kind !== "title").at(-1)
  if (last === undefined) return { reReadTokens: 0, withoutCache: false }
  // input is the prompt the model saw; cacheRead is the part it read from cache.
  const tokens = last.inputTokens + last.cacheReadTokens
  return { reReadTokens: tokens, withoutCache: last.cacheReadTokens > 0 }
}

export function createPlusApi(ctx: Context, state: PlusState, options?: PlusApiOptions): PlusApi {
  const builtins = options?.builtins ?? []
  // The readback from a record set: discovery, teams, output ids and the
  // server listing, then toSnapshot. Stores the result for the current
  // (revision, generation) key, so navigation reads it back without
  // rediscovering. `discovered` may be handed in when the caller already
  // published (which discovered).
  const snapshotOf = async (
    loaded: LoadedStores,
    directory: string,
    discovered?: Discovered,
  ): Promise<Plus.Snapshot> => {
    const found = discovered ?? (await discoverAll(ctx, loaded, state, builtins, directory))
    const teams = await snapshotTeams(directory, loaded.records, builtins)
    const outputIds = await snapshotOutputIds(directory, found, loaded, builtins, state.teamOutputIds)
    const value = toSnapshot(found, loaded, teams, outputIds, await serverListing(ctx, loaded.records))
    state.snapshotCache = {
      projectRevision: loaded.projectRevision,
      globalRevision: loaded.globalRevision,
      generation: state.snapshotGeneration,
      value,
    }
    return value
  }
  // T3: a tool actor may not change a protected agent's row through a mutate
  // either, no matter which level or row kind it addresses. Only changed rows
  // count: a caller that carries a protected agent's records back unchanged
  // (the normal full-snapshot mutate) is not refused, and a delta that leaves
  // a protected row identical is not either.
  const protectedRefusal = (
    actor: Plus.Actor | undefined,
    changed: readonly StoredRecord[],
    config: { readonly protectedAgents: readonly string[] },
  ) => {
    const protectedRow = changed.find(
      (record): record is Exclude<StoredRecord, TeamRecord | EntryRecord | PresetRecord | ModelSettingsRecord | FolderRecord | OrderRecord> =>
        record.type !== "team" &&
        record.type !== "entry" &&
        record.type !== "preset" &&
        record.type !== "modelSettings" &&
        record.type !== "folder" &&
        record.type !== "order" &&
        // A preset's rows are not an agent's, whatever its id.
        record.level !== "preset" &&
        record.agent !== null &&
        config.protectedAgents.includes(record.agent),
    )
    return refuseProtectedForTool(actor, protectedRow?.agent, config)
  }
  const invalidOf = (rows: readonly StoredRecord[]) =>
    rows.flatMap((record) => {
      if (
        record.type === "split" &&
        (record.item.startsWith("setting:") || record.item.startsWith("compaction:")) &&
        record.item !== "setting:description" &&
        record.item !== "compaction:instructions"
      )
        return [{ id: record.item, reason: "Agent controls do not support sections" }]
      if (record.type !== "customization") return []
      const reason = controlRecordError(record)
      return reason === undefined ? [] : [{ id: record.item, reason }]
    })[0]

  const mutateFull = async (input: typeof Plus.MutateInputFull.Type): Promise<MutateResult> => {
    const directory = await activationDirectory(ctx.location.directory)
    const config = await read(directory)
    const stored = await load(directory)
    const loaded = { ...stored, protectedAgents: config.protectedAgents }
    // Links, Defaults entries and presets are not snapshot rows yet either:
    // carried over like teams so a snapshot mutate cannot drop them.
    const records: StoredRecord[] = [
      ...input.records.map(toRecord),
      ...loaded.records.filter(
        (record) =>
          record.type === "team" ||
          record.type === "link" ||
          record.type === "entry" ||
          record.type === "preset" ||
          record.type === "modelSettings" ||
          record.type === "folder" ||
          record.type === "order" ||
          record.type === "rowlink",
      ),
    ]
    const refusal = protectedRefusal(input.actor, deltaRows(loaded.records, records), config)
    if (refusal !== undefined) return { ok: false as const, error: refusal }
    const invalid = invalidOf(records)
    if (invalid !== undefined) return { ok: false as const, error: { code: "agent.invalid" as const, message: invalid.reason, data: invalid } }
    const staleStore =
      input.expectedRevision !== loaded.projectRevision
        ? ("project" as const)
        : input.expectedGlobalRevision !== loaded.globalRevision
          ? ("global" as const)
          : undefined
    if (staleStore !== undefined)
      return {
        ok: true as const,
        value: { ok: false as const, reason: "stale" as const, store: staleStore, snapshot: await snapshotOf(loaded, directory) },
      }
    const saved = await save(directory, {
      expectedProjectRevision: loaded.projectRevision,
      expectedGlobalRevision: loaded.globalRevision,
      records,
    })
    if (!saved.ok) {
      const refreshed = { ...saved.current, protectedAgents: loaded.protectedAgents }
      return {
        ok: true as const,
        value: { ok: false as const, reason: "stale" as const, store: saved.store, snapshot: await snapshotOf(refreshed, directory) },
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
    // No reload from disk: build the next view from what save just wrote and
    // the revisions it returned, so a just-written store is not read again.
    const next = { ...loadedFromSave(saved, records), protectedAgents: loaded.protectedAgents }
    const discovered = await Effect.runPromise(publishFresh(ctx, state, next, builtins))
    const snapshot = await snapshotOf(next, directory, discovered)
    return { ok: true as const, value: { ok: true as const, revision: next.projectRevision, globalRevision: next.globalRevision, snapshot } }
  }

  const mutateDelta = async (input: typeof Plus.MutateInputDelta.Type): Promise<MutateResult> => {
    const directory = await activationDirectory(ctx.location.directory)
    const config = await read(directory)
    const upserts = input.changes.upsert.map(toRecord)
    const removals = new Set(input.changes.remove.map(keyIdentity))
    const added = new Set(upserts.map(recordIdentity))
    // Load, merge the delta onto the *current* records and save as one step
    // under the store's write gates. No expected revision: a delta lands on
    // whatever is current and the same row is last-writer-wins. Refusals are
    // decided on the rows this delta actually changes, computed against the
    // current store inside the gate, and return no records so nothing is
    // written.
    const seen: { before?: readonly StoredRecord[]; after?: readonly StoredRecord[] } = {}
    const outcome = await updateGated<DeltaDecision>(directory, async (loaded) => {
      const merged = [
        ...loaded.records.filter((record) => !removals.has(recordIdentity(record)) && !added.has(recordIdentity(record))),
        ...upserts,
      ]
      const changed = deltaRows(loaded.records, merged)
      const refusal = protectedRefusal(input.actor, changed, config)
      if (refusal !== undefined) return { result: { kind: "refusal" as const, error: refusal } }
      const invalid = invalidOf(upserts)
      if (invalid !== undefined)
        return { result: { kind: "invalid" as const, error: { code: "agent.invalid" as const, message: invalid.reason, data: invalid } } }
      seen.before = loaded.records
      seen.after = merged
      return { result: { kind: "ok" as const, records: merged }, records: merged }
    })
    const decision = outcome.result
    if (decision.kind === "refusal") return { ok: false as const, error: decision.error }
    if (decision.kind === "invalid") return { ok: false as const, error: decision.error }
    const saved = outcome.saved
    if (saved === undefined || !saved.ok)
      return { ok: false as const, error: { code: "agent.invalid" as const, message: "mutate delta: write did not complete", data: { id: "", reason: "write did not complete" } } }
    await logMutate({
      directory,
      actor: normalizeActor(input.actor),
      before: seen.before ?? [],
      after: seen.after ?? decision.records,
      projectRevision: saved.projectRevision,
      globalRevision: saved.globalRevision,
      projectChanged: saved.changed.project,
      globalChanged: saved.changed.global,
    })
    const next = { ...loadedFromSave(saved, decision.records), protectedAgents: config.protectedAgents }
    const discovered = await Effect.runPromise(publishFresh(ctx, state, next, builtins))
    const snapshot = input.snapshot === true ? await snapshotOf(next, directory, discovered) : undefined
    return {
      ok: true as const,
      value: {
        ok: true as const,
        revision: next.projectRevision,
        globalRevision: next.globalRevision,
        ...(snapshot === undefined ? {} : { snapshot }),
      },
    }
  }

  return {
    snapshot: async () => {
      const directory = await activationDirectory(ctx.location.directory)
      const config = await read(directory)
      const stored = await loadMigrated(directory)
      const loaded = { ...stored, protectedAgents: config.protectedAgents }
      const cached = state.snapshotCache
      if (
        cached !== undefined &&
        cached.projectRevision === loaded.projectRevision &&
        cached.globalRevision === loaded.globalRevision &&
        cached.generation === state.snapshotGeneration
      )
        return { ok: true as const, value: cached.value }
      return { ok: true as const, value: await snapshotOf(loaded, directory) }
    },
    refresh: async () => {
      const directory = await activationDirectory(ctx.location.directory)
      const config = await read(directory)
      const stored = await loadMigrated(directory)
      const loaded = { ...stored, protectedAgents: config.protectedAgents }
      const discovered = await Effect.runPromise(publishFresh(ctx, state, loaded, builtins))
      return { ok: true as const, value: await snapshotOf(loaded, directory, discovered) }
    },
    chatRefresh: async (input) => {
      // Rebuild this folder from its current settings and files: the host
      // reloads (config, agents, providers, models, commands, skills, MCP),
      // then Plus republishes what this chat sends, and applies any pending
      // Instructions change. This is the escape hatch: it may rebuild a cached
      // prefix, so the caller is told the cost first.
      const directory = await activationDirectory(ctx.location.directory)
      if (input.dryRun === true) {
        const cost = await chatRefreshCost(ctx, input.sessionID)
        const stored = await loadMigrated(directory)
        return {
          ok: true as const,
          value: {
            reloaded: [],
            reReadTokens: cost.reReadTokens,
            withoutCache: cost.withoutCache,
            revision: stored.projectRevision,
            globalRevision: stored.globalRevision,
          },
        }
      }
      // Config first, forced: the domain reloads below re-read their entries,
      // and a forced config publish makes every config-backed plugin rescan
      // its files, so a new skill file or edited project opencode.json
      // applies here instead of through a per-folder file watcher. Each is
      // independent: one failing domain must not skip the others.
      const reloads: readonly [string, Effect.Effect<void>][] = [
        ["config", ctx.config.reload({ force: true })],
        ["instruction", ctx.instruction.reload()],
        ["agents", ctx.agent.reload()],
        ["providers", ctx.provider.reload()],
        ["models", ctx.model.reload()],
        ["commands", ctx.command.reload()],
        ["skills", ctx.skill.reload()],
        ["mcp", ctx.mcp.reload()],
      ]
      const reloaded: string[] = []
      for (const [name, reload] of reloads) {
        const exit = await Effect.runPromiseExit(reload)
        if (exit._tag === "Success") reloaded.push(name)
        else Effect.runSync(Effect.logWarning("plus chat refresh reload failed", { domain: name }))
      }
      await Effect.runPromise(refreshFromHost(ctx, state))
      // The chat's next request pins what was just published. Stored, so it holds
      // when the config reload above re-activates Plus.
      if (input.sessionID !== undefined) await Effect.runPromise(state.sessionPins.markRebuild(input.sessionID))
      const fresh = await loadMigrated(directory)
      const cost = await chatRefreshCost(ctx, input.sessionID)
      return {
        ok: true as const,
        value: {
          reloaded,
          reReadTokens: cost.reReadTokens,
          withoutCache: cost.withoutCache,
          revision: fresh.projectRevision,
          globalRevision: fresh.globalRevision,
        },
      }
    },
    mutate: async (input) => {
      if ("changes" in input) return mutateDelta(input)
      return mutateFull(input)
    },
    log: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const merged = await readBoth(directory, { ...(input.where === undefined ? {} : { where: input.where }) })
      const offset = input.offset === undefined || Number.isNaN(input.offset) ? 0 : Math.max(0, Math.floor(input.offset))
      const limit = input.limit === undefined || Number.isNaN(input.limit) ? undefined : Math.max(0, Math.floor(input.limit))
      const total = merged.length
      const entries = limit === undefined ? merged.slice(offset) : merged.slice(offset, offset + limit)
      return { ok: true as const, value: { entries: [...entries], total } }
    },
    assembled: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const config = await read(directory)
      const stored = await load(directory)
      const loaded = { ...stored, protectedAgents: config.protectedAgents }
      const discovered = await discoverAll(ctx, loaded, state, builtins, directory)
      // The agents and context a publish applies: a team member (and an
      // enabled team's Special agent) resolves with its team, as apply ran it.
      const chain = await publishChain(discovered, loaded.records, directory, builtins, state.teamOutputIds)
      const result = await assembled({
        ctx,
        agent: input.agent,
        items: discovered.items,
        agents: applyAgentsOf(chain.publishAgents),
        records: customizationsOf(loaded.records),
        splits: splitsOf(loaded.records),
        scopes: chain.publishScopes,
        installedTools: state.installedTools,
        orders: loaded.records.filter((record): record is OrderRecord => record.type === "order"),
      })
      if ("ok" in result)
        return {
          ok: false as const,
          error: { code: "agent.unknown" as const, message: `Unknown agent ${input.agent}`, data: { agent: input.agent } },
        }
      return { ok: true as const, value: result }
    },
    createAgent: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const config = await read(directory)
      const validated = validateAgentId(input.id)
      if (!validated.ok)
        return {
          ok: false as const,
          error: { code: "agent.invalid" as const, message: validated.reason, data: { id: input.id, reason: validated.reason } },
        }
      const refusal = refuseProtectedForTool(input.actor, validated.id, config)
      if (refusal !== undefined) return { ok: false as const, error: refusal }
      // DESIGN §5: the preset's mode and description (core reads them from
      // the file), an empty body, and a link that makes everything else
      // follow the preset. No preset: an empty file and no link (off).
      const preset = input.preset === undefined ? undefined : await agentPresetEntry(ctx, directory, input.preset)
      if (input.preset !== undefined && preset === undefined) return { ok: false as const, error: unknownPreset(input.preset) }
      const created = await create({
        scope: input.scope,
        projectDirectory: directory,
        id: validated.id,
        fields: presetFields(preset ?? {}),
        prompt: "",
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
      // A link left behind by a deleted agent of the same id is replaced (or,
      // with no preset, dropped) so the new agent starts where it was asked to.
      await setOwnerLink(directory, { level: input.scope, agent: validated.id }, input.preset ?? null)
      await Effect.runPromise(ctx.agent.reload())
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins, true))
      await logFileOp({
        directory,
        actor: normalizeActor(input.actor),
        scope: input.scope,
        op: "agent.create",
        target: created.path,
        summary: `agent.create ${validated.id} (${input.scope})${input.preset === undefined ? "" : ` from ${presetKey(input.preset)}`}`,
      })
      return { ok: true as const, value: { id: validated.id, path: created.path } }
    },
    renameAgent: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const config = await read(directory)
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
      const fromRefusal = refuseProtectedForTool(input.actor, from.id, config)
      if (fromRefusal !== undefined) return { ok: false as const, error: fromRefusal }
      const toRefusal = refuseProtectedForTool(input.actor, to.id, config)
      if (toRefusal !== undefined) return { ok: false as const, error: toRefusal }
      // T6: a team in the id makes the row an on-disk team member; its file
      // lives in the team directory and its records are team-scoped.
      if (input.team !== undefined)
        return renameTeamMember(ctx, state, builtins, directory, config, {
          scope: input.scope,
          team: input.team,
          from: from.id,
          to: to.id,
          ...(input.actor === undefined ? {} : { actor: input.actor }),
        })
      const discovered = await discoverAll(ctx, await loadCurrent(directory), state, builtins, directory)
      const scoped = discovered.agents.find((agent) => agent.id === from.id && agent.scope === input.scope && agent.team === undefined)
      // Built-ins (OpenCode/Special/Plus) ship no file; a Defaults row served
      // at this level is one of them. Rename addresses files only.
      const hostBuiltin = scoped === undefined && discovered.agents.some((agent) => agent.id === from.id && agent.team === undefined && agent.path === undefined)
      if ((scoped !== undefined && scoped.path === undefined) || hostBuiltin)
        return {
          ok: false as const,
          error: {
            code: "agent.invalid" as const,
            message: `Agent ${from.id} is built in and cannot be renamed`,
            data: { id: from.id, reason: `Agent ${from.id} is built in and cannot be renamed` },
          },
        }
      if (scoped?.ancestor === true)
        return {
          ok: false as const,
          error: {
            code: "agent.invalid" as const,
            message: `Agent ${from.id} is inherited from an ancestor directory and cannot be renamed`,
            data: { id: from.id, reason: `Agent ${from.id} is inherited from an ancestor directory and cannot be renamed` },
          },
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
      // The agent's link and its own records (row edits, splits, models,
      // rules) move with its file; anything a deleted agent of the new id left
      // behind gives way. A member of the same id (team-scoped) and the agent
      // at another level are not this agent's and stay.
      const source = { level: input.scope, agent: from.id }
      const target = { level: input.scope, agent: to.id }
      const moved = await updateRecords(directory, (current) =>
        current.flatMap((record): StoredRecord[] => {
          if (record.type === "team" || record.type === "entry" || record.type === "preset" || record.type === "modelSettings" || record.type === "folder" || record.type === "order")
            return [record]
          if (scopedTo(record, target)) return []
          return [scopedTo(record, source) ? { ...record, agent: to.id } : record]
        }),
      )
      if (!moved.ok) {
        await rename({ scope: input.scope, projectDirectory: directory, from: to.id, to: from.id })
        const reason = "the store changed concurrently; retry"
        return { ok: false as const, error: { code: "agent.invalid" as const, message: `Could not rename ${from.id}: ${reason}`, data: { id: input.from, reason } } }
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
      const directory = await activationDirectory(ctx.location.directory)
      const config = await read(directory)
      const validated = validateAgentId(input.id)
      if (!validated.ok)
        return {
          ok: false as const,
          error: { code: "agent.invalid" as const, message: validated.reason, data: { id: input.id, reason: validated.reason } },
        }
      const refusal = refuseProtectedForTool(input.actor, validated.id, config)
      if (refusal !== undefined) return { ok: false as const, error: refusal }
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
      const stored = await load(directory)
      const loaded = { ...stored, protectedAgents: config.protectedAgents }
      await removeAgentRecords(directory, loaded, validated.id, input.scope)
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
      const directory = await activationDirectory(ctx.location.directory)
      const scope = input.scope ?? "project"
      const target = skillTargetOf(directory, input)
      if (!target.ok)
        return { ok: false as const, error: { code: "skill.invalid" as const, message: target.message, data: { id: input.name, reason: target.message } } }
      const result = await createSkill({ ...target.target, name: input.name, body: input.body })
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
      await logFileOp({ directory, actor: normalizeActor(input.actor), scope: scope === "project" ? "project" : "global", op: "skill.create", target: result.path, summary: `skill.create ${result.id} (${scope})` })
      return { ok: true as const, value: { id: result.id, path: result.path, scope } }
    },
    importSkill: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const scope = input.scope ?? "project"
      const target = skillTargetOf(directory, input)
      if (!target.ok)
        return { ok: false as const, error: { code: "skill.invalid" as const, message: target.message, data: { id: input.path, reason: target.message } } }
      const result = await importSkill({ ...target.target, path: input.path })
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
      await logFileOp({ directory, actor: normalizeActor(input.actor), scope: scope === "project" ? "project" : "global", op: "skill.import", target: result.path, summary: `skill.import ${result.id} (${scope})` })
      return { ok: true as const, value: { id: result.id, path: result.path, scope } }
    },
    deleteSkill: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const scope = input.scope ?? "project"
      const config = await read(directory)
      const target = skillTargetOf(directory, input)
      if (!target.ok)
        return { ok: false as const, error: { code: "skill.invalid" as const, message: target.message, data: { id: input.id, reason: target.message } } }
      // The cascade below drops every customization/split at skill:<id>, not
      // only rows the deleted skill owned, and deleting the file is a write;
      // refuse a tool actor before either. The delete helper trims ids, so the
      // cascade address uses the same trimmed form.
      const stored = await load(directory)
      const refusal = refuseProtectedItemCascade(input.actor, stored.records, `skill:${input.id.trim()}`, config)
      if (refusal !== undefined) return { ok: false as const, error: refusal }
      const result = await deleteSkill({ ...target.target, id: input.id })
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
      const freshStored = await load(directory)
      const freshLoaded = { ...freshStored, protectedAgents: config.protectedAgents }
      await removeItemRecords(directory, freshLoaded, `skill:${result.id}`)
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory))
      await logFileOp({ directory, actor: normalizeActor(input.actor), scope: scope === "project" ? "project" : "global", op: "skill.delete", target: result.path, summary: `skill.delete ${result.id} (${scope})` })
      return { ok: true as const, value: { id: result.id, path: result.path, scope } }
    },
    createBase: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
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
      const directory = await activationDirectory(ctx.location.directory)
      const config = await read(directory)
      // Same cascade guard as skill.delete: refuse a tool actor before the
      // template file is removed when a protected agent holds base:<id>.
      const stored = await load(directory)
      const refusal = refuseProtectedItemCascade(input.actor, stored.records, `base:${input.id.trim()}`, config)
      if (refusal !== undefined) return { ok: false as const, error: refusal }
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
      const freshStored = await load(directory)
      const freshLoaded = { ...freshStored, protectedAgents: config.protectedAgents }
      await removeItemRecords(directory, freshLoaded, `base:${result.id}`)
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
    createSystem: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const result = await createSystemRow(input.id, input.title, input.text, input.models)
      if (!result.ok && result.reason === "exists")
        return {
          ok: false as const,
          error: { code: "system.exists" as const, message: `System row ${result.id} already exists`, data: { id: result.id } },
        }
      if (!result.ok)
        return {
          ok: false as const,
          error: { code: "system.invalid" as const, message: result.message, data: { id: result.id, reason: result.message } },
        }
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory))
      await logFileOp({
        directory,
        actor: normalizeActor(input.actor),
        scope: "global",
        op: "system.create",
        target: userSystemFile(result.id),
        summary: `system.create ${result.id}`,
      })
      return { ok: true as const, value: { id: result.id } }
    },
    deleteSystem: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const config = await read(directory)
      // Same cascade guard as base.delete: refuse a tool actor before the file
      // is removed when a protected agent holds system:<id>.
      const stored = await load(directory)
      const refusal = refuseProtectedItemCascade(input.actor, stored.records, `system:${input.id.trim()}`, config)
      if (refusal !== undefined) return { ok: false as const, error: refusal }
      const result = await deleteSystemRow(input.id)
      if (!result.ok && result.reason === "missing")
        return {
          ok: false as const,
          error: { code: "system.missing" as const, message: `System row ${result.id} does not exist`, data: { id: result.id } },
        }
      if (!result.ok)
        return {
          ok: false as const,
          error: { code: "system.invalid" as const, message: result.message, data: { id: result.id, reason: result.message } },
        }
      const freshStored = await load(directory)
      const freshLoaded = { ...freshStored, protectedAgents: config.protectedAgents }
      await removeItemRecords(directory, freshLoaded, `system:${result.id}`)
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory))
      await logFileOp({
        directory,
        actor: normalizeActor(input.actor),
        scope: "global",
        op: "system.delete",
        target: userSystemFile(result.id),
        summary: `system.delete ${result.id}`,
      })
      return { ok: true as const, value: { id: result.id } }
    },
    setSystemModels: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const result = await setModelPromptModels(input.id, input.models)
      if (!result.ok && result.reason === "missing")
        return {
          ok: false as const,
          error: { code: "system.missing" as const, message: `Model prompt ${result.id} does not exist`, data: { id: result.id } },
        }
      if (!result.ok)
        return {
          ok: false as const,
          error: { code: "system.invalid" as const, message: result.message, data: { id: result.id, reason: result.message } },
        }
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory))
      await logFileOp({
        directory,
        actor: normalizeActor(input.actor),
        scope: "global",
        op: "system.models",
        target: userSystemFile(result.id),
        summary: `system.models ${result.id} ${input.models.join(" ")}`,
      })
      return { ok: true as const, value: { id: result.id } }
    },
    createInstruction: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      // OpenCodePlus: creating AGENTS.md files is off pending the Context
      // catalogue. The handler body below is kept for the rework.
      if (INSTRUCTIONS_DISABLED)
        return { ok: false as const, error: { code: "instruction.invalid" as const, message: INSTRUCTION_DISABLED, data: { name: input.name, reason: INSTRUCTION_DISABLED } } }
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
      const directory = await activationDirectory(ctx.location.directory)
      // OpenCodePlus: deleting AGENTS.md files is off pending the Context catalogue.
      if (INSTRUCTIONS_DISABLED)
        return { ok: false as const, error: { code: "instruction.invalid" as const, message: INSTRUCTION_DISABLED, data: { name: input.name, reason: INSTRUCTION_DISABLED } } }
      const config = await read(directory)
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
      const freshStored = await load(directory)
      const freshLoaded = { ...freshStored, protectedAgents: config.protectedAgents }
      await removeItemRecords(directory, freshLoaded, result.id)
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
      const directory = await activationDirectory(ctx.location.directory)
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
      const directory = await activationDirectory(ctx.location.directory)
      const config = await read(directory)
      // Same cascade guard as skill.delete: refuse a tool actor before the
      // server leaves the project config when a protected agent holds mcp:<name>.
      const stored = await load(directory)
      const refusal = refuseProtectedItemCascade(input.actor, stored.records, `mcp:${input.name.trim()}`, config)
      if (refusal !== undefined) return { ok: false as const, error: refusal }
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
      const freshStored = await load(directory)
      const freshLoaded = { ...freshStored, protectedAgents: config.protectedAgents }
      await removeItemRecords(directory, freshLoaded, `mcp:${result.name}`)
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory))
      const removedConfig = await mcpConfigTarget(directory)
      await logFileOp({ directory, actor: normalizeActor(input.actor), scope: "project", op: "mcp.remove", target: removedConfig, summary: `mcp.remove ${result.name}` })
      return { ok: true as const, value: { name: result.name } }
    },
    createTeam: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const config = await read(directory)
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
      // `preset` names a team preset, Plus or User (DESIGN §5): the team is
      // created with the preset's members, each linked to its member preset,
      // and records its own link to the team preset.
      const templateName = input.preset === undefined || input.preset === "" ? undefined : input.preset
      const presetRecords = presetStateOf((await load(directory)).records).presets
      const template = templateName === undefined ? undefined : teamPresetMembers(templateName, presetRecords)
      if (templateName !== undefined && template === undefined) {
        const reason = `Unknown team preset ${templateName}`
        return {
          ok: false as const,
          error: { code: "team.invalid" as const, message: reason, data: { team: validated.team, reason } },
        }
      }
      // Creating from a preset writes every member file, so a tool actor may
      // not create a protected member in a new team.
      const protectedMember = template?.find((member) => config.protectedAgents.includes(member.id))
      const refusal = refuseProtectedForTool(input.actor, protectedMember?.id, config)
      if (refusal !== undefined) return { ok: false as const, error: refusal }
      // Validate every preset member before anything is created: a refused
      // create must leave no team directory (and no `.opencodeplus`) behind.
      const planned = (template ?? []).map((member) => {
        if (member.id === "special") return { ok: false as const, code: "team.invalid" as const, reason: 'Member id "special" is reserved' }
        const memberId = validateAgentId(member.id)
        if (!memberId.ok) return { ok: false as const, code: "team.create" as const, reason: memberId.reason }
        return {
          ok: true as const,
          id: memberId.id,
          ...(member.mode === undefined ? {} : { mode: member.mode }),
          ...(member.description === undefined ? {} : { description: member.description }),
        }
      })
      const refusedMember = planned.find((member) => !member.ok)
      if (refusedMember !== undefined && !refusedMember.ok)
        return {
          ok: false as const,
          error:
            refusedMember.code === "team.invalid"
              ? { code: "team.invalid" as const, message: refusedMember.reason, data: { team: validated.team, reason: refusedMember.reason } }
              : { code: "team.create" as const, message: `Could not create team ${validated.team}: ${refusedMember.reason}`, data: { level: input.level, team: validated.team, reason: refusedMember.reason } },
        }
      const members = planned.flatMap((member) => (member.ok ? [member] : []))
      const root = input.level === "project" ? projectTeamsPath(directory) : globalTeamsPath()
      const teamDir = path.join(root, validated.team)
      // A duplicate team is refused before any directory exists...
      const exists = (target: string): Promise<boolean> => fs.stat(target).then(() => true, () => false)
      if (await exists(teamDir))
        return {
          ok: false as const,
          error: { code: "team.exists" as const, message: `Team ${validated.team} already exists`, data: { level: input.level, team: validated.team } },
        }
      // ...and a failed mkdir removes the parent chain it just created.
      const plusExisted = await exists(path.dirname(root))
      const rootExisted = await exists(root)
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
      const made = await fs.mkdir(teamDir).then(
        () => ({ ok: true as const }),
        (error: unknown) => ({ ok: false as const, error }),
      )
      if (!made.ok) {
        const code = typeof made.error === "object" && made.error !== null && "code" in made.error ? made.error.code : undefined
        if (code !== "EEXIST") {
          if (!rootExisted) await fs.rmdir(root).catch(() => undefined)
          if (!plusExisted) await fs.rmdir(path.dirname(root)).catch(() => undefined)
        }
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
      // A project-level team directory is a project-scoped write, so
      // `.opencodeplus` is created on demand; a global team writes globally.
      // The config lands only once the team directory exists, so a refused
      // create above leaves nothing behind.
      if (input.level === "project") await ensure(directory)
      if (template !== undefined && templateName !== undefined) {
        for (const member of members) {
          const target = path.join(teamDir, `${member.id}.md`)
          // Core reads mode and description from the file; the body stays
          // empty so the role text, like everything else, follows the link.
          const content = formatMarkdown(presetFields(member), "")
          const seeded = await fs.mkdir(path.dirname(target), { recursive: true }).then(
            () => fs.writeFile(target, content).then(
              () => ({ ok: true as const }),
              (error: unknown) => ({ ok: false as const, error }),
            ),
            (error: unknown) => ({ ok: false as const, error }),
          )
          if (!seeded.ok) {
            const reason = messageOf(seeded.error)
            return {
              ok: false as const,
              error: { code: "team.create" as const, message: `Could not create team ${validated.team}: ${reason}`, data: { level: input.level, team: validated.team, reason } },
            }
          }
        }
        const owner = { level: input.level, team: validated.team }
        const updated = new Date().toISOString()
        const linked = await saveLinks(directory, [
          { type: "link", level: input.level, agent: null, team: owner, preset: { kind: "team", id: templateName }, updated },
          ...members.map(
            (member): LinkRecord => ({
              type: "link",
              level: input.level,
              agent: member.id,
              team: owner,
              preset: { kind: "member", team: templateName, id: member.id },
              updated,
            }),
          ),
        ])
        if (!linked.ok) {
          const reason = "the store changed concurrently while linking the members; retry"
          return {
            ok: false as const,
            error: { code: "team.create" as const, message: `Could not create team ${validated.team}: ${reason}`, data: { level: input.level, team: validated.team, reason } },
          }
        }
      }
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins))
      await Effect.runPromise(emitTeamsChanged(state))
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
      const directory = await activationDirectory(ctx.location.directory)
      const config = await read(directory)
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
        await appendForLevel(directory, input.level, {
          ts: new Date().toISOString(),
          actor: normalizeActor(input.actor),
          op: "team.setEnabled",
          target: `team:${input.level}:${validated.team}`,
          summary: `team.setEnabled ${validated.team} ${input.enabled ? "enabled" : "disabled"} (${input.level})`,
          revision: saved.revision,
        })
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins))
      await Effect.runPromise(emitTeamsChanged(state))
      return { ok: true as const, value: { level: input.level, team: validated.team, enabled: input.enabled, exclusive: true as const, disabledTeams: saved.disabledTeams } }
    },
    setModelSettings: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const providerID = input.providerID?.trim()
      const modelID = input.modelID?.trim()
      if ((providerID === undefined) !== (modelID === undefined))
        return invalidModelSettings("providerID and modelID go together; omit both for the Every model row")
      const key = { ...(providerID === undefined ? {} : { providerID }), ...(modelID === undefined ? {} : { modelID }) }
      const parsed = warmingFieldsOf({
        ...(input.warming === undefined || input.warming === null ? {} : { warming: input.warming }),
        ...(input.interval === undefined || input.interval === null ? {} : { interval: input.interval }),
        ...(input.waiting === undefined || input.waiting === null ? {} : { waiting: input.waiting }),
        ...(input.subagent === undefined || input.subagent === null ? {} : { subagent: input.subagent }),
        ...(input.prompt === undefined || input.prompt === null ? {} : { prompt: input.prompt }),
      })
      if ("error" in parsed) return invalidModelSettings(parsed.error)
      const compact = compactionFieldsOf({
        ...(input.compactWarm === undefined ? {} : { compactWarm: input.compactWarm }),
        ...(input.coldFirst === undefined ? {} : { coldFirst: input.coldFirst }),
        ...(input.coldCompact === undefined ? {} : { coldCompact: input.coldCompact }),
        ...(input.coldModels === undefined ? {} : { coldModels: input.coldModels }),
        ...(input.compactionStrategy === undefined ? {} : { compactionStrategy: input.compactionStrategy }),
        ...(input.compactionModel === undefined ? {} : { compactionModel: input.compactionModel }),
        ...(input.compactionInstructions === undefined ? {} : { compactionInstructions: input.compactionInstructions }),
        ...(input.imageConvert === undefined ? {} : { imageConvert: input.imageConvert }),
        ...(input.imageShrink === undefined ? {} : { imageShrink: input.imageShrink }),
        ...(input.imagesFull === undefined ? {} : { imagesFull: input.imagesFull }),
        ...(input.compactionInput === undefined ? {} : { compactionInput: input.compactionInput }),
        ...(input.compactionOutput === undefined ? {} : { compactionOutput: input.compactionOutput }),
      })
      if ("error" in compact) return invalidModelSettings(compact.error)
      const cleared = (value: string | null | undefined, field: "warming" | "interval" | "waiting" | "subagent" | "prompt") =>
        value === undefined ? undefined : value === null ? null : (parsed.fields[field] ?? null)
      const fields = {
        warming: cleared(input.warming, "warming"),
        interval: cleared(input.interval, "interval"),
        waiting: cleared(input.waiting, "waiting"),
        subagent: cleared(input.subagent, "subagent"),
        prompt: cleared(input.prompt, "prompt"),
        ...(input.effort === undefined
          ? {}
          : { effort: input.effort === null || input.effort.trim().length === 0 ? null : input.effort.trim() }),
        ...compact.fields,
      }
      const updated = new Date().toISOString()
      // A warming time rounds up to whole intervals against opencode.json too.
      const host =
        key.providerID === undefined
          ? undefined
          : (await hostModelsFor(ctx, state)).find((entry) => entry.providerID === key.providerID && entry.modelID === key.modelID)?.warming
      const write = async () => {
        const current = await load(directory)
        const before = settingsFor(modelSettingsOf(current.records), key)
        const merged = setModelSettingsRecord(modelSettingsOf(current.records), key, fields, updated)
        const rounded = roundedWarmingFor(merged, key, host)
        const subagent = roundedWarmingFor(merged, key, host, "subagent")
        const next =
          rounded === undefined && subagent === undefined
            ? merged
            : setModelSettingsRecord(
                merged,
                key,
                { ...(rounded === undefined ? {} : { warming: rounded }), ...(subagent === undefined ? {} : { subagent }) },
                updated,
              )
        const record = settingsFor(next, key)
        const saved = await save(directory, {
          expectedProjectRevision: current.projectRevision,
          expectedGlobalRevision: current.globalRevision,
          records: [...current.records.filter((entry) => entry.type !== "modelSettings"), ...next],
        })
        if (!saved.ok) return { ok: false as const }
        return { ok: true as const, changed: saved.changed.global, before, record, revision: saved.projectRevision, globalRevision: saved.globalRevision }
      }
      let saved = await write()
      if (!saved.ok) saved = await write()
      if (!saved.ok) return invalidModelSettings("the store changed concurrently; retry")
      const label = key.providerID === undefined ? "Every model" : `${key.providerID}/${key.modelID}`
      if (saved.changed) {
        const described = MODEL_DEFAULT_FIELDS.flatMap((field) => {
          const value = saved.record?.[field]
          if (JSON.stringify(saved.before?.[field]) === JSON.stringify(value)) return []
          return [`${field} ${value === undefined ? "cleared" : typeof value === "string" ? value : JSON.stringify(value)}`]
        }).join(", ")
        await append(globalLogPath(), {
          ts: updated,
          actor: normalizeActor(input.actor),
          op: "modelSettings.set",
          target: key.providerID === undefined ? "modeldefault:every" : `modeldefault:${key.providerID}/${key.modelID}`,
          summary: `modelSettings.${saved.record === undefined ? "clear" : "set"} ${label} (${described})`,
          revision: saved.globalRevision,
        })
      }
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins))
      return { ok: true as const, value: { record: saved.record ?? null, revision: saved.revision, globalRevision: saved.globalRevision } }
    },
    layoutWrite: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const actor = normalizeActor(input.actor)
      const updated = new Date().toISOString()
      const current = await load(directory)
      if (current.globalRevision !== input.expectedGlobalRevision || current.projectRevision !== input.expectedProjectRevision)
        return invalidLayout("the folders changed since they were read; read them again and retry")
      const refusal = layoutRefusal(input.folders, input.orders)
      if (refusal !== undefined) return invalidLayout(refusal)
      const currentFolders = current.records.filter((record): record is FolderRecord => record.type === "folder")
      const currentOrders = current.records.filter((record): record is OrderRecord => record.type === "order")
      const folders = input.folders.map((folder) => stamped(folder, currentFolders.find((record) => record.id === folder.id), updated))
      const orders = input.orders.map((order) => stamped(order, currentOrders.find((record) => record.scope === order.scope), updated))
      const config = await read(directory)
      const upserts = input.changes?.upsert.map(toRecord) ?? []
      const removed = new Set(input.changes?.remove.map(keyIdentity) ?? [])
      const replaced = new Set(upserts.map(recordIdentity))
      const records = [
        ...current.records.filter((record) => record.type !== "folder" && record.type !== "order" && !removed.has(recordIdentity(record)) && !replaced.has(recordIdentity(record))),
        ...upserts, ...folders, ...orders,
      ]
      const protectedChange = protectedRefusal(input.actor, deltaRows(current.records, records), config)
      if (protectedChange !== undefined) return invalidLayout(protectedChange.message)
      const invalid = invalidOf(upserts)
      if (invalid !== undefined) return invalidLayout(invalid.reason)
      const saved = await save(directory, {
        expectedProjectRevision: current.projectRevision,
        expectedGlobalRevision: current.globalRevision,
        records,
      })
      if (!saved.ok) return invalidLayout("the store changed concurrently; retry")
      for (const level of ["project", "global"] as const) {
        if (!saved.changed[level]) continue
        await appendForLevel(directory, level, {
          ts: updated,
          actor,
          op: "layout",
          target: input.target,
          summary: input.status,
          revision: level === "project" ? saved.projectRevision : saved.globalRevision,
        })
      }
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins))
      return {
        ok: true as const,
        value: {
          changed: saved.changed.global || saved.changed.project,
          revision: saved.projectRevision,
          globalRevision: saved.globalRevision,
          status: input.status,
        },
      }
    },
    addTeamAgent: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const config = await read(directory)
      const validatedTeam = validateTeamName(input.team)
      if (!validatedTeam.ok)
        return {
          ok: false as const,
          error: { code: "team.invalid" as const, message: validatedTeam.reason, data: { team: input.team, reason: validatedTeam.reason } },
        }
      // DESIGN §4: a Defaults team takes member ENTRIES, named by patterns.
      if (input.level === "defaults") {
        const made = await createEntryRecord(ctx, state, directory, builtins, {
          catalogue: "teams",
          team: validatedTeam.team,
          name: input.id,
          ...(input.preset === undefined ? {} : { preset: input.preset }),
          ...(input.actor === undefined ? {} : { actor: input.actor }),
        })
        if (!made.ok) return made
        await Effect.runPromise(emitTeamsChanged(state))
        return { ok: true as const, value: { id: made.value.name ?? input.id, path: made.value.id } }
      }
      const validated = validateAgentId(input.id)
      if (!validated.ok)
        return {
          ok: false as const,
          error: { code: "agent.invalid" as const, message: validated.reason, data: { id: input.id, reason: validated.reason } },
        }
      const refusal = refuseProtectedForTool(input.actor, validated.id, config)
      if (refusal !== undefined) return { ok: false as const, error: refusal }
      if (input.id === "special")
        return {
          ok: false as const,
          error: {
            code: "team.invalid" as const,
            message: 'Member id "special" is reserved',
            data: { level: input.level, team: validatedTeam.team, reason: 'Member id "special" is reserved' },
          },
        }
      const known = await discoverTeams(input.level, directory, builtins)
      const found = known.find((team) => team.team === validatedTeam.team)
      if (found === undefined)
        return {
          ok: false as const,
          error: { code: "team.unknown" as const, message: `Unknown team ${validatedTeam.team}`, data: { level: input.level, team: validatedTeam.team } },
        }
      const teamDir =
        input.level === "project"
          ? path.join(projectTeamsPath(directory), validatedTeam.team)
          : path.join(globalTeamsPath(), validatedTeam.team)
      const target = teamMemberPath(teamDir, validated.id)
      if (target === undefined)
        return {
          ok: false as const,
          error: { code: "agent.invalid" as const, message: `Invalid agent id "${input.id}"`, data: { id: input.id, reason: `Invalid agent id "${input.id}"` } },
        }
      const existing = found.agents.find((agent) => agent.id === validated.id)
      if (existing !== undefined)
        return {
          ok: false as const,
          error: {
            code: "agent.exists" as const,
            message: `Agent ${validated.id} already exists at ${existing.path ?? target}`,
            data: { path: existing.path ?? target },
          },
        }
      if (await Bun.file(target).exists())
        return {
          ok: false as const,
          error: { code: "agent.exists" as const, message: `Agent ${validated.id} already exists at ${target}`, data: { path: target } },
        }
      // The member file carries its preset's mode and description with an
      // empty body; a team-scoped link makes the rest follow the preset.
      const preset = input.preset === undefined ? undefined : await agentPresetEntry(ctx, directory, input.preset)
      if (input.preset !== undefined && preset === undefined) return { ok: false as const, error: unknownPreset(input.preset) }
      await fs.mkdir(path.dirname(target), { recursive: true })
      await fs.writeFile(target, formatMarkdown(presetFields(preset ?? {}), ""))
      // The config lands only once the member file exists, so a failed write
      // above leaves nothing behind.
      if (input.level === "project") await ensure(directory)
      await setOwnerLink(
        directory,
        { level: input.level, agent: validated.id, team: { level: input.level, team: validatedTeam.team } },
        input.preset ?? null,
      )
      await Effect.runPromise(ctx.agent.reload())
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins, true))
      await Effect.runPromise(emitTeamsChanged(state))
      await logFileOp({
        directory,
        actor: normalizeActor(input.actor),
        scope: input.level === "project" ? "project" : "global",
        op: "team.addAgent",
        target,
        summary: `team.addAgent ${validated.id} to ${validatedTeam.team} (${input.level})${input.preset === undefined ? "" : ` from ${presetKey(input.preset)}`}`,
      })
      return { ok: true as const, value: { id: validated.id, path: target } }
    },
    removeTeamAgent: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const config = await read(directory)
      const validatedTeam = validateTeamName(input.team)
      if (!validatedTeam.ok)
        return {
          ok: false as const,
          error: { code: "team.invalid" as const, message: validatedTeam.reason, data: { team: input.team, reason: validatedTeam.reason } },
        }
      const validated = validateAgentId(input.id)
      if (!validated.ok)
        return {
          ok: false as const,
          error: { code: "agent.invalid" as const, message: validated.reason, data: { id: input.id, reason: validated.reason } },
        }
      const refusal = refuseProtectedForTool(input.actor, validated.id, config)
      if (refusal !== undefined) return { ok: false as const, error: refusal }
      const known = await discoverTeams(input.level, directory, builtins)
      const found = known.find((team) => team.team === validatedTeam.team)
      if (found === undefined)
        return {
          ok: false as const,
          error: { code: "team.unknown" as const, message: `Unknown team ${validatedTeam.team}`, data: { level: input.level, team: validatedTeam.team } },
        }
      const existing = found.agents.find((agent) => agent.id === validated.id)
      if (existing === undefined)
        return {
          ok: false as const,
          error: { code: "agent.invalid" as const, message: `Agent "${validated.id}" not found in team "${validatedTeam.team}"`, data: { id: input.id, reason: `Agent "${validated.id}" not found in team "${validatedTeam.team}"` } },
        }
      // Defaults team members are registry entries with no file (no overlay is read).
      if (input.level === "defaults")
        return {
          ok: false as const,
          error: {
            code: "team.invalid" as const,
            message: `"${validated.id}" cannot be deleted: shipped member of built-in team "${validatedTeam.team}"`,
            data: { team: validatedTeam.team, reason: `"${validated.id}" cannot be deleted: shipped member of built-in team "${validatedTeam.team}"` },
          },
        }
      const teamDir =
        input.level === "project"
          ? path.join(projectTeamsPath(directory), validatedTeam.team)
          : path.join(globalTeamsPath(), validatedTeam.team)
      const target = existing.path ?? teamMemberPath(teamDir, validated.id)
      if (target === undefined)
        return {
          ok: false as const,
          error: { code: "agent.invalid" as const, message: `Invalid agent id "${input.id}"`, data: { id: input.id, reason: `Invalid agent id "${input.id}"` } },
        }
      if (await Bun.file(target).exists()) {
        await fs.unlink(target)
      }
      // The member's own rows go with its file (agent.delete's cascade for
      // the team-scoped node): its link would otherwise keep a member the
      // team no longer has alive for preset.inUse, and its edits would meet
      // a member of the same id added later.
      const stored = await load(directory)
      await removeTeamMemberRecords(directory, { ...stored, protectedAgents: config.protectedAgents }, input.level, validatedTeam.team, validated.id)
      await Effect.runPromise(ctx.agent.reload())
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins, true))
      await Effect.runPromise(emitTeamsChanged(state))
      await logFileOp({
        directory,
        actor: normalizeActor(input.actor),
        scope: input.level === "project" ? "project" : "global",
        op: "team.removeAgent",
        target,
        summary: `team.removeAgent ${validated.id} from ${validatedTeam.team} (${input.level})`,
      })
      return { ok: true as const, value: { id: validated.id, path: target } }
    },
    deleteTeam: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const config = await read(directory)
      if (input.level === "defaults") {
        const reason = `Team "${input.team}" is built in: built-in teams cannot be deleted`
        return {
          ok: false as const,
          error: {
            code: "team.invalid" as const,
            message: reason,
            data: { team: input.team, reason },
          },
        }
      }
      const validated = validateTeamName(input.team)
      if (!validated.ok)
        return {
          ok: false as const,
          error: { code: "team.invalid" as const, message: validated.reason, data: { team: input.team, reason: validated.reason } },
        }
      const known = await discoverTeams(input.level, directory, builtins)
      const found = known.find((team) => team.team === validated.team)
      if (found === undefined)
        return {
          ok: false as const,
          error: { code: "team.unknown" as const, message: `Unknown team ${validated.team}`, data: { level: input.level, team: validated.team } },
        }
      const protectedMember = found.agents.find((member) => config.protectedAgents.includes(member.id))
      const refusal = refuseProtectedForTool(input.actor, protectedMember?.id, config)
      if (refusal !== undefined) return { ok: false as const, error: refusal }
      const teamsRoot = input.level === "project" ? projectTeamsPath(directory) : globalTeamsPath()
      const teamDir = path.join(teamsRoot, validated.team)
      let realTeamDir: string
      let realTeamsRoot: string
      try {
        realTeamDir = await fs.realpath(teamDir)
        realTeamsRoot = await fs.realpath(teamsRoot)
      } catch {
        return {
          ok: false as const,
          error: { code: "team.unknown" as const, message: `Team directory "${validated.team}" not found`, data: { level: input.level, team: validated.team } },
        }
      }
      const rel = path.relative(realTeamsRoot, realTeamDir)
      if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "") {
        const reason = `Team directory "${validated.team}" is outside teams root`
        return {
          ok: false as const,
          error: { code: "team.invalid" as const, message: reason, data: { team: validated.team, reason } },
        }
      }
      const stored = await load(directory)
      const loaded = { ...stored, protectedAgents: config.protectedAgents }
      const existing = loaded.records.find(
        (record): record is TeamRecord => record.type === "team" && record.level === input.level && record.team === validated.team,
      )
      if (existing?.enabled) {
        const disabledSave = await saveTeamRecord(directory, loaded, input.level, validated.team, false)
        if (!disabledSave.ok)
          return {
            ok: false as const,
            error: {
              code: "team.unknown" as const,
              message: `Team ${validated.team} changed concurrently; retry`,
              data: { level: input.level, team: validated.team },
            },
          }
        if (disabledSave.changed)
          await appendForLevel(directory, input.level, {
            ts: new Date().toISOString(),
            actor: normalizeActor(input.actor),
            op: "team.setEnabled",
            target: `team:${input.level}:${validated.team}`,
            summary: `team.setEnabled ${validated.team} disabled (${input.level})`,
            revision: disabledSave.revision,
          })
        await Effect.runPromise(ctx.agent.reload())
        await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins, true))
      }
      try {
        await fs.rm(realTeamDir, { recursive: true, force: true })
      } catch (error) {
        const reason = `Failed to remove team directory: ${messageOf(error)}`
        return {
          ok: false as const,
          error: {
            code: "team.invalid" as const,
            message: reason,
            data: { team: validated.team, reason },
          },
        }
      }
      const freshStored = await load(directory)
      const freshLoaded = { ...freshStored, protectedAgents: config.protectedAgents }
      await removeTeamRecords(directory, freshLoaded, input.level, validated.team)
      await Effect.runPromise(ctx.agent.reload())
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins, true))
      await Effect.runPromise(emitTeamsChanged(state))
      await logFileOp({
        directory,
        actor: normalizeActor(input.actor),
        scope: input.level,
        op: "team.delete",
        target: `team:${input.level}:${validated.team}`,
        summary: `team.delete ${validated.team} (${input.level})`,
      })
      return {
        ok: true as const,
        value: {
          level: input.level,
          team: validated.team,
          removedMembers: found.agents.length,
        },
      }
    },
    renameTeam: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const config = await read(directory)
      return renameTeamAt(ctx, state, builtins, directory, config, input)
    },
    listTeams: async () => {
      const directory = await activationDirectory(ctx.location.directory)
      const stored = await load(directory)
      const result = await listTeams(directory, stored.records, builtins)
      return { ok: true as const, value: result }
    },
    catalogModels: async () => {
      const models = (await hostModelsFor(ctx, state)).flatMap((entry): Plus.CatalogModel[] => {
        const providerID = entry.providerID
        const modelID = entry.modelID
        const name = entry.name ?? modelID
        const base: Plus.CatalogModel = { providerID, modelID, name }
        const variants = entry.variants.map(
          (variant): Plus.CatalogModel => ({ providerID, modelID, variant, name }),
        )
        return [base, ...variants]
      })
      return { ok: true as const, value: { models } }
    },
    addModel: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const config = await read(directory)
      // A preset's rows are not an agent's, whatever its id.
      const refusal = refuseProtectedForTool(input.actor, input.level === "preset" ? null : input.agent, config)
      if (refusal !== undefined) return { ok: false as const, error: refusal }
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
      // The same owner-segment guard as the tool boundary: a member's owner
      // path is not an agent id, and passing it here would write a literal
      // owner record the tree can never select. Refuse before any write.
      if (input.team === undefined && input.agent !== null) {
        const owner = parseMemberOwnerPath(input.agent)
        if (owner !== undefined) {
          const reason = `${JSON.stringify(input.agent)} is a team member's owner path, not an agent id; pass agent ${JSON.stringify(owner.member)} with team ${JSON.stringify(owner.team)}`
          return {
            ok: false as const,
            error: { code: "model.invalid" as const, message: reason, data: { providerID: validated.providerID, modelID: validated.modelID, ...(validated.variant === undefined ? {} : { variant: validated.variant }), reason } },
          }
        }
      }
      if (!(await catalogKnows(ctx, state, validated.providerID, validated.modelID, validated.variant))) {
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
          record.removed !== true &&
          record.level === input.level &&
          record.agent === input.agent &&
          sameTeam(record.team, input.team) &&
          catalogueMatches(input.agent, record.catalogue, input.catalogue) &&
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
      const target = { providerID: validated.providerID, modelID: validated.modelID, ...(validated.variant === undefined ? {} : { variant: validated.variant }) }
      const address = {
        level: input.level,
        agent: input.agent,
        ...(input.team !== undefined ? { team: input.team } : {}),
        ...(input.catalogue === undefined ? {} : { catalogue: input.catalogue }),
      }
      // Adding a model always makes it the active one at this level for this
      // owner: the new row is planted (clearing a tombstone for the same
      // candidate) and activated exclusively, so the previously active row at
      // the same (level, agent[, team]) stops being active. One save, one
      // revision, one log line.
      const models = modelsOf(loaded.records)
      const activated = activateModel(addModelRecord(models, address, target, new Date().toISOString()), address, target)
      const viewLoaded = { ...loaded, protectedAgents: config.protectedAgents }
      const teams = await snapshotTeams(directory, loaded.records, builtins)
      const discovered = await discoverAll(ctx, viewLoaded, state, builtins, directory)
      const switched = switchModelActivation(memoInputOf(toSnapshot(discovered, viewLoaded, teams, undefined, [])),
        { ...address, item: modelItemId(target), section: null }, target, activated,
        (owner) => owner !== null && config.protectedAgents.includes(owner))
      if ("refusal" in switched) return {
        ok: false as const,
        error: { code: "model.invalid" as const, message: switched.refusal, data: { providerID: target.providerID, modelID: target.modelID, reason: switched.refusal } },
      }
      const records = [...loaded.records.filter((record) => record.type !== "model" && record.type !== "customization"), ...switched.records, ...(switched.models ?? activated)]
      const saved = await saveModelRecords(directory, loaded, records)
      if (!saved.ok) {
        const reason = `Model ${validated.providerID}/${validated.modelID} changed concurrently; retry`
        return {
          ok: false as const,
          error: { code: "model.invalid" as const, message: reason, data: { providerID: validated.providerID, modelID: validated.modelID, ...(validated.variant === undefined ? {} : { variant: validated.variant }), reason } },
        }
      }
      const next = records.find(
        (record): record is ModelRecord =>
          record.type === "model" &&
          record.removed !== true &&
          record.level === input.level &&
          record.agent === input.agent &&
          sameTeam(record.team, input.team) &&
          catalogueMatches(input.agent, record.catalogue, input.catalogue) &&
          record.providerID === validated.providerID &&
          record.modelID === validated.modelID &&
          record.variant === validated.variant,
      )
      if (next === undefined) {
        const reason = `Model ${validated.providerID}/${validated.modelID} was not saved`
        return {
          ok: false as const,
          error: { code: "model.invalid" as const, message: reason, data: { providerID: validated.providerID, modelID: validated.modelID, ...(validated.variant === undefined ? {} : { variant: validated.variant }), reason } },
        }
      }
      if (saved.changed)
        await appendForLevel(directory, input.level, {
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
          ...(next.team !== undefined ? { team: next.team } : {}),
          providerID: next.providerID,
          modelID: next.modelID,
          ...(next.variant === undefined ? {} : { variant: next.variant }),
        },
      }
    },
    removeModel: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const config = await read(directory)
      // A preset's rows are not an agent's, whatever its id.
      const refusal = refuseProtectedForTool(input.actor, input.level === "preset" ? null : input.agent, config)
      if (refusal !== undefined) return { ok: false as const, error: refusal }
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
          sameTeam(record.team, input.team) &&
          catalogueMatches(input.agent, record.catalogue, input.catalogue) &&
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
        await appendForLevel(directory, input.level, {
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
          ...(existing.team !== undefined ? { team: existing.team } : {}),
          providerID: existing.providerID,
          modelID: existing.modelID,
          ...(existing.variant === undefined ? {} : { variant: existing.variant }),
        },
      }
    },
    pickModel: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const config = await read(directory)
      const validated = validateModelRef(input.providerID, input.modelID, input.variant)
      if (!validated.ok)
        return {
          ok: false as const,
          error: { code: "model.invalid" as const, message: validated.reason, data: { providerID: input.providerID, modelID: input.modelID, ...(input.variant === undefined ? {} : { variant: input.variant }), reason: validated.reason } },
        }
      if (!(await catalogKnows(ctx, state, validated.providerID, validated.modelID, validated.variant))) {
        const reason = `Unknown model ${validated.providerID}/${validated.modelID}${validated.variant === undefined ? "" : `@${validated.variant}`}`
        return {
          ok: false as const,
          error: { code: "model.invalid" as const, message: reason, data: { providerID: validated.providerID, modelID: validated.modelID, ...(validated.variant === undefined ? {} : { variant: validated.variant }), reason } },
        }
      }
      const pick: ModelPick = {
        agent: input.agent,
        providerID: validated.providerID,
        modelID: validated.modelID,
        ...(validated.variant === undefined ? {} : { variant: validated.variant }),
      }
      const invalid = (reason: string) =>
        ({
          ok: false as const,
          error: { code: "model.invalid" as const, message: reason, data: { providerID: validated.providerID, modelID: validated.modelID, ...(validated.variant === undefined ? {} : { variant: validated.variant }), reason } },
        })
      // Decide from fresh state, save revision-checked, and on a stale write
      // re-read, re-decide and try once more. One log line per changed save.
      const attempt = async (): Promise<
        | { ok: true; changed: boolean; revision: number; level: Level; rowId: string; status: string }
        | { ok: false; refusal?: string }
      > => {
        const stored = await load(directory)
        const loaded = { ...stored, protectedAgents: config.protectedAgents }
        const teams = await snapshotTeams(directory, loaded.records, builtins)
        const discovered = await discoverAll(ctx, loaded, state, builtins, directory)
        const snapshot = toSnapshot(discovered, loaded, teams, undefined, [])
        const memo = memoInputOf(snapshot)
        const result = pickModelRow(memo, pick, undefined, (owner) => owner !== null && config.protectedAgents.includes(owner))
        if ("refusal" in result) return { ok: false, refusal: result.refusal }
        if (!result.changed)
          return { ok: true, changed: false, revision: stored.projectRevision, level: result.level, rowId: result.rowId, status: result.status }
        const next = [...loaded.records.filter((record) => record.type !== "model" && (result.records === undefined || record.type !== "customization")), ...(result.records ?? []), ...result.models]
        const saved = await save(directory, {
          expectedProjectRevision: stored.projectRevision,
          expectedGlobalRevision: stored.globalRevision,
          records: next,
        })
        if (!saved.ok) return { ok: false }
        return {
          ok: true,
          changed: saved.changed.project || saved.changed.global,
          revision: result.level === "project" ? saved.projectRevision : saved.globalRevision,
          level: result.level,
          rowId: result.rowId,
          status: result.status,
        }
      }
      let saved = await attempt()
      if (!saved.ok && saved.refusal === undefined) saved = await attempt()
      if (!saved.ok) return invalid(saved.refusal ?? "the store changed concurrently; retry")
      if (saved.changed)
        await appendForLevel(directory, saved.level, {
          ts: new Date().toISOString(),
          actor: normalizeActor(input.actor),
          op: "model.pick",
          target: saved.rowId,
          summary: `model.pick ${validated.providerID}/${validated.modelID} (${saved.level})`,
          revision: saved.revision,
        })
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins))
      return { ok: true as const, value: { level: saved.level, rowId: saved.rowId, status: saved.status, changed: saved.changed } }
    },
    addRule: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const config = await read(directory)
      // A preset's rows are not an agent's, whatever its id.
      const refusal = refuseProtectedForTool(input.actor, input.level === "preset" ? null : input.agent, config)
      if (refusal !== undefined) return { ok: false as const, error: refusal }
      const validated = validateRuleRef(input.tool, input.id, input.label, input.patterns, input.keywords, input.message)
      if (!validated.ok)
        return {
          ok: false as const,
          error: { code: "rule.invalid" as const, message: validated.reason, data: { tool: input.tool, id: input.id, reason: validated.reason } },
        }
      const stored = await load(directory)
      const loaded = { ...stored, protectedAgents: config.protectedAgents }
      const existing = loaded.records.find(
        (record): record is RuleRecord => record.type === "rule" && record.tool === validated.tool && record.id === validated.id && scopedTo(record, input),
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
        ...catalogueField({ agent: input.agent, ...(input.catalogue === undefined ? {} : { catalogue: input.catalogue }) }),
        ...(input.team === undefined ? {} : { team: input.team }),
        tool: validated.tool,
        id: validated.id,
        label: validated.label,
        patterns: validated.patterns,
        keywords: validated.keywords,
        ...(validated.message === undefined ? {} : { message: validated.message }),
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
        await appendForLevel(directory, input.level, {
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
      const directory = await activationDirectory(ctx.location.directory)
      const config = await read(directory)
      const validated = validateRuleIdentity(input.tool, input.id)
      if (!validated.ok)
        return {
          ok: false as const,
          error: { code: "rule.invalid" as const, message: validated.reason, data: { tool: input.tool, id: input.id, reason: validated.reason } },
        }
      const stored = await load(directory)
      const loaded = { ...stored, protectedAgents: config.protectedAgents }
      const existing = ownRule(rulesOf(loaded.records), { ...input, item: permItemId(validated.tool, validated.id), section: null })
      if (existing === undefined)
        return {
          ok: false as const,
          error: {
            code: "rule.missing" as const,
            message: `Rule ${validated.tool}:${validated.id} does not exist`,
            data: { level: input.level, agent: input.agent, tool: validated.tool, id: validated.id },
          },
        }
      const refusal = refuseProtectedForTool(input.actor, input.level === "preset" ? null : input.agent, config)
      if (refusal !== undefined) return { ok: false as const, error: refusal }
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
        await appendForLevel(directory, existing.level, {
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
      const directory = await activationDirectory(ctx.location.directory)
      const config = await read(directory)
      const validated = validateRuleRef(input.tool, input.id, input.label, input.patterns, input.keywords, input.message)
      if (!validated.ok)
        return {
          ok: false as const,
          error: { code: "rule.invalid" as const, message: validated.reason, data: { tool: input.tool, id: input.id, reason: validated.reason } },
        }
      const stored = await load(directory)
      const loaded = { ...stored, protectedAgents: config.protectedAgents }
      const existing = ownRule(rulesOf(loaded.records), { ...input, item: permItemId(validated.tool, validated.id), section: null })
      const inherited = existing ?? await (async () => {
        const discovered = await discoverAll(ctx, loaded, state, builtins, directory)
        const chain = await publishChain(discovered, loaded.records, directory, builtins, state.teamOutputIds)
        return ruleAt(rulesOf(loaded.records), chain.publishScopes, { ...input, item: permItemId(input.tool, input.id), section: null })
      })()
      const owner = input.level === "preset" ? null : input.agent
      const refusal = refuseProtectedForTool(input.actor, owner, config)
      if (refusal !== undefined) return { ok: false as const, error: refusal }
      // A message present in the update wins, including blank, which clears
      // the stored one. Absent leaves it alone, so a label/pattern edit
      // through `set` never drops a rule's message.
      const message = input.message === undefined ? inherited?.message : validated.message
      const next: RuleRecord = {
        type: "rule",
        level: existing === undefined ? input.level : existing.level,
        agent: existing === undefined ? input.agent : existing.agent,
        // A matched record keeps its stored catalogue and team: editing a
        // Teams rule's message must not move it into the Agents catalogue
        // (and the team scope must survive too). With no match the row is a
        // first write at the caller's address, so the address catalogue
        // decides the new row (agent-qualified rows stay keyless).
        ...(existing === undefined
          ? catalogueField({ agent: input.agent, ...(input.catalogue === undefined ? {} : { catalogue: input.catalogue }) })
          : {
              ...(existing.catalogue === undefined ? {} : { catalogue: existing.catalogue }),
              ...(existing.team === undefined ? {} : { team: existing.team }),
            }),
        ...(input.team === undefined ? {} : { team: input.team }),
        tool: validated.tool,
        id: validated.id,
        label: validated.label,
        patterns: validated.patterns,
        keywords: input.keywords === undefined ? inherited?.keywords ?? validated.keywords : validated.keywords,
        ...(message === undefined ? {} : { message }),
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
        await appendForLevel(directory, next.level, {
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
    createEntry: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      return createEntryRecord(ctx, state, directory, builtins, input)
    },
    deleteEntry: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const team = input.catalogue === "teams" ? (input.team?.trim() || "*") : undefined
      if (input.catalogue === "agents" && input.name === undefined)
        return { ok: false as const, error: entryInvalid("", "An Agents entry is deleted by name") }
      const name = input.name?.trim()
      const matches = (entry: EntryRecord) =>
        entry.catalogue === input.catalogue && (entry.team ?? "*") === (team ?? "*") && (name === undefined || entry.name === name)
      const found = presetStateOf((await load(directory)).records).entries.filter(matches)
      if (found.length === 0) {
        const reason = `No Defaults ${input.catalogue} entry ${entryLabel({ catalogue: input.catalogue, team, name })}`
        return {
          ok: false as const,
          error: {
            code: "entry.missing" as const,
            message: reason,
            data: { catalogue: input.catalogue, ...(team === undefined ? {} : { team }), ...(name === undefined ? {} : { name }) },
          },
        }
      }
      // The entries go with their own settings and links (DESIGN §8 keeps
      // orphans of removed rows, but an entry re-created later must start
      // clean, not resurrect the old one's rows).
      const nodes = found.map(entryNode)
      const saved = await updateRecords(directory, (records) =>
        records.filter(
          (record) =>
            !(record.type === "entry" && matches(record)) &&
            !(
              record.type !== "team" &&
              record.type !== "entry" &&
              record.type !== "preset" &&
              record.type !== "modelSettings" &&
              record.type !== "folder" &&
              record.type !== "order" &&
              nodes.some((node) => scopedTo(record, node))
            ),
        ),
      )
      if (!saved.ok) return { ok: false as const, error: entryInvalid(name ?? team ?? "", "the store changed concurrently; retry") }
      await logFileOp({
        directory,
        actor: normalizeActor(input.actor),
        scope: "global",
        op: "entry.delete",
        target: entryRowId(input.catalogue, team, name),
        summary: `entry.delete ${entryLabel({ catalogue: input.catalogue, team, name })} (${found.length} removed)`,
      })
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins))
      return {
        ok: true as const,
        value: {
          id: entryRowId(input.catalogue, team, name),
          catalogue: input.catalogue,
          ...(team === undefined ? {} : { team }),
          ...(name === undefined ? {} : { name }),
          removed: found.length,
        },
      }
    },
    renameEntry: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const team = input.catalogue === "teams" ? (input.team?.trim() || "*") : undefined
      const to = validateEntryName(input.to)
      if (!to.ok) return { ok: false as const, error: entryInvalid(input.to, to.reason) }
      if (input.catalogue === "teams" && to.name === "special")
        return { ok: false as const, error: entryInvalid(to.name, 'Member id "special" is reserved') }
      const name = input.name.trim()
      const entries = presetStateOf((await load(directory)).records).entries
      const same = (entry: EntryRecord, entryName: string) =>
        entry.catalogue === input.catalogue && (entry.team ?? "*") === (team ?? "*") && entry.name === entryName
      if (!entries.some((entry) => same(entry, name)))
        return {
          ok: false as const,
          error: {
            code: "entry.missing" as const,
            message: `No Defaults ${input.catalogue} entry ${entryLabel({ catalogue: input.catalogue, team, name })}`,
            data: { catalogue: input.catalogue, ...(team === undefined ? {} : { team }), name },
          },
        }
      if (entries.some((entry) => same(entry, to.name))) return { ok: false as const, error: entryExists(input.catalogue, team, to.name) }
      const from = entryNode({ catalogue: input.catalogue, ...(team === undefined ? {} : { team }), name })
      const updated = new Date().toISOString()
      // The entry's own records and link move with it.
      const saved = await updateRecords(directory, (records) =>
        records.map((record): StoredRecord => {
          if (record.type === "entry") return same(record, name) ? { ...record, name: to.name, updated } : record
          if (record.type === "team" || record.type === "preset" || record.type === "modelSettings" || record.type === "folder" || record.type === "order") return record
          return scopedTo(record, from) ? { ...record, agent: to.name } : record
        }),
      )
      if (!saved.ok) return { ok: false as const, error: entryInvalid(name, "the store changed concurrently; retry") }
      await logFileOp({
        directory,
        actor: normalizeActor(input.actor),
        scope: "global",
        op: "entry.rename",
        target: entryRowId(input.catalogue, team, to.name),
        summary: `entry.rename ${entryLabel({ catalogue: input.catalogue, team, name })} to ${to.name}`,
      })
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins))
      return {
        ok: true as const,
        value: { id: entryRowId(input.catalogue, team, to.name), catalogue: input.catalogue, ...(team === undefined ? {} : { team }), name: to.name },
      }
    },
    createPreset: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const records = (await load(directory)).records
      const listing = await serverListing(ctx, records)
      const updated = new Date().toISOString()
      if (input.kind === "agent") {
        const validated = validateAgentId(input.id)
        if (!validated.ok) return { ok: false as const, error: presetInvalid(input.id, validated.reason) }
        const ref = { kind: "agent" as const, id: validated.id }
        if (listed(listing, ref) !== undefined) return { ok: false as const, error: presetExists(ref) }
        const from = input.from === undefined ? undefined : listed(listing, input.from)
        if (input.from !== undefined && (from === undefined || input.from.kind === "team")) return { ok: false as const, error: unknownPreset(input.from) }
        const saved = await updateRecords(directory, (current) => [
          ...current,
          { type: "preset", level: "preset", kind: "agent", id: validated.id, ...presetRecordFields(from), updated },
          ...(input.from === undefined ? [] : [linkRecord(presetOwner(ref), input.from, updated)]),
        ])
        if (!saved.ok) return { ok: false as const, error: presetInvalid(validated.id, "the store changed concurrently; retry") }
        return presetCreated(ctx, state, directory, builtins, ref, input.actor, input.from)
      }
      const validated = validateTeamName(input.id)
      if (!validated.ok) return { ok: false as const, error: presetInvalid(input.id, validated.reason) }
      const ref = { kind: "team" as const, id: validated.team }
      if (listed(listing, ref) !== undefined) return { ok: false as const, error: presetExists(ref) }
      const source = input.from === undefined || input.from === "" ? undefined : input.from
      const members = source === undefined ? [] : teamPresetMembers(source, presetStateOf(records).presets)
      if (members === undefined) return { ok: false as const, error: presetInvalid(source ?? "", `Unknown team preset ${source}`) }
      // A team preset from a team preset copies the member list; each member
      // links to the source member, the team to the source team.
      const saved = await updateRecords(directory, (current) => [
        ...current,
        { type: "preset", level: "preset", kind: "team", id: validated.team, updated },
        ...members.flatMap((member): StoredRecord[] => [
          { type: "preset", level: "preset", kind: "agent", id: member.id, team: validated.team, ...presetRecordFields(member), updated },
          linkRecord(presetOwner({ kind: "member", team: validated.team, id: member.id }), { kind: "member", team: source ?? "", id: member.id }, updated),
        ]),
        ...(source === undefined ? [] : [linkRecord(presetOwner(ref), { kind: "team", id: source }, updated)]),
      ])
      if (!saved.ok) return { ok: false as const, error: presetInvalid(validated.team, "the store changed concurrently; retry") }
      return presetCreated(ctx, state, directory, builtins, ref, input.actor, source === undefined ? undefined : { kind: "team", id: source })
    },
    addPresetMember: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const records = (await load(directory)).records
      const listing = await serverListing(ctx, records)
      const team = listed(listing, { kind: "team", id: input.team.trim() })
      if (team === undefined) return { ok: false as const, error: presetInvalid(input.team, `Unknown team preset ${input.team}`) }
      if (team.origin !== "user") return { ok: false as const, error: presetReadonly(team.ref) }
      const validated = validateAgentId(input.id)
      if (!validated.ok) return { ok: false as const, error: presetInvalid(input.id, validated.reason) }
      if (validated.id === "special") return { ok: false as const, error: presetInvalid(validated.id, 'Member id "special" is reserved') }
      const ref = { kind: "member" as const, team: team.ref.id, id: validated.id }
      if (listed(listing, ref) !== undefined) return { ok: false as const, error: presetExists(ref) }
      const from = input.from === undefined ? undefined : listed(listing, input.from)
      if (input.from !== undefined && (from === undefined || input.from.kind === "team")) return { ok: false as const, error: unknownPreset(input.from) }
      const updated = new Date().toISOString()
      const saved = await updateRecords(directory, (current) => [
        ...current,
        { type: "preset", level: "preset", kind: "agent", id: validated.id, team: team.ref.id, ...presetRecordFields(from), updated },
        ...(input.from === undefined ? [] : [linkRecord(presetOwner(ref), input.from, updated)]),
      ])
      if (!saved.ok) return { ok: false as const, error: presetInvalid(validated.id, "the store changed concurrently; retry") }
      return presetCreated(ctx, state, directory, builtins, ref, input.actor, input.from)
    },
    deletePreset: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const records = (await load(directory)).records
      const found = listed(await serverListing(ctx, records), input.ref)
      if (found === undefined) return { ok: false as const, error: unknownPreset(input.ref) }
      if (found.origin !== "user") return { ok: false as const, error: presetReadonly(input.ref) }
      // Links here (this project and the global store) always refuse: relink
      // them first — but only while their owner exists. A link whose agent,
      // member, team, Defaults entry or preset is gone is an orphan (an older
      // build removed the owner without its links, or the directory vanished
      // outside Plus): it never refuses and goes with the preset in the same
      // revision. Links other projects hold refuse unless `confirm`; after a
      // confirmed delete they read as a missing preset there. The check and
      // the commit share one write gate, so a link any in-process save adds
      // meanwhile is either seen here or written after the preset is gone.
      const decided = await updateGated(directory, async (loaded, gate) => {
        const links = presetStateOf(loaded.records).links
        const listing = await serverListing(ctx, loaded.records)
        const discovered = await discoverAll(ctx, { ...loaded, protectedAgents: [] }, state, builtins, directory)
        const teams = await discoverAllTeams(directory, builtins)
        const users = presetUsers(links, input.ref, (owner) => linkOwnerExists(loaded.records, listing, discovered, teams, owner))
        const elsewhere = await presetUsersElsewhere(directory, input.ref, gate.forget)
        if (users.length > 0 || (elsewhere.length > 0 && input.confirm !== true))
          return { result: { users, elsewhere, orphans: 0 } }
        // The preset goes with its members (a team preset), their own edits
        // and their links; every link to the preset left in this store belongs
        // to a gone owner and goes too.
        const members =
          input.ref.kind === "team"
            ? presetStateOf(loaded.records).presets.filter((record) => record.kind === "agent" && record.team === input.ref.id).map((record) => record.id)
            : []
        const owners = [presetOwner(input.ref), ...members.map((id) => presetOwner({ kind: "member", team: input.ref.id, id }))]
        const removed = (record: StoredRecord) => {
          if (record.type === "link" && targetsPreset(record.preset, input.ref)) return true
          if (record.type === "preset") return owners.some((owner) => presetRecordOwns(record, owner))
          if (record.type === "team" || record.type === "entry" || record.type === "modelSettings" || record.type === "folder" || record.type === "order") return false
          return owners.some((owner) => scopedTo(record, owner))
        }
        return { result: { users, elsewhere, orphans: links.filter((record) => targetsPreset(record.preset, input.ref)).length }, records: loaded.records.filter((record) => !removed(record)) }
      })
      const users = decided.result.users
      const elsewhere = decided.result.elsewhere
      if (decided.saved === undefined) {
        const all = [...users, ...elsewhere.flatMap((project) => project.users.map((user) => `${project.directory} › ${user}`))]
        const hint =
          users.length > 0
            ? "relink or delete them first"
            : "relink them there, or delete with confirm (their links then show as a missing preset)"
        return {
          ok: false as const,
          error: {
            code: "preset.inUse" as const,
            message: `Preset ${presetKey(input.ref)} is in use by ${all.join(", ")}; ${hint}`,
            data: { ref: input.ref, users: all, ...(elsewhere.length === 0 ? {} : { elsewhere }) },
          },
        }
      }
      if (!decided.saved.ok) return { ok: false as const, error: presetInvalid(input.ref.id, "the store changed concurrently; retry") }
      const id = ownerRowId(presetOwner(input.ref))
      await logFileOp({
        directory,
        actor: normalizeActor(input.actor),
        scope: "global",
        op: "preset.delete",
        target: id,
        summary: `preset.delete ${presetKey(input.ref)}${decided.result.orphans === 0 ? "" : ` (removed ${decided.result.orphans} orphaned link${decided.result.orphans === 1 ? "" : "s"})`}${elsewhere.length === 0 ? "" : ` (confirmed over links in ${elsewhere.map((project) => project.directory).join(", ")})`}`,
      })
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins))
      return { ok: true as const, value: { id, ref: input.ref } }
    },
    setLink: async (input) => {
      const directory = await activationDirectory(ctx.location.directory)
      const config = await read(directory)
      const owner: RecordScope = {
        level: input.level,
        agent: input.agent,
        ...(input.team === undefined ? {} : { team: input.team }),
      }
      // A tool may not relink a protected agent (presets are not agents).
      const refusal = refuseProtectedForTool(input.actor, input.level === "preset" ? null : input.agent, config)
      if (refusal !== undefined) return { ok: false as const, error: refusal }
      const records = (await load(directory)).records
      const listing = await serverListing(ctx, records)
      const invalid = await linkOwnerProblem(ctx, state, directory, builtins, records, listing, owner)
      if (invalid !== undefined) return { ok: false as const, error: invalid }
      const preset = input.preset
      if (preset !== null) {
        const known = listed(listing, preset)
        const wantsTeam = input.agent === null
        if (known === undefined || (preset.kind === "team") !== wantsTeam)
          return {
            ok: false as const,
            error: presetInvalid(
              presetKey(preset),
              known === undefined ? `Unknown preset ${presetKey(preset)}` : wantsTeam ? "A team links to a team preset" : "An agent links to an agent or member preset",
            ),
          }
      }
      // A team relinked to team preset TP relinks every member TP has a
      // counterpart for to `TP › member`; members without one keep their link,
      // and unlinking a team touches no member.
      const members =
        preset !== null && preset.kind === "team" && owner.agent === null && owner.team !== undefined
          ? await memberRelinks(directory, builtins, records, owner.level, owner.team, preset.id)
          : []
      // Relinking a team rewrites its members' links, so a tool may not
      // relink a team while any member it would relink is protected.
      const memberRefusal = members
        .map((member) => refuseProtectedForTool(input.actor, member.owner.level === "preset" ? null : member.owner.agent, config))
        .find((found) => found !== undefined)
      if (memberRefusal !== undefined) return { ok: false as const, error: memberRefusal }
      const updated = new Date().toISOString()
      const replaced = [owner, ...members.map((member) => member.owner)]
      const written = [
        ...(preset === null ? [] : [linkRecord(owner, preset, updated)]),
        ...members.map((member) => linkRecord(member.owner, member.preset, updated)),
      ]
      // §3.2: no preset may come back to itself through its links. The batch
      // is checked as a whole: every new link against the graph with all the
      // others already applied, so two member relinks cannot close a cycle
      // between them.
      if (owner.level === "preset") {
        const proposed = [...presetStateOf(records).links.filter((record) => !replaced.some((node) => scopedTo(record, node))), ...written]
        for (const link of written) {
          const self = presetOfOwner(link)
          const through = self === undefined ? undefined : linkCycle(proposed, self, link.preset)
          if (self !== undefined && through !== undefined)
            return {
              ok: false as const,
              error: {
                code: "link.cycle" as const,
                message: `Linking ${presetKey(self)} to ${presetKey(link.preset)} would make it reach itself (${through.join(" → ")})`,
                data: { preset: link.preset, through },
              },
            }
        }
      }
      const saved = await updateRecords(directory, (current) => [
        ...current.filter((record) => record.type !== "link" || !replaced.some((node) => scopedTo(record, node))),
        ...written,
      ])
      if (!saved.ok) return { ok: false as const, error: { code: "link.invalid" as const, message: "The store changed concurrently; retry", data: { reason: "The store changed concurrently; retry" } } }
      const target = ownerRowId(owner)
      await logFileOp({
        directory,
        actor: normalizeActor(input.actor),
        scope: input.level === "project" ? "project" : "global",
        op: "link.set",
        target,
        summary: `link.set ${target} ${preset === null ? "unlinked" : `to ${presetKey(preset)}`}${members.length === 0 ? "" : `; members ${members.map((member) => `${member.owner.agent} to ${presetKey(member.preset)}`).join(", ")}`}`,
      })
      await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins))
      return {
        ok: true as const,
        value: {
          level: input.level,
          agent: input.agent,
          ...(input.team === undefined ? {} : { team: input.team }),
          preset,
          ...(owner.agent === null && owner.team !== undefined
            ? { members: members.map((member) => ({ agent: member.owner.agent ?? "", preset: member.preset })) }
            : {}),
        },
      }
    },
  }
}

// The members of team `team` (at `level`) that team preset `id` has a member
// of the same id for, each with its new link `id › member`, in id order. A
// preset-level team's members are its member presets.
async function memberRelinks(
  directory: string,
  builtins: readonly BuiltinTeam[],
  records: readonly StoredRecord[],
  level: Level,
  team: TeamRef,
  id: string,
): Promise<{ owner: RecordScope; preset: PresetRef }[]> {
  const counterparts = new Set((teamPresetMembers(id, presetStateOf(records).presets) ?? []).map((member) => member.id))
  const members =
    level === "preset"
      ? presetStateOf(records).presets.filter((record) => record.kind === "agent" && record.team === team.team).map((record) => record.id)
      : level === "defaults"
        ? []
        : ((await discoverTeams(level, directory, builtins)).find((candidate) => candidate.team === team.team)?.agents.map((agent) => agent.id) ?? [])
  return [...new Set(members)]
    .filter((member) => counterparts.has(member))
    .toSorted()
    .map((member) => ({ owner: { level, agent: member, team }, preset: { kind: "member" as const, team: id, id: member } }))
}

function presetInvalid(id: string, reason: string): PresetInvalidError {
  return { code: "preset.invalid" as const, message: reason, data: { id, reason } }
}

function unknownPreset(ref: PresetRef): PresetInvalidError {
  return presetInvalid(presetKey(ref), `Unknown preset ${presetKey(ref)}${ref.kind === "team" ? " (an agent is created from an agent or member preset)" : ""}`)
}

function presetExists(ref: PresetRef): PresetExistsError {
  return { code: "preset.exists" as const, message: `Preset ${presetKey(ref)} already exists`, data: { ref } }
}

function presetReadonly(ref: PresetRef): PresetReadonlyError {
  const reason = `Preset ${presetKey(ref)} ships with the release and is read-only; create a User preset from it`
  return { code: "preset.readonly" as const, message: reason, data: { ref, reason } }
}

function entryInvalid(name: string, reason: string): EntryInvalidError {
  return { code: "entry.invalid" as const, message: reason, data: { name, reason } }
}

function entryExists(catalogue: Catalogue, team: string | undefined, name: string): EntryExistsError {
  return {
    code: "entry.exists" as const,
    message: `Defaults ${catalogue} entry ${entryLabel({ catalogue, team, name })} already exists`,
    data: { catalogue, ...(team === undefined ? {} : { team }), name },
  }
}

function entryLabel(entry: { catalogue: Catalogue; team?: string | undefined; name?: string | undefined }): string {
  if (entry.catalogue === "agents") return `"${entry.name ?? ""}"`
  return entry.name === undefined ? `team "${entry.team ?? "*"}"` : `"${entry.team ?? "*"} › ${entry.name}"`
}

function entryRowId(catalogue: Catalogue, team: string | undefined, name: string | undefined): string {
  if (catalogue === "agents") return `agent:defaults:${name ?? ""}`
  return name === undefined ? `team:defaults:${team ?? "*"}` : `team:defaults:${team ?? "*"}:${name}`
}

// The chain node an entry's own records and link are stored under.
function entryNode(entry: Pick<EntryRecord, "catalogue" | "team" | "name">): RecordScope {
  if (entry.catalogue === "agents") return { level: "defaults", agent: entry.name }
  return { level: "defaults", agent: entry.name, team: { level: "defaults", team: entry.team ?? "*" } }
}

// entry.create and team.addAgent at defaults (DESIGN §4): validate, refuse a
// duplicate (same catalogue, team pattern and name) and a native agent's own
// Defaults row, store the entry and its link in one save.
async function createEntryRecord(
  ctx: Context,
  state: PlusState,
  directory: string,
  builtins: readonly BuiltinTeam[],
  input: Plus.EntryCreateInput,
): Promise<CreateEntryResult> {
  const validated = validateEntryName(input.name)
  if (!validated.ok) return { ok: false as const, error: entryInvalid(input.name, validated.reason) }
  const name = validated.name
  if (input.catalogue === "agents" && input.team !== undefined)
    return { ok: false as const, error: entryInvalid(name, "An Agents entry takes no team pattern") }
  const teamPattern = input.catalogue === "teams" ? validateTeamName(input.team ?? "*") : undefined
  if (teamPattern !== undefined && !teamPattern.ok) return { ok: false as const, error: entryInvalid(input.team ?? "", teamPattern.reason) }
  const team = teamPattern?.ok === true ? teamPattern.team : undefined
  if (input.catalogue === "teams" && name === "special") return { ok: false as const, error: entryInvalid(name, 'Member id "special" is reserved') }
  const stored = await load(directory)
  const records = stored.records
  const duplicate = presetStateOf(records).entries.some(
    (entry) => entry.catalogue === input.catalogue && (entry.team ?? "*") === (team ?? "*") && entry.name === name,
  )
  if (duplicate) return { ok: false as const, error: entryExists(input.catalogue, team, name) }
  // A native agent's Defaults row already is the exact entry of its name.
  if (input.catalogue === "agents") {
    const discovered = await discoverAll(ctx, { ...stored, protectedAgents: [] }, state, builtins, directory)
    if (discovered.agents.some((agent) => agent.scope === "defaults" && agent.id === name))
      return { ok: false as const, error: entryExists(input.catalogue, team, name) }
  }
  if (input.preset !== undefined) {
    const known = listed(await serverListing(ctx, records), input.preset)
    if (known === undefined || input.preset.kind === "team") return { ok: false as const, error: unknownPreset(input.preset) }
  }
  const updated = new Date().toISOString()
  const entry: EntryRecord = {
    type: "entry",
    level: "defaults",
    catalogue: input.catalogue,
    ...(team === undefined ? {} : { team }),
    name,
    updated,
  }
  const preset = input.preset
  // A link left behind at this entry's node (a deleted entry of the same name)
  // gives way to the one asked for now.
  const saved = await updateRecords(directory, (current) => [
    ...current.filter((record) => record.type !== "link" || !scopedTo(record, entryNode(entry))),
    entry,
    ...(preset === undefined ? [] : [linkRecord(entryNode(entry), preset, updated)]),
  ])
  if (!saved.ok) return { ok: false as const, error: entryInvalid(name, "the store changed concurrently; retry") }
  const id = entryRowId(input.catalogue, team, name)
  await logFileOp({
    directory,
    actor: normalizeActor(input.actor),
    scope: "global",
    op: "entry.create",
    target: id,
    summary: `entry.create ${entryLabel({ catalogue: input.catalogue, team, name })}${preset === undefined ? "" : ` from ${presetKey(preset)}`}`,
  })
  await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins))
  return { ok: true as const, value: { id, catalogue: input.catalogue, ...(team === undefined ? {} : { team }), name } }
}

// What stops `owner` from taking a link: it does not exist, or it is a
// Native/Plus preset (read-only) or a Teams entry pattern.
async function linkOwnerProblem(
  ctx: Context,
  state: PlusState,
  directory: string,
  builtins: readonly BuiltinTeam[],
  records: readonly StoredRecord[],
  listing: readonly PresetEntry[],
  owner: RecordScope,
): Promise<PresetReadonlyError | { code: "link.invalid"; message: string; data: Plus.LinkInvalid } | undefined> {
  const invalid = (reason: string) => ({ code: "link.invalid" as const, message: reason, data: { reason } })
  if (owner.level === "preset") {
    const ref = presetOfOwner(owner)
    const known = ref === undefined ? undefined : listed(listing, ref)
    if (ref === undefined || known === undefined) return invalid(`No preset at ${ownerRowId(owner)}`)
    if (known.origin !== "user") return presetReadonly(ref)
    return undefined
  }
  if (owner.level === "defaults") {
    if (owner.agent === null) return invalid("A Teams entry pattern takes no link; link its member entries")
    const agent = owner.agent
    const exists = presetStateOf(records).entries.some((entry) =>
      owner.team === undefined
        ? entry.catalogue === "agents" && entry.name === agent
        : entry.catalogue === "teams" && entry.name === agent && (entry.team ?? "*") === owner.team.team,
    )
    return exists ? undefined : invalid(`No Defaults entry at ${ownerRowId(owner)}; an OpenCode agent's own Defaults row takes no link`)
  }
  const level = owner.level
  if (owner.team !== undefined) {
    const team = (await discoverTeams(level, directory, builtins)).find((candidate) => candidate.team === owner.team?.team)
    if (team === undefined) return invalid(`No ${level} team ${owner.team.team}`)
    if (owner.agent !== null && !team.agents.some((member) => member.id === owner.agent))
      return invalid(`No member ${owner.agent} in ${level} team ${owner.team.team}`)
    return undefined
  }
  if (owner.agent === null) return invalid("A link names an agent, a member or a team")
  const discovered = await discoverAll(ctx, { ...(await load(directory)), protectedAgents: [] }, state, builtins, directory)
  if (!discovered.agents.some((agent) => agent.scope === level && agent.id === owner.agent)) return invalid(`No ${level} agent ${owner.agent}`)
  return undefined
}

// Whether a stored link's owner still exists: an agent (or member) at its
// level, a team, a Defaults entry or a User preset. A link whose owner is
// gone is an orphan — an owner removed without its links, or a store edited
// outside Plus — and must not refuse a preset deletion (`presets.ts`
// `presetUsers` takes this as its `exists` filter); the deletion removes
// those links with the preset in the same revision. `teams` is every
// discovered team, enabled or not, exactly as `linkOwnerProblem` checks:
// a disabled team's members still exist.
function linkOwnerExists(
  records: readonly StoredRecord[],
  listing: readonly PresetEntry[],
  discovered: Discovered,
  teams: readonly DiscoveredTeam[],
  owner: Pick<RecordScope, "level" | "agent" | "team">,
): boolean {
  if (owner.level === "preset") {
    const ref = presetOfOwner(owner)
    return ref !== undefined && listed(listing, ref) !== undefined
  }
  if (owner.level === "defaults") {
    if (owner.agent === null) return false
    return presetStateOf(records).entries.some((entry) =>
      owner.team === undefined
        ? entry.catalogue === "agents" && entry.name === owner.agent
        : entry.catalogue === "teams" && entry.name === owner.agent && (entry.team ?? "*") === owner.team.team,
    )
  }
  if (owner.team !== undefined) {
    const team = teams.find((candidate) => candidate.level === owner.level && candidate.team === owner.team?.team)
    if (team === undefined) return false
    return owner.agent === null || team.agents.some((member) => member.id === owner.agent)
  }
  if (owner.agent === null) return false
  return discovered.agents.some((agent) => agent.scope === owner.level && agent.id === owner.agent)
}

// The preset a `preset`-level owner is.
function presetOfOwner(owner: RecordScope): PresetRef | undefined {
  if (owner.level !== "preset") return undefined
  if (owner.agent === null) return owner.team === undefined ? undefined : { kind: "team", id: owner.team.team }
  if (owner.team === undefined) return { kind: "agent", id: owner.agent }
  return { kind: "member", team: owner.team.team, id: owner.agent }
}

function presetRecordOwns(record: PresetRecord, owner: RecordScope): boolean {
  const ref = presetOfOwner(owner)
  if (ref === undefined) return false
  if (ref.kind === "team") return record.kind === "team" && record.id === ref.id
  if (ref.kind === "member") return record.kind === "agent" && record.team === ref.team && record.id === ref.id
  return record.kind === "agent" && record.team === undefined && record.id === ref.id
}

// Who links to `ref` from other projects' stores (the global index lists the
// projects; each project's own store is read for the truth). A listed project
// whose store is gone, or that no longer holds a link, is dropped from the
// index here: a stale entry never blocks a deletion. Runs under the global
// write gate (`forget` writes the index in place).
async function presetUsersElsewhere(
  directory: string,
  ref: PresetRef,
  forget: (projectDirs: readonly string[]) => Promise<void>,
): Promise<{ directory: string; users: string[] }[]> {
  const here = path.resolve(directory)
  const projects = (await linkedProjects()).filter((project) => project !== here)
  const read = await Promise.all(projects.map(async (project) => ({ directory: project, links: await projectLinks(project) })))
  await forget(read.filter((project) => project.links === undefined || project.links.length === 0).map((project) => project.directory))
  return read.flatMap((project) => {
    const users = presetUsers(project.links ?? [], ref).filter((user) => user.startsWith("agent:project:") || user.startsWith("team:project:"))
    return users.length === 0 ? [] : [{ directory: project.directory, users }]
  })
}

function listed(listing: readonly PresetEntry[], ref: PresetRef): PresetEntry | undefined {
  return listing.find((entry) => presetKey(entry.ref) === presetKey(ref))
}

function linkRecord(owner: RecordScope, preset: PresetRef, updated: string): LinkRecord {
  return {
    type: "link",
    level: owner.level,
    agent: owner.agent,
    ...(owner.team === undefined ? {} : { team: owner.team }),
    preset,
    updated,
  }
}

// The mode and description a user preset copies from its base, so an agent
// later created from it can copy them in turn.
function presetRecordFields(from: { readonly mode?: string; readonly description?: string } | undefined): Pick<PresetRecord, "fields"> {
  if (from === undefined) return {}
  const fields = {
    ...(from.mode === undefined ? {} : { mode: from.mode }),
    ...(from.description === undefined ? {} : { description: from.description }),
  }
  return Object.keys(fields).length === 0 ? {} : { fields }
}

async function presetCreated(
  ctx: Context,
  state: PlusState,
  directory: string,
  builtins: readonly BuiltinTeam[],
  ref: PresetRef,
  actor: Plus.Actor | undefined,
  from: PresetRef | undefined,
): Promise<{ ok: true; value: Plus.PresetResult }> {
  const id = ownerRowId(presetOwner(ref))
  await logFileOp({
    directory,
    actor: normalizeActor(actor),
    scope: "global",
    op: "preset.create",
    target: id,
    summary: `preset.create ${presetKey(ref)}${from === undefined ? "" : ` from ${presetKey(from)}`}`,
  })
  await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins))
  return { ok: true as const, value: { id, ref } }
}

// Every preset with what a created file copies from it; Native presets read
// their mode and description from the host's own agent.
async function serverListing(ctx: Context, records: readonly StoredRecord[]): Promise<PresetEntry[]> {
  const listed = await Effect.runPromise(
    ctx.agent.list().pipe(Effect.catchCause(() => Effect.succeed({ data: [] as readonly Agent.Info[] }))),
  )
  const native = new Map(
    listed.data
      .filter((agent) => (nativePresetIds as readonly string[]).includes(String(agent.id)))
      .map((agent) => [
        String(agent.id),
        {
          ...(agent.mode === undefined ? {} : { mode: String(agent.mode) }),
          ...(agent.description === undefined ? {} : { description: agent.description }),
        },
      ]),
  )
  return presetListing(presetStateOf(records).presets, native)
}

// The agent or member preset an agent file is created from; undefined for an
// unknown preset or a team preset.
async function agentPresetEntry(ctx: Context, directory: string, ref: PresetRef): Promise<PresetEntry | undefined> {
  if (ref.kind === "team") return undefined
  return listed(await serverListing(ctx, (await load(directory)).records), ref)
}

// Load, change and save the store, retrying once against a fresh read when
// it changed concurrently. `attempt` answers the next record list.
async function updateRecords(
  directory: string,
  attempt: (records: readonly StoredRecord[]) => readonly StoredRecord[],
): Promise<{ ok: boolean }> {
  const once = async () => {
    const loaded = await load(directory)
    const saved = await save(directory, {
      expectedProjectRevision: loaded.projectRevision,
      expectedGlobalRevision: loaded.globalRevision,
      records: attempt(loaded.records),
    })
    return saved.ok
  }
  if (await once()) return { ok: true }
  return { ok: await once() }
}

// Replace (or with null drop) the one link `owner` has.
async function setOwnerLink(directory: string, owner: RecordScope, preset: PresetRef | null): Promise<{ ok: boolean }> {
  const updated = new Date().toISOString()
  return updateRecords(directory, (records) => [
    ...records.filter((record) => record.type !== "link" || !scopedTo(record, owner)),
    ...(preset === null ? [] : [linkRecord(owner, preset, updated)]),
  ])
}

export function createHandlers(ctx: Context, state: PlusState, options?: PlusApiOptions): RpcHandlers<typeof Definition> {
  const api = createPlusApi(ctx, state, options)
  return {
    "instructions.snapshot": (_input) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.snapshot())
        return result.value
      }),
    "instructions.refresh": (_input) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.refresh())
        return result.value
      }),
    "chat.refresh": (input) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.chatRefresh(input))
        return result.value
      }),
    "instructions.mutate": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.mutate(input))
        if (!result.ok) {
          if (result.error.code === "agent.invalid")
            return yield* Effect.fail(context.error("agent.invalid", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("agent.protected", result.error.message, result.error.data))
        }
        return result.value
      }),
    "instructions.log": (input) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.log(input))
        return result.value
      }),
    // `opencodeplus instructions …` (B18): enumerate the live instruction
    // tools, then run one through its own implementation. Refusals (including
    // an unknown op) come back by value; `runOp` converts a thrown tool error
    // into `{ error: { message } }`.
    "instructions.ops": () =>
      Effect.gen(function* () {
        const tools = yield* ctx.tool.list()
        return { ops: listOps(toolRegistry(tools)) }
      }),
    "instructions.run": (input) =>
      Effect.gen(function* () {
        const tools = yield* ctx.tool.list()
        const result = yield* Effect.promise(() => runOp(toolRegistry(tools), input.op, input.input, input.actor))
        return result
      }),
    "instructions.assembled": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.assembled(input))
        if (!result.ok) {
          return yield* Effect.fail(context.error("agent.unknown", result.error.message, result.error.data))
        }
        return result.value
      }),
    "agent.create": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.createAgent(input))
        if (!result.ok) {
          if (result.error.code === "agent.exists")
            return yield* Effect.fail(context.error("agent.exists", result.error.message, result.error.data))
          if (result.error.code === "agent.protected")
            return yield* Effect.fail(context.error("agent.protected", result.error.message, result.error.data))
          if (result.error.code === "preset.invalid")
            return yield* Effect.fail(context.error("preset.invalid", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("agent.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "agent.rename": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.renameAgent(input))
        if (!result.ok) {
          if (result.error.code === "agent.missing")
            return yield* Effect.fail(context.error("agent.missing", result.error.message, result.error.data))
          if (result.error.code === "agent.exists")
            return yield* Effect.fail(context.error("agent.exists", result.error.message, result.error.data))
          if (result.error.code === "agent.protected")
            return yield* Effect.fail(context.error("agent.protected", result.error.message, result.error.data))
          if (result.error.code === "team.unknown")
            return yield* Effect.fail(context.error("team.unknown", result.error.message, result.error.data))
          if (result.error.code === "team.invalid")
            return yield* Effect.fail(context.error("team.invalid", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("agent.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "agent.delete": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.deleteAgent(input))
        if (!result.ok) {
          if (result.error.code === "agent.missing")
            return yield* Effect.fail(context.error("agent.missing", result.error.message, result.error.data))
          if (result.error.code === "agent.protected")
            return yield* Effect.fail(context.error("agent.protected", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("agent.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "skill.create": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.createSkill(input))
        if (!result.ok) {
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
          if (result.error.code === "skill.missing")
            return yield* Effect.fail(context.error("skill.missing", result.error.message, result.error.data))
          if (result.error.code === "skill.invalid")
            return yield* Effect.fail(context.error("skill.invalid", result.error.message, result.error.data))
          // Unreachable through this method: its RPC input carries no actor, so
          // this boundary always normalises to the TUI and the item-cascade
          // guard cannot refuse. The variant exists for the tool-facing
          // PlusApi, which passes an actor.
          return yield* Effect.fail(
            context.error("skill.invalid", result.error.message, { id: input.id, reason: result.error.message }),
          )
        }
        return result.value
      }),
    "base.create": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.createBase(input))
        if (!result.ok) {
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
          if (result.error.code === "base.missing")
            return yield* Effect.fail(context.error("base.missing", result.error.message, result.error.data))
          if (result.error.code === "base.invalid")
            return yield* Effect.fail(context.error("base.invalid", result.error.message, result.error.data))
          // Unreachable through this method: its RPC input carries no actor, so
          // this boundary always normalises to the TUI and the item-cascade
          // guard cannot refuse. The variant exists for the tool-facing
          // PlusApi, which passes an actor.
          return yield* Effect.fail(
            context.error("base.invalid", result.error.message, { id: input.id, reason: result.error.message }),
          )
        }
        return result.value
      }),
    "system.create": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.createSystem(input))
        if (!result.ok) {
          if (result.error.code === "system.exists")
            return yield* Effect.fail(context.error("system.exists", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("system.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "system.delete": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.deleteSystem(input))
        if (!result.ok) {
          if (result.error.code === "system.missing")
            return yield* Effect.fail(context.error("system.missing", result.error.message, result.error.data))
          if (result.error.code === "system.invalid")
            return yield* Effect.fail(context.error("system.invalid", result.error.message, result.error.data))
          // Unreachable through this method, as for base.delete: its RPC input
          // carries no actor, so the protected-agent guard cannot refuse.
          return yield* Effect.fail(
            context.error("system.invalid", result.error.message, { id: input.id, reason: result.error.message }),
          )
        }
        return result.value
      }),
    "system.models": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.setSystemModels(input))
        if (!result.ok) {
          if (result.error.code === "system.missing")
            return yield* Effect.fail(context.error("system.missing", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("system.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "instruction.create": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.createInstruction(input))
        if (!result.ok) {
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
          if (result.error.code === "mcp.missing")
            return yield* Effect.fail(context.error("mcp.missing", result.error.message, result.error.data))
          if (result.error.code === "mcp.invalid")
            return yield* Effect.fail(context.error("mcp.invalid", result.error.message, result.error.data))
          // Unreachable through this method: its RPC input carries no actor, so
          // this boundary always normalises to the TUI and the item-cascade
          // guard cannot refuse. The variant exists for the tool-facing
          // PlusApi, which passes an actor.
          return yield* Effect.fail(
            context.error("mcp.invalid", result.error.message, { name: input.name, reason: result.error.message }),
          )
        }
        return result.value
      }),
    "team.create": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.createTeam(input))
        if (!result.ok) {
          if (result.error.code === "team.exists")
            return yield* Effect.fail(context.error("team.exists", result.error.message, result.error.data))
          if (result.error.code === "team.invalid")
            return yield* Effect.fail(context.error("team.invalid", result.error.message, result.error.data))
          if (result.error.code === "agent.protected")
            return yield* Effect.fail(context.error("agent.protected", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("team.create", result.error.message, result.error.data))
        }
        return result.value
      }),
    "team.setEnabled": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.setTeamEnabled(input))
        if (!result.ok) {
          if (result.error.code === "team.invalid")
            return yield* Effect.fail(context.error("team.invalid", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("team.unknown", result.error.message, result.error.data))
        }
        return result.value
      }),
    "modelSettings.set": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.setModelSettings(input))
        if (!result.ok) return yield* Effect.fail(context.error("modelSettings.invalid", result.error.message, result.error.data))
        return result.value
      }),
    "layout.write": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.layoutWrite(input))
        if (!result.ok) return yield* Effect.fail(context.error("layout.invalid", result.error.message, result.error.data))
        return result.value
      }),
    "team.addAgent": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.addTeamAgent(input))
        if (!result.ok) {
          const error = result.error
          if (error.code === "team.unknown") return yield* Effect.fail(context.error(error.code, error.message, error.data))
          if (error.code === "team.invalid") return yield* Effect.fail(context.error(error.code, error.message, error.data))
          if (error.code === "agent.exists") return yield* Effect.fail(context.error(error.code, error.message, error.data))
          if (error.code === "agent.protected") return yield* Effect.fail(context.error(error.code, error.message, error.data))
          if (error.code === "preset.invalid") return yield* Effect.fail(context.error(error.code, error.message, error.data))
          if (error.code === "entry.invalid") return yield* Effect.fail(context.error(error.code, error.message, error.data))
          if (error.code === "entry.exists") return yield* Effect.fail(context.error(error.code, error.message, error.data))
          return yield* Effect.fail(context.error("agent.invalid", error.message, error.data))
        }
        return result.value
      }),
    "entry.create": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.createEntry(input))
        if (result.ok) return result.value
        const error = result.error
        if (error.code === "entry.exists") return yield* Effect.fail(context.error(error.code, error.message, error.data))
        if (error.code === "preset.invalid") return yield* Effect.fail(context.error(error.code, error.message, error.data))
        return yield* Effect.fail(context.error("entry.invalid", error.message, error.data))
      }),
    "entry.delete": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.deleteEntry(input))
        if (result.ok) return result.value
        const error = result.error
        if (error.code === "entry.missing") return yield* Effect.fail(context.error(error.code, error.message, error.data))
        return yield* Effect.fail(context.error("entry.invalid", error.message, error.data))
      }),
    "entry.rename": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.renameEntry(input))
        if (result.ok) return result.value
        const error = result.error
        if (error.code === "entry.missing") return yield* Effect.fail(context.error(error.code, error.message, error.data))
        if (error.code === "entry.exists") return yield* Effect.fail(context.error(error.code, error.message, error.data))
        return yield* Effect.fail(context.error("entry.invalid", error.message, error.data))
      }),
    "preset.create": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.createPreset(input))
        if (result.ok) return result.value
        const error = result.error
        if (error.code === "preset.exists") return yield* Effect.fail(context.error(error.code, error.message, error.data))
        return yield* Effect.fail(context.error("preset.invalid", error.message, error.data))
      }),
    "preset.addMember": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.addPresetMember(input))
        if (result.ok) return result.value
        const error = result.error
        if (error.code === "preset.exists") return yield* Effect.fail(context.error(error.code, error.message, error.data))
        if (error.code === "preset.readonly") return yield* Effect.fail(context.error(error.code, error.message, error.data))
        return yield* Effect.fail(context.error("preset.invalid", error.message, error.data))
      }),
    "preset.delete": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.deletePreset(input))
        if (result.ok) return result.value
        const error = result.error
        if (error.code === "preset.readonly") return yield* Effect.fail(context.error(error.code, error.message, error.data))
        if (error.code === "preset.inUse") return yield* Effect.fail(context.error(error.code, error.message, error.data))
        return yield* Effect.fail(context.error("preset.invalid", error.message, error.data))
      }),
    "link.set": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.setLink(input))
        if (result.ok) return result.value
        const error = result.error
        if (error.code === "preset.invalid") return yield* Effect.fail(context.error(error.code, error.message, error.data))
        if (error.code === "preset.readonly") return yield* Effect.fail(context.error(error.code, error.message, error.data))
        if (error.code === "link.cycle") return yield* Effect.fail(context.error(error.code, error.message, error.data))
        if (error.code === "agent.protected") return yield* Effect.fail(context.error(error.code, error.message, error.data))
        return yield* Effect.fail(context.error("link.invalid", error.message, error.data))
      }),
    "team.removeAgent": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.removeTeamAgent(input))
        if (!result.ok) {
          if (result.error.code === "team.unknown")
            return yield* Effect.fail(context.error("team.unknown", result.error.message, result.error.data))
          if (result.error.code === "team.invalid")
            return yield* Effect.fail(context.error("team.invalid", result.error.message, result.error.data))
          if (result.error.code === "agent.protected")
            return yield* Effect.fail(context.error("agent.protected", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("agent.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "team.delete": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.deleteTeam(input))
        if (!result.ok) {
          if (result.error.code === "team.unknown")
            return yield* Effect.fail(context.error("team.unknown", result.error.message, result.error.data))
          if (result.error.code === "agent.protected")
            return yield* Effect.fail(context.error("agent.protected", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("team.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "team.rename": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.renameTeam(input))
        if (!result.ok) {
          if (result.error.code === "team.unknown")
            return yield* Effect.fail(context.error("team.unknown", result.error.message, result.error.data))
          if (result.error.code === "team.exists")
            return yield* Effect.fail(context.error("team.exists", result.error.message, result.error.data))
          if (result.error.code === "agent.protected")
            return yield* Effect.fail(context.error("agent.protected", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("team.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "team.list": () =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.listTeams())
        return result.value
      }),
    "team.runs.list": (input, context) =>
      Effect.gen(function* () {
        const root = teamsDataDir()
        if (input.tree !== false && input.sessionID) {
          const allRuns = yield* Effect.promise(() => listRunsForNamespace(root, { all: true }))
          const runs = buildRunTree(allRuns, input.sessionID, { all: input.all })
          return { runs }
        }
        const runs = yield* Effect.promise(() => listRunsForNamespace(root, input))
        return { runs }
      }),
    "team.runs.stop": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => stopRun(ctx, input.run))
        if (!result.ok) {
          const data = { message: result.error.message }
          if (result.error.code === "E_BUSY")
            return yield* Effect.fail(context.error("E_BUSY", result.error.message, data))
          if (result.error.code === "run.unknown")
            return yield* Effect.fail(context.error("run.unknown", result.error.message, data))
          return yield* Effect.fail(context.error("run.unknown", result.error.message, data))
        }
        return result.value as { run: string; state: string }
      }),
    "model.add": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.addModel(input))
        if (!result.ok) {
          if (result.error.code === "model.exists")
            return yield* Effect.fail(context.error("model.exists", result.error.message, result.error.data))
          if (result.error.code === "agent.protected")
            return yield* Effect.fail(context.error("agent.protected", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("model.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "model.remove": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.removeModel(input))
        if (!result.ok) {
          if (result.error.code === "model.missing")
            return yield* Effect.fail(context.error("model.missing", result.error.message, result.error.data))
          if (result.error.code === "agent.protected")
            return yield* Effect.fail(context.error("agent.protected", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("model.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "model.pick": (input, context) =>
      Effect.gen(function* () {
        // Chain each pick onto the previous one so overlapping picks apply in
        // order: Ctrl+T twice must end on the second effort, and a pick that
        // lands in the gap cannot clear the later one's in-flight marker. The
        // marker is set synchronously before any await so a session event that
        // arrives while the save runs waits for it (applySessionModel).
        const previous = state.pendingPick ?? Promise.resolve()
        const run = previous.then(() => api.pickModel(input))
        const pending = run.then(
          () => undefined,
          () => undefined,
        )
        state.pendingPick = pending
        const result = yield* Effect.promise(() => run)
        // Clear only when no later pick has already replaced this marker.
        if (state.pendingPick === pending) state.pendingPick = undefined
        if (!result.ok) return yield* Effect.fail(context.error("model.invalid", result.error.message, result.error.data))
        return result.value
      }),
    "rule.add": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.addRule(input))
        if (!result.ok) {
          if (result.error.code === "rule.exists")
            return yield* Effect.fail(context.error("rule.exists", result.error.message, result.error.data))
          if (result.error.code === "agent.protected")
            return yield* Effect.fail(context.error("agent.protected", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("rule.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "rule.remove": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.removeRule(input))
        if (!result.ok) {
          if (result.error.code === "rule.missing")
            return yield* Effect.fail(context.error("rule.missing", result.error.message, result.error.data))
          if (result.error.code === "agent.protected")
            return yield* Effect.fail(context.error("agent.protected", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("rule.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "rule.update": (input, context) =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.updateRule(input))
        if (!result.ok) {
          if (result.error.code === "agent.protected")
            return yield* Effect.fail(context.error("agent.protected", result.error.message, result.error.data))
          return yield* Effect.fail(context.error("rule.invalid", result.error.message, result.error.data))
        }
        return result.value
      }),
    "catalog.models": () =>
      Effect.gen(function* () {
        const result = yield* Effect.promise(() => api.catalogModels())
        return result.value
      }),
    "monitor.query": (input) => Effect.promise(() => monitorQuery(ctx, input)),
    "monitor.cache": (input) => Effect.sync(() => monitorCache(ctx, input)),
    "monitor.prompt": (input) => Effect.sync(() => monitorPrompt(input)),
    "monitor.step": (input) => Effect.promise(() => monitorStep(ctx, input)),
    "monitor.mark": (input) => Effect.sync(() => monitorMark(input.label)),
    "monitor.notices": () => Effect.promise(async () => monitorNotices(await plusSettings.read())),
    "monitor.dismiss": (input) => Effect.sync(() => monitorDismiss(input.requestID)),
    "monitor.sessions": (input) => Effect.promise(() => monitorSessions(ctx, input)),
    "checks.suggest": () =>
      Effect.promise(async () => {
        const root = await mainCheckout(ctx.location.directory)
        if (root === undefined) return { current: [], suggested: [] }
        const project = await readProjectChecks(root)
        const suggestions = await suggestChecks(root)
        const known = new Set((project?.checks ?? []).map((check) => JSON.stringify(check.argv)))
        return {
          root,
          current: [...(project?.checks ?? [])],
          ...(project?.setup === undefined ? {} : { setup: { id: "setup", ...project.setup } }),
          ...(project?.invalid === undefined ? {} : { invalid: project.invalid }),
          // Only what the file does not already hold.
          suggested: suggestions.checks.filter((check) => !known.has(JSON.stringify(check.argv))),
          ...(suggestions.setup === undefined || project?.setup !== undefined ? {} : { suggestedSetup: suggestions.setup }),
        }
      }),
    "checks.save": (input, context) =>
      Effect.gen(function* () {
        const root = yield* Effect.promise(() => mainCheckout(ctx.location.directory))
        if (root === undefined) return yield* Effect.fail(context.error("checks.invalid", "not inside a git repository", { reason: "not inside a git repository" }))
        const entry = (check: { readonly argv: readonly string[]; readonly cwd?: string; readonly description?: string }) => ({
          argv: [...check.argv],
          ...(check.cwd === undefined ? {} : { cwd: check.cwd }),
          ...(check.description === undefined ? {} : { description: check.description }),
        })
        const written = yield* Effect.promise(() =>
          writeProjectChecks(root, {
            version: 1,
            ...(input.setup === undefined ? {} : { setup: entry(input.setup) }),
            checks: Object.fromEntries(input.checks.map((check) => [check.id, entry(check)])),
          }),
        )
        if (!written.ok) return yield* Effect.fail(context.error("checks.invalid", written.reason, { reason: written.reason }))
        return { path: written.path, checks: input.checks.map((check) => check.id) }
      }),
    "warming.status": (input) =>
      Effect.promise(async () => {
        const session = await Effect.runPromise(ctx.session.get({ sessionID: Session.ID.make(input.sessionID) })).catch(
          () => undefined,
        )
        return footerStatusFor(input.sessionID, session?.model, Date.now())
      }),
    "compaction.window": (input) =>
      Effect.sync(() => {
        const threshold = inputThresholdOf(state, input.agent, {
          providerID: input.providerID,
          id: input.modelID,
          ...(input.variant === undefined ? {} : { variant: input.variant }),
        })
        return threshold === undefined ? {} : { input: threshold }
      }),
    "warming.set": (input) =>
      Effect.gen(function* () {
        const status = yield* Effect.promise(() => warmingStore.setChat(input.sessionID, input.chat))
        yield* emitWarmingChanged(state, input.sessionID)
        return status
      }),
    "warming.compact": (input) =>
      Effect.gen(function* () {
        const chat =
          input.on === "default" ? "default" : input.on ? ("on" as const) : ("off" as const)
        const status = yield* Effect.promise(() => warmingStore.setCompact(input.sessionID, chat))
        yield* emitWarmingChanged(state, input.sessionID)
        return status
      }),
    "settings.get": () => Effect.promise(() => plusSettings.read()),
    "settings.set": (input, context) =>
      Effect.gen(function* () {
        const { attention, ...rest } = input
        const current = yield* Effect.promise(() => plusSettings.read())
        const merged = attention === undefined ? undefined : mergeAttention(current.attention, attention)
        if (merged !== undefined && "error" in merged)
          return yield* Effect.fail(context.error("settings.invalid", merged.error, { reason: merged.error }))
        return yield* Effect.promise(() =>
          plusSettings.update({
            ...Object.fromEntries(Object.entries(rest).filter((entry) => entry[1] !== undefined)),
            ...(merged === undefined ? {} : { attention: merged.settings }),
          }),
        )
      }),
    "attention.player": (input) => Effect.sync(() => ({ players: attentionStore.player(input.id) })),
    "attention.open": (input) => Effect.sync(() => ({ tuis: attentionStore.opened(input.id, input.sessionIDs) })),
    "attention.sound": (input, context) =>
      Effect.gen(function* () {
        const sound = yield* Effect.promise(() => readAttentionSound(input.sound))
        if ("reason" in sound) return yield* Effect.fail(context.error("sound.invalid", sound.reason, sound))
        return sound
      }),
    "attention.test": (input) => attentionTest(state, input),
  }
}

// Cache warming: the per-chat switch, then the agent's model row (Models tab,
// resolved down the agent's chain like its active model), then the host
// configuration core proposed. A failure leaves core's proposal in place.
export function decideWarmingFor(
  ctx: Context,
  state: PlusState,
  event: SessionWarming,
  usedUp: typeof pacerUsedUp = pacerUsedUp,
): Effect.Effect<void> {
  // A keep-alive's outcome: whether it went through decides how long the cache stays warm.
  if (event.phase === "warmed")
    return Effect.suspend(() =>
      warmingStore.warmed(event.sessionID, event.now, event.error) ? emitWarmingChanged(state, event.sessionID) : Effect.void,
    )
  return Effect.promise(async () => {
    const run = await bySession(teamsDataDir(), event.sessionID)
    if (run !== undefined) {
      // Evicting the landed folder closes core's loop before its next ping can
      // forget the stored window. Reopening must not resume that old window in
      // the new folder before a real request has populated its cache.
      const reopened = run.history.findLast((entry) => "trigger" in entry && entry.trigger === "reopened")
      if (
        run.worktree === "removed" || run.state === "dead" || run.state === "superseded" || run.state === "reaped" ||
        (event.phase !== "activity" && reopened !== undefined && event.since < Date.parse(reopened.at))
      ) {
        event.settings = undefined
        return warmingStore.stop(event.sessionID)
      }
      if (run.state === "stopping" || run.state === "stopped") {
        const warming = await warmingStore.status(event.sessionID, event.now)
        if (warming.expires === undefined || event.now >= warming.expires) {
          event.settings = undefined
          return false
        }
      }
    }
    if (Date.now() - state.warmingCheckedAt > 5_000) {
      state.warmingCheckedAt = Date.now()
      await refreshActiveModelsIfStale(await activationDirectory(ctx.location.directory), state)
    }
    // A ping must not boot an unloaded folder: the location's own services are
    // dropped after its idle window, and its next load reads fresh state, so a
    // ping there is wasted work at best and an MCP process spawn at worst.
    if (event.phase === "warm" && !(await Effect.runPromise(ctx.locations.loaded(ctx.location)))) {
      event.settings = undefined
      return false
    }
    // Once the cache went cold (keep-alives or steps that did not go through),
    // warming stops: the next keep-alive that went through would write the
    // whole prompt into the cache again. Real activity starts a new window.
    if (event.phase === "warm") {
      const warm = await warmingStatusFor(event.sessionID, event.now)
      if (warm.warmUntil !== undefined && warm.warmUntil <= event.now && warm.compacted !== true) {
        event.settings = undefined
        return warmingStore.cool(event.sessionID, warm.warmUntil)
      }
      // Pacer has decided the chat's account cannot serve its next step, which compacts and moves to
      // another account: a keep-alive would spend that account's last usage on a cache the move does not
      // reuse. It goes on only while the account serves again (its meters at their floor reset) within
      // USED_UP_RESET_MS, when the chat may still stay; the window ends where its cache goes cold.
      const out = await usedUp({ sessionID: event.sessionID, providerID: event.model.providerID, modelID: event.model.id })
      if (out !== undefined && !(out.servesAt !== undefined && out.servesAt - event.now <= USED_UP_RESET_MS)) {
        event.settings = undefined
        return warmingStore.cool(event.sessionID, Math.max(event.now, warm.warmUntil ?? event.now))
      }
    }
    return warmingStore.decide(event, warmingRowsOf(state, event.agent, event.model), (sessionID) =>
      Effect.runPromise(
        Effect.gen(function* () {
          // Compact before cold fires at the window's end; a cache that went cold
          // earlier would make its summary pay for the whole prompt.
          const status = yield* Effect.promise(() => warmingStatusFor(sessionID, Date.now()))
          if (status.warmUntil !== undefined && status.warmUntil <= Date.now()) return
          yield* Effect.logInfo("plus compacting before the cache goes cold", { sessionID })
          yield* emitWarmingChanged(state, sessionID)
          yield* ctx.session.compact({ sessionID: Session.ID.make(sessionID) })
        }).pipe(Effect.tapCause((cause) => Effect.logWarning("plus compact before cold failed", { cause, sessionID }))),
      ),
    )
  }).pipe(
    Effect.flatMap((changed) => (changed ? emitWarmingChanged(state, event.sessionID) : Effect.void)),
    Effect.catchCause((cause) => Effect.logWarning("plus cache warming decision failed", { cause, sessionID: event.sessionID })),
  )
}

export function warmingRowsOf(
  state: Pick<PlusState, "cachedAgents" | "cachedModels" | "cachedModelSettings" | "cachedScopes">,
  agentID: string,
  model: { readonly providerID: string; readonly id: string; readonly variant?: string },
): WarmingRows {
  const context = modelRowContextOf(state, agentID, model)
  const row = resolveModelFields(context.input, context.target)
  const modelRow = settingsFor(state.cachedModelSettings, context.key)
  const everyRow = everySettings(state.cachedModelSettings)
  return {
    ...(Object.keys(row).length === 0 ? {} : { row }),
    ...(modelRow === undefined ? {} : { model: modelRow }),
    ...(everyRow === undefined ? {} : { every: everyRow }),
  }
}

/**
 * The chat's model-level compact settings: the effective `compactWarm` (the
 * per-chat switch's default) and the models cold arming would try when it
 * applies. Only the model rows and the Defaults › Models rows set these, so no
 * agent-wide or shared Defaults record is consulted.
 */
export function compactDefaultsOf(
  state: Pick<PlusState, "cachedAgents" | "cachedModels" | "cachedModelSettings" | "cachedScopes">,
  agentID: string,
  model: { readonly providerID: string; readonly id: string; readonly variant?: string },
  coldCompact: boolean,
): ChatCompactionDefaults {
  const modelRow = settingsFor(state.cachedModelSettings, { providerID: model.providerID, modelID: model.id })
  const everyRow = everySettings(state.cachedModelSettings)
  const effective = effectiveCompaction({
    row: compactionRowsOf(state, agentID, model),
    ...(modelRow === undefined ? {} : { model: modelRow }),
    ...(everyRow === undefined ? {} : { every: everyRow }),
  })
  return {
    compactWarm: effective.compactWarm.value,
    compactWarmFrom: effective.compactWarm.from === "built-in" ? "built-in" : "model",
    // Cold arming only fires while "Compact cold chats first" is on for the
    // model: its own switch, else the global Settings switch.
    coldModels: (effective.coldFirst.value ?? coldCompact) ? effective.coldModels.value : [],
  }
}

/** The chat's model-level compact defaults, read from the session's current agent and model. */
export async function sessionCompactDefaults(
  ctx: Context,
  state: Pick<PlusState, "cachedAgents" | "cachedModels" | "cachedModelSettings" | "cachedScopes">,
  sessionID: string,
): Promise<ChatCompactionDefaults | undefined> {
  const session = await Effect.runPromise(ctx.session.get({ sessionID: Session.ID.make(sessionID) })).catch(() => undefined)
  if (session?.agent === undefined || session.model === undefined) return undefined
  const model = session.model
  return compactDefaultsOf(
    state,
    session.agent,
    { providerID: model.providerID, id: model.id, ...(model.variant === undefined ? {} : { variant: model.variant }) },
    (await plusSettings.read()).coldCompact,
  )
}

// Plus's `compaction.decide`: the per-model settings for (agent, chat model),
// cold-cache arming before any step whose cache is cold, the CPA account-switch
// replacement, and the team `compactWith` arming that wins over all of them.
export function decideCompactionFor(
  ctx: Context,
  state: PlusState,
  event: SessionCompactionDecision,
  ledger: Pick<Ledger, "getRequests" | "getFingerprint"> = ledgerAt(),
  pacer: typeof pacerCache = pacerCache,
): Effect.Effect<void> {
  return Effect.promise(async () => {
    const settings = await plusSettings.read()
    const modelRow = settingsFor(state.cachedModelSettings, { providerID: event.model.providerID, modelID: event.model.id })
    const everyRow = everySettings(state.cachedModelSettings)
    // Instructions › this model › Images › When image context is full; built-in leaves core's own choice (compact).
    const imagesFull = imagesOf(state, event.agent, event.model).imagesFull
    if (imagesFull.from !== "built-in") event.images = imagesFull.value === "error" || imagesFull.value === "leave-out" ? imagesFull.value : "compact"
    // An armed list (a team compactWith, or `compaction.cold`) is the user's
    // explicit instruction: it wins, and nothing below needs reading.
    const armed = consumeColdCompaction(event.sessionID)
    if (armed !== undefined) {
      decideCompaction(event, { armed })
      return
    }
    // Cold is consulted before every step (core's `auto` decisions, retries
    // included), not only a new message's first: a running agent's cache goes
    // cold too, while it waits on a long tool call or a subagent, or when its
    // keep-alives or steps do not go through. Only when Compact cold chats
    // first is on for the chat's model (its own switch, else the Settings one)
    // and the model has a cold-cache list to compact with.
    const consulted =
      event.reason === "auto" && armedColdListOf(state, event.agent, event.model, settings.coldCompact).length > 0
    const cold = consulted ? await coldFor(event, ledger, pacer) : undefined
    const agentWide = await compactionDefaultsOf(ctx, event.agent)
    decideCompaction(event, {
      rows: compactionRowsOf(state, event.agent, event.model),
      ...(modelRow === undefined ? {} : { model: modelRow }),
      ...(everyRow === undefined ? {} : { every: everyRow }),
      ...(agentWide === undefined ? {} : { agent: agentWide }),
      ...(cold === undefined ? {} : { cold }),
    })
  })
}

/** The Images settings an agent on a model resolves: its model rows, then Defaults › Models › that model, then Every model. */
function imagesOf(state: PlusState, agentID: string, model: { readonly providerID: string; readonly id: string; readonly variant?: string }) {
  const modelRow = settingsFor(state.cachedModelSettings, { providerID: model.providerID, modelID: model.id })
  const everyRow = everySettings(state.cachedModelSettings)
  return effectiveImages({
    row: compactionRowsOf(state, agentID, model),
    ...(modelRow === undefined ? {} : { model: modelRow }),
    ...(everyRow === undefined ? {} : { every: everyRow }),
  })
}

/** Applies the chat's model's Images settings to an arriving image; a field no row sets leaves core as configured. */
export function chooseImageFor(ctx: Context, state: PlusState, event: SessionImage): Effect.Effect<void> {
  return ctx.session.get({ sessionID: event.sessionID }).pipe(
    Effect.map((session) => {
      if (session.agent === undefined || session.model === undefined) return
      const images = imagesOf(state, session.agent, session.model)
      chooseImage(event, {
        ...(images.imageConvert.from === "built-in" ? {} : { imageConvert: images.imageConvert.value }),
        ...(images.imageShrink.from === "built-in" ? {} : { imageShrink: images.imageShrink.value }),
      })
    }),
    Effect.catchCause(() => Effect.void),
  )
}

// The agent's old agent-wide compaction policy, as core has it applied.
async function compactionDefaultsOf(ctx: Context, agentID: Agent.ID): Promise<CompactionDefaults | undefined> {
  const agent = await Effect.runPromise(ctx.agent.get({ agentID }).pipe(Effect.catchCause(() => Effect.succeed(undefined))))
  const compaction = agent?.data.compaction
  if (compaction === undefined) return undefined
  const model = compaction.model
  return {
    ...(compaction.strategy === undefined ? {} : { strategy: compaction.strategy }),
    ...(model === undefined ? {} : { model: `${model.providerID}/${model.id}${model.variant === undefined ? "" : `#${model.variant}`}` }),
    ...(compaction.system === undefined ? {} : { instructions: compaction.system }),
  }
}

// The decision module owns the cold test itself. The status is the one the
// footer shows, so a chat compacts first exactly when the footer says it is cold.
async function coldFor(
  event: SessionCompactionDecision,
  ledger: Pick<Ledger, "getRequests" | "getFingerprint">,
  pacer: typeof pacerCache,
) {
  const now = Date.now()
  return coldStateOf({ status: await warmingStatusFor(event.sessionID, now, ledger, pacer), boundary: event.boundary, now })
}

/**
 * A chat's warming status as the footer and cold compaction read it, with
 * when its cache really goes cold (`warmUntil`, see warmUntilOf): a window
 * whose cache went cold before its end (its keep-alives, or its steps, did not
 * go through) reads as ended there; a chat warming does not keep warm is cold
 * from that moment. A window that ends as planned keeps its own end: its last
 * keep-alive was one interval before it.
 */
export async function warmingStatusFor(
  sessionID: string,
  now: number,
  ledger: Pick<Ledger, "getRequests" | "getFingerprint"> = ledgerAt(),
  pacer: typeof pacerCache = pacerCache,
): Promise<WarmingStatus> {
  const status = await warmingStore.status(sessionID, now)
  if (status.compacted === true) return status
  const warm = await warmUntilOf(sessionID, status, now, ledger, pacer)
  if (warm === undefined) return status
  const known: WarmingStatus = { ...status, warmUntil: warm.until, warmBy: warm.by }
  if (status.active && status.expires !== undefined) {
    if (warm.until > now) return known
    // Its summary would no longer read a warm cache: no compact before cold.
    const { compactAt: _cancelled, ...cut } = known
    return { ...cut, active: false, expires: Math.max(status.since ?? warm.until, warm.until) }
  }
  return status.coldAt === undefined ? known : { ...known, coldAt: warm.until }
}

/**
 * The footer's status: the chat's warming status, and whether Pacer has decided the account of the chat's
 * current model cannot serve its next step (it compacts and moves to another account). Only the footer asks
 * Pacer this: a step's compaction decision does not wait on it.
 */
export async function footerStatusFor(
  sessionID: string,
  model: { readonly providerID: string; readonly id: string } | undefined,
  now: number,
  usedUp: typeof pacerUsedUp = pacerUsedUp,
  ledger: Pick<Ledger, "getRequests" | "getFingerprint"> = ledgerAt(),
  pacer: typeof pacerCache = pacerCache,
): Promise<WarmingStatus> {
  const [status, out] = await Promise.all([
    warmingStatusFor(sessionID, now, ledger, pacer),
    model === undefined ? undefined : usedUp({ sessionID, providerID: model.providerID, modelID: model.id }),
  ])
  return out === undefined ? status : { ...status, accountUsedUp: true }
}

// A request touched the chat's cache on the provider when it got an answer (or
// is getting one): a step, keep-alive or other generation on the chat's prefix.
// A failed one did not, unless the provider still counted cache tokens for it.
const touchedCache = (row: RequestRow) =>
  !row.isTitle &&
  row.kind !== "title" &&
  row.kind !== "compaction" &&
  (row.status !== "error" || row.cacheReadTokens + row.cacheWriteTokens > 0)

// A request the store saw start but the Monitor has not recorded yet is under way, for a while.
const PENDING_MS = 120_000

// A used-up account whose meters reset within this keeps its chat warming.
const USED_UP_RESET_MS = 10 * 60_000

// Pacer learns a request's cache use from its usage, after the answer: its
// reading counts from a minute after the chat's latest request ended.
const PACER_SETTLE_MS = 60_000

/**
 * When the chat's cache goes cold by what reached the provider: the start of
 * its latest request that touched the cache (Monitor) plus that request's cache
 * lifetime (its fingerprint's TTL, else the model's known lifetime). Pacer, when
 * it answers for the chat's model with evidence the provider confirmed (cache
 * reads or writes on the chat's account, with the TTL CPA really sent), decides
 * instead, once it can know that latest request. Undefined when nothing is known.
 */
async function warmUntilOf(
  sessionID: string,
  status: WarmingStatus,
  now: number,
  ledger: Pick<Ledger, "getRequests" | "getFingerprint">,
  pacer: typeof pacerCache,
): Promise<{ readonly until: number; readonly by: "monitor" | "pacer" } | undefined> {
  const rows = ledger.getRequests(sessionID)
  const touch = rows.findLast(touchedCache)
  const requested = status.lastRequest
  const pending =
    requested !== undefined && now - requested < PENDING_MS && !rows.some((row) => row.started >= requested - 1_000)
      ? requested
      : undefined
  const touchedAt = Math.max(touch?.started ?? -Infinity, pending ?? -Infinity)
  if (touch === undefined || !Number.isFinite(touchedAt)) return undefined
  const lifetime =
    cacheLifetime(touch, ledger.getFingerprint(touch.id)) ??
    (touch.provider === undefined || touch.model === undefined ? undefined : cacheLifetimeOf({ providerID: touch.provider, modelID: touch.model }))
  const settled = pending !== undefined || touch.ended === undefined ? Infinity : touch.ended + PACER_SETTLE_MS
  const answer =
    settled <= now && touch.provider !== undefined && touch.model !== undefined
      ? await pacer({ sessionID, providerID: touch.provider, modelID: touch.model, after: settled })
      : undefined
  if (answer?.evidence === "confirmed" && answer.until !== undefined) return { until: answer.until, by: "pacer" }
  return lifetime === undefined ? undefined : { until: touchedAt + lifetime, by: "monitor" }
}

interface LoadedStores {
  readonly projectRevision: number
  readonly globalRevision: number
  readonly records: readonly StoredRecord[]
  readonly protectedAgents: readonly string[]
}

// OpenCodePlus: creating and deleting AGENTS.md files is off pending the Context
// catalogue; the rows themselves are back (instructions/discover.ts).
const INSTRUCTIONS_DISABLED = true

// Resolve the skill storage target from a skill RPC input. Scope defaults to
// project; preset scope must name its preset. A missing preset is a caller
// error the handlers surface as skill.invalid rather than a thrown path error.
function skillTargetOf(
  directory: string,
  input: { scope?: Plus.SkillScope; preset?: string },
): { ok: true; target: SkillTarget } | { ok: false; message: string } {
  const scope = input.scope ?? "project"
  if (scope !== "preset") return { ok: true, target: { scope, projectDirectory: directory } }
  const preset = input.preset?.trim()
  if (preset === undefined || preset.length === 0) return { ok: false, message: "preset scope requires a preset id" }
  if (preset.includes("/") || preset.includes("\\") || preset.includes("\0") || preset.includes(".."))
    return { ok: false, message: `Invalid preset id "${preset}"` }
  return { ok: true, target: { scope, projectDirectory: directory, preset } }
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
//
// Exactly one team is enabled at a time, mirroring the agent picker where
// choosing a team member makes that team the active ring: enabling a team
// flips every other enabled team record (at any level) to disabled in the
// same save, so the TUI never has to reconcile two "on" teams.
async function saveTeamRecord(
  directory: string,
  loaded: LoadedStores,
  level: TeamRecord["level"],
  team: string,
  enabled: boolean,
): Promise<{ ok: true; changed: boolean; revision: number; disabledTeams: { level: TeamLevel; team: string }[] } | { ok: false }> {
  const attempt = (records: readonly StoredRecord[]) => {
    const existing = records.find(
      (record): record is TeamRecord => record.type === "team" && record.level === level && record.team === team,
    )
    const others = enabled
      ? records.filter(
          (record): record is TeamRecord =>
            record.type === "team" && record.enabled && !(record.level === level && record.team === team),
        )
      : []
    if (existing !== undefined && existing.enabled === enabled && others.length === 0) return undefined
    const updated = new Date().toISOString()
    const next: TeamRecord = { type: "team", level, team, enabled, updated }
    const isTarget = (record: StoredRecord) => record.type === "team" && record.level === level && record.team === team
    return {
      records: [
        ...records.filter((record) => !isTarget(record) && !others.includes(record as TeamRecord)),
        ...others.map((record): TeamRecord => ({ ...record, enabled: false, updated })),
        next,
      ] as readonly StoredRecord[],
      disabledTeams: others.map((record) => ({ level: record.level, team: record.team })),
    }
  }
  const revisionOf = (projectRevision: number, globalRevision: number) =>
    level === "project" ? projectRevision : globalRevision
  const changedOf = (changed: { readonly project: boolean; readonly global: boolean }) =>
    level === "project" ? changed.project : changed.global
  const first = attempt(loaded.records)
  if (first === undefined) return { ok: true, changed: false, revision: revisionOf(loaded.projectRevision, loaded.globalRevision), disabledTeams: [] }
  const saved = await save(directory, {
    expectedProjectRevision: loaded.projectRevision,
    expectedGlobalRevision: loaded.globalRevision,
    records: first.records,
  })
  if (saved.ok) return { ok: true, changed: changedOf(saved.changed), revision: revisionOf(saved.projectRevision, saved.globalRevision), disabledTeams: first.disabledTeams }
  const fresh = await load(directory)
  const second = attempt(fresh.records)
  if (second === undefined) return { ok: true, changed: false, revision: revisionOf(fresh.projectRevision, fresh.globalRevision), disabledTeams: [] }
  const retried = await save(directory, {
    expectedProjectRevision: fresh.projectRevision,
    expectedGlobalRevision: fresh.globalRevision,
    records: second.records,
  })
  if (retried.ok)
    return { ok: true, changed: changedOf(retried.changed), revision: revisionOf(retried.projectRevision, retried.globalRevision), disabledTeams: second.disabledTeams }
  return { ok: false }
}

// Stores links, each replacing the link its owner had (one link per owner),
// retrying once on a concurrent change like the team records above.
async function saveLinks(directory: string, links: readonly LinkRecord[]): Promise<{ ok: boolean }> {
  const attempt = (records: readonly StoredRecord[]): StoredRecord[] => [
    ...records.filter((record) => record.type !== "link" || !links.some((link) => scopedTo(record, link))),
    ...links,
  ]
  const loaded = await load(directory)
  const saved = await save(directory, {
    expectedProjectRevision: loaded.projectRevision,
    expectedGlobalRevision: loaded.globalRevision,
    records: attempt(loaded.records),
  })
  if (saved.ok) return { ok: true }
  const fresh = await load(directory)
  const retried = await save(directory, {
    expectedProjectRevision: fresh.projectRevision,
    expectedGlobalRevision: fresh.globalRevision,
    records: attempt(fresh.records),
  })
  return { ok: retried.ok }
}

// The fields a file created from a preset copies (DESIGN §5): core reads
// mode and description from the file, everything else follows the link.
// Without a mode (None, or a preset that names none) the file states core's
// own default, `primary` (Agent.Info.default): core skips an empty agent file
// (config/plugin/agent.ts decodes only a file with content), so a file with
// no frontmatter and an empty body would never register.
function presetFields(preset: { readonly mode?: string; readonly description?: string }): AgentFields {
  const mode = preset.mode === "subagent" || preset.mode === "primary" || preset.mode === "all" ? preset.mode : "primary"
  return {
    mode,
    ...(preset.description === undefined ? {} : { description: preset.description }),
  }
}

// The full chain context (DESIGN §3) every production resolution reads: the
// agents' scopes, the stored links, Defaults entries and user presets, the
// preset catalogue built from the discovered items, and each member's teams.
function contextFor(
  agents: readonly AgentSource[],
  items: readonly Item[],
  records: readonly StoredRecord[],
  teams: readonly DiscoveredTeam[],
): Scopes {
  return chainContext({
    agents,
    items,
    ...presetStateOf(records),
    teams: teams.map((team) => ({ team: team.team, agents: team.agents.map((agent) => agent.id) })),
  })
}

// Deletes every record `isTarget` names and saves, retrying once against a
// concurrent change like the other record writers. `changed` reports the
// target level's store (project vs global).
async function removeRecordsAt(
  directory: string,
  loaded: LoadedStores,
  level: Level,
  isTarget: (record: StoredRecord) => boolean,
): Promise<{ ok: true; changed: boolean; revision: number } | { ok: false }> {
  const attempt = (records: readonly StoredRecord[]) => {
    if (!records.some(isTarget)) return undefined
    return records.filter((record) => !isTarget(record)) as readonly StoredRecord[]
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

// The record kinds addressed at one scope: links and the row records
// (customizations, splits, models, rules). Team records, entries and presets
// are owners, not rows of an owner.
function isScopedRow(record: StoredRecord): record is LinkRecord | CustomizationRecord | SplitRecord | ModelRecord | RuleRecord {
  return record.type === "link" || record.type === "customization" || record.type === "split" || record.type === "model" || record.type === "rule"
}

// The rows a deleted team leaves behind: its own TeamRecord, the team's and
// its members' links, and every row addressed to a node inside the team.
// Member files leave with the team directory; keeping these rows would orphan
// them, and a team of the same name created later would inherit them.
async function removeTeamRecords(
  directory: string,
  loaded: LoadedStores,
  level: TeamRecord["level"],
  team: string,
): Promise<{ ok: true; changed: boolean; revision: number } | { ok: false }> {
  return removeRecordsAt(directory, loaded, level, (record) => {
    if (record.type === "team") return record.level === level && record.team === team
    return (
      isScopedRow(record) &&
      record.level === level &&
      record.team !== undefined &&
      record.team.level === level &&
      record.team.team === team
    )
  })
}

// The rows a removed team member leaves behind: everything addressed to it,
// its team-scoped link included (agent.delete's cascade, scoped to the
// member). A member of the same id added later starts clean.
async function removeTeamMemberRecords(
  directory: string,
  loaded: LoadedStores,
  level: TeamRecord["level"],
  team: string,
  agent: string,
): Promise<{ ok: true; changed: boolean; revision: number } | { ok: false }> {
  return removeRecordsAt(directory, loaded, level, (record) =>
    isScopedRow(record) &&
    record.level === level &&
    record.agent === agent &&
    record.team !== undefined &&
    record.team.level === level &&
    record.team.team === team,
  )
}

async function removeAgentRecords(
  directory: string,
  loaded: LoadedStores,
  agent: string,
  level: Level,
): Promise<{ ok: true; changed: boolean; revision: number } | { ok: false }> {
  // The agent's own link goes with it: an agent created later under the same
  // id starts from the preset it is created from, not this one's.
  return removeRecordsAt(directory, loaded, level, (record) => {
    if (isScopedRow(record) && record.team !== undefined) return false
    if (record.type === "customization" || record.type === "split") return record.agent === agent && record.level === level
    if (record.type === "model" || record.type === "rule")
      return record.agent === agent && record.level === level && record.team === undefined
    return record.type === "link" && record.agent === agent && record.level === level && record.team === undefined
  })
}

function teamDirFor(level: "project" | "global", directory: string, team: string): string {
  return level === "project" ? path.join(projectTeamsPath(directory), team) : path.join(globalTeamsPath(), team)
}

// T6: rename an on-disk team member. The member file moves inside its team
// directory and every row the member owns — its team-scoped link, row edits,
// splits, models, rules and warming rows — plus every "Delegate to" row that
// names it moves to the new id in one store revision. Session history keeps
// the old name: nothing here touches session storage.
async function renameTeamMember(
  ctx: Context,
  state: PlusState,
  builtins: readonly BuiltinTeam[],
  directory: string,
  config: { readonly protectedAgents: readonly string[] },
  input: { readonly scope: "project" | "global"; readonly team: string; readonly from: string; readonly to: string; readonly actor?: Plus.Actor },
): Promise<RenameAgentResult> {
  const validatedTeam = validateTeamName(input.team)
  if (!validatedTeam.ok)
    return {
      ok: false,
      error: { code: "team.invalid", message: validatedTeam.reason, data: { team: input.team, reason: validatedTeam.reason } },
    }
  const known = (await discoverTeams(input.scope, directory, builtins)).find((team) => team.team === validatedTeam.team)
  if (known === undefined)
    return {
      ok: false,
      error: { code: "team.unknown", message: `Unknown team ${validatedTeam.team}`, data: { level: input.scope, team: validatedTeam.team } },
    }
  const teamDir = teamDirFor(input.scope, directory, validatedTeam.team)
  const existing = known.agents.find((agent) => agent.id === input.from)
  const sourcePath = existing?.path ?? teamMemberPath(teamDir, input.from)
  if (existing === undefined || sourcePath === undefined)
    return {
      ok: false,
      error: { code: "agent.missing", message: `Agent ${input.from} does not exist in team ${validatedTeam.team}`, data: { path: teamMemberPath(teamDir, input.from) ?? teamDir } },
    }
  const refusal = refuseProtectedForTool(input.actor, input.from, config) ?? refuseProtectedForTool(input.actor, input.to, config)
  if (refusal !== undefined) return { ok: false, error: refusal }
  const targetPath = teamMemberPath(teamDir, input.to)
  if (targetPath === undefined)
    return {
      ok: false,
      error: { code: "agent.invalid", message: `Invalid agent id "${input.to}"`, data: { id: input.to, reason: `Invalid agent id "${input.to}"` } },
    }
  if (await Bun.file(targetPath).exists())
    return { ok: false, error: { code: "agent.exists", message: `Agent ${input.to} already exists at ${targetPath}`, data: { path: targetPath } } }
  await fs.mkdir(path.dirname(targetPath), { recursive: true })
  try {
    await fs.rename(sourcePath, targetPath)
  } catch (error) {
    const reason = messageOf(error)
    return { ok: false, error: { code: "agent.missing", message: `Agent ${input.from} does not exist at ${sourcePath}: ${reason}`, data: { path: sourcePath } } }
  }
  const source = { level: input.scope, agent: input.from, team: { level: input.scope, team: validatedTeam.team } }
  const delegateFrom = `perm:team_delegate:to.${input.from}`
  const delegateTo = `perm:team_delegate:to.${input.to}`
  const memberIds = known.agents.map((agent) => agent.id)
  const moved = await updateRecords(directory, (current) =>
    current.map((record): StoredRecord => {
      if (!isScopedRow(record)) return record
      // The TUI stores per-member Delegate-to rows without a team, so match
      // them by the owner still being a member of the renamed member's team.
      if (
        record.type === "customization" &&
        record.item === delegateFrom &&
        record.team === undefined &&
        record.level === input.scope &&
        record.agent !== null &&
        memberIds.includes(record.agent)
      ) {
        const renamed = { ...record, item: delegateTo }
        return record.agent === input.from ? { ...renamed, agent: input.to } : renamed
      }
      if (!sameTeam(record.team, { level: input.scope, team: validatedTeam.team })) return record
      // A "Delegate to" row naming the member (owned by a peer in the same
      // team) follows the member id; the file name and the target both move.
      if (record.type === "customization" && record.item === delegateFrom) {
        const renamed = { ...record, item: delegateTo }
        return scopedTo(renamed, source) ? { ...renamed, agent: input.to } : renamed
      }
      return scopedTo(record, source) ? { ...record, agent: input.to } : record
    }),
  )
  if (!moved.ok) {
    await fs.rename(targetPath, sourcePath).catch(() => undefined)
    const reason = "the store changed concurrently; retry"
    return { ok: false, error: { code: "agent.invalid", message: `Could not rename ${input.from}: ${reason}`, data: { id: input.from, reason } } }
  }
  await Effect.runPromise(ctx.agent.reload())
  await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins, true))
  await Effect.runPromise(emitTeamsChanged(state))
  await logFileOp({
    directory,
    actor: normalizeActor(input.actor),
    scope: input.scope === "project" ? "project" : "global",
    op: "agent.rename",
    target: targetPath,
    summary: `agent.rename ${input.from} to ${input.to} (${input.scope} team ${validatedTeam.team})`,
  })
  return { ok: true, value: { from: input.from, to: input.to, path: targetPath } }
}

// T6: rename an on-disk team. The team directory moves and every stored record
// that names the team — its enablement row, links and every team-scoped row of
// its members — moves with it in one revision. Defaults (shipped) teams are
// refused; only Project and Global teams have directories.
async function renameTeamAt(
  ctx: Context,
  state: PlusState,
  builtins: readonly BuiltinTeam[],
  directory: string,
  config: { readonly protectedAgents: readonly string[] },
  input: { readonly level: "project" | "global"; readonly from: string; readonly to: string; readonly actor?: Plus.Actor },
): Promise<RenameTeamResult> {
  const from = validateTeamName(input.from)
  if (!from.ok)
    return { ok: false, error: { code: "team.invalid", message: from.reason, data: { team: input.from, reason: from.reason } } }
  const to = validateTeamName(input.to)
  if (!to.ok)
    return { ok: false, error: { code: "team.invalid", message: to.reason, data: { team: input.to, reason: to.reason } } }
  const known = (await discoverTeams(input.level, directory, builtins)).find((team) => team.team === from.team)
  if (known === undefined)
    return { ok: false, error: { code: "team.unknown", message: `Unknown team ${from.team}`, data: { level: input.level, team: from.team } } }
  const refusal = refuseProtectedForTool(input.actor, known.agents.find((member) => config.protectedAgents.includes(member.id))?.id, config)
  if (refusal !== undefined) return { ok: false, error: refusal }
  const teamsRoot = input.level === "project" ? projectTeamsPath(directory) : globalTeamsPath()
  const sourceDir = path.join(teamsRoot, from.team)
  const targetDir = path.join(teamsRoot, to.team)
  let realSource: string
  let realRoot: string
  try {
    realSource = await fs.realpath(sourceDir)
    realRoot = await fs.realpath(teamsRoot)
  } catch {
    return { ok: false, error: { code: "team.unknown", message: `Team directory "${from.team}" not found`, data: { level: input.level, team: from.team } } }
  }
  const rel = path.relative(realRoot, realSource)
  if (rel.startsWith("..") || path.isAbsolute(rel) || rel === "")
    return {
      ok: false,
      error: { code: "team.invalid", message: `Team directory "${from.team}" is outside teams root`, data: { team: from.team, reason: `Team directory "${from.team}" is outside teams root` } },
    }
  if (await fs.stat(targetDir).then(() => true, () => false))
    return { ok: false, error: { code: "team.exists", message: `Team ${to.team} already exists`, data: { level: input.level, team: to.team } } }
  try {
    await fs.rename(sourceDir, targetDir)
  } catch (error) {
    const reason = messageOf(error)
    return { ok: false, error: { code: "team.invalid", message: `Could not rename team ${from.team}: ${reason}`, data: { team: from.team, reason } } }
  }
  const moved = await updateRecords(directory, (current) =>
    current.map((record): StoredRecord => {
      if (record.type === "team") return record.level === input.level && record.team === from.team ? { ...record, team: to.team } : record
      if (isScopedRow(record) && record.team !== undefined && record.team.level === input.level && record.team.team === from.team)
        return { ...record, team: { level: input.level, team: to.team } }
      return record
    }),
  )
  if (!moved.ok) {
    await fs.rename(targetDir, sourceDir).catch(() => undefined)
    const reason = "the store changed concurrently; retry"
    return { ok: false, error: { code: "team.invalid", message: `Could not rename team ${from.team}: ${reason}`, data: { team: from.team, reason } } }
  }
  await Effect.runPromise(ctx.agent.reload())
  await Effect.runPromise(refreshAfterFileChange(ctx, state, directory, builtins, true))
  await Effect.runPromise(emitTeamsChanged(state))
  await logFileOp({
    directory,
    actor: normalizeActor(input.actor),
    scope: input.level,
    op: "team.rename",
    target: `team:${input.level}:${to.team}`,
    summary: `team.rename ${from.team} to ${to.team} (${input.level})`,
  })
  return { ok: true, value: { level: input.level, from: from.team, to: to.team, path: targetDir } }
}

function isTeamRecord(record: StoredRecord): record is TeamRecord {
  return record.type === "team"
}

function modelsOf(records: readonly StoredRecord[]): ModelRecord[] {
  return records.filter((record): record is ModelRecord => record.type === "model")
}

function modelSettingsOf(records: readonly StoredRecord[]): ModelSettingsRecord[] {
  return records.filter((record): record is ModelSettingsRecord => record.type === "modelSettings")
}

function rulesOf(records: readonly StoredRecord[]): RuleRecord[] {
  return records.filter((record): record is RuleRecord => record.type === "rule")
}

function modelRecordTarget(record: ModelRecord): string {
  const teamPrefix = record.team !== undefined ? `${record.team.level}:${record.team.team}:` : ""
  return `model:${teamPrefix}${record.level}:${record.agent ?? ""}:${record.providerID}/${record.modelID}${record.variant === undefined ? "" : `@${record.variant}`}`
}

function ruleRecordTarget(record: RuleRecord): string {
  const owner = record.catalogue === undefined && record.team === undefined ? "" : `:${JSON.stringify([record.catalogue ?? "agents", record.team ?? null])}`
  return `rule:${record.level}:${record.agent ?? ""}:${record.tool}:${record.id}${owner}`
}

function validateRuleRef(
  tool: string,
  id: string,
  label: string,
  patterns: readonly string[],
  keywords?: readonly string[],
  message?: string,
): { ok: true; tool: string; id: string; label: string; patterns: string[]; keywords: string[]; message?: string } | { ok: false; reason: string } {
  return validateRuleInput({ tool, id, label, patterns, ...(keywords === undefined ? {} : { keywords }), ...(message === undefined ? {} : { message }) })
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

// T3: protection is decided at the API boundary, not only in the tool
// wrappers. A tool-originated write that addresses a protected agent's row is
// refused no matter which surface forwarded it (tools, the RPC, or
// instructions.mutate with a caller-supplied actor). A missing actor means the
// TUI, and TUI writes are never refused. `agentId` is the owner of the row
// being written (null for shared rows). Returns the declared error the caller
// must fail with, or undefined when the write may proceed.
function refuseProtectedForTool(
  actor: Plus.Actor | undefined,
  agentId: string | null | undefined,
  config: { readonly protectedAgents: readonly string[] },
): { code: "agent.protected"; message: string; data: Plus.AgentProtected } | undefined {
  if (!isToolActor(normalizeActor(actor).type)) return undefined
  if (agentId === null || agentId === undefined || agentId === "") return undefined
  if (!config.protectedAgents.includes(agentId)) return undefined
  const reason = `agent.protected: row belongs to protected agent "${agentId}"`
  return { code: "agent.protected" as const, message: reason, data: { agent: agentId, reason } }
}

// A delete handler's item-record cascade drops every customization and split
// addressed to the deleted item, including rows owned by other agents. That
// cascade is a write too, so a tool actor may not trigger it while any of
// those rows belongs to a protected agent; otherwise deleting a shared row
// would silently erase a protected agent's own override. Same refusal shape
// and same TUI exemption as refuseProtectedForTool. Callers must run this
// before any write, including a file delete, so a refusal leaves the store,
// the file and the log untouched.
function refuseProtectedItemCascade(
  actor: Plus.Actor | undefined,
  records: readonly StoredRecord[],
  item: string,
  config: { readonly protectedAgents: readonly string[] },
): { code: "agent.protected"; message: string; data: Plus.AgentProtected } | undefined {
  if (!isToolActor(normalizeActor(actor).type)) return undefined
  const owner = records.find(
    (record): record is CustomizationRecord | SplitRecord =>
      (record.type === "customization" || record.type === "split") &&
      record.item === item &&
      record.agent !== null &&
      config.protectedAgents.includes(record.agent),
  )?.agent
  return refuseProtectedForTool(actor, owner, config)
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

// Validation reads the cached catalogue, and on a miss reads it once more: a
// model can arrive without a host change Plus observes (a provider plugin's
// catalogue sync, a fresh /connect), and a real pick must not be refused for
// a stale cache.
async function catalogKnows(ctx: Context, state: PlusState, providerID: string, modelID: string, variant?: string): Promise<boolean> {
  if (hostCatalogHas(await hostModelsFor(ctx, state), providerID, modelID, variant)) return true
  state.hostCatalog = undefined
  state.hostModels = undefined
  return hostCatalogHas(await hostModelsFor(ctx, state), providerID, modelID, variant)
}

function hostCatalogHas(
  hostModels: readonly HostModel[],
  providerID: string,
  modelID: string,
  variant?: string,
): boolean {
  const found = hostModels.find((entry) => entry.providerID === providerID && entry.modelID === modelID)
  if (found === undefined) return false
  if (variant === undefined) return true
  return found.variants.includes(variant)
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

async function removeItemRecords(
  directory: string,
  loaded: LoadedStores,
  item: string,
): Promise<{ ok: true; changed: boolean } | { ok: false }> {
  const attempt = (records: readonly StoredRecord[]) => {
    const drop = (record: StoredRecord) =>
      (record.type === "customization" || record.type === "split") && record.item === item
    if (!records.some(drop)) return undefined
    return records.filter((record) => !drop(record)) as readonly StoredRecord[]
  }
  const changedOf = (changed: { readonly project: boolean; readonly global: boolean }) =>
    changed.project || changed.global
  const first = attempt(loaded.records)
  if (first === undefined) return { ok: true, changed: false }
  const saved = await save(directory, {
    expectedProjectRevision: loaded.projectRevision,
    expectedGlobalRevision: loaded.globalRevision,
    records: first,
  })
  if (saved.ok) return { ok: true, changed: changedOf(saved.changed) }
  const fresh = await load(directory)
  const second = attempt(fresh.records)
  if (second === undefined) return { ok: true, changed: false }
  const retried = await save(directory, {
    expectedProjectRevision: fresh.projectRevision,
    expectedGlobalRevision: fresh.globalRevision,
    records: second,
  })
  if (retried.ok) return { ok: true, changed: changedOf(retried.changed) }
  return { ok: false }
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

// Protected rows refuse a tool actor. The CLI (`opencodeplus instructions …`,
// B18) runs the same tool implementation with the actor recorded as `cli`, so
// it is refused exactly like the model path.
function isToolActor(type: Plus.Actor["type"]): boolean {
  return type === "tool" || type === "cli"
}

function mutateTarget(rows: readonly StoredRecord[]): string {
  const first = rows[0]
  if (first === undefined) return "records"
  return recordTarget(first)
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
    await appendForLevel(input.directory, "project", {
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
  await appendForLevel(input.directory, input.scope, {
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

// The one place the load-time migrations reach disk. `load` already applies
// them in memory — every shared Defaults row is duplicated into the Teams
// catalogue, and every link or customization of a retired Plus preset moves to
// the Basic team preset — so resolution is correct from the first read; this
// persists what moved as one revision and logs each migration once.
// Idempotent: a migrated store finds nothing to do and logs nothing.
async function loadMigrated(directory: string): Promise<Awaited<ReturnType<typeof load>>> {
  const migration = await ensureCatalogues(directory)
  if (migration.migrated)
    await append(globalLogPath(), {
      ts: new Date().toISOString(),
      actor: { type: "tui" as const },
      op: "migrate.catalogues",
      target: "root:defaults",
      summary: "migrate.catalogues: shared Defaults rows copied into the Teams catalogue",
      revision: migration.revision,
    })
  if (migration.presetsMigrated)
    await append(globalLogPath(), {
      ts: new Date().toISOString(),
      actor: { type: "tui" as const },
      op: "migrate.presets",
      target: "root:preset",
      summary: "migrate.presets: retired Plus preset links and customizations moved to the Basic team",
      revision: migration.revision,
    })
  if (migration.skillsMigrated)
    await append(globalLogPath(), {
      ts: new Date().toISOString(),
      actor: { type: "tui" as const },
      op: "migrate.skills",
      target: "root:defaults",
      summary: "migrate.skills: per-skill permission rows' states moved onto the skills (one switch per skill)",
      revision: migration.revision,
    })
  if (migration.splitsMigrated)
    await append(globalLogPath(), {
      ts: new Date().toISOString(),
      actor: { type: "tui" as const },
      op: "migrate.splits",
      target: "root:defaults",
      summary: "migrate.splits: git merge and git worktree add rows took the state of the shell family they were split from",
      revision: migration.revision,
    })
  return migration.loaded
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
      ...(record.team !== undefined ? { team: record.team } : {}),
      ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
      item: record.item,
      boundaries: record.boundaries.map((boundary) => ({ ...boundary })),
      updated: record.updated,
    }
  if (record.type === "model")
    return {
      type: "model",
      level: record.level,
      agent: record.agent,
      ...(record.team !== undefined ? { team: record.team } : {}),
      ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
      providerID: record.providerID,
      modelID: record.modelID,
      ...(record.variant === undefined ? {} : { variant: record.variant }),
      ...(record.active === undefined ? {} : { active: record.active }),
      ...(record.basedOn === undefined ? {} : { basedOn: record.basedOn }),
      ...(record.warming === undefined ? {} : { warming: record.warming }),
      ...(record.interval === undefined ? {} : { interval: record.interval }),
      ...(record.waiting === undefined ? {} : { waiting: record.waiting }),
      ...(record.subagent === undefined ? {} : { subagent: record.subagent }),
      ...(record.prompt === undefined ? {} : { prompt: record.prompt }),
      ...(record.compactWarm === undefined ? {} : { compactWarm: record.compactWarm }),
      ...(record.coldFirst === undefined ? {} : { coldFirst: record.coldFirst }),
      ...(record.coldCompact === undefined ? {} : { coldCompact: record.coldCompact }),
      ...(record.coldModels === undefined ? {} : { coldModels: [...record.coldModels] }),
      ...(record.compactionStrategy === undefined ? {} : { compactionStrategy: record.compactionStrategy }),
      ...(record.compactionModel === undefined ? {} : { compactionModel: record.compactionModel }),
      ...(record.compactionInstructions === undefined ? {} : { compactionInstructions: record.compactionInstructions }),
      ...(record.imageConvert === undefined ? {} : { imageConvert: record.imageConvert }),
      ...(record.imageShrink === undefined ? {} : { imageShrink: record.imageShrink }),
      ...(record.imagesFull === undefined ? {} : { imagesFull: record.imagesFull }),
      ...(record.compactionInput === undefined ? {} : { compactionInput: record.compactionInput }),
      ...(record.compactionOutput === undefined ? {} : { compactionOutput: record.compactionOutput }),
      ...(record.removed === undefined ? {} : { removed: record.removed }),
      ...(record.originalCandidate === undefined
        ? {}
        : {
            originalCandidate: {
              providerID: record.originalCandidate.providerID,
              modelID: record.originalCandidate.modelID,
              ...(record.originalCandidate.variant === undefined ? {} : { variant: record.originalCandidate.variant }),
              ...(record.originalCandidate.source === undefined ? {} : { source: record.originalCandidate.source }),
              ...(record.originalCandidate.editedFields === undefined ? {} : { editedFields: [...record.originalCandidate.editedFields] }),
            },
          }),
      updated: record.updated,
    }
  if (record.type === "rule")
    return {
      type: "rule",
      level: record.level,
      agent: record.agent,
      ...(record.team !== undefined ? { team: record.team } : {}),
      ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
      tool: record.tool,
      id: record.id,
      label: record.label,
      patterns: [...record.patterns],
      keywords: [...record.keywords],
      ...(record.message === undefined ? {} : { message: record.message }),
      updated: record.updated,
    }
  if (record.type === "rowlink")
    return {
      type: "rowlink",
      level: record.level,
      agent: record.agent,
      ...(record.team !== undefined ? { team: record.team } : {}),
      ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
      item: record.item,
      section: record.section,
      target: record.target,
      targetSection: record.targetSection,
      link: record.link,
      ...(record.enabled === undefined ? {} : { enabled: record.enabled }),
      updated: record.updated,
    }
  return {
    type: "customization",
    level: record.level,
    agent: record.agent,
    ...(record.team !== undefined ? { team: record.team } : {}),
    ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
    item: record.item,
    section: record.section,
    ...(record.text === undefined ? {} : { text: record.text }),
    ...(record.state === undefined ? {} : { state: record.state }),
    ...(record.pin === undefined ? {} : { pin: record.pin }),
    ...(record.requires === undefined ? {} : { requires: [...record.requires] }),
    basedOn: record.basedOn,
    ...(record.basedOnText === undefined ? {} : { basedOnText: record.basedOnText }),
    ...(record.acknowledged === undefined ? {} : { acknowledged: record.acknowledged }),
    ...(record.basedOnState === undefined ? {} : { basedOnState: record.basedOnState }),
    ...(record.basedOnPin === undefined ? {} : { basedOnPin: record.basedOnPin }),
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
async function resolveBaseTemplates(
  ctx: Context,
  catalog: readonly Model.Info[],
): Promise<{ templates: BaseTemplate[]; active: (agent: Agent.Info) => string | undefined }> {
  const templates = await Effect.runPromise(ctx.prompt.templates())
  const user = readUserBaseTemplates().map((template) => ({ ...template, user: true as const }))
  const userIds = new Set(user.map((template) => template.id))
  const listed =
    templates.length === 0
      ? [...fallbackBaseTemplates().filter((template) => !userIds.has(template.id)), ...user]
      : [...templates.filter((template) => !userIds.has(template.id)).map((template) => ({ ...template })), ...user]
  const fallback = await Effect.runPromise(
    ctx.model
      .default()
      .pipe(
        Effect.catchCause(() =>
          Effect.succeed({ data: undefined as Model.Info | undefined, location: { directory: ctx.location.directory } }),
        ),
      ),
  )
  const active = (agent: Agent.Info): string | undefined => {
    const model = resolveCatalogModel(agent, catalog, fallback.data)
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

// One provider-catalogue read per Plus instance. The catalogue is the slow
// part of building a snapshot (an Instructions navigation), so cache it here
// and let the pickers and Defaults › Models share it. `refreshFromHost` clears
// the cache when the host's config, agents or skills change, which is when the
// catalogue can move.
async function hostModelsFor(ctx: Context, state: PlusState): Promise<readonly HostModel[]> {
  await hostCatalogFor(ctx, state)
  return state.hostModels ?? []
}

// The one `ctx.model.list()` call: reads the raw catalogue once and derives
// the cached host models from the same answer, so base-template
// classification, discovery, validation and the per-request classifier all
// share one read instead of each listing the catalogue.
async function hostCatalogFor(ctx: Context, state: PlusState): Promise<readonly Model.Info[]> {
  if (state.hostCatalog === undefined || state.hostCatalogAt === undefined || Date.now() - state.hostCatalogAt >= HOST_CATALOG_TTL_MS) {
    const listed = await Effect.runPromise(
      ctx.model.list().pipe(
        Effect.catchCause(() =>
          Effect.succeed({ data: [] as readonly Model.Info[], location: { directory: ctx.location.directory } }),
        ),
      ),
    )
    state.hostCatalog = listed.data
    state.hostCatalogAt = Date.now()
    state.hostModels = hostModelsFrom(listed.data)
  }
  return state.hostCatalog
}

// Provider catalogues move without a host event Plus watches (models.dev
// refreshes, provider syncs). model.updated drops the cache at once; this bound
// covers the rest.
const HOST_CATALOG_TTL_MS = 5 * 60 * 1000

export const discoverCounter = { count: 0 }
export function resetDiscoverCounter(): void {
  discoverCounter.count = 0
}

async function discoverAll(
  ctx: Context,
  loaded: LoadedStores,
  state: PlusState,
  builtins: readonly BuiltinTeam[],
  // The project directory this publish belongs to: a run session in a child
  // worktree activates through the run record's projectDirectory, so team rows
  // resolve against the parent project, not the copy-free worktree.
  directory: string = ctx.location.directory,
): Promise<Discovered> {
  discoverCounter.count++
  const at = ctx.location.directory
  if (state.agentObserver === undefined) {
    refreshPhase(at, "discover: agent observer")
    state.agentObserver = await runRegistration(ctx.agent.transform, (editor: AgentEditor) => {
      state.agentUpstream = structuredClone(editor.list())
    })
  }
  refreshPhase(at, "discover: host catalog and base templates")
  const resolved = await resolveBaseTemplates(ctx, await hostCatalogFor(ctx, state))
  refreshPhase(at, "discover: teams")
  const teams = await discoverAllTeams(directory, builtins)
  // Read before discovery reads the registry: a change in between shows as a
  // difference later and costs one more (unchanged) publish, never a miss.
  refreshPhase(at, "discover: tool list")
  const registry = await Effect.runPromise(ctx.tool.list())
  state.discoveredTools = new Set(registry.map((tool) => tool.id))
  // Remember what each connected MCP server registered, for the next start.
  state.knownMcpTools ??= await loadKnownMcpTools()
  const learned = learnMcpTools(state.knownMcpTools, registry)
  if (learned !== undefined) {
    state.knownMcpTools = learned
    await saveKnownMcpTools(learned).catch(() => undefined)
  }
  refreshPhase(at, "discover: host rows (agents, models, MCP, skills, files)")
  const discovered = await discover({
    ctx,
    records: customizationsOf(loaded.records),
    baselines: state.baselines,
    baseTemplates: resolved.templates,
    activeBase: (agent) => resolved.active(agent),
    modelRecords: modelsOf(loaded.records),
    ruleRecords: rulesOf(loaded.records),
    modelBaselines: state.modelBaselines,
    presetState: presetStateOf(loaded.records),
    teams: teams.map((team) => ({ team: team.team, agents: team.agents.map((agent) => agent.id) })),
    agentUpstream: state.agentUpstream,
    splits: splitsOf(loaded.records),
    knownMcpTools: state.knownMcpTools,
    hostModels: await hostModelsFor(ctx, state),
  })
  refreshPhase(at, "discover: member controls and team rows")
  const memberControls = (await Promise.all(teams.flatMap((team) => team.agents.map(async (member) => {
    // Member installation overlays host agents, so omitted file fields inherit
    // the same pre-Plus values rather than synthetic control defaults.
    const upstream = state.agentUpstream?.find((agent) => agent.id === member.id)
    const fields = member.path === undefined
      ? builtins.find((entry) => entry.name === team.team)?.members.find((entry) => entry.id === member.id)?.fields
      : parseTeamFields(await fs.readFile(member.path, "utf8"))
    return controlItems(member.id, {
      ...upstream,
      ...fields,
      steps: (fields?.steps ?? upstream?.steps) as Agent.Info["steps"],
    })
      .map((item) => ({ ...item, controlTeam: { level: team.level, team: team.team } }))
  })))).flat()
  return {
    ...discovered,
    items: [...discovered.items, ...memberControls, ...(await teamPolicyRows(loaded, discovered, builtins, state.teamOutputIds, directory))],
  }
}

// Per-member team rows (Delegate to, run edit scopes) join the inventory here, where the enabled teams are
// already resolvable: the tree lists them, the query engine filters them and
// apply installs whatever they resolve to, exactly like a discovered row.
//
// Members must resolve against the same filtered view the publish path builds,
// never the raw discovery: once Plus has installed a member, the host reports
// it back as an ordinary unbacked defaults agent, and resolveTeams would read
// that echo as a shadowing regular of equal rank and drop every member. Plus
// ownership (recorded ids, else the shipped-body match) is what tells the two
// apart; approximating it by id would let a team member beat a genuine host
// built-in of the same name.
async function teamPolicyRows(
  loaded: LoadedStores,
  discovered: Discovered,
  builtins: readonly BuiltinTeam[],
  owned: ReadonlyMap<string, TeamOwnership>,
  directory: string,
): Promise<Item[]> {
  const outputIds = await snapshotOutputIds(directory, discovered, loaded, builtins, owned)
  const members = await resolveAllTeamAgents(
    directory,
    loaded.records.filter(isTeamRecord),
    filteredPublishAgents(discovered.agents, outputIds),
    builtins,
  )
  if (members.length === 0) return []
  return teamPolicyItems(policyMembersOf(members.map((agent) => ({ id: agent.id, team: agent.team }))), await liveRunScopes(teamsDataDir()))
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
  const ordered = [
    ...agents.filter((agent) => agent.team !== undefined),
    ...agents.filter((agent) => agent.team === undefined),
  ]
  for (const agent of dedupeAgents(ordered)) {
    const team = agent.team === undefined ? undefined : { level: scopeLevel(agent.scope), team: agent.team }
    const runtime = runtimeScope({ id: agent.id, level: scopeLevel(agent.scope), ...(team === undefined ? {} : { team }) }, scopes)
    const winner = resolveActiveModel({
      models,
      scopes: runtime.scopes,
      level: runtime.level,
      agent: agent.id,
      ...(team === undefined ? {} : { team }),
    })
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

// The plugin's activation step, exported for tests that drive install/dispose
// directly: with project mode gone there is no RPC method that activates.
export function activate(ctx: Context, state: PlusState): Effect.Effect<void, never, never> {
  return Effect.gen(function* () {
    // A run session's worktree is outside its parent's tree. The run record
    // names the project directory its delegate ran from; every other Location
    // resolves from its own directory, upward (project.read).
    const directory = yield* Effect.promise(() => activationDirectory(ctx.location.directory))
    yield* ensureTooling(ctx, state)
    const stored = yield* Effect.promise(() => loadCurrent(directory))
    yield* publishFresh(ctx, state, stored)
  })
}

// The directory a Location activates against: the project directory recorded by
// the run that owns this worktree, else the Location's own directory.
export async function activationDirectory(directory: string): Promise<string> {
  const run = await byDirectory(teamsDataDir(), directory)
  return run?.projectDirectory ?? directory
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
  const tools = await registerInstructionTools(ctx, withCliActor(api))
  // The release namespace records intents and reads them back; it grants no
  // authority, so it installs with the rest of the tooling rather than behind one.
  const release = await registerReleaseTools(ctx)
  const monitor = await registerMonitorTools(ctx)
  const refresh = await registerRefreshTool(ctx, api)
  const search = await registerSearchMcp(ctx)
  const base = [...teaching, tools, release, monitor, refresh]
  return search !== undefined ? [...base, search] : base
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

// Team tools only. Team rules are instructions rows applied by apply.ts, so
// there is no permission hook to install here.
async function installTeamTooling(ctx: Context, state: PlusState): Promise<Registration[]> {
  return [await registerTeamTools(ctx, createTeamApi(ctx, state), () => state.permissions, (agent) => state.teamOutputIds.get(agent)?.team)]
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
  const stored = await loadMigrated(directory)
  return { ...stored, protectedAgents: config.protectedAgents }
}

export function deactivate(state: PlusState): Effect.Effect<void> {
  return state.semaphore.withPermits(1)(
    Effect.gen(function* () {
      yield* disposeApplied(state)
      if (state.agentObserver !== undefined) yield* state.agentObserver.dispose
      state.agentObserver = undefined
      state.agentUpstream = undefined
      state.discoveredTools = undefined
      yield* disposeTooling(state)
      yield* disposeTeamTooling(state)
      state.fingerprint = undefined
      state.snapshotCache = undefined
      state.projectRevision = undefined
      state.globalRevision = undefined
      state.baselines = new Map()
      state.modelBaselines = new Map()
      state.activeModels = new Map()
      state.cachedModels = []
      state.cachedModelSettings = []
      state.cachedAgents = []
      state.cachedScopes = { global: new Set(), defaults: new Set() }
      state.attentionRows = new Map()
      state.teamOutputIds = new Map()
      state.hostModels = undefined
      state.hostCatalog = undefined
    }),
  )
}

function refreshAfterFileChange(
  ctx: Context,
  state: PlusState,
  directory: string,
  builtins: readonly BuiltinTeam[] = [],
  force = false,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    // A file op (agent/skill/base/team/... create or delete) can change what a
    // snapshot contains without moving a store revision — a team is a
    // directory of files, not a record — and can leave the publish fingerprint
    // unchanged (an empty team contributes no body). Bump before publishing so
    // no read can answer from the pre-op snapshot.
    state.snapshotGeneration++
    const stored = yield* Effect.promise(() => loadCurrent(directory))
    yield* publishFresh(ctx, state, stored, builtins, force)
  })
}

function winningEnabledTeams(
  discovered: readonly { level: TeamLevel; team: string }[],
  records: readonly TeamRecord[],
): { level: TeamLevel; team: string }[] {
  const enabled = discovered.filter((t) => isTeamEnabled(records, t.level, t.team))
  const sorted = [...enabled].sort((a, b) => rankOf(a.level) - rankOf(b.level))
  const seen = new Set<string>()
  const winners: { level: TeamLevel; team: string }[] = []
  for (const team of sorted) {
    if (!seen.has(team.team)) {
      seen.add(team.team)
      winners.push(team)
    }
  }
  return winners
}

const specialAgentIds = ["title"] as const

function computeSpecialOverrides(
  winningEnabled: readonly { level: TeamLevel; team: string }[],
  discovered: Discovered,
  records: readonly StoredRecord[],
  scopes: Scopes,
): {
  specialAgents: AgentSource[]
  specialRoleOverrides: Map<string, string>
} {
  const customizations = customizationsOf(records)
  const splits = splitsOf(records)
  const modelRecords = modelsOf(records)
  const specialAgents: AgentSource[] = []
  const specialRoleOverrides = new Map<string, string>()

  for (const team of winningEnabled) {
    for (const specialId of specialAgentIds) {
      // Every Special agent the host runs (or one the team gives an active
      // model) resolves with the enabled team's chain — its tool, permission
      // and skill rows under Teams → <team> → Special included — not only when
      // the team sets its model. The discovered fields (base, model) stay.
      const teamAddress = { level: team.level, agent: specialId, team: { level: team.level, team: team.team } }
      const host = discovered.agents.find((agent) => agent.id === specialId)
      if (host !== undefined || hasModelActiveAt(modelRecords, teamAddress)) {
        specialAgents.push({
          ...host,
          id: specialId,
          scope: team.level,
          team: team.team,
          origin: "special",
        })
      }

      const roleRecord = customizations.find(
        (r) =>
          r.item === "system:role" &&
          r.agent === specialId &&
          r.level === team.level &&
          r.team?.level === team.level &&
          r.team?.team === team.team,
      )
      if (roleRecord !== undefined && (roleRecord.text !== undefined || roleRecord.state !== undefined)) {
        const roleItem = discovered.items.find((i) => i.id === "system:role" && i.agents?.includes(specialId)) ?? {
          id: "system:role",
          kind: "system" as const,
          group: "none" as const,
          title: "system:role",
          text: "",
          enabled: true,
          fingerprint: "",
        }
        const resolvedRole = resolve({
          upstream: roleItem,
          records: customizations,
          splits,
          scopes,
          address: {
            level: team.level,
            agent: specialId,
            item: "system:role",
            section: null,
            team: { level: team.level, team: team.team },
          },
        })
        if (resolvedRole.modified || resolvedRole.overriddenHere) {
          specialRoleOverrides.set(specialId, resolvedRole.assembled)
        }
      }
    }
  }
  return { specialAgents, specialRoleOverrides }
}

/**
 * The agents a publish applies and the chain context it applies them with:
 * the team winners (members and the enabled team's Special agents, each with
 * its team) ahead of the discovered agents, deduplicated, and the full
 * context over all of them. publishFresh installs from this; the assembled
 * readback resolves from the same answer, so both read one chain per agent.
 */
async function publishChain(
  discovered: Discovered,
  records: readonly StoredRecord[],
  directory: string,
  builtins: readonly BuiltinTeam[],
  owned: ReadonlyMap<string, TeamOwnership>,
) {
  const view = await stablePublishView(discovered, records, directory, builtins, owned)
  const teamRecords = records.filter(isTeamRecord)
  const allDiscoveredTeams = await discoverAllTeams(directory, builtins)
  const winningEnabled = winningEnabledTeams(allDiscoveredTeams, teamRecords)
  const { specialAgents, specialRoleOverrides } = computeSpecialOverrides(
    winningEnabled,
    discovered,
    records,
    contextFor(discovered.agents, discovered.items, records, allDiscoveredTeams),
  )

  // Team-provided agents are not host upstream on the first publish
  // after enable or restart: discovered.agents lacks team-only ids, so
  // the model cache and apply would never see them. When an id is both
  // host-discovered (unbacked defaults) and a current team winner, the team
  // winner's scope is authoritative for model resolution and state.activeModels:
  // order team winners first so dedupe keeps the team winner's scope,
  // preserving discovered fields (such as base and model) on the team winner entry.
  // Retaining discovered.agents in mergedAgents ensures the chain context
  // still sees defaults for fallback inheritance. The context is the full
  // one (links, entries, presets, member teams): the model cache, apply
  // and the refresh-time model rebuild all read it.
  const teamMerged = [
    ...specialAgents,
    ...view.teamAgents.map((teamAgent) => {
      const discoveredAgent = discovered.agents.find((agent) => agent.id === teamAgent.id)
      return discoveredAgent !== undefined
        ? { ...discoveredAgent, ...teamAgent, scope: teamAgent.scope }
        : teamAgent
    }),
  ]
  const mergedAgents = [...teamMerged, ...discovered.agents]
  return {
    view,
    teams: allDiscoveredTeams,
    specialRoleOverrides,
    publishAgents: dedupeAgents(mergedAgents),
    publishScopes: contextFor(mergedAgents, discovered.items, records, allDiscoveredTeams),
  }
}

// What apply receives per published agent: a team winner carries its team.
function applyAgentsOf(agents: readonly AgentSource[]): ApplyAgent[] {
  return agents.map((agent) => ({
    id: agent.id,
    level: scopeLevel(agent.scope),
    base: agent.base,
    ...(agent.team !== undefined ? { team: { level: scopeLevel(agent.scope), team: agent.team } } : {}),
  }))
}

// Only publishFresh and deactivate acquire the semaphore, and neither calls the
// other, so a caller never blocks on a permit it already holds.
function publishFresh(
  ctx: Context,
  state: PlusState,
  stored: LoadedStores,
  builtins: readonly BuiltinTeam[] = [],
  force = false,
): Effect.Effect<Discovered> {
  const at = ctx.location.directory
  refreshPhase(at, "publish: waiting for the location lock")
  return state.semaphore.withPermits(1)(
    Effect.gen(function* () {
      // The project directory this publish applies to. Activation resolves a
      // run session's worktree to the project directory its record names; the
      // team discoveries below must use the same directory, or a child
      // worktree would report and install an empty project.
      const directory = yield* Effect.promise(() => activationDirectory(ctx.location.directory))
      const discovered = yield* Effect.promise(() => discoverAll(ctx, stored, state, builtins, directory))
      refreshPhase(at, "publish: chain")
      yield* Effect.yieldNow
      // A newer publish already won; this read is stale, so leave the applied
      // registrations and the last emitted revision untouched.
      if (state.projectRevision !== undefined && stored.projectRevision < state.projectRevision) return discovered
      if (state.globalRevision !== undefined && stored.globalRevision < state.globalRevision) return discovered
      const customizations = customizationsOf(stored.records)
      const splits = splitsOf(stored.records)
      const modelRecords = modelsOf(stored.records)
      const { view, teams, specialRoleOverrides, publishAgents, publishScopes } = yield* Effect.promise(() =>
        publishChain(discovered, stored.records, directory, builtins, state.teamOutputIds),
      )
      yield* Effect.yieldNow
      state.activeModels = buildActiveModels(publishAgents, modelRecords, publishScopes)
      state.cachedModels = modelRecords
      state.cachedModelSettings = modelSettingsOf(stored.records)
      state.cachedAgents = publishAgents.map((agent) => ({ ...agent }))
      state.cachedScopes = publishScopes
      const fingerprint = JSON.stringify({
        // Mined perm rows are view-time only and stay out, but team policy
        // rows are derived state that must move the fingerprint: a run
        // starting or settling changes what a member may edit.
        items: view.items.filter((item) => item.kind !== "perm" || item.policy !== undefined || item.agents !== undefined),
        agents: view.agents,
        servers: discovered.servers,
        records: stored.records,
        teamBodies: view.teamBodies,
        overrides: [...view.overrides].toSorted((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)),
        specialOverrides: [...specialRoleOverrides].toSorted((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0)),
        scopes: { global: [...view.scopes.global].toSorted(), defaults: [...view.scopes.defaults].toSorted() },
      })
      // Catalogue-only changes do not alter installed instructions. They still
      // invalidate open views, without reinstalling unchanged agent/tool rows.
      const hostModels = JSON.stringify(discovered.hostModels)
      const catalogueChanged = hostModels !== state.publishedHostModels
      state.publishedHostModels = hostModels
      if (state.projectRevision !== undefined && fingerprint === state.fingerprint) {
        if (!force && !catalogueChanged) return discovered
        // Core debounces its own reload, so a just-written agent file cannot
        // move the fingerprint yet; the file mutation itself is the change.
        state.snapshotGeneration++
        yield* emitChanged(state, stored.projectRevision, stored.globalRevision)
        return discovered
      }
      // The per-request base classifier reads the cached catalogue instead
      // of listing the provider catalogue on every publish.
      refreshPhase(at, "publish: host catalog")
      const catalog = yield* Effect.promise(() => hostCatalogFor(ctx, state))
      // The installed state changed: the snapshot cache key must move so the
      // next read rebuilds instead of answering from the old registrations.
      state.snapshotGeneration++
      const applyInput: ApplyInput = {
        items: discovered.items,
        // Discovery keeps shadowed identities for scope resolution and the UI;
        // runtime application uses the first (effective) identity per id.
        agents: applyAgentsOf(publishAgents),
        records: customizations,
        splits,
        scopes: publishScopes,
        models: modelRecords,
        rules: rulesOf(stored.records),
        catalog,
        teamAgents: view.teamAgents.map((agent) => agent.id),
        orders: stored.records.filter((record): record is OrderRecord => record.type === "order"),
        enforcement: state.enforcement,
        enforcementDeps: {
          headless: async (sessionID) => (await bySession(teamsDataDir(), sessionID))?.kind === "w",
          instructions: async () => {
            const snapshot = await createPlusApi(ctx, state, { builtins }).snapshot()
            return memoInputOf(snapshot.value)
          },
        },
        deferAgentControls: true,
      }
      state.attentionRows = attentionRowsOf(applyInput)
      const teamAgents = view.teamAgents
      const fileAgents = teamAgents.filter((agent) => agent.path !== undefined)
      const builtinWinners = teamAgents.filter((agent) => agent.path === undefined)
      const teamRoleOverrides = view.overrides

      // One core batch for the whole install/dispose set: the host rebuilds
      // and reconciles each registry once per publish.
      refreshPhase(at, "publish: apply batch")
      const partsResult = yield* inPublishBatch(ctx.batch, () =>
        applyPublishParts(ctx, state, {
          applyInput,
          fileAgents,
          builtinWinners,
          builtins,
          teamRoleOverrides,
          specialRoleOverrides,
        }),
      )
      yield* Effect.yieldNow

      state.applied = [...state.appliedParts.values()].flatMap((p) => p.registrations as Registration[])
      const winnerById = new Map(teamAgents.map((agent) => [agent.id, agent] as const))
      const ownership = new Map<string, TeamOwnership>()
      for (const id of partsResult.installedIds) {
        const winner = winnerById.get(id)
        if (winner?.team === undefined) continue
        ownership.set(id, { team: winner.team, level: winner.scope })
      }
      const teamOwnershipChanged = !sameTeamOwnership(state.teamOutputIds, ownership)
      state.teamOutputIds = ownership
      state.installedTools = partsResult.tools
      state.permissions = partsResult.permissions
      state.fingerprint = fingerprint
      state.projectRevision = stored.projectRevision
      state.globalRevision = stored.globalRevision
      captureBaselines(
        ctx,
        state,
        discovered,
        customizations,
        splits,
        modelRecords,
        teamAgents,
        view.overrides,
        view.teamBodies,
        specialRoleOverrides,
        contextFor(discovered.agents, discovered.items, stored.records, teams),
      )
      yield* emitChanged(state, stored.projectRevision, stored.globalRevision)
      if (teamOwnershipChanged) yield* emitTeamsChanged(state)
      return discovered
    }),
  ).pipe(Effect.ensuring(Effect.sync(() => refreshPhase(at, undefined))))
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
  teamAgents?: readonly AgentSource[],
  teamOverrides?: ReadonlyMap<string, string>,
  teamBodies?: readonly { id: string; scope: AgentSource["scope"]; body: string | undefined }[],
  specialOverrides?: ReadonlyMap<string, string>,
  // The full chain context of this publish; callers without one (unit tests of
  // the baseline itself) resolve through the discovered agents' scopes.
  context?: Scopes,
): void {
  void ctx
  void splits
  const next = new Map<string, PromptBaseline>()
  const scopes = context ?? scopesOf(discovered.agents)
  const winnerScope = new Map((teamAgents ?? []).map((agent) => [agent.id, agent.scope] as const))
  for (const item of discovered.items) {
    const key = baselineKey(item)
    if (item.id === "system:role") {
      const owner = item.agents?.[0]
      if (owner === undefined) continue
      if (specialOverrides?.has(owner)) {
        next.set(key, {
          applied: specialOverrides.get(owner)!,
          upstream: item.text,
          fileBacked: false,
        })
        continue
      }
      if (winnerScope.has(owner) && teamOverrides?.has(owner)) {
        next.set(key, {
          applied: teamOverrides.get(owner)!,
          upstream: item.text,
          fileBacked: false,
        })
        continue
      }
      // Team-only host agents surface at `defaults` while their role records
      // live at the team winner's level. Resolving at the discovered scope
      // misses project/global edits, so the next discovery mistakes the
      // installed edit for upstream and the override silently reverts. Resolve
      // at the winner's scope so the existing unmask path reports upstream.
      // Any other agent resolves where apply resolved it (runtimeScope).
      const winner = winnerScope.get(owner)
      const runtime =
        winner !== undefined
          ? { level: scopeLevel(winner), scopes }
          : runtimeScope({ id: owner, level: scopeLevel(discovered.agents.find((agent) => agent.id === owner)?.scope ?? "defaults") }, scopes)
      const resolved = resolve({ upstream: item, records, splits, scopes: runtime.scopes, address: { level: runtime.level, agent: owner, item: item.id, section: null } })
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
  // Team installs overwrite the host system outside applyRoles, so the loop
  // above never sees them: a winner absent from the host has no role item,
  // and a winner over a regular resolves to upstream (no records) and is
  // skipped. Retain (applied, upstream) for every installed winner so the
  // next discovery unmasks Plus's own team output back to upstream instead
  // of reporting it as a new upstream edit or losing a persisted edit across
  // disable→enable. Absent members use the shipped body as upstream; members
  // over a regular use the discovered role text (the regular body).
  const overrides = teamOverrides ?? new Map<string, string>()
  const bodies = new Map((teamBodies ?? []).map((entry) => [entry.id, entry.body] as const))
  const roleText = new Map(
    discovered.items.flatMap((item): [string, string][] => {
      if (item.id !== "system:role") return []
      const owner = item.agents?.[0]
      if (owner === undefined) return []
      return [[owner, item.text]]
    }),
  )
  for (const agent of teamAgents ?? []) {
    if (next.has(agent.id)) continue
    const raw = bodies.get(agent.id)
    if (raw === undefined) continue
    const shipped = agentBody(raw)
    const applied = overrides.get(agent.id) ?? shipped
    const upstream = roleText.get(agent.id) ?? shipped
    if (applied === upstream) continue
    next.set(agent.id, { applied, upstream, fileBacked: false })
  }
  // A persisted edit outlives a disable: the disabled publish sees no role
  // item and installs nothing, so without retention the baseline is dropped
  // and the re-enable mistakes the edit for upstream. Keep old baselines for
  // ids absent now; a deleted customization clears on its next resolving
  // publish when the host shows the retained upstream.
  for (const [key, baseline] of state.baselines) {
    if (!next.has(key)) next.set(key, baseline)
  }
  state.baselines = next
  const models = modelRecords ?? []
  if (models.length === 0) {
    state.modelBaselines = new Map()
    return
  }
  const modelNext = new Map<string, ModelBaseline>()
  // Newly installed members are absent from the pre-publish host discovery.
  // Capture them too, or their first installed model becomes false upstream
  // on the next read (and gets recorded as an activation's basedOn).
  const effective = dedupeAgents([...discovered.agents, ...(teamAgents ?? [])])
  for (const agent of effective) {
    const runtime = runtimeScope({ id: agent.id, level: scopeLevel(agent.scope) }, scopes)
    const upstream = discovered.modelUpstream.get(agent.id)
    const active = state.activeModels.get(agent.id)
    const winner = active !== undefined
      ? { providerID: active.providerID, modelID: active.modelID, ...(active.variant === undefined ? {} : { variant: active.variant }), source: runtime.level }
      : resolveActiveModel({ models, scopes: runtime.scopes, level: runtime.level, agent: agent.id })
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
    const registrations = [...state.appliedParts.values()].flatMap((p) => p.registrations as Registration[])
    state.appliedParts.clear()
    state.appliedPlans.clear()
    state.sessionPins.clear()
    state.currentPlanSet = undefined
    state.applied = []
    state.installedTools = []
    yield* Effect.forEach(registrations, (registration) => registration.dispose, { discard: true })
  })
}

function emitChanged(state: PlusState, revision: number, globalRevision: number): Effect.Effect<void> {
  // Wake the other Locations in this process (and, through the file watcher,
  // other processes) before the optional host event: sharing the store is the
  // point, not the local registration.
  notifySharedStoreChanged(state)
  const registration = state.registration
  if (!registration) return Effect.void
  return registration.events.emit("instructions.changed", { revision, globalRevision }).pipe(Effect.orDie)
}

function emitWarmingChanged(state: PlusState, sessionID: string): Effect.Effect<void> {
  const registration = state.registration
  if (!registration) return Effect.void
  return registration.events.emit("warming.changed", { sessionID }).pipe(Effect.orDie)
}

// Notifications and sounds (attention-watch.ts): this folder's events, decided with the global
// settings under each agent's rows.
function watchAttention(ctx: Context, state: PlusState): Effect.Effect<void, never, Scope.Scope> {
  const watcher = createAttentionWatcher({
    parentOf: (sessionID) => parentChatOf(ctx, sessionID),
    chatOf: async (sessionID) => {
      const session = await Effect.runPromise(ctx.session.get({ sessionID: Session.ID.make(sessionID) }))
      // A chat on the default agent names none; its first turn ends before it has a title.
      const agent = await currentSessionAgent(ctx, sessionID)
      const title = session.title !== undefined && session.title.length > 0 ? session.title : path.basename(session.location.directory)
      return { ...(agent === undefined ? {} : { agent }), title }
    },
    settledOf: (sessionID) => memberSettled(ctx, sessionID),
    settingsFor: (agent) => attentionFor(state, agent),
    workRuns: (sessionID) => warmingStore.workRuns(sessionID),
    notices: async () => monitorNotices(await plusSettings.read()).notices,
    emit: (attention) => Effect.runPromise(emitAttention(state, attention)),
  })
  return Effect.gen(function* () {
    yield* Effect.addFinalizer(() => Effect.sync(() => watcher.dispose()))
    yield* ctx.event.subscribe().pipe(
      Stream.runForEach((event) =>
        Effect.promise(() => watcher.handle(event)).pipe(
          Effect.catchCause((cause) => Effect.logWarning("plus attention event failed", { cause, type: event.type })),
        ),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  })
}

/** The notification settings an agent resolves: Settings › Notifications under its own rows. */
async function attentionFor(state: Pick<PlusState, "attentionRows">, agent: string | undefined): Promise<Plus.AttentionSettings> {
  const global = (await plusSettings.read()).attention
  const rows = agent === undefined ? undefined : state.attentionRows.get(agent)
  return rows === undefined ? global : agentAttention(global, rows)
}

function emitAttention(state: PlusState, attention: Plus.Attention): Effect.Effect<void> {
  const registration = state.registration
  if (!registration) return Effect.void
  return registration.events.emit("attention", attention).pipe(Effect.orDie)
}

// A sound named by path is read here for a player on another machine.
const SOUND_FILES = new Set([".mp3", ".wav", ".ogg", ".flac"])
const MAX_SOUND_BYTES = 5 * 1024 * 1024

async function readAttentionSound(sound: string): Promise<Plus.AttentionSoundData | Plus.SettingsInvalid> {
  if (!path.isAbsolute(sound) || !SOUND_FILES.has(path.extname(sound).toLowerCase()))
    return { reason: "A sound file is an absolute path to an .mp3, .wav, .ogg or .flac file" }
  const file = Bun.file(sound)
  if (!(await file.exists())) return { reason: `No sound file at ${sound} on the server` }
  if (file.size > MAX_SOUND_BYTES) return { reason: `Sound files are at most ${MAX_SOUND_BYTES / 1024 / 1024} MB` }
  return { data: Buffer.from(await file.arrayBuffer()).toString("base64"), name: path.basename(sound) }
}

// /settings and `opencodeplus notify --test`: one occurrence with an agent's settings, whether
// they are on or not, so a test always shows what the event does.
function attentionTest(state: PlusState, input: Plus.AttentionTestInput): Effect.Effect<Plus.Attention> {
  return Effect.gen(function* () {
    const settings = (yield* Effect.promise(() => attentionFor(state, input.agent)))[input.kind]
    const attention: Plus.Attention = {
      id: `test:${crypto.randomUUID()}`,
      kind: input.kind,
      sessionID: "",
      rootID: "",
      depth: 0,
      ...(input.agent === undefined ? {} : { agent: input.agent }),
      title: "OpenCodePlus",
      message: `Test: ${ATTENTION_TEST_LABELS[input.kind]}`,
      notify: settings.notify,
      ...(settings.sound === "off" ? {} : { sound: settings.sound }),
      player: attentionStore.players() > 0,
      test: true,
      at: Date.now(),
    }
    yield* emitAttention(state, attention)
    return attention
  })
}

const ATTENTION_TEST_LABELS: Readonly<Record<Plus.AttentionKind, string>> = {
  done: "a chat is done",
  reply: "a chat replied while its work still runs",
  child: "a subagent or team member is done",
  question: "a question needs your answer",
  error: "a chat failed",
  cacheMiss: "a cache miss",
}

function emitTeamsChanged(state: PlusState): Effect.Effect<void> {
  // A team create/enable/member change can touch no record (an empty team is a
  // directory), so notify here too: the other Locations must re-discover even
  // though the store revisions did not move.
  notifySharedStoreChanged(state, true)
  const registration = state.registration
  if (!registration) return Effect.void
  return registration.events.emit("teams.changed", {}).pipe(Effect.orDie)
}

function sameTeamOwnership(
  left: ReadonlyMap<string, TeamOwnership>,
  right: ReadonlyMap<string, TeamOwnership>,
): boolean {
  if (left.size !== right.size) return false
  for (const [key, leftVal] of left) {
    const rightVal = right.get(key)
    if (!rightVal || rightVal.team !== leftVal.team || rightVal.level !== leftVal.level) return false
  }
  return true
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
  const place = (id: string, entry: TeamApplied) => {
    const existing = applied.get(id)
    if (existing === undefined) {
      applied.set(id, entry)
      return
    }
    // Winner precedence mirrors resolveTeams: project over global over
    // defaults, same-level ties to the lexicographically smallest team.
    const rank = teamLevelRank(entry.level) - teamLevelRank(existing.level)
    if (rank < 0 || (rank === 0 && entry.team < existing.team)) applied.set(id, entry)
  }
  for (const team of builtins) {
    if (!isTeamEnabled(teamRecords, "defaults", team.name)) continue
    for (const member of team.members) {
      place(member.id, { team: team.name, level: "defaults", body: agentBody(member.body), fields: member.fields ?? { permissions: [] } })
    }
  }
  const disk = await Promise.all([discoverTeams("project", directory), discoverTeams("global", directory)])
  for (const discovered of [...disk[0], ...disk[1]]) {
    if (!isTeamEnabled(teamRecords, discovered.level, discovered.team)) continue
    for (const member of discovered.agents) {
      if (member.path === undefined) continue
      const text = await readTeamBody(member.path)
      if (text === undefined) continue
      place(member.id, { team: discovered.team, level: discovered.level, body: agentBody(text), fields: parseTeamFields(text) })
    }
  }
  return applied
}

function teamLevelRank(level: TeamLevel): number {
  if (level === "project") return 0
  if (level === "global") return 1
  return 2
}

// Override map for installation: resolve every resolved team winner at its
// own scope (project > global > defaults, the same winners resolveTeams
// produces) against the unmasked discovery. A project winner resolves
// project-level role records; resolving at the losing built-in level would
// omit them and reinstall the shipped body. Inputs are the unfiltered
// discovery plus records, splits, and scopes; only the agent list comes from
// the filtered publish view's winners, which are available before the
// installer runs. Winners absent from the host have no role item yet, so
// synthesize their shipped-body upstream (the true upstream for a member
// that does not exist in the host) and resolve stored records against it,
// making the override available on the very first publish after enable.
function teamRoleOverrides(
  discovered: Discovered,
  teamAgents: readonly AgentSource[],
  records: readonly CustomizationRecord[],
  splits: readonly SplitRecord[],
  scopes: Scopes,
  teamBodies: readonly { id: string; scope: AgentSource["scope"]; body: string | undefined }[],
): Map<string, string> {
  const teamAgentIds = new Set(teamAgents.map((agent) => agent.id))
  const itemsWithoutTeamRoles = discovered.items.filter((item) => {
    if (item.id !== "system:role") return true
    const owner = item.agents?.[0]
    return owner === undefined || !teamAgentIds.has(owner)
  })
  const bodies = new Map(teamBodies.map((entry) => [entry.id, entry.body] as const))
  const synthesized: Item[] = teamAgents.flatMap((agent): Item[] => {
    const raw = bodies.get(agent.id)
    if (raw === undefined) return []
    const text = agentBody(raw)
    return [{ id: "system:role", kind: "system", group: "none", title: "Role/persona", text, enabled: true, fingerprint: fingerprint(text), agents: [agent.id], order: 0 }]
  })
  return new Map(
    roleUpdates(
      {
        items: [...itemsWithoutTeamRoles, ...synthesized],
        // Addressed as apply addresses members (with their team), so a member
        // created from a preset reads its role text through its link.
        agents: teamAgents.map((agent) => ({
          id: agent.id,
          level: scopeLevel(agent.scope),
          ...(agent.team === undefined ? {} : { team: { level: scopeLevel(agent.scope), team: agent.team } }),
        })),
        records,
        splits,
        scopes,
      },
      { skipNoop: true },
    ).map((entry) => [entry.agent, entry.text] as const),
  )
}

function plusTeamOutputIds(
  discovered: Discovered,
  applied: ReadonlyMap<string, TeamApplied>,
  owned: ReadonlyMap<string, TeamOwnership>,
): Map<string, TeamLevel> {
  const output = new Map<string, TeamLevel>()
  // Recorded ownership is authoritative, keyed by team identity: an id Plus
  // installed last publish that is still enabled by the same team at the same
  // level stays team output regardless of the body the host currently shows
  // (the host holds the previous publish's body while records already
  // describe the next one). A different team reusing the same id must not
  // inherit ownership: on a team/level mismatch fall through to the
  // body-based check, which declines while the host still shows the previous
  // owner's body and preserves the regular identity. Structural guards still
  // apply: a file-backed regular source wins, and only an unbacked defaults
  // source with a live host entry can be Plus output.
  if (owned.size > 0) {
    for (const [id, ownership] of owned) {
      const entry = applied.get(id)
      if (entry === undefined) continue
      const sources = discovered.agents.filter((agent) => agent.id === id)
      if (sources.length > 0 && sources.some((agent) => agent.path !== undefined)) continue
      const unbacked = sources.filter((agent) => agent.scope === "defaults" && agent.path === undefined)
      if (unbacked.length === 0) continue
      const host = discovered.hosts.find((agent) => String(agent.id) === id)
      if (host === undefined) continue
      if (entry.team !== ownership.team || entry.level !== ownership.level) {
        if (!matchesTeamApplied(host, entry.body, entry.fields)) continue
        output.set(id, entry.level)
        continue
      }
      output.set(id, ownership.level)
    }
    return output
  }
  // Cold start with no memory: fall back to matching the shipped body only.
  // A customized member whose host shows an edited body is not recognized
  // here; its leftover host entry flows through the regular role path rather
  // than being dropped, and the next publish records ownership again.
  for (const [id, entry] of applied) {
    const sources = discovered.agents.filter((agent) => agent.id === id)
    if (sources.length > 0 && sources.some((agent) => agent.path !== undefined)) continue
    const unbacked = sources.filter((agent) => agent.scope === "defaults" && agent.path === undefined)
    if (unbacked.length === 0) continue
    const host = discovered.hosts.find((agent) => String(agent.id) === id)
    if (host === undefined) continue
    if (!matchesTeamApplied(host, entry.body, entry.fields)) continue
    output.set(id, entry.level)
  }
  return output
}

function filteredPublishAgents(agents: readonly AgentSource[], outputIds: ReadonlyMap<string, TeamLevel>): AgentSource[] {
  return agents.filter((agent) => !(outputIds.has(agent.id) && agent.scope === "defaults" && agent.path === undefined))
}

function filteredPublishItems(items: readonly Item[], outputIds: ReadonlyMap<string, TeamLevel>): Item[] {
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
  owned: ReadonlyMap<string, TeamOwnership>,
): Promise<{ agents: AgentSource[]; items: Item[]; scopes: Scopes; teamAgents: readonly AgentSource[]; teamBodies: { id: string; scope: AgentSource["scope"]; body: string | undefined }[]; outputIds: Map<string, TeamLevel>; overrides: Map<string, string> }> {
  const teamRecords = records.filter(isTeamRecord)
  const applied = await enabledTeamApplied(directory, teamRecords, builtins)
  const customizations = customizationsOf(records)
  const splits = splitsOf(records)
  // Ownership no longer depends on the override map, so output filtering
  // runs first from the recorded ids (cold-start shipped fallback only).
  // Winners resolve against the filtered regulars, then overrides resolve at
  // the winners' own scopes for the installer.
  const outputIds = plusTeamOutputIds(discovered, applied, owned)
  const agents = filteredPublishAgents(discovered.agents, outputIds)
  const items = filteredPublishItems(discovered.items, outputIds)
  const teams = await discoverAllTeams(directory, builtins)
  const scopes = contextFor(agents, items, records, teams)
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
  const overrides = teamRoleOverrides(
    discovered,
    teamAgents,
    customizations,
    splits,
    contextFor(discovered.agents, discovered.items, records, teams),
    teamBodies,
  )
  return { agents, items, scopes, teamAgents, teamBodies, outputIds, overrides }
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
  builtins: readonly BuiltinTeam[] = [],
): Promise<readonly AgentSource[]> {
  const disk = await Promise.all([discoverTeams("project", directory), discoverTeams("global", directory)])
  const builtin = discoverBuiltinTeams(builtins)
  return resolveTeams([...disk[0], ...disk[1], ...builtin], records, regular).agents
}

// The canonical event names, not string guesses: agent and skill reloads
// publish their Updated events, and config reloads publish Updated whenever
// the merged config changes. Tool and MCP-config drift arrives through the
// same config reloads, so these cover every host change we snapshot. model.updated
// is the provider catalogue moving (CPA's sync, the models.dev refresh).
// Our own apply calls reload(), which republishes agent.updated, but the
// fingerprint above is unchanged then, so the refresh is a no-op instead of
// a loop.
const RefreshEvents: Set<string> = new Set([
  Agent.Event.Updated.type,
  Skill.Event.Updated.type,
  Config.Event.Updated.type,
  Model.Event.Updated.type,
])

const SessionModelEvents: Set<string> = new Set(["session.created", "session.agent.selected"])

const SessionCompactionEvents: Set<string> = new Set(["session.compaction.ended", "session.compacted"])

export function watchHostEvents(ctx: Context, state: PlusState): Effect.Effect<void, never, Scope.Scope> {
  const refresh = ctx.event.subscribe().pipe(
    Stream.filter((event) => RefreshEvents.has(event.type)),
    Stream.runForEach((event) => {
      state.pendingHostChange = true
      // A provider catalogue moved. Drop it now, not on the refresh below: an
      // idle folder defers that refresh to its next use.
      if (event.type === Model.Event.Updated.type) {
        state.hostCatalog = undefined
        state.hostModels = undefined
      }
      // Each Instructions write lands in the global config directory every
      // folder's Config watches, so every folder's skill and agent registries
      // reload and announce it, several events per write. An idle folder
      // applies that on its next use; a folder in use refreshes once after the
      // burst, as for a store notice. One refresh per event, each taking the
      // process refresh lock in turn, kept prompts in other folders waiting
      // for theirs for up to minutes (B69).
      state.pendingRefresh = true
      if (!idleLocation(state)) scheduleRefresh(ctx, state)
      return Effect.void
    }),
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
  // A team run's state follows its host session: idle, failed and interrupted
  // turns settle the attempt and hand the inbox over without any tool call.
  // Compact before cold reads the same events: a running chat never compacts.
  // A chat that moves between checkouts is the other event a run follows
  // (lifecycle.onSessionMoved): a root run with no child takes the new folder.
  const runs = ctx.event.subscribe().pipe(
    Stream.filter((event) => SessionRunEvents.has(event.type) || event.type === RETRY_SCHEDULED || event.type === "session.moved"),
    Stream.runForEach((event) =>
      Effect.promise(() => {
        const sessionID = (event.data as { readonly sessionID?: unknown } | undefined)?.sessionID
        // Only the run events start or end a turn: a move or a scheduled retry
        // must not clear a running chat's busy flag.
        const turn = typeof sessionID === "string" && SessionRunEvents.has(event.type)
        const started = event.type === "session.execution.started"
        if (turn) {
          warmingStore.running(sessionID, started)
          // Its parent chat keeps warm while it runs (looked up once per start).
          if (started) void parentChatOf(ctx, sessionID).then((parent) => parent === undefined || warmingStore.parent(sessionID, parent))
          // A running session keeps this Location in use (its context hook
          // reads the published plans every step, prompt or not).
          if (started) state.running.add(sessionID)
          if (!started) state.running.delete(sessionID)
        }
        // A turn ended: its window (and its parents') shows the configured one at once.
        const settled = turn && !started ? Effect.runPromise(settleWarming(state, sessionID)) : Promise.resolve()
        // A session starting here without a prompt (a resumed run) is a use too.
        const used = started ? Effect.runPromise(useLocation(ctx, state)) : Promise.resolve()
        return Promise.all([settled, used]).then(() => onSessionEvent(ctx, teamsDataDir(), event))
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("plus team session event failed", { cause, type: event.type })),
        Effect.asVoid,
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
    Effect.asVoid,
  )
  const compactions = ctx.event.subscribe().pipe(
    Stream.filter((event) => SessionCompactionEvents.has(event.type)),
    Stream.runForEach((event) =>
      Effect.gen(function* () {
        const sessionID = (event.data as { readonly sessionID?: unknown } | undefined)?.sessionID
        if (typeof sessionID === "string") {
          yield* state.sessionPins.markRebuild(sessionID)
          const created = (event as { created?: unknown }).created
          const completedAt = typeof created === "number" ? created : Date.now()
          warmingStore.invalidateCompaction(sessionID, completedAt)
          yield* emitWarmingChanged(state, sessionID)
        }
      }).pipe(
        Effect.catchCause((cause) => Effect.logWarning("plus compaction event failed", { cause, type: event.type })),
        Effect.asVoid,
      ),
    ),
    Effect.forkScoped({ startImmediately: true }),
    Effect.asVoid,
  )
  const sessionDeletions = ctx.event.subscribe().pipe(
    Stream.filter((event) => event.type === "session.deleted"),
    Stream.runForEach((event) => {
      const sessionID =
        (event.data as { readonly sessionID?: unknown } | undefined)?.sessionID ??
        (event as { readonly sessionID?: unknown }).sessionID
      return typeof sessionID === "string" ? state.sessionPins.dropPin(sessionID) : Effect.void
    }),
    Effect.forkScoped({ startImmediately: true }),
    Effect.asVoid,
  )
  return Effect.gen(function* () {
    yield* refresh
    yield* sessions
    yield* runs
    yield* compactions
    yield* sessionDeletions
    yield* watchToolRegistry(ctx, state)
  })
}

// An MCP server's tools join the tool registry after Plus's first discovery (a
// server connects later: the search server Plus registers always does) or
// change when it reconnects or announces new tools. None of that reaches a
// plugin as an event: mcp.tools.changed is not a server event. Until a
// discovery lists those tools they have no rows, so no member's "off" row
// denies them. A transform replays on every registry rebuild, so it signals
// each one; a rebuild whose tools differ from the last discovery's refreshes.
// Discovery's own registry reads rebuild too, but list the same tools.
export function watchToolRegistry(ctx: Context, state: PlusState): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const rebuilt = yield* Queue.sliding<void>(1)
    yield* ctx.tool.transform(() => {
      Queue.offerUnsafe(rebuilt, undefined)
    })
    yield* Stream.fromQueue(rebuilt).pipe(
      Stream.debounce("100 millis"),
      Stream.runForEach(() =>
        Effect.gen(function* () {
          const known = state.discoveredTools
          if (known === undefined) return
          const listed = yield* ctx.tool.list()
          if (listed.length === known.size && listed.every((tool) => known.has(tool.id))) return
          state.pendingHostChange = true
          yield* refreshFromHost(ctx, state)
        }).pipe(Effect.catchCause((cause) => Effect.logWarning("plus tool registry refresh failed", { cause }))),
      ),
      Effect.forkScoped({ startImmediately: true }),
    )
  })
}

// T2: every Location runs its own Plus instance in one server process, but the
// host Bus is Location-filtered, so a change through one instance never reaches
// the others' watchHostEvents. Two seams cover the two topologies:
//
// - the in-process bus (shared-store-bus.ts) for every Location in the one
//   elected server;
// - an fs watcher on the shared records directory for a standalone server of
//   its own (the `--standalone` dev topology), where module state is not
//   shared.
//
// Both trigger a 1s trailing quiet coalescing timer, and a location with a
// pending refresh flushes before prompt execution.
export function watchSharedStore(ctx: Context, state: PlusState): Effect.Effect<void, never, Scope.Scope> {
  return Effect.gen(function* () {
    const trigger = (source?: unknown, force?: boolean) => {
      if (source === state) return
      state.pendingRefresh = true
      if (force === true) state.pendingForce = true
      // An idle folder (a stopped worker's, one nobody opened for a while)
      // catches up on its next use instead of rediscovering on every write.
      if (idleLocation(state)) return
      scheduleRefresh(ctx, state)
    }
    const unsubscribe = onSharedStoreChanged(trigger)
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        unsubscribe()
        if (state.refreshTimer !== undefined) {
          clearTimeout(state.refreshTimer)
          state.refreshTimer = undefined
        }
      }),
    )
    yield* watchSharedStoreFile(trigger)
  })
}

// The cross-process half: any write to the shared records file or the global
// teams root (an empty team is a directory and writes no record, so the teams
// root needs its own watch) means another Plus instance published. Bun.write
// rewrites the records file in place, so the directory watch sees it.
//
// One service-wide pair, not one per folder: see shared-store-file.ts.
function watchSharedStoreFile(onChange: (source: undefined, force: boolean) => void): Effect.Effect<void, never, Scope.Scope> {
  return acquireSharedStoreWatch(
    [
      // The teams root changes without a record write, so its changes force a rediscovery.
      { path: path.dirname(globalRecordsPath()), force: false },
      { path: globalTeamsPath(), force: true },
    ],
    (force) => onChange(undefined, force),
  )
}

// Placement has committed; persist and publish the destination row before the runner continues.
export function transferSessionModel(
  ctx: Context,
  state: PlusState,
  source: Session.Info,
  destination: Session.Info,
): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (!source.model) return
    const agent = source.agent ?? (yield* Effect.promise(() => currentSessionAgent(ctx, source.id)))
    if (!agent) return
    const from = yield* Effect.promise(() => activationDirectory(source.location.directory))
    const directory = yield* Effect.promise(() => activationDirectory(destination.location.directory))
    if (from === directory) return
    const stored = yield* Effect.promise(() => load(from))
    const target = { providerID: source.model.providerID, modelID: source.model.id, variant: source.model.variant }
    const members = yield* Effect.promise(() => resolveAllTeamAgents(from, stored.records.filter(isTeamRecord), []))
    const member = members.find((entry) => entry.id === agent)
    const team = member?.team === undefined ? undefined : { level: scopeLevel(member.scope), team: member.team }
    const candidates = stored.records.filter((record): record is ModelRecord =>
      record.type === "model" && record.level === "project" && record.removed !== true &&
      record.agent === agent && sameTeam(record.team, team) &&
      record.providerID === target.providerID && record.modelID === target.modelID,
    )
    const row = candidates.find((record) => sameModelRef(record, target)) ?? candidates.find((record) => record.variant === undefined)
    // Global-only selections already travel with the user. Do not freeze inherited values into
    // a project row when there is no saved project configuration to transfer.
    if (!row) return
    const saved = yield* Effect.promise(() => updateRecords(directory, (records) => {
      const models = modelsOf(records)
      const existing = models.find((record) => scopedTo(record, row) && sameModelRef(record, row))
      // Existing destination configuration wins. Activation follows folder movement, just as an
      // explicit model pick does, without importing any other source inventory.
      const copied = existing
        ? models.map((record) => record === existing && record.removed ? { ...record, removed: undefined } : record)
        : [...models, structuredClone(row)]
      return [...records.filter((record) => record.type !== "model"), ...activateModel(copied, row, row)]
    }))
    if (!saved.ok) return yield* Effect.die("Project model transfer changed concurrently; retry the session move")
    yield* refreshAfterFileChange(ctx, state, directory)
  })
}

// A session created with, or switched to, an agent adopts that agent's active
// model via switchModel, and only when the session's current model differs.
// An agent switch returns to the chat's last model for that agent, read from
// the chat's own history, falling back to the agent's active model when the
// chat has no history for it; a created session always uses the active model.
// A user pick is saved as that agent's active row through `model.pick` (the
// Plus TUI calls it when the pick completes), so after the save the pick and
// the active row agree and this never reverts it. Mid-session
// session.model.selected from other sources — commands with a model, the
// subagent tool, team runs, quota fallback — is never subscribed to, so those
// do not rewrite the user's rows either. The wanted model comes from the
// publishFresh cache, refreshed cheaply when the shared stores moved (another
// live Location may have published Global/Defaults changes that Bus never
// delivers here, since Bus.subscribe is Location-filtered and RefreshEvents
// covers only host agent/skill/config events). The refresh is two small file
// reads plus a cache rebuild from the last discovery's agents: no host lists,
// no discovery run here.
export function applySessionModel(
  ctx: Context,
  state: PlusState,
  event: { type: string; properties?: Record<string, unknown>; data?: unknown },
): Effect.Effect<void> {
  return Effect.gen(function* () {
    // A pick in flight in this Plus instance has not yet refreshed the active
    // model cache. Wait for it so a session created right after the pick (Ctrl+T
    // then Enter on the home screen) sees the picked model and is not reverted.
    if (state.pendingPick !== undefined) yield* Effect.promise(() => state.pendingPick!.catch(() => undefined))
    // Same resolution as activate: a session in a run's worktree adopts the
    // recorded project directory's active models, not the worktree's own empty
    // ancestry.
    const directory = yield* Effect.promise(() => activationDirectory(ctx.location.directory))
    yield* Effect.promise(() => refreshActiveModelsIfStale(directory, state))
    const payload = (event.properties ?? event.data ?? {}) as Record<string, unknown>
    const sessionID = payload.sessionID
    if (typeof sessionID !== "string" || sessionID.length === 0) return
    // Core already chose a subagent's model: the one its caller asked for,
    // else its agent's model (which apply sets to the active one).
    if (event.type === "session.created" && typeof payload.parentID === "string") return
    const agentID = typeof payload.agent === "string" ? payload.agent : undefined
    const targetAgent = agentID ?? (yield* Effect.promise(() => currentSessionAgent(ctx, sessionID)))
    if (targetAgent === undefined) return
    const wanted =
      event.type === "session.agent.selected"
        ? ((yield* Effect.promise(() => chatModelForAgent(ctx, sessionID, targetAgent))) ?? state.activeModels.get(targetAgent))
        : state.activeModels.get(targetAgent)
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
  // Links and Defaults entries may have changed with the store: the cached
  // context keeps its agents and preset catalogue and takes the fresh ones.
  const fresh = presetStateOf(stored.records)
  state.cachedModels = modelsOf(stored.records)
  state.cachedModelSettings = modelSettingsOf(stored.records)
  // Cache warming resolves model rows with the same fresh context.
  state.cachedScopes = { ...state.cachedScopes, links: fresh.links, entries: fresh.entries }
  state.activeModels = buildActiveModels(state.cachedAgents, state.cachedModels, state.cachedScopes)
  state.projectRevision = stored.projectRevision
  state.globalRevision = stored.globalRevision
}

// The chat that started this one: a subagent's parent session, or a team
// worker's parent run's chat. Undefined for a top-level chat.
/** The chats running now, from core: the same set /api/session/active reports. */
export function activeSessionsOf(ctx: Context): Promise<ReadonlySet<string>> {
  return Effect.runPromise(
    Effect.suspend(() => ctx.session.active()).pipe(Effect.map((active) => new Set<string>(Object.keys(active)))),
  )
}

export function settleWarming(state: PlusState, sessionID: string): Effect.Effect<void> {
  return Effect.promise(() => warmingStore.settle(sessionID)).pipe(
    Effect.flatMap((changed) => Effect.forEach(changed, (chat) => emitWarmingChanged(state, chat), { discard: true })),
    Effect.catchCause((cause) => Effect.logWarning("plus warming settle failed", { cause, sessionID })),
  )
}

// A delegated team member's turn ended: its report says how ("scout needs context: Find …"), not
// a bare "is done". Its chat title is "<role>: <objective>".
const settledWords: Readonly<Record<string, string>> = {
  done: "is done",
  done_with_concerns: "is done, with concerns",
  blocked: "is blocked",
  needs_context: "needs context",
  rejected: "rejected its Brief",
}

export async function memberSettled(ctx: Context, sessionID: string): Promise<string | undefined> {
  const run = await bySession(teamsDataDir(), sessionID).catch(() => undefined)
  const attempt = run?.attempts.at(-1)
  if (run === undefined || run.kind !== "w" || attempt === undefined) return undefined
  const report = await readJson<{ status?: unknown }>(path.join(teamsDataDir(), "runs", run.id, `report-${attempt.n}.json`))
  const words = typeof report?.status === "string" ? settledWords[report.status] : undefined
  const session = await Effect.runPromise(ctx.session.get({ sessionID: Session.ID.make(sessionID) })).catch(() => undefined)
  const title = session?.title ?? ""
  const objective = title.startsWith(`${run.role}: `) ? title.slice(run.role.length + 2) : title
  const what = objective.length > 80 ? `${objective.slice(0, 79)}…` : objective
  return `${run.role} ${words ?? "stopped without a report"}${what.length === 0 ? "" : `: ${what}`}`
}

export async function parentChatOf(ctx: Context, sessionID: string): Promise<string | undefined> {
  const session = await Effect.runPromise(ctx.session.get({ sessionID: Session.ID.make(sessionID) })).catch(() => undefined)
  if (session?.parentID !== undefined) return session.parentID
  const run = await bySession(teamsDataDir(), sessionID).catch(() => undefined)
  if (run?.parent === null || run?.parent === undefined) return undefined
  const parent = await loadRun(teamsDataDir(), run.parent).catch(() => undefined)
  return parent?.sessionID ?? undefined
}

const refreshProcessSemaphore = Effect.runSync(Semaphore.make(1))

// A folder's own files (its opencode.json, skills, agent and command files)
// are not watched (item 4): a new chat re-reads them once, alongside its first
// request, so a change applies from that chat's next request. A folder that loaded moments
// ago has just read them (a team worker's first prompt), and later prompts of
// the same chat keep what it started with; `/refresh` reloads everything now.
export function refreshFolderForNewChat(ctx: Context, state: PlusState, sessionID: string): Effect.Effect<void> {
  return Effect.gen(function* () {
    if (state.chatsSeen.has(sessionID)) return
    state.chatsSeen.add(sessionID)
    if (Date.now() - state.loadedAt < NEW_CHAT_FRESH_MS) return
    const reloads = [ctx.config.reload({ force: true }), ctx.instruction.reload(), ctx.agent.reload(), ctx.command.reload(), ctx.skill.reload()]
    for (const reload of reloads)
      yield* reload.pipe(Effect.catchCause((cause) => Effect.logWarning("plus new-chat folder reload failed", { cause })))
  })
}

const NEW_CHAT_FRESH_MS = 5000

// A Location unused this long (and running nothing) defers other Locations'
// writes to its next use; see `useLocation`.
const IDLE_REFRESH_MS = 5 * 60_000

function idleLocation(state: PlusState): boolean {
  return state.running.size === 0 && Date.now() - state.lastUsedAt > IDLE_REFRESH_MS
}

/** Marks this Location used and applies a refresh it deferred, before the use goes on. */
export function useLocation(ctx: Context, state: PlusState): Effect.Effect<void> {
  return Effect.suspend(() => {
    state.lastUsedAt = Date.now()
    return catchUp(ctx, state)
  })
}

/** Applies a refresh this Location deferred, without counting as a use (a warming ping). */
export function catchUp(ctx: Context, state: PlusState): Effect.Effect<void> {
  return Effect.suspend(() => (state.pendingRefresh ? flushPendingRefresh(ctx, state) : Effect.void))
}

// The coalesced refresh: one trailing second of quiet after the last notice.
function scheduleRefresh(ctx: Context, state: PlusState): void {
  if (state.refreshTimer !== undefined) clearTimeout(state.refreshTimer)
  state.refreshTimer = setTimeout(() => {
    state.refreshTimer = undefined
    Effect.runPromise(
      flushPendingRefresh(ctx, state).pipe(
        Effect.catchCause((cause) => Effect.logWarning("plus coalesced refresh failed", { cause })),
      ),
    )
  }, 1000)
}

// Every Plus RPC is a use of its Location (the TUI's Instructions page, the
// agent tools' writes). An RPC answers from the store, not from what this
// Location published, so it does not wait for a deferred refresh: it schedules
// it (a request that runs on the published plans waits, in the prompt and
// warming hooks).
function usedHandlers<Handlers extends Record<string, (input: never, context: never) => Effect.Effect<unknown, unknown>>>(
  ctx: Context,
  state: PlusState,
  handlers: Handlers,
): Handlers {
  return Object.fromEntries(
    Object.entries(handlers).map(([name, handler]) => [
      name,
      (input: never, context: never) =>
        Effect.andThen(
          Effect.sync(() => {
            state.lastUsedAt = Date.now()
            if (state.pendingRefresh && state.refreshTimer === undefined) scheduleRefresh(ctx, state)
          }),
          handler(input, context),
        ),
    ]),
  ) as Handlers
}

export function flushPendingRefresh(ctx: Context, state: PlusState): Effect.Effect<void> {
  return Effect.promise(async () => {
    if (state.refreshTimer !== undefined) {
      clearTimeout(state.refreshTimer)
      state.refreshTimer = undefined
    }
    if (state.activeRefresh !== undefined) {
      if (!refreshPhases.has(ctx.location.directory)) refreshPhase(ctx.location.directory, "flush: waiting for this location's running refresh")
      await state.activeRefresh.catch(() => {})
      if (!state.pendingRefresh) return
    }
    if (!state.pendingRefresh) return
    state.pendingRefresh = false
    const promise = Effect.runPromise(
      refreshFromHost(ctx, state).pipe(
        Effect.catchCause((cause) => Effect.logWarning("plus flush refresh failed", { cause })),
      ),
    )
    state.activeRefresh = promise
    try {
      await promise
    } finally {
      state.activeRefresh = undefined
    }
  })
}

// What each Location's refresh is doing now (B18 diagnostics): a slow prompt
// warning names every phase older than 10 s, so a wedge says where it waits.
const refreshPhases = new Map<string, { readonly phase: string; readonly since: number }>()

function refreshPhase(directory: string, phase: string | undefined): void {
  if (phase === undefined) return void refreshPhases.delete(directory)
  refreshPhases.set(directory, { phase, since: Date.now() })
}

export function stuckRefreshes(): string {
  const now = Date.now()
  return [...refreshPhases]
    .filter((entry) => now - entry[1].since >= 10_000)
    .map((entry) => `${entry[0]}: ${entry[1].phase} (${Math.round((now - entry[1].since) / 1000)} s)`)
    .join("; ")
}

// Refreshes run one at a time process-wide, and a prompt waits for its
// location's pending refresh: one refresh that never ends stops every prompt
// in every location (B18: a landed child's removed worktree, whose host reads
// never answered). So a team worktree's location whose directory is gone is
// not refreshed, and a refresh gives the lock up after a minute. Both are
// checked again once the lock is held, with whether the location is still
// loaded: a landing removes the worktree, and a stopped run's folder is
// evicted, while its refresh waits in line (B69).
const REFRESH_LIMIT = Duration.seconds(60)

export function refreshFromHost(ctx: Context, state: PlusState, limit: Duration.Duration = REFRESH_LIMIT): Effect.Effect<void> {
  const at = ctx.location.directory
  const gone = () => at.startsWith(path.join(teamsDataDir(), "worktrees") + path.sep) && !fsSync.existsSync(at)
  if (gone()) return Effect.void
  refreshPhase(at, "refresh: waiting for the process refresh lock")
  return refreshProcessSemaphore.withPermits(1)(
    Effect.gen(function* () {
      if (gone() || !(yield* ctx.locations.loaded(ctx.location))) return
      refreshPhase(at, "refresh: loading the stores")
      const hasHostChange = state.pendingHostChange
      const forced = hasHostChange || state.pendingForce
      state.pendingHostChange = false
      state.pendingForce = false
      // A host or team change changes what a snapshot holds even when the store
      // revisions did not move: the snapshot cache key moves first.
      if (forced) state.snapshotGeneration++
      // A host change can change the provider catalogue; a store or team change cannot.
      if (hasHostChange) {
        state.hostModels = undefined
        state.hostCatalog = undefined
      }
      const directory = yield* Effect.promise(() => activationDirectory(ctx.location.directory))
      const stored = yield* Effect.promise(() => loadCurrent(directory))
      if (
        !forced &&
        state.projectRevision !== undefined &&
        state.globalRevision !== undefined &&
        stored.projectRevision === state.projectRevision &&
        stored.globalRevision === state.globalRevision
      ) {
        return
      }
      refreshPhase(at, "refresh: publish")
      // Not forked: a publish left running after its refresh was interrupted
      // (a plugin reload) stalled that location's next activation. A host read
      // awaited as a promise gives way to the timeout at once.
      const published = yield* publishFresh(ctx, state, stored).pipe(Effect.timeoutOption(limit))
      if (Option.isSome(published)) return
      yield* Effect.logWarning("plus refresh gave up", { directory: at, phase: refreshPhases.get(at)?.phase ?? "unknown" })
    }),
  ).pipe(Effect.ensuring(Effect.sync(() => refreshPhase(at, undefined))))
}

function toSnapshot(
  discovered: Discovered,
  loaded: LoadedStores,
  teams: readonly Plus.TeamEntry[],
  outputIds: ReadonlyMap<string, TeamLevel> | undefined,
  listing: readonly PresetEntry[],
): Plus.Snapshot {
  return {
    revision: loaded.projectRevision,
    globalRevision: loaded.globalRevision,
    agents: discovered.agents.map((agent) => {
      // Server-side origin crosses the RPC boundary. Plus team output (an id
      // in plusTeamOutputIds, or an AgentSource carrying team) upgrades to
      // origin plus; otherwise the discovery classification rides through.
      // File-backed team clashes keep their user origin via the path guard in
      // the fallback below.
      const fromOutput = outputIds !== undefined ? outputIds.has(agent.id) : false
      const fromTeams =
        outputIds === undefined && agent.path === undefined && agent.team === undefined
          ? teams.some((team) => team.enabled && team.agents.includes(agent.id))
          : false
      const isPlus = agent.team !== undefined || fromOutput || fromTeams
      const origin = isPlus ? ("plus" as const) : agent.origin
      return {
        id: agent.id,
        scope: agent.scope,
        ...(origin === undefined ? {} : { origin }),
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
      ...(agent.ancestor ? { ancestor: true } : {}),
      fileBacked: agent.path !== undefined,
      }
    }),
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
        ...(item.userSystem === undefined ? {} : { userSystem: item.userSystem }),
        ...(item.models === undefined ? {} : { models: [...item.models] }),
        ...(item.opencodePart === undefined ? {} : { opencodePart: item.opencodePart }),
        ...(item.codemode === undefined ? {} : { codemode: item.codemode }),
        ...(item.controlTeam === undefined ? {} : { controlTeam: item.controlTeam }),
        ...(item.namespace === undefined ? {} : { namespace: item.namespace }),
        ...(item.pinned === undefined ? {} : { pinned: item.pinned }),
        ...(item.execute === undefined ? {} : { execute: item.execute }),
        ...(item.paramTool === undefined ? {} : { paramTool: item.paramTool }),
        ...(item.permissionParameter === undefined ? {} : { permissionParameter: item.permissionParameter }),
        ...(item.permissionSource === undefined ? {} : { permissionSource: item.permissionSource }),
        ...(item.paramType === undefined ? {} : { paramType: item.paramType }),
        ...(item.required === undefined ? {} : { required: item.required }),
        ...(item.permTool === undefined ? {} : { permTool: item.permTool }),
        ...(item.permAction === undefined ? {} : { permAction: item.permAction }),
        ...(item.ruleId === undefined ? {} : { ruleId: item.ruleId }),
        ...(item.patterns === undefined ? {} : { patterns: [...item.patterns] }),
        ...(item.keywords === undefined ? {} : { keywords: [...item.keywords] }),
        ...(item.provenance === undefined ? {} : { provenance: [...item.provenance] }),
        ...(item.custom === undefined ? {} : { custom: item.custom }),
        ...(item.ownedBy === undefined ? {} : { ownedBy: item.ownedBy }),
        ...(item.policy === undefined
          ? {}
          : {
              policy: {
                on: item.policy.on.map((rule) => ({ ...rule })),
                off: item.policy.off.map((rule) => ({ ...rule })),
              },
            }),
        ...(item.alsoUnder === undefined ? {} : { alsoUnder: [...item.alsoUnder] }),
        ...(item.runID === undefined ? {} : { runID: item.runID }),
        ...(item.category === undefined ? {} : { category: item.category }),
        ...(item.permKind === undefined ? {} : { permKind: item.permKind }),
        ...(item.field === undefined ? {} : { field: item.field }),
        ...(item.value === undefined ? {} : { value: item.value }),
        ...(item.allow === undefined ? {} : { allow: item.allow }),
        ...(item.measure === undefined ? {} : { measure: item.measure }),
        ...(item.mode === undefined ? {} : { mode: item.mode }),
        ...(item.message === undefined ? {} : { message: item.message }),
        ...(item.fallback === undefined ? {} : { fallback: item.fallback }),
      }
    }),
    records: loaded.records.flatMap((record): Plus.SnapshotRecord[] => {
      if (record.type === "split")
        return [
          {
            type: "split" as const,
            level: record.level,
            agent: record.agent,
            ...(record.team !== undefined ? { team: record.team } : {}),
            ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
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
            ...(record.team !== undefined ? { team: record.team } : {}),
            ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
            providerID: record.providerID,
            modelID: record.modelID,
            ...(record.variant === undefined ? {} : { variant: record.variant }),
            ...(record.active === undefined ? {} : { active: record.active }),
            ...(record.basedOn === undefined ? {} : { basedOn: record.basedOn }),
            ...(record.warming === undefined ? {} : { warming: record.warming }),
            ...(record.interval === undefined ? {} : { interval: record.interval }),
            ...(record.waiting === undefined ? {} : { waiting: record.waiting }),
            ...(record.subagent === undefined ? {} : { subagent: record.subagent }),
            ...(record.prompt === undefined ? {} : { prompt: record.prompt }),
            ...(record.compactWarm === undefined ? {} : { compactWarm: record.compactWarm }),
            ...(record.coldFirst === undefined ? {} : { coldFirst: record.coldFirst }),
            ...(record.coldCompact === undefined ? {} : { coldCompact: record.coldCompact }),
            ...(record.coldModels === undefined ? {} : { coldModels: [...record.coldModels] }),
            ...(record.compactionStrategy === undefined ? {} : { compactionStrategy: record.compactionStrategy }),
            ...(record.compactionModel === undefined ? {} : { compactionModel: record.compactionModel }),
            ...(record.compactionInstructions === undefined ? {} : { compactionInstructions: record.compactionInstructions }),
            ...(record.imageConvert === undefined ? {} : { imageConvert: record.imageConvert }),
            ...(record.imageShrink === undefined ? {} : { imageShrink: record.imageShrink }),
            ...(record.imagesFull === undefined ? {} : { imagesFull: record.imagesFull }),
            ...(record.compactionInput === undefined ? {} : { compactionInput: record.compactionInput }),
            ...(record.compactionOutput === undefined ? {} : { compactionOutput: record.compactionOutput }),
            ...(record.removed === undefined ? {} : { removed: record.removed }),
            ...(record.originalCandidate === undefined ? {} : { originalCandidate: { ...record.originalCandidate } }),
            updated: record.updated,
          },
        ]
      if (record.type === "rule")
        return [
          {
            type: "rule" as const,
            level: record.level,
            agent: record.agent,
            ...(record.team !== undefined ? { team: record.team } : {}),
            ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
            tool: record.tool,
            id: record.id,
            label: record.label,
            patterns: [...record.patterns],
            keywords: [...record.keywords],
            ...(record.message === undefined ? {} : { message: record.message }),
            updated: record.updated,
          },
        ]
      // Team records stay out of `records`: clients read enablement through
      // `teams` instead, and instructions.mutate re-merges stored team
      // records so a client that cannot see them cannot delete them. Links,
      // Defaults entries, presets and Defaults › Models rows are handled the
      // same way: they cross in their own fields below.
      if (
        record.type === "team" ||
        record.type === "link" ||
        record.type === "entry" ||
        record.type === "preset" ||
        record.type === "modelSettings" ||
        record.type === "folder" ||
        record.type === "order"
      )
        return []
      if (record.type === "rowlink")
        return [
          {
            type: "rowlink" as const,
            level: record.level,
            agent: record.agent,
            ...(record.team !== undefined ? { team: record.team } : {}),
            ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
            item: record.item,
            section: record.section,
            target: record.target,
            targetSection: record.targetSection,
            link: record.link,
            ...(record.enabled === undefined ? {} : { enabled: record.enabled }),
            updated: record.updated,
          },
        ]
      return [
        {
          type: "customization" as const,
          level: record.level,
          agent: record.agent,
          ...(record.team !== undefined ? { team: record.team } : {}),
          ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
          item: record.item,
          section: record.section,
          ...(record.text === undefined ? {} : { text: record.text }),
          ...(record.state === undefined ? {} : { state: record.state }),
          ...(record.pin === undefined ? {} : { pin: record.pin }),
          ...(record.requires === undefined ? {} : { requires: [...record.requires] }),
          basedOn: record.basedOn,
          ...(record.basedOnText === undefined ? {} : { basedOnText: record.basedOnText }),
          ...(record.acknowledged === undefined ? {} : { acknowledged: record.acknowledged }),
          ...(record.basedOnState === undefined ? {} : { basedOnState: record.basedOnState }),
          ...(record.basedOnPin === undefined ? {} : { basedOnPin: record.basedOnPin }),
          updated: record.updated,
        },
      ]
    }),
    ...snapshotPresetState(loaded.records),
    folders: loaded.records
      .filter((record): record is FolderRecord => record.type === "folder")
      .map((record) => ({ ...record, items: [...record.items] })),
    orders: loaded.records
      .filter((record): record is OrderRecord => record.type === "order")
      .map((record) => ({ ...record, items: [...record.items] })),
    modelSettings: modelSettingsOf(loaded.records).map((record) => ({ ...record })),
    hostModels: discovered.hostModels.map((entry) => ({
      providerID: entry.providerID,
      modelID: entry.modelID,
      variants: [...entry.variants],
      ...(entry.warming === undefined ? {} : { warming: { ...entry.warming } }),
    })),
    listing: listing.map((entry) => ({
      ref: entry.ref.kind === "member" ? { kind: "member" as const, team: entry.ref.team, id: entry.ref.id } : { kind: entry.ref.kind, id: entry.ref.id },
      origin: entry.origin,
      kind: entry.kind,
      label: entry.label,
      ...(entry.description === undefined ? {} : { description: entry.description }),
      ...(entry.mode === undefined ? {} : { mode: entry.mode }),
      ...(entry.members === undefined ? {} : { members: [...entry.members] }),
    })),
    teams: teams.map((team) => ({
      level: team.level,
      team: team.team,
      enabled: team.enabled,
      agents: [...team.agents],
      ...(team.overlay !== undefined ? { overlay: [...team.overlay] } : {}),
    })),
    servers: discovered.servers.map((server) => ({ name: server.name, enabled: server.enabled })),
    protectedAgents: [...loaded.protectedAgents],
  }
}

// Links, Defaults entries and user presets, in the Snapshot's own fields: the
// chain reads them client-side, and shipped preset content is computed there
// from the items (instructions/presets.ts) instead of crossing.
function snapshotPresetState(
  records: readonly StoredRecord[],
): Required<Pick<Plus.Snapshot, "links" | "entries" | "presets">> {
  const state = presetStateOf(records)
  return {
    links: state.links.map((record) => ({
      type: "link" as const,
      level: record.level,
      agent: record.agent,
      ...(record.team === undefined ? {} : { team: { level: record.team.level, team: record.team.team } }),
      ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
      preset: record.preset.kind === "member" ? { kind: "member" as const, team: record.preset.team, id: record.preset.id } : { kind: record.preset.kind, id: record.preset.id },
      updated: record.updated,
    })),
    entries: state.entries.map((record) => ({
      type: "entry" as const,
      level: "defaults" as const,
      catalogue: record.catalogue,
      ...(record.team === undefined ? {} : { team: record.team }),
      name: record.name,
      updated: record.updated,
    })),
    presets: state.presets.map((record) => ({
      type: "preset" as const,
      level: "preset" as const,
      kind: record.kind,
      id: record.id,
      ...(record.team === undefined ? {} : { team: record.team }),
      ...(record.fields === undefined
        ? {}
        : {
            fields: {
              ...(record.fields.mode === undefined ? {} : { mode: record.fields.mode }),
              ...(record.fields.description === undefined ? {} : { description: record.fields.description }),
            },
          }),
      updated: record.updated,
    })),
  }
}

// Snapshot.teams keeps membership and enablement on their separate sources:
// disk discovery lists project/global members, the built-in registry lists
// defaults members with no filesystem path, stored team records decide
// enabled. A discovered team with no record reads DISABLED; a record with no
// matching team never surfaces.
async function snapshotOutputIds(
  directory: string,
  discovered: Discovered,
  loaded: LoadedStores,
  builtins: readonly BuiltinTeam[],
  owned: ReadonlyMap<string, TeamOwnership>,
): Promise<Map<string, TeamLevel>> {
  const teamRecords = loaded.records.filter(isTeamRecord)
  const applied = await enabledTeamApplied(directory, teamRecords, builtins)
  return plusTeamOutputIds(discovered, applied, owned)
}

async function snapshotTeams(
  directory: string,
  records: readonly StoredRecord[],
  builtins: readonly BuiltinTeam[] = [],
): Promise<Plus.TeamEntry[]> {
  const teamRecords = records.filter((record): record is TeamRecord => record.type === "team")
  const disk = await Promise.all([discoverTeams("project", directory), discoverTeams("global", directory)])
  const builtin = discoverBuiltinTeams(builtins)
  return [...disk[0], ...disk[1], ...builtin]
    .map((team): Plus.TeamEntry => {
      const overlay = team.agents.filter((agent) => agent.path !== undefined).map((agent) => agent.id)
      return {
        level: team.level,
        team: team.team,
        enabled: isTeamEnabled(teamRecords, team.level, team.team),
        agents: team.agents.map((agent) => agent.id),
        ...(team.level === "defaults" && overlay.length > 0 ? { overlay } : {}),
      }
    })
    .toSorted(compareTeams)
}

async function listTeams(
  directory: string,
  records: readonly StoredRecord[],
  builtins: readonly BuiltinTeam[] = [],
): Promise<Plus.TeamListOutput> {
  const teamRecords = records.filter((record): record is TeamRecord => record.type === "team")
  const disk = await Promise.all([discoverTeams("project", directory), discoverTeams("global", directory)])
  const builtin = discoverBuiltinTeams(builtins)
  const discovered = [...disk[0], ...disk[1], ...builtin].toSorted(compareTeams)

  const teams: Plus.TeamListEntry[] = await Promise.all(
    discovered.map(async (team) => {
      const enabled = isTeamEnabled(teamRecords, team.level, team.team)
      const members: Plus.TeamMemberEntry[] = await Promise.all(
        team.agents.map(async (agent) => {
          let mode: Plus.TeamMemberMode = "primary"
          if (agent.path !== undefined) {
            try {
              const text = await Bun.file(agent.path).text()
              const fields = parseTeamFields(text)
              if (fields.mode === "subagent" || fields.mode === "primary" || fields.mode === "all") {
                mode = fields.mode
              }
            } catch {
              // fallback to primary
            }
          } else {
            const builtinTeam = builtins.find((b) => b.name === team.team)
            const builtinMember = builtinTeam?.members.find((m) => m.id === agent.id)
            const m = builtinMember?.fields?.mode
            if (m === "subagent" || m === "primary" || m === "all") {
              mode = m
            }
          }
          return { id: agent.id, mode }
        }),
      )
      return {
        level: team.level,
        team: team.team,
        enabled,
        members,
      }
    }),
  )

  return { teams }
}

function compareTeams(
  left: { level: Plus.TeamLevel; team: string },
  right: { level: Plus.TeamLevel; team: string },
): number {
  if (left.level !== right.level) return left.level < right.level ? -1 : 1
  if (left.team !== right.team) return left.team < right.team ? -1 : 1
  return 0
}

// Confined member path inside a team directory: validated ids can never
// escape, so unvalidated input fails closed with undefined.
function teamMemberPath(teamDir: string, id: string): string | undefined {
  const base = path.resolve(teamDir)
  const resolved = path.resolve(base, `${id}.md`)
  if (resolved === base || !resolved.startsWith(`${base}${path.sep}`)) return undefined
  return resolved
}
