import type { Plus } from "../rpc.js"
import type {
  AgentSource,
  CustomizationRecord,
  EntryRecord,
  Item,
  LinkRecord,
  ModelRecord,
  PresetRecord,
  PresetRef,
  RuleRecord,
  Scopes,
  SplitRecord,
} from "./model.js"
import { chainContext, presetListing, withOwnerRoles, type PresetState } from "./presets.js"
import type { RowlinkRecord, RowlinkType } from "./rowlinks.js"
import {
  everySettings,
  isEvery,
  modelDefaultView,
  parseModelDefaultItemId,
  parseModelSettingItemId,
  settingsFor,
  type HostModel,
  type ModelDefaultView,
  type ModelSettingsKey,
  type ModelSettingsRecord,
} from "./model-settings.js"
import type { MemoInput, TeamInput } from "./tree.js"

export function itemOf(item: Plus.SnapshotItem): Item {
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
    ...(item.controlTeam === undefined ? {} : { controlTeam: item.controlTeam }),
    ...(item.order === undefined ? {} : { order: item.order }),
    ...(item.userBase === undefined ? {} : { userBase: item.userBase }),
    ...(item.userSystem === undefined ? {} : { userSystem: item.userSystem }),
    ...(item.models === undefined ? {} : { models: [...item.models] }),
    ...(item.opencodePart === undefined ? {} : { opencodePart: item.opencodePart }),
    ...(item.codemode === undefined ? {} : { codemode: item.codemode }),
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
    ...(item.alsoUnder === undefined ? {} : { alsoUnder: [...item.alsoUnder] }),
  }
}

declare module "./model.js" {
  interface AgentSource {
    readonly ancestor?: boolean
  }
}

export function agentOf(agent: Plus.AgentEntry): AgentSource {
  return {
    id: agent.id,
    scope: agent.scope,
    ...(agent.origin === undefined ? {} : { origin: agent.origin }),
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
  }
}

export function recordOf(
  record: Plus.SnapshotRecord,
): CustomizationRecord | SplitRecord | ModelRecord | RuleRecord | RowlinkRecord {
  if (record.type === "split") return splitOf(record)
  if (record.type === "model") return modelOf(record)
  if (record.type === "rule") return ruleOf(record)
  if (record.type === "rowlink") return rowlinkOf(record)
  return customizationOf(record)
}

function splitOf(record: Plus.SnapshotSplitRecord): SplitRecord {
  return {
    type: "split",
    level: record.level,
    agent: record.agent,
    ...(record.team === undefined ? {} : { team: { level: record.team.level, team: record.team.team } }),
    ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
    item: record.item,
    boundaries: record.boundaries.map((boundary) => ({ ...boundary })),
    updated: record.updated,
  }
}

function modelOf(record: Plus.SnapshotModelRecord): ModelRecord {
  return {
    type: "model",
    level: record.level,
    agent: record.agent,
    ...(record.team === undefined ? {} : { team: { level: record.team.level, team: record.team.team } }),
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
}

export function ruleOf(record: Plus.SnapshotRuleRecord): RuleRecord {
  return {
    type: "rule",
    level: record.level,
    agent: record.agent,
    ...(record.team === undefined ? {} : { team: { level: record.team.level, team: record.team.team } }),
    ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
    tool: record.tool,
    id: record.id,
    label: record.label,
    patterns: [...record.patterns],
    keywords: [...record.keywords],
    ...(record.message === undefined ? {} : { message: record.message }),
    updated: record.updated,
  }
}

function customizationOf(record: Plus.SnapshotCustomizationRecord): CustomizationRecord {
  return {
    type: "customization",
    level: record.level,
    agent: record.agent,
    ...(record.team === undefined ? {} : { team: { level: record.team.level, team: record.team.team } }),
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

export function teamOf(team: Plus.TeamEntry): TeamInput {
  return {
    level: team.level,
    team: team.team,
    enabled: team.enabled,
    agents: [...team.agents],
    ...(team.overlay !== undefined ? { overlay: [...team.overlay] } : {}),
  }
}

export function modelSettingsRecordOf(record: Plus.SnapshotModelSettingsRecord): ModelSettingsRecord {
  return {
    type: "modelSettings",
    level: "defaults",
    ...(record.providerID === undefined ? {} : { providerID: record.providerID }),
    ...(record.modelID === undefined ? {} : { modelID: record.modelID }),
    ...(record.warming === undefined ? {} : { warming: record.warming }),
    ...(record.interval === undefined ? {} : { interval: record.interval }),
    ...(record.waiting === undefined ? {} : { waiting: record.waiting }),
    ...(record.subagent === undefined ? {} : { subagent: record.subagent }),
    ...(record.prompt === undefined ? {} : { prompt: record.prompt }),
    ...(record.effort === undefined ? {} : { effort: record.effort }),
    ...(record.compactWarm === undefined ? {} : { compactWarm: record.compactWarm }),
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
    updated: record.updated,
  }
}

export function hostModelOf(record: Plus.SnapshotHostModel): HostModel {
  return {
    providerID: record.providerID,
    modelID: record.modelID,
    variants: [...record.variants],
    ...(record.warming === undefined
      ? {}
      : {
          warming: {
            on: record.warming.on,
            ...(record.warming.duration === undefined ? {} : { duration: record.warming.duration }),
            ...(record.warming.interval === undefined ? {} : { interval: record.warming.interval }),
            ...(record.warming.prompt === undefined ? {} : { prompt: record.warming.prompt }),
          },
        }),
  }
}

/** What one Defaults › Models row resolves to now, from the snapshot alone (tree rows, inspector, dialogs). */
export function modelDefaultsViewOf(
  snapshot: Plus.Snapshot,
  item: string | undefined,
): (ModelDefaultView & { readonly key: ModelSettingsKey; readonly record?: ModelSettingsRecord }) | undefined {
  // A field row resolves through the row it belongs to.
  const key = item === undefined ? undefined : (parseModelDefaultItemId(item) ?? parseModelSettingItemId(item)?.key)
  if (key === undefined) return undefined
  const records = (snapshot.modelSettings ?? []).map(modelSettingsRecordOf)
  const own = settingsFor(records, key)
  const every = isEvery(key) ? undefined : everySettings(records)
  const host =
    isEvery(key)
      ? undefined
      : (snapshot.hostModels ?? []).find((entry) => entry.providerID === key.providerID && entry.modelID === key.modelID)
  const view = modelDefaultView({
    key,
    ...(own === undefined ? {} : { record: own }),
    ...(every === undefined ? {} : { every }),
    ...(host?.warming === undefined ? {} : { host: host.warming }),
    ...(host === undefined ? {} : { variants: host.variants }),
  })
  return { ...view, key, ...(own === undefined ? {} : { record: own }) }
}

// A snapshot is an immutable answer: its memo input is computed once.
const memoInputs = new WeakMap<Plus.Snapshot, MemoInput>()

export function memoInputOf(snapshot: Plus.Snapshot): MemoInput {
  const known = memoInputs.get(snapshot)
  if (known !== undefined) return known
  const input = memoInputFrom(snapshot)
  memoInputs.set(snapshot, input)
  return input
}

function memoInputFrom(snapshot: Plus.Snapshot): MemoInput {
  return {
    // Presets and Defaults entries get the Role/persona row discovery gives
    // every agent (presets.ts withOwnerRoles).
    items: withOwnerRoles(snapshot.items.map(itemOf), presetStateOfSnapshot(snapshot)),
    // Model and rule records are tree rows in phases 2 and 3. They
    // round-trip through recordOf losslessly above.
    records: snapshot.records
      .map(recordOf)
      .filter(
        (record): record is CustomizationRecord | SplitRecord | ModelRecord | RuleRecord | RowlinkRecord =>
          record.type === "customization" ||
          record.type === "split" ||
          record.type === "model" ||
          record.type === "rule" ||
          record.type === "rowlink",
      ),
    agents: snapshot.agents.map(agentOf),
    teams: (snapshot.teams ?? []).map(teamOf),
    modelSettings: (snapshot.modelSettings ?? []).map(modelSettingsRecordOf),
    hostModels: (snapshot.hostModels ?? []).map(hostModelOf),
    folders: snapshot.folders ?? [],
    orders: snapshot.orders ?? [],
    ...presetStateOfSnapshot(snapshot),
  }
}

/** The links, Defaults entries and user presets a snapshot carries. */
export function presetStateOfSnapshot(snapshot: Plus.Snapshot): Required<PresetState> {
  return {
    links: (snapshot.links ?? []).map(linkOf),
    // Rowlinks cross as inventory records (SnapshotRecord) so the link tool's
    // delta write can upsert them and instructions.mutate carries stored ones
    // over; pull them from the same records as every other row.
    rowlinks: snapshot.records
      .filter((record): record is Plus.SnapshotRowlinkRecord => record.type === "rowlink")
      .map(rowlinkOf),
    entries: (snapshot.entries ?? []).map(entryOf),
    presets: (snapshot.presets ?? []).map(presetOf),
  }
}

/** Every preset a snapshot knows, in picker order: the server's listing, else one built from its user presets. */
export function listingOfSnapshot(snapshot: Plus.Snapshot): readonly Plus.PresetListEntry[] {
  return snapshot.listing ?? presetListing((snapshot.presets ?? []).map(presetOf))
}

/** The full chain context of a snapshot, built exactly as the server builds it. */
export function contextOfSnapshot(snapshot: Plus.Snapshot): Scopes {
  return chainContext({
    agents: snapshot.agents.map(agentOf),
    items: snapshot.items.map(itemOf),
    teams: (snapshot.teams ?? []).map(teamOf),
    ...presetStateOfSnapshot(snapshot),
  })
}

export function linkOf(record: Plus.SnapshotLinkRecord): LinkRecord {
  return {
    type: "link",
    level: record.level,
    agent: record.agent,
    ...(record.team === undefined ? {} : { team: { level: record.team.level, team: record.team.team } }),
    ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
    preset: presetRefOf(record.preset),
    updated: record.updated,
  }
}

export function rowlinkOf(record: Plus.SnapshotRowlinkRecord): RowlinkRecord {
  return {
    type: "rowlink",
    level: record.level,
    agent: record.agent,
    ...(record.team === undefined ? {} : { team: { level: record.team.level, team: record.team.team } }),
    ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
    item: record.item,
    section: record.section,
    target: record.target,
    targetSection: record.targetSection,
    link: record.link as RowlinkType,
    ...(record.enabled === undefined ? {} : { enabled: record.enabled }),
    updated: record.updated,
  }
}

export function entryOf(record: Plus.SnapshotEntryRecord): EntryRecord {
  return {
    type: "entry",
    level: "defaults",
    catalogue: record.catalogue,
    ...(record.team === undefined ? {} : { team: record.team }),
    name: record.name,
    updated: record.updated,
  }
}

export function presetOf(record: Plus.SnapshotPresetRecord): PresetRecord {
  return {
    type: "preset",
    level: "preset",
    kind: record.kind,
    id: record.id,
    ...(record.team === undefined ? {} : { team: record.team }),
    ...(record.fields === undefined ? {} : { fields: { ...record.fields } }),
    updated: record.updated,
  }
}

function presetRefOf(ref: Plus.PresetRef): PresetRef {
  if (ref.kind === "member") return { kind: "member", team: ref.team, id: ref.id }
  return { kind: ref.kind, id: ref.id }
}
