// The S1b pick-up move mode (plus-1.2.0 B8): the pure planner moves a row
// through the S1a layout records without writing, and the tree renders the
// result. Route tests drive the actual keys in instructions-move-route.test.tsx.
import { expect, test } from "bun:test"
import { folderRef, groupScope, type FolderRecord, type OrderRecord } from "../src/instructions/folders.js"
import type { AgentSource, Item } from "../src/instructions/model.js"
import { fingerprint, resolve } from "../src/instructions/model.js"
import { planGroupMove } from "../src/instructions/ops.js"
import { expandedTree, type MemoInput, type TeamInput, type TreeNode } from "../src/instructions/tree.js"
import { advanceMove, startMove, type MoveState } from "../src/tui/instructions/move.js"

const UPDATED = "2026-01-01T00:00:00.000Z"
const TOOLS = "group:project:Implementer:tools"
const NATIVE = `${TOOLS}:native`
const AGENTS_USER = "group:project:agents:user"
const row = (item: string) => `item:project:Implementer:${item}`
const folderRow = (id: string) => `${TOOLS}:folder:${id}`

function item(overrides: Partial<Item> & Pick<Item, "id" | "kind" | "title">): Item {
  const text = overrides.text ?? "default text"
  return { group: "native", text, enabled: true, fingerprint: fingerprint(text), ...overrides }
}

function items(): Item[] {
  return [
    item({ id: "tool:bash", kind: "tool", title: "bash" }),
    item({ id: "tool:reader", kind: "tool", title: "reader" }),
    item({ id: "tool:special", kind: "tool", title: "special", group: "none" }),
  ]
}

function agents(): AgentSource[] {
  return [
    { id: "Implementer", scope: "project", origin: "user" },
    { id: "Helper", scope: "project", origin: "user" },
  ]
}

function folder(id: string, name: string, folderItems: readonly string[], parent?: string): FolderRecord {
  return {
    type: "folder",
    level: "global",
    tab: id.split(":")[0] ?? "tools",
    id,
    name,
    items: folderItems,
    updated: UPDATED,
    ...(parent === undefined ? {} : { parent }),
  }
}

function order(scope: string, orderItems: readonly string[]): OrderRecord {
  return { type: "order", level: "global", scope, items: orderItems, updated: UPDATED }
}

function memoOf(folders: readonly FolderRecord[], orders: readonly OrderRecord[] = [], teams: readonly TeamInput[] = []): MemoInput {
  return { items: items(), records: [], agents: agents(), folders, orders, teams }
}

const noLayout = { folders: [] as FolderRecord[], orders: [] as OrderRecord[] }

function nodeNamed(nodes: readonly TreeNode[], id: string): TreeNode {
  const node = nodes.find((entry) => entry.id === id)
  if (node === undefined) throw new Error(`no row ${id}`)
  return node
}

function childrenOf(nodes: readonly TreeNode[], id: string): TreeNode[] {
  const index = nodes.findIndex((node) => node.id === id)
  if (index === -1) return []
  const depth = nodes[index]?.depth ?? 0
  const out: TreeNode[] = []
  for (const node of nodes.slice(index + 1)) {
    if (node.depth <= depth) break
    if (node.depth === depth + 1) out.push(node)
  }
  return out
}

function started(input: MemoInput, id: string): MoveState {
  const layout = { folders: [...(input.folders ?? [])], orders: [...(input.orders ?? [])] }
  const result = startMove(nodeNamed(expandedTree(input), id), layout)
  if ("refusal" in result) throw new Error(`move refused: ${result.refusal}`)
  return result.state
}

function moved(input: MemoInput, state: MoveState, step: "up" | "down" | "in" | "out"): MoveState {
  const result = advanceMove(input, state, step)
  if ("refusal" in result) throw new Error(`step refused: ${result.refusal}`)
  return result.state
}

test("down and up reorder a row within its origin group through a group order", () => {
  const input = memoOf([])
  const start = started(input, row("tool:bash"))
  const down = moved(input, start, "down")
  const nativeOrder = down.layout.orders.find((record) => record.scope === groupScope(NATIVE))
  expect(nativeOrder?.items).toEqual(["tool:reader", "tool:bash"])

  const preview = expandedTree({ ...input, orders: down.layout.orders })
  expect(childrenOf(preview, NATIVE).map((node) => node.id)).toEqual([row("tool:reader"), row("tool:bash")])

  const back = moved({ ...input, orders: down.layout.orders }, down, "up")
  expect(back.layout.orders.find((record) => record.scope === groupScope(NATIVE))?.items).toEqual([
    "tool:bash",
    "tool:reader",
  ])
})

test("a row with no room in its group refuses rather than writing", () => {
  const input = memoOf([])
  const first = started(input, row("tool:bash"))
  const refused = advanceMove(input, first, "up")
  expect("refusal" in refused && refused.refusal).toContain("top")
})

test("right enters the folder below and left leaves it again", () => {
  const mine = folder("tools:mine", "Mine", [])
  const orders = [order("tab:tools", ["tool:special", folderRef("tools:mine")])]
  const input = memoOf([mine], orders)
  const first = started(input, row("tool:special"))
  const inside = advanceMove(input, first, "in")
  if ("refusal" in inside) throw new Error(inside.refusal)
  const owned = `${TOOLS}/tools:mine`
  expect(inside.expand).toEqual([folderRow(owned)])
  expect(inside.state.layout.folders.find((record) => record.id === owned)?.items).toEqual(["tool:special"])
  expect(inside.state.layout.folders.find((record) => record.id === mine.id)).toEqual(mine)

  const preview = expandedTree({ ...input, orders: inside.state.layout.orders, folders: inside.state.layout.folders })
  expect(childrenOf(preview, folderRow(owned)).map((node) => node.id)).toEqual([row("tool:special")])

  const left = moved(
    { ...input, orders: inside.state.layout.orders, folders: inside.state.layout.folders },
    inside.state,
    "out",
  )
  expect(left.layout.folders.find((record) => record.id === owned)?.items).toEqual([])
  expect(left.layout.folders.find((record) => record.id === mine.id)).toEqual(mine)
})

test("folders nest: moving into a sibling folder reparents it and out returns it", () => {
  const outer = folder("tools:outer", "Outer", [])
  const inner = folder("tools:inner", "Inner", [])
  const orders = [order("tab:tools", [folderRef("tools:outer"), folderRef("tools:inner")])]
  const input = memoOf([outer, inner], orders)
  // inner up, before outer; its new neighbour below is outer, so right nests it.
  const start = started(input, folderRow("tools:inner"))
  const up = moved(input, start, "up")
  const nested = moved({ ...input, folders: up.layout.folders, orders: up.layout.orders }, up, "in")
  const ownedInner = `${TOOLS}/tools:inner`
  const ownedOuter = `${TOOLS}/tools:outer`
  expect(nested.layout.folders.find((record) => record.id === ownedInner)?.parent).toBe(ownedOuter)
  expect(nested.layout.folders.find((record) => record.id === ownedOuter)?.items).toEqual([folderRef(ownedInner)])
  expect(nested.layout.folders.find((record) => record.id === outer.id)).toEqual(outer)
  expect(nested.layout.folders.find((record) => record.id === inner.id)).toEqual(inner)

  const out = moved({ ...input, folders: nested.layout.folders, orders: nested.layout.orders }, nested, "out")
  expect(out.layout.folders.find((record) => record.id === ownedInner)?.parent).toBeUndefined()
})

test("built-in group headings refuse while sections enter their own move mode", () => {
  const input = memoOf([])
  const nodes = expandedTree(input)
  const heading = startMove(nodeNamed(nodes, NATIVE), noLayout)
  expect("refusal" in heading && heading.refusal).toContain("built-in structure")

  const reader = item({ id: "tool:reader", kind: "tool", title: "reader", text: "# Reader\nintro\n## Details\nd\n" })
  const withReader = { ...input, items: [...items().filter((entry) => entry.id !== "tool:reader"), reader] }
  const section = expandedTree(withReader).find((node) => node.address !== undefined && node.address.section !== null)
  expect(section).toBeDefined()
  const refused = startMove(section!, noLayout)
  expect("state" in refused && refused.state.isSection).toBe(true)
})

test("sidebar owner lists reorder through a group order and cannot enter folders", () => {
  const input = memoOf([])
  const defaultIds = childrenOf(expandedTree(input), AGENTS_USER).map((node) => node.id)
  expect(defaultIds).toHaveLength(2)
  const second = defaultIds[1]!
  const start = started(input, second)
  const up = moved(input, start, "up")
  expect(up.layout.orders.find((record) => record.scope === groupScope(AGENTS_USER))?.items).toEqual([
    second,
    defaultIds[0]!,
  ])
  const preview = expandedTree({ ...input, orders: up.layout.orders })
  expect(childrenOf(preview, AGENTS_USER).map((node) => node.id)).toEqual([second, defaultIds[0]!])

  const down = advanceMove({ ...input, orders: up.layout.orders }, up, "down")
  // down puts it back where it started, so the order record returns to default.
  const restored = "state" in down ? down.state.layout.orders.find((record) => record.scope === groupScope(AGENTS_USER))?.items : undefined
  expect(restored).toEqual([defaultIds[0]!, second])

  const into = advanceMove(input, start, "in")
  expect("refusal" in into && into.refusal).toContain("folder")
})

test("a team's member list reorders through a group order", () => {
  const teams: TeamInput[] = [{ level: "project", team: "crew", enabled: true, agents: ["alpha", "beta"] }]
  const input = memoOf([], [], teams)
  const teamId = "team:project:crew"
  const memberIds = childrenOf(expandedTree(input), teamId)
    .filter((node) => node.id !== `${teamId}:special`)
    .map((node) => node.id)
  expect(memberIds).toEqual(["team:project:crew:alpha", "team:project:crew:beta"])
  const start = started(input, memberIds[1]!)
  const up = moved(input, start, "up")
  expect(up.layout.orders.find((record) => record.scope === groupScope(teamId))?.items).toEqual([
    memberIds[1]!,
    memberIds[0]!,
  ])
  const preview = expandedTree({ ...input, orders: up.layout.orders })
  expect(
    childrenOf(preview, teamId)
      .filter((node) => node.id !== `${teamId}:special`)
      .map((node) => node.id),
  ).toEqual([memberIds[1]!, memberIds[0]!])
})

test("planGroupMove reorders before and after a sibling without touching folders", () => {
  const input = memoOf([])
  const change = planGroupMove(input, noLayout, row("tool:reader"), { before: row("tool:bash") }, UPDATED)
  if ("refusal" in change) throw new Error(change.refusal)
  expect(change.layout.orders.find((record) => record.scope === groupScope(NATIVE))?.items).toEqual([
    "tool:reader",
    "tool:bash",
  ])
  expect(change.layout.folders).toEqual([])
})

test("a display-only reorder leaves the row's prompt identity and text untouched", () => {
  // An order record is screen state only (decision 6): the moved row keeps its
  // address (which names its prompt text in the assembler) and re-resolves the
  // same text, so no reorder can leak into the model.
  const input = memoOf([])
  const before = nodeNamed(expandedTree(input), row("tool:reader"))
  const state = moved(input, started(input, row("tool:reader")), "up")
  const after = nodeNamed(expandedTree({ ...input, orders: state.layout.orders }), row("tool:reader"))
  expect(after.address).toEqual(before.address)
  const scopes = { global: new Set<string>(), defaults: new Set<string>() }
  const upstream = input.items!.find((item) => item.id === "tool:reader")!
  expect(resolve({ upstream, records: [], splits: [], scopes, address: after.address! }).assembled).toBe(
    resolve({ upstream, records: [], splits: [], scopes, address: before.address! }).assembled,
  )
})
