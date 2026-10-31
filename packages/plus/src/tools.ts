import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import { Tool } from "@opencode/schema/tool"
import { Effect, Option, Schema } from "effect"
import { modelActivationRefusal, reflectedPeer, reflectedRows } from "./instructions/reflection.js"
import { interactiveActor } from "./instructions-cli.js"
import { captureRows, pasteRows, type Clipboard } from "./instructions/clipboard.js"
import { duplicateName, duplicateSource, itemRecordsCopy, materializedOwnerRecords, ownerLayoutCopy, systemCopyId, teamLayoutCopy, teamRecordsCopy, type DuplicateSource } from "./instructions/duplicate.js"
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
  editableText,
  findRow,
  isModelRowId,
  isPermRowId,
  parseModelText,
  planFolderCreate,
  planFolderDelete,
  planFolderRename,
  planGroupMove,
  planLayoutReview,
  planRowMove,
  planSectionMove,
  planSystemMove,
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
import { findCollapse, namedFinds, query, rowTypes } from "./instructions/query.js"
import { replaceText } from "./instructions/text-edit.js"
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
import type { Address, CustomizationRecord, ModelRecord, RuleRecord, SplitRecord, ThreeWay } from "./instructions/model.js"
import { buildTreeMemo, findLazy, lazyPath, materialize, tabLayout, type Lazy } from "./instructions/tree.js"
import { badgeLabels } from "./instructions/from-label.js"
import { ownRule, ruleAt, ruleItem } from "./instructions/rules.js"
import type { Memo, MemoInput, TreeNode } from "./instructions/tree.js"
import { isModelPrompt } from "./instructions/system-order.js"
import { contextOfSnapshot, memoInputOf, presetOf } from "./instructions/snapshot.js"
import { rowlinksOf, storedRecords } from "./instructions/resolve-memo.js"
import { markerIn } from "./instructions/requires.js"
import { sameEndpoint, sameOwnerView, writeRowlink, rowlinkView, type RowlinkEndpoint, type RowlinkRecord, type RowlinkType } from "./instructions/rowlinks.js"
import { deltaOf, snapshotRecordOf } from "./instructions/delta.js"
import { stagedApi } from "./instructions/staged.js"
import type { StoredRecord } from "./instructions/store.js"
import { IMAGE_FIELDS, type ImageField } from "./image-settings.js"
import {
  everySettings,
  effectiveCompaction,
  effectiveImages,
  MODEL_COMPACTION_FIELDS,
  compactionFieldsOf,
  setModelCompaction,
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
import { folderIdOfRef, folderRef } from "./instructions/folders.js"
import type { PlusApi } from "./index.js"
import { Plus } from "./rpc.js"

const namespace = "instructions"
// OpenCodePlus: creating and deleting AGENTS.md files is off pending the
// Context catalogue; the files OpenCode sends are rows under System.
export const INSTRUCTION_DISABLED =
  "instruction.disabled: creating and deleting AGENTS.md files from OpenCodePlus is off until the Context catalogue. The files OpenCode sends are listed under System › AGENTS.md files, each switched off or edited per agent."
const origin = { type: "plugin", name: "opencode.plus" } as const
const options = { namespace, codemode: true, permission: "instructions" } as const
// The most rows one read, set, edit, reset or delete takes through find.
const maxRows = 200

const FindDescription =
  "Find instruction rows: one \"id | badges | from\" line per thing; every parameter given must match.\n" +
  "Each row appears once, at its most specific level (what runs here). Without agent or team, agents' copies with the same on/off and text are one row, ending \"(+N agents)\"; agent \"*\" lists each. " +
  "level, in, type section|preset and is (each level's own edits) show the rest. " +
  "agent, team, level, type, name and is take lists (any of them). e.g. {agent:[\"build\",\"plan\"],type:\"tool\",state:\"off\"}, {is:\"review\"}. fields picks columns after id; limit defaults to 40. Returns { total, columns, rows }."

const ReadDescription =
  "Read one row: its text and where it comes from (view resolved, the default).\n" +
  "On an agent, group or root, resolved lists the rows under it. assembled appears only when what reaches the model differs from text.\n" +
  "Views: upstream, mine, diff (unified diffs and the merge units set's resolve merge takes), record, sections, assembled (an agent's whole prompt; its dropped list names every line a rule cut, with the rule).\n" +
  "Team, member, preset and entry rows return what they stand for; a Defaults › Models row each effective keep-alive value and its source.\n" +
  "Several rows: id as a list, or find with find's filters; that answers { total, failed, results: [{ id, output } or { id, error }] }."

// What a write over several rows answers (eachStep).
const ManyWrites =
  "Several rows: id as a list, or find with find's filters (lists match any: name:[\"edit\",\"write\"]). They are written once (one revision, one log entry); the answer is { status, changed, already, notDone: [{ id, reason }] }, verbose adds each row's answer. dryRun writes nothing."

const SetDescription =
  "Change one row: its text, on/off state, pin, model, review, preset link or a field (TUI Enter/Space/p/w/k/t/e/l).\n" +
  "text replaces the whole text (edit changes part of it). state on|off switches the row; a bare id toggles it (models: activates). On a group, state switches every row under it (protected rows are skipped).\n" +
  "Agent and member rows take state and mode primary|subagent|all; setting:* and compaction:* rows take text (enabled and hidden take state); empty clears.\n" +
  "resolve keep|take|edit settles a review (keep|take also a tab's layout); resolve merge with include:[unit ids from read's diff] saves a merge. preset links an agent, member, team, entry or user preset (\"<id>\" or \"<team>/<member>\"; null unlinks). rename renames an agent, member, team or folder.\n" +
  "Model rows: active true activates; text replaces the candidate (provider/model#variant); warming, interval, waiting (warm while waiting on its own work: off or a time, built-in 2h), subagent (Warm as subagent: off, on = the warming time, or its own time such as 15m; built-in off, independent of warming; chat switch wins) and prompt set keep-alive; compactWarm, coldFirst (Compact cold chats first for this model, over the Settings switch), coldModels, compactionStrategy|Model|Instructions|Input|Output, imageConvert, imageShrink and imagesFull set per-model compaction and images (null inherits; coldCompact is refused). Defaults › Models rows also take effort, and state for warming.\n" +
  "Perm rows take state, message (the refusal the model reads) and label+patterns(+keywords). System rows take requires (when sent); model prompt rows take models. Enabling a team disables the others (disabledTeams). like:\"<agent>\" (or \"<team>/<member>\") takes that agent's on/off and text for the same row. More in skill instructions-tools.\n" +
  ManyWrites

const EditDescription =
  "Change part of a row's text: replace oldString with newString, like the edit tool does for a file.\n" +
  "oldString must match the row's current text (read's text) exactly once; replaceAll replaces every occurrence. Saves like set({ id, text }) and set's permissions apply.\n" +
  "Works on any row with text (tools, parameters, sections, base, system, skills, settings); models, rules, teams and groups change with set. Returns { id, status, replacements }.\n" +
  ManyWrites

const MoveDescription =
  "Move a row, folder or section before or after a sibling, or a row or folder into a folder or a tab's top level.\n" +
  "Rows move only inside their own tab; folders are display only. A section moves within its item (the item's text is rewritten).\n" +
  "In a System list, moving a row reorders that part of the owner's system prompt (before/after only; a base prompt moves with Role/persona; OpenCode's parts move but are not edited).\n" +
  "id takes a list: the rows move in that order to the same place, written once; dryRun writes nothing."

const ResetDescription =
  "Drop the override at this level only (TUI `r`).\n" +
  "Agent and member rows reset their settings and compaction controls; model rows clear only this level's active flag; a Defaults › Models row clears its values.\n" +
  ManyWrites

const SplitDescription =
  "Set manual sections or append one (TUI `s` / `a` on an item).\n" +
  "Pass boundaries [{id,name,start}] to set manual sections, or add {name,text} to append one."

const CreateDescription =
  "Create an agent, team, member, Defaults entry, preset, skill, base, system, MCP, model, rule or folder row (TUI `a`).\n" +
  "Returns {id, item}: pass id to read, set, edit and delete. Kinds and their fields: agent (id, scope project|global, preset); team (team, level, preset = a team preset; created disabled); " +
  "member (team, level, id, preset; at level defaults a Teams entry, team and id are patterns); entry (catalogue agents|teams, name with * or %, team pattern, preset); " +
  "preset, teamPreset, presetMember (id, from; presetMember also team); skill (name, body, scope); base (id, title, text); system (id, text, title; models makes a model prompt); mcp (name, config); " +
  "model (providerID, modelID, variant, level, agent; it becomes the active one there); rule (tool, id, label, patterns as core wildcards not regex, keywords, message, level, agent); folder (name, id of the tab or folder).\n" +
  "A preset is \"<id>\" (agent preset) or \"<team>/<member>\" (member preset); without one an agent is unlinked and Defaults still apply. catalogue agents|teams picks where a shared Defaults model or rule lands.\n" +
  "id and agent take lists (one create each, e.g. a rule for agent:[\"a\",\"b\"]); a team takes members:[\"<id>\" or {id,preset}]. Several are answered like set's several rows. dryRun previews record rows only, not new files."

const DeleteDescription =
  "Delete a user-owned row: agent, team, member, file, Defaults entry, user preset, custom rule or folder.\n" +
  "Needs confirm:true. A model row deletes its candidate at this level (the active model refuses: activate another first); a Defaults › Models row clears its values. A preset still linked is refused (preset.inUse names the rows); force:true overrides links only other projects hold.\n" +
  ManyWrites

const LogDescription =
  "Change history (who/what/when).\n" +
  "Reads the change log newest-first with where/limit/offset filtering. A write of several rows lists them in rows; undo with its ts takes the whole write back."

const LinkDescription =
  "Inspect or set a link between two rows of the same owner and level.\n" +
  "Without target: list the row's links in and out. With target: store a link from id to target; type either (default: turning one on switches the other off), shownWhenOn or shownWhenOff (target is sent only while id is on / off; id must be a whole row).\n" +
  "enabled:false masks the pair at this level, including an inherited link.\n" +
  "id and target take lists: every id is linked to every target in one call (links are their own store: one write per pair); dryRun refuses them."

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

// A filter value: one, or a list matching any of them. In the string form a
// comma separates values too (agent:"build,plan"), as in where.
const OneOrMore = <S extends Schema.Top>(value: S) => Schema.Union([value, Schema.Array(value)])

const FindFilter = Schema.Struct({
  agent: Schema.optionalKey(OneOrMore(Schema.String)).annotate({
    description: "An agent or team member by name, ignoring case; * stands for any text. A list (or a,b) matches any of them.",
  }),
  team: Schema.optionalKey(OneOrMore(Schema.String)).annotate({ description: "A team: its rows and its members' rows. A list matches any." }),
  level: Schema.optionalKey(OneOrMore(Schema.Literals(["project", "global", "defaults", "preset"]))).annotate({
    description: "Only this level (or these). Without it, each row at the most specific level it has (what runs here).",
  }),
  type: Schema.optionalKey(OneOrMore(Schema.Literals(rowTypes))),
  name: Schema.optionalKey(OneOrMore(Schema.String)).annotate({
    description: "A row's own name: tool, skill, rule, setting, section or agent name, ignoring case; * stands for any text. A list matches any.",
  }),
  in: Schema.optionalKey(Schema.String).annotate({ description: "Only rows under this row id, e.g. a tool's parameters and rules." }),
  state: Schema.optionalKey(Schema.Literals(["on", "off"])),
  text: Schema.optionalKey(Schema.String).annotate({ description: "Rows whose text contains this, ignoring case (taken whole)." }),
  is: Schema.optionalKey(OneOrMore(Schema.Literals(namedFinds))).annotate({
    description:
      "Rows holding an edit: review (what it was based on changed since), changed (any; reset drops it), " +
      "overruled (a more specific level sets it too, so it never applies), orphaned (its row is gone). " +
      "held-back: rows and sections that are on, but the agent does not get them because their \"shown when\" does not hold.",
  }),
  where: Schema.optionalKey(Schema.String).annotate({ description: "More key:value terms (skill instructions-tools)." }),
})

const FindInput = Schema.Struct({
  ...FindFilter.fields,
  fields: Schema.optionalKey(Schema.Array(Field)),
  sort: Schema.optionalKey(Sort),
  limit: Schema.optionalKey(Schema.Number),
  offset: Schema.optionalKey(Schema.Number),
})

// The rows read, set, edit, reset and delete act on: one id, a list, or what a
// find filter matches (eachRow).
const Rows = {
  id: Schema.optionalKey(Schema.Union([Schema.String, Schema.Array(Schema.String)])).annotate({
    description: "A row id, or a list of row ids (a write over a list is written once and answers counts and the rows not done).",
  }),
  find: Schema.optionalKey(FindFilter).annotate({
    description:
      "Instead of id: the rows find lists with these filters (every page; without agent or team, each agent's copy). " +
      `At most ${maxRows} rows.`,
  }),
}

// Every write takes these. Several rows are applied to one in-memory store and
// written once: one store revision, one log entry, one publish.
const WriteOptions = {
  dryRun: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Answer what would change, in the same shape, and write nothing.",
  }),
  verbose: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Several rows: add each row's full answer (results).",
  }),
}
// Exactly one of id and find names the rows.
const oneSelection = Schema.makeFilter<{ readonly id?: unknown; readonly find?: unknown }>((input) =>
  input.id === undefined && input.find === undefined
    ? "Pass id (a row id or a list of them) or find (find's filters)"
    : input.id !== undefined && input.find !== undefined
      ? "Pass id or find, not both"
      : true,
)

const ReadInput = Schema.Struct({
  ...Rows,
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
}).check(oneSelection)

const SetInput = Schema.Struct({
  ...Rows,
  ...WriteOptions,
  like: Schema.optionalKey(Schema.String).annotate({
    description:
      "Each selected row takes the on/off (and text, where it has one) of the same row for this agent (\"<team>/<member>\" for a member), e.g. {find:{agent:\"lead\",type:\"skill\"},like:\"general\"}.",
  }),
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
  models: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description:
      "Model prompt rows only: the models it is sent for. Each pattern is matched, ignoring case, against provider/model, the model id and its name; * or % stands for any text, e.g. [\"*opus-5-5*\", \"%qwen3.6%\"].",
  }),
  active: Schema.optionalKey(Schema.Boolean),
  resolve: Schema.optionalKey(
    Schema.Union([Schema.Literal("keep"), Schema.Literal("take"), Schema.Literal("edit"), Schema.Literal("merge")]),
  ),
  include: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "With resolve merge: the unit ids (read's merge.units) to include; omitted = the defaults.",
  }),
  label: Schema.optionalKey(Schema.String),
  patterns: Schema.optionalKey(Schema.Array(Schema.String)),
  keywords: Schema.optionalKey(Schema.Array(Schema.String)),
  message: Schema.optionalKey(Schema.String),
  preset: Schema.optionalKey(Schema.NullOr(PresetInput)),
  warming: Schema.optionalKey(Schema.String),
  interval: Schema.optionalKey(Schema.String),
  waiting: Schema.optionalKey(Schema.String),
  subagent: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  effort: Schema.optionalKey(Schema.String),
  compactWarm: Schema.optionalKey(Schema.NullOr(Schema.String)),
  coldFirst: Schema.optionalKey(Schema.NullOr(Schema.String)),
  coldCompact: Schema.optionalKey(Schema.NullOr(Schema.String)),
  coldModels: Schema.optionalKey(Schema.NullOr(Schema.Union([Schema.String, Schema.Array(Schema.String)]))),
  compactionStrategy: Schema.optionalKey(Schema.NullOr(Schema.String)),
  compactionModel: Schema.optionalKey(Schema.NullOr(Schema.String)),
  compactionInstructions: Schema.optionalKey(Schema.NullOr(Schema.String)),
  imageConvert: Schema.optionalKey(Schema.NullOr(Schema.String)),
  imageShrink: Schema.optionalKey(Schema.NullOr(Schema.String)),
  imagesFull: Schema.optionalKey(Schema.NullOr(Schema.String)),
  compactionInput: Schema.optionalKey(Schema.NullOr(Schema.String)),
  compactionOutput: Schema.optionalKey(Schema.NullOr(Schema.String)),
  rename: Schema.optionalKey(Schema.String).annotate({
    description:
      "Rename this agent, on-disk team member or Project/Global team row to this new name/id, or a folder row to a new name. " +
      "Everything that names it follows in one store revision; built-ins, shipped Defaults rows, " +
      "ancestor-backed agents and Protected agents (tool actor) refuse.",
  }),
}).check(oneSelection)

const EditInput = Schema.Struct({
  ...Rows,
  ...WriteOptions,
  oldString: Schema.String.annotate({ description: "Exact text to find in the row's current text (read's text)" }),
  newString: Schema.String.annotate({ description: "Text to replace oldString with (must differ from oldString)" }),
  replaceAll: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Whether to replace every occurrence of oldString. When false, oldString must match exactly once. Defaults to false.",
  }),
}).check(oneSelection)

const MoveInput = Schema.Struct({
  id: OneOrMore(Schema.String).annotate({ description: "A row id, or a list moved together in this order (each after the one before)." }),
  ...WriteOptions,
  into: Schema.optionalKey(Schema.String),
  before: Schema.optionalKey(Schema.String),
  after: Schema.optionalKey(Schema.String),
})

const ResetInput = Schema.Struct({
  ...Rows,
  ...WriteOptions,
}).check(oneSelection)

const SplitInput = Schema.Struct({
  id: Schema.String,
  dryRun: WriteOptions.dryRun,
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
    Schema.Literal("system"),
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
  id: Schema.optionalKey(OneOrMore(Schema.String)).annotate({ description: "A list creates one row per id (agents, members, presets, ...)." }),
  ...WriteOptions,
  scope: Schema.optionalKey(
    Schema.Union([Schema.Literal("project"), Schema.Literal("global"), Schema.Literal("defaults"), Schema.Literal("preset")]),
  ),
  preset: Schema.optionalKey(PresetInput),
  from: Schema.optionalKey(PresetInput),
  name: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  models: Schema.optionalKey(Schema.Array(Schema.String)).annotate({
    description: "kind system: make it a model prompt sent only for these models (patterns; * or % stands for any text).",
  }),
  config: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  team: Schema.optionalKey(Schema.String),
  level: Schema.optionalKey(
    Schema.Union([Schema.Literal("project"), Schema.Literal("global"), Schema.Literal("defaults"), Schema.Literal("preset")]),
  ),
  catalogue: Schema.optionalKey(Plus.Catalogue),
  providerID: Schema.optionalKey(Schema.String),
  modelID: Schema.optionalKey(Schema.String),
  variant: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(OneOrMore(Schema.String)).annotate({ description: "kind model|rule: the owner; a list creates it for each agent." }),
  members: Schema.optionalKey(Schema.Array(Schema.Union([Schema.String, Schema.Struct({ id: Schema.String, preset: Schema.optionalKey(PresetInput) })]))).annotate({
    description: "kind team: members to add right after the team is made (ids, or {id, preset}).",
  }),
  tool: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  patterns: Schema.optionalKey(Schema.Array(Schema.String)),
  keywords: Schema.optionalKey(Schema.Array(Schema.String)),
  message: Schema.optionalKey(Schema.String),
})

const DeleteInput = Schema.Struct({
  ...Rows,
  ...WriteOptions,
  confirm: Schema.optionalKey(Schema.Boolean),
  force: Schema.optionalKey(Schema.Boolean),
}).check(oneSelection)

const LogInput = Schema.Struct({
  where: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Number),
  offset: Schema.optionalKey(Schema.Number),
})

const LinkInput = Schema.Struct({
  id: OneOrMore(Schema.String).annotate({ description: "The row (or rows) the link starts from." }),
  target: Schema.optionalKey(OneOrMore(Schema.String)).annotate({ description: "The other row, or a list: every id is linked to every target." }),
  ...WriteOptions,
  type: Schema.optionalKey(
    Schema.Union([
      Schema.Literal("either"),
      Schema.Literal("shownWhenOn"),
      Schema.Literal("shownWhenOff"),
    ]),
  ),
  enabled: Schema.optionalKey(Schema.Boolean),
})

const BatchOps = ["set", "edit", "reset", "split", "create", "delete", "move", "link"] as const

const BatchInput = Schema.Struct({
  changes: Schema.optionalKey(Schema.Array(Schema.Record(Schema.String, Schema.Unknown))).annotate({
    description:
      "Different changes in one call, applied in order to one store and written once: each is { op: set|edit|reset|delete|create|move|link|split, ...that op's fields }. A later change can name a row an earlier one created.",
  }),
  op: Schema.optionalKey(Schema.Literals(BatchOps)).annotate({ description: "TUI multi-select: the op for every selected row." }),
  id: Schema.optionalKey(Schema.String).annotate({ description: "TUI multi-select: the focused row." }),
  selected: Schema.optionalKey(Schema.Array(Schema.String)).annotate({ description: "TUI multi-select: the selected roots." }),
  input: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)).annotate({ description: "TUI multi-select: the op's fields except id." }),
  ...WriteOptions,
}).check(Schema.makeFilter<{ readonly changes?: unknown; readonly op?: unknown; readonly id?: unknown; readonly selected?: unknown; readonly input?: unknown }>((input) =>
  input.changes !== undefined
    ? input.op === undefined && input.id === undefined && input.selected === undefined && input.input === undefined ? true : "Pass changes, or op with id, selected and input, not both"
    : input.op !== undefined && input.id !== undefined && input.selected !== undefined && input.input !== undefined ? true : "Pass changes: [{ op, ...fields }]",
))

const BatchDescription =
  "Several different changes in one call, applied in order and written once.\n" +
  "batch({ changes: [{ op: \"create\", kind: \"agent\", id: \"lead\" }, { op: \"set\", find: { agent: \"lead\", type: \"tool\", name: [\"edit\", \"write\"] }, state: \"off\" }] }).\n" +
  "One store, one revision, one log entry; a change that refuses does not stop the rest, and the answer names each one not done and why. dryRun shows what would change; files (new agents, teams, skills) are not previewed.\n" +
  "The TUI's multi-select form: op, id (focused row), selected (roots) and input apply one op to the corresponding row under each root; it answers applied, skipped and failed ids."

const UndoInput = Schema.Struct({
  ts: Schema.optionalKey(Schema.String).annotate({ description: "The log entry's ts (log lists them); omitted = the newest change of records." }),
  dryRun: WriteOptions.dryRun,
})

const UndoDescription =
  "Take back one change log entry (one whole call) to the values before it; undo of an undo puts it back.\n" +
  "Not the same as reset, which drops this level's change. Rows changed again after that entry are not undone: the answer names each with who changed it. Only record changes undo; files (agents, skills, teams) are deleted or created again by hand."

export async function registerInstructionTools(ctx: Context, api: PlusApi): Promise<Registration> {
  const clipboards = new Map<string, Clipboard>()
  // The write ops batch runs, each against the api it is given (batch's
  // staged one), so a batch is applied to one in-memory store.
  const ops = new Map<string, { readonly input: Schema.Top; readonly run: (input: never, context: Tool.Context, api: PlusApi) => Effect.Effect<{ output: unknown }, Tool.Error> }>()
  const registered = <S extends Schema.Top>(name: string, input: S, run: (input: S["Type"], context: Tool.Context, api: PlusApi) => Effect.Effect<{ output: unknown }, Tool.Error>) => {
    ops.set(name, { input, run })
    return (value: S["Type"], context: Tool.Context) => run(value, context, api)
  }
  return runRegistration(ctx.tool.transform, (editor) => {
    editor.namespace({ name: namespace, description: "Instruction rows: tools, base prompts, skills, system files, MCP, teams." })
    editor.add({
      name: "clipboard",
      description: "Copy, cut and paste Instructions rows, or duplicate rows that can exist twice.\nPaste goes onto a compatible row or category. Copy captures independent configuration. Cut is pending until paste succeeds; clear cancels without writes. The returned clipboard token is temporary in this host. Pasting a tool into another agent updates its existing tool; copying the same tool within one owner refuses a duplicate. Placement and configuration are saved together. Use action copy/cut with ids, paste with clipboard and into, or clear with clipboard.\nduplicate with ids makes an independent copy of each agent (a built-in one becomes a user agent), team, team member with a file, skill, preset (built-in and team presets included), user System row or built-in System row (as a new user row with the text this owner sees), or folder, right after it, named \"<name> copy\" / \"<id>-copy\" (name sets it for one id). A copy is never linked to the original or its preset: it takes the original's effective configuration (on/off, texts, models, rules, links between its rows, folder layout) as its own records. A folder's copy holds a copy of every row inside it that can exist twice, recursively; the status names the rows it skipped and why. Rows that exist once (Tools, Role/persona, base prompts, AGENTS.md files, model prompts, tools, parameters, rules, models) refuse with the reason.",
      input: Schema.Struct({
        action: Schema.Literals(["copy", "cut", "paste", "clear", "duplicate"]),
        ids: Schema.optionalKey(Schema.Array(Schema.String)),
        clipboard: Schema.optionalKey(Schema.String),
        into: Schema.optionalKey(Schema.String),
        name: Schema.optionalKey(Schema.String).annotate({ description: "duplicate: the copy's name when ids holds one row" }),
      }),
      output: Plus.InstructionsClipboardOutput,
      options,
      origin,
      execute: (input, context) => Effect.gen(function* () {
        if (input.action === "clear") {
          if (input.clipboard !== undefined) clipboards.delete(input.clipboard)
          return { output: { status: "Clipboard cleared", rows: [] } }
        }
        if (input.action === "duplicate") {
          const ids = [...new Set(input.ids ?? [])]
          if (ids.length === 0) return yield* Effect.fail(new Tool.Error({ message: "Select rows to duplicate" }))
          const actor = actorFrom(context)
          const done: { row: string; status: string }[] = []
          const refused: string[] = []
          for (const id of ids) {
            yield* duplicateRow(api, id, ids.length === 1 ? input.name : undefined, actor).pipe(Effect.match({
              onSuccess: (copy) => { done.push(copy) },
              onFailure: (error) => { refused.push(error.message) },
            }))
          }
          if (done.length === 0) return yield* Effect.fail(new Tool.Error({ message: refused.join("; ") }))
          const status = done.length === 1 ? done[0]!.status : `Duplicated ${done.length} rows`
          return { output: { status: refused.length === 0 ? status : `${status}; not duplicated: ${refused.join("; ")}`, rows: done.map((copy) => copy.row) } }
        }
        const snapshot = yield* snapshotOrFail(api)
        const memo = memoFromSnapshot(snapshot)
        if (input.action === "copy" || input.action === "cut") {
          const captured = captureRows(memo, input.ids ?? [], input.action)
          if ("refusal" in captured) return yield* Effect.fail(new Tool.Error({ message: captured.refusal }))
          if (input.clipboard !== undefined) clipboards.delete(input.clipboard)
          const id = crypto.randomUUID()
          clipboards.set(id, captured)
          return { output: { clipboard: id, mode: captured.mode, rows: captured.rows, status: `${captured.rows.length} row(s) ${input.action === "cut" ? "ready to move" : "copied"}` } }
        }
        const captured = input.clipboard === undefined ? undefined : clipboards.get(input.clipboard)
        if (captured === undefined) return yield* Effect.fail(new Tool.Error({ message: "Clipboard is unavailable; copy or cut the rows again" }))
        if (input.into === undefined) return yield* Effect.fail(new Tool.Error({ message: "Choose a paste destination" }))
        const plan = pasteRows(memo, captured, input.into)
        if ("refusal" in plan) return yield* Effect.fail(new Tool.Error({ message: plan.refusal }))
        const delta = deltaOf(memo.records, plan.memo.records)
        const written = yield* Effect.promise(() => api.layoutWrite({
          ...plan.layout,
          changes: { upsert: delta.upsert.flatMap((record) => { const row = snapshotRecordOf(record); return row === undefined ? [] : [row] }), remove: delta.remove },
          expectedProjectRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision,
          target: input.into!, status: `Pasted ${captured.rows.length} row(s)`, actor: actorFrom(context),
        }))
        if (!written.ok) return yield* Effect.fail(new Tool.Error({ message: written.error.message }))
        if (captured.mode === "cut") clipboards.delete(input.clipboard!)
        return { output: { ...written.value, rows: plan.rows, consumed: captured.mode === "cut" } }
      }),
    })
    editor.add({
      name: "batch",
      description: BatchDescription,
      input: BatchInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: (input, context) => Effect.gen(function* () {
        if (input.changes !== undefined) {
          const steps = input.changes.map((change, index) => {
            const { op: name, dryRun: _dryRun, ...fields } = change
            const entry = typeof name === "string" && name !== "batch" ? ops.get(name) : undefined
            const label = `${index + 1}. ${String(name)}${typeof fields.id === "string" ? ` ${fields.id}` : ""}`
            return {
              id: label,
              run: (api: PlusApi) => {
                if (entry === undefined) return Effect.fail(new Tool.Error({ message: `unknown op ${JSON.stringify(name)}; ops: ${[...ops.keys()].filter((key) => key !== "undo").join(", ")}` }))
                const decoded = Schema.decodeUnknownExit(entry.input as unknown as Schema.Codec<unknown>)(fields)
                if (decoded._tag === "Failure") return Effect.fail(new Tool.Error({ message: `invalid ${String(name)}: ${String(decoded.cause).split("\n")[0]}` }))
                return entry.run(decoded.value as never, context, api)
              },
            }
          })
          return yield* eachStep(api, steps, { single: false, dryRun: input.dryRun, verbose: input.verbose })
        }
        // The TUI's multi-select: one op on the corresponding row under each selected root.
        const focus = input.id!
        const selected = input.selected ?? []
        const fieldsIn = input.input ?? {}
        const snapshot = yield* snapshotOrFail(api)
        const memo = treeMemoOf(memoFromSnapshot(snapshot))
        const reflected = reflectedRows(memo, focus, selected)
        if (input.op === "set" && (fieldsIn.active === true || fieldsIn.state === "on")) {
          const refusal = modelActivationRefusal(reflected.targets)
          if (refusal !== undefined) return yield* Effect.fail(new Tool.Error({ message: refusal }))
        }
        const operation = input.op === undefined ? undefined : ops.get(input.op)
        if (operation === undefined) return yield* Effect.fail(new Tool.Error({ message: `Unknown Instructions operation ${input.op}` }))
        const staged = stagedApi(api, { dryRun: input.dryRun === true, status: () => `${input.op} on ${reflected.targets.length} selected rows` })
        const applied: string[] = []
        const failed: { id: string; reason: string }[] = []
        const created = new Set<string>()
        const skipped = [...reflected.skipped]
        for (const row of reflected.targets) {
          const peer = input.op === "link" ? Option.getOrUndefined(Schema.decodeUnknownOption(Schema.String)(fieldsIn.target)) : undefined
          const target = peer === undefined ? undefined : reflectedPeer(memo, focus, row.id, selected, peer)
          if (peer !== undefined && target === undefined) {
            failed.push({ id: row.id, reason: "Does not have the corresponding link endpoint" })
            continue
          }
          const fields = input.op === "create" ? creationFields(memo, row, fieldsIn) : { ...fieldsIn, id: row.id, ...(target === undefined ? {} : { target: target.id }) }
          if ("refusal" in fields) {
            failed.push({ id: row.id, reason: String(fields.refusal) })
            continue
          }
          const decoded = Schema.decodeUnknownOption(operation.input as unknown as Schema.Codec<unknown>)(fields)
          if (Option.isNone(decoded)) {
            failed.push({ id: row.id, reason: `Invalid arguments for ${input.op}` })
            continue
          }
          const identity = JSON.stringify(decoded.value)
          if (input.op === "create" && created.has(identity)) {
            skipped.push({ id: row.id, reason: "The same shared resource was already created for another selected row" })
            continue
          }
          yield* operation.run(decoded.value as never, context, staged.api).pipe(Effect.match({
            onSuccess: () => { applied.push(row.id); created.add(identity); staged.settle(row.id) },
            onFailure: (error) => { failed.push({ id: row.id, reason: error.message }) },
          }))
        }
        yield* Effect.promise(() => staged.commit())
        const refused = new Set(staged.refused().map((entry) => entry.id))
        return { output: { applied: applied.filter((id) => !refused.has(id)), skipped, failed: [...failed, ...staged.refused()] } }
      }),
    })
    editor.add({
      name: "find",
      description: FindDescription,
      input: FindInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: (input) =>
        Effect.gen(function* () {
          const snapshot = yield* snapshotOrFail(api)
          const memo = memoFromSnapshot(snapshot)
          const columns = ["id" as const, ...(input.fields ?? lineFields).filter((field) => field !== "id")]
          const where = findWhere(input)
          const queried = yield* Effect.try({
            try: () =>
              query(memo, {
                where,
                fields: columns,
                ...(input.sort === undefined ? {} : { sort: input.sort }),
                limit: input.limit ?? 40,
                ...(input.offset === undefined ? {} : { offset: input.offset }),
                withoutAliases: true,
                collapse: findCollapse(where),
              }, treeMemoOf(memo)),
            catch: (error) => new Tool.Error({ message: error instanceof Error ? error.message : String(error) }),
          })
          return {
            output: {
              total: queried.total,
              columns: columns.join(" | "),
              // A row standing for other agents' same copies says how many, after where it comes from.
              rows: queried.rows.map((row) => {
                const more = row.copies === undefined ? "" : ` (+${row.copies} agent${row.copies === 1 ? "" : "s"})`
                const at = columns.includes("from") ? "from" : "badges"
                return columns.map((field) => cell(row[field]) + (field === at ? more : "")).join(" | ")
              }),
            },
          }
        }),
    })
    editor.add({
      name: "read",
      description: ReadDescription,
      input: ReadInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: (input) =>
        eachRow(api, input, (input, api) =>
          Effect.gen(function* () {
            const view = input.view ?? "resolved"
            if (view === "assembled") return yield* showAssembled(api, input.id)
            return yield* showRow(api, input.id, view)
          }),
          true,
        ),
    })
    editor.add({
      name: "set",
      description: SetDescription,
      input: SetInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: registered("set", SetInput, (input, context, api) =>
        eachRow(api, input, (given, api) =>
          Effect.gen(function* () {
            const actor = actorFrom(context)
            const snapshot = yield* snapshotOrFail(api)
            const memo = memoFromSnapshot(snapshot)
            const treeMemo = treeMemoOf(memo)
            const node = findRow(memo, given.id, treeMemo)
            if (node === undefined) return yield* Effect.fail(unknownError(given.id, memo))
            const protectedAgent = protectedOf(snapshot, node)
            if (protectedAgent !== undefined) return yield* Effect.fail(protectedError(protectedAgent))
            // like: the same row's on/off and text for that agent, set here.
            const liked = given.like === undefined ? undefined : likeFields(memo, treeMemo, node, given)
            if (liked !== undefined && "refusal" in liked) return yield* Effect.fail(new Tool.Error({ message: liked.refusal }))
            if (liked !== undefined && liked.state === undefined && liked.text === undefined)
              return { output: { id: given.id, status: `"${node.label}" is already like ${given.like}` } }
            const input = liked === undefined ? given : { ...given, ...liked }
            const folderId = folderIdOfRef(rowToken(node) ?? "")
            if (folderId !== undefined) {
              if (input.rename === undefined) return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" is a folder: set it with rename` }))
              const owner = node.id.split(":folder:")[0]!
              const applied = yield* applyLayout(api, snapshot, planFolderRename(layoutOf(snapshot), folderId, input.rename, new Date().toISOString(), owner, tabLayout(treeMemo, owner).inherited), actor)
              return { output: { id: input.id, ...applied } }
            }
            // A tab whose own layout is to review settles with keep or take.
            if (node.badges.reviewOf?.includes("layout") === true && (input.resolve === "keep" || input.resolve === "take")) {
              const applied = yield* applyLayout(api, snapshot, planLayoutReview(memo, layoutOf(snapshot), input.id, input.resolve, new Date().toISOString(), treeMemo), actor)
              return { output: { id: input.id, ...applied } }
            }
            if (input.rename !== undefined) return yield* renameRow(api, snapshot, node, input.rename, actor)
            if (input.models !== undefined) return yield* setModels(api, node, input, actor)
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
            if (input.compactWarm !== undefined || input.coldFirst !== undefined || input.coldCompact !== undefined || input.coldModels !== undefined || input.compactionStrategy !== undefined || input.compactionModel !== undefined || input.compactionInstructions !== undefined || input.compactionInput !== undefined || input.compactionOutput !== undefined || input.imageConvert !== undefined || input.imageShrink !== undefined || input.imagesFull !== undefined)
              return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" is not a model row; compaction fields are set on model or Defaults › Models rows` }))
            if (input.warming !== undefined)
              return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" is not a model row; warming is set on model rows` }))
            if (isPermRowId(input.id) || node.address?.item.startsWith("perm:")) return yield* setPerm(api, snapshot, memo, input.id, actor, input, treeMemo)
            if (node.kind === "group") return yield* setGroup(api, snapshot, memo, input.id, actor, input)
            if (input.include !== undefined && input.resolve !== "merge")
              return yield* Effect.fail(new Tool.Error({ message: `"${node.label}": include applies only with resolve merge` }))
            const op = input.resolve === "merge" ? mergeOp(memo, treeMemo, node, input) : computeSet(memo, input, treeMemo, (agent) => protectedForActor(snapshot, agent))
            if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
            const applied = yield* mutateOp(api, memo, op, actor)
            return { output: { id: input.id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
          }),
        )),
    })
    editor.add({
      name: "edit",
      description: EditDescription,
      input: EditInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: registered("edit", EditInput, (input, context, api) =>
        eachRow(api, input, (input, api) =>
          Effect.gen(function* () {
            const snapshot = yield* snapshotOrFail(api)
            const memo = memoFromSnapshot(snapshot)
            const treeMemo = treeMemoOf(memo)
            const node = findRow(memo, input.id, treeMemo)
            if (node === undefined) return yield* Effect.fail(unknownError(input.id, memo))
            const protectedAgent = protectedOf(snapshot, node)
            if (protectedAgent !== undefined) return yield* Effect.fail(protectedError(protectedAgent))
            if (!holdsText(input.id, node))
              return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" has no text to edit: change it with set` }))
            const current = editableText(memo, input.id, treeMemo)
            if ("refusal" in current) return yield* Effect.fail(new Tool.Error({ message: current.refusal }))
            const replaced = replaceText(current.text, input, current.label)
            if ("refusal" in replaced) return yield* Effect.fail(new Tool.Error({ message: replaced.refusal }))
            const op = computeSet(memo, { id: input.id, text: replaced.text }, treeMemo, (agent) => protectedForActor(snapshot, agent))
            if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
            const applied = yield* mutateOp(api, memo, op, actorFrom(context))
            return { output: { id: input.id, status: applied.status, replacements: replaced.replacements } }
          }),
        )),
    })
    editor.add({
      name: "move",
      description: MoveDescription,
      input: MoveInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: registered("move", MoveInput, (input, context, api) => {
        // Several ids keep their order: the first goes where asked, each next one right after it.
        const ids = typeof input.id === "string" ? [input.id] : [...new Set(input.id)]
        const first = {
          ...(input.into === undefined ? {} : { into: input.into }),
          ...(input.before === undefined ? {} : { before: input.before }),
          ...(input.after === undefined ? {} : { after: input.after }),
        }
        return eachStep(api, ids.map((id, index) => ({ id, run: (api) => moveRow(api, id, index === 0 ? first : { after: ids[index - 1]! }, actorFrom(context)) })), {
          single: typeof input.id === "string", dryRun: input.dryRun, verbose: input.verbose,
        })
      }),
    })
    editor.add({
      name: "reset",
      description: ResetDescription,
      input: ResetInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: registered("reset", ResetInput, (input, context, api) =>
        eachRow(api, input, (input, api) =>
          Effect.gen(function* () {
            const actor = actorFrom(context)
            const snapshot = yield* snapshotOrFail(api)
            const memo = memoFromSnapshot(snapshot)
            const treeMemo = treeMemoOf(memo)
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
        )),
    })
    editor.add({
      name: "split",
      description: SplitDescription,
      input: SplitInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: registered("split", SplitInput, (input, context, api) =>
        Effect.gen(function* () {
          const actor = actorFrom(context)
          const snapshot = yield* snapshotOrFail(api)
          const memo = memoFromSnapshot(snapshot)
          const treeMemo = treeMemoOf(memo)
          const node = findRow(memo, input.id, treeMemo)
          if (node === undefined) return yield* Effect.fail(unknownError(input.id, memo))
          const protectedAgent = protectedOf(snapshot, node)
          if (protectedAgent !== undefined) return yield* Effect.fail(protectedError(protectedAgent))
          const op = computeSplit(memo, input, treeMemo)
          if (typeof op === "string") return yield* Effect.fail(new Tool.Error({ message: op }))
          if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
          const applied = yield* mutateOp(api, memo, op, actor)
          return { output: { id: input.id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
        })),
    })
    editor.add({
      name: "create",
      description: CreateDescription,
      input: CreateInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: registered("create", CreateInput, (input, context, api) => {
        const rows = createRows(input)
        const single = rows.length === 1 && typeof input.id !== "object" && typeof input.agent !== "object"
        return eachStep(api, rows.map((row) => ({ id: createLabel(row), run: (api) => createRow(api, row, actorFrom(context)) })), {
          single, dryRun: input.dryRun, verbose: input.verbose,
        })
      }),
    })
    editor.add({
      name: "delete",
      description: DeleteDescription,
      input: DeleteInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: registered("delete", DeleteInput, (input, context, api) =>
        input.confirm !== true
          ? Effect.fail(new Tool.Error({ message: "delete.unconfirmed: delete requires confirm:true" }))
          : eachRow(api, input, (input, api) =>
              Effect.gen(function* () {
                const actor = actorFrom(context)
                const snapshot = yield* snapshotOrFail(api)
                const memo = memoFromSnapshot(snapshot)
                const folderId = folderIdOfInput(memo, input.id)
                if (folderId !== undefined) {
                  const owner = input.id.includes(":folder:") ? input.id.split(":folder:")[0] : snapshot.folders?.find((folder) => folder.id === folderId)?.owner
                  const from = owner === undefined ? undefined : tabLayout(treeMemoOf(memo), owner).inherited
                  const applied = yield* applyLayout(api, snapshot, planFolderDelete(layoutOf(snapshot), folderId, new Date().toISOString(), owner, from), actor)
                  return { output: { id: input.id, ...applied } }
                }
                const node = findRow(memo, input.id, treeMemoOf(memo))
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
            )),
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
    editor.add({
      name: "link",
      description: LinkDescription,
      input: LinkInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: registered("link", LinkInput, (input, context, api) => {
        const ids = typeof input.id === "string" ? [input.id] : [...new Set(input.id)]
        const targets = input.target === undefined ? [undefined] : typeof input.target === "string" ? [input.target] : [...new Set(input.target)]
        const pairs = ids.flatMap((id) => targets.map((target) => ({ id, target })))
        const fields = { ...(input.type === undefined ? {} : { type: input.type }), ...(input.enabled === undefined ? {} : { enabled: input.enabled }) }
        const single = pairs.length === 1 && typeof input.id === "string" && typeof input.target !== "object"
        // Without a target link only reads: several rows answer each row's links.
        if (input.target === undefined && !single)
          return Effect.forEach(ids, (id) => linkRow(api, { id }, actorFrom(context)).pipe(Effect.match({
            onSuccess: (done) => ({ id, output: done.output }),
            onFailure: (error) => ({ id, error: error.message }),
          }))).pipe(Effect.map((results) => ({ output: { total: results.length, failed: results.filter((result) => "error" in result).length, results } })))
        return eachStep(api, pairs.map((pair) => ({
          id: pair.target === undefined ? pair.id : `${pair.id} -> ${pair.target}`,
          run: (api) => linkRow(api, { id: pair.id, ...(pair.target === undefined ? {} : { target: pair.target }), ...fields }, actorFrom(context)),
        })), { single, dryRun: input.dryRun, verbose: input.verbose })
      }),
    })
    editor.add({
      name: "undo",
      description: UndoDescription,
      input: UndoInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: registered("undo", UndoInput, (input, context, api) =>
        Effect.gen(function* () {
          const result = yield* Effect.promise(() =>
            api.undo({ ...(input.ts === undefined ? {} : { ts: input.ts }), dryRun: input.dryRun === true, actor: actorFrom(context) }),
          )
          if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
          return { output: result.value }
        })),
    })
  })
}

// find's default columns: what agents asked for most.
const lineFields = ["id", "badges", "from"] as const

// One value of a line: "-" for nothing, arrays comma-joined, objects as JSON.
function cell(value: unknown): string {
  if (value === undefined || value === null || value === "") return "-"
  if (Array.isArray(value)) return value.length === 0 ? "-" : value.join(",")
  if (typeof value === "object") return JSON.stringify(value)
  return String(value)
}

// A child row of read's listing, in find's default columns. Groups add their
// on count ("3/7 on") and settings their value.
function childLine(node: TreeNode): string {
  const badges = [
    ...badgeLabels(node),
    ...(node.badges.summary === undefined ? [] : [`${node.badges.summary} on`]),
    ...(node.badges.value === undefined ? [] : [`= ${node.badges.value}`]),
  ]
  return [node.id, cell(badges.join(" ")), cell(node.badges.fromLabel)].join(" | ")
}

// `set { like }`: the on/off and the text (rows that hold one) the same row
// has for that agent, at the row's level first, then the most specific level
// it has, as fields for this row; only what differs. A member is
// "<team>/<member>".
function likeFields(
  memo: MemoInput,
  tree: Memo,
  node: TreeNode,
  input: { readonly id: string; readonly like?: string; readonly state?: unknown; readonly text?: unknown },
): { state?: "on" | "off"; text?: string } | { refusal: string } {
  const like = input.like!.trim()
  if (input.state !== undefined || input.text !== undefined) return { refusal: `like takes the state and text from ${like}; set state or text in another change` }
  const address = node.address
  const kind = input.id.split(":", 1)[0]
  const marker = address === undefined ? -1 : input.id.indexOf(`:${address.item}`, `${kind}:${address.level}:`.length)
  if (address === undefined || (kind !== "item" && kind !== "section") || marker === -1)
    return { refusal: `"${node.label}" is not a row another agent has (like works on tool, skill, rule, system, base and setting rows)` }
  const owner = like.includes("/") ? `${like.slice(0, like.indexOf("/"))}/:${like.slice(like.indexOf("/") + 1)}` : like
  const rest = input.id.slice(marker)
  const levels = [address.level, "project", "global", "defaults", "preset"].filter((level, index, all) => all.indexOf(level) === index)
  const source = levels.map((level) => `${kind}:${level}:${owner}${rest}`).map((id) => ({ id, row: findRow(memo, id, tree) })).find((entry) => entry.row !== undefined)
  if (source?.row === undefined) return { refusal: `${like} has no row like "${node.label}" (${kind}:<level>:${owner}${rest})` }
  const state = source.row.badges.state !== undefined && source.row.badges.state !== node.badges.state ? source.row.badges.state : undefined
  const theirs = holdsText(source.id, source.row) ? editableText(memo, source.id, tree) : undefined
  const mine = holdsText(input.id, node) ? editableText(memo, input.id, tree) : undefined
  const text = theirs !== undefined && !("refusal" in theirs) && mine !== undefined && !("refusal" in mine) && theirs.text !== mine.text ? theirs.text : undefined
  return { ...(state === undefined ? {} : { state }), ...(text === undefined ? {} : { text }) }
}

// Rows whose text set saves as an override; models and their fields,
// permission rules, teams, groups and folders change by field instead.
function holdsText(id: string, node: TreeNode): boolean {
  const item = node.address?.item
  if (item === undefined || node.kind === "team" || node.kind === "group") return false
  if (isModelRowId(id) || item.startsWith("model:") || isModelFieldRowId(id) || isModelSettingRowId(id) || isModelDefaultRowId(id)) return false
  return !isPermRowId(id) && !item.startsWith("perm:")
}

// A find filter as the terms the TUI and CLI type, each value quoted. A list,
// or a comma in a string value of a key that names things, is alternatives
// (`agent:"build","plan"`); in, state and text are taken whole.
function findWhere(filter: typeof FindFilter.Type): string {
  const quote = (value: string) => `"${value.replace(/[\\"]/g, "\\$&")}"`
  return [
    ...(["agent", "team", "level", "type", "name", "in", "state", "is", "text"] as const).flatMap((key) => {
      const value = filter[key]
      const whole = key === "in" || key === "state" || key === "text"
      const values = (value === undefined ? [] : typeof value === "string" ? (whole ? [value] : value.split(",")) : [...value])
        .map((entry) => (whole ? entry : entry.trim()))
        .filter((entry) => entry !== "")
      return values.length === 0 ? [] : [`${key}:${values.map(quote).join(",")}`]
    }),
    filter.where ?? "",
  ].join(" ")
}

// The rows one call acts on (the input names them with exactly one of id and
// find, oneSelection). A single id answers exactly as before. A list of ids,
// or the rows a find filter matches, runs the operation once per row in order
// against one in-memory store and writes once (eachStep); read answers one
// result per row.
function eachRow<Input extends { readonly id?: string | readonly string[]; readonly find?: typeof FindFilter.Type; readonly dryRun?: boolean; readonly verbose?: boolean }>(
  api: PlusApi,
  input: Input,
  one: (input: Omit<Input, "id" | "find" | "dryRun" | "verbose"> & { readonly id: string }, api: PlusApi) => Effect.Effect<{ output: unknown }, Tool.Error>,
  reads = false,
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const { id, find, dryRun, verbose, ...rest } = input
    if (typeof id === "string" && dryRun !== true) return yield* one({ ...rest, id }, api)
    const ids = typeof id === "string" ? [id] : find === undefined ? [...new Set(id ?? [])] : yield* foundRows(api, find)
    if (reads) {
      const results = yield* Effect.forEach(ids, (row) =>
        one({ ...rest, id: row }, api).pipe(
          Effect.match({
            onSuccess: (done) => ({ id: row, output: done.output }),
            onFailure: (error) => ({ id: row, error: error.message }),
          }),
        ),
      )
      return { output: { total: results.length, failed: results.filter((result) => "error" in result).length, results } }
    }
    return yield* eachStep(api, ids.map((row) => ({ id: row, run: (api) => one({ ...rest, id: row }, api) })), {
      single: typeof id === "string", dryRun, verbose,
    })
  })
}

interface Step {
  readonly id: string
  readonly run: (api: PlusApi) => Effect.Effect<{ output: unknown }, Tool.Error>
}

// What a call with several rows answers: one status line with the counts, the
// rows it changed and every row it did not change with the reason; each row's
// own answer only with verbose.
interface Many {
  readonly status: string
  readonly changed: readonly string[]
  readonly already: number
  readonly notDone: readonly { readonly id: string; readonly reason: string }[]
  readonly dryRun?: true
  readonly revision?: number
  readonly globalRevision?: number
  readonly results?: readonly unknown[]
}

function isMany(value: unknown): value is Many {
  return typeof value === "object" && value !== null && Array.isArray((value as Many).changed) && Array.isArray((value as Many).notDone) && typeof (value as Many).already === "number"
}

// Run steps in order against one staged store (staged.ts) and write once. A
// step that refuses does not stop the rest; a write that refuses names every
// row it carried. A single step that is not a dry run answers as itself.
function eachStep(
  api: PlusApi,
  steps: readonly Step[],
  options: { readonly single: boolean; readonly dryRun?: boolean; readonly verbose?: boolean },
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const dryRun = options.dryRun === true
    if (options.single && steps.length === 1 && !dryRun) return yield* steps[0]!.run(api)
    const counts = { changed: 0 }
    const staged = stagedApi(api, { dryRun, status: () => `${counts.changed} change${counts.changed === 1 ? "" : "s"}: ${steps.map((step) => step.id).join(", ")}` })
    const done: { id: string; output?: unknown; error?: string; changed: boolean }[] = []
    for (const step of steps) {
      const before = staged.changes()
      const outcome = yield* step.run(staged.api).pipe(
        Effect.match({
          onSuccess: (result): { id: string; output?: unknown; error?: string } => ({ id: step.id, output: result.output }),
          onFailure: (error): { id: string; output?: unknown; error?: string } => ({ id: step.id, error: error.message }),
        }),
      )
      const changed = outcome.error === undefined && staged.changes() > before
      if (changed) counts.changed++
      if (outcome.error === undefined) staged.settle(step.id)
      done.push({ ...outcome, changed })
    }
    const written = yield* Effect.promise(() => staged.commit())
    if (options.single && steps.length === 1) {
      const only = done[0]!
      if (only.error !== undefined) return yield* Effect.fail(new Tool.Error({ message: only.error }))
      const output = only.output as { readonly status?: unknown }
      return { output: { ...(typeof output === "object" && output !== null ? output : { output }), dryRun: true, status: `Dry run, nothing written: ${typeof output?.status === "string" ? output.status : only.changed ? "it would change" : "nothing to change"}` } }
    }
    const refused = new Map(staged.refused().map((entry) => [entry.id, entry.reason]))
    const nested = done.flatMap((entry) => (isMany(entry.output) ? [entry.output] : []))
    // A row created and then set by a later change is one changed row.
    const changed = [...new Set([
      ...done.filter((entry) => entry.changed && !isMany(entry.output) && !refused.has(entry.id)).map((entry) => createdIdOf(entry.output) ?? entry.id),
      ...nested.flatMap((many) => many.changed),
    ])]
    const notDone = [
      ...done.flatMap((entry) => (entry.error === undefined ? [] : [{ id: entry.id, reason: entry.error }])),
      ...staged.refused(),
      ...nested.flatMap((many) => many.notDone),
    ]
    const already = done.filter((entry) => entry.error === undefined && !entry.changed && !isMany(entry.output)).length + nested.reduce((sum, many) => sum + many.already, 0)
    // Files, teams and links are written as their op runs, besides the one record write.
    const writes = staged.writes()
    const wrote = !dryRun && writes > 0
    const counted = `${changed.length} ${dryRun ? "would change" : "changed"}, ${already} already so, ${notDone.length} not done`
    const how = writes === 1 ? "written once" : `written in ${writes} writes`
    const many: Many = {
      status: `${dryRun ? "Dry run, nothing written: " : ""}${counted}${wrote ? ` (${how}${written.revision === undefined ? "" : `: revision ${written.revision}, global ${written.globalRevision}`})` : ""}`,
      changed,
      already,
      notDone,
      ...(dryRun ? { dryRun: true as const } : {}),
      ...(written.revision === undefined ? {} : { revision: written.revision, globalRevision: written.globalRevision }),
      ...(options.verbose === true ? { results: done.map((entry) => (entry.error === undefined ? { id: entry.id, output: entry.output } : { id: entry.id, error: entry.error })) } : {}),
    }
    return { output: many }
  })
}

// The row a create answered with, so a list of creates names what it made.
function createdIdOf(output: unknown): string | undefined {
  if (typeof output !== "object" || output === null || !("item" in output)) return undefined
  const id = (output as { readonly id?: unknown }).id
  return typeof id === "string" ? id : undefined
}

// The rows a find filter selects: every row find lists (all pages), with each
// agent's copy rather than one row standing for them, and the shared Defaults
// rows first, so an agent's copy changed after its shared row inherits the
// change instead of storing its own.
function foundRows(api: PlusApi, filter: typeof FindFilter.Type): Effect.Effect<string[], Tool.Error> {
  return Effect.gen(function* () {
    const memo = memoFromSnapshot(yield* snapshotOrFail(api))
    const where = findWhere(filter)
    const queried = yield* Effect.try({
      try: () => query(memo, { where, fields: ["id"], withoutAliases: true, collapse: { ...findCollapse(where), copies: false } }, treeMemoOf(memo)),
      catch: (error) => new Tool.Error({ message: error instanceof Error ? error.message : String(error) }),
    })
    if (queried.total > maxRows)
      return yield* Effect.fail(
        new Tool.Error({ message: `find matches ${queried.total} rows; one call takes at most ${maxRows}: narrow it (agent, type, name, where) or pass ids` }),
      )
    const treeMemo = treeMemoOf(memo)
    const shared = (id: string) => findRow(memo, id, treeMemo)?.address?.agent === null
    return queried.rows.map((row) => row.id).toSorted((left, right) => Number(!shared(left)) - Number(!shared(right)))
  })
}

function snapshotOrFail(api: PlusApi): Effect.Effect<Plus.Snapshot, Tool.Error> {
  return Effect.gen(function* () {
    const result = yield* Effect.promise(() => api.snapshot())
    return result.value
  })
}

function creationFields(memo: Memo, row: TreeNode, input: Record<string, unknown>): Record<string, unknown> {
  if (input.kind === "folder") return { ...input, id: row.id }
  const path = lazyPath(memo, row.id)
  const owner = row.address ?? path.findLast((entry) => entry.owner !== undefined)?.owner
  const level = owner?.level ?? path.find((entry) => entry.kind === "root")?.id.slice("root:".length)
  if (input.kind === "model" || input.kind === "rule") {
    if (owner === undefined) return { refusal: `"${row.label}" does not identify an owner` }
    const fields = {
      ...Object.fromEntries(Object.entries(input).filter(([key]) => !["level", "scope", "agent", "team", "catalogue"].includes(key))),
      level: owner.level, agent: owner.agent ?? "_",
      ...(owner.catalogue === undefined ? {} : { catalogue: owner.catalogue }),
      ...(owner.team === undefined ? {} : { team: owner.team.team }),
    }
    if (input.kind === "model") return fields
    const item = memo.ctx.items.find((item) => item.id === row.address?.item)
    const tool = item?.paramTool ?? item?.permTool ?? (row.address?.item.startsWith("tool:") ? row.address.item.slice("tool:".length) : undefined)
    return tool === undefined ? { refusal: `"${row.label}" does not identify a rule's tool` } : { ...fields, tool }
  }
  if (input.kind === "member" || input.kind === "presetMember") {
    const team = path.findLast((entry) => entry.owner?.team !== undefined)?.owner?.team?.team
    if (team === undefined) return { refusal: `"${row.label}" does not identify a team` }
    return { ...input, level, team }
  }
  if (input.kind === "agent" || input.kind === "team" || input.kind === "skill") return { ...input, scope: level, level }
  return input
}

function actorFrom(context: Tool.Context): Plus.Actor {
  const human = interactiveActor()
  if (human !== undefined) return human
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
    return findRow(memo, rowId, treeMemoOf(memo)) === undefined ? [] : [{ team: team.team, rowId }]
  })
}

function isOwnerLevel(value: string | undefined): value is "project" | "global" | "defaults" {
  return value === "project" || value === "global" || value === "defaults"
}

// The folder a delete id names: `folder:<id>` or a folder row's id.
function folderIdOfInput(memo: MemoInput, id: string): string | undefined {
  if (id.startsWith("folder:")) return id.slice("folder:".length)
  const node = findRow(memo, id, treeMemoOf(memo))
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
        expectedProjectRevision: snapshot.revision,
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

// api.snapshot() answers the same object until the store or host changes, so
// its memo input and tree memo are built once per snapshot.
const memoInputs = new WeakMap<Plus.Snapshot, MemoInput>()

function memoFromSnapshot(snapshot: Plus.Snapshot): MemoInput {
  const known = memoInputs.get(snapshot)
  if (known !== undefined) return known
  const memo = memoInputOf(snapshot)
  const input: MemoInput = {
    ...memo,
    records: memo.records.map((record, index) => {
      const snap = snapshot.records[index]
      if (snap?.team !== undefined) {
        return { ...record, team: snap.team }
      }
      return record
    }),
  }
  memoInputs.set(snapshot, input)
  return input
}

const treeMemos = new WeakMap<MemoInput, Memo>()

function treeMemoOf(memo: MemoInput): Memo {
  const known = treeMemos.get(memo)
  if (known !== undefined) return known
  const tree = buildTreeMemo(memo)
  treeMemos.set(memo, tree)
  return tree
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
    if (agent !== "" && protectedForActor(snapshot, agent)) return agent
    return undefined
  }
  const owner = node.address?.agent ?? node.owner?.agent
  if (owner !== undefined && owner !== null && protectedForActor(snapshot, owner)) return owner
  return undefined
}

function protectedForActor(snapshot: Plus.Snapshot, agent: string | null): boolean {
  return interactiveActor() === undefined && agent !== null && snapshot.protectedAgents.includes(agent)
}

// `set {id, rename}`: rename an agent, on-disk team member or Project/Global
// team. The API owns the refusals (built-ins, shipped Defaults rows,
// ancestor-backed agents, protected agents for a tool actor); this wrapper
// only routes the row to the right method.
// A model prompt's patterns live with its file, not in a level's records: one
// list for every agent and level, set on its own.
function setModels(
  api: PlusApi,
  node: TreeNode,
  input: { readonly id: string; readonly models?: readonly string[]; readonly [field: string]: unknown },
  actor: Plus.Actor,
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const item = node.address?.section === null ? node.address.item : undefined
    if (item === undefined || !isModelPrompt(item))
      return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" is not a model prompt; models is set on System › Model prompts rows` }))
    const others = Object.keys(input).filter((key) => key !== "id" && key !== "models" && input[key] !== undefined)
    if (others.length > 0) return yield* Effect.fail(new Tool.Error({ message: `models is set on its own; send ${others.join(", ")} in another call` }))
    const result = yield* Effect.promise(() => api.setSystemModels({ id: item.slice("system:".length), models: input.models ?? [], actor }))
    if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
    const snapshot = yield* snapshotOrFail(api)
    const models = snapshot.items.find((entry) => entry.id === item)?.models ?? []
    return { output: { id: input.id, models, status: `"${node.label}" is sent for ${models.join(", ")}` } }
  })
}

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

function moveRow(
  api: PlusApi,
  id: string,
  placement: { readonly into?: string; readonly before?: string; readonly after?: string },
  actor: Plus.Actor,
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const snapshot = yield* snapshotOrFail(api)
    const memo = memoFromSnapshot(snapshot)
    const node = findRow(memo, id, treeMemoOf(memo))
    if (node === undefined) return yield* Effect.fail(unknownError(id, memo))
    const protectedAgent = protectedOf(snapshot, node)
    if (protectedAgent !== undefined) return yield* Effect.fail(protectedError(protectedAgent))
    if (node.kind === "section") {
      const op = planSectionMove(memo, id, placement, new Date().toISOString())
      if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
      const applied = yield* mutateOp(api, memo, op, actor)
      return { output: { id, target: id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
    }
    const change = planRowMove(memo, layoutOf(snapshot), id, placement, new Date().toISOString())
    const applied = yield* applyLayout(api, snapshot, change, actor)
    return { output: { id, ...applied } }
  })
}

// `link {id, target?, type?, enabled?}`: inspect a row's links, or upsert the
// link whose primary is `id`. Both ends must resolve in one owner/level view
// (B11); every refusal happens before the write, so a refused call leaves the
// records and the change log untouched.
function linkRow(
  api: PlusApi,
  input: { id: string; target?: string; type?: RowlinkType; enabled?: boolean },
  actor: Plus.Actor,
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const snapshot = yield* snapshotOrFail(api)
    const memo = memoFromSnapshot(snapshot)
    const node = findRow(memo, input.id, treeMemoOf(memo))
    if (node === undefined) return yield* Effect.fail(unknownError(input.id, memo))
    const address = node.address
    if (address === undefined || address.item === undefined)
      return yield* Effect.fail(new Tool.Error({ message: `link.invalid: "${node.label}" is not a row a link can address` }))
    const primary: RowlinkEndpoint = { item: address.item, section: address.section }
    const scopes = contextOfSnapshot(snapshot)
    if (input.target === undefined) {
      // The shipped `<!-- requires -->` marker on the endpoint's own text is an
      // effective incoming link too (B43); report it with its "text"
      // provenance alongside the stored links.
      const customizations = memo.records.filter((record): record is CustomizationRecord => record.type === "customization")
      const splits = memo.records.filter((record): record is SplitRecord => record.type === "split")
      const upstream = upstreamOf(memo, address)
      const marker = upstream === undefined ? [] : (markerIn(resolve({ upstream, records: customizations, splits, scopes, address }).text) ?? [])
      return {
        output: {
          id: input.id,
          item: address.item,
          section: address.section,
          links: rowlinkView(rowlinksOf(memo), scopes, address, primary, marker),
        },
      }
    }
    const targetNode = findRow(memo, input.target, treeMemoOf(memo))
    if (targetNode === undefined) return yield* Effect.fail(unknownError(input.target, memo))
    const targetAddress = targetNode.address
    if (targetAddress === undefined || targetAddress.item === undefined)
      return yield* Effect.fail(new Tool.Error({ message: `link.invalid: "${targetNode.label}" is not a row a link can address` }))
    if (!sameOwnerView(address, targetAddress))
      return yield* Effect.fail(
        new Tool.Error({ message: `link.invalid: "${node.label}" and "${targetNode.label}" are not in the same level and owner` }),
      )
    if (sameEndpoint(primary, targetAddress.item, targetAddress.section))
      return yield* Effect.fail(new Tool.Error({ message: `link.invalid: "${node.label}" cannot link to itself` }))
    const protectedPrimary = protectedOf(snapshot, node)
    if (protectedPrimary !== undefined) return yield* Effect.fail(protectedError(protectedPrimary))
    const protectedTarget = protectedOf(snapshot, targetNode)
    if (protectedTarget !== undefined) return yield* Effect.fail(protectedError(protectedTarget))
    const type = input.type ?? "either"
    // A gate's primary is a condition row; a section is not a row the gate can
    // read (its on/off is not one answer), so refuse rather than silently use
    // the whole item's state.
    if (type !== "either" && primary.section !== null)
      return yield* Effect.fail(
        new Tool.Error({ message: `link.invalid: a "${type}" gate cannot have a section as its condition; condition the whole row` }),
      )
    const next = writeRowlink(
      rowlinksOf(memo),
      address,
      primary,
      { item: targetAddress.item, section: targetAddress.section },
      type,
      input.enabled,
      new Date().toISOString(),
    )
    const withoutRowlinks = memo.records.filter((record) => record.type !== "rowlink")
    const status =
      input.enabled === false
        ? `Disabled the ${type} link between "${node.label}" and "${targetNode.label}" at this level`
        : `Linked "${node.label}" to "${targetNode.label}" (${type})`
    const applied = yield* mutateDelta(api, memo, [...withoutRowlinks, ...next], actor, status)
    return { output: { id: input.id, target: input.target, type, enabled: input.enabled !== false, ...applied } }
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
  // Refuses a write-time switch onto a protected owner's row before any record
  // changes (B9). Supplied by the tool actor; absent leaves switches unguarded.
  isProtected?: (owner: string | null) => boolean,
): ReturnType<typeof setRequires> {
  const preserved = modelsOfMemo(memo)
  const preservedRules = rulesOfMemo(memo)
  const withModels = (records: readonly CustomizationRecord[], splits: readonly SplitRecord[], models: readonly ModelRecord[] = preserved): MemoInput => ({
    ...memo,
    records: [...records, ...splits, ...models, ...preservedRules, ...rowlinksOf(memo)],
  })
  // The condition is its own field: set it, then whatever else came with it.
  if (input.requires !== undefined) {
    const first = setRequires(memo, input.id, input.requires, sharedMemo)
    const rest = { ...input, requires: undefined }
    const more = rest.mode !== undefined || rest.text !== undefined || rest.state !== undefined || rest.pin !== undefined || rest.resolve !== undefined
    if ("refusal" in first || !more) return first
    const stepped = computeSet({ ...withModels(first.records, first.splits), rowlinks: first.rowlinks }, rest, undefined, isProtected)
    return "refusal" in stepped || first.rowlinks === undefined ? stepped : { ...stepped, rowlinks: first.rowlinks }
  }
  if (input.mode !== undefined) {
    const first = setAgentMode(memo, input.id, input.mode, sharedMemo)
    if ("refusal" in first || (input.state === undefined && input.text === undefined && input.pin === undefined && input.resolve === undefined)) return first
    return computeSet(withModels(first.records, first.splits), { ...input, mode: undefined }, undefined, isProtected)
  }
  if (input.resolve !== undefined) {
    if (input.pin === undefined && input.state === undefined) return resolveReview(memo, input.id, input.resolve, input.text, undefined, sharedMemo)
    const first = resolveReview(memo, input.id, input.resolve, input.text, undefined, sharedMemo)
    if ("refusal" in first) return first
    let interim: MemoInput = withModels(first.records, first.splits)
    if (input.state !== undefined) {
      const second = setEnabled(interim, input.id, input.state === "on", undefined, isProtected)
      if ("refusal" in second) return second
      interim = withModels(second.records, second.splits, second.models)
      if (input.pin === undefined) return second
    }
    if (input.pin !== undefined) {
      const pinned = setPin(interim, input.id, input.pin)
      return "refusal" in pinned ? pinned : { ...pinned, models: modelsOfMemo(interim) }
    }
    return first
  }
  if (input.text !== undefined && input.state !== undefined && input.pin !== undefined) {
    const first = saveText(memo, input.id, input.text, sharedMemo)
    if ("refusal" in first) return first
    const interim: MemoInput = withModels(first.records, first.splits)
    const second = setEnabled(interim, input.id, input.state === "on", undefined, isProtected)
    if ("refusal" in second) return second
    const interim2: MemoInput = withModels(second.records, second.splits, second.models)
    const pinned = setPin(interim2, input.id, input.pin)
    return "refusal" in pinned ? pinned : { ...pinned, models: modelsOfMemo(interim2) }
  }
  if (input.text !== undefined && input.state !== undefined) {
    const first = saveText(memo, input.id, input.text, sharedMemo)
    if ("refusal" in first) return first
    const interim: MemoInput = withModels(first.records, first.splits)
    return setEnabled(interim, input.id, input.state === "on", undefined, isProtected)
  }
  if (input.text !== undefined && input.pin !== undefined) {
    const first = saveText(memo, input.id, input.text, sharedMemo)
    if ("refusal" in first) return first
    const interim: MemoInput = withModels(first.records, first.splits)
    return setPin(interim, input.id, input.pin)
  }
  if (input.state !== undefined && input.pin !== undefined) {
    const first = setEnabled(memo, input.id, input.state === "on", sharedMemo, isProtected)
    if ("refusal" in first) return first
    const interim: MemoInput = withModels(first.records, first.splits, first.models)
    const pinned = setPin(interim, input.id, input.pin)
    return "refusal" in pinned ? pinned : { ...pinned, models: modelsOfMemo(interim) }
  }
  if (input.text !== undefined) return saveText(memo, input.id, input.text, sharedMemo)
  if (input.state !== undefined) return setEnabled(memo, input.id, input.state === "on", sharedMemo, isProtected)
  if (input.pin !== undefined) return setPin(memo, input.id, input.pin, sharedMemo)
  return toggle(memo, input.id, sharedMemo, isProtected)
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
    // Both sides as stored: an edit equal to what its row inherits is not
    // written, and one already stored is not removed for a row this op did
    // not touch (a tool may not change a protected agent's rows).
    const delta = deltaOf(storedRecords(before, before.records), storedRecords(before, next))
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
  op: { records: CustomizationRecord[]; splits: SplitRecord[]; models?: readonly ModelRecord[]; rowlinks?: readonly RowlinkRecord[]; status: string },
  actor: Plus.Actor,
): Effect.Effect<{ revision: number; globalRevision: number; status: string }, Tool.Error> {
  const models = op.models ?? modelsOfMemo(memo)
  const rowlinks = op.rowlinks ?? rowlinksOf(memo)
  return mutateDelta(
    api,
    memo,
    [...op.records, ...op.splits, ...models, ...rulesOfMemo(memo), ...rowlinks],
    actor,
    op.status,
  )
}

// A model op: customizations, splits and rules pass through unchanged; the
// op's `models` is the complete new model list, so it replaces the memo's.
function mutateModels(
  api: PlusApi,
  memo: MemoInput,
  models: readonly ModelRecord[],
  status: string,
  actor: Plus.Actor,
  records?: readonly CustomizationRecord[],
): Effect.Effect<{ revision: number; globalRevision: number; status: string }, Tool.Error> {
  const rest = memo.records.filter((record) => record.type !== "model" && (records === undefined || record.type !== "customization"))
  return mutateDelta(api, memo, [...rest, ...(records ?? []), ...models], actor, status)
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
    waiting?: string
    subagent?: string
    prompt?: string
    effort?: string
    compactWarm?: string | null
    coldFirst?: string | null
    coldCompact?: string | null
    coldModels?: string | readonly string[] | null
    compactionStrategy?: string | null
    compactionModel?: string | null
    compactionInstructions?: string | null
    imageConvert?: string | null
    imageShrink?: string | null
    imagesFull?: string | null
    compactionInput?: string | null
    compactionOutput?: string | null
  },
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const node = findRow(memo, id, treeMemoOf(memo))
    const label = node?.label ?? id
    if (input.active === false) return yield* Effect.fail(new Tool.Error({ message: `"${label}" cannot be deactivated with active:false; remove the candidate to mask it` }))
    if ((input.active !== undefined || input.state !== undefined) &&
      (input.text !== undefined || input.warming !== undefined || input.interval !== undefined || input.waiting !== undefined || input.subagent !== undefined || input.prompt !== undefined))
      return yield* Effect.fail(new Tool.Error({ message: `"${label}": set candidate or warming separately from activation or state` }))
    const compaction = compactionFieldsOf(input)
    if ("error" in compaction) return yield* Effect.fail(new Tool.Error({ message: compaction.error }))
    // Compose candidate/warming and C1 changes in memory, then persist once.
    // A bad warming edit must not leave an otherwise valid C1 update behind.
    if (Object.keys(compaction.fields).length > 0) {
      if (input.active !== undefined || input.state !== undefined || input.pin !== undefined || input.resolve !== undefined)
        return yield* Effect.fail(new Tool.Error({ message: `"${label}": set compaction separately from activation, state, pin or review` }))
      const target = input.text === undefined ? modelTargetOfAddress(node) : parseModelText(input.text)
      if (target === undefined || node?.address === undefined)
        return yield* Effect.fail(new Tool.Error({ message: `"${label}" takes provider/model or provider/model#variant` }))
      const edit = input.text !== undefined || input.warming !== undefined || input.interval !== undefined || input.waiting !== undefined || input.subagent !== undefined || input.prompt !== undefined
        ? editModelRow(memo, id, { ...target, ...(input.warming === undefined ? {} : { warming: input.warming }), ...(input.interval === undefined ? {} : { interval: input.interval }), ...(input.waiting === undefined ? {} : { waiting: input.waiting }), ...(input.subagent === undefined ? {} : { subagent: input.subagent }), ...(input.prompt === undefined ? {} : { prompt: input.prompt }) })
        : undefined
      if (edit !== undefined && "refusal" in edit) return yield* Effect.fail(new Tool.Error({ message: edit.refusal }))
      const models = setModelCompaction(edit?.models ?? modelsOfMemo(memo), node.address, target, compaction.fields, new Date().toISOString())
      const applied = yield* mutateModels(api, memo, models, `Updated "${label}"`, actor, edit?.records)
      return { output: { id, ...applied } }
    }
    // Cache warming for this agent on this model at this level; "" inherits.
    if (input.warming !== undefined && input.text === undefined && input.interval === undefined && input.waiting === undefined && input.subagent === undefined && input.prompt === undefined) {
      const warming = input.warming
      const op = setModelWarmingRow(memo, id, warming)
      if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
      const applied = yield* mutateModels(api, memo, op.models, op.status, actor)
      return { output: { id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
    }
    // A model row's text replaces the candidate (and may set warming in the
    // same save), the tool-side equivalent of the TUI's enter edit dialog.
    // Interval, prompt or warming alone keep the row's candidate.
    if (input.text !== undefined || input.interval !== undefined || input.waiting !== undefined || input.subagent !== undefined || input.prompt !== undefined || input.warming !== undefined) {
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
        ...(input.waiting === undefined ? {} : { waiting: input.waiting }),
        ...(input.subagent === undefined ? {} : { subagent: input.subagent }),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      }
      const op = editModelRow(memo, id, fields, undefined, (owner) => protectedForActor(snapshot, owner))
      if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
      const applied = yield* mutateModels(api, memo, op.models, op.status, actor, op.records)
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
    if (input.state === "off") return yield* Effect.fail(new Tool.Error({ message: `"${label}" cannot be toggled off by state; remove the candidate to mask it` }))
    const op = activateModelRow(memo, id, undefined, (owner) => protectedForActor(snapshot, owner))
    if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
    const applied = yield* mutateOp(api, memo, { records: op.records ?? memo.records.filter((record): record is CustomizationRecord => record.type === "customization"), splits: memo.records.filter((record): record is SplitRecord => record.type === "split"), models: op.models, status: op.status }, actor)
    return { output: { id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
  })
}

// One field row under an agent/member/preset model row edits that field alone
// at the row's level, mirroring a Defaults › Models field row. Model replaces
// the candidate (keeping the variant unless the text names one); Effort
// replaces the variant; Warming / Ping every / Warm while waiting / Warm as subagent / Keep-alive prompt set or clear
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
    const node = findRow(memo, id, treeMemoOf(memo))
    if (node === undefined) return yield* Effect.fail(unknownError(id))
    if (input.text === undefined)
      return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" takes text: its value, or "" to inherit` }))
    const text = input.text
    const op = setModelFieldRow(memo, id, text)
    if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
    const applied = yield* mutateModels(api, memo, op.models, op.status, actor, op.records)
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
    const node = findRow(memo, id, treeMemoOf(memo))
    if (node === undefined) return yield* Effect.fail(unknownError(id))
    const op = resetModelFieldRow(memo, id)
    if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
    const applied = yield* mutateModels(api, memo, op.models, op.status, actor)
    return { output: { id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
  })
}

// Defaults › Models rows (model-settings.ts) edit through modelSettings.set, not
// the inventory mutate: they are server-owned rows like teams. A string sets a
// field, "" clears it (except compactionInstructions), absent leaves it;
// `state` sets the warming switch. C1 null clears; [] sets an empty cold list.
function setModelDefaults(
  api: PlusApi,
  node: TreeNode,
  actor: Plus.Actor,
  input: {
    state?: "on" | "off"
    warming?: string
    interval?: string
    waiting?: string
    subagent?: string
    prompt?: string
    effort?: string
    compactWarm?: string | null
    coldFirst?: string | null
    coldCompact?: string | null
    coldModels?: string | readonly string[] | null
    compactionStrategy?: string | null
    compactionModel?: string | null
    compactionInstructions?: string | null
    imageConvert?: string | null
    imageShrink?: string | null
    imagesFull?: string | null
    compactionInput?: string | null
    compactionOutput?: string | null
    text?: string
    pin?: boolean
    active?: boolean
    resolve?: "keep" | "take" | "edit" | "merge"
    mode?: "primary" | "subagent" | "all"
  },
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    if (input.text !== undefined) return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" takes warming, interval, waiting, subagent, prompt or effort, not text` }))
    if (input.pin !== undefined) return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" cannot be pinned` }))
    if (input.active !== undefined) return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" is not a model row` }))
    if (input.resolve !== undefined) return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" has no review to resolve` }))
    if (input.mode !== undefined) return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" has no mode` }))
    if (
      input.warming === undefined &&
      input.interval === undefined &&
      input.waiting === undefined &&
      input.subagent === undefined &&
      input.prompt === undefined &&
      input.effort === undefined &&
      input.compactWarm === undefined &&
      input.coldFirst === undefined &&
      input.coldCompact === undefined &&
      input.coldModels === undefined &&
      input.compactionStrategy === undefined &&
      input.compactionModel === undefined &&
      input.compactionInstructions === undefined &&
      input.imageConvert === undefined &&
      input.imageShrink === undefined &&
      input.imagesFull === undefined &&
      input.compactionInput === undefined &&
      input.compactionOutput === undefined &&
      input.state === undefined
    )
      return yield* Effect.fail(new Tool.Error({ message: `"${node.label}" needs warming, interval, waiting, subagent, prompt or effort to set` }))
    const key = defaultsKeyOf(node)
    if (key === undefined) return yield* Effect.fail(unknownError(node.id))
    const compaction = compactionFieldsOf(input)
    if ("error" in compaction) return yield* Effect.fail(new Tool.Error({ message: compaction.error }))
    const result = yield* Effect.promise(() =>
      api.setModelSettings({
        ...key,
        ...(input.state === undefined ? {} : { warming: input.state }),
        ...(input.warming === undefined ? {} : { warming: input.warming }),
        ...(input.interval === undefined ? {} : { interval: input.interval }),
        ...(input.waiting === undefined ? {} : { waiting: input.waiting }),
        ...(input.subagent === undefined ? {} : { subagent: input.subagent }),
        ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
        ...(input.effort === undefined ? {} : { effort: input.effort }),
        ...compaction.fields,
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
    ...(record.waiting === undefined ? [] : [`waiting ${record.waiting}`]),
    ...(record.subagent === undefined ? [] : [`subagent ${record.subagent}`]),
    ...(record.prompt === undefined ? [] : ["a prompt"]),
    ...(record.effort === undefined ? [] : [`effort ${record.effort}`]),
    ...MODEL_COMPACTION_FIELDS.flatMap((field) => {
      const value = record[field]
      if (value === undefined) return []
      if (field === "compactionInstructions") return ["compaction instructions"]
      return [`${field} ${Array.isArray(value) ? value.join(", ") || "none" : value}`]
    }),
  ]
  return `Defaults › Models "${label}": ${set.join(", ")}`
}

// A Defaults › Models compaction or image field's effective value, as the tree resolves it: this
// model's record, then Every model (`every`, absent on the Every model row itself), then built-in.
function defaultFieldValue(field: string, record: Plus.SnapshotModelSettingsRecord | undefined, every: Plus.SnapshotModelSettingsRecord | undefined): unknown {
  const sources = { ...(record === undefined ? {} : { model: record }), ...(every === undefined ? {} : { every }) }
  if ((IMAGE_FIELDS as readonly string[]).includes(field)) return effectiveImages(sources)[field as ImageField].value
  const compaction = effectiveCompaction(sources)
  const value =
    field === "compactionStrategy"
      ? compaction.strategy.value
      : field === "compactionModel"
        ? compaction.model.value
        : field === "compactionInstructions"
          ? compaction.instructions.value
          : field === "compactionInput" || field === "compactionOutput" || field === "compactWarm" || field === "coldFirst" || field === "coldModels"
            ? compaction[field].value
            : undefined
  return value ?? null
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
    const node = findRow(memo, id, treeMemoOf(memo))
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
      const op = computeSet(memo, { id, text }, treeMemo, (agent) => protectedForActor(snapshot, agent))
      if ("refusal" in op) return yield* Effect.fail(new Tool.Error({ message: op.refusal }))
      const applied = yield* mutateOp(api, memo, op, actor)
      return { output: { id, status: applied.status, revision: applied.revision, globalRevision: applied.globalRevision } }
    }
    if (input.resolve !== undefined) return yield* Effect.fail(new Tool.Error({ message: resolveRefusalForLabel(label) }))
    if (input.pin !== undefined) return yield* Effect.fail(new Tool.Error({ message: `"${label}" cannot be pinned` }))
    if (input.active !== undefined) return yield* Effect.fail(new Tool.Error({ message: `"${label}" cannot be activated` }))
    const op = computeSet(memo, { id, ...(input.state === undefined ? {} : { state: input.state }) }, treeMemo, (agent) => protectedForActor(snapshot, agent))
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
    const found = findRow(memo, id, treeMemoOf(memo))
    const address = found?.address
    if (address === undefined) return yield* Effect.fail(unknownError(id))
    const parsed = parsePermItemId(address.item)
    if (parsed === undefined) return yield* Effect.fail(unknownError(id))
    const existing = ownRule(rulesOfMemo(memo), address)
    if (existing === undefined) return yield* Effect.fail(new Tool.Error({ message: `"${found?.label ?? id}" cannot be deleted: only user-created rules owned by this row can be deleted` }))
    if (existing.agent !== null && protectedForActor(snapshot, existing.agent))
      return yield* Effect.fail(protectedError(existing.agent))
    const result = yield* Effect.promise(() =>
      api.removeRule({ level: existing.level, agent: existing.agent, ...catalogueField(existing), ...(existing.team === undefined ? {} : { team: existing.team }), tool: parsed.tool, id: parsed.ruleId, actor }),
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
    const found = findRow(memo, id, treeMemoOf(memo))
    const address = found?.address
    if (address === undefined) return yield* Effect.fail(unknownError(id))
    const parsed = parsePermItemId(address.item)
    if (parsed === undefined) return yield* Effect.fail(unknownError(id))
    const existing = ruleAt(rulesOfMemo(memo), contextOfSnapshot(snapshot), address)
    if (address.agent !== null && protectedForActor(snapshot, address.agent))
      return yield* Effect.fail(protectedError(address.agent))
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
        // this curated or catalog row) materialises: a Teams-catalogue row must
        // create a Teams rule, not an Agents one. A matched record keeps its
        // stored catalogue server-side, so this only matters for a new one.
        ...(address.catalogue === undefined ? {} : { catalogue: address.catalogue }),
        ...(address.team === undefined ? {} : { team: address.team }),
        tool: parsed.tool,
        id: parsed.ruleId,
        label,
        patterns: [...patterns],
        keywords: [...(input.keywords ?? existing?.keywords ?? upstream?.keywords ?? [])],
        message: input.message ?? existing?.message ?? upstream?.message ?? "",
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
    const node = findRow(memo, id, treeMemoOf(memo))
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
    const node = findRow(memo, id, treeMemoOf(memo))
    const label = node?.label ?? id
    if (input.text !== undefined) return yield* Effect.fail(new Tool.Error({ message: editRefusalForLabel(label) }))
    if (input.pin !== undefined) return yield* Effect.fail(new Tool.Error({ message: `"${label}" is not a Code Mode tool and cannot be pinned` }))
    if (input.resolve !== undefined) return yield* Effect.fail(new Tool.Error({ message: resolveRefusalForLabel(label) }))
    if (input.mode !== undefined || input.requires !== undefined)
      return yield* Effect.fail(new Tool.Error({ message: `"${label}" is a group: only state on|off applies` }))
    const target = input.state === undefined ? undefined : input.state === "on"
    const isProtected = (agent: string) => protectedForActor(snapshot, agent)
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
    const treeMemo = treeMemoOf(memo)
    const node = findRow(memo, id, treeMemo)
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
        key,
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
                  : defaultFieldValue(setting.field, record, key.providerID === undefined ? undefined : everySettings(memo.modelSettings ?? [])),
              }),
          summary: modelDefaultValue(resolved),
          warming: { on: resolved.on.value, from: resolved.on.from, ...(resolved.on.value ? { duration: resolved.duration.value } : {}) },
          interval: { value: resolved.interval.value, from: resolved.interval.from },
          waiting: { value: resolved.waiting.value, from: resolved.waiting.from },
          subagent: {
            value: resolved.subagent.value,
            from: resolved.subagent.from,
            ...(resolved.subagent.value ? { duration: resolved.subagentDuration.value } : {}),
          },
          prompt: { value: resolved.prompt.value, from: resolved.prompt.from },
          ...(resolved.effort === undefined ? {} : { effort: { value: resolved.effort.value, from: resolved.effort.from } }),
          ...(record === undefined ? {} : { record }),
        },
      }
    }
    // An agent, group or root has no text of its own: resolved lists the rows
    // directly under it, one line each, as list does.
    if (node.address === undefined && view === "resolved") {
      const children = findLazy(treeMemo, id)?.children().map(materialize) ?? []
      return {
        output: {
          id,
          view,
          kind: node.kind,
          label: node.label,
          ...(node.badges.state === undefined ? {} : { state: node.badges.state }),
          // The preset as set({ preset }) names it: "<id>" or "<team>/<member>".
          ...(node.owner?.link === undefined
            ? {}
            : { link: node.owner.link.kind === "member" ? `${node.owner.link.team}/${node.owner.link.id}` : node.owner.link.id }),
          columns: "id | badges | from",
          rows: children.map(childLine),
        },
      }
    }
    if (node.address === undefined)
      return yield* Effect.fail(new Tool.Error({ message: `view.unsupported: ${view} view needs a row with text (got ${id}); resolved lists the rows under it` }))
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
      const parent = memo.items.find((entry) => entry.id === `tool:${upstream.permTool ?? ""}`)
      // Only the parent tool description is scrubbed live (apply.ts
      // applyRuleScrub); system text and skills are never cut, and a subagent
      // row drops nothing (Core already lists only the subagents an agent may
      // run), whatever keywords a stored record holds.
      const scrubbed =
        parent === undefined || upstream.permTool === "subagent"
          ? { text: "", hidden: 0, preview: [] as readonly string[] }
          : scrubLines(parent.text, keywords)
      const message = upstream.custom === true ? upstream.message : curatedRuleMessage(upstream.permTool ?? "", upstream.ruleId ?? "") ?? upstream.message
      return {
        output: {
          id,
          view,
          tool: upstream.permTool ?? "",
          rule: upstream.ruleId ?? "",
          label: upstream.title,
          patterns,
          keywords,
          custom: upstream.custom === true,
          enabled: resolved.enabled,
          source: resolved.source,
          stateFrom: resolved.from,
          textFrom: resolved.textFrom,
          // Where the row is listed and how it is enforced (permission-catalog.ts).
          category: upstream.category ?? "",
          kind: upstream.permKind ?? "rule",
          ...(upstream.allow === true ? { allow: true } : {}),
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
      const text = address.section === null ? (resolved.fullText ?? resolved.text) : resolved.text
      return {
        output: {
          id,
          view,
          text,
          // What reaches the model, only when gates or markers make it differ.
          ...(resolved.assembled === text ? {} : { assembled: resolved.assembled }),
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
    const proposal = mergeProposal(memo, treeMemoOf(memo), node)
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

function upstreamOf(memo: MemoInput, address: Address) {
  if (isControl(address.item)) return controlItemFor(memo.items, address)
  const matches = memo.items.filter((item) => item.id === address.item)
  const item = matches.find((item) => address.agent === null || applies(item, address.agent)) ?? matches[0]
  if (item === undefined || item.kind !== "perm") return item
  const context = treeMemoOf(memo).ctx
  return ruleItem(item, context.rules, context.scopes, address)
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
      const rule = ownRule(rulesOfMemo(memo), address)
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
      | "system"
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
    models?: readonly string[]
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
      if (candidate !== "" && protectedForActor(snapshot, candidate))
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
    if (input.kind === "system") {
      if (input.id === undefined || input.text === undefined)
        return yield* Effect.fail(new Tool.Error({ message: "create system requires id and text" }))
      const created = yield* Effect.promise(() =>
        api.createSystem({ id: input.id as string, title: input.title ?? "", text: input.text as string, ...(input.models === undefined ? {} : { models: input.models }), actor }),
      )
      if (!created.ok) return yield* Effect.fail(new Tool.Error({ message: `${created.error.code}: ${created.error.message}` }))
      const row = yield* createdRowOrFail(
        api,
        (memo) => createdItemRow(memo, { level: "defaults", agent: null, item: `system:${created.value.id}` }),
        `${input.models === undefined ? "System row" : "model prompt"} "${created.value.id}"`,
      )
      return { output: { ...created.value, id: row.id, item: row.item } }
    }
    if (input.kind === "instruction") {
      // OpenCodePlus: creating AGENTS.md files is off pending the Context catalogue.
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
      if (level !== "defaults" && teammate !== "" && protectedForActor(snapshot, teammate))
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
      if (level !== "preset" && agent !== null && protectedForActor(snapshot, agent))
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
      const member = team === undefined ? undefined : findRow(memo, `team:${level}:${team}:${agent}`, treeMemoOf(memo))
      // Match the TUI Models group: presets and Defaults entries own scoped
      // records; an ordinary member writes its agent's records in this team's chain.
      if (team !== undefined && (agent === null || findRow(memo, `group:${level}:${team}/:${agent}:models`, treeMemoOf(memo)) === undefined))
        return yield* Effect.fail(new Tool.Error({ message: `model.invalid: unknown member ${JSON.stringify(agent)} of team ${JSON.stringify(team)} at ${level}` }))
      const owner = team === undefined
        ? {}
        : member?.owner?.preset !== undefined || member?.owner?.entry !== undefined
          ? { team: { level, team } }
          : { memberOf: { level, team } }
      if (team === undefined && findRow(memo, `group:${level}:${agent ?? (input.catalogue === "teams" ? "/teams" : "")}:models`, treeMemoOf(memo)) === undefined)
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
      if (level !== "preset" && agent !== null && protectedForActor(snapshot, agent))
        return yield* Effect.fail(protectedError(agent))
      const team = input.team?.trim()
      const memo = memoFromSnapshot(snapshot)
      const member = team === undefined ? undefined : findRow(memo, `team:${level}:${team}:${agent}`, treeMemoOf(memo))
      if (team !== undefined && member?.owner === undefined)
        return yield* Effect.fail(new Tool.Error({ message: `rule.invalid: unknown member ${JSON.stringify(agent)} of team ${JSON.stringify(team)} at ${level}` }))
      const owner = team === undefined ? {} : member?.owner?.preset !== undefined || member?.owner?.entry !== undefined
        ? { team: { level, team } } : { memberOf: { level, team } }
      const created = yield* Effect.promise(() =>
        api.addRule({
          level,
          agent,
          ...(owner.team === undefined ? {} : { team: owner.team }),
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
            ...owner,
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

type CreateOne = Parameters<typeof createRow>[1]

// create's lists, one create each: every id (for every agent of a model or
// rule), and a team's members right after the team.
function createRows(input: typeof CreateInput.Type): CreateOne[] {
  const { id, agent, members, dryRun: _dryRun, verbose: _verbose, ...rest } = input
  const ids = id === undefined ? [undefined] : typeof id === "string" ? [id] : [...new Set(id)]
  const agents = agent === undefined ? [undefined] : typeof agent === "string" ? [agent] : [...new Set(agent)]
  const rows: CreateOne[] = ids.flatMap((one) => agents.map((owner) => ({ ...rest, ...(one === undefined ? {} : { id: one }), ...(owner === undefined ? {} : { agent: owner }) })))
  if (input.kind !== "team" || members === undefined) return rows
  return [
    ...rows,
    ...rows.flatMap((team) =>
      members.map((member): CreateOne => ({
        kind: "member",
        ...(team.team === undefined ? {} : { team: team.team }),
        ...(team.level === undefined ? {} : { level: team.level }),
        ...(typeof member === "string" ? { id: member } : { id: member.id, ...(member.preset === undefined ? {} : { preset: member.preset }) }),
      })),
    ),
  ]
}

function createLabel(row: CreateOne): string {
  const name = row.id ?? row.name ?? row.team ?? (row.modelID === undefined ? undefined : `${row.providerID}/${row.modelID}`) ?? ""
  return `create ${row.kind} ${name}${row.agent === undefined ? "" : ` for ${row.agent}`}${row.kind === "member" && row.team !== undefined ? ` in ${row.team}` : ""}`.trim()
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
        message: `create.failed: created ${label} but its row is missing from the instructions tree; re-read with instructions_find`,
      }),
    )
  })
}

// Duplicate one row: the existing create operation makes the copy (a file, a
// skill or a preset) without the original's preset, and one guarded layout
// write gives it the original's effective configuration as its own records
// (clipboard.ts pasteRows) and its folder layout. A copy is independent: it is
// never linked to the original or to the presets either of them followed.
function duplicateRow(api: PlusApi, id: string, name: string | undefined, actor: Plus.Actor, into?: string): Effect.Effect<{ readonly row: string; readonly status: string }, Tool.Error> {
  return Effect.gen(function* () {
    const snapshot = yield* snapshotOrFail(api)
    const memo = memoFromSnapshot(snapshot)
    const tree = treeMemoOf(memo)
    const source = duplicateSource(tree, id)
    if ("refusal" in source) return yield* Effect.fail(new Tool.Error({ message: source.refusal }))
    const label = name?.trim() || duplicateName(tree, source)
    const updated = new Date().toISOString()
    const failed = (result: { readonly ok: false; readonly error: { readonly code: string; readonly message: string } }) =>
      Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
    if (source.kind === "folder") return yield* duplicateFolder(api, snapshot, memo, source, label, updated, actor)
    // A copy carries the original's effective configuration as its own
    // records (materializedOwnerRecords): what it resolves to now, not a link
    // to what it followed. A copy never stays linked to its original.
    const settle = (fresh: Plus.Snapshot, current: MemoInput, row: string, layout: LayoutRecords, status: string, records: MemoInput["records"]) =>
      Effect.gen(function* () {
        const placed = into === undefined ? layout : placeInto({ ...current, ...layout }, layout, row, into, updated)
        return yield* writeCopy(api, fresh, current, records, placed, row, status, actor)
      })
    if (source.kind === "system") {
      const created = yield* Effect.promise(() =>
        api.createSystem({ id: systemCopyId(tree, label), title: label, text: source.text, ...(source.models === undefined ? {} : { models: source.models }), actor }),
      )
      if (!created.ok) return yield* failed(created)
      const item = `system:${created.value.id}`
      yield* createdRowOrFail(api, (input) => createdItemRow(input, { level: "defaults", agent: null, item }), `System row "${created.value.id}"`)
      const after = yield* snapshotOrFail(api)
      const current = memoFromSnapshot(after)
      const row = `${source.row.slice(0, -source.item.length)}${item}`
      // A user System row's copy carries every agent's settings; a built-in
      // row's copy starts from the text this owner sees, and nothing else.
      const records = [...current.records, ...(builtInSystem(tree, source.item) ? [] : itemRecordsCopy(current.records, source.item, item))]
      const layout = systemOrderAfter(current, layoutOf(after), row, source.row, updated)
      return yield* writeCopy(api, after, current, records, into === undefined ? layout : placeInto({ ...current, ...layout }, layout, row, into, updated), row, `Duplicated "${source.title}" as "${label}"`, actor)
    }
    if (source.kind === "skill") {
      const created = yield* Effect.promise(() =>
        api.createSkill({
          name: label,
          body: source.text,
          scope: source.scope,
          ...(source.scope === "preset" && source.preset !== undefined ? { preset: source.preset } : {}),
          actor,
        }),
      )
      if (!created.ok) return yield* failed(created)
      // A skill's text lives in its file, so the copy needs no records: the
      // host lists it once it rescans the skills directory.
      const after = yield* snapshotOrFail(api)
      const current = memoFromSnapshot(after)
      const row = `${source.row.slice(0, -source.skill.length - "skill:".length)}skill:${created.value.id}`
      return yield* writeCopy(api, after, current, current.records, layoutOf(after), row, `Duplicated skill ${source.skill} as ${created.value.id}`, actor)
    }
    if (source.kind === "team") {
      const created = yield* Effect.promise(() => api.createTeam({ level: source.level, team: label, actor }))
      if (!created.ok) return yield* failed(created)
      yield* Effect.promise(() => api.refresh())
      const row = `team:${source.level}:${label}`
      const members = tree.ctx.teams.find((entry) => entry.level === source.level && entry.team === source.team)?.agents ?? []
      const copied: string[] = []
      const skipped: string[] = []
      for (const member of members) {
        const made = yield* duplicateRow(api, `team:${source.level}:${source.team}:${member}`, member, actor, row).pipe(Effect.match({
          onSuccess: (copy) => (copied.push(copy.row), copy),
          onFailure: (error) => (skipped.push(error.message), undefined as { readonly row: string; readonly status: string } | undefined),
        }))
        if (made === undefined) continue
      }
      const after = yield* snapshotOrFail(api)
      const current = memoFromSnapshot(after)
      const records = [...current.records, ...teamRecordsCopy(current.records, source.level, source.team, label)]
      // The team's own settings and rules, resolved as it shows them now.
      const values = materializedOwnerRecords(treeMemoOf(current), {
        row: `team:${source.level}:${source.team}`, level: source.level, agent: null, team: { level: source.level, team: source.team },
      }, { level: source.level, agent: null, team: { level: source.level, team: label } }, updated)
      const layout = teamLayoutCopy(layoutOf(after), source.level, source.team, label, updated)
      records.push(...values)
      const kept = members.length - copied.length
      const status = `Duplicated team "${source.team}" as "${label}"${copied.length === 0 ? "" : `: ${copied.length} member${copied.length === 1 ? "" : "s"} copied`}${kept === 0 ? "" : `; ${kept} member${kept === 1 ? "" : "s"} not copied: ${skipped.join("; ")}`} (the copy starts off: one team is on at a time)`
      return yield* writeCopy(api, after, current, records, layout, row, status, actor)
    }
    if (source.kind === "agent" || source.kind === "member") {
      // A member copied into another team (a team's copy) lands in that team's
      // directory, with the same id.
      const team = source.kind === "member" ? { level: source.level, team: source.team } : undefined
      const destination = team === undefined
        ? undefined
        : into?.startsWith(`team:${source.level}:`) === true ? into.slice(`team:${source.level}:`.length) : team.team
      const created = yield* Effect.promise(() => source.kind === "agent"
        ? api.createAgent({ scope: source.scope, id: label, ...(source.file ? { from: source.agent } : {}), actor })
        // A copy in the same team copies the member's file; one in another team
        // starts from an empty file, and its rows carry the configuration.
        : api.addTeamAgent({ level: source.level, team: destination!, id: label, ...(destination === team!.team ? { from: source.agent } : {}), actor }))
      if (!created.ok) return yield* failed(created)
      const copy = created.value.id
      const row = team === undefined ? `agent:${source.level}:${copy}` : `team:${source.level}:${destination}:${copy}`
      const discard = () => Effect.promise(() => source.kind === "agent"
        ? api.deleteAgent({ scope: source.scope, id: copy, actor }).then(() => undefined)
        : api.removeTeamAgent({ level: source.level, team: destination!, id: copy, actor }).then(() => undefined))
      // The host lists a new agent file after its debounced rescan; rebuild
      // now so the copy is in the tree to carry the configuration.
      yield* Effect.promise(() => api.refresh())
      const listed = yield* createdRowOrFail(api, (input) => findRow(input, row, treeMemoOf(input)) === undefined ? undefined : { id: row, item: copy }, `agent "${copy}"`).pipe(Effect.option)
      if (Option.isNone(listed)) {
        yield* discard()
        return yield* Effect.fail(new Tool.Error({ message: `create.failed: created agent "${copy}" but its row is missing from the instructions tree; nothing was copied` }))
      }
      const after = yield* snapshotOrFail(api)
      const current = memoFromSnapshot(after)
      const levels = [...new Set(source.kind === "agent" ? [source.scope, source.level] : [source.level])]
      const targetTeam = team === undefined ? undefined : { level: team.level, team: destination! }
      const owner = (agent: string) => (level: string) => team === undefined ? `group:${level}:${agent}:` : `group:${level}:${destination}/:${agent}:`
      const treeAfter = treeMemoOf(current)
      const copied = levels.flatMap((level) => [
        ...materializedOwnerRecords(treeAfter, {
          row: source.row,
          level,
          agent: source.agent,
          ...(team === undefined ? {} : { team }),
        }, { level, agent: copy, ...(targetTeam === undefined ? {} : { team: targetTeam }) }, updated),
        // A discovered member's own rows and its team-scoped rows both come along.
        ...(team === undefined ? [] : materializedOwnerRecords(treeAfter, {
          row: `team:${level}:${team.team}:${source.agent}`,
          level,
          agent: source.agent,
          team: { level, team: team.team },
        }, { level, agent: copy, team: { level, team: destination! } }, updated)),
      ])
      const layout = levels.reduce((all, level) => ownerLayoutCopy(all, owner(source.agent)(level), owner(copy)(level), updated), layoutOf(after))
      const records = [...current.records, ...copied]
      // The copy goes right after its original in its catalogue list (an
      // owner row reorders inside its group), unless a folder takes it.
      const placed = placeAfter({ ...current, records, ...layout }, layout, row, source)
      return yield* settle(after, current, row, placed, `Duplicated ${source.agent} as ${copy}`, records).pipe(Effect.catchTag("Tool.Error", (error) => discard().pipe(Effect.andThen(Effect.fail(error)))))
    }
    const ref = source.ref
    if (ref.kind === "team") {
      // A team preset: an independent copy of the member list, each member an
      // independent preset of its own, carrying the original member's values.
      const created = yield* Effect.promise(() => api.createPreset({ kind: "team", id: label, actor }))
      if (!created.ok) return yield* failed(created)
      const team = created.value.ref.id
      const members = tree.ctx.listing.find((entry) => entry.ref.kind === "team" && entry.ref.id === ref.id)?.members ?? []
      const copied: string[] = []
      const failedMembers: string[] = []
      for (const member of members) {
        const added = yield* Effect.promise(() => api.addPresetMember({ team, id: member, actor }))
        if (!added.ok) { failedMembers.push(`${member}: ${added.error.message}`); continue }
        const memberRow = yield* createdRowOrFail(api, (input) => createdPresetRow(input, { kind: "member", team, id: member }), `member preset "${team} › ${member}"`).pipe(Effect.option)
        if (Option.isNone(memberRow)) { failedMembers.push(`${member}: its row is missing`); continue }
        const fresh = yield* snapshotOrFail(api)
        const current = memoFromSnapshot(fresh)
        const values = materializedOwnerRecords(treeMemoOf(current), {
          row: `team:preset:${ref.id}:${member}`, level: "preset", agent: member, team: { level: "preset", team: ref.id },
        }, { level: "preset", agent: member, team: { level: "preset", team } }, updated)
        yield* writeCopy(api, fresh, current, [...current.records, ...values], layoutOf(fresh), memberRow.value.id, `Copied member ${member}`, actor)
        copied.push(member)
      }
      const status = `Duplicated team preset ${ref.id} as ${team}${members.length === 0 ? "" : `: ${copied.length} of ${members.length} members copied`}${failedMembers.length === 0 ? "" : `; not copied: ${failedMembers.join("; ")}`}`
      return { row: `team:preset:${team}`, status }
    }
    const created = yield* Effect.promise(() => ref.kind === "member"
      ? api.addPresetMember({ team: ref.team, id: label, actor })
      : api.createPreset({ kind: "agent", id: label, actor }))
    if (!created.ok) return yield* failed(created)
    const copy = created.value.ref
    const row = yield* createdRowOrFail(api, (input) => createdPresetRow(input, copy), `preset "${copy.id}"`)
    const after = yield* snapshotOrFail(api)
    const current = memoFromSnapshot(after)
    const copied = materializedOwnerRecords(treeMemoOf(current), {
      row: row.id, level: "preset", agent: ref.id,
      ...(ref.kind === "member" ? { team: { level: "preset" as const, team: ref.team } } : {}),
    }, {
      level: "preset", agent: copy.id,
      ...(copy.kind === "member" ? { team: { level: "preset" as const, team: copy.team } } : {}),
    }, updated)
    const prefix = (agent: string) => ref.kind === "member" ? `group:preset:${ref.team}/:${agent}:` : `group:preset:${agent}:`
    const layout = ownerLayoutCopy(layoutOf(after), prefix(ref.id), prefix(copy.id), updated)
    return yield* settle(after, current, row.id, layout, `Duplicated preset ${ref.id} as ${copy.id}`, [...current.records, ...copied]).pipe(Effect.catchTag("Tool.Error", (error) =>
      Effect.promise(() => api.deletePreset({ ref: copy, actor }).then(() => undefined)).pipe(Effect.andThen(Effect.fail(error))),
    ))
  })
}

// A folder copy holds a copy of every row inside it that can exist twice,
// subfolders included, in the same order; rows that exist once are skipped
// and counted in the status line.
function duplicateFolder(api: PlusApi, snapshot: Plus.Snapshot, memo: MemoInput, source: Extract<DuplicateSource, { kind: "folder" }>, label: string, updated: string, actor: Plus.Actor) {
  return Effect.gen(function* () {
    const created = planFolderCreate(memo, layoutOf(snapshot), source.parent, label, updated, treeMemoOf(memo))
    if ("refusal" in created) return yield* Effect.fail(new Tool.Error({ message: created.refusal }))
    const added = created.layout.folders.find((entry) => folderRef(entry.id) === created.target)!
    const row = `${added.owner}:folder:${added.id}`
    const layout = placeAfter({ ...memo, ...created.layout }, created.layout, row, source)
    const written = yield* Effect.promise(() => api.layoutWrite({
      folders: [...layout.folders], orders: [...layout.orders],
      expectedProjectRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision,
      target: row, status: `Created folder "${added.name}"`, actor,
    }))
    if (!written.ok) return yield* Effect.fail(new Tool.Error({ message: `${written.error.code}: ${written.error.message}` }))
    const stats = { copied: 0, skipped: new Map<string, number>() }
    yield* copyFolderRows(api, source.row, row, updated, actor, stats)
    const reasons = new Map([["tool row", "they exist once per agent"], ["parameter row", "they exist once per agent"], ["rule row", "they exist once per agent"], ["model row", "they exist once per agent"]])
    const skipped = [...stats.skipped].map(([what, count]) => `${count} ${what}${count === 1 ? "" : "s"} skipped${reasons.get(what) === undefined ? "" : ` (${reasons.get(what)})`}`)
    const status = `Duplicated folder "${source.name}" as "${added.name}": ${stats.copied === 0 ? "empty" : `${stats.copied} row${stats.copied === 1 ? "" : "s"} copied`}${skipped.length === 0 ? "" : `, ${skipped.join(", ")}`}`
    return { row, status }
  })
}

// Every child of one folder, in order: a subfolder is created and filled; a
// row that can exist twice is duplicated into the folder; anything else is
// counted by its kind.
function copyFolderRows(api: PlusApi, sourceFolder: string, destination: string, updated: string, actor: Plus.Actor, stats: { copied: number; skipped: Map<string, number> }): Effect.Effect<void, Tool.Error> {
  return Effect.gen(function* () {
    const snapshot = yield* snapshotOrFail(api)
    const memo = memoFromSnapshot(snapshot)
    const tree = treeMemoOf(memo)
    const children = findLazy(tree, sourceFolder)?.children() ?? []
    for (const child of children) {
      if (child.kind === "group" && child.id.includes(":folder:")) {
        const made = planFolderCreate(memo, layoutOf(snapshot), destination, child.label, updated, tree)
        if ("refusal" in made) { stats.skipped.set("folder", (stats.skipped.get("folder") ?? 0) + 1); continue }
        const inside = made.layout.folders.find((entry) => folderRef(entry.id) === made.target)!
        const written = yield* Effect.promise(() => api.layoutWrite({
          folders: [...made.layout.folders], orders: [...made.layout.orders],
          expectedProjectRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision,
          target: made.target, status: `Created folder "${inside.name}"`, actor,
        }))
        if (!written.ok) return yield* Effect.fail(new Tool.Error({ message: `${written.error.code}: ${written.error.message}` }))
        stats.copied += 1
        yield* copyFolderRows(api, child.id, `${inside.owner}:folder:${inside.id}`, updated, actor, stats)
        continue
      }
      const source = duplicateSource(tree, child.id)
      if ("refusal" in source) {
        const what = folderSkipKind(child)
        stats.skipped.set(what, (stats.skipped.get(what) ?? 0) + 1)
        continue
      }
      yield* duplicateRow(api, child.id, undefined, actor, destination)
      stats.copied += 1
    }
  })
}

function folderSkipKind(node: Lazy): string {
  const item = node.address?.item ?? ""
  if (item.startsWith("model")) return "model row"
  if (item.startsWith("perm:")) return "rule row"
  if (item.startsWith("param:")) return "parameter row"
  if (item.startsWith("tool:")) return "tool row"
  return "row"
}

// The copy goes right after the original in their list; a list that does not
// take that order (a built-in agent's copy lands among the user agents) keeps
// its own. An item row moves with the tab's folders (planRowMove); an owner
// row — an agent, a team, a member — reorders inside its group list instead
// (planGroupMove), which planRowMove refuses as built-in structure.
function placeAfter(memo: MemoInput, layout: LayoutRecords, row: string, source: DuplicateSource): LayoutRecords {
  const tree = buildTreeMemo(memo)
  // A folder whose tab took its own copy of an inherited layout has a new id.
  const original = findLazy(tree, source.row)?.id
    ?? (source.kind === "folder" ? findLazy(tree, source.parent)?.children().find((entry) => entry.id.includes(":folder:") && entry.label === source.name && entry.id !== row)?.id : undefined)
  if (original === undefined) return layout
  const updated = new Date().toISOString()
  const moved = planRowMove(memo, layout, row, { after: original }, updated, tree)
  const placed = "refusal" in moved ? planGroupMove(memo, layout, row, { after: original }, updated, tree) : moved
  return "refusal" in placed ? layout : placed.layout
}

// A row made inside a folder goes into it; a row whose list cannot hold it
// keeps the place its list gives it.
function placeInto(memo: MemoInput, layout: LayoutRecords, row: string, into: string, updated: string): LayoutRecords {
  const moved = planRowMove(memo, layout, row, { into }, updated, buildTreeMemo(memo))
  return "refusal" in moved ? layout : moved.layout
}

// A System row's copy right after the original in the request: the owner's
// request order names the copy's slot after the original's. A user System row
// off the System list (a model prompt) keeps the order the list gives it.
function systemOrderAfter(memo: MemoInput, layout: LayoutRecords, row: string, original: string, updated: string): LayoutRecords {
  const moved = planSystemMove(memo, layout, row, { after: original }, updated, buildTreeMemo(memo))
  return "refusal" in moved ? layout : moved.layout
}

// A System row OpenCode ships rather than a file the owner made.
function builtInSystem(tree: Memo, item: string): boolean {
  return tree.ctx.items.some((entry) => entry.id === item && entry.kind === "system" && entry.userSystem !== true)
}

function writeCopy(api: PlusApi, snapshot: Plus.Snapshot, before: MemoInput, records: MemoInput["records"], layout: LayoutRecords, row: string, status: string, actor: Plus.Actor) {
  return Effect.gen(function* () {
    const delta = deltaOf(before.records, records)
    const written = yield* Effect.promise(() => api.layoutWrite({
      folders: [...layout.folders], orders: [...layout.orders],
      changes: { upsert: delta.upsert.flatMap((record) => { const next = snapshotRecordOf(record); return next === undefined ? [] : [next] }), remove: delta.remove },
      expectedProjectRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision,
      target: row, status, actor,
    }))
    if (!written.ok) return yield* Effect.fail(new Tool.Error({ message: `The copy was created, but its configuration was not saved: ${written.error.message}` }))
    return { row, status }
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
    if (plan.kind === "system.delete") {
      const result = yield* Effect.promise(() => api.deleteSystem({ id: plan.id, actor }))
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
