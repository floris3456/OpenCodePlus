import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { runRegistration } from "./instructions/apply.js"
import { changedLines, unifiedDiff } from "./instructions/diff-lines.js"
import { defaultInclude, mergeUnits, renderMerge, withoutFinalNewline, type MergeEntry } from "./instructions/merge-units.js"
import {
  activateModelRow,
  addSection,
  createdAgentRow,
  createdEntryRow,
  createdItemRow,
  createdMemberRow,
  createdPresetRow,
  createdTeamRow,
  editModelRow,
  editRefusalForLabel,
  findRow,
  isModelRowId,
  isPermRowId,
  parseModelText,
  planFolderCreate,
  planFolderDelete,
  planFolderRename,
  planRowMove,
  planSectionMove,
  removalPlan,
  rowToken,
  type LayoutChange,
  type LayoutRecords,
  removeModelRow,
  reset,
  resetModelFieldRow,
  resetModelRow,
  resolveRefusalForLabel,
  resolveReview,
  saveSplit,
  saveText,
  setEnabled,
  setAgentMode,
  setModelFieldRow,
  setModelWarmingRow,
  setPin,
  setRequires,
  teamPlan,
  teamRowEntity,
  toggle,
  toggleGroup,
  unknownRowRefusal,
  type CreatedRow,
  type ModelEditFields,
  type OpFailure,
  type RemovalPlan,
} from "./instructions/ops.js"
import { query } from "./instructions/query.js"
import {
  applies,
  catalogueField,
  catalogueMatches,
  modelItemId,
  parseMemberOwnerPath,
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
import type { Address, CustomizationRecord, Item, ModelRecord, RuleRecord, SplitRecord, ThreeWay } from "./instructions/model.js"
import { buildTreeMemo } from "./instructions/tree.js"
import type { Memo, MemoInput, TreeNode } from "./instructions/tree.js"
import { contextOfSnapshot, memoInputOf, presetOf } from "./instructions/snapshot.js"
import { deltaOf, snapshotRecordOf } from "./instructions/delta.js"
import type { StoredRecord } from "./instructions/store.js"
import {
  everySettings,
  hostModelOf,
  isModelDefaultRowId,
  isModelFieldRowId,
  isModelSettingRowId,
  modelDefaultValue,
  modelDefaultView,
  modelSettingEffective,
  MODEL_DEFAULT_FIELDS,
  MODEL_SETTINGS_FIELDS,
  parseModelDefaultItemId,
  parseModelFieldItemId,
  parseModelSettingItemId,
  settingsFor,
  type ModelDefaultField,
  type ModelSettingsField,
  type ModelSettingsKey,
} from "./instructions/model-settings.js"
import { presetListing } from "./instructions/presets.js"
import { folderIdOfRef } from "./instructions/folders.js"
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
  "Diff returns two unified diffs (original→mine, original→upstream), a one-line summary, and merge: the merge units (id, kind, yours, upstream, base, included) with the default merged text.\n" +
  "A Defaults › Models row resolves to a summary with each effective keep-alive value and the layer it came from."

const SetDescription =
  "Save an override, toggle, pin, set when shown, activate a model, resolve review or relink (TUI Enter/Space/p/w/k/t/e/l).\n" +
  "On a group row id, state on|off turns every row under it on or off in one write (a bare id toggles the group: all on means all off, otherwise all on); protected rows are skipped and named, team groups refuse.\n" +
  "Enabling a team is exclusive across loaded project/global/defaults records; disabledTeams reports the other teams disabled by this save.\n" +
  "With text save an override, with state on|off toggle explicitly, with pin true|false pin a Code Mode tool, with active true activate a model row, with resolve keep|take|edit resolve review, with resolve merge and include:[unit ids from show's merge.units] save that merge (no include = the defaults; a merge equal to upstream is a take).\n" +
  "Agent/member rows accept state on|off and mode primary|subagent|all. setting:* and compaction:* rows use text (enabled/hidden use state); empty optional fields clear them. Compaction model is provider/model#variant; empty inherits the maintenance compaction model, otherwise the active session model.\n" +
  "With preset on an agent, member, team, Defaults entry or user preset row, link it to that preset (null unlinks): \"<id>\" names an agent preset, \"<team>/<member>\" a member preset (team rows take a team preset id).\n" +
  "On a perm row with label+patterns (keywords optional) update the rule; message sets the refusal text the model reads. Bare id toggles (model rows activate). Writes pass actor tool and retry once when stale.\n" +
  "On a model row text replaces the candidate (provider/model or provider/model#variant; the TUI's enter edit) and warming sets cache warming for that agent on that model at that level: off, on, or a total time 1m-24h such as 45m, 2h, 1h30m; empty warming inherits.\n" +
  "On a Defaults › Models row (item:defaults:/models:modeldefault:* and …:<provider>/<model>) warming, interval (30s-24h such as 4m or 3m30s), prompt (the keep-alive text) and effort (the default variant) set that row's fields; an empty field clears it so the level below decides, and state on|off sets the warming switch.\n" +
  "On a folder row rename renames the folder; move places rows and folders (see move).\n" +
  "rename renames an agent, an on-disk team member or a Project/Global team: its file or team directory, every stored record (links, models, rules, splits, customizations, warming rows) and the tree selection follow in one revision; session history keeps the old name. Built-ins, shipped Defaults rows, ancestor-backed agents and Protected agents (tool actor) refuse."

const MoveDescription =
  "Move a row, folder or section (by row id) into a folder or a tab's top level, or before/after a sibling in its list.\n" +
  "Rows and folders move only inside their own tab; a folder cannot move into itself or its own folders; built-in structure cannot move.\n" +
  "A section moves before or after a sibling under the same parent inside its own item; the item's text is rewritten so the request order changes (a heading-derived move folds the consumed same-level child texts into the parent).\n" +
  "Row and folder moves are display only: nothing there changes what the model sees."

const ResetDescription =
  "Drop the override at this level only (TUI `r`).\n" +
  "Agent/member rows reset their settings and compaction controls at this level.\n" +
  "Removes the stored text/state at the addressed row (model rows clear only that level's active flag; a Defaults › Models row clears its keep-alive fields and goes away). Writes pass actor tool and retry once when stale."

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
  "folder (name, id = the tab row or folder row to create it in; a folder groups rows inside one tab, display only),\n" +
  "rule (tool+id+label+patterns, keywords/level/agent optional; patterns are core wildcards, not regex; message is the optional refusal text the model reads; a rule with no agent keeps its requested level and resolves through its shared Defaults row).\n" +
  "Every kind returns {id, item}: id is the row id show/set/delete accept, item the created item's own id.\n" +
  "catalogue agents|teams (default agents) picks which catalogue a shared Defaults model or rule lands in;\n" +
  "base/instruction/mcp create one file both catalogues list, so catalogue does not change what is written."

const DeleteDescription =
  "Delete a user-owned row (agent, team, member, file, Defaults entry, user preset); refuses without `confirm`.\n" +
  "Pass confirm:true to delete. Resolves the row through the TUI removal plan. A model row deletes its local candidate or hides an inherited/upstream one at this level; the row that is the effective model refuses (activate another model first). A Defaults › Models row with values clears them (it disappears); one with none refuses. A preset any live row links to is refused (preset.inUse lists who); links whose owner is gone are removed with the preset. Links only other projects hold are overridden with force:true (they then show as a missing preset)."

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
  requires: Schema.optionalKey(Schema.NullOr(Schema.Array(Schema.String))).annotate({
    description:
      "System rows (not Role/persona as a whole) and their sections: send it only while these rows are on for the agent, " +
      "e.g. [\"tool:question\"]; \"!perm:shell:git-push\" = while that row is off. [] = always; null = drop this level's " +
      "condition (the level above, or the section's own <!-- requires --> line, decides). Shown as \"shown when\".",
  }),
  active: Schema.optionalKey(Schema.Boolean),
  resolve: Schema.optionalKey(
    Schema.Union([Schema.Literal("keep"), Schema.Literal("take"), Schema.Literal("edit"), Schema.Literal("merge")]),
  ),
  include: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "With resolve merge: the unit ids (show's merge.units) to include; omitted = the defaults.",
  }),
  label: Schema.optionalKey(Schema.String),
  patterns: Schema.optionalKey(Schema.Array(Schema.String)),
  keywords: Schema.optionalKey(Schema.Array(Schema.String)),
  message: Schema.optionalKey(Schema.String),
  preset: Schema.optionalKey(Schema.NullOr(PresetInput)),
  warming: Schema.optionalKey(Schema.String),
  interval: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  rename: Schema.optionalKey(Schema.String).annotate({
    description:
      "Rename this agent, on-disk team member or Project/Global team row to this new name/id, or a folder row to a new name. " +
      "Everything that names it follows in one store revision; built-ins, shipped Defaults rows, " +
      "ancestor-backed agents and Protected agents (tool actor) refuse.",
  }),
})

const MoveInput = Schema.Struct({
  id: Schema.String,
  into: Schema.optionalKey(Schema.String),
  before: Schema.optionalKey(Schema.String),
  after: Schema.optionalKey(Schema.String),
})

const ResetInput = Schema.Struct({
  id: Schema.String,
})

const SplitInput = Schema.Struct({
  id: Schema.String,
  boundaries: Schema.optionalKey(
    Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String, start: Schema.Number, depth: Schema.optionalKey(Schema.Number) })),
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
    Schema.Literal("folder"),
  ]),
  id: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(
    Schema.Union([Schema.Literal("project"), Schema.Literal("global"), Schema.Literal("defaults"), Schema.Literal("preset")]),
  ),
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
          const treeMemo = buildTreeMemo(memo)
          const node = findRow(memo, input.id, treeMemo)
          if (node === undefined) return yield* Effect.fail(unknownError(input.id, memo))
          const protectedAgent = protectedOf(snapshot, node)
          if (protectedAgent !== undefined) return yield* Effect.fail(protectedError(protectedAgent))
          const folderId = folderIdOfRef(rowToken(node) ?? "")
          if (folderId !== undefined) {
            if (input.rename === undefined) return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" is a folder: set it with rename` }))
            const applied = yield* applyLayout(api, snapshot, planFolderRename(layoutOf(snapshot), folderId, input.rename, new Date().toISOString()), actor)
            return { output: { id: input.id, ...applied } }
          }
          if (input.rename !== undefined) return yield* renameRow(api, snapshot, node, input.rename, actor)
          if (isModelFieldRowId(input.id)) return yield* setModelField(api, snapshot, memo, input.id, actor, input)
          if (isModelSettingRowId(input.id)) {
            const field = settingOf(node)?.field
            if (field === undefined) return yield* Effect.fail(unknownError(input.id))
            if (input.text === undefined)
              return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" takes text: its value, or "" to inherit` }))
            return yield* setModelDefaults(api, node, actor, { [field]: input.text })
          }
          if (isModelDefaultRowId(input.id)) return yield* setModelDefaults(api, node, actor, input)
          if (input.effort !== undefined)
            return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" has no effort; effort is set on a Defaults › Models row` }))
          if (input.preset !== undefined) return yield* setLink(api, snapshot, node, input.preset, actor)
          if (node.kind === "team" && node.depth === 2) return yield* setTeam(api, memo, input.id, actor, input)
          if (isModelRowId(input.id) || node.address?.item.startsWith("model:")) return yield* setModel(api, snapshot, memo, input.id, actor, input)
          if (input.warming !== undefined)
            return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" is not a model row; warming is set on model rows` }))
          if (isPermRowId(input.id) || node.address?.item.startsWith("perm:")) return yield* setPerm(api, snapshot, memo, input.id, actor, input, treeMemo)
          if (node.kind === "group") return yield* setGroup(api, snapshot, memo, input.id, actor, input)
          if (input.include !== undefined && input.resolve !== "merge")
            return yield* Effect.fail(new Tool.Error({ message: `"${node.label}": include applies only with resolve merge` }))
          const op = input.resolve === "merge" ? mergeOp(memo, treeMemo, node, input) : computeSet(memo, input, treeMemo)
          if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
          const applied = yield* mutateOp(api, memo, op, actor)
          return { output: { id: input.id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
        }),
    })
    editor.add({
      name: "move",
      description: MoveDescription,
      input: MoveInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: (input, context) =>
        Effect.gen(function* () {
          const actor = actorFrom(context)
          const snapshot = yield* snapshotOrFail(api)
          const memo = memoFromSnapshot(snapshot)
          const node = findRow(memo, input.id)
          if (node === undefined) return yield* Effect.fail(unknownError(input.id, memo))
          const protectedAgent = protectedOf(snapshot, node)
          if (protectedAgent !== undefined) return yield* Effect.fail(protectedError(protectedAgent))
          if (node.kind === "section") {
            const op = planSectionMove(memo, input.id, input, new Date().toISOString())
            if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
            const applied = yield* mutateOp(api, memo, op, actor)
            return { output: { id: input.id, target: input.id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
          }
          const change = planRowMove(memo, layoutOf(snapshot), input.id, input, new Date().toISOString())
          const applied = yield* applyLayout(api, snapshot, change, actor)
          return { output: { id: input.id, ...applied } }
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
          const treeMemo = buildTreeMemo(memo)
          const node = findRow(memo, input.id, treeMemo)
          if (node === undefined) return yield* Effect.fail(unknownError(input.id, memo))
          const protectedAgent = protectedOf(snapshot, node)
          if (protectedAgent !== undefined) return yield* Effect.fail(protectedError(protectedAgent))
          if (isModelFieldRowId(input.id)) return yield* resetModelField(api, snapshot, memo, input.id, actor)
          if (isModelSettingRowId(input.id)) {
            const field = settingOf(node)?.field
            if (field === undefined) return yield* Effect.fail(unknownError(input.id))
            return yield* clearModelDefaults(api, node, actor, "reset", [field])
          }
          if (isModelDefaultRowId(input.id)) return yield* clearModelDefaults(api, node, actor, "reset")
          if (isModelRowId(input.id) || node.address?.item.startsWith("model:")) return yield* resetModel(api, snapshot, memo, input.id, actor)
          const op = reset(memo, input.id, treeMemo)
          if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
          const applied = yield* mutateOp(api, memo, op, actor)
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
          const treeMemo = buildTreeMemo(memo)
          const node = findRow(memo, input.id, treeMemo)
          if (node === undefined) return yield* Effect.fail(unknownError(input.id, memo))
          const protectedAgent = protectedOf(snapshot, node)
          if (protectedAgent !== undefined) return yield* Effect.fail(protectedError(protectedAgent))
          const op = computeSplit(memo, input, treeMemo)
          if (typeof op === "string") return yield* Effect.fail(new Tool.Error({ message: op }))
          if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
          const applied = yield* mutateOp(api, memo, op, actor)
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
          const folderId = folderIdOfInput(memo, input.id)
          if (folderId !== undefined) {
            const applied = yield* applyLayout(api, snapshot, planFolderDelete(layoutOf(snapshot), folderId, new Date().toISOString()), actor)
            return { output: { id: input.id, ...applied } }
          }
          const node = findRow(memo, input.id)
          if (node === undefined) return yield* Effect.fail(unknownError(input.id, memo))
          const protectedAgent = protectedOf(snapshot, node)
          if (protectedAgent !== undefined) return yield* Effect.fail(protectedError(protectedAgent))
          if (isModelSettingRowId(input.id) || isModelFieldRowId(input.id))
            return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" is a field of its model row: reset clears it` }))
          if (isModelDefaultRowId(input.id)) {
            if (node.actions?.remove !== true)
              return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" has no Defaults › Models values to clear` }))
            return yield* clearModelDefaults(api, node, actor, "remove")
          }
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
          return { output: result.value }
        }),
    })
  })
}

function snapshotOrFail(api: PlusApi): Effect.Effect<Plus.Snapshot, Tool.Error> {
  return Effect.gen(function* () {
    const result = yield* Effect.promise(() => api.snapshot())
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

function unknownError(id: string, memo?: MemoInput): Tool.Error {
  return new Tool.Error({ message: `row.unknown: ${unknownRowRefusal(id)}${memo === undefined ? "" : memberRowNote(memo, id)}` })
}

// A flat owner model id names no row when that agent exists only as a team
// member: the member's rows live under its `<team>/:<member>` owner path, so
// the flat id resolves to nothing. Two flat forms are recognized:
//
//   - the row grammar `item:<level>:<owner>:model:<provider>/<model>[@variant]`;
//   - the legacy log target `model:<level>:<owner>:<provider>/<model>[@variant]`
//     that `model.add`/`mutate` wrote before the member owner path existed
//     (docs/plans/plus-1.1.12-instructions.md T3 evidence).
//
// Either form only earns a hint when the exact candidate row already exists
// under a real member: the note never invents a candidate, an owner, or a team,
// and when several teams hold the same member it lists every matching row
// instead of choosing one. A genuinely unknown row keeps the plain refusal.
function memberRowNote(memo: MemoInput, id: string): string {
  const flat = flatModelOwner(id)
  if (flat === undefined) return ""
  const rows = memberModelRows(memo, flat)
  if (rows.length === 0) return ""
  if (rows.length === 1) return `; "${flat.owner}" is a member of team "${rows[0]!.team}": use "${rows[0]!.rowId}"`
  return (
    `; "${flat.owner}" is a member of teams ${rows.map((row) => `"${row.team}"`).join(", ")}: ` +
    `use ${rows.map((row) => `"${row.rowId}"`).join(" or ")}`
  )
}

// The (level, owner, item) a flat model id names, or undefined when the id is
// not a flat model address (a member-scoped owner path, another row kind, or a
// malformed id).
function flatModelOwner(
  id: string,
): { level: "project" | "global" | "defaults"; owner: string; item: string } | undefined {
  const parts = id.split(":")
  const level = parts[1]
  const owner = parts[2]
  if (!isOwnerLevel(level) || owner === undefined || owner.length === 0) return undefined
  // A member-scoped owner (`<team>/:<member>`) or a colon owner is not flat.
  if (owner.endsWith("/") || owner.includes(":")) return undefined
  if (parts[0] === "item") {
    if (parts.length < 4) return undefined
    const item = parts.slice(3).join(":")
    return item.startsWith("model:") ? { level, owner, item } : undefined
  }
  if (parts[0] === "model") {
    if (parts.length < 4) return undefined
    return { level, owner, item: `model:${parts.slice(3).join(":")}` }
  }
  return undefined
}

// Every `<team>/:<member>` model row that holds the flat owner's exact
// candidate at that level, in team order. Empty when no member row exists.
function memberModelRows(
  memo: MemoInput,
  flat: { level: "project" | "global" | "defaults"; owner: string; item: string },
): { team: string; rowId: string }[] {
  return (memo.teams ?? []).flatMap((team) => {
    if (team.level !== flat.level || !team.agents.includes(flat.owner)) return []
    const rowId = `item:${flat.level}:${team.team}/:${flat.owner}:${flat.item}`
    return findRow(memo, rowId) === undefined ? [] : [{ team: team.team, rowId }]
  })
}

function isOwnerLevel(value: string | undefined): value is "project" | "global" | "defaults" {
  return value === "project" || value === "global" || value === "defaults"
}

// The folder a delete id names: `folder:<id>` or a folder row's id.
function folderIdOfInput(memo: MemoInput, id: string): string | undefined {
  if (id.startsWith("folder:")) return id.slice("folder:".length)
  const node = findRow(memo, id)
  const token = node === undefined ? undefined : rowToken(node)
  return token === undefined ? undefined : folderIdOfRef(token)
}

function layoutOf(snapshot: Plus.Snapshot): LayoutRecords {
  return { folders: snapshot.folders ?? [], orders: snapshot.orders ?? [] }
}

// One layout write for a planned change: the whole folder and order set, logged once.
function applyLayout(api: PlusApi, snapshot: Plus.Snapshot, change: LayoutChange, actor: Plus.Actor) {
  return Effect.gen(function* () {
    if ("refusal" in change) return yield* Effect.fail(new Tool.Error({ message: change.refusal }))
    const written = yield* Effect.promise(() =>
      api.layoutWrite({
        folders: [...change.layout.folders],
        orders: [...change.layout.orders],
        expectedGlobalRevision: snapshot.globalRevision,
        target: change.target,
        status: change.status,
        actor,
      }),
    )
    if (!written.ok) return yield* Effect.fail(new Tool.Error({ message: `${written.error.code}: ${written.error.message}` }))
    return {
      target: change.target,
      status: change.status,
      changed: written.value.changed,
      revision: written.value.revision,
      globalRevision: written.value.globalRevision,
    }
  })
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

// `set {id, rename}`: rename an agent, on-disk team member or Project/Global
// team. The API owns the refusals (built-ins, shipped Defaults rows,
// ancestor-backed agents, protected agents for a tool actor); this wrapper
// only routes the row to the right method.
function renameRow(
  api: PlusApi,
  snapshot: Plus.Snapshot,
  node: TreeNode,
  to: string,
  actor: Plus.Actor,
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const name = to.trim()
    if (name.length === 0) return yield* Effect.fail(new Tool.Error({ message: `rename.invalid: a new name is required` }))
    const owner = node.owner
    if (node.kind === "agent" && owner !== undefined && owner.preset === undefined && owner.entry === undefined && owner.agent !== null && (owner.level === "project" || owner.level === "global")) {
      const result = yield* Effect.promise(() => api.renameAgent({ scope: owner.level as "project" | "global", from: owner.agent as string, to: name, actor }))
      if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
      return { output: { id: `agent:${owner.level}:${result.value.to}`, to: result.value.to, path: result.value.path, status: `Renamed ${node.label} to ${result.value.to}` } }
    }
    if (node.kind === "team" && owner !== undefined && owner.preset === undefined && owner.entry === undefined && owner.team !== undefined && (owner.level === "project" || owner.level === "global")) {
      if (owner.agent === null) {
        const result = yield* Effect.promise(() => api.renameTeam({ level: owner.level as "project" | "global", from: node.label, to: name, actor }))
        if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
        return { output: { id: `team:${owner.level}:${result.value.to}`, to: result.value.to, path: result.value.path, status: `Renamed team ${node.label} to ${result.value.to}` } }
      }
      const team = snapshot.teams?.find((entry) => entry.level === owner.level && entry.team === owner.team?.team)
      if (team?.agents.includes(owner.agent as string)) {
        const result = yield* Effect.promise(() => api.renameAgent({ scope: owner.level as "project" | "global", team: owner.team?.team ?? "", from: owner.agent as string, to: name, actor }))
        if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
        return { output: { id: `team:${owner.level}:${owner.team?.team}:${result.value.to}`, to: result.value.to, path: result.value.path, status: `Renamed member ${node.label} to ${result.value.to}` } }
      }
    }
    const defaults = owner?.level === "defaults" || node.id.startsWith("team:defaults:")
    const reason = defaults ? "shipped and cannot be renamed" : owner?.preset !== undefined ? "a preset row and cannot be renamed" : "not a renamable row"
    return yield* Effect.fail(new Tool.Error({ message: `rename.invalid: "${node.label}" is ${reason}` }))
  })
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
  input: {
    id: string
    mode?: "primary" | "subagent" | "all"
    text?: string
    state?: "on" | "off"
    pin?: boolean
    requires?: readonly string[] | null
    resolve?: "keep" | "take" | "edit" | "merge"
  },
  // The resolution memo built once for this tool call. Only the first op reads
  // it: a follow-up op runs against the interim records the first produced, so
  // it resolves through its own memo.
  sharedMemo?: Memo,
): ReturnType<typeof setRequires> {
  const preserved = modelsOfMemo(memo)
  const preservedRules = rulesOfMemo(memo)
  const withModels = (records: readonly CustomizationRecord[], splits: readonly SplitRecord[]): MemoInput => ({
    ...memo,
    records: [...records, ...splits, ...preserved, ...preservedRules],
  })
  // The condition is its own field: set it, then whatever else came with it.
  if (input.requires !== undefined) {
    const first = setRequires(memo, input.id, input.requires, sharedMemo)
    const rest = { ...input, requires: undefined }
    const more = rest.mode !== undefined || rest.text !== undefined || rest.state !== undefined || rest.pin !== undefined || rest.resolve !== undefined
    if ("refusal" in first || !more) return first
    return computeSet(withModels(first.records, first.splits), rest)
  }
  if (input.mode !== undefined) {
    const first = setAgentMode(memo, input.id, input.mode, sharedMemo)
    if ("refusal" in first || (input.state === undefined && input.text === undefined && input.pin === undefined && input.resolve === undefined)) return first
    return computeSet(withModels(first.records, first.splits), { ...input, mode: undefined })
  }
  if (input.resolve !== undefined) {
    if (input.pin === undefined && input.state === undefined) return resolveReview(memo, input.id, input.resolve, input.text, undefined, sharedMemo)
    const first = resolveReview(memo, input.id, input.resolve, input.text, undefined, sharedMemo)
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
    const first = saveText(memo, input.id, input.text, sharedMemo)
    if ("refusal" in first) return first
    const interim: MemoInput = withModels(first.records, first.splits)
    const second = setEnabled(interim, input.id, input.state === "on")
    if ("refusal" in second) return second
    const interim2: MemoInput = withModels(second.records, second.splits)
    return setPin(interim2, input.id, input.pin)
  }
  if (input.text !== undefined && input.state !== undefined) {
    const first = saveText(memo, input.id, input.text, sharedMemo)
    if ("refusal" in first) return first
    const interim: MemoInput = withModels(first.records, first.splits)
    return setEnabled(interim, input.id, input.state === "on")
  }
  if (input.text !== undefined && input.pin !== undefined) {
    const first = saveText(memo, input.id, input.text, sharedMemo)
    if ("refusal" in first) return first
    const interim: MemoInput = withModels(first.records, first.splits)
    return setPin(interim, input.id, input.pin)
  }
  if (input.state !== undefined && input.pin !== undefined) {
    const first = setEnabled(memo, input.id, input.state === "on", sharedMemo)
    if ("refusal" in first) return first
    const interim: MemoInput = withModels(first.records, first.splits)
    return setPin(interim, input.id, input.pin)
  }
  if (input.text !== undefined) return saveText(memo, input.id, input.text, sharedMemo)
  if (input.state !== undefined) return setEnabled(memo, input.id, input.state === "on", sharedMemo)
  if (input.pin !== undefined) return setPin(memo, input.id, input.pin, sharedMemo)
  return toggle(memo, input.id, sharedMemo)
}

function computeSplit(
  memo: MemoInput,
  input: { id: string; boundaries?: readonly { id: string; name: string; start: number }[]; add?: { name: string; text: string } },
  sharedMemo?: Memo,
): { records: CustomizationRecord[]; splits: SplitRecord[]; status: string; retryHint: string } | { refusal: string } | string {
  if (input.add !== undefined) return addSection(memo, input.id, input.add.name, input.add.text, sharedMemo)
  if (input.boundaries !== undefined) return saveSplit(memo, input.id, [...input.boundaries], sharedMemo)
  return "split requires boundaries or add"
}

// Every instruction write goes through a delta: the rows this op actually
// changed, applied to whatever the server currently holds. There is no
// expected revision, so a write never gets a stale refusal for an unrelated
// row and the whole record set never crosses the wire. `before` is the memo
// the op was computed against (built once per tool call); `next` is the full
// desired inventory the op produced. Unchanged rows stay byte-identical.
function mutateDelta(
  api: PlusApi,
  before: MemoInput,
  next: readonly StoredRecord[],
  actor: Plus.Actor,
  status: string,
): Effect.Effect<{ revision: number; globalRevision: number; status: string }, Tool.Error> {
  return Effect.gen(function* () {
    const delta = deltaOf(before.records, next)
    const upsert = delta.upsert.flatMap((record) => {
      const snapshot = snapshotRecordOf(record)
      return snapshot === undefined ? [] : [snapshot]
    })
    const result = yield* Effect.promise(() =>
      api.mutate({ changes: { upsert, remove: delta.remove }, actor }),
    )
    if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
    if (!result.value.ok) return yield* Effect.fail(new Tool.Error({ message: "stale: delta write was refused" }))
    return { revision: result.value.revision, globalRevision: result.value.globalRevision, status }
  })
}

// A customization/split op: models and rules are carried from the memo the op
// was computed against unless the op produced its own model list.
function mutateOp(
  api: PlusApi,
  memo: MemoInput,
  op: { records: CustomizationRecord[]; splits: SplitRecord[]; models?: readonly ModelRecord[]; status: string },
  actor: Plus.Actor,
): Effect.Effect<{ revision: number; globalRevision: number; status: string }, Tool.Error> {
  const models = op.models ?? modelsOfMemo(memo)
  return mutateDelta(api, memo, [...op.records, ...op.splits, ...models, ...rulesOfMemo(memo)], actor, op.status)
}

// A model op: customizations, splits and rules pass through unchanged; the
// op's `models` is the complete new model list, so it replaces the memo's.
function mutateModels(
  api: PlusApi,
  memo: MemoInput,
  models: readonly ModelRecord[],
  status: string,
  actor: Plus.Actor,
): Effect.Effect<{ revision: number; globalRevision: number; status: string }, Tool.Error> {
  const rest = memo.records.filter((record) => record.type !== "model")
  return mutateDelta(api, memo, [...rest, ...models], actor, status)
}

// The candidate a model row addresses: `model:<provider>/<model>[@variant]`.
function modelTargetOfAddress(node: TreeNode | undefined): { providerID: string; modelID: string; variant?: string } | undefined {
  const item = node?.address?.item
  if (item === undefined || !item.startsWith("model:")) return undefined
  return parseModelItemId(item)
}

function setModel(
  api: PlusApi,
  snapshot: Plus.Snapshot,
  memo: MemoInput,
  id: string,
  actor: Plus.Actor,
  input: {
    text?: string
    state?: "on" | "off"
    pin?: boolean
    active?: boolean
    resolve?: "keep" | "take" | "edit" | "merge"
    warming?: string
    interval?: string
    prompt?: string
    effort?: string
  },
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const node = findRow(memo, id)
    const label = node?.label ?? id
    // Cache warming for this agent on this model at this level; "" inherits.
    if (input.warming !== undefined && input.text === undefined && input.interval === undefined && input.prompt === undefined) {
      const warming = input.warming
      const op = setModelWarmingRow(memo, id, warming)
      if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
      const applied = yield* mutateModels(api, memo, op.models, op.status, actor)
      return { output: { id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
    }
    // A model row's text replaces the candidate (and may set warming in the
    // same save), the tool-side equivalent of the TUI's enter edit dialog.
    // Interval, prompt or warming alone keep the row's candidate.
    if (input.text !== undefined || input.interval !== undefined || input.prompt !== undefined || input.warming !== undefined) {
      const parsed = input.text === undefined ? modelTargetOfAddress(node) : parseModelText(input.text)
      if (parsed === undefined)
        return yield* Effect.fail(
          new Tool.Error({
            message:
              input.text === undefined
                ? `"${label}" has no model candidate to set`
                : `"${label}" takes provider/model or provider/model#variant (got "${input.text}")`,
          }),
        )
      const fields: ModelEditFields = {
        ...parsed,
        ...(input.warming === undefined ? {} : { warming: input.warming }),
        ...(input.interval === undefined ? {} : { interval: input.interval }),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      }
      const op = editModelRow(memo, id, fields)
      if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
      const applied = yield* mutateModels(api, memo, op.models, op.status, actor)
      return { output: { id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
    }
    if (input.resolve !== undefined) return yield* Effect.fail(new Tool.Error({ message: resolveRefusalForLabel(label) }))
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
      const applied = yield* mutateOp(api, memo, op, actor)
      return { output: { id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
    }
    if (input.resolve !== undefined) return yield* Effect.fail(new Tool.Error({ message: resolveRefusalForLabel(label) }))
    if (input.pin !== undefined) return yield* Effect.fail(new Tool.Error({ message: `"${label}" cannot be pinned` }))
    if (input.state !== undefined) return yield* Effect.fail(new Tool.Error({ message: `"${label}" cannot be toggled by state; use active:true to activate` }))
    const op = activateModelRow(memo, id)
    if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
    const applied = yield* mutateModels(api, memo, op.models, op.status, actor)
    return { output: { id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
  })
}

// One field row under an agent/member/preset model row edits that field alone
// at the row's level, mirroring a Defaults › Models field row. Model replaces
// the candidate (keeping the variant unless the text names one); Effort
// replaces the variant; Warming / Ping every / Keep-alive prompt set or clear
// that field on the candidate's local record. The field row's parent model row
// is the edit target, so an inherited row plants a local record like the TUI.
function setModelField(
  api: PlusApi,
  snapshot: Plus.Snapshot,
  memo: MemoInput,
  id: string,
  actor: Plus.Actor,
  input: { text?: string },
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const node = findRow(memo, id)
    if (node === undefined) return yield* Effect.fail(unknownError(id))
    if (input.text === undefined)
      return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" takes text: its value, or "" to inherit` }))
    const text = input.text
    const op = setModelFieldRow(memo, id, text)
    if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
    const applied = yield* mutateModels(api, memo, op.models, op.status, actor)
    return { output: { id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
  })
}

// r on a field row clears that field at the row's level. Model has no field
// below it to fall back to, so it refuses; Effort drops the row's variant;
// the warming fields clear and inherit again.
function resetModelField(
  api: PlusApi,
  snapshot: Plus.Snapshot,
  memo: MemoInput,
  id: string,
  actor: Plus.Actor,
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const node = findRow(memo, id)
    if (node === undefined) return yield* Effect.fail(unknownError(id))
    const op = resetModelFieldRow(memo, id)
    if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
    const applied = yield* mutateModels(api, memo, op.models, op.status, actor)
    return { output: { id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
  })
}

// Defaults › Models rows (model-settings.ts) edit through modelSettings.set, not
// the inventory mutate: they are server-owned rows like teams. A string sets a
// field, "" clears it, absent leaves it; `state` sets the warming switch.
function setModelDefaults(
  api: PlusApi,
  node: TreeNode,
  actor: Plus.Actor,
  input: {
    state?: "on" | "off"
    warming?: string
    interval?: string
    prompt?: string
    effort?: string
    compactWarm?: string
    coldCompact?: string
    coldModels?: readonly string[]
    compactionStrategy?: string
    compactionModel?: string
    compactionInstructions?: string
    text?: string
    pin?: boolean
    active?: boolean
    resolve?: "keep" | "take" | "edit" | "merge"
    mode?: "primary" | "subagent" | "all"
  },
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    if (input.text !== undefined) return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" takes warming, interval, prompt or effort, not text` }))
    if (input.pin !== undefined) return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" cannot be pinned` }))
    if (input.active !== undefined) return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" is not a model row` }))
    if (input.resolve !== undefined) return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" has no review to resolve` }))
    if (input.mode !== undefined) return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" has no mode` }))
    if (
      input.warming === undefined &&
      input.interval === undefined &&
      input.prompt === undefined &&
      input.effort === undefined &&
      input.compactWarm === undefined &&
      input.coldCompact === undefined &&
      input.coldModels === undefined &&
      input.compactionStrategy === undefined &&
      input.compactionModel === undefined &&
      input.compactionInstructions === undefined &&
      input.state === undefined
    )
      return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" needs warming, interval, prompt or effort to set` }))
    const key = defaultsKeyOf(node)
    if (key === undefined) return yield* Effect.fail(unknownError(node.id))
    const result = yield* Effect.promise(() =>
      api.setModelSettings({
        ...key,
        ...(input.state === undefined ? {} : { warming: input.state }),
        ...(input.warming === undefined ? {} : { warming: input.warming }),
        ...(input.interval === undefined ? {} : { interval: input.interval }),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...(input.compactWarm === undefined ? {} : { compactWarm: input.compactWarm }),
        ...(input.coldCompact === undefined ? {} : { coldCompact: input.coldCompact }),
        ...(input.coldModels === undefined ? {} : { coldModels: [...input.coldModels] }),
        ...(input.compactionStrategy === undefined ? {} : { compactionStrategy: input.compactionStrategy }),
        ...(input.compactionModel === undefined ? {} : { compactionModel: input.compactionModel }),
        ...(input.compactionInstructions === undefined ? {} : { compactionInstructions: input.compactionInstructions }),
        actor,
      }),
    )
    if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `modelSettings.invalid: ${result.error.message}` }))
    return { output: { id: node.id, status: defaultsStatus(node.label, result.value.record), revision: result.value.revision, globalRevision: result.value.globalRevision } }
  })
}

function clearModelDefaults(
  api: PlusApi,
  node: TreeNode,
  actor: Plus.Actor,
  verb: "reset" | "remove",
  fields: readonly ModelDefaultField[] = [...MODEL_DEFAULT_FIELDS],
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const key = defaultsKeyOf(node)
    if (key === undefined) return yield* Effect.fail(unknownError(node.id))
    const result = yield* Effect.promise(() =>
      api.setModelSettings({ ...key, ...Object.fromEntries(fields.map((field) => [field, null])), actor }),
    )
    if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `modelSettings.invalid: ${result.error.message}` }))
    return {
      output: {
        id: node.id,
        status: `${verb === "remove" ? "Cleared" : "Reset"} "${node.label}" to inherit`,
        revision: result.value.revision,
        globalRevision: result.value.globalRevision,
      },
    }
  })
}

// A Defaults › Models row, or one of its field rows, names the model it sets.
function defaultsKeyOf(node: TreeNode): ModelSettingsKey | undefined {
  const item = node.address?.item
  if (item === undefined) return undefined
  return parseModelDefaultItemId(item) ?? parseModelSettingItemId(item)?.key
}

function settingOf(node: TreeNode) {
  return node.address === undefined ? undefined : parseModelSettingItemId(node.address.item)
}

function defaultsStatus(label: string, record: Plus.SnapshotModelSettingsRecord | null): string {
  if (record === null) return `Defaults › Models "${label}" inherits`
  const set = [
    ...(record.warming === undefined ? [] : [`warming ${record.warming}`]),
    ...(record.interval === undefined ? [] : [`every ${record.interval}`]),
    ...(record.prompt === undefined ? [] : ["a prompt"]),
    ...(record.effort === undefined ? [] : [`effort ${record.effort}`]),
  ]
  return `Defaults › Models "${label}": ${set.join(", ")}`
}

function setPerm(
  api: PlusApi,
  snapshot: Plus.Snapshot,
  memo: MemoInput,
  id: string,
  actor: Plus.Actor,
  input: { text?: string; state?: "on" | "off"; pin?: boolean; active?: boolean; resolve?: "keep" | "take" | "edit" | "merge"; label?: string; patterns?: readonly string[]; keywords?: readonly string[]; message?: string },
  treeMemo?: Memo,
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
      const op = computeSet(memo, { id, text }, treeMemo)
      if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
      const applied = yield* mutateOp(api, memo, op, actor)
      return { output: { id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
    }
    if (input.resolve !== undefined) return yield* Effect.fail(new Tool.Error({ message: resolveRefusalForLabel(label) }))
    if (input.pin !== undefined) return yield* Effect.fail(new Tool.Error({ message: `"${label}" cannot be pinned` }))
    if (input.active !== undefined) return yield* Effect.fail(new Tool.Error({ message: `"${label}" cannot be activated` }))
    const op = computeSet(memo, { id, ...(input.state === undefined ? {} : { state: input.state }) }, treeMemo)
    if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
    const applied = yield* mutateOp(api, memo, op, actor)
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
    const applied = yield* mutateModels(api, memo, op.models, op.status, actor)
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
    // Same content as the TUI's `d`: a live local record is deleted, an
    // inherited or upstream row is hidden at this level with a tombstone, and
    // the currently effective model refuses with its own message.
    const op = removeModelRow(memo, id)
    if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
    const applied = yield* mutateModels(api, memo, op.models, op.status, actor)
    return { output: { id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
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
  input: { state?: "on" | "off"; text?: string; pin?: boolean; resolve?: "keep" | "take" | "edit" | "merge" },
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

// `set {id, state}` on a group row id: the explicit target (or a plain toggle
// when state is absent) applies to the group's nearest toggleable rows in one
// write (ops.toggleGroup). Protected agents' rows are skipped and named; team
// groups refuse (teams enable through team.setEnabled, not records).
function setGroup(
  api: PlusApi,
  snapshot: Plus.Snapshot,
  memo: MemoInput,
  id: string,
  actor: Plus.Actor,
  input: { state?: "on" | "off"; text?: string; pin?: boolean; mode?: unknown; requires?: unknown; resolve?: unknown },
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const node = findRow(memo, id)
    const label = node?.label ?? id
    if (input.text !== undefined) return yield* Effect.fail(new Tool.Error({ message: editRefusalForLabel(label) }))
    if (input.pin !== undefined) return yield* Effect.fail(new Tool.Error({ message: `"${label}" is not a Code Mode tool and cannot be pinned` }))
    if (input.resolve !== undefined) return yield* Effect.fail(new Tool.Error({ message: resolveRefusalForLabel(label) }))
    if (input.mode !== undefined || input.requires !== undefined)
      return yield* Effect.fail(new Tool.Error({ message: `"${label}" is a group: only state on|off applies` }))
    const target = input.state === undefined ? undefined : input.state === "on"
    const isProtected = (agent: string) => snapshot.protectedAgents.includes(agent)
    const op = toggleGroup(memo, id, undefined, target, isProtected)
    if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
    const applied = yield* mutateOp(api, memo, op, actor)
    return { output: { id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
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
    if (node === undefined) return yield* Effect.fail(unknownError(id, memo))
    // A model row's field row renders one effective value with its source.
    const modelField = node.address === undefined ? undefined : parseModelFieldItemId(node.address.item)
    if (modelField !== undefined) {
      if (view === "record") {
        const address = node.address!
        // Match the full owner: level, agent, team and catalogue. A shared
        // inventory row's Teams record is a different record from its Agents
        // one, and a member row's team-scoped record from its flat one.
        const record = modelsOfMemo(memo).find(
          (entry) =>
            entry.level === address.level &&
            entry.agent === address.agent &&
            sameTeam(entry.team, address.team) &&
            catalogueMatches(address.agent, entry.catalogue, address.catalogue) &&
            entry.providerID === modelField.target.providerID &&
            entry.modelID === modelField.target.modelID &&
            entry.variant === modelField.target.variant,
        )
        return { output: { id, view, record: record ?? null } }
      }
      if (view !== "resolved")
        return yield* Effect.fail(new Tool.Error({ message: `view.unsupported: ${view} view is not available for a model field row (got ${id})` }))
      return { output: { id, view, label: node.label, field: modelField.field, value: node.badges.value ?? null } }
    }
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
    if (isModelDefaultRowId(id) || isModelSettingRowId(id)) {
      const key = defaultsKeyOf(node)
      if (key === undefined) return yield* Effect.fail(unknownError(id))
      const record = settingsFor(memo.modelSettings ?? [], key)
      if (view === "record") return { output: { id, view, record: record ?? null } }
      if (view !== "resolved")
        return yield* Effect.fail(new Tool.Error({ message: `view.unsupported: ${view} view is not available for a Defaults › Models row (got ${id})` }))
      const host =
        key.providerID === undefined || key.modelID === undefined
          ? undefined
          : hostModelOf(memo.hostModels ?? [], { providerID: key.providerID, modelID: key.modelID })
      const resolved = modelDefaultView({
        ...(record === undefined ? {} : { record }),
        ...(everySettings(memo.modelSettings ?? []) === undefined ? {} : { every: everySettings(memo.modelSettings ?? []) }),
        ...(host?.warming === undefined ? {} : { host: host.warming }),
        ...(host === undefined ? {} : { variants: host.variants }),
      })
      const setting = settingOf(node)
      return {
        output: {
          id,
          view,
          label: node.label,
          ...(setting === undefined
            ? {}
            : {
                field: setting.field,
                value: (MODEL_SETTINGS_FIELDS as readonly string[]).includes(setting.field)
                  ? (modelSettingEffective(resolved, setting.field as ModelSettingsField) ?? null)
                  : null,
              }),
          summary: modelDefaultValue(resolved),
          warming: { on: resolved.on.value, from: resolved.on.from, ...(resolved.on.value ? { duration: resolved.duration.value } : {}) },
          interval: { value: resolved.interval.value, from: resolved.interval.from },
          prompt: { value: resolved.prompt.value, from: resolved.prompt.from },
          ...(resolved.effort === undefined ? {} : { effort: { value: resolved.effort.value, from: resolved.effort.from } }),
          ...(record === undefined ? {} : { record }),
        },
      }
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
          text: address.section === null ? (resolved.fullText ?? resolved.text) : resolved.text,
          assembled: resolved.assembled,
          enabled: resolved.enabled,
          source: resolved.source,
          stateFrom: resolved.from,
          textFrom: resolved.textFrom,
          ...(node.badges.fromLabel === undefined ? {} : { from: node.badges.fromLabel }),
          ...(node.badges.reviewOf === undefined ? {} : { reviewOf: node.badges.reviewOf }),
          // Instructions that follow capabilities (requires.ts): a section's
          // requires line and uncovered mentions, a row's Tools and rules sections.
          ...(node.badges.requires === undefined ? {} : { requires: node.badges.requires }),
          ...(node.badges.requiresFrom === undefined ? {} : { requiresFrom: node.badges.requiresFrom }),
          ...(node.badges.requiresHere === true ? { requiresHere: true } : {}),
          ...(node.badges.mentions === undefined ? {} : { mentions: node.badges.mentions }),
          ...(node.badges.guidance === undefined ? {} : { guidance: node.badges.guidance }),
        },
      }
    }
    if (view === "upstream") return { output: { id, view, text: upstreamForEdit(chain) } }
    if (view === "mine") {
      if (address.section === null) {
        const ownRecords = customizations.filter(
          (record) =>
            record.level === address.level &&
            record.agent === address.agent &&
            sameTeam(record.team, address.team) &&
            record.item === address.item &&
            catalogueMatches(address.agent, record.catalogue, address.catalogue),
        )
        const hasOverride = ownRecords.some((r) => r.text !== undefined)
        if (!hasOverride) return { output: { id, view, text: "", hasOverride: false } }
        const wholeRecord = ownRecords.find((r) => r.section === null && r.text !== undefined)
        const hasSectionOverrides = ownRecords.some((r) => r.section !== null && r.text !== undefined)
        if (wholeRecord !== undefined && !hasSectionOverrides) {
          return { output: { id, view, text: wholeRecord.text ?? "", hasOverride: true } }
        }
        const resolved = resolve(chain)
        return { output: { id, view, text: resolved.fullText ?? resolved.text, hasOverride: true } }
      }
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
    const proposal = mergeProposal(memo, buildTreeMemo(memo), node)
    if (proposal === undefined) return { output: { id, view: "diff", mineDiff: "", upstreamDiff: "", summary: "no changes" } }
    const { three, entries } = proposal
    const mineDiff = unifiedDiff(three.original, three.mine, { from: "original", to: "mine" })
    const upstreamDiff = unifiedDiff(three.original, three.upstream, { from: "original", to: "upstream" })
    const summary = `mine differs by ${changedLines(three.original, three.mine)} lines, upstream by ${changedLines(three.original, three.upstream)} lines`
    return { output: { id, view: "diff", mineDiff, upstreamDiff, summary, merge: mergeOutput(entries) } }
  })
}

// The merge proposal of one row, built from the same context `set` resolves
// against, so the unit ids `show` returns are the ids `set` accepts.
function mergeProposal(memo: MemoInput, treeMemo: Memo, node: TreeNode): { three: ThreeWay; entries: MergeEntry[] } | undefined {
  const address = node.address
  if (address === undefined) return undefined
  const upstream = upstreamOf({ ...memo, items: treeMemo.ctx.items }, address)
  if (upstream === undefined) return undefined
  const three = threeWay({
    upstream,
    records: treeMemo.ctx.customizations,
    splits: treeMemo.ctx.splits,
    scopes: treeMemo.ctx.scopes,
    address,
  })
  if (three === undefined) return undefined
  return { three, entries: mergeUnits(three.original, three.mine, three.upstream) }
}

function mergeIds(entries: readonly MergeEntry[]): string[] {
  return entries.flatMap((entry) => (entry.type === "unchanged" ? [] : entry.upstreamId === undefined ? [entry.id] : [entry.id, entry.upstreamId]))
}

function mergeOutput(entries: readonly MergeEntry[]) {
  const defaults = defaultInclude(entries)
  const units = entries.flatMap((entry) =>
    entry.type === "unchanged"
      ? []
      : mergeIds([entry]).map((id) => ({
          id,
          kind: entry.kind,
          yours: entry.yours.join(""),
          upstream: entry.upstream.join(""),
          base: entry.base.join(""),
          included: defaults.has(id),
        })),
  )
  return { units, text: renderMerge(entries, defaults) }
}

// `set` with resolve merge: the include set (default: the defaults) renders the
// merged text; a render equal to upstream is a take, as the screen's t saves it.
function mergeOp(memo: MemoInput, treeMemo: Memo, node: TreeNode, input: { id: string; text?: string; include?: readonly string[] }) {
  if (input.text !== undefined)
    return { refusal: `"${node.label}" merges by include, not text: resolve merge takes include; edit takes text` }
  const proposal = mergeProposal(memo, treeMemo, node)
  if (proposal === undefined) return { refusal: resolveRefusalForLabel(node.label) }
  const valid = mergeIds(proposal.entries)
  const unknown = (input.include ?? []).find((id) => !valid.includes(id))
  if (unknown !== undefined)
    return { refusal: `"${node.label}" has no merge unit "${unknown}": valid units are ${valid.join(", ") || "none"}` }
  const include = input.include === undefined ? defaultInclude(proposal.entries) : new Set(input.include)
  const text = renderMerge(proposal.entries, include)
  if (withoutFinalNewline(text) === withoutFinalNewline(proposal.three.upstream))
    return resolveReview(memo, input.id, "take", undefined, undefined, treeMemo)
  return resolveReview(memo, input.id, "merge", text, undefined, treeMemo)
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
  address: { level: CustomizationRecord["level"]; agent: string | null; item: string; section: string | null; team?: CustomizationRecord["team"]; catalogue?: CustomizationRecord["catalogue"] },
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
          catalogueMatches(address.agent, record.catalogue, address.catalogue) &&
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
      | "folder"
    id?: string
    scope?: "project" | "global" | "defaults" | "preset"
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
    if (input.kind === "folder") {
      if (input.id === undefined) return yield* Effect.fail(new Tool.Error({ message: "create folder requires id: the tab row or folder row to create it in" }))
      const snapshot = yield* snapshotOrFail(api)
      const memo = memoFromSnapshot(snapshot)
      const applied = yield* applyLayout(api, snapshot, planFolderCreate(memo, layoutOf(snapshot), input.id, input.name ?? "", new Date().toISOString()), actor)
      return { output: { id: applied.target, item: applied.target, ...applied } }
    }
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
      const scope = input.scope ?? "project"
      const preset = typeof input.preset === "string" ? input.preset : input.preset?.id
      if (scope === "preset" && (preset === undefined || preset.length === 0))
        return yield* Effect.fail(new Tool.Error({ message: "preset.invalid: create skill with scope preset requires a preset id" }))
      const created = yield* Effect.promise(() =>
        api.createSkill({
          name: input.name as string,
          body: input.body as string,
          scope,
          ...(preset === undefined ? {} : { preset }),
          actor,
        }),
      )
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
      // A member's owner path (`<team>/:<member>`, the segment team and
      // member rows carry) is not an agent id: agent ids forbid `:`. Passing
      // it as `agent` with no `team` would otherwise find the member's Models
      // group, write a record whose agent is literally that path, and fail to
      // find the row, leaving an unreachable record delete cannot remove.
      // Refuse before any write and name the two fields to pass instead.
      if (team === undefined && agent !== null) {
        const owner = parseMemberOwnerPath(agent)
        if (owner !== undefined)
          return yield* Effect.fail(
            new Tool.Error({
              message: `model.invalid: ${JSON.stringify(agent)} is a team member's owner path, not an agent id; pass agent ${JSON.stringify(owner.member)} with team ${JSON.stringify(owner.team)}`,
            }),
          )
      }
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
