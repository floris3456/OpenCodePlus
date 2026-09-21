import type { Plus } from "../rpc.js"
import type { AgentSource, CustomizationRecord, Item, ModelRecord, RuleRecord, SplitRecord } from "./model.js"
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
    ...(item.order === undefined ? {} : { order: item.order }),
    ...(item.userBase === undefined ? {} : { userBase: item.userBase }),
    ...(item.codemode === undefined ? {} : { codemode: item.codemode }),
    ...(item.namespace === undefined ? {} : { namespace: item.namespace }),
    ...(item.pinned === undefined ? {} : { pinned: item.pinned }),
    ...(item.execute === undefined ? {} : { execute: item.execute }),
    ...(item.permTool === undefined ? {} : { permTool: item.permTool }),
    ...(item.permAction === undefined ? {} : { permAction: item.permAction }),
    ...(item.ruleId === undefined ? {} : { ruleId: item.ruleId }),
    ...(item.patterns === undefined ? {} : { patterns: [...item.patterns] }),
    ...(item.keywords === undefined ? {} : { keywords: [...item.keywords] }),
    ...(item.provenance === undefined ? {} : { provenance: [...item.provenance] }),
    ...(item.custom === undefined ? {} : { custom: item.custom }),
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

export function recordOf(record: Plus.SnapshotRecord): CustomizationRecord | SplitRecord | ModelRecord | RuleRecord {
  if (record.type === "split") return splitOf(record)
  if (record.type === "model") return modelOf(record)
  if (record.type === "rule") return ruleOf(record)
  return customizationOf(record)
}

function splitOf(record: Plus.SnapshotSplitRecord): SplitRecord {
  return {
    type: "split",
    level: record.level,
    agent: record.agent,
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
    ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
    providerID: record.providerID,
    modelID: record.modelID,
    ...(record.variant === undefined ? {} : { variant: record.variant }),
    ...(record.active === undefined ? {} : { active: record.active }),
    updated: record.updated,
  }
}

function ruleOf(record: Plus.SnapshotRuleRecord): RuleRecord {
  return {
    type: "rule",
    level: record.level,
    agent: record.agent,
    ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
    tool: record.tool,
    id: record.id,
    label: record.label,
    patterns: [...record.patterns],
    keywords: [...record.keywords],
    updated: record.updated,
  }
}

function customizationOf(record: Plus.SnapshotCustomizationRecord): CustomizationRecord {
  return {
    type: "customization",
    level: record.level,
    agent: record.agent,
    ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
    item: record.item,
    section: record.section,
    ...(record.text === undefined ? {} : { text: record.text }),
    ...(record.state === undefined ? {} : { state: record.state }),
    ...(record.pin === undefined ? {} : { pin: record.pin }),
    basedOn: record.basedOn,
    ...(record.basedOnText === undefined ? {} : { basedOnText: record.basedOnText }),
    ...(record.acknowledged === undefined ? {} : { acknowledged: record.acknowledged }),
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

export function memoInputOf(snapshot: Plus.Snapshot): MemoInput {
  return {
    items: snapshot.items.map(itemOf),
    // Model and rule records are tree rows in phases 2 and 3. They
    // round-trip through recordOf losslessly above.
    records: snapshot.records
      .map(recordOf)
      .filter(
        (record): record is CustomizationRecord | SplitRecord | ModelRecord | RuleRecord =>
          record.type === "customization" || record.type === "split" || record.type === "model" || record.type === "rule",
      ),
    agents: snapshot.agents.map(agentOf),
    teams: (snapshot.teams ?? []).map(teamOf),
  }
}
