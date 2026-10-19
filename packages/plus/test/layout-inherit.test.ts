// Folders and order flow down an owner's chain like text and on/off do: a tab
// without a layout of its own shows the first one down its chain (presets,
// Defaults, Global, then Project), takes its own copy with its first change,
// and that copy is to review once what it inherits changes. These tests use the
// real tree builder, planners and query engine.
import { expect, test } from "bun:test"
import { layoutPrint, type FolderRecord, type OrderRecord } from "../src/instructions/folders.js"
import { badgeLabels } from "../src/instructions/from-label.js"
import { fingerprint, type AgentSource, type Item, type LinkRecord } from "../src/instructions/model.js"
import { planFolderRename, planLayoutReview, planRowMove, type LayoutChange, type LayoutRecords } from "../src/instructions/ops.js"
import { query } from "../src/instructions/query.js"
import { expandedTree, type MemoInput, type TreeNode } from "../src/instructions/tree.js"

const UPDATED = "2026-01-01T00:00:00.000Z"
const tab = (level: string, owner: string) => `group:${level}:${owner}:tools`

function item(id: string, title: string): Item {
  return { id, kind: "tool", group: "native", title, text: `${title} text`, enabled: true, fingerprint: fingerprint(`${title} text`) }
}

// build is OpenCode's own agent, listed at every level; alpha is a project
// agent made from the build preset.
const agents: AgentSource[] = [
  { id: "build", scope: "defaults", origin: "native" },
  { id: "alpha", scope: "project", origin: "user" },
]
const links: LinkRecord[] = [{ type: "link", level: "project", agent: "alpha", preset: { kind: "agent", id: "build" }, updated: UPDATED }]

function folder(owner: string, slug: string, name: string, items: readonly string[]): FolderRecord {
  return { type: "folder", level: owner.startsWith("group:project:") ? "project" : "global", owner, tab: "tools", id: `${owner}:${slug}`, name, items, updated: UPDATED }
}

function order(owner: string, items: readonly string[], basedOn?: string): OrderRecord {
  return { type: "order", level: owner.startsWith("group:project:") ? "project" : "global", scope: `group:${owner}`, items, ...(basedOn === undefined ? {} : { basedOn }), updated: UPDATED }
}

function input(layout: LayoutRecords): MemoInput {
  return { items: [item("tool:bash", "bash"), item("tool:reader", "reader"), item("tool:skill", "skill")], records: [], agents, links, ...layout }
}

function childrenOf(nodes: readonly TreeNode[], id: string): string[] {
  const index = nodes.findIndex((node) => node.id === id)
  if (index === -1) throw new Error(`missing ${id}`)
  const depth = nodes[index]!.depth
  const out: string[] = []
  for (const node of nodes.slice(index + 1)) {
    if (node.depth <= depth) break
    if (node.depth === depth + 1) out.push(node.id)
  }
  return out
}

function planned(change: LayoutChange): LayoutRecords {
  if ("refusal" in change) throw new Error(`expected a plan, got refusal: ${change.refusal}`)
  return change.layout
}

// Global build keeps bash in a folder of its own.
const global = tab("global", "build")
const globalLayout: LayoutRecords = { folders: [folder(global, "mine", "Mine", ["tool:bash"])], orders: [order(global, [`folder:${global}:mine`])] }

test("a tab without its own layout shows the first one down its chain", () => {
  const project = tab("project", "build")
  const nodes = expandedTree(input(globalLayout))
  expect(childrenOf(nodes, `${project}:folder:${global}:mine`)).toEqual(["item:project:build:tool:bash"])
  // Defaults flows down to Global and Project alike.
  const defaults = tab("defaults", "build")
  const fromDefaults = expandedTree(input({ folders: [folder(defaults, "kept", "Kept", ["tool:reader"])], orders: [] }))
  expect(childrenOf(fromDefaults, `${global}:folder:${defaults}:kept`)).toEqual(["item:global:build:tool:reader"])
  expect(childrenOf(fromDefaults, `${project}:folder:${defaults}:kept`)).toEqual(["item:project:build:tool:reader"])
  // A preset's flows to the agents made from it.
  const preset = tab("preset", "build")
  const fromPreset = expandedTree(input({ folders: [folder(preset, "set", "Set", ["tool:skill"])], orders: [] }))
  expect(childrenOf(fromPreset, `${tab("project", "alpha")}:folder:${preset}:set`)).toEqual(["item:project:alpha:tool:skill"])
  // The folder filter key reads the folders a tab shows.
  expect(query(input(globalLayout), { where: "folder:Mine level:project agent:build" }).rows.map((row) => row.id)).toContain("item:project:build:tool:bash")
})

test("a list's order inside a tab flows down the same chain", () => {
  const nodes = expandedTree(input({ folders: [], orders: [{ ...order(`${global}:native`, ["tool:skill", "tool:reader", "tool:bash"]), scope: `group:${global}:native` }] }))
  expect(childrenOf(nodes, `${tab("project", "build")}:native`)).toEqual(["item:project:build:tool:skill", "item:project:build:tool:reader", "item:project:build:tool:bash"])
})

test("the first change copies the inherited layout to the tab, based on what it copied", () => {
  const project = tab("project", "build")
  const moved = planned(planRowMove(input(globalLayout), globalLayout, "item:project:build:tool:reader", { into: `${project}:folder:${global}:mine` }, UPDATED))
  // Global's own layout is untouched; Project now has its own copy.
  expect(moved.folders).toContainEqual(globalLayout.folders[0])
  expect(moved.folders.find((entry) => entry.owner === project)).toMatchObject({ id: `${project}:mine`, name: "Mine", items: ["tool:bash", "tool:reader"] })
  expect(moved.orders.find((entry) => entry.scope === `group:${project}`)).toMatchObject({ basedOn: layoutPrint(globalLayout, global, "tools") })
  const nodes = expandedTree(input(moved))
  expect(childrenOf(nodes, `${project}:folder:${project}:mine`)).toEqual(["item:project:build:tool:bash", "item:project:build:tool:reader"])
  expect(nodes.find((node) => node.id === project)?.badges.review).not.toBe(true)
})

test("a change to what a copy inherits puts it to review; keep acknowledges it, take drops the copy", () => {
  const project = tab("project", "build")
  const copied = planned(planRowMove(input(globalLayout), globalLayout, "item:project:build:tool:reader", { into: `${project}:folder:${global}:mine` }, UPDATED))
  // Global renames its folder after Project took its copy.
  const changed = planned(planFolderRename(copied, `${global}:mine`, "Renamed", UPDATED, global))
  const nodes = expandedTree(input(changed))
  const row = nodes.find((node) => node.id === project)
  expect(row?.badges.reviewOf).toEqual(["layout"])
  expect(badgeLabels(row!)).toContain("to review (layout)")
  // It counts with the rows to review above it, and find names it.
  expect(nodes.find((node) => node.id === "agent:project:build")?.badges.reviewCount).toBeGreaterThan(0)
  expect(query(input(changed), { where: "is:review" }).rows.map((entry) => entry.id)).toContain(project)
  // Global's own tab is not to review: it inherits nothing that changed.
  expect(nodes.find((node) => node.id === global)?.badges.reviewOf).toBeUndefined()

  const kept = planned(planLayoutReview(input(changed), changed, project, "keep", UPDATED))
  expect(expandedTree(input(kept)).find((node) => node.id === project)?.badges.reviewOf).toBeUndefined()
  expect(kept.folders.filter((entry) => entry.owner === project)).toEqual(changed.folders.filter((entry) => entry.owner === project))

  const taken = planned(planLayoutReview(input(changed), changed, project, "take", UPDATED))
  expect(taken.folders.some((entry) => entry.owner === project)).toBe(false)
  expect(taken.orders.some((entry) => entry.scope === `group:${project}`)).toBe(false)
  const after = expandedTree(input(taken))
  expect(after.find((node) => node.id === `${project}:folder:${global}:mine`)?.label).toBe("Renamed")
  expect("refusal" in planLayoutReview(input(taken), taken, project, "keep", UPDATED)).toBe(true)
})
