import type { Plus } from "../rpc.js"
import type { Catalogue, CustomizationRecord, ModelRecord, RuleRecord, SplitRecord, TeamRef } from "./model.js"
import type { RowlinkRecord } from "./rowlinks.js"
import type { StoredRecord } from "./store.js"
import { stable } from "./store.js"

// One row identity shared by the full-form change detection, the change log
// and the delta form: the record type plus its target id plus its catalogue
// and team. The catalogue keeps the two copies of a shared Defaults row
// distinct; the team keeps a member row (`preset/reader@crew`) distinct from
// the stand-alone row of the same id, which recordTarget alone does not carry.
// Only together do they let a delta replace exactly one stored row and leave
// every other row byte-identical.
export function recordIdentity(record: StoredRecord): string {
  return `${record.type}\u0000${recordTarget(record)}\u0000${catalogueOfRecord(record)}\u0000${teamKeyOfRecord(record)}`
}

function catalogueOfRecord(record: StoredRecord): string {
  if (record.type === "customization" || record.type === "split" || record.type === "model" || record.type === "rule" || record.type === "rowlink")
    return record.catalogue ?? ""
  return ""
}

function teamKeyOfRecord(record: StoredRecord): string {
  if (
    record.type === "customization" ||
    record.type === "split" ||
    record.type === "model" ||
    record.type === "rule" ||
    record.type === "link" ||
    record.type === "rowlink"
  )
    return record.team === undefined ? "" : `${record.team.level}:${record.team.team}`
  return ""
}



// Tree row id for a stored record: customizations and splits address
// item:<level>:<agent|''>:<itemId> (sectioned rows add their section),
// teams address team:<level>:<name>. Shared with the change log's grouping
// and with the delta form's RecordKey.
export function recordTarget(record: StoredRecord): string {
  if (record.type === "team") return `team:${record.level}:${record.team}`
  if (record.type === "entry")
    return record.team === undefined ? `agent:defaults:${record.name}` : `team:defaults:${record.team}:${record.name}`
  if (record.type === "preset")
    return record.team === undefined ? `${record.kind}:preset:${record.id}` : `team:preset:${record.team}:${record.id}`
  if (record.type === "link") return `link:${record.level}:${record.agent ?? ""}`
  if (record.type === "modelSettings")
    return record.providerID === undefined || record.modelID === undefined
      ? "modeldefault:every"
      : `modeldefault:${record.providerID}/${record.modelID}`
  if (record.type === "model")
    return `model:${record.level}:${record.agent ?? ""}:${record.providerID}/${record.modelID}${record.variant === undefined ? "" : `@${record.variant}`}`
  if (record.type === "rule") return `rule:${record.level}:${record.agent ?? ""}:${record.tool}:${record.id}`
  if (record.type === "folder") return `folder:${record.id}`
  if (record.type === "order") return `order:${record.scope}`
  if (record.type === "rowlink") return `rowlink:${record.level}:${record.agent ?? ""}:${record.item}:${record.section ?? ""}:${record.target}:${record.targetSection ?? ""}`
  const agent = record.agent ?? ""
  if (record.type === "split") return `item:${record.level}:${agent}:${record.item}`
  if (record.section !== null) return `section:${record.level}:${agent}:${record.item}:${record.section}`
  return `item:${record.level}:${agent}:${record.item}`
}

// The structured key a client sends to remove one stored row. Its identity —
// keyIdentity — is exactly recordIdentity's answer for the row it addresses.
export function recordKeyOf(record: StoredRecord): Plus.RecordKey | undefined {
  if (record.type === "customization")
    return {
      type: "customization",
      level: record.level,
      agent: record.agent,
      ...teamField(record),
      ...catalogueField(record),
      item: record.item,
      section: record.section,
    }
  if (record.type === "split")
    return { type: "split", level: record.level, agent: record.agent, ...teamField(record), ...catalogueField(record), item: record.item }
  if (record.type === "model")
    return {
      type: "model",
      level: record.level,
      agent: record.agent,
      ...teamField(record),
      ...catalogueField(record),
      providerID: record.providerID,
      modelID: record.modelID,
      ...(record.variant === undefined ? {} : { variant: record.variant }),
    }
  if (record.type === "rule")
    return { type: "rule", level: record.level, agent: record.agent, ...teamField(record), ...catalogueField(record), tool: record.tool, id: record.id }
  if (record.type === "rowlink")
    return {
      type: "rowlink",
      level: record.level,
      agent: record.agent,
      ...teamField(record),
      ...catalogueField(record),
      item: record.item,
      section: record.section,
      target: record.target,
      targetSection: record.targetSection,
    }
  return undefined
}

function teamField(record: CustomizationRecord | SplitRecord | ModelRecord | RuleRecord | RowlinkRecord): { team?: TeamRef } {
  return record.team === undefined ? {} : { team: record.team }
}

function catalogueField(record: CustomizationRecord | SplitRecord | ModelRecord | RuleRecord | RowlinkRecord): { catalogue?: Catalogue } {
  return record.catalogue === undefined ? {} : { catalogue: record.catalogue }
}

function keyTarget(key: Plus.RecordKey): string {
  const agent = key.agent ?? ""
  if (key.type === "customization")
    return key.section === null
      ? `item:${key.level}:${agent}:${key.item}`
      : `section:${key.level}:${agent}:${key.item}:${key.section}`
  if (key.type === "split") return `item:${key.level}:${agent}:${key.item}`
  if (key.type === "model")
    return `model:${key.level}:${agent}:${key.providerID}/${key.modelID}${key.variant === undefined ? "" : `@${key.variant}`}`
  if (key.type === "rowlink")
    return `rowlink:${key.level}:${agent}:${key.item}:${key.section ?? ""}:${key.target}:${key.targetSection ?? ""}`
  return `rule:${key.level}:${agent}:${key.tool}:${key.id}`
}

/** The identity of the row a RecordKey addresses, as recordIdentity names it. */
export function keyIdentity(key: Plus.RecordKey): string {
  return `${key.type}\u0000${keyTarget(key)}\u0000${key.catalogue ?? ""}\u0000${key.team === undefined ? "" : `${key.team.level}:${key.team.team}`}`
}

export function contentOf(record: StoredRecord): string {
  return JSON.stringify(stable(record))
}

function sortByContent(records: readonly StoredRecord[]): StoredRecord[] {
  return [...records].sort((left, right) => {
    const leftKey = contentOf(left)
    const rightKey = contentOf(right)
    if (leftKey === rightKey) return 0
    return leftKey < rightKey ? -1 : 1
  })
}

function groupByIdentity(records: readonly StoredRecord[]): Map<string, StoredRecord[]> {
  const groups = new Map<string, StoredRecord[]>()
  for (const record of records) {
    const key = recordIdentity(record)
    const group = groups.get(key)
    if (group === undefined) groups.set(key, [record])
    else group.push(record)
  }
  return groups
}

// Multiset difference keyed by row identity: a row counts as changed when it
// was added, removed, or its stored content differs, and a modified row is
// named once (the after version). Content compares on the store's canonical
// serialized form. Team rows merged back verbatim cancel out, so a pure
// mutate never names them. The full-form mutate and the change log read this;
// the delta form uses deltaOf, which returns keys for removals too.
export function deltaRows(before: readonly StoredRecord[], after: readonly StoredRecord[]): StoredRecord[] {
  const beforeGroups = groupByIdentity(before)
  const afterGroups = groupByIdentity(after)
  const changed: StoredRecord[] = []
  for (const key of new Set([...beforeGroups.keys(), ...afterGroups.keys()])) {
    const olds = sortByContent(beforeGroups.get(key) ?? [])
    const news = sortByContent(afterGroups.get(key) ?? [])
    const paired = Math.min(olds.length, news.length)
    for (let index = 0; index < paired; index++) {
      const oldRow = olds[index]
      const newRow = news[index]
      if (oldRow === undefined || newRow === undefined) continue
      if (contentOf(oldRow) !== contentOf(newRow)) changed.push(newRow)
    }
    for (let index = paired; index < olds.length; index++) {
      const removed = olds[index]
      if (removed !== undefined) changed.push(removed)
    }
    for (let index = paired; index < news.length; index++) {
      const added = news[index]
      if (added !== undefined) changed.push(added)
    }
  }
  return changed
}

export interface Delta {
  readonly upsert: StoredRecord[]
  readonly remove: Plus.RecordKey[]
}

/**
 * The changed rows between two record sets, by identity and content: rows whose
 * stored content changed or that were added are upserts; identities that
 * disappeared are removes. Unchanged rows are not named, so a delta write
 * leaves them byte-identical.
 */
export function deltaOf(before: readonly StoredRecord[], after: readonly StoredRecord[]): Delta {
  const beforeGroups = groupByIdentity(before)
  const afterGroups = groupByIdentity(after)
  const upsert: StoredRecord[] = []
  const remove: Plus.RecordKey[] = []
  for (const key of new Set([...beforeGroups.keys(), ...afterGroups.keys()])) {
    const olds = sortByContent(beforeGroups.get(key) ?? [])
    const news = sortByContent(afterGroups.get(key) ?? [])
    const paired = Math.min(olds.length, news.length)
    for (let index = 0; index < paired; index++) {
      const oldRow = olds[index]
      const newRow = news[index]
      if (oldRow !== undefined && newRow !== undefined && contentOf(oldRow) !== contentOf(newRow)) upsert.push(newRow)
    }
    for (let index = paired; index < news.length; index++) {
      const added = news[index]
      if (added !== undefined) upsert.push(added)
    }
    for (let index = paired; index < olds.length; index++) {
      const removed = olds[index]
      if (removed === undefined) continue
      const recordKey = recordKeyOf(removed)
      if (recordKey !== undefined) remove.push(recordKey)
    }
  }
  return { upsert, remove }
}

// The wire form of one mutable record. Mirrors toSnapshotRecords (tools.ts):
// absent keys stay absent, and the shared-inventory catalogue and a rule's
// message ride along so a delta round-trips exactly. Team, link, entry,
// preset, modelSettings and category rows have their own endpoints and are
// not part of the inventory mutate.
export function snapshotRecordOf(record: StoredRecord): Plus.SnapshotRecord | undefined {
  if (record.type === "customization")
    return {
      type: "customization",
      level: record.level,
      agent: record.agent,
      ...(record.team === undefined ? {} : { team: record.team }),
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
  if (record.type === "split")
    return {
      type: "split",
      level: record.level,
      agent: record.agent,
      ...(record.team === undefined ? {} : { team: record.team }),
      ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
      item: record.item,
      boundaries: record.boundaries.map((boundary) => ({ ...boundary })),
      updated: record.updated,
    }
  if (record.type === "model")
    return {
      type: "model",
      level: record.level,
      agent: record.agent,
      ...(record.team === undefined ? {} : { team: record.team }),
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
      ...(record.coldFirst === undefined ? {} : { coldFirst: record.coldFirst }),
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
              ...record.originalCandidate,
              ...(record.originalCandidate.editedFields === undefined ? {} : { editedFields: [...record.originalCandidate.editedFields] }),
            },
          }),
      updated: record.updated,
    }
  if (record.type === "rule")
    return {
      type: "rule",
      level: record.level,
      agent: record.agent,
      ...(record.team === undefined ? {} : { team: record.team }),
      ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
      tool: record.tool,
      id: record.id,
      label: record.label,
      patterns: [...record.patterns],
      keywords: [...record.keywords],
      ...(record.message === undefined ? {} : { message: record.message }),
      updated: record.updated,
    }
  if (record.type === "rowlink")
    return {
      type: "rowlink",
      level: record.level,
      agent: record.agent,
      ...(record.team === undefined ? {} : { team: record.team }),
      ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
      item: record.item,
      section: record.section,
      target: record.target,
      targetSection: record.targetSection,
      link: record.link,
      ...(record.enabled === undefined ? {} : { enabled: record.enabled }),
      updated: record.updated,
    }
  return undefined
}
