export * as Plus from "./rpc.js"

import { Schema } from "effect"
import { Rpc } from "@opencode/schema/rpc"

export interface Status extends Schema.Schema.Type<typeof Status> {}
export const Status = Schema.Struct({
  enabled: Schema.Boolean,
  directory: Schema.String,
}).annotate({ identifier: "Plus.Status" })

export type Level = typeof Level.Type
export const Level = Schema.Union([
  Schema.Literal("defaults"),
  Schema.Literal("global"),
  Schema.Literal("project"),
  Schema.Literal("preset"),
]).annotate({ identifier: "Plus.Level" })

export interface TeamOwner extends Schema.Schema.Type<typeof TeamOwner> {}
export const TeamOwner = Schema.Struct({
  level: Level,
  team: Schema.String,
}).annotate({ identifier: "Plus.TeamOwner" })

// The two catalogues the instructions tree splits into. Shared-inventory rows
// only (`agent === null`); absent means the Agents catalogue, so every address
// and record written before the split keeps its meaning.
export type Catalogue = typeof Catalogue.Type
export const Catalogue = Schema.Union([Schema.Literal("agents"), Schema.Literal("teams")]).annotate({
  identifier: "Plus.Catalogue",
})

export interface Address extends Schema.Schema.Type<typeof Address> {}
export const Address = Schema.Struct({
  level: Level,
  agent: Schema.NullOr(Schema.String),
  item: Schema.String,
  section: Schema.NullOr(Schema.String),
  team: Schema.optionalKey(TeamOwner),
  catalogue: Schema.optionalKey(Catalogue),
  // An ordinary team member's row: resolved as a member of this team, its own
  // records per-agent (instructions/model.ts Address.memberOf).
  memberOf: Schema.optionalKey(TeamOwner),
}).annotate({ identifier: "Plus.Address" })

export type ItemKind = typeof ItemKind.Type
export const ItemKind = Schema.Union([
  Schema.Literal("tool"),
  Schema.Literal("base"),
  Schema.Literal("skill"),
  Schema.Literal("system"),
  Schema.Literal("mcp"),
  Schema.Literal("model"),
  Schema.Literal("perm"),
  Schema.Literal("setting"),
  Schema.Literal("compaction"),
]).annotate({ identifier: "Plus.ItemKind" })

export type ItemGroup = typeof ItemGroup.Type
export const ItemGroup = Schema.Union([
  Schema.Literal("native"),
  Schema.Literal("plus"),
  Schema.Literal("mcp"),
  Schema.Literal("project"),
  Schema.Literal("none"),
]).annotate({ identifier: "Plus.ItemGroup" })

// Mirrors PolicyEffects in instructions/model.ts. A team policy row carries
// both sides of its own answer, and `ask` is a real core effect, so all three
// effects have to round-trip for the row to mean the same thing on both sides.
// `message` is what the rule says when it is the one refusing, so it has to
// cross too for `instructions.show` to display it. A rule without one omits
// the key, never sends `undefined`.
export interface PolicyRule extends Schema.Schema.Type<typeof PolicyRule> {}
export const PolicyRule = Schema.Struct({
  action: Schema.String,
  resource: Schema.String,
  effect: Schema.Union([Schema.Literal("allow"), Schema.Literal("deny"), Schema.Literal("ask")]),
  message: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Plus.PolicyRule" })

export interface PolicyEffects extends Schema.Schema.Type<typeof PolicyEffects> {}
export const PolicyEffects = Schema.Struct({
  on: Schema.Array(PolicyRule),
  off: Schema.Array(PolicyRule),
}).annotate({ identifier: "Plus.PolicyEffects" })

export interface SnapshotItem extends Schema.Schema.Type<typeof SnapshotItem> {}
export const SnapshotItem = Schema.Struct({
  id: Schema.String,
  kind: ItemKind,
  group: ItemGroup,
  server: Schema.optionalKey(Schema.String),
  title: Schema.String,
  text: Schema.String,
  enabled: Schema.Boolean,
  fingerprint: Schema.String,
  agents: Schema.optionalKey(Schema.Array(Schema.String)),
  controlTeam: Schema.optionalKey(TeamOwner),
  order: Schema.optionalKey(Schema.Number),
  userBase: Schema.optionalKey(Schema.Boolean),
  codemode: Schema.optionalKey(Schema.Boolean),
  namespace: Schema.optionalKey(Schema.String),
  pinned: Schema.optionalKey(Schema.Boolean),
  execute: Schema.optionalKey(Schema.Boolean),
  permTool: Schema.optionalKey(Schema.String),
  permAction: Schema.optionalKey(Schema.String),
  ruleId: Schema.optionalKey(Schema.String),
  patterns: Schema.optionalKey(Schema.Array(Schema.String)),
  keywords: Schema.optionalKey(Schema.Array(Schema.String)),
  provenance: Schema.optionalKey(Schema.Array(Schema.String)),
  custom: Schema.optionalKey(Schema.Boolean),
  ownedBy: Schema.optionalKey(Schema.String),
  policy: Schema.optionalKey(PolicyEffects),
  runID: Schema.optionalKey(Schema.String),
  // Per-tool permissions (instructions/permission-catalog.ts): where a perm
  // row is listed and how it is enforced. Every field crosses so the TUI and
  // the tools read the same rows the server enforces.
  category: Schema.optionalKey(Schema.String),
  permKind: Schema.optionalKey(
    Schema.Literals(["rule", "input", "value", "param", "limit", "approval", "env", "team"]),
  ),
  field: Schema.optionalKey(Schema.String),
  value: Schema.optionalKey(Schema.Union([Schema.String, Schema.Number, Schema.Boolean, Schema.Null])),
  allow: Schema.optionalKey(Schema.Boolean),
  measure: Schema.optionalKey(Schema.Literals(["value", "length", "count"])),
  mode: Schema.optionalKey(Schema.Literals(["clamp", "refuse"])),
  message: Schema.optionalKey(Schema.String),
  fallback: Schema.optionalKey(Schema.Boolean),
  alsoUnder: Schema.optionalKey(Schema.Array(Schema.String)),
}).annotate({ identifier: "Plus.SnapshotItem" })

export interface Boundary extends Schema.Schema.Type<typeof Boundary> {}
export const Boundary = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  start: Schema.Number,
}).annotate({ identifier: "Plus.Boundary" })

export type RecordState = typeof RecordState.Type
export const RecordState = Schema.Union([Schema.Literal("on"), Schema.Literal("off")]).annotate({
  identifier: "Plus.RecordState",
})

export interface SnapshotCustomizationRecord extends Schema.Schema.Type<typeof SnapshotCustomizationRecord> {}
export const SnapshotCustomizationRecord = Schema.Struct({
  type: Schema.Literal("customization"),
  level: Level,
  agent: Schema.NullOr(Schema.String),
  team: Schema.optionalKey(TeamOwner),
  catalogue: Schema.optionalKey(Catalogue),
  item: Schema.String,
  section: Schema.NullOr(Schema.String),
  text: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(RecordState),
  pin: Schema.optionalKey(Schema.Boolean),
  basedOn: Schema.String,
  basedOnText: Schema.optionalKey(Schema.String),
  acknowledged: Schema.optionalKey(Schema.String),
  basedOnState: Schema.optionalKey(RecordState),
  basedOnPin: Schema.optionalKey(Schema.Boolean),
  updated: Schema.String,
}).annotate({ identifier: "Plus.SnapshotCustomizationRecord" })

export interface SnapshotSplitRecord extends Schema.Schema.Type<typeof SnapshotSplitRecord> {}
export const SnapshotSplitRecord = Schema.Struct({
  type: Schema.Literal("split"),
  level: Level,
  agent: Schema.NullOr(Schema.String),
  team: Schema.optionalKey(TeamOwner),
  catalogue: Schema.optionalKey(Catalogue),
  item: Schema.String,
  boundaries: Schema.Array(Boundary),
  updated: Schema.String,
}).annotate({ identifier: "Plus.SnapshotSplitRecord" })

// Per-agent model selection. `active` is `true` or omitted, never `false`:
// results are validated as JSON, so a present-but-undefined key fails the
// whole call with HTTP 400.
export interface SnapshotModelRecord extends Schema.Schema.Type<typeof SnapshotModelRecord> {}
export const SnapshotModelRecord = Schema.Struct({
  type: Schema.Literal("model"),
  level: Level,
  agent: Schema.NullOr(Schema.String),
  team: Schema.optionalKey(TeamOwner),
  catalogue: Schema.optionalKey(Catalogue),
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optionalKey(Schema.String),
  active: Schema.optionalKey(Schema.Literal(true)),
  basedOn: Schema.optionalKey(Schema.String),
  updated: Schema.String,
}).annotate({ identifier: "Plus.SnapshotModelRecord" })

export interface SnapshotRuleRecord extends Schema.Schema.Type<typeof SnapshotRuleRecord> {}
export const SnapshotRuleRecord = Schema.Struct({
  type: Schema.Literal("rule"),
  level: Level,
  agent: Schema.NullOr(Schema.String),
  team: Schema.optionalKey(TeamOwner),
  catalogue: Schema.optionalKey(Catalogue),
  tool: Schema.String,
  id: Schema.String,
  label: Schema.String,
  patterns: Schema.Array(Schema.String),
  keywords: Schema.Array(Schema.String),
  message: Schema.optionalKey(Schema.String),
  updated: Schema.String,
}).annotate({ identifier: "Plus.SnapshotRuleRecord" })

export type SnapshotRecord = typeof SnapshotRecord.Type
export const SnapshotRecord = Schema.Union([
  SnapshotCustomizationRecord,
  SnapshotSplitRecord,
  SnapshotModelRecord,
  SnapshotRuleRecord,
]).annotate({
  identifier: "Plus.SnapshotRecord",
})

// What a link points at (DESIGN §7): an agent preset, one member of a team
// preset, or a whole team preset.
export type PresetRef = typeof PresetRef.Type
export const PresetRef = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("agent"), id: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("member"), team: Schema.String, id: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("team"), id: Schema.String }),
]).annotate({ identifier: "Plus.PresetRef" })

// "Created from preset X". Links, Defaults entries and user presets cross in
// their own Snapshot fields, never in `records`: instructions.mutate keeps
// the stored ones, so a client that resubmits only inventory records cannot
// drop them.
export interface SnapshotLinkRecord extends Schema.Schema.Type<typeof SnapshotLinkRecord> {}
export const SnapshotLinkRecord = Schema.Struct({
  type: Schema.Literal("link"),
  level: Level,
  agent: Schema.NullOr(Schema.String),
  team: Schema.optionalKey(TeamOwner),
  catalogue: Schema.optionalKey(Catalogue),
  preset: PresetRef,
  updated: Schema.String,
}).annotate({ identifier: "Plus.SnapshotLinkRecord" })

export interface SnapshotEntryRecord extends Schema.Schema.Type<typeof SnapshotEntryRecord> {}
export const SnapshotEntryRecord = Schema.Struct({
  type: Schema.Literal("entry"),
  level: Schema.Literal("defaults"),
  catalogue: Catalogue,
  team: Schema.optionalKey(Schema.String),
  name: Schema.String,
  updated: Schema.String,
}).annotate({ identifier: "Plus.SnapshotEntryRecord" })

export interface SnapshotPresetRecord extends Schema.Schema.Type<typeof SnapshotPresetRecord> {}
export const SnapshotPresetRecord = Schema.Struct({
  type: Schema.Literal("preset"),
  level: Schema.Literal("preset"),
  kind: Schema.Union([Schema.Literal("agent"), Schema.Literal("team")]),
  id: Schema.String,
  team: Schema.optionalKey(Schema.String),
  fields: Schema.optionalKey(
    Schema.Struct({
      mode: Schema.optionalKey(Schema.String),
      description: Schema.optionalKey(Schema.String),
    }),
  ),
  updated: Schema.String,
}).annotate({ identifier: "Plus.SnapshotPresetRecord" })

// Every preset as the create pickers and the tree list them (Native, Plus,
// User agent presets, then team presets each followed by its members). Native
// presets carry the native agent's mode and description as the host reports
// them; the rest carry what the preset copies into a created file.
export interface PresetListEntry extends Schema.Schema.Type<typeof PresetListEntry> {}
export const PresetListEntry = Schema.Struct({
  ref: PresetRef,
  origin: Schema.Union([Schema.Literal("native"), Schema.Literal("plus"), Schema.Literal("user")]),
  kind: Schema.Union([Schema.Literal("agent"), Schema.Literal("member"), Schema.Literal("team")]),
  label: Schema.String,
  description: Schema.optionalKey(Schema.String),
  mode: Schema.optionalKey(Schema.String),
  members: Schema.optionalKey(Schema.Array(Schema.String)),
}).annotate({ identifier: "Plus.PresetListEntry" })

export type AgentScope = typeof AgentScope.Type
export const AgentScope = Schema.Union([
  Schema.Literal("project"),
  Schema.Literal("global"),
  Schema.Literal("defaults"),
]).annotate({ identifier: "Plus.AgentScope" })

export interface AgentModel extends Schema.Schema.Type<typeof AgentModel> {}
export const AgentModel = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Plus.AgentModel" })

export type AgentOrigin = typeof AgentOrigin.Type
export const AgentOrigin = Schema.Union([
  Schema.Literal("native"),
  Schema.Literal("special"),
  Schema.Literal("plus"),
  Schema.Literal("user"),
]).annotate({ identifier: "Plus.AgentOrigin" })

export interface AgentEntry extends Schema.Schema.Type<typeof AgentEntry> {}
export const AgentEntry = Schema.Struct({
  id: Schema.String,
  scope: AgentScope,
  origin: Schema.optionalKey(AgentOrigin),
  path: Schema.optionalKey(Schema.String),
  base: Schema.optionalKey(Schema.String),
  model: Schema.optionalKey(AgentModel),
  ancestor: Schema.optionalKey(Schema.Boolean),
  fileBacked: Schema.Boolean,
}).annotate({ identifier: "Plus.AgentEntry" })

export interface ServerEntry extends Schema.Schema.Type<typeof ServerEntry> {}
export const ServerEntry = Schema.Struct({
  name: Schema.String,
  enabled: Schema.Boolean,
}).annotate({ identifier: "Plus.ServerEntry" })

export type FileScope = typeof FileScope.Type
export const FileScope = Schema.Union([Schema.Literal("project"), Schema.Literal("global")]).annotate({
  identifier: "Plus.FileScope",
})

export type TeamLevel = typeof TeamLevel.Type
export const TeamLevel = Schema.Union([
  Schema.Literal("project"),
  Schema.Literal("global"),
  Schema.Literal("defaults"),
]).annotate({
  identifier: "Plus.TeamLevel",
})

// Teams surface: membership comes from disk discovery for project/global and
// from the built-in source registry for defaults, enablement from team
// records. Snapshot.teams keeps those two sources distinct exactly as
// resolveTeams does — agents lists member ids whether or not the team is
// enabled. This stays a SEPARATE field: team records are deliberately
// excluded from SnapshotRecord so instructions.mutate cannot delete them.
export interface TeamEntry extends Schema.Schema.Type<typeof TeamEntry> {}
export const TeamEntry = Schema.Struct({
  level: TeamLevel,
  team: Schema.String,
  enabled: Schema.Boolean,
  agents: Schema.Array(Schema.String),
  overlay: Schema.optionalKey(Schema.Array(Schema.String)),
}).annotate({ identifier: "Plus.TeamEntry" })

export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
export const Snapshot = Schema.Struct({
  revision: Schema.Number,
  globalRevision: Schema.Number,
  agents: Schema.Array(AgentEntry),
  items: Schema.Array(SnapshotItem),
  records: Schema.Array(SnapshotRecord),
  // Optional so older clients and existing fixtures without teams still
  // decode; the server always emits it (possibly empty).
  teams: Schema.optionalKey(Schema.Array(TeamEntry)),
  // What the resolution chain reads besides `records` (the server always
  // emits them, possibly empty). Shipped preset content does not cross:
  // clients compute it from `items` with instructions/presets.ts, as the
  // server does.
  links: Schema.optionalKey(Schema.Array(SnapshotLinkRecord)),
  entries: Schema.optionalKey(Schema.Array(SnapshotEntryRecord)),
  presets: Schema.optionalKey(Schema.Array(SnapshotPresetRecord)),
  listing: Schema.optionalKey(Schema.Array(PresetListEntry)),
  servers: Schema.Array(ServerEntry),
  protectedAgents: Schema.Array(Schema.String),
}).annotate({ identifier: "Plus.Snapshot" })

export interface Actor extends Schema.Schema.Type<typeof Actor> {}
export const Actor = Schema.Struct({
  type: Schema.Union([Schema.Literal("tui"), Schema.Literal("tool")]),
  agent: Schema.optionalKey(Schema.String),
  sessionID: Schema.optionalKey(Schema.String),
  messageID: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Plus.Actor" })

export interface LogEntry extends Schema.Schema.Type<typeof LogEntry> {}
export const LogEntry = Schema.Struct({
  ts: Schema.String,
  actor: Actor,
  op: Schema.String,
  target: Schema.String,
  summary: Schema.String,
  revision: Schema.Number,
}).annotate({ identifier: "Plus.LogEntry" })

export interface LogInput extends Schema.Schema.Type<typeof LogInput> {}
export const LogInput = Schema.Struct({
  where: Schema.optionalKey(Schema.String),
  limit: Schema.optionalKey(Schema.Number),
  offset: Schema.optionalKey(Schema.Number),
}).annotate({ identifier: "Plus.LogInput" })

export interface LogOutput extends Schema.Schema.Type<typeof LogOutput> {}
export const LogOutput = Schema.Struct({
  entries: Schema.Array(LogEntry),
  total: Schema.Number,
}).annotate({ identifier: "Plus.LogOutput" })

export interface MutateInput extends Schema.Schema.Type<typeof MutateInput> {}
export const MutateInput = Schema.Struct({
  expectedRevision: Schema.Number,
  expectedGlobalRevision: Schema.Number,
  records: Schema.Array(SnapshotRecord),
  // Who performed the mutation. Callers omit the key when unknown (an
  // explicit undefined fails JSON encoding); the handler treats a missing
  // actor as { type: "tui" }.
  actor: Schema.optionalKey(Actor),
}).annotate({ identifier: "Plus.MutateInput" })

export interface MutateSuccess extends Schema.Schema.Type<typeof MutateSuccess> {}
export const MutateSuccess = Schema.Struct({
  ok: Schema.Literal(true),
  revision: Schema.Number,
  globalRevision: Schema.Number,
  snapshot: Snapshot,
}).annotate({ identifier: "Plus.MutateSuccess" })

export interface MutateConflict extends Schema.Schema.Type<typeof MutateConflict> {}
export const MutateConflict = Schema.Struct({
  ok: Schema.Literal(false),
  reason: Schema.Literal("stale"),
  store: Schema.Union([Schema.Literal("project"), Schema.Literal("global")]),
  snapshot: Snapshot,
}).annotate({ identifier: "Plus.MutateConflict" })

export type MutateResult = typeof MutateResult.Type
export const MutateResult = Schema.Union([MutateSuccess, MutateConflict]).annotate({
  identifier: "Plus.MutateResult",
})

export interface InstructionsChanged extends Schema.Schema.Type<typeof InstructionsChanged> {}
export const InstructionsChanged = Schema.Struct({
  revision: Schema.Number,
  globalRevision: Schema.optionalKey(Schema.Number),
}).annotate({ identifier: "Plus.InstructionsChanged" })

export interface AssembledInput extends Schema.Schema.Type<typeof AssembledInput> {}
export const AssembledInput = Schema.Struct({
  agent: Schema.String,
}).annotate({ identifier: "Plus.AssembledInput" })

export interface AssembledTool extends Schema.Schema.Type<typeof AssembledTool> {}
export const AssembledTool = Schema.Struct({
  id: Schema.String,
  description: Schema.String,
  codemode: Schema.optionalKey(Schema.Boolean),
  pinned: Schema.optionalKey(Schema.Boolean),
}).annotate({ identifier: "Plus.AssembledTool" })

export interface AssembledSkill extends Schema.Schema.Type<typeof AssembledSkill> {}
export const AssembledSkill = Schema.Struct({
  id: Schema.String,
  content: Schema.String,
}).annotate({ identifier: "Plus.AssembledSkill" })

export interface Assembled extends Schema.Schema.Type<typeof Assembled> {}
export const Assembled = Schema.Struct({
  agent: Schema.String,
  system: Schema.Array(Schema.String),
  tools: Schema.Array(AssembledTool),
  skills: Schema.Array(AssembledSkill),
}).annotate({ identifier: "Plus.Assembled" })

export interface AgentPermissionRule extends Schema.Schema.Type<typeof AgentPermissionRule> {}
export const AgentPermissionRule = Schema.Struct({
  action: Schema.String,
  resource: Schema.String,
  effect: Schema.Union([Schema.Literal("allow"), Schema.Literal("deny"), Schema.Literal("ask")]),
}).annotate({ identifier: "Plus.AgentPermissionRule" })

// DESIGN §5: name → preset → done. The agent file carries the preset's
// `mode` and `description` (core reads them from the file) and an empty body;
// a link record makes everything else follow the preset live. No preset is
// "None — everything off": an empty file and no link.
export interface CreateAgentInput extends Schema.Schema.Type<typeof CreateAgentInput> {}
export const CreateAgentInput = Schema.Struct({
  scope: FileScope,
  id: Schema.String,
  preset: Schema.optionalKey(PresetRef),
  // Who performed the write. Callers omit the key when unknown (an explicit
  // undefined fails JSON encoding); the handler treats a missing actor as
  // { type: "tui" }, and a tool actor is refused for protected agents.
  actor: Schema.optionalKey(Actor),
}).annotate({ identifier: "Plus.CreateAgentInput" })

export interface AgentRef extends Schema.Schema.Type<typeof AgentRef> {}
export const AgentRef = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
}).annotate({ identifier: "Plus.AgentRef" })

export interface RenameAgentInput extends Schema.Schema.Type<typeof RenameAgentInput> {}
export const RenameAgentInput = Schema.Struct({
  scope: FileScope,
  from: Schema.String,
  to: Schema.String,
  actor: Schema.optionalKey(Actor),
}).annotate({ identifier: "Plus.RenameAgentInput" })

export interface RenameAgentResult extends Schema.Schema.Type<typeof RenameAgentResult> {}
export const RenameAgentResult = Schema.Struct({
  from: Schema.String,
  to: Schema.String,
  path: Schema.String,
}).annotate({ identifier: "Plus.RenameAgentResult" })

export interface DeleteAgentInput extends Schema.Schema.Type<typeof DeleteAgentInput> {}
export const DeleteAgentInput = Schema.Struct({
  scope: FileScope,
  id: Schema.String,
  actor: Schema.optionalKey(Actor),
}).annotate({ identifier: "Plus.DeleteAgentInput" })

export interface CreateSkillInput extends Schema.Schema.Type<typeof CreateSkillInput> {}
export const CreateSkillInput = Schema.Struct({
  name: Schema.String,
  body: Schema.String,
}).annotate({ identifier: "Plus.CreateSkillInput" })

export interface ImportSkillInput extends Schema.Schema.Type<typeof ImportSkillInput> {}
export const ImportSkillInput = Schema.Struct({
  path: Schema.String,
}).annotate({ identifier: "Plus.ImportSkillInput" })

export interface SkillRef extends Schema.Schema.Type<typeof SkillRef> {}
export const SkillRef = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
}).annotate({ identifier: "Plus.SkillRef" })

export interface DeleteSkillInput extends Schema.Schema.Type<typeof DeleteSkillInput> {}
export const DeleteSkillInput = Schema.Struct({
  id: Schema.String,
}).annotate({ identifier: "Plus.DeleteSkillInput" })

export interface CreateBaseInput extends Schema.Schema.Type<typeof CreateBaseInput> {}
export const CreateBaseInput = Schema.Struct({
  id: Schema.String,
  title: Schema.String,
  text: Schema.String,
}).annotate({ identifier: "Plus.CreateBaseInput" })

export interface BaseRef extends Schema.Schema.Type<typeof BaseRef> {}
export const BaseRef = Schema.Struct({
  id: Schema.String,
}).annotate({ identifier: "Plus.BaseRef" })

export interface DeleteBaseInput extends Schema.Schema.Type<typeof DeleteBaseInput> {}
export const DeleteBaseInput = Schema.Struct({
  id: Schema.String,
}).annotate({ identifier: "Plus.DeleteBaseInput" })

export interface CreateInstructionInput extends Schema.Schema.Type<typeof CreateInstructionInput> {}
export const CreateInstructionInput = Schema.Struct({
  name: Schema.String,
  text: Schema.String,
}).annotate({ identifier: "Plus.CreateInstructionInput" })

export interface InstructionRef extends Schema.Schema.Type<typeof InstructionRef> {}
export const InstructionRef = Schema.Struct({
  id: Schema.String,
  path: Schema.String,
}).annotate({ identifier: "Plus.InstructionRef" })

export interface DeleteInstructionInput extends Schema.Schema.Type<typeof DeleteInstructionInput> {}
export const DeleteInstructionInput = Schema.Struct({
  name: Schema.String,
}).annotate({ identifier: "Plus.DeleteInstructionInput" })

export interface AddMcpInput extends Schema.Schema.Type<typeof AddMcpInput> {}
export const AddMcpInput = Schema.Struct({
  name: Schema.String,
  config: Schema.Record(Schema.String, Schema.Unknown),
}).annotate({ identifier: "Plus.AddMcpInput" })

export interface McpRef extends Schema.Schema.Type<typeof McpRef> {}
export const McpRef = Schema.Struct({
  name: Schema.String,
}).annotate({ identifier: "Plus.McpRef" })

// Toggle one team as a unit. Level scopes the record store (project writes
// the project file, global and defaults write the global file); team names
// the team (an on-disk directory for project/global, a built-in name for
// defaults); enabled is the desired state. A discovered team with no record
// reads as DISABLED. Invalid names fail before touching the store.
export interface SetTeamEnabledInput extends Schema.Schema.Type<typeof SetTeamEnabledInput> {}
export const SetTeamEnabledInput = Schema.Struct({
  level: TeamLevel,
  team: Schema.String,
  enabled: Schema.Boolean,
}).annotate({ identifier: "Plus.SetTeamEnabledInput" })

export interface TeamRef extends Schema.Schema.Type<typeof TeamRef> {}
export const TeamRef = Schema.Struct({
  level: TeamLevel,
  team: Schema.String,
  enabled: Schema.Boolean,
}).annotate({ identifier: "Plus.TeamRef" })

export interface TeamActivation extends Schema.Schema.Type<typeof TeamActivation> {}
export const TeamActivation = Schema.Struct({
  ...TeamRef.fields,
  exclusive: Schema.Literal(true),
  disabledTeams: Schema.Array(Schema.Struct({ level: TeamLevel, team: Schema.String })),
}).annotate({ identifier: "Plus.TeamActivation" })

// Creating a team makes the on-disk team directory without enabling it: a
// newly created team has no record at all, so it reads as DISABLED until
// toggled with team.setEnabled. Creation at defaults is refused (Defaults
// teams are entries: team.addAgent at defaults or entry.create). An optional
// `preset` names a team preset (Plus or User): the team is created with the
// preset's members (same ids), each member file carrying its member preset's
// mode and description with an empty body and linked to that member preset,
// and the team records its own link. Unknown presets fail with `team.invalid`.
export interface CreateTeamInput extends Schema.Schema.Type<typeof CreateTeamInput> {}
export const CreateTeamInput = Schema.Struct({
  level: TeamLevel,
  team: Schema.String,
  preset: Schema.optionalKey(Schema.String),
  actor: Schema.optionalKey(Actor),
}).annotate({ identifier: "Plus.CreateTeamInput" })

// Adding an agent to a team writes `<teamdir>/<id>.md` (project/global) with
// the preset's mode and description and an empty body, plus a team-scoped
// link to the preset. At `defaults` it creates a Teams member ENTRY instead
// (`team` and `id` are patterns; no file; `path` answers the entry's row id):
// see entry.create. Existing member ids fail with `agent.exists` (entries
// with `entry.exists`), invalid ids with `agent.invalid`, unknown presets with
// `preset.invalid`.
export interface TeamAddAgentInput extends Schema.Schema.Type<typeof TeamAddAgentInput> {}
export const TeamAddAgentInput = Schema.Struct({
  level: TeamLevel,
  team: Schema.String,
  id: Schema.String,
  preset: Schema.optionalKey(PresetRef),
  actor: Schema.optionalKey(Actor),
}).annotate({ identifier: "Plus.TeamAddAgentInput" })

// Defaults entries (DESIGN §4): a row named by an exact name or a pattern
// (`*` and `%` match any text), optionally created from a preset. Teams
// entries also carry a team pattern (absent = `*`). `id` in results is the
// entry's tree row id.
export interface EntryCreateInput extends Schema.Schema.Type<typeof EntryCreateInput> {}
export const EntryCreateInput = Schema.Struct({
  catalogue: Catalogue,
  name: Schema.String,
  team: Schema.optionalKey(Schema.String),
  preset: Schema.optionalKey(PresetRef),
  actor: Schema.optionalKey(Actor),
}).annotate({ identifier: "Plus.EntryCreateInput" })

// Deleting a Teams entry without `name` deletes every member entry of that
// team pattern (the team entry row). The entry's own records and link go
// with it.
export interface EntryDeleteInput extends Schema.Schema.Type<typeof EntryDeleteInput> {}
export const EntryDeleteInput = Schema.Struct({
  catalogue: Catalogue,
  name: Schema.optionalKey(Schema.String),
  team: Schema.optionalKey(Schema.String),
  actor: Schema.optionalKey(Actor),
}).annotate({ identifier: "Plus.EntryDeleteInput" })

// Renaming moves the entry's own records and link with it.
export interface EntryRenameInput extends Schema.Schema.Type<typeof EntryRenameInput> {}
export const EntryRenameInput = Schema.Struct({
  catalogue: Catalogue,
  name: Schema.String,
  team: Schema.optionalKey(Schema.String),
  to: Schema.String,
  actor: Schema.optionalKey(Actor),
}).annotate({ identifier: "Plus.EntryRenameInput" })

export interface EntryRef extends Schema.Schema.Type<typeof EntryRef> {}
export const EntryRef = Schema.Struct({
  id: Schema.String,
  catalogue: Catalogue,
  team: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
  removed: Schema.optionalKey(Schema.Number),
}).annotate({ identifier: "Plus.EntryRef" })

// User presets (DESIGN §5): an agent preset (optionally from another agent or
// member preset, linked live), or a team preset (optionally from a team
// preset: its member list is copied, each member linked to the source member).
export type PresetCreateInput = typeof PresetCreateInput.Type
export const PresetCreateInput = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("agent"),
    id: Schema.String,
    from: Schema.optionalKey(PresetRef),
    actor: Schema.optionalKey(Actor),
  }),
  Schema.Struct({
    kind: Schema.Literal("team"),
    id: Schema.String,
    from: Schema.optionalKey(Schema.String),
    actor: Schema.optionalKey(Actor),
  }),
]).annotate({ identifier: "Plus.PresetCreateInput" })

export interface PresetAddMemberInput extends Schema.Schema.Type<typeof PresetAddMemberInput> {}
export const PresetAddMemberInput = Schema.Struct({
  team: Schema.String,
  id: Schema.String,
  from: Schema.optionalKey(PresetRef),
  actor: Schema.optionalKey(Actor),
}).annotate({ identifier: "Plus.PresetAddMemberInput" })

// Deleting a preset that anything links to is refused (`preset.inUse` lists
// the row ids of its users); Native and Plus presets are read-only.
export interface PresetDeleteInput extends Schema.Schema.Type<typeof PresetDeleteInput> {}
export const PresetDeleteInput = Schema.Struct({
  ref: PresetRef,
  /** Delete even though other projects link to it; their links then show as a missing preset. */
  confirm: Schema.optionalKey(Schema.Boolean),
  actor: Schema.optionalKey(Actor),
}).annotate({ identifier: "Plus.PresetDeleteInput" })

export interface PresetResult extends Schema.Schema.Type<typeof PresetResult> {}
export const PresetResult = Schema.Struct({
  id: Schema.String,
  ref: PresetRef,
}).annotate({ identifier: "Plus.PresetResult" })

// Relink (preset) or unlink (null) the owner of a link: an agent (level +
// agent), a team member (+ team), a team (agent null + team), a Defaults
// entry (level defaults; Teams entries with team {defaults, pattern}) or a
// user preset (level preset; member presets with team {preset, team}).
export interface LinkSetInput extends Schema.Schema.Type<typeof LinkSetInput> {}
export const LinkSetInput = Schema.Struct({
  level: Level,
  agent: Schema.NullOr(Schema.String),
  team: Schema.optionalKey(TeamOwner),
  catalogue: Schema.optionalKey(Catalogue),
  preset: Schema.NullOr(PresetRef),
  actor: Schema.optionalKey(Actor),
}).annotate({ identifier: "Plus.LinkSetInput" })

export interface LinkResult extends Schema.Schema.Type<typeof LinkResult> {}
export const LinkResult = Schema.Struct({
  level: Level,
  agent: Schema.NullOr(Schema.String),
  team: Schema.optionalKey(TeamOwner),
  preset: Schema.NullOr(PresetRef),
  /** A team owner: the members relinked to the new team preset's member of the same id (none on unlink). */
  members: Schema.optionalKey(Schema.Array(Schema.Struct({ agent: Schema.String, preset: PresetRef }))),
}).annotate({ identifier: "Plus.LinkResult" })

export interface TeamRemoveAgentInput extends Schema.Schema.Type<typeof TeamRemoveAgentInput> {}
export const TeamRemoveAgentInput = Schema.Struct({
  level: TeamLevel,
  team: Schema.String,
  id: Schema.String,
  actor: Schema.optionalKey(Actor),
}).annotate({ identifier: "Plus.TeamRemoveAgentInput" })

export interface DeleteTeamInput extends Schema.Schema.Type<typeof DeleteTeamInput> {}
export const DeleteTeamInput = Schema.Struct({
  level: TeamLevel,
  team: Schema.String,
  actor: Schema.optionalKey(Actor),
}).annotate({ identifier: "Plus.DeleteTeamInput" })

export interface DeleteTeamResult extends Schema.Schema.Type<typeof DeleteTeamResult> {}
export const DeleteTeamResult = Schema.Struct({
  level: TeamLevel,
  team: Schema.String,
  removedMembers: Schema.Number,
}).annotate({ identifier: "Plus.DeleteTeamResult" })

export type TeamDeleteInput = DeleteTeamInput
export const TeamDeleteInput = DeleteTeamInput
export type TeamDeleteResult = DeleteTeamResult
export const TeamDeleteResult = DeleteTeamResult

export type TeamMemberMode = typeof TeamMemberMode.Type
export const TeamMemberMode = Schema.Union([
  Schema.Literal("subagent"),
  Schema.Literal("primary"),
  Schema.Literal("all"),
]).annotate({ identifier: "Plus.TeamMemberMode" })

export interface TeamMemberEntry extends Schema.Schema.Type<typeof TeamMemberEntry> {}
export const TeamMemberEntry = Schema.Struct({
  id: Schema.String,
  mode: TeamMemberMode,
}).annotate({ identifier: "Plus.TeamMemberEntry" })

export interface TeamListEntry extends Schema.Schema.Type<typeof TeamListEntry> {}
export const TeamListEntry = Schema.Struct({
  level: TeamLevel,
  team: Schema.String,
  enabled: Schema.Boolean,
  members: Schema.Array(TeamMemberEntry),
}).annotate({ identifier: "Plus.TeamListEntry" })

export interface TeamListOutput extends Schema.Schema.Type<typeof TeamListOutput> {}
export const TeamListOutput = Schema.Struct({
  teams: Schema.Array(TeamListEntry),
}).annotate({ identifier: "Plus.TeamListOutput" })

export interface TeamRunEntry extends Schema.Schema.Type<typeof TeamRunEntry> {}
export const TeamRunEntry = Schema.Struct({
  id: Schema.String,
  role: Schema.String,
  state: Schema.String,
  task: Schema.NullOr(Schema.String),
  head: Schema.String,
  worktree: Schema.String,
  lastUsed: Schema.String,
  sessionID: Schema.NullOr(Schema.String),
  parent: Schema.NullOr(Schema.String),
}).annotate({ identifier: "Plus.TeamRunEntry" })

export interface TeamRunsListInput extends Schema.Schema.Type<typeof TeamRunsListInput> {}
export const TeamRunsListInput = Schema.Struct({
  all: Schema.optional(Schema.Boolean),
}).annotate({ identifier: "Plus.TeamRunsListInput" })

export interface TeamRunsListOutput extends Schema.Schema.Type<typeof TeamRunsListOutput> {}
export const TeamRunsListOutput = Schema.Struct({
  runs: Schema.Array(TeamRunEntry),
}).annotate({ identifier: "Plus.TeamRunsListOutput" })

export interface TeamRunsStopInput extends Schema.Schema.Type<typeof TeamRunsStopInput> {}
export const TeamRunsStopInput = Schema.Struct({
  run: Schema.String,
}).annotate({ identifier: "Plus.TeamRunsStopInput" })

export interface TeamRunsStopOutput extends Schema.Schema.Type<typeof TeamRunsStopOutput> {}
export const TeamRunsStopOutput = Schema.Struct({
  run: Schema.String,
  state: Schema.String,
}).annotate({ identifier: "Plus.TeamRunsStopOutput" })

export interface RunBusy extends Schema.Schema.Type<typeof RunBusy> {}
export const RunBusy = Schema.Struct({
  message: Schema.String,
}).annotate({ identifier: "Plus.RunBusy" })

export interface RunUnknown extends Schema.Schema.Type<typeof RunUnknown> {}
export const RunUnknown = Schema.Struct({
  message: Schema.String,
}).annotate({ identifier: "Plus.RunUnknown" })

export interface TeamsChanged extends Schema.Schema.Type<typeof TeamsChanged> {}
export const TeamsChanged = Schema.Struct({}).annotate({ identifier: "Plus.TeamsChanged" })

export interface ProjectDisabled extends Schema.Schema.Type<typeof ProjectDisabled> {}
export const ProjectDisabled = Schema.Struct({
  directory: Schema.String,
}).annotate({ identifier: "Plus.ProjectDisabled" })

export interface AgentExists extends Schema.Schema.Type<typeof AgentExists> {}
export const AgentExists = Schema.Struct({
  path: Schema.String,
}).annotate({ identifier: "Plus.AgentExists" })

export interface AgentMissing extends Schema.Schema.Type<typeof AgentMissing> {}
export const AgentMissing = Schema.Struct({
  path: Schema.String,
}).annotate({ identifier: "Plus.AgentMissing" })

export interface AgentInvalid extends Schema.Schema.Type<typeof AgentInvalid> {}
export const AgentInvalid = Schema.Struct({
  id: Schema.String,
  reason: Schema.String,
}).annotate({ identifier: "Plus.AgentInvalid" })

export interface AgentUnknown extends Schema.Schema.Type<typeof AgentUnknown> {}
export const AgentUnknown = Schema.Struct({
  agent: Schema.String,
}).annotate({ identifier: "Plus.AgentUnknown" })

// A write whose actor is a tool addressed a row owned by an agent listed in
// `protectedAgents`. `id` names the addressed row or input when it differs
// from the protected agent id. Only tool-originated writes refuse; TUI writes
// are unaffected.
export interface AgentProtected extends Schema.Schema.Type<typeof AgentProtected> {}
export const AgentProtected = Schema.Struct({
  agent: Schema.String,
  id: Schema.optionalKey(Schema.String),
  reason: Schema.String,
}).annotate({ identifier: "Plus.AgentProtected" })

export interface SkillExists extends Schema.Schema.Type<typeof SkillExists> {}
export const SkillExists = Schema.Struct({
  id: Schema.String,
}).annotate({ identifier: "Plus.SkillExists" })

export interface SkillMissing extends Schema.Schema.Type<typeof SkillMissing> {}
export const SkillMissing = Schema.Struct({
  id: Schema.String,
}).annotate({ identifier: "Plus.SkillMissing" })

export interface SkillInvalid extends Schema.Schema.Type<typeof SkillInvalid> {}
export const SkillInvalid = Schema.Struct({
  id: Schema.String,
  reason: Schema.String,
}).annotate({ identifier: "Plus.SkillInvalid" })

export interface BaseExists extends Schema.Schema.Type<typeof BaseExists> {}
export const BaseExists = Schema.Struct({
  id: Schema.String,
}).annotate({ identifier: "Plus.BaseExists" })

export interface BaseMissing extends Schema.Schema.Type<typeof BaseMissing> {}
export const BaseMissing = Schema.Struct({
  id: Schema.String,
}).annotate({ identifier: "Plus.BaseMissing" })

export interface BaseInvalid extends Schema.Schema.Type<typeof BaseInvalid> {}
export const BaseInvalid = Schema.Struct({
  id: Schema.String,
  reason: Schema.String,
}).annotate({ identifier: "Plus.BaseInvalid" })

export interface InstructionExists extends Schema.Schema.Type<typeof InstructionExists> {}
export const InstructionExists = Schema.Struct({
  path: Schema.String,
}).annotate({ identifier: "Plus.InstructionExists" })

export interface InstructionMissing extends Schema.Schema.Type<typeof InstructionMissing> {}
export const InstructionMissing = Schema.Struct({
  name: Schema.String,
}).annotate({ identifier: "Plus.InstructionMissing" })

export interface InstructionInvalid extends Schema.Schema.Type<typeof InstructionInvalid> {}
export const InstructionInvalid = Schema.Struct({
  name: Schema.String,
  reason: Schema.String,
}).annotate({ identifier: "Plus.InstructionInvalid" })

export interface McpExists extends Schema.Schema.Type<typeof McpExists> {}
export const McpExists = Schema.Struct({
  name: Schema.String,
}).annotate({ identifier: "Plus.McpExists" })

export interface McpMissing extends Schema.Schema.Type<typeof McpMissing> {}
export const McpMissing = Schema.Struct({
  name: Schema.String,
}).annotate({ identifier: "Plus.McpMissing" })

export interface McpInvalid extends Schema.Schema.Type<typeof McpInvalid> {}
export const McpInvalid = Schema.Struct({
  name: Schema.String,
  reason: Schema.String,
}).annotate({ identifier: "Plus.McpInvalid" })

export interface TeamInvalid extends Schema.Schema.Type<typeof TeamInvalid> {}
export const TeamInvalid = Schema.Struct({
  team: Schema.String,
  reason: Schema.String,
}).annotate({ identifier: "Plus.TeamInvalid" })

export interface TeamUnknown extends Schema.Schema.Type<typeof TeamUnknown> {}
export const TeamUnknown = Schema.Struct({
  level: TeamLevel,
  team: Schema.String,
}).annotate({ identifier: "Plus.TeamUnknown" })

export interface TeamExists extends Schema.Schema.Type<typeof TeamExists> {}
export const TeamExists = Schema.Struct({
  level: TeamLevel,
  team: Schema.String,
}).annotate({ identifier: "Plus.TeamExists" })

export interface TeamCreate extends Schema.Schema.Type<typeof TeamCreate> {}
export const TeamCreate = Schema.Struct({
  level: TeamLevel,
  team: Schema.String,
  reason: Schema.String,
}).annotate({ identifier: "Plus.TeamCreate" })

// Presets, Defaults entries and links (DESIGN §5). `id` names the input the
// refusal is about; `users` are the tree row ids of everything linked to a
// preset that cannot be deleted.
export interface PresetInvalid extends Schema.Schema.Type<typeof PresetInvalid> {}
export const PresetInvalid = Schema.Struct({
  id: Schema.String,
  reason: Schema.String,
}).annotate({ identifier: "Plus.PresetInvalid" })

export interface PresetExists extends Schema.Schema.Type<typeof PresetExists> {}
export const PresetExists = Schema.Struct({
  ref: PresetRef,
}).annotate({ identifier: "Plus.PresetExists" })

export interface PresetReadonly extends Schema.Schema.Type<typeof PresetReadonly> {}
export const PresetReadonly = Schema.Struct({
  ref: PresetRef,
  reason: Schema.String,
}).annotate({ identifier: "Plus.PresetReadonly" })

export interface PresetInUse extends Schema.Schema.Type<typeof PresetInUse> {}
export const PresetInUse = Schema.Struct({
  ref: PresetRef,
  /** Every owner row still linked to the preset; another project's rows read `<directory> › <row id>`. */
  users: Schema.Array(Schema.String),
  /** The users in other projects, per project; `confirm` deletes over them. */
  elsewhere: Schema.optionalKey(Schema.Array(Schema.Struct({ directory: Schema.String, users: Schema.Array(Schema.String) }))),
}).annotate({ identifier: "Plus.PresetInUse" })

export interface EntryInvalid extends Schema.Schema.Type<typeof EntryInvalid> {}
export const EntryInvalid = Schema.Struct({
  name: Schema.String,
  reason: Schema.String,
}).annotate({ identifier: "Plus.EntryInvalid" })

export interface EntryExists extends Schema.Schema.Type<typeof EntryExists> {}
export const EntryExists = Schema.Struct({
  catalogue: Catalogue,
  team: Schema.optionalKey(Schema.String),
  name: Schema.String,
}).annotate({ identifier: "Plus.EntryExists" })

export interface EntryMissing extends Schema.Schema.Type<typeof EntryMissing> {}
export const EntryMissing = Schema.Struct({
  catalogue: Catalogue,
  team: Schema.optionalKey(Schema.String),
  name: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Plus.EntryMissing" })

export interface LinkInvalid extends Schema.Schema.Type<typeof LinkInvalid> {}
export const LinkInvalid = Schema.Struct({
  reason: Schema.String,
}).annotate({ identifier: "Plus.LinkInvalid" })

// Linking would make a preset reach itself: `through` lists the presets on
// the way back (presetKey form).
export interface LinkCycle extends Schema.Schema.Type<typeof LinkCycle> {}
export const LinkCycle = Schema.Struct({
  preset: PresetRef,
  through: Schema.Array(Schema.String),
}).annotate({ identifier: "Plus.LinkCycle" })

// Per-agent model selection: candidates are stored ModelRecords, one row per
// distinct (provider, model, variant). Adding stores an inactive row;
// activation flips it exclusive at that (level, agent); reset clears only
// that level's active flag; remove deletes the row at that address.
export interface ModelAddInput extends Schema.Schema.Type<typeof ModelAddInput> {}
export const ModelAddInput = Schema.Struct({
  level: Level,
  agent: Schema.NullOr(Schema.String),
  team: Schema.optionalKey(TeamOwner),
  catalogue: Schema.optionalKey(Catalogue),
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optionalKey(Schema.String),
  actor: Schema.optionalKey(Actor),
}).annotate({ identifier: "Plus.ModelAddInput" })

export interface ModelRemoveInput extends Schema.Schema.Type<typeof ModelRemoveInput> {}
export const ModelRemoveInput = Schema.Struct({
  level: Level,
  agent: Schema.NullOr(Schema.String),
  team: Schema.optionalKey(TeamOwner),
  catalogue: Schema.optionalKey(Catalogue),
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optionalKey(Schema.String),
  actor: Schema.optionalKey(Actor),
}).annotate({ identifier: "Plus.ModelRemoveInput" })

export interface ModelRef extends Schema.Schema.Type<typeof ModelRef> {}
export const ModelRef = Schema.Struct({
  level: Level,
  agent: Schema.NullOr(Schema.String),
  team: Schema.optionalKey(TeamOwner),
  catalogue: Schema.optionalKey(Catalogue),
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optionalKey(Schema.String),
  active: Schema.optionalKey(Schema.Literal(true)),
}).annotate({ identifier: "Plus.ModelRef" })

export interface CatalogModel extends Schema.Schema.Type<typeof CatalogModel> {}
export const CatalogModel = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optionalKey(Schema.String),
  name: Schema.String,
}).annotate({ identifier: "Plus.CatalogModel" })

export interface CatalogModelsOutput extends Schema.Schema.Type<typeof CatalogModelsOutput> {}
export const CatalogModelsOutput = Schema.Struct({
  models: Schema.Array(CatalogModel),
}).annotate({ identifier: "Plus.CatalogModelsOutput" })

export interface ModelExists extends Schema.Schema.Type<typeof ModelExists> {}
export const ModelExists = Schema.Struct({
  level: Level,
  agent: Schema.NullOr(Schema.String),
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Plus.ModelExists" })

export interface ModelMissing extends Schema.Schema.Type<typeof ModelMissing> {}
export const ModelMissing = Schema.Struct({
  level: Level,
  agent: Schema.NullOr(Schema.String),
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optionalKey(Schema.String),
}).annotate({ identifier: "Plus.ModelMissing" })

export interface ModelInvalid extends Schema.Schema.Type<typeof ModelInvalid> {}
export const ModelInvalid = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optionalKey(Schema.String),
  reason: Schema.String,
}).annotate({ identifier: "Plus.ModelInvalid" })

// Tool-specific permission rules (phase 3). A RuleRecord defines a user-added
// rule; toggling any rule (curated, mined, or custom) is a CustomizationRecord
// with state on/off on the perm item address. Patterns are CORE RESOURCE
// WILDCARDS over the parsed command text, NOT regex: `*` spans any run, `?`
// matches one character. For shell the resource is the parsed command text,
// so `git *` also matches a bare `git`. `message` is the optional refusal
// text the model reads in place of the generic denial; blank clears it.
// `catalogue` on `rule.add` picks where a new shared (`agent: null`) rule
// lands; on `rule.update` it names the addressed row's catalogue, which a
// first write (a curated/mined override) materialises into. A matched
// existing rule keeps the catalogue and team it was stored with, so editing
// a message never moves a Teams rule into the Agents catalogue.
export interface RuleAddInput extends Schema.Schema.Type<typeof RuleAddInput> {}
export const RuleAddInput = Schema.Struct({
  level: Level,
  agent: Schema.NullOr(Schema.String),
  catalogue: Schema.optionalKey(Catalogue),
  tool: Schema.String,
  id: Schema.String,
  label: Schema.String,
  patterns: Schema.Array(Schema.String),
  keywords: Schema.optionalKey(Schema.Array(Schema.String)),
  message: Schema.optionalKey(Schema.String),
  actor: Schema.optionalKey(Actor),
}).annotate({ identifier: "Plus.RuleAddInput" })

export interface RuleRemoveInput extends Schema.Schema.Type<typeof RuleRemoveInput> {}
export const RuleRemoveInput = Schema.Struct({
  level: Level,
  agent: Schema.NullOr(Schema.String),
  tool: Schema.String,
  id: Schema.String,
  actor: Schema.optionalKey(Actor),
}).annotate({ identifier: "Plus.RuleRemoveInput" })

export interface RuleUpdateInput extends Schema.Schema.Type<typeof RuleUpdateInput> {}
export const RuleUpdateInput = Schema.Struct({
  level: Level,
  agent: Schema.NullOr(Schema.String),
  catalogue: Schema.optionalKey(Catalogue),
  tool: Schema.String,
  id: Schema.String,
  label: Schema.String,
  patterns: Schema.Array(Schema.String),
  keywords: Schema.optionalKey(Schema.Array(Schema.String)),
  message: Schema.optionalKey(Schema.String),
  actor: Schema.optionalKey(Actor),
}).annotate({ identifier: "Plus.RuleUpdateInput" })

export interface RuleRef extends Schema.Schema.Type<typeof RuleRef> {}
export const RuleRef = Schema.Struct({
  level: Level,
  agent: Schema.NullOr(Schema.String),
  tool: Schema.String,
  id: Schema.String,
  label: Schema.String,
}).annotate({ identifier: "Plus.RuleRef" })

export interface RuleExists extends Schema.Schema.Type<typeof RuleExists> {}
export const RuleExists = Schema.Struct({
  level: Level,
  agent: Schema.NullOr(Schema.String),
  tool: Schema.String,
  id: Schema.String,
}).annotate({ identifier: "Plus.RuleExists" })

export interface RuleMissing extends Schema.Schema.Type<typeof RuleMissing> {}
export const RuleMissing = Schema.Struct({
  level: Level,
  agent: Schema.NullOr(Schema.String),
  tool: Schema.String,
  id: Schema.String,
}).annotate({ identifier: "Plus.RuleMissing" })

export interface RuleInvalid extends Schema.Schema.Type<typeof RuleInvalid> {}
export const RuleInvalid = Schema.Struct({
  tool: Schema.String,
  id: Schema.String,
  reason: Schema.String,
}).annotate({ identifier: "Plus.RuleInvalid" })

// The TUI promise client only accepts portable schemas (Standard Schema or
// JSON Schema views), which bare Effect schemas structurally lack. Wrap fresh
// annotated copies so the shared exports above are never mutated in place.
const Empty = Schema.toStandardSchemaV1(Schema.Void.annotate({ identifier: "Plus.Empty" }))
const PortableStatus = Schema.toStandardSchemaV1(Status.annotate({ identifier: "Plus.Status" }))
const PortableSnapshot = Schema.toStandardSchemaV1(Snapshot.annotate({ identifier: "Plus.Snapshot" }))
const PortableMutateInput = Schema.toStandardSchemaV1(MutateInput.annotate({ identifier: "Plus.MutateInput" }))
const PortableMutateResult = Schema.toStandardSchemaV1(MutateResult.annotate({ identifier: "Plus.MutateResult" }))
const PortableAssembledInput = Schema.toStandardSchemaV1(
  AssembledInput.annotate({ identifier: "Plus.AssembledInput" }),
)
const PortableAssembled = Schema.toStandardSchemaV1(Assembled.annotate({ identifier: "Plus.Assembled" }))
const PortableInstructionsChanged = Schema.toStandardSchemaV1(
  InstructionsChanged.annotate({ identifier: "Plus.InstructionsChanged" }),
)
const PortableCreateAgentInput = Schema.toStandardSchemaV1(
  CreateAgentInput.annotate({ identifier: "Plus.CreateAgentInput" }),
)
const PortableAgentRef = Schema.toStandardSchemaV1(AgentRef.annotate({ identifier: "Plus.AgentRef" }))
const PortableRenameAgentInput = Schema.toStandardSchemaV1(
  RenameAgentInput.annotate({ identifier: "Plus.RenameAgentInput" }),
)
const PortableRenameAgentResult = Schema.toStandardSchemaV1(
  RenameAgentResult.annotate({ identifier: "Plus.RenameAgentResult" }),
)
const PortableDeleteAgentInput = Schema.toStandardSchemaV1(
  DeleteAgentInput.annotate({ identifier: "Plus.DeleteAgentInput" }),
)
const PortableCreateSkillInput = Schema.toStandardSchemaV1(
  CreateSkillInput.annotate({ identifier: "Plus.CreateSkillInput" }),
)
const PortableImportSkillInput = Schema.toStandardSchemaV1(
  ImportSkillInput.annotate({ identifier: "Plus.ImportSkillInput" }),
)
const PortableSkillRef = Schema.toStandardSchemaV1(SkillRef.annotate({ identifier: "Plus.SkillRef" }))
const PortableDeleteSkillInput = Schema.toStandardSchemaV1(
  DeleteSkillInput.annotate({ identifier: "Plus.DeleteSkillInput" }),
)
const PortableCreateBaseInput = Schema.toStandardSchemaV1(
  CreateBaseInput.annotate({ identifier: "Plus.CreateBaseInput" }),
)
const PortableDeleteBaseInput = Schema.toStandardSchemaV1(
  DeleteBaseInput.annotate({ identifier: "Plus.DeleteBaseInput" }),
)
const PortableBaseRef = Schema.toStandardSchemaV1(BaseRef.annotate({ identifier: "Plus.BaseRef" }))
const PortableCreateInstructionInput = Schema.toStandardSchemaV1(
  CreateInstructionInput.annotate({ identifier: "Plus.CreateInstructionInput" }),
)
const PortableDeleteInstructionInput = Schema.toStandardSchemaV1(
  DeleteInstructionInput.annotate({ identifier: "Plus.DeleteInstructionInput" }),
)
const PortableInstructionRef = Schema.toStandardSchemaV1(
  InstructionRef.annotate({ identifier: "Plus.InstructionRef" }),
)
const PortableAddMcpInput = Schema.toStandardSchemaV1(AddMcpInput.annotate({ identifier: "Plus.AddMcpInput" }))
const PortableMcpRef = Schema.toStandardSchemaV1(McpRef.annotate({ identifier: "Plus.McpRef" }))
const PortableSetTeamEnabledInput = Schema.toStandardSchemaV1(
  SetTeamEnabledInput.annotate({ identifier: "Plus.SetTeamEnabledInput" }),
)
const PortableTeamRef = Schema.toStandardSchemaV1(TeamRef.annotate({ identifier: "Plus.TeamRef" }))
const PortableTeamActivation = Schema.toStandardSchemaV1(TeamActivation)
const PortableCreateTeamInput = Schema.toStandardSchemaV1(
  CreateTeamInput.annotate({ identifier: "Plus.CreateTeamInput" }),
)
const PortableTeamAddAgentInput = Schema.toStandardSchemaV1(
  TeamAddAgentInput.annotate({ identifier: "Plus.TeamAddAgentInput" }),
)
const PortableTeamRemoveAgentInput = Schema.toStandardSchemaV1(
  TeamRemoveAgentInput.annotate({ identifier: "Plus.TeamRemoveAgentInput" }),
)
const PortableDeleteTeamInput = Schema.toStandardSchemaV1(
  DeleteTeamInput.annotate({ identifier: "Plus.DeleteTeamInput" }),
)
const PortableDeleteTeamResult = Schema.toStandardSchemaV1(
  DeleteTeamResult.annotate({ identifier: "Plus.DeleteTeamResult" }),
)
const PortableTeamListOutput = Schema.toStandardSchemaV1(
  TeamListOutput.annotate({ identifier: "Plus.TeamListOutput" }),
)
const PortableTeamRunsListInput = Schema.toStandardSchemaV1(
  TeamRunsListInput.annotate({ identifier: "Plus.TeamRunsListInput" }),
)
const PortableTeamRunsListOutput = Schema.toStandardSchemaV1(
  TeamRunsListOutput.annotate({ identifier: "Plus.TeamRunsListOutput" }),
)
const PortableTeamRunsStopInput = Schema.toStandardSchemaV1(
  TeamRunsStopInput.annotate({ identifier: "Plus.TeamRunsStopInput" }),
)
const PortableTeamRunsStopOutput = Schema.toStandardSchemaV1(
  TeamRunsStopOutput.annotate({ identifier: "Plus.TeamRunsStopOutput" }),
)
const PortableRunBusy = Schema.toStandardSchemaV1(
  RunBusy.annotate({ identifier: "Plus.RunBusy" }),
)
const PortableRunUnknown = Schema.toStandardSchemaV1(
  RunUnknown.annotate({ identifier: "Plus.RunUnknown" }),
)
const PortableTeamsChanged = Schema.toStandardSchemaV1(
  TeamsChanged.annotate({ identifier: "Plus.TeamsChanged" }),
)
const PortableLogInput = Schema.toStandardSchemaV1(LogInput.annotate({ identifier: "Plus.LogInput" }))
const PortableLogOutput = Schema.toStandardSchemaV1(LogOutput.annotate({ identifier: "Plus.LogOutput" }))

const PortableProjectDisabled = Schema.toStandardSchemaV1(
  ProjectDisabled.annotate({ identifier: "Plus.ProjectDisabled" }),
)
const PortableAgentExists = Schema.toStandardSchemaV1(AgentExists.annotate({ identifier: "Plus.AgentExists" }))
const PortableAgentMissing = Schema.toStandardSchemaV1(AgentMissing.annotate({ identifier: "Plus.AgentMissing" }))
const PortableAgentInvalid = Schema.toStandardSchemaV1(AgentInvalid.annotate({ identifier: "Plus.AgentInvalid" }))
const PortableAgentUnknown = Schema.toStandardSchemaV1(AgentUnknown.annotate({ identifier: "Plus.AgentUnknown" }))
const PortableAgentProtected = Schema.toStandardSchemaV1(
  AgentProtected.annotate({ identifier: "Plus.AgentProtected" }),
)
const PortableSkillExists = Schema.toStandardSchemaV1(SkillExists.annotate({ identifier: "Plus.SkillExists" }))
const PortableSkillMissing = Schema.toStandardSchemaV1(SkillMissing.annotate({ identifier: "Plus.SkillMissing" }))
const PortableSkillInvalid = Schema.toStandardSchemaV1(SkillInvalid.annotate({ identifier: "Plus.SkillInvalid" }))
const PortableBaseExists = Schema.toStandardSchemaV1(BaseExists.annotate({ identifier: "Plus.BaseExists" }))
const PortableBaseMissing = Schema.toStandardSchemaV1(BaseMissing.annotate({ identifier: "Plus.BaseMissing" }))
const PortableBaseInvalid = Schema.toStandardSchemaV1(BaseInvalid.annotate({ identifier: "Plus.BaseInvalid" }))
const PortableInstructionExists = Schema.toStandardSchemaV1(
  InstructionExists.annotate({ identifier: "Plus.InstructionExists" }),
)
const PortableInstructionMissing = Schema.toStandardSchemaV1(
  InstructionMissing.annotate({ identifier: "Plus.InstructionMissing" }),
)
const PortableInstructionInvalid = Schema.toStandardSchemaV1(
  InstructionInvalid.annotate({ identifier: "Plus.InstructionInvalid" }),
)
const PortableMcpExists = Schema.toStandardSchemaV1(McpExists.annotate({ identifier: "Plus.McpExists" }))
const PortableMcpMissing = Schema.toStandardSchemaV1(McpMissing.annotate({ identifier: "Plus.McpMissing" }))
const PortableMcpInvalid = Schema.toStandardSchemaV1(McpInvalid.annotate({ identifier: "Plus.McpInvalid" }))
const PortableTeamInvalid = Schema.toStandardSchemaV1(TeamInvalid.annotate({ identifier: "Plus.TeamInvalid" }))
const PortableTeamUnknown = Schema.toStandardSchemaV1(TeamUnknown.annotate({ identifier: "Plus.TeamUnknown" }))
const PortableTeamExists = Schema.toStandardSchemaV1(TeamExists.annotate({ identifier: "Plus.TeamExists" }))
const PortableTeamCreate = Schema.toStandardSchemaV1(TeamCreate.annotate({ identifier: "Plus.TeamCreate" }))
const PortableEntryCreateInput = Schema.toStandardSchemaV1(
  EntryCreateInput.annotate({ identifier: "Plus.EntryCreateInput" }),
)
const PortableEntryDeleteInput = Schema.toStandardSchemaV1(
  EntryDeleteInput.annotate({ identifier: "Plus.EntryDeleteInput" }),
)
const PortableEntryRenameInput = Schema.toStandardSchemaV1(
  EntryRenameInput.annotate({ identifier: "Plus.EntryRenameInput" }),
)
const PortableEntryRef = Schema.toStandardSchemaV1(EntryRef.annotate({ identifier: "Plus.EntryRef" }))
const PortablePresetCreateInput = Schema.toStandardSchemaV1(
  PresetCreateInput.annotate({ identifier: "Plus.PresetCreateInput" }),
)
const PortablePresetAddMemberInput = Schema.toStandardSchemaV1(
  PresetAddMemberInput.annotate({ identifier: "Plus.PresetAddMemberInput" }),
)
const PortablePresetDeleteInput = Schema.toStandardSchemaV1(
  PresetDeleteInput.annotate({ identifier: "Plus.PresetDeleteInput" }),
)
const PortablePresetResult = Schema.toStandardSchemaV1(PresetResult.annotate({ identifier: "Plus.PresetResult" }))
const PortableLinkSetInput = Schema.toStandardSchemaV1(LinkSetInput.annotate({ identifier: "Plus.LinkSetInput" }))
const PortableLinkResult = Schema.toStandardSchemaV1(LinkResult.annotate({ identifier: "Plus.LinkResult" }))
const PortablePresetInvalid = Schema.toStandardSchemaV1(PresetInvalid.annotate({ identifier: "Plus.PresetInvalid" }))
const PortablePresetExists = Schema.toStandardSchemaV1(PresetExists.annotate({ identifier: "Plus.PresetExists" }))
const PortablePresetReadonly = Schema.toStandardSchemaV1(PresetReadonly.annotate({ identifier: "Plus.PresetReadonly" }))
const PortablePresetInUse = Schema.toStandardSchemaV1(PresetInUse.annotate({ identifier: "Plus.PresetInUse" }))
const PortableEntryInvalid = Schema.toStandardSchemaV1(EntryInvalid.annotate({ identifier: "Plus.EntryInvalid" }))
const PortableEntryExists = Schema.toStandardSchemaV1(EntryExists.annotate({ identifier: "Plus.EntryExists" }))
const PortableEntryMissing = Schema.toStandardSchemaV1(EntryMissing.annotate({ identifier: "Plus.EntryMissing" }))
const PortableLinkInvalid = Schema.toStandardSchemaV1(LinkInvalid.annotate({ identifier: "Plus.LinkInvalid" }))
const PortableLinkCycle = Schema.toStandardSchemaV1(LinkCycle.annotate({ identifier: "Plus.LinkCycle" }))
const PortableModelAddInput = Schema.toStandardSchemaV1(ModelAddInput.annotate({ identifier: "Plus.ModelAddInput" }))
const PortableModelRemoveInput = Schema.toStandardSchemaV1(
  ModelRemoveInput.annotate({ identifier: "Plus.ModelRemoveInput" }),
)
const PortableModelRef = Schema.toStandardSchemaV1(ModelRef.annotate({ identifier: "Plus.ModelRef" }))
const PortableCatalogModelsOutput = Schema.toStandardSchemaV1(
  CatalogModelsOutput.annotate({ identifier: "Plus.CatalogModelsOutput" }),
)
const PortableModelExists = Schema.toStandardSchemaV1(ModelExists.annotate({ identifier: "Plus.ModelExists" }))
const PortableModelMissing = Schema.toStandardSchemaV1(ModelMissing.annotate({ identifier: "Plus.ModelMissing" }))
const PortableModelInvalid = Schema.toStandardSchemaV1(ModelInvalid.annotate({ identifier: "Plus.ModelInvalid" }))
const PortableRuleAddInput = Schema.toStandardSchemaV1(RuleAddInput.annotate({ identifier: "Plus.RuleAddInput" }))
const PortableRuleRemoveInput = Schema.toStandardSchemaV1(
  RuleRemoveInput.annotate({ identifier: "Plus.RuleRemoveInput" }),
)
const PortableRuleUpdateInput = Schema.toStandardSchemaV1(
  RuleUpdateInput.annotate({ identifier: "Plus.RuleUpdateInput" }),
)
const PortableRuleRef = Schema.toStandardSchemaV1(RuleRef.annotate({ identifier: "Plus.RuleRef" }))
const PortableRuleExists = Schema.toStandardSchemaV1(RuleExists.annotate({ identifier: "Plus.RuleExists" }))
const PortableRuleMissing = Schema.toStandardSchemaV1(RuleMissing.annotate({ identifier: "Plus.RuleMissing" }))
const PortableRuleInvalid = Schema.toStandardSchemaV1(RuleInvalid.annotate({ identifier: "Plus.RuleInvalid" }))

export const Definition = Rpc.define({
  id: "opencode.plus",
  methods: {
    "project.status": {
      input: Empty,
      output: PortableStatus,
    },
    "project.enable": {
      input: Empty,
      output: PortableStatus,
    },
    "project.disable": {
      input: Empty,
      output: PortableStatus,
    },
    "instructions.snapshot": {
      input: Empty,
      output: PortableSnapshot,
      errors: {
        "project.disabled": PortableProjectDisabled,
      },
    },
    "instructions.refresh": {
      input: Empty,
      output: PortableSnapshot,
      errors: {
        "project.disabled": PortableProjectDisabled,
      },
    },
    "instructions.mutate": {
      input: PortableMutateInput,
      output: PortableMutateResult,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "agent.protected": PortableAgentProtected,
        "agent.invalid": PortableAgentInvalid,
      },
    },
    "instructions.log": {
      input: PortableLogInput,
      output: PortableLogOutput,
      errors: {
        "project.disabled": PortableProjectDisabled,
      },
    },
    "instructions.assembled": {
      input: PortableAssembledInput,
      output: PortableAssembled,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "agent.unknown": PortableAgentUnknown,
      },
    },
    "agent.create": {
      input: PortableCreateAgentInput,
      output: PortableAgentRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "agent.exists": PortableAgentExists,
        "agent.invalid": PortableAgentInvalid,
        "agent.protected": PortableAgentProtected,
        "preset.invalid": PortablePresetInvalid,
      },
    },
    "agent.rename": {
      input: PortableRenameAgentInput,
      output: PortableRenameAgentResult,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "agent.missing": PortableAgentMissing,
        "agent.exists": PortableAgentExists,
        "agent.invalid": PortableAgentInvalid,
        "agent.protected": PortableAgentProtected,
      },
    },
    "agent.delete": {
      input: PortableDeleteAgentInput,
      output: PortableAgentRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "agent.missing": PortableAgentMissing,
        "agent.invalid": PortableAgentInvalid,
        "agent.protected": PortableAgentProtected,
      },
    },
    "skill.create": {
      input: PortableCreateSkillInput,
      output: PortableSkillRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "skill.exists": PortableSkillExists,
        "skill.invalid": PortableSkillInvalid,
      },
    },
    "skill.import": {
      input: PortableImportSkillInput,
      output: PortableSkillRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "skill.exists": PortableSkillExists,
        "skill.invalid": PortableSkillInvalid,
      },
    },
    "skill.delete": {
      input: PortableDeleteSkillInput,
      output: PortableSkillRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "skill.missing": PortableSkillMissing,
        "skill.invalid": PortableSkillInvalid,
      },
    },
    "base.create": {
      input: PortableCreateBaseInput,
      output: PortableBaseRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "base.exists": PortableBaseExists,
        "base.invalid": PortableBaseInvalid,
      },
    },
    "base.delete": {
      input: PortableDeleteBaseInput,
      output: PortableBaseRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "base.missing": PortableBaseMissing,
        "base.invalid": PortableBaseInvalid,
      },
    },
    "instruction.create": {
      input: PortableCreateInstructionInput,
      output: PortableInstructionRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "instruction.exists": PortableInstructionExists,
        "instruction.invalid": PortableInstructionInvalid,
      },
    },
    "instruction.delete": {
      input: PortableDeleteInstructionInput,
      output: PortableInstructionRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "instruction.missing": PortableInstructionMissing,
        "instruction.invalid": PortableInstructionInvalid,
      },
    },
    "mcp.add": {
      input: PortableAddMcpInput,
      output: PortableMcpRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "mcp.exists": PortableMcpExists,
        "mcp.invalid": PortableMcpInvalid,
      },
    },
    "mcp.remove": {
      input: PortableMcpRef,
      output: PortableMcpRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "mcp.missing": PortableMcpMissing,
        "mcp.invalid": PortableMcpInvalid,
      },
    },
    "team.create": {
      input: PortableCreateTeamInput,
      output: PortableTeamRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "team.exists": PortableTeamExists,
        "team.invalid": PortableTeamInvalid,
        "team.create": PortableTeamCreate,
        "agent.protected": PortableAgentProtected,
      },
    },
    "team.setEnabled": {
      input: PortableSetTeamEnabledInput,
      output: PortableTeamActivation,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "team.unknown": PortableTeamUnknown,
        "team.invalid": PortableTeamInvalid,
      },
    },
    "team.addAgent": {
      input: PortableTeamAddAgentInput,
      output: PortableAgentRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "team.unknown": PortableTeamUnknown,
        "team.invalid": PortableTeamInvalid,
        "agent.exists": PortableAgentExists,
        "agent.invalid": PortableAgentInvalid,
        "agent.protected": PortableAgentProtected,
        "preset.invalid": PortablePresetInvalid,
        "entry.invalid": PortableEntryInvalid,
        "entry.exists": PortableEntryExists,
      },
    },
    "team.removeAgent": {
      input: PortableTeamRemoveAgentInput,
      output: PortableAgentRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "team.unknown": PortableTeamUnknown,
        "team.invalid": PortableTeamInvalid,
        "agent.invalid": PortableAgentInvalid,
        "agent.protected": PortableAgentProtected,
      },
    },
    "team.delete": {
      input: PortableDeleteTeamInput,
      output: PortableDeleteTeamResult,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "team.unknown": PortableTeamUnknown,
        "team.invalid": PortableTeamInvalid,
        "agent.protected": PortableAgentProtected,
      },
    },
    "team.list": {
      input: Empty,
      output: PortableTeamListOutput,
      errors: {
        "project.disabled": PortableProjectDisabled,
      },
    },
    "team.runs.list": {
      input: PortableTeamRunsListInput,
      output: PortableTeamRunsListOutput,
      errors: {},
    },
    "team.runs.stop": {
      input: PortableTeamRunsStopInput,
      output: PortableTeamRunsStopOutput,
      errors: {
        "E_BUSY": PortableRunBusy,
        "run.unknown": PortableRunUnknown,
      },
    },
    "model.add": {
      input: PortableModelAddInput,
      output: PortableModelRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "model.exists": PortableModelExists,
        "model.invalid": PortableModelInvalid,
        "agent.protected": PortableAgentProtected,
      },
    },
    "model.remove": {
      input: PortableModelRemoveInput,
      output: PortableModelRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "model.missing": PortableModelMissing,
        "model.invalid": PortableModelInvalid,
        "agent.protected": PortableAgentProtected,
      },
    },
    "catalog.models": {
      input: Empty,
      output: PortableCatalogModelsOutput,
      errors: {
        "project.disabled": PortableProjectDisabled,
      },
    },
    "rule.add": {
      input: PortableRuleAddInput,
      output: PortableRuleRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "rule.exists": PortableRuleExists,
        "rule.invalid": PortableRuleInvalid,
        "agent.protected": PortableAgentProtected,
      },
    },
    "rule.remove": {
      input: PortableRuleRemoveInput,
      output: PortableRuleRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "rule.missing": PortableRuleMissing,
        "rule.invalid": PortableRuleInvalid,
        "agent.protected": PortableAgentProtected,
      },
    },
    "rule.update": {
      input: PortableRuleUpdateInput,
      output: PortableRuleRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "rule.invalid": PortableRuleInvalid,
        "agent.protected": PortableAgentProtected,
      },
    },
    "entry.create": {
      input: PortableEntryCreateInput,
      output: PortableEntryRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "entry.invalid": PortableEntryInvalid,
        "entry.exists": PortableEntryExists,
        "preset.invalid": PortablePresetInvalid,
      },
    },
    "entry.delete": {
      input: PortableEntryDeleteInput,
      output: PortableEntryRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "entry.invalid": PortableEntryInvalid,
        "entry.missing": PortableEntryMissing,
      },
    },
    "entry.rename": {
      input: PortableEntryRenameInput,
      output: PortableEntryRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "entry.invalid": PortableEntryInvalid,
        "entry.exists": PortableEntryExists,
        "entry.missing": PortableEntryMissing,
      },
    },
    "preset.create": {
      input: PortablePresetCreateInput,
      output: PortablePresetResult,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "preset.invalid": PortablePresetInvalid,
        "preset.exists": PortablePresetExists,
      },
    },
    "preset.addMember": {
      input: PortablePresetAddMemberInput,
      output: PortablePresetResult,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "preset.invalid": PortablePresetInvalid,
        "preset.exists": PortablePresetExists,
        "preset.readonly": PortablePresetReadonly,
      },
    },
    "preset.delete": {
      input: PortablePresetDeleteInput,
      output: PortablePresetResult,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "preset.invalid": PortablePresetInvalid,
        "preset.readonly": PortablePresetReadonly,
        "preset.inUse": PortablePresetInUse,
      },
    },
    "link.set": {
      input: PortableLinkSetInput,
      output: PortableLinkResult,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "link.invalid": PortableLinkInvalid,
        "link.cycle": PortableLinkCycle,
        "preset.invalid": PortablePresetInvalid,
        "preset.readonly": PortablePresetReadonly,
        "agent.protected": PortableAgentProtected,
      },
    },
  },
  events: {
    "project.changed": {
      schema: PortableStatus,
    },
    "instructions.changed": {
      schema: PortableInstructionsChanged,
    },
    "teams.changed": {
      schema: PortableTeamsChanged,
    },
  },
})
