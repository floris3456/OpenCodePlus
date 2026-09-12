export * as Plus from "./rpc.js"

import { Schema } from "effect"
import { Rpc } from "@opencode/schema/rpc"

export interface Status extends Schema.Schema.Type<typeof Status> {}
export const Status = Schema.Struct({
  enabled: Schema.Boolean,
  directory: Schema.String,
}).annotate({ identifier: "Plus.Status" })

export interface SnapshotCustomization extends Schema.Schema.Type<typeof SnapshotCustomization> {}
export const SnapshotCustomization = Schema.Struct({
  item: Schema.String,
  agent: Schema.String,
  text: Schema.optional(Schema.String),
  state: Schema.Union([Schema.Literal("inherit"), Schema.Literal("enabled"), Schema.Literal("disabled")]),
  basedOn: Schema.String,
  reviewed: Schema.optional(Schema.String),
  updated: Schema.String,
}).annotate({ identifier: "Plus.SnapshotCustomization" })

export interface SnapshotItem extends Schema.Schema.Type<typeof SnapshotItem> {}
export const SnapshotItem = Schema.Struct({
  id: Schema.String,
  kind: Schema.Union([
    Schema.Literal("prompt"),
    Schema.Literal("skill"),
    Schema.Literal("tool"),
    Schema.Literal("mcp"),
    Schema.Literal("instruction"),
  ]),
  owner: Schema.String,
  title: Schema.String,
  text: Schema.String,
  agents: Schema.Array(Schema.String),
  fingerprint: Schema.String,
  available: Schema.Boolean,
}).annotate({ identifier: "Plus.SnapshotItem" })

export interface AgentEntry extends Schema.Schema.Type<typeof AgentEntry> {}
export const AgentEntry = Schema.Struct({
  id: Schema.String,
  scope: Schema.Union([Schema.Literal("project"), Schema.Literal("global"), Schema.Literal("builtin")]),
  path: Schema.optional(Schema.String),
  fileBacked: Schema.Boolean,
}).annotate({ identifier: "Plus.AgentEntry" })

export interface Snapshot extends Schema.Schema.Type<typeof Snapshot> {}
export const Snapshot = Schema.Struct({
  revision: Schema.Number,
  agents: Schema.Array(AgentEntry),
  items: Schema.Array(SnapshotItem),
  customizations: Schema.Array(SnapshotCustomization),
}).annotate({ identifier: "Plus.Snapshot" })

export interface MutateInput extends Schema.Schema.Type<typeof MutateInput> {}
export const MutateInput = Schema.Struct({
  expectedRevision: Schema.Number,
  customizations: Schema.Array(SnapshotCustomization),
}).annotate({ identifier: "Plus.MutateInput" })

export interface MutateSuccess extends Schema.Schema.Type<typeof MutateSuccess> {}
export const MutateSuccess = Schema.Struct({
  ok: Schema.Literal(true),
  revision: Schema.Number,
  snapshot: Snapshot,
}).annotate({ identifier: "Plus.MutateSuccess" })

export interface MutateConflict extends Schema.Schema.Type<typeof MutateConflict> {}
export const MutateConflict = Schema.Struct({
  ok: Schema.Literal(false),
  reason: Schema.Literal("stale"),
  snapshot: Snapshot,
}).annotate({ identifier: "Plus.MutateConflict" })

export type MutateResult = typeof MutateResult.Type
export const MutateResult = Schema.Union([MutateSuccess, MutateConflict]).annotate({
  identifier: "Plus.MutateResult",
})

export interface InstructionsChanged extends Schema.Schema.Type<typeof InstructionsChanged> {}
export const InstructionsChanged = Schema.Struct({
  revision: Schema.Number,
}).annotate({ identifier: "Plus.InstructionsChanged" })

export type FileScope = typeof FileScope.Type
export const FileScope = Schema.Union([Schema.Literal("project"), Schema.Literal("global")]).annotate({
  identifier: "Plus.FileScope",
})

export interface AgentPermissionRule extends Schema.Schema.Type<typeof AgentPermissionRule> {}
export const AgentPermissionRule = Schema.Struct({
  action: Schema.String,
  resource: Schema.String,
  effect: Schema.Union([Schema.Literal("allow"), Schema.Literal("deny"), Schema.Literal("ask")]),
}).annotate({ identifier: "Plus.AgentPermissionRule" })

export interface CreateAgentFields extends Schema.Schema.Type<typeof CreateAgentFields> {}
export const CreateAgentFields = Schema.Struct({
  model: Schema.optional(Schema.String),
  variant: Schema.optional(Schema.String),
  request: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  description: Schema.optional(Schema.String),
  mode: Schema.optional(Schema.Union([Schema.Literal("subagent"), Schema.Literal("primary"), Schema.Literal("all")])),
  hidden: Schema.optional(Schema.Boolean),
  color: Schema.optional(Schema.String),
  steps: Schema.optional(Schema.Int),
  disabled: Schema.optional(Schema.Boolean),
  permissions: Schema.optional(Schema.Array(AgentPermissionRule)),
}).annotate({ identifier: "Plus.CreateAgentFields" })

export interface CreateAgentInput extends Schema.Schema.Type<typeof CreateAgentInput> {}
export const CreateAgentInput = Schema.Struct({
  scope: FileScope,
  id: Schema.String,
  fields: Schema.optional(CreateAgentFields),
  prompt: Schema.String,
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
}).annotate({ identifier: "Plus.DeleteAgentInput" })

const ProjectDisabled = Schema.Struct({
  directory: Schema.String,
}).annotate({ identifier: "Plus.ProjectDisabled" })

const AgentExists = Schema.Struct({
  path: Schema.String,
}).annotate({ identifier: "Plus.AgentExists" })

const AgentMissing = Schema.Struct({
  path: Schema.String,
}).annotate({ identifier: "Plus.AgentMissing" })

// The TUI promise client only accepts portable schemas (Standard Schema or
// JSON Schema views), which bare Effect schemas structurally lack. Wrap fresh
// annotated copies so the shared exports above are never mutated in place.
const Empty = Schema.toStandardSchemaV1(Schema.Void.annotate({ identifier: "Plus.Empty" }))
const PortableStatus = Schema.toStandardSchemaV1(Status.annotate({ identifier: "Plus.Status" }))
const PortableSnapshot = Schema.toStandardSchemaV1(Snapshot.annotate({ identifier: "Plus.Snapshot" }))
const PortableMutateInput = Schema.toStandardSchemaV1(MutateInput.annotate({ identifier: "Plus.MutateInput" }))
const PortableMutateResult = Schema.toStandardSchemaV1(MutateResult.annotate({ identifier: "Plus.MutateResult" }))
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
const PortableProjectDisabled = Schema.toStandardSchemaV1(
  ProjectDisabled.annotate({ identifier: "Plus.ProjectDisabled" }),
)
const PortableAgentExists = Schema.toStandardSchemaV1(AgentExists.annotate({ identifier: "Plus.AgentExists" }))
const PortableAgentMissing = Schema.toStandardSchemaV1(AgentMissing.annotate({ identifier: "Plus.AgentMissing" }))

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
    "instructions.mutate": {
      input: PortableMutateInput,
      output: PortableMutateResult,
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
    "agent.create": {
      input: PortableCreateAgentInput,
      output: PortableAgentRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "agent.exists": PortableAgentExists,
      },
    },
    "agent.rename": {
      input: PortableRenameAgentInput,
      output: PortableRenameAgentResult,
      errors: {
        "project.disabled": PortableProjectDisabled,
        "agent.missing": PortableAgentMissing,
        "agent.exists": PortableAgentExists,
      },
    },
    "agent.delete": {
      input: PortableDeleteAgentInput,
      output: PortableAgentRef,
      errors: {
        "project.disabled": PortableProjectDisabled,
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
  },
})
