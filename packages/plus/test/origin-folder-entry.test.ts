import { expect, test } from "bun:test"
import { advanceMove, startMove } from "../src/tui/instructions/move.js"
import type { AgentSource, Item } from "../src/instructions/model.js"
import { fingerprint } from "../src/instructions/model.js"
import { expandedTree, type MemoInput } from "../src/instructions/tree.js"
import { planFolderCreate } from "../src/instructions/ops.js"

const UPDATED = "2026-01-01T00:00:00.000Z"
const item = (o: Partial<Item> & Pick<Item, "id" | "kind" | "title">): Item => {
  const text = o.text ?? "default text"
  return { group: "native", text, enabled: true, fingerprint: fingerprint(text), ...o }
}
test("ordinary origin-group tools can enter a tab-root folder and return home", () => {
  const items: Item[] = [
    item({ id: "tool:bash", kind: "tool", title: "bash" }),
    item({ id: "tool:reader", kind: "tool", title: "reader" }),
  ]
  const agents: AgentSource[] = [{ id: "Implementer", scope: "project", origin: "user" }]
  const empty: MemoInput = { items, records: [], agents, folders: [], orders: [] }
  const created = planFolderCreate(empty, { folders: [], orders: [] }, "group:project:Implementer:tools:native", "Mine", UPDATED)
  expect("layout" in created).toBe(true)
  if (!("layout" in created)) return
  const folder = created.layout.folders[0]!
  expect(folder.tab).toBe("tools")
  const input: MemoInput = { ...empty, ...created.layout }
  const node = expandedTree(input).find((n) => n.address?.item === "tool:bash" && n.address.section === null)!
  const layout = created.layout
  const picked = startMove(node, layout)
  expect("state" in picked).toBe(true)
  if (!("state" in picked)) return
  const entered = advanceMove(input, picked.state, "in")
  expect("state" in entered).toBe(true)
  if (!("state" in entered)) return
  expect(entered.state.layout.folders[0]!.items).toEqual(["tool:bash"])
  const left = advanceMove({ ...input, ...entered.state.layout }, entered.state, "out")
  expect("state" in left).toBe(true)
  if (!("state" in left)) return
  expect(left.state.layout.folders[0]!.items).toEqual([])
  expect(expandedTree({ ...input, ...left.state.layout }).find((n) => n.id === node.id)?.depth).toBe(node.depth)
  const reordered = advanceMove({ ...input, ...left.state.layout }, left.state, "down")
  expect("state" in reordered).toBe(true)
  if (!("state" in reordered)) return
  expect(reordered.state.layout.orders.find((entry) => entry.scope.includes(":native"))?.items).toEqual(["tool:reader", "tool:bash"])
  expect(items.map((entry) => entry.text)).toEqual(["default text", "default text"])
  expect(folder.items).toEqual([])
})
