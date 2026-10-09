import { test } from "bun:test"
import type { AgentSource, Item } from "../src/instructions/model.js"
import { fingerprint } from "../src/instructions/model.js"
import { expandedTree, type MemoInput } from "../src/instructions/tree.js"
import type { FolderRecord, OrderRecord } from "../src/instructions/folders.js"
import { folderRef } from "../src/instructions/folders.js"

const UPDATED = "2026-01-01T00:00:00.000Z"
const item = (o: Partial<Item> & Pick<Item,"id"|"kind"|"title">): Item => {
  const text = o.text ?? "default text"
  return { group: "native", text, enabled: true, fingerprint: fingerprint(text), ...o }
}
test("probe", () => {
  const items: Item[] = [
    item({ id: "tool:bash", kind: "tool", title: "bash" }),
    item({ id: "tool:reader", kind: "tool", title: "reader" }),
  ]
  const agents: AgentSource[] = [{ id: "Implementer", scope: "project", origin: "user" }]
  const folder: FolderRecord = { type: "folder", level: "global", tab: "tools", id: "tools:mine", name: "Mine", items: [], updated: UPDATED }
  const orders: OrderRecord[] = [
    { type: "order", level: "global", scope: "tab:tools", items: [folderRef("tools:mine")], updated: UPDATED },
  ]
  const input: MemoInput = { items, records: [], agents, folders: [folder], orders }
  for (const n of expandedTree(input)) {
    if (!n.id.startsWith("group:project:Implementer:tools") && !n.id.startsWith("root:project") && !n.id.startsWith("group:project:agents")) continue
    console.log(`${"  ".repeat(n.depth)}${n.depth} ${n.kind} ${n.id} :: ${n.label}`)
  }
})
