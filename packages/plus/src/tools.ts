import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { runRegistration } from "./instructions/apply.js"
import { changedLines, unifiedDiff } from "./instructions/diff-lines.js"
import {
  activateModelRow,
  addSection,
  createdAgentRow,
  createdEntryRow,
  createdItemRow,
  createdMemberRow,
  createdPresetRow,
  createdTeamRow,
  editRefusalForLabel,
  findRow,
  isModelRowId,
  isPermRowId,
  removalPlan,
  reset,
  resetModelRow,
  resolveRefusalForLabel,
  resolveReview,
  saveSplit,
  saveText,
  setEnabled,
  setAgentMode,
  setPin,
  teamPlan,
  teamRowEntity,
  toggle,
  unknownRowRefusal,
  type CreatedRow,
  type OpFailure,
  type RemovalPlan,
} from "./instructions/ops.js"
import { query } from "./instructions/query.js"
import {
  applies,
  catalogueField,
  modelItemId,
  parseModelItemId,
  parsePermItemId,
  permItemId,
  presetKey,
  resolve,
  resolveSplit,
  sameTeam,
  threeWay,
  upstreamForEdit,
} from "./instructions/model.js"
import { curatedRuleMessage, scrubLines } from "./instructions/tool-permissions.js"
import { isValueRow, limitOf } from "./instructions/permission-catalog.js"
import { controlItemFor, isControl } from "./instructions/agent-controls.js"
import type { Address, CustomizationRecord, Item, ModelRecord, RuleRecord, SplitRecord } from "./instructions/model.js"
import type { MemoInput, TreeNode } from "./instructions/tree.js"
import { contextOfSnapshot, memoInputOf, presetOf } from "./instructions/snapshot.js"
import { presetListing } from "./instructions/presets.js"
import type { PlusApi } from "./index.js"
import { Plus } from "./rpc.js"

const namespace = "instructions"
// OpenCodePlus: AGENTS.md rows and their create/delete are disabled pending the
// Context catalogue (instructions/discover.ts carries the full note).
export const INSTRUCTION_DISABLED =
  "instruction.disabled: AGENTS.md handling in OpenCodePlus is disabled for now; OpenCode applies AGENTS.md files. Being reworked with the Context catalogue."
const origin = { type: "plugin", name: "opencode.plus" } as const
const options = { namespace, codemode: true, permission: "instructions" } as const

const ListDescription =
  "Filter instruction rows; `where` uses `key:value` terms (grammar in skill `instructions-tools`).\n" +
  "Fields select the projection, sort orders rows, limit defaults to 40. Reads never refuse for protection."

const ShowDescription =
  "Read one row: resolved text (default), diff, record, sections, an entity, or an agent's assembled view.\n" +
  "Resolved rows expose stateFrom and textFrom owner identities separately; from remains the state-source label.\n" +
  "Views: resolved (default), upstream, mine, diff, record, sections, assembled (agent rows only).\n" +
  "Team and member rows carry no text: resolved returns the entity (level, team, enabled/members, or member registered), record nests it under record.\n" +
  "Diff returns two unified diffs (original→mine, original→upstream) plus a one-line summary."

const SetDescription =
  "Save an override, toggle, pin, activate a model, resolve a review row, or relink (TUI Enter/Space/p/k/t/e/l).\n" +
  "Enabling a team is exclusive across loaded project/global/defaults records; disabledTeams reports the other teams disabled by this save.\n" +
  "With text save an override, with state on|off toggle explicitly, with pin true|false pin a Code Mode tool, with active true activate a model row, with resolve keep|take|edit resolve review.\n" +
  "Agent/member rows accept state on|off and mode primary|subagent|all. setting:* and compaction:* rows use text (enabled/hidden use state); empty optional fields clear them. Compaction model is provider/model#variant; empty inherits the maintenance compaction model, otherwise the active session model.\n" +
  "With preset on an agent, member, team, Defaults entry or user preset row, link it to that preset (null unlinks): \"<id>\" names an agent preset, \"<team>/<member>\" a member preset (team rows take a team preset id).\n" +
  "On a perm row with label+patterns (keywords optional) update the rule; message sets the refusal text the model reads. Bare id toggles (model rows activate). Writes pass actor tool and retry once when stale."

const ResetDescription =
  "Drop the override at this level only (TUI `r`).\n" +
  "Agent/member rows reset their settings and compaction controls at this level.\n" +
  "Removes the stored text/state at the addressed row (model rows clear only that level's active flag). Writes pass actor tool and retry once when stale."

const SplitDescription =
  "Set manual sections or append one (TUI `s` / `a` on an item).\n" +
  "Pass boundaries [{id,name,start}] to set manual sections, or add {name,text} to append one."

const CreateDescription =
  "Create an agent, team, member, Defaults entry, preset, file-backed row, model candidate or permission rule (TUI `a`).\n" +
  "A preset is \"<id>\" (agent preset) or \"<team>/<member>\" (member preset). No preset leaves the agent unlinked: Defaults still apply, ordinary tools otherwise fall back to off, and controls retain configuration defaults. Kinds:\n" +
  "agent (id, scope project|global default project, preset), team (team+level, preset = team preset id; created disabled),\n" +
  "member (team+level+id, preset; level defaults creates a Teams member entry, team and id are patterns),\n" +
  "entry (catalogue agents|teams + name, team pattern for teams, preset; names may hold * and %, matched case-insensitively),\n" +
  "preset (id, from = base agent/member preset), teamPreset (id, from = team preset id whose members are copied, each linked to its source),\n" +
  "presetMember (team = user team preset + id, from), skill (name+body), base (id+title+text), instruction (name+text), mcp (name+config),\n" +
  "model (providerID+modelID, variant/level/agent optional; team selects that team's member owner, including level:preset),\n" +
  "rule (tool+id+label+patterns, keywords/level/agent optional; patterns are core wildcards, not regex; message is the optional refusal text the model reads; a rule with no agent keeps its requested level and resolves through its shared Defaults row).\n" +
  "Every kind returns {id, item}: id is the row id show/set/delete accept, item the created item's own id.\n" +
  "catalogue agents|teams (default agents) picks which catalogue a shared Defaults model or rule lands in;\n" +
  "base/instruction/mcp create one file both catalogues list, so catalogue does not change what is written."

const DeleteDescription =
  "Delete a user-owned row (agent, team, member, file, Defaults entry, user preset); refuses without `confirm`.\n" +
  "Pass confirm:true to delete. Resolves the row through the TUI removal plan. A preset anything links to is refused (preset.inUse lists who); links only other projects hold are overridden with force:true (they then show as a missing preset)."

const LogDescription =
  "Change history (who/what/when).\n" +
  "Reads the change log newest-first with where/limit/offset filtering."

const Field = Schema.Union([
  Schema.Literal("id"),
  Schema.Literal("badges"),
  Schema.Literal("source"),
  Schema.Literal("tokens"),
  Schema.Literal("text"),
  Schema.Literal("upstream"),
  Schema.Literal("record"),
  Schema.Literal("label"),
  Schema.Literal("path"),
  Schema.Literal("updated"),
  Schema.Literal("sections"),
  Schema.Literal("from"),
])

// A preset as tools name it: the RPC's `PresetRef`, or the friendlier string
// "<id>" (an agent preset) / "<team>/<member>" (a member preset).
const PresetInput = Schema.Union([Schema.String, Plus.PresetRef])

const Sort = Schema.Union([
  Schema.Literal("tokens"),
  Schema.Literal("delta"),
  Schema.Literal("updated"),
  Schema.Literal("label"),
  Schema.Literal("id"),
  Schema.Literal("-tokens"),
  Schema.Literal("-delta"),
  Schema.Literal("-updated"),
  Schema.Literal("-label"),
  Schema.Literal("-id"),
])

const ListInput = Schema.Struct({
  where: Schema.optionalKey(Schema.String),
  fields: Schema.optionalKey(Schema.Array(Field)),
  sort: Schema.optionalKey(Sort),
  limit: Schema.optionalKey(Schema.Number),
  offset: Schema.optionalKey(Schema.Number),
})

const ShowInput = Schema.Struct({
  id: Schema.String,
  view: Schema.optionalKey(
    Schema.Union([
      Schema.Literal("resolved"),
      Schema.Literal("upstream"),
      Schema.Literal("mine"),
      Schema.Literal("diff"),
      Schema.Literal("record"),
      Schema.Literal("sections"),
      Schema.Literal("assembled"),
    ]),
  ),
})

const SetInput = Schema.Struct({
  id: Schema.String,
  mode: Schema.optionalKey(Schema.Literals(["primary", "subagent", "all"])),
  text: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.Union([Schema.Literal("on"), Schema.Literal("off")])),
  pin: Schema.optionalKey(Schema.Boolean),
  active: Schema.optionalKey(Schema.Boolean),
  resolve: Schema.optionalKey(Schema.Union([Schema.Literal("keep"), Schema.Literal("take"), Schema.Literal("edit")])),
  label: Schema.optionalKey(Schema.String),
  patterns: Schema.optionalKey(Schema.Array(Schema.String)),
  keywords: Schema.optionalKey(Schema.Array(Schema.String)),
  message: Schema.optionalKey(Schema.String),
  preset: Schema.optionalKey(Schema.NullOr(PresetInput)),
})

const ResetInput = Schema.Struct({
  id: Schema.String,
})

const SplitInput = Schema.Struct({
  id: Schema.String,
  boundaries: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, start: Schema.Number })),
  ),
  add: Schema.optionalKey(Schema.Struct({ name: Schema.String, text: Schema.String })),
})

const CreateInput = Schema.Struct({
  kind: Schema.Union([
    Schema.Literal("agent"),
    Schema.Literal("skill"),
    Schema.Literal("base"),
    Schema.Literal("instruction"),
    Schema.Literal("mcp"),
    Schema.Literal("team"),
    Schema.Literal("member"),
    Schema.Literal("model"),
    Schema.Literal("rule"),
    Schema.Literal("entry"),
    Schema.Literal("preset"),
    Schema.Literal("teamPreset"),
    Schema.Literal("presetMember"),
  ]),
  id: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.Union([Schema.Literal("project"), Schema.Literal("global"), Schema.Literal("defaults")])),
  preset: Schema.optionalKey(PresetInput),
  from: Schema.optionalKey(PresetInput),
  name: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  config: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  team: Schema.optionalKey(Schema.String),
  level: Schema.optionalKey(
    Schema.Union([Schema.Literal("project"), Schema.Literal("global"), Schema.Literal("defaults"), Schema.Literal("preset")]),
  ),
  catalogue: Schema.optionalKey(Plus.Catalogue),
  providerID: Schema.optionalKey(Schema.String),
  modelID: Schema.optionalKey(Schema.String),
  variant: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  tool: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  patterns: Schema.optionalKey(Schema.Array(Schema.String)),
  keywords: Schema.optionalKey(Schema.Array(Schema.String)),
  message: Schema.optionalKey(Schema.String),
})

const DeleteInput = Schema.Struct({
  id: Schema.String,
  confirm: Schema.optionalKey(Schema.Boolean),
  force: Schema.optionalKey(Schema.Boolean),
})

const LogInput = Schema.Struct({
  where: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Number),
  offset: Schema.optionalKey(Schema.Number),
})

export async function registerInstructionTools(ctx: Context, api: PlusApi): Promise<Registration> {
  return runRegistration(ctx.tool.transform, (editor) => {
    editor.namespace({ name: namespace, description: "Instruction rows: tools, base prompts, skills, system files, MCP, teams." })
    editor.add({
      name: "list",
      description: ListDescription,
      input: ListInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: (input) =>
        Effect.gen(function* () {
          const snapshot = yield* snapshotOrFail(api)
          const memo = memoFromSnapshot(snapshot)
          const queried = yield* Effect.try({
            try: () =>
              query(memo, {
                ...(input.where === undefined ? {} : { where: input.where }),
                ...(input.fields === undefined ? {} : { fields: [...input.fields] }),
                ...(input.sort === undefined ? {} : { sort: input.sort }),
                limit: input.limit ?? 40,
                ...(input.offset === undefined ? {} : { offset: input.offset }),
              }),
            catch: (error) => new Tool.Error({ message: error instanceof Error ? error.message : String(error) }),
          })
          return { output: queried }
        }),
    })
    editor.add({
      name: "show",
      description: ShowDescription,
      input: ShowInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: (input) =>
        Effect.gen(function* () {
          const view = input.view ?? "resolved"
          if (view === "assembled") return yield* showAssembled(api, input.id)
          return yield* showRow(api, input.id, view)
        }),
    })
    editor.add({
      name: "set",
      description: SetDescription,
      input: SetInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: (input, context) =>
        Effect.gen(function* () {
          const actor = actorFrom(context)
          const snapshot = yield* snapshotOrFail(api)
          const memo = memoFromSnapshot(snapshot)
          const node = findRow(memo, input.id)
          if (node === undefined) return yield* Effect.fail(unknownError(input.id))
          const protectedAgent = protectedOf(snapshot, node)
          if (protectedAgent !== undefined) return yield* Effect.fail(protectedError(protectedAgent))
          if (input.preset !== undefined) return yield* setLink(api, snapshot, node, input.preset, actor)
          if (node.kind === "team" && node.depth === 2) return yield* setTeam(api, memo, input.id, actor, input)
          if (isModelRowId(input.id) || node.address?.item.startsWith("model:")) return yield* setModel(api, snapshot, memo, input.id, actor, input)
          if (isPermRowId(input.id) || node.address?.item.startsWith("perm:")) return yield* setPerm(api, snapshot, memo, input.id, actor, input)
          const op = computeSet(memo, input)
          if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
          const applied = yield* mutateWithRetry(api, snapshot, op, actor, (fresh) =>
            computeSet(memoFromSnapshot(fresh), input),
          )
          return { output: { id: input.id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
        }),
    })
    editor.add({
      name: "reset",
      description: ResetDescription,
      input: ResetInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: (input, context) =>
        Effect.gen(function* () {
          const actor = actorFrom(context)
          const snapshot = yield* snapshotOrFail(api)
          const memo = memoFromSnapshot(snapshot)
          const node = findRow(memo, input.id)
          if (node === undefined) return yield* Effect.fail(unknownError(input.id))
          const protectedAgent = protectedOf(snapshot, node)
          if (protectedAgent !== undefined) return yield* Effect.fail(protectedError(protectedAgent))
          if (isModelRowId(input.id) || node.address?.item.startsWith("model:")) return yield* resetModel(api, snapshot, memo, input.id, actor)
          const op = reset(memo, input.id)
          if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
          const applied = yield* mutateWithRetry(api, snapshot, op, actor, (fresh) => reset(memoFromSnapshot(fresh), input.id))
          return { output: { id: input.id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
        }),
    })
    editor.add({
      name: "split",
      description: SplitDescription,
      input: SplitInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: (input, context) =>
        Effect.gen(function* () {
          const actor = actorFrom(context)
          const snapshot = yield* snapshotOrFail(api)
          const memo = memoFromSnapshot(snapshot)
          const node = findRow(memo, input.id)
          if (node === undefined) return yield* Effect.fail(unknownError(input.id))
          const protectedAgent = protectedOf(snapshot, node)
          if (protectedAgent !== undefined) return yield* Effect.fail(protectedError(protectedAgent))
          const op = computeSplit(memo, input)
          if (typeof op === "string") return yield* Effect.fail(new Tool.Error({ message: op }))
          if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
          const applied = yield* mutateWithRetry(api, snapshot, op, actor, (fresh) => {
            const retry = computeSplit(memoFromSnapshot(fresh), input)
            if (typeof retry === "string") return { refusal: retry }
            return retry
          })
          return { output: { id: input.id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
        }),
    })
    editor.add({
      name: "create",
      description: CreateDescription,
      input: CreateInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: (input, context) =>
        Effect.gen(function* () {
          return yield* createRow(api, input, actorFrom(context))
        }),
    })
    editor.add({
      name: "delete",
      description: DeleteDescription,
      input: DeleteInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: (input, context) =>
        Effect.gen(function* () {
          if (input.confirm !== true)
            return yield* Effect.fail(new Tool.Error({ message: "delete.unconfirmed: delete requires confirm:true" }))
          const actor = actorFrom(context)
          const snapshot = yield* snapshotOrFail(api)
          const memo = memoFromSnapshot(snapshot)
          const node = findRow(memo, input.id)
          if (node === undefined) return yield* Effect.fail(unknownError(input.id))
          const protectedAgent = protectedOf(snapshot, node)
          if (protectedAgent !== undefined) return yield* Effect.fail(protectedError(protectedAgent))
          if (isModelRowId(input.id) || node.address?.item.startsWith("model:")) return yield* deleteModelRow(api, snapshot, memo, input.id, actor)
          if (isPermRowId(input.id) || node.address?.item.startsWith("perm:")) return yield* deleteRuleRow(api, snapshot, memo, input.id, actor)
          const plan = removalPlan(memo, input.id)
          if ("refusal" in plan) return yield* Effect.fail(new Tool.Error({ message: plan.refusal }))
          return yield* deletePlan(api, plan, actor, input.force === true)
        }),
    })
    editor.add({
      name: "log",
      description: LogDescription,
      input: LogInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: (input) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            api.log({
              ...(input.where === undefined ? {} : { where: input.where }),
              ...(input.limit === undefined ? {} : { limit: input.limit }),
              ...(input.offset === undefined ? {} : { offset: input.offset }),
            }),
          )
          if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `project.disabled: ${result.error.message}` }))
          return { output: result.value }
        }),
    })
  })
}

function snapshotOrFail(api: PlusApi): Effect.Effect<Plus.Snapshot, Tool.Error> {
  return Effect.gen(function* () {
    const result = yield* Effect.promise(() => api.snapshot())
    if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `project.disabled: ${result.error.message}` }))
    return result.value
  })
}

function actorFrom(context: Tool.Context): Plus.Actor {
  return {
    type: "tool",
    agent: String(context.agent),
    sessionID: String(context.sessionID),
    messageID: String(context.messageID),
  }
}

function unknownError(id: string): Tool.Error {
  return new Tool.Error({ message: `row.unknown: ${unknownRowRefusal(id)}` })
}

function protectedError(agent: string): Tool.Error {
  return new Tool.Error({ message: `agent.protected: row belongs to protected agent "${agent}"` })
}

function memoFromSnapshot(snapshot: Plus.Snapshot): MemoInput {
  const memo = memoInputOf(snapshot)
  return {
    ...memo,
    records: memo.records.map((record, index) => {
      const snap = snapshot.records[index]
      if (snap?.team !== undefined) {
        return { ...record, team: snap.team }
      }
      return record
    }),
  }
}

// A state-only write (set with just `state`) resubmits every record, so this
// serializer has to carry the same optional fields `toRecord` (index.ts) and
// `toRpcRecords` (tui/instructions/state.ts) preserve. Two are easy to drop
// silently: a rule's `message` — the refusal text the model reads — and the
// shared-inventory `catalogue`, which decides whether a Defaults row resolves
// through the Agents or the Teams catalogue. Absent keys stay absent so an
// unset field encodes exactly as it did before it existed.
function toSnapshotRecords(
  records: readonly CustomizationRecord[],
  splits: readonly SplitRecord[],
  models?: readonly ModelRecord[],
  rules?: readonly RuleRecord[],
): Plus.SnapshotRecord[] {
  return [
    ...records.map(
      (record): Plus.SnapshotRecord => ({
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
        basedOn: record.basedOn,
        ...(record.basedOnText === undefined ? {} : { basedOnText: record.basedOnText }),
        ...(record.acknowledged === undefined ? {} : { acknowledged: record.acknowledged }),
        ...(record.basedOnState === undefined ? {} : { basedOnState: record.basedOnState }),
        ...(record.basedOnPin === undefined ? {} : { basedOnPin: record.basedOnPin }),
        updated: record.updated,
      }),
    ),
    ...splits.map(
      (split): Plus.SnapshotRecord => ({
        type: "split",
        level: split.level,
        agent: split.agent,
        ...(split.team !== undefined ? { team: split.team } : {}),
        ...(split.catalogue === undefined ? {} : { catalogue: split.catalogue }),
        item: split.item,
        boundaries: split.boundaries.map((boundary) => ({ ...boundary })),
        updated: split.updated,
      }),
    ),
    ...(models ?? []).map(
      (record): Plus.SnapshotRecord => ({
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
        updated: record.updated,
      }),
    ),
    ...(rules ?? []).map(
      (record): Plus.SnapshotRecord => ({
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
      }),
    ),
  ]
}

function modelsOfMemo(memo: MemoInput): ModelRecord[] {
  return memo.records.filter((record): record is ModelRecord => record.type === "model")
}

function rulesOfMemo(memo: MemoInput): RuleRecord[] {
  return memo.records.filter((record): record is RuleRecord => record.type === "rule")
}

// Presets are not agents: their rows (and a preset that happens to share a
// protected agent's id) are never protected. Every agent, member or team
// member row still is, its link included.
function protectedOf(snapshot: Plus.Snapshot, node: TreeNode): string | undefined {
  if (node.owner?.level === "preset" || node.address?.level === "preset") return undefined
  if (node.kind === "agent") {
    const agent = node.id.split(":").slice(2).join(":")
    if (agent !== "" && snapshot.protectedAgents.includes(agent)) return agent
    return undefined
  }
  const owner = node.address?.agent ?? node.owner?.agent
  if (owner !== undefined && owner !== null && snapshot.protectedAgents.includes(owner)) return owner
  return undefined
}

// `set {id, preset}`: relink (or with null unlink) the row's owner.
function setLink(
  api: PlusApi,
  snapshot: Plus.Snapshot,
  node: TreeNode,
  preset: string | Plus.PresetRef | null,
  actor: Plus.Actor,
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const owner = node.owner
    if (owner === undefined)
      return yield* Effect.fail(
        new Tool.Error({
          message: `link.invalid: "${node.label}" takes no preset; agent, member, team, Defaults entry and user preset rows do`,
        }),
      )
    const ref = preset === null ? null : presetRefOf(snapshot, preset, owner.agent === null)
    if (ref === undefined) return yield* Effect.fail(new Tool.Error({ message: `preset.invalid: unknown preset ${JSON.stringify(preset)}` }))
    const result = yield* Effect.promise(() =>
      api.setLink({
        level: owner.level,
        agent: owner.agent,
        ...(owner.team === undefined ? {} : { team: owner.team }),
        ...(owner.catalogue === undefined ? {} : { catalogue: owner.catalogue }),
        preset: ref,
        actor,
      }),
    )
    if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
    // A team relink also relinks the members the team preset has.
    const members = result.value.members ?? []
    const said = result.value.preset === null ? `Unlinked "${node.label}"` : `Linked "${node.label}" to ${presetKey(result.value.preset)}`
    return {
      output: {
        id: node.id,
        preset: result.value.preset,
        ...(result.value.members === undefined ? {} : { members }),
        status: members.length === 0 ? said : `${said}; relinked ${members.map((member) => member.agent).join(", ")}`,
      },
    }
  })
}

// The string form of a preset: an agent preset id, else `<team>/<member>`
// (team ids never hold `/`, so the first one splits); a team owner takes a
// team preset id. Undefined when no preset answers to it.
function presetRefOf(snapshot: Plus.Snapshot, input: string | Plus.PresetRef, team = false): Plus.PresetRef | undefined {
  if (typeof input !== "string") return input
  const listing = snapshot.listing ?? presetListing((snapshot.presets ?? []).map(presetOf))
  const known = (ref: Plus.PresetRef) => listing.some((entry) => presetKey(entry.ref) === presetKey(ref))
  const name = input.trim()
  if (team) return known({ kind: "team", id: name }) ? { kind: "team", id: name } : undefined
  if (known({ kind: "agent", id: name })) return { kind: "agent", id: name }
  const slash = name.indexOf("/")
  if (slash === -1) return undefined
  const member: Plus.PresetRef = { kind: "member", team: name.slice(0, slash), id: name.slice(slash + 1) }
  return known(member) ? member : undefined
}

function computeSet(
  memo: MemoInput,
  input: { id: string; mode?: "primary" | "subagent" | "all"; text?: string; state?: "on" | "off"; pin?: boolean; resolve?: "keep" | "take" | "edit" },
) {
  const preserved = modelsOfMemo(memo)
  const preservedRules = rulesOfMemo(memo)
  const withModels = (records: readonly CustomizationRecord[], splits: readonly SplitRecord[]): MemoInput => ({
    ...memo,
    records: [...records, ...splits, ...preserved, ...preservedRules],
  })
  if (input.mode !== undefined) {
    const first = setAgentMode(memo, input.id, input.mode)
    if ("refusal" in first || (input.state === undefined && input.text === undefined && input.pin === undefined && input.resolve === undefined)) return first
    return computeSet(withModels(first.records, first.splits), { ...input, mode: undefined })
  }
  if (input.resolve !== undefined) {
    if (input.pin === undefined && input.state === undefined) return resolveReview(memo, input.id, input.resolve, input.text)
    const first = resolveReview(memo, input.id, input.resolve, input.text)
    if ("refusal" in first) return first
    let interim: MemoInput = withModels(first.records, first.splits)
    if (input.state !== undefined) {
      const second = setEnabled(interim, input.id, input.state === "on")
      if ("refusal" in second) return second
      interim = withModels(second.records, second.splits)
      if (input.pin === undefined) return second
    }
    if (input.pin !== undefined) return setPin(interim, input.id, input.pin)
    return first
  }
  if (input.text !== undefined && input.state !== undefined && input.pin !== undefined) {
    const first = saveText(memo, input.id, input.text)
    if ("refusal" in first) return first
    const interim: MemoInput = withModels(first.records, first.splits)
    const second = setEnabled(interim, input.id, input.state === "on")
    if ("refusal" in second) return second
    const interim2: MemoInput = withModels(second.records, second.splits)
    return setPin(interim2, input.id, input.pin)
  }
  if (input.text !== undefined && input.state !== undefined) {
    const first = saveText(memo, input.id, input.text)
    if ("refusal" in first) return first
    const interim: MemoInput = withModels(first.records, first.splits)
    return setEnabled(interim, input.id, input.state === "on")
  }
  if (input.text !== undefined && input.pin !== undefined) {
    const first = saveText(memo, input.id, input.text)
    if ("refusal" in first) return first
    const interim: MemoInput = withModels(first.records, first.splits)
    return setPin(interim, input.id, input.pin)
  }
  if (input.state !== undefined && input.pin !== undefined) {
    const first = setEnabled(memo, input.id, input.state === "on")
    if ("refusal" in first) return first
    const interim: MemoInput = withModels(first.records, first.splits)
    return setPin(interim, input.id, input.pin)
  }
  if (input.text !== undefined) return saveText(memo, input.id, input.text)
  if (input.state !== undefined) return setEnabled(memo, input.id, input.state === "on")
  if (input.pin !== undefined) return setPin(memo, input.id, input.pin)
  return toggle(memo, input.id)
}

function computeSplit(
  memo: MemoInput,
  input: { id: string; boundaries?: readonly { id: string; name: string; start: number }[]; add?: { name: string; text: string } },
): { records: CustomizationRecord[]; splits: SplitRecord[]; status: string; retryHint: string } | { refusal: string } | string {
  if (input.add !== undefined) return addSection(memo, input.id, input.add.name, input.add.text)
  if (input.boundaries !== undefined) return saveSplit(memo, input.id, [...input.boundaries])
  return "split requires boundaries or add"
}

function mutateWithRetry(
  api: PlusApi,
  snapshot: Plus.Snapshot,
  op: { records: CustomizationRecord[]; splits: SplitRecord[]; models?: readonly ModelRecord[]; status: string },
  actor: Plus.Actor,
  recompute: (fresh: Plus.Snapshot) => { records: CustomizationRecord[]; splits: SplitRecord[]; models?: readonly ModelRecord[]; status: string } | { refusal: string },
): Effect.Effect<{ revision: number; globalRevision: number; status: string }, Tool.Error> {
  return Effect.gen(function* () {
    const models = op.models ?? modelsOfMemo(memoFromSnapshot(snapshot))
    const rules = rulesOfMemo(memoFromSnapshot(snapshot))
    const first = yield* Effect.promise(() =>
      api.mutate({
        expectedRevision: snapshot.revision,
        expectedGlobalRevision: snapshot.globalRevision,
        records: toSnapshotRecords(op.records, op.splits, models, rules),
        actor,
      }),
    )
    if (!first.ok) return yield* Effect.fail(new Tool.Error({ message: `project.disabled: ${first.error.message}` }))
    if (first.value.ok) return { revision: first.value.revision, globalRevision: first.value.globalRevision, status: op.status }
    const fresh = yield* Effect.promise(() => api.snapshot())
    if (!fresh.ok) return yield* Effect.fail(new Tool.Error({ message: `project.disabled: ${fresh.error.message}` }))
    const retry = recompute(fresh.value)
    if ("refusal" in retry) return yield* Effect.fail(new Tool.Error({ message: retry.refusal }))
    const retryModels = retry.models ?? modelsOfMemo(memoFromSnapshot(fresh.value))
    const retryRules = rulesOfMemo(memoFromSnapshot(fresh.value))
    const second = yield* Effect.promise(() =>
      api.mutate({
        expectedRevision: fresh.value.revision,
        expectedGlobalRevision: fresh.value.globalRevision,
        records: toSnapshotRecords(retry.records, retry.splits, retryModels, retryRules),
        actor,
      }),
    )
    if (!second.ok) return yield* Effect.fail(new Tool.Error({ message: `project.disabled: ${second.error.message}` }))
    if (second.value.ok)
      return { revision: second.value.revision, globalRevision: second.value.globalRevision, status: retry.status }
    return yield* Effect.fail(new Tool.Error({ message: "stale: write conflicted twice; re-read and retry" }))
  })
}

function mutateModelsWithRetry(
  api: PlusApi,
  snapshot: Plus.Snapshot,
  memo: MemoInput,
  models: ModelRecord[],
  status: string,
  actor: Plus.Actor,
  recompute: (fresh: Plus.Snapshot) => { models: ModelRecord[]; status: string } | { refusal: string },
): Effect.Effect<{ revision: number; globalRevision: number; status: string }, Tool.Error> {
  return Effect.gen(function* () {
    const customizations = memo.records.filter((record): record is CustomizationRecord => record.type === "customization")
    const splits = memo.records.filter((record): record is SplitRecord => record.type === "split")
    const rules = memo.records.filter((record): record is RuleRecord => record.type === "rule")
    const first = yield* Effect.promise(() =>
      api.mutate({
        expectedRevision: snapshot.revision,
        expectedGlobalRevision: snapshot.globalRevision,
        records: toSnapshotRecords(customizations, splits, models, rules),
        actor,
      }),
    )
    if (!first.ok) return yield* Effect.fail(new Tool.Error({ message: `project.disabled: ${first.error.message}` }))
    if (first.value.ok) return { revision: first.value.revision, globalRevision: first.value.globalRevision, status }
    const fresh = yield* Effect.promise(() => api.snapshot())
    if (!fresh.ok) return yield* Effect.fail(new Tool.Error({ message: `project.disabled: ${fresh.error.message}` }))
    const retry = recompute(fresh.value)
    if ("refusal" in retry) return yield* Effect.fail(new Tool.Error({ message: retry.refusal }))
    const freshMemo = memoFromSnapshot(fresh.value)
    const freshCustom = freshMemo.records.filter((record): record is CustomizationRecord => record.type === "customization")
    const freshSplits = freshMemo.records.filter((record): record is SplitRecord => record.type === "split")
    const freshRules = freshMemo.records.filter((record): record is RuleRecord => record.type === "rule")
    const second = yield* Effect.promise(() =>
      api.mutate({
        expectedRevision: fresh.value.revision,
        expectedGlobalRevision: fresh.value.globalRevision,
        records: toSnapshotRecords(freshCustom, freshSplits, retry.models, freshRules),
        actor,
      }),
    )
    if (!second.ok) return yield* Effect.fail(new Tool.Error({ message: `project.disabled: ${second.error.message}` }))
    if (second.value.ok)
      return { revision: second.value.revision, globalRevision: second.value.globalRevision, status: retry.status }
    return yield* Effect.fail(new Tool.Error({ message: "stale: write conflicted twice; re-read and retry" }))
  })
}

function setModel(
  api: PlusApi,
  snapshot: Plus.Snapshot,
  memo: MemoInput,
  id: string,
  actor: Plus.Actor,
  input: { text?: string; state?: "on" | "off"; pin?: boolean; active?: boolean; resolve?: "keep" | "take" | "edit" },
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const node = findRow(memo, id)
    const label = node?.label ?? id
    // A limit row's text is its number: `set({ id, text: "8" })` changes the
    // cap; every other perm row keeps its text in its rule.
    if (input.text !== undefined) {
      const upstream = node?.address === undefined ? undefined : upstreamOf(memo, node.address)
      if (upstream === undefined || !isValueRow(upstream)) return yield* Effect.fail(new Tool.Error({ message: editRefusalForLabel(label) }))
      if (limitOf(input.text) === undefined)
        return yield* Effect.fail(new Tool.Error({ message: `"${label}" takes a number (got "${input.text}")` }))
      const text = String(limitOf(input.text))
      const op = computeSet(memo, { id, text })
      if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
      const applied = yield* mutateWithRetry(api, snapshot, op, actor, (fresh) => computeSet(memoFromSnapshot(fresh), { id, text }))
      return { output: { id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
    }
    if (input.resolve !== undefined) return yield* Effect.fail(new Tool.Error({ message: resolveRefusalForLabel(label) }))
    if (input.pin !== undefined) return yield* Effect.fail(new Tool.Error({ message: `"${label}" cannot be pinned` }))
    if (input.state !== undefined) return yield* Effect.fail(new Tool.Error({ message: `"${label}" cannot be toggled by state; use active:true to activate` }))
    const op = activateModelRow(memo, id)
    if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
    const applied = yield* mutateModelsWithRetry(api, snapshot, memo, op.models, op.status, actor, (fresh) => {
      const retry = activateModelRow(memoFromSnapshot(fresh), id)
      if ("refusal" in retry) return retry
      return { models: retry.models, status: retry.status }
    })
    return { output: { id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
  })
}

function setPerm(
  api: PlusApi,
  snapshot: Plus.Snapshot,
  memo: MemoInput,
  id: string,
  actor: Plus.Actor,
  input: { text?: string; state?: "on" | "off"; pin?: boolean; active?: boolean; resolve?: "keep" | "take" | "edit"; label?: string; patterns?: readonly string[]; keywords?: readonly string[]; message?: string },
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const node = findRow(memo, id)
    const label = node?.label ?? id
    if (input.label !== undefined || input.patterns !== undefined || input.keywords !== undefined || input.message !== undefined)
      return yield* updateRuleRow(api, snapshot, memo, id, actor, {
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.patterns === undefined ? {} : { patterns: input.patterns }),
        ...(input.keywords === undefined ? {} : { keywords: input.keywords }),
        ...(input.message === undefined ? {} : { message: input.message }),
      })
    // A limit row's text is its number: `set({ id, text: "8" })` changes the
    // cap; every other perm row keeps its text in its rule.
    if (input.text !== undefined) {
      const upstream = node?.address === undefined ? undefined : upstreamOf(memo, node.address)
      if (upstream === undefined || !isValueRow(upstream)) return yield* Effect.fail(new Tool.Error({ message: editRefusalForLabel(label) }))
      if (limitOf(input.text) === undefined)
        return yield* Effect.fail(new Tool.Error({ message: `"${label}" takes a number (got "${input.text}")` }))
      const text = String(limitOf(input.text))
      const op = computeSet(memo, { id, text })
      if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
      const applied = yield* mutateWithRetry(api, snapshot, op, actor, (fresh) => computeSet(memoFromSnapshot(fresh), { id, text }))
      return { output: { id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
    }
    if (input.resolve !== undefined) return yield* Effect.fail(new Tool.Error({ message: resolveRefusalForLabel(label) }))
    if (input.pin !== undefined) return yield* Effect.fail(new Tool.Error({ message: `"${label}" cannot be pinned` }))
    if (input.active !== undefined) return yield* Effect.fail(new Tool.Error({ message: `"${label}" cannot be activated` }))
    const op = computeSet(memo, { id, ...(input.state === undefined ? {} : { state: input.state }) })
    if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
    const applied = yield* mutateWithRetry(api, snapshot, op, actor, (fresh) =>
      computeSet(memoFromSnapshot(fresh), { id, ...(input.state === undefined ? {} : { state: input.state }) }),
    )
    return { output: { id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
  })
}

function resetModel(
  api: PlusApi,
  snapshot: Plus.Snapshot,
  memo: MemoInput,
  id: string,
  actor: Plus.Actor,
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const op = resetModelRow(memo, id)
    if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
    const applied = yield* mutateModelsWithRetry(api, snapshot, memo, op.models, op.status, actor, (fresh) => {
      const retry = resetModelRow(memoFromSnapshot(fresh), id)
      if ("refusal" in retry) return retry
      return { models: retry.models, status: retry.status }
    })
    return { output: { id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
  })
}

function deleteModelRow(
  api: PlusApi,
  snapshot: Plus.Snapshot,
  memo: MemoInput,
  id: string,
  actor: Plus.Actor,
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const address = findRow(memo, id)?.address
    if (address === undefined) return yield* Effect.fail(unknownError(id))
    const parsed = parseModelItemId(address.item)
    if (parsed === undefined) return yield* Effect.fail(unknownError(id))
    const result = yield* Effect.promise(() =>
      api.removeModel({
        level: address.level,
        agent: address.agent,
        providerID: parsed.providerID,
        modelID: parsed.modelID,
        ...(parsed.variant === undefined ? {} : { variant: parsed.variant }),
        actor,
      }),
    )
    if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
    return { output: { ...result.value, status: `Removed "${id}"` } }
  })
}

function deleteRuleRow(
  api: PlusApi,
  snapshot: Plus.Snapshot,
  memo: MemoInput,
  id: string,
  actor: Plus.Actor,
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const found = findRow(memo, id)
    const address = found?.address
    if (address === undefined) return yield* Effect.fail(unknownError(id))
    const parsed = parsePermItemId(address.item)
    if (parsed === undefined) return yield* Effect.fail(unknownError(id))
    const item = memo.items.find((entry) => entry.id === address.item)
    if (item?.custom !== true) {
      const label = found?.label ?? id
      return yield* Effect.fail(new Tool.Error({ message: `"${label}" cannot be deleted: only user-created rules can be deleted` }))
    }
    // Custom rules display globally: the selected row's agent is whatever
    // subtree the user happened to open, not the record's owner. Validate the
    // owner of the record actually matched (by global tool+id identity) before
    // deleting, or a rule owned by protected alpha is deletable through beta.
    const existing = memo.records.find(
      (record): record is RuleRecord => record.type === "rule" && record.tool === parsed.tool && record.id === parsed.ruleId,
    )
    if (existing === undefined) return yield* Effect.fail(unknownError(id))
    if (existing.agent !== null && snapshot.protectedAgents.includes(existing.agent))
      return yield* Effect.fail(protectedError(existing.agent))
    const result = yield* Effect.promise(() =>
      api.removeRule({ level: existing.level, agent: existing.agent, tool: parsed.tool, id: parsed.ruleId, actor }),
    )
    if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
    return { output: { ...result.value, status: `Removed "${id}"` } }
  })
}

function updateRuleRow(
  api: PlusApi,
  snapshot: Plus.Snapshot,
  memo: MemoInput,
  id: string,
  actor: Plus.Actor,
  input: { label?: string; patterns?: readonly string[]; keywords?: readonly string[]; message?: string },
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const found = findRow(memo, id)
    const address = found?.address
    if (address === undefined) return yield* Effect.fail(unknownError(id))
    const parsed = parsePermItemId(address.item)
    if (parsed === undefined) return yield* Effect.fail(unknownError(id))
    // Same global-identity protection as delete: the row's agent is whatever
    // subtree is open, so check the matched record's owner before writing, or
    // a protected owner's rule is editable through another agent's row. The
    // PlusApi updateRule repeats this guard at the shared boundary, so direct
    // RPC callers inherit it too.
    const existing = memo.records.find(
      (record): record is RuleRecord => record.type === "rule" && record.tool === parsed.tool && record.id === parsed.ruleId,
    )
    if (existing !== undefined && existing.agent !== null && snapshot.protectedAgents.includes(existing.agent))
      return yield* Effect.fail(protectedError(existing.agent))
    // A message-only edit derives label and patterns from the rule it edits
    // (the user record, else the upstream perm item it materialises), so
    // `set({ id, message })` works without restating the whole rule.
    const upstream = upstreamOf(memo, address)
    const label = input.label ?? existing?.label ?? upstream?.title
    const patterns = input.patterns ?? existing?.patterns ?? upstream?.patterns
    if (label === undefined || patterns === undefined)
      return yield* Effect.fail(new Tool.Error({ message: "set rule requires label and patterns" }))
    const result = yield* Effect.promise(() =>
      api.updateRule({
        level: address.level,
        agent: address.agent,
        // The row's own address decides where a first write (an override of
        // this curated/mined row) materialises: a Teams-catalogue row must
        // create a Teams rule, not an Agents one. A matched record keeps its
        // stored catalogue server-side, so this only matters for a new one.
        ...(address.catalogue === undefined ? {} : { catalogue: address.catalogue }),
        tool: parsed.tool,
        id: parsed.ruleId,
        label,
        patterns: [...patterns],
        ...(input.keywords === undefined ? {} : { keywords: [...input.keywords] }),
        ...(input.message === undefined ? {} : { message: input.message }),
        actor,
      }),
    )
    if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
    return { output: { ...result.value, status: `Updated "${id}"` } }
  })
}

function setTeam(
  api: PlusApi,
  memo: MemoInput,
  id: string,
  actor: Plus.Actor,
  input: { state?: "on" | "off"; text?: string; pin?: boolean; resolve?: "keep" | "take" | "edit" },
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const node = findRow(memo, id)
    const label = node?.label ?? id
    if (input.text !== undefined) return yield* Effect.fail(new Tool.Error({ message: editRefusalForLabel(label) }))
    if (input.resolve !== undefined) return yield* Effect.fail(new Tool.Error({ message: resolveRefusalForLabel(label) }))
    if (input.pin !== undefined) {
      const pinned = setPin(memo, id, input.pin)
      if ("refusal" in pinned) return yield* Effect.fail(new Tool.Error({ message: pinned.refusal }))
      return yield* Effect.fail(new Tool.Error({ message: pinned.status }))
    }
    const desired = input.state === undefined ? undefined : input.state === "on"
    const plan = teamPlan(memo, id, desired)
    if ("refusal" in plan) return yield* Effect.fail(new Tool.Error({ message: plan.refusal }))
    const result = yield* Effect.promise(() => api.setTeamEnabled({ level: plan.level, team: plan.team, enabled: plan.enabled, actor }))
    if (!result.ok)
      return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
    return { output: { id, status: plan.successStatus, ...result.value } }
  })
}

function showAssembled(api: PlusApi, id: string): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    // Presets and Defaults entries are not agents: nothing assembles for them.
    if (!/^agent:(project|global|defaults):/.test(id))
      return yield* Effect.fail(new Tool.Error({ message: `view.unsupported: assembled view needs an agent row id (got ${id})` }))
    const agent = id.split(":").slice(2).join(":")
    if (agent === "")
      return yield* Effect.fail(new Tool.Error({ message: `view.unsupported: assembled view needs an agent row id (got ${id})` }))
    const result = yield* Effect.promise(() => api.assembled({ agent }))
    if (!result.ok)
      return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
    return { output: { id, view: "assembled", ...result.value } }
  })
}

function showRow(api: PlusApi, id: string, view: string): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const snapshot = yield* snapshotOrFail(api)
    const memo = memoFromSnapshot(snapshot)
    const node = findRow(memo, id)
    if (node === undefined) return yield* Effect.fail(unknownError(id))
    // Presets and Defaults entries carry no text of their own: resolved and
    // record render what the row is and what it is linked to.
    const owner = node.owner
    if (owner !== undefined && (owner.preset !== undefined || owner.entry !== undefined)) {
      if (view !== "resolved" && view !== "record")
        return yield* Effect.fail(new Tool.Error({ message: `view.unsupported: ${view} view is not available for this row (got ${id})` }))
      const entity = {
        kind: owner.preset !== undefined ? ("preset" as const) : ("entry" as const),
        label: node.label,
        ...(owner.preset === undefined ? {} : { preset: owner.preset.ref, origin: owner.preset.origin }),
        ...(owner.entry === undefined ? {} : { entry: owner.entry }),
        link: owner.link ?? null,
        ...(owner.linkMissing === true ? { linkMissing: true } : {}),
      }
      if (view === "record") return { output: { id, view, record: entity } }
      return { output: { id, view, ...entity } }
    }
    if (node.kind === "team") {
      // Team and member rows carry no item address, so resolved/record render
      // the entity these rows stand for; every other view stays refused.
      const entity = teamRowEntity(memo, node)
      if (entity === undefined) return yield* Effect.fail(unknownError(id))
      if (view !== "resolved" && view !== "record")
        return yield* Effect.fail(
          new Tool.Error({ message: `view.unsupported: ${view} view is not available for team rows (got ${id})` }),
        )
      if (view === "record") return { output: { id, view, record: entity } }
      return { output: { id, view, ...entity } }
    }
    if (node.address === undefined)
      return yield* Effect.fail(new Tool.Error({ message: `view.unsupported: ${view} view needs an addressed row (got ${id})` }))
    const address = node.address
    const customizations = memo.records.filter(
      (record): record is CustomizationRecord => record.type === "customization",
    )
    const splits = memo.records.filter((record): record is SplitRecord => record.type === "split")
    const scopes = contextOfSnapshot(snapshot)
    const upstream = upstreamOf(memo, address)
    if (upstream === undefined) return yield* Effect.fail(new Tool.Error({ message: `Item not found for "${node.label}"` }))
    if (view === "record") {
      return { output: { id, view, record: recordOfRow(memo, address, customizations) } }
    }
    if (upstream.kind === "perm") {
      const chain = { upstream, records: customizations, splits, scopes, address }
      const resolved = resolve(chain)
      const patterns = upstream.patterns === undefined ? [] : [...upstream.patterns]
      const keywords = upstream.keywords === undefined ? [] : [...upstream.keywords]
      const provenance = upstream.provenance === undefined ? [] : [...upstream.provenance]
      const parent = memo.items.find((entry) => entry.id === `tool:${upstream.permTool ?? ""}`)
      const scrubbed = parent === undefined ? { text: "", hidden: 0, preview: [] as readonly string[] } : scrubLines(parent.text, keywords)
      const message = ruleMessageOf(snapshot, upstream)
      return {
        output: {
          id,
          view,
          tool: upstream.permTool ?? "",
          rule: upstream.ruleId ?? "",
          label: upstream.title,
          patterns,
          keywords,
          provenance,
          custom: upstream.custom === true,
          enabled: resolved.enabled,
          source: resolved.source,
          stateFrom: resolved.from,
          textFrom: resolved.textFrom,
          // Where the row is listed and how it is enforced (permission-catalog.ts).
          category: upstream.category ?? "",
          kind: upstream.permKind ?? "rule",
          ...(upstream.field === undefined ? {} : { field: upstream.field }),
          ...(upstream.value === undefined ? {} : { value: upstream.value }),
          ...(isValueRow(upstream) ? { limit: limitOf(resolved.text) ?? null } : {}),
          scrub: { hidden: scrubbed.hidden, preview: [...scrubbed.preview] },
          // The refusal text the model reads when this rule denies: a user
          // rule's own message or the curated one it ships.
          ...(message === undefined ? {} : { message }),
          // Team policy rows only: the rules the row installs on either side,
          // each with the message it refuses with, so a reader sees what the
          // rule says and not just that it exists.
          ...(upstream.policy === undefined
            ? {}
            : { policy: { on: [...upstream.policy.on], off: [...upstream.policy.off] } }),
        },
      }
    }
    const chain = { upstream, records: customizations, splits, scopes, address }
    if (view === "resolved") {
      const resolved = resolve(chain)
      return {
        output: {
          id,
          view,
          text: resolved.text,
          assembled: resolved.assembled,
          enabled: resolved.enabled,
          source: resolved.source,
          stateFrom: resolved.from,
          textFrom: resolved.textFrom,
          ...(node.badges.fromLabel === undefined ? {} : { from: node.badges.fromLabel }),
          ...(node.badges.reviewOf === undefined ? {} : { reviewOf: node.badges.reviewOf }),
        },
      }
    }
    if (view === "upstream") return { output: { id, view, text: upstreamForEdit(chain) } }
    if (view === "mine") {
      const own = customizations.find(
        (record) =>
          record.level === address.level &&
          record.agent === address.agent &&
          sameTeam(record.team, address.team) &&
          record.item === address.item &&
          record.section === address.section,
      )
      return { output: { id, view, text: own?.text ?? "", hasOverride: own?.text !== undefined } }
    }
    if (view === "sections") {
      const resolved = resolve(chain)
      const split = resolveSplit({ text: resolved.text, title: upstream.title, splits, scopes, address })
      return { output: { id, view, sections: split.sections.map((section) => section.id) } }
    }
    const three = threeWay(chain)
    if (three === undefined) return { output: { id, view: "diff", mineDiff: "", upstreamDiff: "", summary: "no changes" } }
    const mineDiff = unifiedDiff(three.original, three.mine, { from: "original", to: "mine" })
    const upstreamDiff = unifiedDiff(three.original, three.upstream, { from: "original", to: "upstream" })
    const summary = `mine differs by ${changedLines(three.original, three.mine)} lines, upstream by ${changedLines(three.original, three.upstream)} lines`
    return { output: { id, view: "diff", mineDiff, upstreamDiff, summary } }
  })
}

function upstreamOf(memo: MemoInput, address: Pick<Address, "item" | "agent" | "team" | "memberOf">) {
  if (isControl(address.item)) return controlItemFor(memo.items, address)
  const matches = memo.items.filter((item) => item.id === address.item)
  if (address.agent === null) return matches[0]
  return matches.find((item) => applies(item, address.agent as string)) ?? matches[0]
}

// The refusal text a perm row installs: a user rule's own stored message
// wins, a curated row ships one, a mined row has none and keeps core's
// generic refusal.
function ruleMessageOf(snapshot: Plus.Snapshot, item: Item): string | undefined {
  const tool = item.permTool
  const rule = item.ruleId
  if (tool === undefined || rule === undefined) return undefined
  if (item.custom !== true) return curatedRuleMessage(tool, rule) ?? item.message
  const record = snapshot.records.find(
    (entry): entry is Plus.SnapshotRuleRecord => entry.type === "rule" && entry.tool === tool && entry.id === rule,
  )
  return record?.message
}

function recordOfRow(
  memo: MemoInput,
  address: { level: CustomizationRecord["level"]; agent: string | null; item: string; section: string | null; team?: CustomizationRecord["team"] },
  customizations: readonly CustomizationRecord[],
): ModelRecord | RuleRecord | CustomizationRecord | null {
  if (address.item.startsWith("model:")) {
    const parsed = parseModelItemId(address.item)
    if (parsed === undefined) return null
    return (
      modelsOfMemo(memo).find(
        (record) =>
          record.level === address.level &&
          record.agent === address.agent &&
          sameTeam(record.team, address.team) &&
          record.providerID === parsed.providerID &&
          record.modelID === parsed.modelID &&
          record.variant === parsed.variant,
      ) ?? null
    )
  }
  if (address.item.startsWith("perm:")) {
    const parsed = parsePermItemId(address.item)
    if (parsed !== undefined) {
      const rule = rulesOfMemo(memo).find((record) => record.tool === parsed.tool && record.id === parsed.ruleId)
      if (rule !== undefined) return rule
    }
  }
  return (
    customizations.find(
      (record) =>
        record.level === address.level &&
        record.agent === address.agent &&
        sameTeam(record.team, address.team) &&
        record.item === address.item &&
        record.section === address.section,
    ) ?? null
  )
}

function createRow(
  api: PlusApi,
  input: {
    kind:
      | "agent"
      | "skill"
      | "base"
      | "instruction"
      | "mcp"
      | "team"
      | "member"
      | "model"
      | "rule"
      | "entry"
      | "preset"
      | "teamPreset"
      | "presetMember"
    id?: string
    scope?: "project" | "global" | "defaults"
    preset?: string | Plus.PresetRef
    from?: string | Plus.PresetRef
    name?: string
    body?: string
    title?: string
    text?: string
    config?: Record<string, unknown>
    team?: string
    level?: "project" | "global" | "defaults" | "preset"
    catalogue?: Plus.Catalogue
    providerID?: string
    modelID?: string
    variant?: string
    agent?: string
    tool?: string
    label?: string
    patterns?: readonly string[]
    keywords?: readonly string[]
    message?: string
  },
  actor: Plus.Actor,
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    if (input.kind === "agent") {
      if (input.id === undefined) return yield* Effect.fail(new Tool.Error({ message: "create agent requires id" }))
      const scope = input.scope ?? "project"
      if (scope !== "project" && scope !== "global")
        return yield* Effect.fail(new Tool.Error({ message: "create agent requires scope project|global" }))
      const snapshot = yield* snapshotOrFail(api)
      const candidate = input.id.trim()
      if (candidate !== "" && snapshot.protectedAgents.includes(candidate))
        return yield* Effect.fail(protectedError(candidate))
      const preset = yield* presetInputOrFail(snapshot, input.preset)
      const created = yield* Effect.promise(() =>
        api.createAgent({ scope, id: input.id as string, ...(preset === undefined ? {} : { preset }), actor }),
      )
      if (!created.ok) return yield* Effect.fail(new Tool.Error({ message: `${created.error.code}: ${created.error.message}` }))
      const row = yield* createdRowOrFail(api, (memo) => createdAgentRow(memo, scope, created.value.id), `agent "${created.value.id}"`)
      return { output: { ...created.value, id: row.id, item: row.item } }
    }
    if (input.kind === "entry") {
      if (input.catalogue === undefined || input.name === undefined)
        return yield* Effect.fail(new Tool.Error({ message: "create entry requires catalogue and name" }))
      const snapshot = yield* snapshotOrFail(api)
      const preset = yield* presetInputOrFail(snapshot, input.preset)
      const created = yield* Effect.promise(() =>
        api.createEntry({
          catalogue: input.catalogue as Plus.Catalogue,
          name: input.name as string,
          ...(input.team === undefined ? {} : { team: input.team }),
          ...(preset === undefined ? {} : { preset }),
          actor,
        }),
      )
      if (!created.ok) return yield* Effect.fail(new Tool.Error({ message: `${created.error.code}: ${created.error.message}` }))
      const value = created.value
      const row = yield* createdRowOrFail(
        api,
        (memo) =>
          createdEntryRow(memo, { catalogue: value.catalogue, ...(value.team === undefined ? {} : { team: value.team }), name: value.name ?? "" }),
        `entry "${value.name ?? ""}"`,
      )
      return { output: { ...value, id: row.id, item: row.item } }
    }
    if (input.kind === "preset" || input.kind === "teamPreset") {
      if (input.id === undefined) return yield* Effect.fail(new Tool.Error({ message: `create ${input.kind} requires id` }))
      const snapshot = yield* snapshotOrFail(api)
      const team = input.kind === "teamPreset"
      const from = input.from === undefined ? undefined : presetRefOf(snapshot, input.from, team)
      if (input.from !== undefined && from === undefined)
        return yield* Effect.fail(new Tool.Error({ message: `preset.invalid: unknown preset ${JSON.stringify(input.from)}` }))
      if (team && from !== undefined && from.kind !== "team")
        return yield* Effect.fail(new Tool.Error({ message: "preset.invalid: a team preset is created from a team preset" }))
      const created = yield* Effect.promise(() =>
        api.createPreset(
          team
            ? { kind: "team", id: input.id as string, ...(from === undefined ? {} : { from: from.id }), actor }
            : { kind: "agent", id: input.id as string, ...(from === undefined ? {} : { from }), actor },
        ),
      )
      if (!created.ok) return yield* Effect.fail(new Tool.Error({ message: `${created.error.code}: ${created.error.message}` }))
      const ref = created.value.ref
      const row = yield* createdRowOrFail(api, (memo) => createdPresetRow(memo, ref), `preset "${ref.id}"`)
      return { output: { ...created.value, id: row.id, item: row.item } }
    }
    if (input.kind === "presetMember") {
      if (input.team === undefined || input.id === undefined)
        return yield* Effect.fail(new Tool.Error({ message: "create presetMember requires team and id" }))
      const snapshot = yield* snapshotOrFail(api)
      const from = yield* presetInputOrFail(snapshot, input.from)
      const created = yield* Effect.promise(() =>
        api.addPresetMember({ team: input.team as string, id: input.id as string, ...(from === undefined ? {} : { from }), actor }),
      )
      if (!created.ok) return yield* Effect.fail(new Tool.Error({ message: `${created.error.code}: ${created.error.message}` }))
      const ref = created.value.ref
      const row = yield* createdRowOrFail(api, (memo) => createdPresetRow(memo, ref), `member preset "${ref.id}"`)
      return { output: { ...created.value, id: row.id, item: row.item } }
    }
    if (input.kind === "skill") {
      if (input.name === undefined || input.body === undefined)
        return yield* Effect.fail(new Tool.Error({ message: "create skill requires name and body" }))
      const created = yield* Effect.promise(() => api.createSkill({ name: input.name as string, body: input.body as string, actor }))
      if (!created.ok) return yield* Effect.fail(new Tool.Error({ message: `${created.error.code}: ${created.error.message}` }))
      const row = yield* createdRowOrFail(
        api,
        (memo) => createdItemRow(memo, { level: "defaults", agent: null, item: `skill:${created.value.id}` }),
        `skill "${created.value.id}"`,
      )
      return { output: { ...created.value, id: row.id, item: row.item } }
    }
    if (input.kind === "base") {
      if (input.id === undefined || input.title === undefined || input.text === undefined)
        return yield* Effect.fail(new Tool.Error({ message: "create base requires id, title, and text" }))
      const created = yield* Effect.promise(() =>
        api.createBase({ id: input.id as string, title: input.title as string, text: input.text as string, actor }),
      )
      if (!created.ok) return yield* Effect.fail(new Tool.Error({ message: `${created.error.code}: ${created.error.message}` }))
      const row = yield* createdRowOrFail(
        api,
        (memo) => createdItemRow(memo, { level: "defaults", agent: null, item: `base:${created.value.id}` }),
        `base "${created.value.id}"`,
      )
      return { output: { ...created.value, id: row.id, item: row.item } }
    }
    if (input.kind === "instruction") {
      // OpenCodePlus: AGENTS.md handling is disabled pending the Context catalogue
      // (see instructions/discover.ts). Native opencode owns AGENTS.md until then.
      return yield* Effect.fail(new Tool.Error({ message: INSTRUCTION_DISABLED }))
      // if (input.name === undefined || input.text === undefined)
      //   return yield* Effect.fail(new Tool.Error({ message: "create instruction requires name and text" }))
      // const created = yield* Effect.promise(() =>
      //   api.createInstruction({ name: input.name as string, text: input.text as string, actor }),
      // )
      // if (!created.ok) return yield* Effect.fail(new Tool.Error({ message: `${created.error.code}: ${created.error.message}` }))
      // return { output: created.value }
    }
    if (input.kind === "mcp") {
      if (input.name === undefined || input.config === undefined)
        return yield* Effect.fail(new Tool.Error({ message: "create mcp requires name and config" }))
      const created = yield* Effect.promise(() => api.addMcp({ name: input.name as string, config: { ...(input.config as Record<string, unknown>) }, actor }))
      if (!created.ok) return yield* Effect.fail(new Tool.Error({ message: `${created.error.code}: ${created.error.message}` }))
      const row = yield* createdRowOrFail(
        api,
        (memo) => createdItemRow(memo, { level: "defaults", agent: null, item: `mcp:${created.value.name}` }),
        `MCP server "${created.value.name}"`,
      )
      return { output: { ...created.value, id: row.id, item: row.item } }
    }
    if (input.kind === "team") {
      if (input.team === undefined || input.level === undefined || input.level === "preset")
        return yield* Effect.fail(new Tool.Error({ message: "create team requires team and level project|global" }))
      if (input.preset !== undefined && typeof input.preset !== "string" && input.preset.kind !== "team")
        return yield* Effect.fail(new Tool.Error({ message: "preset.invalid: a team is created from a team preset" }))
      const preset = input.preset === undefined ? undefined : typeof input.preset === "string" ? input.preset : input.preset.id
      const created = yield* Effect.promise(() =>
        api.createTeam({
          level: input.level as "project" | "global",
          team: input.team as string,
          ...(preset === undefined ? {} : { preset }),
          actor,
        }),
      )
      if (!created.ok) return yield* Effect.fail(new Tool.Error({ message: `${created.error.code}: ${created.error.message}` }))
      const row = yield* createdRowOrFail(api, (memo) => createdTeamRow(memo, created.value.level, created.value.team), `team "${created.value.team}"`)
      return { output: { ...created.value, id: row.id, item: row.item } }
    }
    if (input.kind === "member") {
      const level = input.level
      const team = input.team?.trim()
      // team.addAgent validates and trims the team name itself, so the lookup
      // resolves the same name the write used.
      if (team === undefined || level === undefined || level === "preset" || input.id === undefined)
        return yield* Effect.fail(new Tool.Error({ message: "create member requires team, level project|global|defaults, and id" }))
      const snapshot = yield* snapshotOrFail(api)
      const teammate = input.id.trim()
      // A Defaults member entry is a pattern, not an agent: protection is
      // about agents a tool may not create.
      if (level !== "defaults" && teammate !== "" && snapshot.protectedAgents.includes(teammate))
        return yield* Effect.fail(protectedError(teammate))
      const preset = yield* presetInputOrFail(snapshot, input.preset)
      const created = yield* Effect.promise(() =>
        api.addTeamAgent({ level, team, id: input.id as string, ...(preset === undefined ? {} : { preset }), actor }),
      )
      if (!created.ok) return yield* Effect.fail(new Tool.Error({ message: `${created.error.code}: ${created.error.message}` }))
      const row = yield* createdRowOrFail(
        api,
        (memo) =>
          level === "defaults"
            ? createdEntryRow(memo, { catalogue: "teams", team, name: created.value.id })
            : createdMemberRow(memo, level, team, created.value.id),
        `team member "${created.value.id}"`,
      )
      return { output: { ...created.value, id: row.id, item: row.item } }
    }
    if (input.kind === "model") {
      if (input.providerID === undefined || input.modelID === undefined)
        return yield* Effect.fail(new Tool.Error({ message: "create model requires providerID and modelID" }))
      const level = input.level ?? input.scope ?? "project"
      const rawAgent = input.agent?.trim() ?? ""
      // A preset's Models group: level preset with the preset id as agent.
      if (level !== "defaults" && rawAgent.length === 0)
        return yield* Effect.fail(new Tool.Error({ message: "create model requires agent for project|global|preset levels" }))
      const agent = level === "defaults" && (rawAgent.length === 0 || rawAgent === "_") ? null : rawAgent
      const snapshot = yield* snapshotOrFail(api)
      if (level !== "preset" && agent !== null && snapshot.protectedAgents.includes(agent))
        return yield* Effect.fail(protectedError(agent))
      const memo = memoFromSnapshot(snapshot)
      const team = input.team?.trim()
      const member = team === undefined ? undefined : findRow(memo, `team:${level}:${team}:${agent}`)
      // Match the TUI Models group: presets and Defaults entries own scoped
      // records; an ordinary member writes its agent's records in this team's chain.
      if (team !== undefined && (agent === null || findRow(memo, `group:${level}:${team}/:${agent}:models`) === undefined))
        return yield* Effect.fail(new Tool.Error({ message: `model.invalid: unknown member ${JSON.stringify(agent)} of team ${JSON.stringify(team)} at ${level}` }))
      const owner = team === undefined
        ? {}
        : member?.owner?.preset !== undefined || member?.owner?.entry !== undefined
          ? { team: { level, team } }
          : { memberOf: { level, team } }
      if (team === undefined && findRow(memo, `group:${level}:${agent ?? (input.catalogue === "teams" ? "/teams" : "")}:models`) === undefined)
        return yield* Effect.fail(new Tool.Error({ message: `model.invalid: unknown model owner ${JSON.stringify(agent)} at ${level}` }))
      const created = yield* Effect.promise(() =>
        api.addModel({
          level,
          agent,
          ...(owner.team === undefined ? {} : { team: owner.team }),
          ...(input.catalogue === undefined ? {} : { catalogue: input.catalogue }),
          providerID: input.providerID as string,
          modelID: input.modelID as string,
          ...(input.variant === undefined ? {} : { variant: input.variant }),
          actor,
        }),
      )
      if (!created.ok) return yield* Effect.fail(new Tool.Error({ message: `${created.error.code}: ${created.error.message}` }))
      // The row is resolved at the written level and owner, so a project or
      // global candidate is never reported as the Defaults row that happens
      // to carry the same model.
      const row = yield* createdRowOrFail(
        api,
        (memo) =>
          createdItemRow(memo, {
            level: created.value.level,
            agent: created.value.agent,
            ...owner,
            item: modelItemId(created.value),
            ...(team === undefined
              ? catalogueField({ agent: created.value.agent, ...(input.catalogue === undefined ? {} : { catalogue: input.catalogue }) })
              : { catalogue: "teams" }),
          }),
        `model "${created.value.providerID}/${created.value.modelID}"`,
      )
      return { output: { ...created.value, id: row.id, item: row.item } }
    }
    if (input.kind === "rule") {
      if (input.tool === undefined || input.id === undefined || input.label === undefined || input.patterns === undefined)
        return yield* Effect.fail(new Tool.Error({ message: "create rule requires tool, id, label, and patterns" }))
      const level = input.level ?? input.scope ?? "project"
      const rawAgent = input.agent?.trim() ?? ""
      const agent = rawAgent.length === 0 || rawAgent === "_" ? null : rawAgent
      const snapshot = yield* snapshotOrFail(api)
      if (level !== "preset" && agent !== null && snapshot.protectedAgents.includes(agent))
        return yield* Effect.fail(protectedError(agent))
      const created = yield* Effect.promise(() =>
        api.addRule({
          level,
          agent,
          ...(input.catalogue === undefined ? {} : { catalogue: input.catalogue }),
          tool: input.tool as string,
          id: input.id as string,
          label: input.label as string,
          patterns: [...(input.patterns as string[])],
          ...(input.keywords === undefined ? {} : { keywords: [...input.keywords] }),
          ...(input.message === undefined ? {} : { message: input.message }),
          actor,
        }),
      )
      if (!created.ok) return yield* Effect.fail(new Tool.Error({ message: `${created.error.code}: ${created.error.message}` }))
      // The row is resolved at the written level and owner, so a project or
      // global rule is never reported as an inherited Defaults row. A shared
      // rule keeps its requested storage level but its only visible row is the
      // shared Defaults catalogue row, so that row is the returned id.
      const row = yield* createdRowOrFail(
        api,
        (memo) =>
          createdItemRow(memo, {
            level: created.value.agent === null ? "defaults" : created.value.level,
            agent: created.value.agent,
            item: permItemId(created.value.tool, created.value.id),
            ...catalogueField({ agent: created.value.agent, ...(input.catalogue === undefined ? {} : { catalogue: input.catalogue }) }),
          }),
        `rule "${created.value.tool}:${created.value.id}"`,
      )
      return { output: { ...created.value, id: row.id, item: row.item } }
    }
    return yield* Effect.fail(new Tool.Error({ message: `create unknown kind ${input.kind}` }))
  })
}

function presetInputOrFail(
  snapshot: Plus.Snapshot,
  input: string | Plus.PresetRef | undefined,
): Effect.Effect<Plus.PresetRef | undefined, Tool.Error> {
  if (input === undefined) return Effect.succeed(undefined)
  const ref = presetRefOf(snapshot, input)
  if (ref === undefined) return Effect.fail(new Tool.Error({ message: `preset.invalid: unknown preset ${JSON.stringify(input)}` }))
  return Effect.succeed(ref)
}

// Resolve the row a create just wrote through the same tree show, set and
// delete read. There is no fallback id: a create that cannot find its row
// fails with create.failed instead of returning a string those tools refuse.
// File-derived rows (skills, MCP servers) reach the tree only after the host's
// own watcher rescans and reloads its registry, so the lookup gives that
// publish a short window before it gives up; it is still the row that decides
// the returned id, never a formatted string.
const ROW_WAIT_ATTEMPTS = 12

function createdRowOrFail(
  api: PlusApi,
  resolve: (memo: MemoInput) => CreatedRow | undefined,
  label: string,
): Effect.Effect<CreatedRow, Tool.Error> {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < ROW_WAIT_ATTEMPTS; attempt++) {
      const snapshot = yield* snapshotOrFail(api)
      const row = resolve(memoFromSnapshot(snapshot))
      if (row !== undefined) return row
      if (attempt < ROW_WAIT_ATTEMPTS - 1) yield* Effect.sleep("100 millis")
    }
    return yield* Effect.fail(
      new Tool.Error({
        message: `create.failed: created ${label} but its row is missing from the instructions tree; re-read with instructions_list`,
      }),
    )
  })
}

type ExecutableRemovalPlan = Exclude<RemovalPlan, OpFailure>

function deletePlan(
  api: PlusApi,
  plan: ExecutableRemovalPlan,
  actor: Plus.Actor,
  force = false,
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    if (plan.kind === "agent.delete") {
      const result = yield* Effect.promise(() => api.deleteAgent({ scope: plan.scope, id: plan.id, actor }))
      if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
      return { output: { ...result.value, status: plan.successStatus } }
    }
    if (plan.kind === "mcp.remove") {
      const result = yield* Effect.promise(() => api.removeMcp({ name: plan.name, actor }))
      if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
      return { output: { ...result.value, status: plan.successStatus } }
    }
    if (plan.kind === "skill.delete") {
      const result = yield* Effect.promise(() => api.deleteSkill({ id: plan.id, actor }))
      if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
      return { output: { ...result.value, status: plan.successStatus } }
    }
    if (plan.kind === "base.delete") {
      const result = yield* Effect.promise(() => api.deleteBase({ id: plan.id, actor }))
      if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
      return { output: { ...result.value, status: plan.successStatus } }
    }
    if (plan.kind === "instruction.delete") {
      const result = yield* Effect.promise(() => api.deleteInstruction({ name: plan.name, actor }))
      if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
      return { output: { ...result.value, status: plan.successStatus } }
    }
    if (plan.kind === "team.delete") {
      const result = yield* Effect.promise(() => api.deleteTeam({ level: plan.level, team: plan.team, actor }))
      if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
      return { output: { ...result.value, status: plan.successStatus } }
    }
    if (plan.kind === "preset.delete") {
      // `force` deletes over links other projects hold (they then read as a missing preset).
      const result = yield* Effect.promise(() => api.deletePreset({ ref: plan.ref, actor, ...(force ? { confirm: true } : {}) }))
      // In use: the refusal names every row still linked to the preset.
      if (!result.ok && result.error.code === "preset.inUse")
        return yield* Effect.fail(
          new Tool.Error({ message: `preset.inUse: ${result.error.message} (used by ${result.error.data.users.join(", ")})` }),
        )
      if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
      return { output: { ...result.value, status: plan.successStatus } }
    }
    if (plan.kind === "entry.delete") {
      const result = yield* Effect.promise(() =>
        api.deleteEntry({
          catalogue: plan.catalogue,
          ...(plan.team === undefined ? {} : { team: plan.team }),
          ...(plan.name === undefined ? {} : { name: plan.name }),
          actor,
        }),
      )
      if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
      return { output: { ...result.value, status: plan.successStatus } }
    }
    const result = yield* Effect.promise(() =>
      api.removeTeamAgent({ level: plan.level, team: plan.team, id: plan.id, actor }),
    )
    if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
    return { output: { ...result.value, status: plan.successStatus } }
  })
}
