import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { runRegistration } from "./instructions/apply.js"
import { changedLines, unifiedDiff } from "./instructions/diff-lines.js"
import {
  activateModelRow,
  addSection,
  editRefusalForLabel,
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
  setPin,
  teamPlan,
  toggle,
  unknownRowRefusal,
  type OpFailure,
  type RemovalPlan,
} from "./instructions/ops.js"
import { query } from "./instructions/query.js"
import { applies, parseModelItemId, parsePermItemId, resolve, resolveSplit, scopesOf, threeWay, upstreamForEdit } from "./instructions/model.js"
import { scrubLines } from "./instructions/tool-permissions.js"
import type { CustomizationRecord, ModelRecord, RuleRecord, SplitRecord } from "./instructions/model.js"
import type { MemoInput } from "./instructions/tree.js"
import { memoInputOf } from "./instructions/snapshot.js"
import { expandedTree } from "./instructions/tree.js"
import type { PlusApi } from "./index.js"
import { Plus } from "./rpc.js"

const namespace = "instructions"
const origin = { type: "plugin", name: "opencode.plus" } as const
const options = { namespace, codemode: true, permission: "instructions" } as const

const ListDescription =
  "Filter instruction rows; `where` uses `key:value` terms (grammar in skill `instructions-tools`).\n" +
  "Fields select the projection, sort orders rows, limit defaults to 40. Reads never refuse for protection."

const ShowDescription =
  "Read one row: resolved text (default), diff, record, sections, or an agent's assembled view.\n" +
  "Views: resolved (default), upstream, mine, diff, record, sections, assembled (agent rows only).\n" +
  "Diff returns two unified diffs (original→mine, original→upstream) plus a one-line summary."

const SetDescription =
  "Save an override, toggle, pin, activate a model, or resolve a review row (TUI Enter/Space/p/k/t/e).\n" +
  "With text save an override, with state on|off toggle explicitly, with pin true|false pin a Code Mode tool, with active true activate a model row, with resolve keep|take|edit resolve review.\n" +
  "On a perm row with label+patterns (keywords optional) update the rule. Bare id toggles (model rows activate). Writes pass actor tool and retry once when stale."

const ResetDescription =
  "Drop the override at this level only (TUI `r`).\n" +
  "Removes the stored text/state at the addressed row (model rows clear only that level's active flag). Writes pass actor tool and retry once when stale."

const SplitDescription =
  "Set manual sections or append one (TUI `s` / `a` on an item).\n" +
  "Pass boundaries [{id,name,start}] to set manual sections, or add {name,text} to append one."

const CreateDescription =
  "Create a file-backed row, a team directory, a model candidate, or a permission rule (TUI `a`).\n" +
  "Kinds: agent (id+prompt, scope defaults to project, template/fields optional), skill (name+body),\n" +
  "base (id+title+text), instruction (name+text), mcp (name+config), team (team+level, created disabled),\n" +
  "model (providerID+modelID, variant/level/agent optional; level defaults to project),\n" +
  "rule (tool+id+label+patterns, keywords/level/agent optional; patterns are core wildcards, not regex).\n" +
  "catalogue agents|teams (default agents) picks which catalogue a shared Defaults model or rule lands in;\n" +
  "base/instruction/mcp create one file both catalogues list, so catalogue does not change what is written."

const DeleteDescription =
  "Delete a project-owned row; refuses without `confirm`.\n" +
  "Pass confirm:true to delete. Resolves the row through the TUI removal plan and deletes the file."

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
])

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
  text: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.Union([Schema.Literal("on"), Schema.Literal("off")])),
  pin: Schema.optionalKey(Schema.Boolean),
  active: Schema.optionalKey(Schema.Boolean),
  resolve: Schema.optionalKey(Schema.Union([Schema.Literal("keep"), Schema.Literal("take"), Schema.Literal("edit")])),
  label: Schema.optionalKey(Schema.String),
  patterns: Schema.optionalKey(Schema.Array(Schema.String)),
  keywords: Schema.optionalKey(Schema.Array(Schema.String)),
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
    Schema.Literal("model"),
    Schema.Literal("rule"),
  ]),
  id: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.Union([Schema.Literal("project"), Schema.Literal("global"), Schema.Literal("defaults")])),
  template: Schema.optionalKey(Schema.String),
  fields: Schema.optionalKey(Plus.CreateAgentFields),
  name: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  config: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  team: Schema.optionalKey(Schema.String),
  level: Schema.optionalKey(Schema.Union([Schema.Literal("project"), Schema.Literal("global"), Schema.Literal("defaults")])),
  catalogue: Schema.optionalKey(Plus.Catalogue),
  providerID: Schema.optionalKey(Schema.String),
  modelID: Schema.optionalKey(Schema.String),
  variant: Schema.optionalKey(Schema.String),
  agent: Schema.optionalKey(Schema.String),
  tool: Schema.optionalKey(Schema.String),
  label: Schema.optionalKey(Schema.String),
  patterns: Schema.optionalKey(Schema.Array(Schema.String)),
  keywords: Schema.optionalKey(Schema.Array(Schema.String)),
})

const DeleteInput = Schema.Struct({
  id: Schema.String,
  confirm: Schema.optionalKey(Schema.Boolean),
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
          if (node.kind === "team") return yield* setTeam(api, memo, input.id, actor, input)
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
          return yield* deletePlan(api, plan, actor)
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
        item: record.item,
        section: record.section,
        ...(record.text === undefined ? {} : { text: record.text }),
        ...(record.state === undefined ? {} : { state: record.state }),
        ...(record.pin === undefined ? {} : { pin: record.pin }),
        basedOn: record.basedOn,
        ...(record.basedOnText === undefined ? {} : { basedOnText: record.basedOnText }),
        ...(record.acknowledged === undefined ? {} : { acknowledged: record.acknowledged }),
        updated: record.updated,
      }),
    ),
    ...splits.map(
      (split): Plus.SnapshotRecord => ({
        type: "split",
        level: split.level,
        agent: split.agent,
        ...(split.team !== undefined ? { team: split.team } : {}),
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
        providerID: record.providerID,
        modelID: record.modelID,
        ...(record.variant === undefined ? {} : { variant: record.variant }),
        ...(record.active === undefined ? {} : { active: record.active }),
        updated: record.updated,
      }),
    ),
    ...(rules ?? []).map(
      (record): Plus.SnapshotRecord => ({
        type: "rule",
        level: record.level,
        agent: record.agent,
        ...(record.team !== undefined ? { team: record.team } : {}),
        tool: record.tool,
        id: record.id,
        label: record.label,
        patterns: [...record.patterns],
        keywords: [...record.keywords],
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

function findRow(memo: MemoInput, id: string) {
  return expandedTree(memo).find((node) => node.id === id)
}

function protectedOf(snapshot: Plus.Snapshot, node: { kind: string; id: string; address?: { agent: string | null } }): string | undefined {
  if (node.kind === "agent") {
    const agent = node.id.split(":").slice(2).join(":")
    if (agent !== "" && snapshot.protectedAgents.includes(agent)) return agent
    return undefined
  }
  const owner = node.address?.agent
  if (owner !== undefined && owner !== null && snapshot.protectedAgents.includes(owner)) return owner
  return undefined
}

function computeSet(
  memo: MemoInput,
  input: { id: string; text?: string; state?: "on" | "off"; pin?: boolean; resolve?: "keep" | "take" | "edit" },
) {
  const preserved = modelsOfMemo(memo)
  const preservedRules = rulesOfMemo(memo)
  const withModels = (records: readonly CustomizationRecord[], splits: readonly SplitRecord[]): MemoInput => ({
    ...memo,
    records: [...records, ...splits, ...preserved, ...preservedRules],
  })
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
    if (input.text !== undefined) return yield* Effect.fail(new Tool.Error({ message: editRefusalForLabel(label) }))
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
  input: { text?: string; state?: "on" | "off"; pin?: boolean; active?: boolean; resolve?: "keep" | "take" | "edit"; label?: string; patterns?: readonly string[]; keywords?: readonly string[] },
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const node = findRow(memo, id)
    const label = node?.label ?? id
    if (input.label !== undefined || input.patterns !== undefined || input.keywords !== undefined)
      return yield* updateRuleRow(api, snapshot, memo, id, actor, {
        ...(input.label === undefined ? {} : { label: input.label }),
        ...(input.patterns === undefined ? {} : { patterns: input.patterns }),
        ...(input.keywords === undefined ? {} : { keywords: input.keywords }),
      })
    if (input.text !== undefined) return yield* Effect.fail(new Tool.Error({ message: editRefusalForLabel(label) }))
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
  input: { label?: string; patterns?: readonly string[]; keywords?: readonly string[] },
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const found = findRow(memo, id)
    const address = found?.address
    if (address === undefined) return yield* Effect.fail(unknownError(id))
    const parsed = parsePermItemId(address.item)
    if (parsed === undefined) return yield* Effect.fail(unknownError(id))
    if (input.label === undefined || input.patterns === undefined)
      return yield* Effect.fail(new Tool.Error({ message: "set rule requires label and patterns" }))
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
    const result = yield* Effect.promise(() =>
      api.updateRule({
        level: address.level,
        agent: address.agent,
        tool: parsed.tool,
        id: parsed.ruleId,
        label: input.label as string,
        patterns: [...(input.patterns as readonly string[])],
        ...(input.keywords === undefined ? {} : { keywords: [...input.keywords] }),
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
    if (!id.startsWith("agent:"))
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
    if (node.address === undefined)
      return yield* Effect.fail(new Tool.Error({ message: `view.unsupported: ${view} view needs an addressed row (got ${id})` }))
    const address = node.address
    const customizations = memo.records.filter(
      (record): record is CustomizationRecord => record.type === "customization",
    )
    const splits = memo.records.filter((record): record is SplitRecord => record.type === "split")
    const scopes = scopesOf(memo.agents)
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
          scrub: { hidden: scrubbed.hidden, preview: [...scrubbed.preview] },
        },
      }
    }
    const chain = { upstream, records: customizations, splits, scopes, address }
    if (view === "resolved") {
      const resolved = resolve(chain)
      return { output: { id, view, text: resolved.text, assembled: resolved.assembled, enabled: resolved.enabled, source: resolved.source } }
    }
    if (view === "upstream") return { output: { id, view, text: upstreamForEdit(chain) } }
    if (view === "mine") {
      const own = customizations.find(
        (record) => record.level === address.level && record.agent === address.agent && record.item === address.item && record.section === address.section,
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

function upstreamOf(memo: MemoInput, address: { item: string; agent: string | null }) {
  const matches = memo.items.filter((item) => item.id === address.item)
  if (address.agent === null) return matches[0]
  return matches.find((item) => applies(item, address.agent as string)) ?? matches[0]
}

function recordOfRow(
  memo: MemoInput,
  address: { level: CustomizationRecord["level"]; agent: string | null; item: string; section: string | null },
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
        record.item === address.item &&
        record.section === address.section,
    ) ?? null
  )
}

function createRow(
  api: PlusApi,
  input: {
    kind: "agent" | "skill" | "base" | "instruction" | "mcp" | "team" | "model" | "rule"
    id?: string
    prompt?: string
    scope?: "project" | "global" | "defaults"
    template?: string
    fields?: Plus.CreateAgentInput["fields"]
    name?: string
    body?: string
    title?: string
    text?: string
    config?: Record<string, unknown>
    team?: string
    level?: "project" | "global" | "defaults"
    catalogue?: Plus.Catalogue
    providerID?: string
    modelID?: string
    variant?: string
    agent?: string
    tool?: string
    label?: string
    patterns?: readonly string[]
    keywords?: readonly string[]
  },
  actor: Plus.Actor,
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    if (input.kind === "agent") {
      if (input.id === undefined || input.prompt === undefined)
        return yield* Effect.fail(new Tool.Error({ message: "create agent requires id and prompt" }))
      const scope = input.scope ?? "project"
      if (scope !== "project" && scope !== "global")
        return yield* Effect.fail(new Tool.Error({ message: "create agent requires scope project|global" }))
      const snapshot = yield* snapshotOrFail(api)
      const candidate = input.id.trim()
      if (candidate !== "" && snapshot.protectedAgents.includes(candidate))
        return yield* Effect.fail(protectedError(candidate))
      const created = yield* Effect.promise(() =>
        api.createAgent({
          scope,
          id: input.id as string,
          ...(input.template === undefined ? {} : { template: input.template }),
          ...(input.fields === undefined ? {} : { fields: input.fields }),
          prompt: input.prompt as string,
          actor,
        }),
      )
      if (!created.ok) return yield* Effect.fail(new Tool.Error({ message: `${created.error.code}: ${created.error.message}` }))
      return { output: created.value }
    }
    if (input.kind === "skill") {
      if (input.name === undefined || input.body === undefined)
        return yield* Effect.fail(new Tool.Error({ message: "create skill requires name and body" }))
      const created = yield* Effect.promise(() => api.createSkill({ name: input.name as string, body: input.body as string, actor }))
      if (!created.ok) return yield* Effect.fail(new Tool.Error({ message: `${created.error.code}: ${created.error.message}` }))
      return { output: created.value }
    }
    if (input.kind === "base") {
      if (input.id === undefined || input.title === undefined || input.text === undefined)
        return yield* Effect.fail(new Tool.Error({ message: "create base requires id, title, and text" }))
      const created = yield* Effect.promise(() =>
        api.createBase({ id: input.id as string, title: input.title as string, text: input.text as string, actor }),
      )
      if (!created.ok) return yield* Effect.fail(new Tool.Error({ message: `${created.error.code}: ${created.error.message}` }))
      return { output: created.value }
    }
    if (input.kind === "instruction") {
      if (input.name === undefined || input.text === undefined)
        return yield* Effect.fail(new Tool.Error({ message: "create instruction requires name and text" }))
      const created = yield* Effect.promise(() =>
        api.createInstruction({ name: input.name as string, text: input.text as string, actor }),
      )
      if (!created.ok) return yield* Effect.fail(new Tool.Error({ message: `${created.error.code}: ${created.error.message}` }))
      return { output: created.value }
    }
    if (input.kind === "mcp") {
      if (input.name === undefined || input.config === undefined)
        return yield* Effect.fail(new Tool.Error({ message: "create mcp requires name and config" }))
      const created = yield* Effect.promise(() => api.addMcp({ name: input.name as string, config: { ...(input.config as Record<string, unknown>) }, actor }))
      if (!created.ok) return yield* Effect.fail(new Tool.Error({ message: `${created.error.code}: ${created.error.message}` }))
      return { output: created.value }
    }
    if (input.kind === "team") {
      if (input.team === undefined || input.level === undefined)
        return yield* Effect.fail(new Tool.Error({ message: "create team requires team and level" }))
      const created = yield* Effect.promise(() =>
        api.createTeam({ level: input.level as "project" | "global", team: input.team as string, actor }),
      )
      if (!created.ok) return yield* Effect.fail(new Tool.Error({ message: `${created.error.code}: ${created.error.message}` }))
      return { output: created.value }
    }
    if (input.kind === "model") {
      if (input.providerID === undefined || input.modelID === undefined)
        return yield* Effect.fail(new Tool.Error({ message: "create model requires providerID and modelID" }))
      const level = input.level ?? input.scope ?? "project"
      if (level !== "project" && level !== "global" && level !== "defaults")
        return yield* Effect.fail(new Tool.Error({ message: "create model requires level project|global|defaults" }))
      const rawAgent = input.agent?.trim() ?? ""
      if (level !== "defaults" && rawAgent.length === 0)
        return yield* Effect.fail(new Tool.Error({ message: "create model requires agent for project|global levels" }))
      const agent = level === "defaults" && (rawAgent.length === 0 || rawAgent === "_") ? null : rawAgent
      const snapshot = yield* snapshotOrFail(api)
      if (agent !== null && snapshot.protectedAgents.includes(agent))
        return yield* Effect.fail(protectedError(agent))
      const created = yield* Effect.promise(() =>
        api.addModel({
          level,
          agent,
          ...(input.catalogue === undefined ? {} : { catalogue: input.catalogue }),
          providerID: input.providerID as string,
          modelID: input.modelID as string,
          ...(input.variant === undefined ? {} : { variant: input.variant }),
          actor,
        }),
      )
      if (!created.ok) return yield* Effect.fail(new Tool.Error({ message: `${created.error.code}: ${created.error.message}` }))
      return { output: created.value }
    }
    if (input.kind === "rule") {
      if (input.tool === undefined || input.id === undefined || input.label === undefined || input.patterns === undefined)
        return yield* Effect.fail(new Tool.Error({ message: "create rule requires tool, id, label, and patterns" }))
      const level = input.level ?? input.scope ?? "project"
      if (level !== "project" && level !== "global" && level !== "defaults")
        return yield* Effect.fail(new Tool.Error({ message: "create rule requires level project|global|defaults" }))
      const rawAgent = input.agent?.trim() ?? ""
      const agent = rawAgent.length === 0 || rawAgent === "_" ? null : rawAgent
      const snapshot = yield* snapshotOrFail(api)
      if (agent !== null && snapshot.protectedAgents.includes(agent))
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
          actor,
        }),
      )
      if (!created.ok) return yield* Effect.fail(new Tool.Error({ message: `${created.error.code}: ${created.error.message}` }))
      return { output: created.value }
    }
    return yield* Effect.fail(new Tool.Error({ message: `create unknown kind ${input.kind}` }))
  })
}

type ExecutableRemovalPlan = Exclude<RemovalPlan, OpFailure>

function deletePlan(
  api: PlusApi,
  plan: ExecutableRemovalPlan,
  actor: Plus.Actor,
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
    const result = yield* Effect.promise(() =>
      api.removeTeamAgent({ level: plan.level, team: plan.team, id: plan.id, actor }),
    )
    if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
    return { output: { ...result.value, status: plan.successStatus } }
  })
}
