import fs from "node:fs/promises"
import path from "node:path"
import { Option, Schema } from "effect"
import { folderRef, tabKeys, tabOfItem, uniqueFolderId, type FolderRecord, type OrderRecord } from "./folders.js"
import { migrateRequires, type RowlinkRecord } from "./rowlinks.js"
import type { Boundary } from "./sections.js"
import { assembleWithOverrides, derive, manual, slice } from "./sections.js"
import type {
  Catalogue,
  CustomizationRecord,
  EntryRecord,
  Level,
  LinkRecord,
  ModelRecord,
  OriginalCandidate,
  PresetRecord,
  PresetRef,
  RuleRecord,
  SplitRecord,
} from "./model.js"
import { catalogueMatches, fingerprint, sameTeam } from "./model.js"
import type { ModelCompactionFields, ModelSettingsRecord } from "./model-settings.js"
import type { TeamRecord } from "./teams.js"
import { globalRecordsPath, linkedProjectsPath, projectRecordsPath } from "./paths.js"
import { basicMemberForRetiredAgent, basicTeamId, retiredMemberPresets } from "./presets.js"
import { catalogFor } from "./permission-catalog.js"
import { ensure } from "../project.js"

export type { CustomizationRecord, SplitRecord }
export type { ModelRecord, ModelSettingsRecord, OriginalCandidate, RuleRecord }
export type { TeamRecord }
export type { EntryRecord, LinkRecord, PresetRecord }
export type { FolderRecord, OrderRecord, RowlinkRecord }
export type StoredRecord =
  | CustomizationRecord
  | SplitRecord
  | TeamRecord
  | ModelRecord
  | ModelSettingsRecord
  | RuleRecord
  | LinkRecord
  | EntryRecord
  | PresetRecord
  | FolderRecord
  | OrderRecord
  | RowlinkRecord

// A category record (plus-1.1.12) is read only: the load migrates it into
// folders and order records (migrateCategories), so it never reaches a caller.
interface LegacyCategory {
  readonly type: "category"
  readonly level: "global"
  readonly name: string
  readonly order: number
  readonly items: readonly string[]
  readonly updated: string
}
export type RecordState = "on" | "off"

export type { Level }

export interface Loaded {
  readonly projectRevision: number
  readonly globalRevision: number
  readonly records: readonly StoredRecord[]
  readonly migrated: boolean
  /** True when this load duplicated pre-split shared rows into the Teams catalogue. */
  readonly cataloguesMigrated: boolean
  /** True when this load moved links and customizations of the retired Plus presets onto the Basic team preset. */
  readonly presetsMigrated: boolean
  /** True when this load moved per-skill permission rows' states onto the skills themselves. */
  readonly skillsMigrated: boolean
  /** True when this load carried a shell family's state onto a row split out of it. */
  readonly splitsMigrated: boolean
  /** True when this load converted a whole-row override on a split row into section overrides. */
  readonly wholeRowsMigrated: boolean
  /** True when this load turned category records into folders and order records. */
  readonly foldersMigrated: boolean
  /** True when this load migrated `requires` lists or retired one-way links. */
  readonly rowlinksMigrated: boolean
}

export interface SaveInput {
  readonly expectedProjectRevision: number
  readonly expectedGlobalRevision: number
  readonly records: readonly StoredRecord[]
}

export interface SaveSuccess {
  readonly ok: true
  readonly projectRevision: number
  readonly globalRevision: number
  // Which stores the write actually moved. An unchanged save moves neither
  // and touches no file; callers use this to log one line per changed store.
  readonly changed: { readonly project: boolean; readonly global: boolean }
}

export interface SaveStale {
  readonly ok: false
  readonly reason: "stale"
  readonly store: "project" | "global"
  readonly current: Loaded
}

export type SaveResult = SaveSuccess | SaveStale

// The in-memory view of what a successful save just wrote, without re-reading
// the files. `load` returns project-level records first, then the rest, each
// file in canonical order; a store with no project-level rows is one global
// list. Migrations are already applied to `records` (they came from a load),
// so the flag fields stay false exactly as a fresh load would report.
export function loadedFromSave(saved: SaveSuccess, records: readonly StoredRecord[]): Loaded {
  const project = canonical(records.filter((record) => record.level === "project"))
  const global = canonical(records.filter((record) => record.level !== "project"))
  return {
    projectRevision: saved.projectRevision,
    globalRevision: saved.globalRevision,
    records: project.length === 0 ? canonical(records) : [...project, ...global],
    migrated: false,
    cataloguesMigrated: false,
    presetsMigrated: false,
    skillsMigrated: false,
    splitsMigrated: false,
    wholeRowsMigrated: false,
    foldersMigrated: false,
    rowlinksMigrated: false,
  }
}

const VERSION = 2

const LevelSchema = Schema.Union([
  Schema.Literal("defaults"),
  Schema.Literal("global"),
  Schema.Literal("project"),
  Schema.Literal("preset"),
])

const V2TeamRef = Schema.Struct({
  level: LevelSchema,
  team: Schema.String,
})

// Shared-inventory rows only. Absent means the Agents catalogue, so every
// record written before the catalogue split keeps its exact bytes and meaning.
const CatalogueSchema = Schema.Union([Schema.Literal("agents"), Schema.Literal("teams")])

const BoundarySchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  start: Schema.Number,
  depth: Schema.optional(Schema.Number),
})

const V2Customization = Schema.Struct({
  type: Schema.Literal("customization"),
  level: LevelSchema,
  agent: Schema.Union([Schema.String, Schema.Null]),
  team: Schema.optional(V2TeamRef),
  catalogue: Schema.optional(CatalogueSchema),
  item: Schema.String,
  section: Schema.Union([Schema.String, Schema.Null]),
  text: Schema.optional(Schema.String),
  state: Schema.optional(Schema.Union([Schema.Literal("on"), Schema.Literal("off")])),
  pin: Schema.optional(Schema.Boolean),
  requires: Schema.optional(Schema.Array(Schema.String)),
  basedOn: Schema.String,
  basedOnText: Schema.optional(Schema.String),
  acknowledged: Schema.optional(Schema.String),
  basedOnState: Schema.optional(Schema.Union([Schema.Literal("on"), Schema.Literal("off")])),
  basedOnPin: Schema.optional(Schema.Boolean),
  updated: Schema.String,
})

const V2Split = Schema.Struct({
  type: Schema.Literal("split"),
  level: LevelSchema,
  agent: Schema.Union([Schema.String, Schema.Null]),
  team: Schema.optional(V2TeamRef),
  catalogue: Schema.optional(CatalogueSchema),
  item: Schema.String,
  boundaries: Schema.Array(BoundarySchema),
  updated: Schema.String,
})

// Teams persist at all three tiers, including defaults-level enablement
// records for built-in teams; anything else (a `preset` level included: team
// presets are PresetRecords) fails validation and the line is skipped like
// any malformed record.
const V2Team = Schema.Struct({
  type: Schema.Literal("team"),
  level: Schema.Union([Schema.Literal("defaults"), Schema.Literal("global"), Schema.Literal("project")]),
  team: Schema.String,
  enabled: Schema.Boolean,
  updated: Schema.String,
})

const V2OriginalCandidate = Schema.Struct({
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optional(Schema.String),
  source: Schema.optional(Schema.Union([LevelSchema, Schema.Literal("upstream")])),
  editedFields: Schema.optional(Schema.Array(Schema.Union([Schema.Literal("model"), Schema.Literal("effort")]))),
})

// Compaction per model, on agent model rows and Defaults › Models rows alike
// (model-settings.ts). Stored loosely like the warming fields: a value that no
// longer parses sets nothing at resolution instead of dropping the record.
const CompactionFields = {
  compactWarm: Schema.optional(Schema.String),
  coldCompact: Schema.optional(Schema.String),
  coldModels: Schema.optional(Schema.Array(Schema.String)),
  compactionStrategy: Schema.optional(Schema.String),
  compactionModel: Schema.optional(Schema.String),
  compactionInstructions: Schema.optional(Schema.String),
  imageConvert: Schema.optional(Schema.String),
  imageShrink: Schema.optional(Schema.String),
  imagesFull: Schema.optional(Schema.String),
  compactionInput: Schema.optional(Schema.String),
  compactionOutput: Schema.optional(Schema.String),
}

// Per-agent model selection. Omitted active retains ordinary inheritance;
// explicit false is a durable switch-off mask that keeps the candidate and
// its settings. Existing true/omitted stores need no migration. `removed: true`
// remains the separate tombstone hiding a candidate at that level.
const V2Model = Schema.Struct({
  type: Schema.Literal("model"),
  level: LevelSchema,
  agent: Schema.Union([Schema.String, Schema.Null]),
  team: Schema.optional(V2TeamRef),
  catalogue: Schema.optional(CatalogueSchema),
  providerID: Schema.String,
  modelID: Schema.String,
  variant: Schema.optional(Schema.String),
  active: Schema.optional(Schema.Boolean),
  basedOn: Schema.optional(Schema.String),
  warming: Schema.optional(Schema.String),
  interval: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  ...CompactionFields,
  removed: Schema.optional(Schema.Literal(true)),
  originalCandidate: Schema.optional(V2OriginalCandidate),
  updated: Schema.String,
})

// Defaults › Models: the model settings every agent falls back to, one row
// per model and one "Every model" row (no providerID/modelID).
const V2ModelSettings = Schema.Struct({
  type: Schema.Literal("modelSettings"),
  level: Schema.Literal("defaults"),
  providerID: Schema.optional(Schema.String),
  modelID: Schema.optional(Schema.String),
  warming: Schema.optional(Schema.String),
  interval: Schema.optional(Schema.String),
  prompt: Schema.optional(Schema.String),
  effort: Schema.optional(Schema.String),
  ...CompactionFields,
  updated: Schema.String,
})

const V2Rule = Schema.Struct({
  type: Schema.Literal("rule"),
  level: LevelSchema,
  agent: Schema.Union([Schema.String, Schema.Null]),
  team: Schema.optional(V2TeamRef),
  catalogue: Schema.optional(CatalogueSchema),
  tool: Schema.String,
  id: Schema.String,
  label: Schema.String,
  patterns: Schema.Array(Schema.String),
  keywords: Schema.Array(Schema.String),
  message: Schema.optional(Schema.String),
  updated: Schema.String,
})

const PresetRefSchema = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("agent"), id: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("member"), team: Schema.String, id: Schema.String }),
  Schema.Struct({ kind: Schema.Literal("team"), id: Schema.String }),
])

// "Created from preset X" (DESIGN §7): owned by an agent, member, team,
// Defaults entry or preset at any level; routes by level like any record.
const V2Link = Schema.Struct({
  type: Schema.Literal("link"),
  level: LevelSchema,
  agent: Schema.Union([Schema.String, Schema.Null]),
  team: Schema.optional(V2TeamRef),
  catalogue: Schema.optional(CatalogueSchema),
  preset: PresetRefSchema,
  updated: Schema.String,
})

// A Defaults entry named by an exact name or a wildcard pattern: always at
// level defaults, so it lives in the global file.
const V2Entry = Schema.Struct({
  type: Schema.Literal("entry"),
  level: Schema.Literal("defaults"),
  catalogue: CatalogueSchema,
  team: Schema.optional(Schema.String),
  name: Schema.String,
  updated: Schema.String,
})

// A user preset (Native and Plus presets are code): always at level preset,
// so it lives in the global file.
const V2Preset = Schema.Struct({
  type: Schema.Literal("preset"),
  level: Schema.Literal("preset"),
  kind: Schema.Union([Schema.Literal("agent"), Schema.Literal("team")]),
  id: Schema.String,
  team: Schema.optional(Schema.String),
  fields: Schema.optional(
    Schema.Struct({
      mode: Schema.optional(Schema.String),
      description: Schema.optional(Schema.String),
    }),
  ),
  updated: Schema.String,
})

// A user category (plan plus-1.1.12 T8). Read only: migrateCategories turns it
// into folders at load, and it is never written again.
const V2Category = Schema.Struct({
  type: Schema.Literal("category"),
  level: Schema.Literal("global"),
  name: Schema.String,
  order: Schema.Number,
  items: Schema.Array(Schema.String),
  updated: Schema.String,
})

// Folders and display order (folders.ts): always global.
const V2Folder = Schema.Struct({
  type: Schema.Literal("folder"),
  level: Schema.Literals(["global", "project"]),
  owner: Schema.optional(Schema.String),
  tab: Schema.String,
  id: Schema.String,
  name: Schema.String,
  parent: Schema.optional(Schema.String),
  items: Schema.Array(Schema.String),
  updated: Schema.String,
})

const V2Order = Schema.Struct({
  type: Schema.Literal("order"),
  level: Schema.Literals(["global", "project"]),
  scope: Schema.String,
  items: Schema.Array(Schema.String),
  basedOn: Schema.optional(Schema.String),
  updated: Schema.String,
})

// Row links (rowlinks.ts): switches and gates between two rows of one owner
// and level. `requires` and the read-only legacy `oneway` type migrate at load.
const V2Rowlink = Schema.Struct({
  type: Schema.Literal("rowlink"),
  level: LevelSchema,
  agent: Schema.Union([Schema.String, Schema.Null]),
  team: Schema.optional(V2TeamRef),
  catalogue: Schema.optional(CatalogueSchema),
  item: Schema.String,
  section: Schema.Union([Schema.String, Schema.Null]),
  target: Schema.String,
  targetSection: Schema.Union([Schema.String, Schema.Null]),
  link: Schema.Union([
    Schema.Literal("either"),
    Schema.Literal("oneway"),
    Schema.Literal("shownWhenOn"),
    Schema.Literal("shownWhenOff"),
    Schema.Literal("shownAlways"),
  ]),
  enabled: Schema.optional(Schema.Boolean),
  updated: Schema.String,
})

const V2Record = Schema.Union([
  V2Customization,
  V2Split,
  V2Team,
  V2Model,
  V2ModelSettings,
  V2Rule,
  V2Link,
  V2Entry,
  V2Preset,
  V2Category,
  V2Folder,
  V2Order,
  V2Rowlink,
])

const V2Header = Schema.Struct({
  version: Schema.Literal(2),
  revision: Schema.Number,
})

const V1Header = Schema.Struct({
  revision: Schema.Number,
})

// v1 records: { item, agent, text?, state, basedOn, reviewed?, updated }.
// `agent === "*"` meant the shared row; state was enabled|disabled|inherit.
const V1Record = Schema.Struct({
  item: Schema.String,
  agent: Schema.String,
  text: Schema.optional(Schema.String),
  state: Schema.Union([Schema.Literal("inherit"), Schema.Literal("enabled"), Schema.Literal("disabled")]),
  basedOn: Schema.String,
  reviewed: Schema.optional(Schema.String),
  updated: Schema.String,
})

const decodeV2Record = Schema.decodeUnknownOption(Schema.fromJsonString(V2Record))
const decodeV2Header = Schema.decodeUnknownOption(Schema.fromJsonString(V2Header))
const decodeV1Header = Schema.decodeUnknownOption(Schema.fromJsonString(V1Header))
const decodeV1Record = Schema.decodeUnknownOption(Schema.fromJsonString(V1Record))

export type StaleStore = "project" | "global"

const gates = new Map<string, Promise<void>>()

interface ParsedFile {
  readonly revision: number
  readonly records: readonly (StoredRecord | LegacyCategory)[]
  readonly migrated: boolean
  readonly rowlinksMigrated?: boolean
}

export async function load(projectDir: string): Promise<Loaded> {
  const project = await readFile(projectRecordsPath(projectDir))
  const global = await readFile(globalRecordsPath())
  const projectParsed = parseFile(project)
  const globalParsed = parseFile(global)
  if (!projectParsed.migrated && !globalParsed.migrated) {
    const folders = migrateCategories([...projectParsed.records, ...globalParsed.records])
    const catalogues = migrateCatalogues(folders.records)
    const presets = migrateRemovedPresets(catalogues.records)
    const skills = migrateSkillPermissions(presets.records)
    const splits = migrateSplitRows(skills.records)
    const wholeRows = migrateWholeRows(splits.records)
    const rowlinks = migrateRequires(wholeRows.records)
    return {
      projectRevision: projectParsed.revision,
      globalRevision: globalParsed.revision,
      records: [...rowlinks.records, ...rowlinks.rowlinks],
      migrated: false,
      cataloguesMigrated: catalogues.migrated,
      presetsMigrated: presets.migrated,
      skillsMigrated: skills.migrated,
      splitsMigrated: splits.migrated,
      wholeRowsMigrated: wholeRows.migrated,
      foldersMigrated: folders.migrated,
      rowlinksMigrated: rowlinks.migrated || projectParsed.rowlinksMigrated === true || globalParsed.rowlinksMigrated === true,
    }
  }
  // A v1 project file may hold defaults-level records (old `agent: "*"` rows);
  // those route into the global store, not the project file.
  const folders = migrateCategories(projectParsed.records.concat(globalParsed.records))
  const catalogues = migrateCatalogues(folders.records)
  const presets = migrateRemovedPresets(catalogues.records)
  const skills = migrateSkillPermissions(presets.records)
  const splits = migrateSplitRows(skills.records)
  const wholeRows = migrateWholeRows(splits.records)
  const rowlinks = migrateRequires(wholeRows.records)
  const routed = route([...rowlinks.records, ...rowlinks.rowlinks])
  return {
    projectRevision: projectParsed.revision,
    globalRevision: globalParsed.revision,
    records: routed.project.concat(routed.global),
    migrated: true,
    cataloguesMigrated: catalogues.migrated,
    presetsMigrated: presets.migrated,
    skillsMigrated: skills.migrated,
    splitsMigrated: splits.migrated,
    wholeRowsMigrated: wholeRows.migrated,
    foldersMigrated: folders.migrated,
    rowlinksMigrated: rowlinks.migrated || projectParsed.rowlinksMigrated === true || globalParsed.rowlinksMigrated === true,
  }
}

// Categories (plus-1.1.12) became folders (plus-1.2.0, B1, B4): each category
// is one folder in every tab that holds one of its items, with its name and its
// items in order, and a category with no items is an empty folder in Tools. A
// tab's top level lists its folders in the categories' order. An item held by
// two categories stays with the first, as the tabs showed it. The category
// records are gone after this, so there is one source of truth.
//
// Idempotent: a store with no category record is returned untouched.
export function migrateCategories(records: readonly (StoredRecord | LegacyCategory)[]): {
  records: StoredRecord[]
  migrated: boolean
} {
  const rest = records.flatMap((record): StoredRecord[] => (record.type === "category" ? [] : [record]))
  const categories = records
    .flatMap((record): LegacyCategory[] => (record.type === "category" ? [record] : []))
    .toSorted((left, right) => left.order - right.order || left.name.localeCompare(right.name))
  if (categories.length === 0) return { records: rest, migrated: false }
  const holder = new Map<string, string>()
  for (const category of categories) for (const item of category.items) if (!holder.has(item)) holder.set(item, category.name)
  const folders: FolderRecord[] = []
  for (const category of categories) {
    const held = category.items.filter((item) => holder.get(item) === category.name)
    const tabs = tabKeys.filter((tab) => held.some((item) => tabOfItem(item) === tab))
    for (const tab of tabs.length === 0 ? ["tools"] : tabs) {
      const items = held.filter((item) => tabOfItem(item) === tab)
      const id = uniqueFolderId(folders, tab, category.name)
      folders.push({ type: "folder", level: "global", tab, id, name: category.name, items, updated: category.updated })
    }
  }
  const orders = tabKeys.flatMap((tab): OrderRecord[] => {
    const inTab = folders.filter((folder) => folder.tab === tab)
    if (inTab.length === 0) return []
    return [{ type: "order", level: "global", scope: `tab:${tab}`, items: inTab.map((folder) => folderRef(folder.id)), updated: inTab[inTab.length - 1]!.updated }]
  })
  return { records: [...rest, ...folders, ...orders], migrated: true }
}

// Skills once had two switches per agent: the skill row and a "skill" tool
// permission row per skill (perm:skill:<id>). Both installed the same deny,
// so they could disagree on screen while either one took the skill away. The
// skill row is now the only switch, so each stored state on a per-skill
// permission row moves onto the skill at the same address. When both are
// stored there and disagree, off wins: either one already took the skill away.
//
// The skill tool's own catalog rows (Approval) and user-created skill rules
// are real permissions and stay. A per-skill row's text (its pattern) has no
// meaning on a skill and is dropped with it.
//
// Idempotent: a migrated store has no per-skill permission records left.
export function migrateSkillPermissions(records: readonly StoredRecord[]): {
  records: StoredRecord[]
  migrated: boolean
} {
  const catalogCategories = new Set(catalogFor("skill").map((category) => category.id))
  const userRules = new Set(records.flatMap((record) => (record.type === "rule" && record.tool === "skill" ? [record.id] : [])))
  const skillOf = (record: StoredRecord): string | undefined => {
    if (record.type !== "customization" || !record.item.startsWith("perm:skill:")) return undefined
    const id = record.item.slice("perm:skill:".length)
    if (id.length === 0 || userRules.has(id)) return undefined
    if (id.includes(".") && catalogCategories.has(id.slice(0, id.indexOf(".")))) return undefined
    return id
  }
  if (!records.some((record) => skillOf(record) !== undefined)) return { records: [...records], migrated: false }
  const addressKey = (record: CustomizationRecord, item: string) =>
    JSON.stringify([record.level, record.agent, record.team ?? null, record.catalogue ?? null, item, record.section])
  const out: StoredRecord[] = []
  const skillAt = new Map<string, number>()
  for (const record of records) {
    if (skillOf(record) !== undefined) continue
    if (record.type === "customization" && record.item.startsWith("skill:")) skillAt.set(addressKey(record, record.item), out.length)
    out.push(record)
  }
  for (const record of records) {
    const skill = skillOf(record)
    if (skill === undefined || record.type !== "customization" || record.state === undefined) continue
    const key = addressKey(record, `skill:${skill}`)
    const at = skillAt.get(key)
    if (at === undefined) {
      skillAt.set(key, out.length)
      out.push({
        type: "customization",
        level: record.level,
        agent: record.agent,
        ...(record.team === undefined ? {} : { team: record.team }),
        ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
        item: `skill:${skill}`,
        section: null,
        state: record.state,
        basedOn: "",
        ...(record.basedOnState === undefined ? {} : { basedOnState: record.basedOnState }),
        updated: record.updated,
      })
      continue
    }
    const existing = out[at] as CustomizationRecord
    if (existing.state === "off" || record.state === existing.state) continue
    out[at] = { ...existing, state: record.state === "off" ? "off" : existing.state ?? record.state }
  }
  return { records: out, migrated: true }
}

// Rows split out of a shell family (permission-catalog.ts): "Git merge" out of
// "Git working-tree changes" and "Git worktree add" out of "Git branches, tags
// and worktrees". Before the split the family's state decided those commands
// too, so a state stored on the family carries over to the split-off row at the
// same address (unless that row has a record there already), and the family's
// record is re-based on its current text: the split is all that changed, so
// nothing is left to review. Only a state-only record based on the family's
// pre-split text moves; a customized text stays for the user to review.
//
// Idempotent: a migrated record is re-based, so a later load finds nothing.
const splitRows = [
  {
    family: "commands.git-changes",
    row: "commands.git-merge",
    before: ["Git working-tree changes", "git add *", "git stash", "git stash *", "git clean *", "git restore *", "git switch *", "git merge *", "git cherry-pick *", "git revert *", "git rm *", "git mv *", "git apply *", "git am *", "git pull", "git pull *"],
  },
  {
    family: "commands.git-refs",
    row: "commands.git-worktree-add",
    before: ["Git branches, tags and worktrees", "git branch -d *", "git branch -D *", "git branch -m *", "git branch -M *", "git branch -f *", "git tag *", "git update-ref *", "git worktree add *", "git worktree remove *", "git worktree prune *", "git worktree move *"],
  },
].map((split) => ({ ...split, before: fingerprint(split.before.join("\n")) }))

export function migrateSplitRows(records: readonly StoredRecord[]): {
  records: StoredRecord[]
  migrated: boolean
} {
  const splitOf = (record: StoredRecord) =>
    record.type === "customization" && record.state !== undefined && record.text === undefined
      ? splitRows.find((split) => record.item === `perm:shell:${split.family}` && record.basedOn === split.before)
      : undefined
  if (!records.some((record) => splitOf(record) !== undefined)) return { records: [...records], migrated: false }
  const rows = catalogFor("shell").find((category) => category.id === "commands")?.rows ?? []
  const textOf = (id: string) => {
    const row = rows.find((entry) => `commands.${entry.id}` === id)
    return row === undefined ? "" : fingerprint([row.label, ...(row.patterns ?? [])].join("\n"))
  }
  const addressKey = (record: CustomizationRecord, item: string) =>
    JSON.stringify([record.level, record.agent, record.team ?? null, record.catalogue ?? null, item, record.section])
  const stored = new Set(records.flatMap((record) => (record.type === "customization" ? [addressKey(record, record.item)] : [])))
  return {
    records: records.flatMap((record): StoredRecord[] => {
      const split = splitOf(record)
      if (split === undefined || record.type !== "customization" || record.state === undefined) return [record]
      const rebased = { ...record, basedOn: textOf(split.family) }
      const item = `perm:shell:${split.row}`
      if (stored.has(addressKey(record, item))) return [rebased]
      stored.add(addressKey(record, item))
      return [
        rebased,
        {
          type: "customization",
          level: record.level,
          agent: record.agent,
          ...(record.team === undefined ? {} : { team: record.team }),
          ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
          item,
          section: record.section,
          state: record.state,
          basedOn: textOf(split.row),
          ...(record.basedOnState === undefined ? {} : { basedOnState: record.basedOnState }),
          updated: record.updated,
        },
      ]
    }),
    migrated: true,
  }
}

// Idempotent: an existing whole-row override (section: null customization with
// text on a split row) becomes section overrides. Section overrides already
// stored stay on top. The prompt comes out byte-identical before and after.
// Verify by assembling before and after inside the migration: if they differ,
// do not migrate that row.
export function migrateWholeRows(records: readonly StoredRecord[]): {
  records: StoredRecord[]
  migrated: boolean
} {
  const needsMigration = (record: StoredRecord): boolean => {
    if (record.type !== "customization" || record.section !== null || record.text === undefined) return false
    const manualSplit = records.find((r): r is SplitRecord => r.type === "split" && r.item === record.item)
    const split = manualSplit !== undefined ? manual(record.text, manualSplit.boundaries) : derive(record.text, record.item)
    return split.kind !== "whole" && split.sections.length > 1
  }

  if (!records.some(needsMigration)) return { records: [...records], migrated: false }

  const out: StoredRecord[] = []
  let migrated = false

  for (const record of records) {
    if (!needsMigration(record)) {
      out.push(record)
      continue
    }

    const custom = record as CustomizationRecord
    const manualSplit = records.find((r): r is SplitRecord => r.type === "split" && r.item === custom.item)
    const split = manualSplit !== undefined ? manual(custom.text!, manualSplit.boundaries) : derive(custom.text!, custom.item)

    const existingSectionOverrides = new Map<string, string>()
    for (const r of records) {
      if (
        r.type === "customization" &&
        r.item === custom.item &&
        r.level === custom.level &&
        r.agent === custom.agent &&
        sameTeam(r.team, custom.team) &&
        catalogueMatches(custom.agent, r.catalogue, custom.catalogue) &&
        r.section !== null &&
        r.text !== undefined
      ) {
        existingSectionOverrides.set(r.section, r.text)
      }
    }

    const assembledBefore = assembleWithOverrides(custom.text!, split, new Set(), existingSectionOverrides)

    const candidateSectionRecords: CustomizationRecord[] = []
    const allOverrides = new Map(existingSectionOverrides)

    const baseSplit =
      custom.basedOnText !== undefined
        ? (manualSplit !== undefined ? manual(custom.basedOnText, manualSplit.boundaries) : derive(custom.basedOnText, custom.item))
        : undefined

    for (const sec of split.sections) {
      if (existingSectionOverrides.has(sec.id)) continue

      const secText = slice(custom.text!, sec)
      const baseSec = baseSplit?.sections.find((s) => s.id === sec.id)
      const baseSecText = baseSec !== undefined && custom.basedOnText !== undefined ? slice(custom.basedOnText, baseSec) : undefined

      allOverrides.set(sec.id, secText)
      candidateSectionRecords.push({
        type: "customization",
        level: custom.level,
        agent: custom.agent,
        ...(custom.team !== undefined ? { team: custom.team } : {}),
        ...(custom.catalogue !== undefined ? { catalogue: custom.catalogue } : {}),
        item: custom.item,
        section: sec.id,
        text: secText,
        basedOn: baseSecText !== undefined ? fingerprint(baseSecText) : fingerprint(secText),
        ...(baseSecText !== undefined ? { basedOnText: baseSecText } : {}),
        updated: custom.updated,
      })
    }

    const baseTextForAfter = custom.basedOnText ?? custom.text!
    const baseSplitForAfter = manualSplit !== undefined ? manual(baseTextForAfter, manualSplit.boundaries) : derive(baseTextForAfter, custom.item)
    const assembledAfter = assembleWithOverrides(baseTextForAfter, baseSplitForAfter, new Set(), allOverrides)

    const norm = (s: string) => s.replace(/\n(?:[ \t]*\n)+/g, "\n\n").trim()
    const safeToMigrate = norm(assembledAfter) === norm(assembledBefore)

    if (!safeToMigrate) {
      out.push(record)
      continue
    }

    migrated = true
    for (const newSec of candidateSectionRecords) {
      out.push(newSec)
    }

    if (custom.state !== undefined || custom.pin !== undefined || custom.requires !== undefined) {
      const { text: _t, basedOnText: _b, ...kept } = custom
      out.push(kept)
    }
  }

  return { records: out, migrated }
}

// The catalogue split: before it there was one shared "everyone" inventory at
// `{ level: "defaults", agent: null }`, and every agent — stand-alone or team
// member — resolved through it. After it there are two, and a team member
// reads only the Teams one. So a store with no catalogue anywhere is a
// pre-split store: copy each shared row into the Teams catalogue so everything
// that applied to everyone still applies to everyone.
//
// Idempotent by construction: the copies carry `catalogue: "teams"`, so the
// "no record carries a catalogue" test is false on every later load, and a
// store that already holds a Teams copy is returned untouched.
export function migrateCatalogues(records: readonly StoredRecord[]): {
  records: StoredRecord[]
  migrated: boolean
} {
  const shared = records.filter(isSharedDefaults)
  if (shared.length === 0) return { records: [...records], migrated: false }
  if (records.some((record) => isInventory(record) && record.catalogue !== undefined))
    return { records: [...records], migrated: false }
  return { records: [...records, ...shared.map((record) => ({ ...record, catalogue: "teams" as Catalogue }))], migrated: true }
}

// The Basic team preset replaced the six Plus agent presets and the three
// shipped team presets (opencodeplus-team, starter, review). A store written
// before that keeps working without user action:
//
// - every link that named a retired Plus agent preset moves to the Basic
//   member preset of the same name;
// - every link that named a member preset of a retired team preset moves to
//   the Basic member the old member carried (`retiredMemberPresets`); a link
//   naming anything else (a retired team preset itself, an unknown member id)
//   is left exactly as it is and reads as a missing preset;
// - a preset-level customization (level `preset`, no team) owned by a retired
//   Plus agent preset moves onto its Basic member preset, the address shape a
//   member preset uses (`team: { level: "preset", team: "basic" }`), so user
//   edits keep applying.
//
// Idempotent by construction: nothing that already names a Basic member ref
// or carries the Basic team address is touched, so a second load finds
// nothing to migrate.
export function migrateRemovedPresets(records: readonly StoredRecord[]): {
  records: StoredRecord[]
  migrated: boolean
} {
  let migrated = false
  const out = records.map((record): StoredRecord => {
    if (record.type === "link") {
      const preset = basicPresetOf(record.preset)
      if (preset === undefined) return record
      migrated = true
      return { ...record, preset }
    }
    if (
      record.type === "customization" &&
      record.level === "preset" &&
      record.team === undefined &&
      record.agent !== null &&
      basicMemberForRetiredAgent(record.agent) !== undefined
    ) {
      migrated = true
      return { ...record, team: { level: "preset" as const, team: basicTeamId } }
    }
    return record
  })
  return { records: out, migrated }
}

// The Basic member preset a retired preset ref maps to; undefined when the ref
// names anything else (including a ref that already names a Basic member).
function basicPresetOf(preset: PresetRef): PresetRef | undefined {
  if (preset.kind === "agent") {
    const member = basicMemberForRetiredAgent(preset.id)
    return member === undefined ? undefined : { kind: "member", team: basicTeamId, id: member }
  }
  if (preset.kind !== "member") return undefined
  const member = retiredMemberPresets[preset.team]?.[preset.id]
  return member === undefined ? undefined : { kind: "member", team: basicTeamId, id: member }
}

// The record kinds the catalogue split applies to. Teams, links, Defaults
// entries and presets are not inventory rows and never take part in it.
type InventoryRecord = CustomizationRecord | SplitRecord | ModelRecord | RuleRecord

function isInventory(record: StoredRecord): record is InventoryRecord {
  return record.type === "customization" || record.type === "split" || record.type === "model" || record.type === "rule"
}

function isSharedDefaults(record: StoredRecord): record is InventoryRecord {
  if (!isInventory(record)) return false
  return record.level === "defaults" && record.agent === null && record.team === undefined
}

export interface SaveOptions {
  /**
   * Set only by the read-triggered load migrations (`ensureCatalogues`): a
   * read must never create a project store that does not exist yet. While one
   * is missing its project rows stay in the global file (so nothing is lost);
   * a later real write moves them into the store it creates.
   */
  readonly readTriggeredMigration?: boolean
}

export async function save(projectDir: string, input: SaveInput, options?: SaveOptions): Promise<SaveResult> {
  // Fixed order (global then project) so two projects saving concurrently
  // cannot interleave: each save holds both gates across read+write.
  return withLock(globalGateKey(), () =>
    withLock(projectGateKey(projectDir), () => write(projectDir, input, options)),
  )
}

/**
 * Load, decide and save as one step under both write gates, so what `change`
 * checks — including other projects' stores and the linked-projects index,
 * which every in-process save writes under the same global gate — cannot
 * change between the check and the commit. `change` answers its result and,
 * to write, the next record list; without `records` nothing is written.
 * It runs inside the gates, so it must not call `save` or another gated
 * write; `gate.forget` drops index entries in place.
 */
export async function updateGated<T>(
  projectDir: string,
  change: (
    loaded: Loaded,
    gate: { forget: (projectDirs: readonly string[]) => Promise<void> },
  ) => Promise<{ readonly result: T; readonly records?: readonly StoredRecord[] }>,
): Promise<{ result: T; saved: SaveResult | undefined }> {
  return withLock(globalGateKey(), () =>
    withLock(projectGateKey(projectDir), async () => {
      const loaded = await load(projectDir)
      const decided = await change(loaded, { forget: dropLinkedProjects })
      if (decided.records === undefined) return { result: decided.result, saved: undefined }
      const saved = await write(projectDir, {
        expectedProjectRevision: loaded.projectRevision,
        expectedGlobalRevision: loaded.globalRevision,
        records: decided.records,
      })
      return { result: decided.result, saved }
    }),
  )
}

// Persist the load-time migrations once, on the first load that sees a
// pre-split store or links to the retired Plus presets, so what they moved
// lands in one revision the log can name (one line per migration). A store
// that needs nothing is read and left alone; a concurrent writer that wins
// the revision race simply migrates on its own next load.
export async function ensureCatalogues(projectDir: string): Promise<{
  migrated: boolean
  presetsMigrated: boolean
  skillsMigrated: boolean
  splitsMigrated: boolean
  wholeRowsMigrated: boolean
  foldersMigrated: boolean
  rowlinksMigrated: boolean
  loaded: Loaded
  revision: number
}> {
  const current = await load(projectDir)
  const none = { migrated: false, presetsMigrated: false, skillsMigrated: false, splitsMigrated: false, wholeRowsMigrated: false, foldersMigrated: false, rowlinksMigrated: false }
  if (
    !current.cataloguesMigrated &&
    !current.presetsMigrated &&
    !current.skillsMigrated &&
    !current.splitsMigrated &&
    !current.wholeRowsMigrated &&
    !current.foldersMigrated &&
    !current.rowlinksMigrated
  )
    return { ...none, loaded: current, revision: current.globalRevision }
  const saved = await save(projectDir, {
    expectedProjectRevision: current.projectRevision,
    expectedGlobalRevision: current.globalRevision,
    records: current.records,
  }, { readTriggeredMigration: true })
  if (!saved.ok) return { ...none, loaded: saved.current, revision: saved.current.globalRevision }
  return {
    migrated: current.cataloguesMigrated,
    presetsMigrated: current.presetsMigrated,
    skillsMigrated: current.skillsMigrated,
    splitsMigrated: current.splitsMigrated,
    wholeRowsMigrated: current.wholeRowsMigrated,
    foldersMigrated: current.foldersMigrated,
    rowlinksMigrated: current.rowlinksMigrated,
    loaded: await load(projectDir),
    revision: saved.globalRevision,
  }
}

async function write(projectDir: string, input: SaveInput, options?: SaveOptions): Promise<SaveResult> {
  const current = await load(projectDir)
  const projectStale = input.expectedProjectRevision !== current.projectRevision
  const globalStale = input.expectedGlobalRevision !== current.globalRevision
  if (projectStale || globalStale)
    return { ok: false, reason: "stale", store: projectStale ? "project" : "global", current }
  const routed = route(input.records)
  // A migrating load reroutes v1 rows across stores, so the first save must
  // write v2 to both stores even when the rerouted records already match. The
  // catalogue duplication and the retired-preset move are the same situation:
  // both sides of `same` are already migrated (the load applied them in
  // memory), so only these flags make the moved records reach disk.
  const forced = current.migrated || current.cataloguesMigrated || current.presetsMigrated || current.skillsMigrated || current.splitsMigrated || current.wholeRowsMigrated || current.foldersMigrated || current.rowlinksMigrated
  const projectMissing = !(await Bun.file(projectRecordsPath(projectDir)).exists())
  // A read-triggered migration never writes a missing project store, and a
  // forced rewrite still never writes an empty one into a directory that has
  // none: either way `.opencodeplus` is left for a real project write.
  const projectChanged =
    options?.readTriggeredMigration === true && projectMissing
      ? false
      : (forced && !(projectMissing && routed.project.length === 0)) ||
        !same(currentProjectRecords(current.records), routed.project)
  // While no project store exists, project-level rows have no other file:
  // they ride the global write, and a global-only save can never drop them.
  // Once this write creates the project store, they move there instead.
  const globalRecords = projectMissing && !projectChanged ? canonical(input.records) : routed.global
  // The physical global file is `current.records` only when the project file
  // is absent; otherwise it is the non-project rows. Comparing against the
  // physical side drops held project rows from the global file when they move.
  const globalCurrent = projectMissing ? canonical(current.records) : currentGlobalRecords(current.records)
  const globalChanged = forced || !same(globalCurrent, globalRecords)
  // An unchanged save is a no-op: neither file is touched, neither revision moves.
  if (!projectChanged && !globalChanged)
    return {
      ok: true,
      projectRevision: current.projectRevision,
      globalRevision: current.globalRevision,
      changed: { project: false, global: false },
    }
  const nextProject = projectChanged ? current.projectRevision + 1 : current.projectRevision
  const nextGlobal = globalChanged ? current.globalRevision + 1 : current.globalRevision
  if (projectChanged) {
    // The project store write creates `.opencodeplus` on demand; `ensure`
    // leaves an inherited ancestor config (and its protectedAgents) alone.
    await ensure(projectDir)
    await writeStore(projectRecordsPath(projectDir), nextProject, routed.project)
  }
  if (globalChanged) await writeStore(globalRecordsPath(), nextGlobal, globalRecords)
  if (projectChanged) await indexProjectLinks(projectDir, routed.project.some((record) => record.type === "link"))
  return {
    ok: true,
    projectRevision: nextProject,
    globalRevision: nextGlobal,
    changed: { project: projectChanged, global: globalChanged },
  }
}

// The global index of projects whose store holds a link (paths.ts
// linkedProjectsPath). Every save that writes a project store keeps it
// current under the global gate `save` holds. A listed project is only a
// place to look: its own store is the truth, so an entry for a project that
// moved, was deleted or dropped its links never answers for it (see
// projectLinks) and is forgotten by the next preset deletion.
const LinkedProjects = Schema.Struct({ version: Schema.Literal(1), projects: Schema.Array(Schema.String) })
const decodeLinkedProjects = Schema.decodeUnknownOption(Schema.fromJsonString(LinkedProjects))

/** Every project directory the index lists (absolute). */
export async function linkedProjects(): Promise<string[]> {
  const text = await readFile(linkedProjectsPath())
  if (text === undefined) return []
  return [...(Option.getOrUndefined(decodeLinkedProjects(text))?.projects ?? [])]
}

/** The project-level links a project's own store holds; undefined when it has no store (moved or deleted). */
export async function projectLinks(projectDir: string): Promise<LinkRecord[] | undefined> {
  const text = await readFile(projectRecordsPath(projectDir))
  if (text === undefined) return undefined
  return parseFile(text).records.filter((record): record is LinkRecord => record.type === "link" && record.level === "project")
}

// Drop projects from the index (entries that no longer answer). The caller
// holds the global gate (updateGated's `gate.forget`).
async function dropLinkedProjects(projectDirs: readonly string[]): Promise<void> {
  if (projectDirs.length === 0) return
  const drop = new Set(projectDirs.map((dir) => path.resolve(dir)))
  await writeLinkedProjects((await linkedProjects()).filter((dir) => !drop.has(dir)))
}

async function indexProjectLinks(projectDir: string, linked: boolean): Promise<void> {
  const directory = path.resolve(projectDir)
  const listed = await linkedProjects()
  if (listed.includes(directory) === linked) return
  await writeLinkedProjects(linked ? [...listed, directory].toSorted() : listed.filter((dir) => dir !== directory))
}

async function writeLinkedProjects(projects: readonly string[]): Promise<void> {
  const target = linkedProjectsPath()
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, `${JSON.stringify({ version: 1, projects })}\n`)
}

async function writeStore(target: string, revision: number, records: readonly StoredRecord[]): Promise<void> {
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, serialize(revision, records))
}

function globalGateKey(): string {
  return `global:${path.resolve(globalRecordsPath())}`
}

function projectGateKey(projectDir: string): string {
  return `project:${path.resolve(projectDir)}`
}

function currentProjectRecords(records: readonly StoredRecord[]): StoredRecord[] {
  return records.filter((record) => record.level === "project")
}

function currentGlobalRecords(records: readonly StoredRecord[]): StoredRecord[] {
  return records.filter((record) => record.level !== "project")
}

async function withLock<T>(key: string, task: () => Promise<T>): Promise<T> {
  const previous = gates.get(key) ?? Promise.resolve()
  let release: () => void = () => undefined
  const gate = new Promise<void>((resolve) => {
    release = resolve
  })
  const entry = previous.then(() => gate)
  gates.set(key, entry)
  await previous
  try {
    return await task()
  } finally {
    release()
    if (gates.get(key) === entry) gates.delete(key)
  }
}

function parseFile(text: string | undefined): ParsedFile {
  if (text === undefined) return { revision: 0, records: [], migrated: false }
  const lines = text.split("\n").filter((line) => line.trim().length > 0)
  if (lines.length === 0) return { revision: 0, records: [], migrated: false }
  const v2 = Option.getOrUndefined(decodeV2Header(lines[0]))
  if (v2 !== undefined) return { revision: v2.revision, ...parseV2(lines.slice(1)), migrated: false }
  // Any header without "version" is v1 and must be migrated; never write v1 again.
  const v1 = Option.getOrUndefined(decodeV1Header(lines[0]))
  return { revision: v1?.revision ?? 0, records: lines.slice(1).flatMap(migrateLine), migrated: true }
}

// Teams route by level like any other record: project teams to the project
// file, global and defaults teams to the global file. No team ever lands in
// a defaults bucket: there is no defaults store file.
function route(records: readonly StoredRecord[]): { project: StoredRecord[]; global: StoredRecord[] } {
  const project = records.filter((record) => record.level === "project")
  const global = records.filter((record) => record.level !== "project")
  return { project: canonical(project), global: canonical(global) }
}

function parseV2(lines: string[]) {
  let rowlinksMigrated = false
  const records = lines.flatMap((line): (StoredRecord | LegacyCategory)[] => {
    const record = Option.getOrUndefined(decodeV2Record(line))
    if (record === undefined) return []
    if (record.type === "category") return [record]
    if (record.type === "folder")
      return [
        {
          type: "folder",
          level: record.level,
          ...(record.owner === undefined ? {} : { owner: record.owner }),
          tab: record.tab,
          id: record.id,
          name: record.name,
          ...(record.parent === undefined ? {} : { parent: record.parent }),
          items: [...record.items],
          updated: record.updated,
        },
      ]
    if (record.type === "order")
      return [{ type: "order", level: record.level, scope: record.scope, items: [...record.items], ...(record.basedOn === undefined ? {} : { basedOn: record.basedOn }), updated: record.updated }]
    if (record.type === "rowlink") {
      // Retired one-way switches become reversible conditions. Keep the pair,
      // owner, enabled state and provenance; persist via the existing migration gate.
      if (record.link === "oneway") rowlinksMigrated = true
      return [
        {
          type: "rowlink",
          level: record.level,
          agent: record.agent,
          ...(record.team === undefined ? {} : { team: record.team }),
          ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
          item: record.item,
          section: record.section,
          target: record.target,
          targetSection: record.targetSection,
          link: record.link === "oneway" ? "shownWhenOff" : record.link,
          ...(record.enabled === undefined ? {} : { enabled: record.enabled }),
          updated: record.updated,
        },
      ]
    }
    if (record.type === "team")
      return [
        {
          type: "team",
          level: record.level,
          team: record.team,
          enabled: record.enabled,
          updated: record.updated,
        },
      ]
    if (record.type === "split")
      return [
        {
          type: "split",
          level: record.level,
          agent: record.agent,
          ...(record.team === undefined ? {} : { team: record.team }),
          ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
          item: record.item,
          boundaries: record.boundaries.map((boundary): Boundary => ({ ...boundary })),
          updated: record.updated,
        },
      ]
    if (record.type === "model")
      return [
        {
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
          ...(record.prompt === undefined ? {} : { prompt: record.prompt }),
          ...storedCompaction(record),
          ...(record.removed === undefined ? {} : { removed: record.removed }),
          ...(record.originalCandidate === undefined ? {} : { originalCandidate: record.originalCandidate }),
          updated: record.updated,
        },
      ]
    if (record.type === "modelSettings") return [stable(record)]
    if (record.type === "link" || record.type === "entry" || record.type === "preset") return [stable(record)]
    if (record.type === "rule")
      return [
        {
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
        },
      ]
    return [
      {
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
      },
    ]
  })
  return { records, rowlinksMigrated }
}

function migrateLine(line: string): StoredRecord[] {
  const record = Option.getOrUndefined(decodeV1Record(line))
  if (record === undefined) return []
  const item = migrateItem(record.item)
  if (record.agent === "*")
    return [
      {
        type: "customization",
        level: "defaults",
        agent: null,
        item,
        section: null,
        ...(record.text === undefined ? {} : { text: record.text }),
        ...(migrateState(record.state) === undefined ? {} : { state: migrateState(record.state) }),
        basedOn: record.basedOn,
        ...(record.reviewed === undefined ? {} : { acknowledged: record.reviewed }),
        updated: record.updated,
      },
    ]
  return [
    {
      type: "customization",
      level: "project",
      agent: record.agent,
      item,
      section: null,
      ...(record.text === undefined ? {} : { text: record.text }),
      ...(migrateState(record.state) === undefined ? {} : { state: migrateState(record.state) }),
      basedOn: record.basedOn,
      ...(record.reviewed === undefined ? {} : { acknowledged: record.reviewed }),
      updated: record.updated,
    },
  ]
}

function migrateItem(item: string): string {
  if (item.startsWith("prompt:")) return "system:role"
  if (item.startsWith("instruction:")) return `system:${item.slice("instruction:".length)}`
  return item
}

function migrateState(state: "inherit" | "enabled" | "disabled"): "on" | "off" | undefined {
  if (state === "enabled") return "on"
  if (state === "disabled") return "off"
  return undefined
}

function serialize(revision: number, records: readonly StoredRecord[]): string {
  const lines = canonical(records).map((record) => JSON.stringify(stable(record)))
  return [JSON.stringify({ version: VERSION, revision }), ...lines].join("\n") + "\n"
}

// Canonically ordered and stably keyed so an unchanged save is a no-op.
function same(left: readonly StoredRecord[], right: readonly StoredRecord[]): boolean {
  return JSON.stringify(canonical(left).map(stable)) === JSON.stringify(canonical(right).map(stable))
}

// Canonical order and stably keyed content for callers that diff record sets
// (the change log names added/removed/modified rows without reimplementing
// the comparison).
export function canonical(records: readonly StoredRecord[]): StoredRecord[] {
  return [...records].sort(compareRecords)
}

function compareRecords(left: StoredRecord, right: StoredRecord): number {
  const leftKey = sortKey(left)
  const rightKey = sortKey(right)
  for (let i = 0; i < leftKey.length; i++) {
    if (leftKey[i] !== rightKey[i]) return leftKey[i] < rightKey[i] ? -1 : 1
  }
  return 0
}

// Teams have no item/agent/section, so they order by team name first, then
// level; enabled and updated last keep the order total for identical keys.
// Models order by provider, model, and variant, then agent and level; rules
// order by tool and id, then agent and level. Both end with `updated` so the
// order is total and an unchanged save stays a no-op.
// Links order by owner then preset; Defaults entries by catalogue, team
// pattern and name; presets by kind, team and id. All end with `updated`.
function sortKey(record: StoredRecord): string[] {
  if (record.type === "team") return ["team", record.team, record.level, String(record.enabled), record.updated]
  if (record.type === "folder") return ["folder", record.tab, record.id, record.updated]
  if (record.type === "order") return ["order", record.scope, record.updated]
  if (record.type === "modelSettings")
    return ["modelSettings", record.providerID ?? "", record.modelID ?? "", record.updated]
  if (record.type === "entry") return ["entry", record.catalogue, record.team ?? "", record.name, record.updated]
  if (record.type === "preset") return ["preset", record.kind, record.team ?? "", record.id, record.updated]
  const teamKey = record.team !== undefined ? `${record.team.level}:${record.team.team}` : ""
  const catalogueKey = record.catalogue ?? ""
  if (record.type === "link")
    return [
      "link",
      String(record.agent),
      teamKey,
      catalogueKey,
      record.level,
      record.preset.kind,
      record.preset.kind === "member" ? record.preset.team : "",
      record.preset.id,
      record.updated,
    ]
  if (record.type === "model")
    return [
      "model",
      record.providerID,
      record.modelID,
      record.variant ?? "",
      String(record.agent),
      teamKey,
      catalogueKey,
      record.level,
      record.active === true ? "active" : "",
      record.warming ?? "",
      record.updated,
    ]
  if (record.type === "rule")
    return ["rule", record.tool, record.id, String(record.agent), teamKey, catalogueKey, record.level, record.updated]
  if (record.type === "rowlink")
    return [
      "rowlink",
      String(record.agent),
      teamKey,
      catalogueKey,
      record.level,
      record.item,
      record.section ?? "",
      record.target,
      record.targetSection ?? "",
      record.link,
      record.updated,
    ]
  return [
    record.type,
    record.item,
    String(record.agent),
    teamKey,
    catalogueKey,
    record.level,
    record.type === "customization" ? String(record.section) : "",
  ]
}

// A model row's or Defaults › Models row's compaction fields in a fixed key
// order, absent keys absent, so a store without them stays byte-identical.
function storedCompaction(record: ModelCompactionFields): ModelCompactionFields {
  return {
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
  }
}

export function stable(record: StoredRecord): StoredRecord {
  if (record.type === "link")
    return {
      type: "link",
      level: record.level,
      agent: record.agent,
      ...(record.team === undefined ? {} : { team: { level: record.team.level, team: record.team.team } }),
      ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
      preset: stablePreset(record.preset),
      updated: record.updated,
    }
  if (record.type === "entry")
    return {
      type: "entry",
      level: "defaults",
      catalogue: record.catalogue,
      ...(record.team === undefined ? {} : { team: record.team }),
      name: record.name,
      updated: record.updated,
    }
  if (record.type === "preset")
    return {
      type: "preset",
      level: "preset",
      kind: record.kind,
      id: record.id,
      ...(record.team === undefined ? {} : { team: record.team }),
      ...(record.fields === undefined
        ? {}
        : {
            fields: {
              ...(record.fields.mode === undefined ? {} : { mode: record.fields.mode }),
              ...(record.fields.description === undefined ? {} : { description: record.fields.description }),
            },
          }),
      updated: record.updated,
    }
  if (record.type === "team")
    return {
      type: "team",
      level: record.level,
      team: record.team,
      enabled: record.enabled,
      updated: record.updated,
    }
  if (record.type === "folder")
    return {
      type: "folder",
      level: record.level,
      ...(record.owner === undefined ? {} : { owner: record.owner }),
      tab: record.tab,
      id: record.id,
      name: record.name,
      ...(record.parent === undefined ? {} : { parent: record.parent }),
      items: [...record.items],
      updated: record.updated,
    }
  if (record.type === "order")
    return { type: "order", level: record.level, scope: record.scope, items: [...record.items], ...(record.basedOn === undefined ? {} : { basedOn: record.basedOn }), updated: record.updated }
  if (record.type === "rowlink")
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
      link: record.link,
      ...(record.enabled === undefined ? {} : { enabled: record.enabled }),
      updated: record.updated,
    }
  if (record.type === "modelSettings")
    return {
      type: "modelSettings",
      level: "defaults",
      ...(record.providerID === undefined ? {} : { providerID: record.providerID }),
      ...(record.modelID === undefined ? {} : { modelID: record.modelID }),
      ...(record.warming === undefined ? {} : { warming: record.warming }),
      ...(record.interval === undefined ? {} : { interval: record.interval }),
      ...(record.prompt === undefined ? {} : { prompt: record.prompt }),
      ...(record.effort === undefined ? {} : { effort: record.effort }),
      ...storedCompaction(record),
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
      ...(record.prompt === undefined ? {} : { prompt: record.prompt }),
      ...storedCompaction(record),
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
  if (record.type === "split")
    return {
      type: "split",
      level: record.level,
      agent: record.agent,
      ...(record.team === undefined ? {} : { team: record.team }),
      ...(record.catalogue === undefined ? {} : { catalogue: record.catalogue }),
      item: record.item,
      boundaries: record.boundaries.map((boundary) => ({
        id: boundary.id,
        name: boundary.name,
        start: boundary.start,
        ...(boundary.depth !== undefined ? { depth: boundary.depth } : {}),
      })),
      updated: record.updated,
    }
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
}

function stablePreset(ref: PresetRef): PresetRef {
  if (ref.kind === "member") return { kind: "member", team: ref.team, id: ref.id }
  return { kind: ref.kind, id: ref.id }
}

async function readFile(target: string): Promise<string | undefined> {
  const file = Bun.file(target)
  if (!(await file.exists())) return undefined
  return file.text()
}
