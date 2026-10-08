// Folders and display order (plus-1.2.0 S1a): the category records are gone
// after one load-time migration; folders and order records replace them. These
// tests use the real store file, written in its persisted format.
import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  createFolderRecord,
  deleteFolderRecord,
  renameFolderRecord,
  type FolderRecord,
  type OrderRecord,
} from "../src/instructions/folders.js"
import { ensureCatalogues, load } from "../src/instructions/store.js"
import { globalRecordsPath } from "../src/instructions/paths.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

const UPDATED = "2026-01-01T00:00:00.000Z"

async function isolated(): Promise<{ project: string }> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-folders-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  return { project: path.join(root, "project") }
}

function category(name: string, order: number, items: string[]) {
  return { type: "category", level: "global", name, order, items, updated: UPDATED }
}

async function writeGlobal(records: readonly object[]): Promise<void> {
  const lines = [JSON.stringify({ version: 2, revision: 1 }), ...records.map((record) => JSON.stringify(record))]
  await fs.mkdir(path.dirname(globalRecordsPath()), { recursive: true })
  await Bun.write(globalRecordsPath(), lines.join("\n") + "\n")
}

function folders(records: readonly unknown[]): FolderRecord[] {
  return records.filter((record): record is FolderRecord => (record as { type: string }).type === "folder")
}

function orders(records: readonly unknown[]): OrderRecord[] {
  return records.filter((record): record is OrderRecord => (record as { type: string }).type === "order")
}

test("categories migrate to one folder per tab they hold, items in order, and the category records go", async () => {
  const { project } = await isolated()
  await writeGlobal([
    category("Mine", 0, ["system:role", "tool:bash", "model:cpa/gpt"]),
    category("Other", 1, ["tool:reader"]),
  ])
  const loaded = await load(project)
  expect(loaded.records.some((record) => (record as { type: string }).type === "category")).toBe(false)
  expect(loaded.foldersMigrated).toBe(true)
  expect(folders(loaded.records)).toEqual([
    {
      type: "folder",
      level: "global",
      tab: "models",
      id: "models:mine",
      name: "Mine",
      items: ["model:cpa/gpt"],
      updated: UPDATED,
    },
    {
      type: "folder",
      level: "global",
      tab: "tools",
      id: "tools:mine",
      name: "Mine",
      items: ["tool:bash"],
      updated: UPDATED,
    },
    {
      type: "folder",
      level: "global",
      tab: "system",
      id: "system:mine",
      name: "Mine",
      items: ["system:role"],
      updated: UPDATED,
    },
    {
      type: "folder",
      level: "global",
      tab: "tools",
      id: "tools:other",
      name: "Other",
      items: ["tool:reader"],
      updated: UPDATED,
    },
  ])
  expect(orders(loaded.records).map((order) => [order.scope, order.items])).toEqual([
    ["tab:models", ["folder:models:mine"]],
    ["tab:tools", ["folder:tools:mine", "folder:tools:other"]],
    ["tab:system", ["folder:system:mine"]],
  ])
})

test("an empty category becomes an empty folder in Tools", async () => {
  const { project } = await isolated()
  await writeGlobal([category("Empty", 0, [])])
  const loaded = await load(project)
  expect(folders(loaded.records)).toEqual([
    { type: "folder", level: "global", tab: "tools", id: "tools:empty", name: "Empty", items: [], updated: UPDATED },
  ])
  expect(orders(loaded.records).map((order) => order.items)).toEqual([["folder:tools:empty"]])
})

test("a store with no categories is untouched by the migration", async () => {
  const { project } = await isolated()
  await writeGlobal([])
  const before = await load(project)
  expect(before.foldersMigrated).toBe(false)
  const persisted = await ensureCatalogues(project)
  expect(persisted.loaded.globalRevision).toBe(1)
  expect(persisted.loaded.records).toEqual([])
})

test("the migration persists once: after ensureCatalogues no category line is left", async () => {
  const { project } = await isolated()
  await writeGlobal([category("Mine", 0, ["tool:bash"])])
  const first = await ensureCatalogues(project)
  expect(first.foldersMigrated).toBe(true)
  expect(await Bun.file(globalRecordsPath()).text()).not.toContain('"type":"category"')
  const second = await load(project)
  expect(second.foldersMigrated).toBe(false)
  expect(folders(second.records).map((record) => record.id)).toEqual(["tools:mine"])
})

test("folders are created in a tab, nested, renamed and deleted in place", () => {
  const start = createFolderRecord([], { tab: "tools", name: "Mine" }, UPDATED)
  const withBash = start.map((record) => (record.type === "folder" ? { ...record, items: ["tool:bash"] } : record))
  const nested = createFolderRecord(withBash, { tab: "tools", name: "Inner", parent: "tools:mine" }, UPDATED)
  const inner = folders(nested).find((record) => record.id === "tools:inner")
  expect(inner?.parent).toBe("tools:mine")
  expect(folders(nested).find((record) => record.id === "tools:mine")?.items).toEqual([
    "tool:bash",
    "folder:tools:inner",
  ])
  const renamed = renameFolderRecord(nested, "tools:mine", "Renamed", UPDATED)
  expect(folders(renamed).find((record) => record.id === "tools:mine")?.name).toBe("Renamed")
  const duplicate = createFolderRecord(renamed, { tab: "tools", name: "Renamed" }, UPDATED)
  expect(folders(duplicate).map((record) => record.id)).toContain("tools:renamed")
  const numbered = createFolderRecord(duplicate, { tab: "tools", name: "Renamed" }, UPDATED)
  expect(folders(numbered).map((record) => record.id)).toContain("tools:renamed-2")
})

test("deleting a folder returns its rows to where it sat", () => {
  const records = [
    {
      type: "order",
      level: "global",
      scope: "tab:tools",
      items: ["tool:a", "folder:tools:mine", "tool:b"],
      updated: UPDATED,
    } as OrderRecord,
    {
      type: "folder",
      level: "global",
      tab: "tools",
      id: "tools:mine",
      name: "Mine",
      items: ["tool:c", "folder:tools:inner"],
      updated: UPDATED,
    } as FolderRecord,
    {
      type: "folder",
      level: "global",
      tab: "tools",
      id: "tools:inner",
      name: "Inner",
      parent: "tools:mine",
      items: ["tool:d"],
      updated: UPDATED,
    } as FolderRecord,
  ]
  const after = deleteFolderRecord(records, "tools:mine", UPDATED)
  expect(orders(after)[0]?.items).toEqual(["tool:a", "tool:c", "folder:tools:inner", "tool:b"])
  expect(folders(after)).toEqual([
    {
      type: "folder",
      level: "global",
      tab: "tools",
      id: "tools:inner",
      name: "Inner",
      items: ["tool:d"],
      updated: UPDATED,
    },
  ])
  expect("parent" in (folders(after)[0] ?? {})).toBe(false)
})
