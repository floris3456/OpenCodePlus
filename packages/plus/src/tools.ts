import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { runRegistration } from "./instructions/apply.js"
import { changedLines, unifiedDiff } from "./instructions/diff-lines.js"
import {
  addSection,
  editRefusalForLabel,
  removalPlan,
  reset,
  resolveRefusalForLabel,
  resolveReview,
  saveSplit,
  saveText,
  setEnabled,
  teamPlan,
  toggle,
  unknownRowRefusal,
} from "./instructions/ops.js"
import { query } from "./instructions/query.js"
import { applies, resolve, resolveSplit, scopesOf, threeWay, upstreamForEdit } from "./instructions/model.js"
import type { CustomizationRecord, SplitRecord } from "./instructions/model.js"
import type { MemoInput } from "./instructions/tree.js"
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
  "Save an override, toggle, or resolve a review row (TUI Enter/Space/k/t/e).\n" +
  "With text save an override, with state on|off toggle explicitly, with resolve keep|take|edit resolve review.\n" +
  "Bare id toggles. Writes pass actor tool and retry once when stale."

const ResetDescription =
  "Drop the override at this level only (TUI `r`).\n" +
  "Removes the stored text/state at the addressed row. Writes pass actor tool and retry once when stale."

const SplitDescription =
  "Set manual sections or append one (TUI `s` / `a` on an item).\n" +
  "Pass boundaries [{id,name,start}] to set manual sections, or add {name,text} to append one."

const CreateDescription =
  "Create a file-backed row or a team directory (TUI `a`).\n" +
  "Kinds: agent (id+prompt, scope defaults to project, template/fields optional), skill (name+body),\n" +
  "base (id+title+text), instruction (name+text), mcp (name+config), team (team+level, created disabled)."

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
  resolve: Schema.optionalKey(Schema.Union([Schema.Literal("keep"), Schema.Literal("take"), Schema.Literal("edit")])),
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
  ]),
  id: Schema.optionalKey(Schema.String),
  prompt: Schema.optionalKey(Schema.String),
  scope: Schema.optionalKey(Schema.Union([Schema.Literal("project"), Schema.Literal("global")])),
  template: Schema.optionalKey(Schema.String),
  fields: Schema.optionalKey(Plus.CreateAgentFields),
  name: Schema.optionalKey(Schema.String),
  body: Schema.optionalKey(Schema.String),
  title: Schema.optionalKey(Schema.String),
  text: Schema.optionalKey(Schema.String),
  config: Schema.optionalKey(Schema.Record(Schema.String, Schema.Unknown)),
  team: Schema.optionalKey(Schema.String),
  level: Schema.optionalKey(Schema.Union([Schema.Literal("project"), Schema.Literal("global")])),
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
  return {
    items: snapshot.items.map((item) => ({
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
    })),
    records: snapshot.records.map((record) => {
      if (record.type === "split")
        return {
          type: "split",
          level: record.level,
          agent: record.agent,
          item: record.item,
          boundaries: record.boundaries.map((boundary) => ({ ...boundary })),
          updated: record.updated,
        } as SplitRecord
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
      } as CustomizationRecord
    }),
    agents: snapshot.agents.map((agent) => ({
      id: agent.id,
      scope: agent.scope,
      ...(agent.path === undefined ? {} : { path: agent.path }),
      ...(agent.base === undefined ? {} : { base: agent.base }),
    })),
    teams: (snapshot.teams ?? []).map((team) => ({
      level: team.level,
      team: team.team,
      enabled: team.enabled,
      agents: [...team.agents],
    })),
  }
}

function toSnapshotRecords(records: readonly CustomizationRecord[], splits: readonly SplitRecord[]): Plus.SnapshotRecord[] {
  return [
    ...records.map(
      (record): Plus.SnapshotRecord => ({
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
      }),
    ),
    ...splits.map(
      (split): Plus.SnapshotRecord => ({
        type: "split",
        level: split.level,
        agent: split.agent,
        item: split.item,
        boundaries: split.boundaries.map((boundary) => ({ ...boundary })),
        updated: split.updated,
      }),
    ),
  ]
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

function computeSet(memo: MemoInput, input: { id: string; text?: string; state?: "on" | "off"; resolve?: "keep" | "take" | "edit" }) {
  if (input.resolve !== undefined) return resolveReview(memo, input.id, input.resolve, input.text)
  if (input.text !== undefined && input.state !== undefined) {
    const first = saveText(memo, input.id, input.text)
    if ("refusal" in first) return first
    const interim: MemoInput = { ...memo, records: [...first.records, ...first.splits] }
    return setEnabled(interim, input.id, input.state === "on")
  }
  if (input.text !== undefined) return saveText(memo, input.id, input.text)
  if (input.state !== undefined) return setEnabled(memo, input.id, input.state === "on")
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
  op: { records: CustomizationRecord[]; splits: SplitRecord[]; status: string },
  actor: Plus.Actor,
  recompute: (fresh: Plus.Snapshot) => { records: CustomizationRecord[]; splits: SplitRecord[]; status: string } | { refusal: string },
): Effect.Effect<{ revision: number; globalRevision: number; status: string }, Tool.Error> {
  return Effect.gen(function* () {
    const first = yield* Effect.promise(() =>
      api.mutate({
        expectedRevision: snapshot.revision,
        expectedGlobalRevision: snapshot.globalRevision,
        records: toSnapshotRecords(op.records, op.splits),
        actor,
      }),
    )
    if (!first.ok) return yield* Effect.fail(new Tool.Error({ message: `project.disabled: ${first.error.message}` }))
    if (first.value.ok) return { revision: first.value.revision, globalRevision: first.value.globalRevision, status: op.status }
    const fresh = yield* Effect.promise(() => api.snapshot())
    if (!fresh.ok) return yield* Effect.fail(new Tool.Error({ message: `project.disabled: ${fresh.error.message}` }))
    const retry = recompute(fresh.value)
    if ("refusal" in retry) return yield* Effect.fail(new Tool.Error({ message: retry.refusal }))
    const second = yield* Effect.promise(() =>
      api.mutate({
        expectedRevision: fresh.value.revision,
        expectedGlobalRevision: fresh.value.globalRevision,
        records: toSnapshotRecords(retry.records, retry.splits),
        actor,
      }),
    )
    if (!second.ok) return yield* Effect.fail(new Tool.Error({ message: `project.disabled: ${second.error.message}` }))
    if (second.value.ok)
      return { revision: second.value.revision, globalRevision: second.value.globalRevision, status: retry.status }
    return yield* Effect.fail(new Tool.Error({ message: "stale: write conflicted twice; re-read and retry" }))
  })
}

function setTeam(
  api: PlusApi,
  memo: MemoInput,
  id: string,
  actor: Plus.Actor,
  input: { state?: "on" | "off"; text?: string; resolve?: "keep" | "take" | "edit" },
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    const node = findRow(memo, id)
    const label = node?.label ?? id
    if (input.text !== undefined) return yield* Effect.fail(new Tool.Error({ message: editRefusalForLabel(label) }))
    if (input.resolve !== undefined) return yield* Effect.fail(new Tool.Error({ message: resolveRefusalForLabel(label) }))
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
    if (view === "record") {
      const own = customizations.find(
        (record) => record.level === address.level && record.agent === address.agent && record.item === address.item && record.section === address.section,
      )
      return { output: { id, view, record: own ?? null } }
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

function createRow(
  api: PlusApi,
  input: {
    kind: "agent" | "skill" | "base" | "instruction" | "mcp" | "team"
    id?: string
    prompt?: string
    scope?: "project" | "global"
    template?: string
    fields?: Plus.CreateAgentInput["fields"]
    name?: string
    body?: string
    title?: string
    text?: string
    config?: Record<string, unknown>
    team?: string
    level?: "project" | "global"
  },
  actor: Plus.Actor,
): Effect.Effect<{ output: unknown }, Tool.Error> {
  return Effect.gen(function* () {
    if (input.kind === "agent") {
      if (input.id === undefined || input.prompt === undefined)
        return yield* Effect.fail(new Tool.Error({ message: "create agent requires id and prompt" }))
      const snapshot = yield* snapshotOrFail(api)
      const candidate = input.id.trim()
      if (candidate !== "" && snapshot.protectedAgents.includes(candidate))
        return yield* Effect.fail(protectedError(candidate))
      const created = yield* Effect.promise(() =>
        api.createAgent({
          scope: input.scope ?? "project",
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
    return yield* Effect.fail(new Tool.Error({ message: `create unknown kind ${input.kind}` }))
  })
}

function deletePlan(
  api: PlusApi,
  plan:
    | { kind: "agent.delete"; scope: "project" | "global"; id: string; successStatus: string }
    | { kind: "mcp.remove"; name: string; successStatus: string }
    | { kind: "skill.delete"; id: string; successStatus: string }
    | { kind: "base.delete"; id: string; successStatus: string }
    | { kind: "instruction.delete"; name: string; successStatus: string },
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
    const result = yield* Effect.promise(() => api.deleteInstruction({ name: plan.name, actor }))
    if (!result.ok) return yield* Effect.fail(new Tool.Error({ message: `${result.error.code}: ${result.error.message}` }))
    return { output: { ...result.value, status: plan.successStatus } }
  })
}
