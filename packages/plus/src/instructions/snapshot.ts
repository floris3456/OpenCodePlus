import type { Plus } from "../rpc.js"
import type { AgentSource, CustomizationRecord, Item, SplitRecord } from "./model.js"
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
  }
}

export function agentOf(agent: Plus.AgentEntry): AgentSource {
  return {
    id: agent.id,
    scope: agent.scope,
    ...(agent.path === undefined ? {} : { path: agent.path }),
    ...(agent.base === undefined ? {} : { base: agent.base }),
  }
}

export function recordOf(record: Plus.SnapshotRecord): CustomizationRecord | SplitRecord {
  if (record.type === "split") return splitOf(record)
  return customizationOf(record)
}

function splitOf(record: Plus.SnapshotSplitRecord): SplitRecord {
  return {
    type: "split",
    level: record.level,
    agent: record.agent,
    item: record.item,
    boundaries: record.boundaries.map((boundary) => ({ ...boundary })),
    updated: record.updated,
  }
}

function customizationOf(record: Plus.SnapshotCustomizationRecord): CustomizationRecord {
  return {
    type: "customization",
    level: record.level,
    agent: record.agent,
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
  }
}

export function memoInputOf(snapshot: Plus.Snapshot): MemoInput {
  return {
    items: snapshot.items.map(itemOf),
    records: snapshot.records.map(recordOf),
    agents: snapshot.agents.map(agentOf),
    teams: (snapshot.teams ?? []).map(teamOf),
  }
}
