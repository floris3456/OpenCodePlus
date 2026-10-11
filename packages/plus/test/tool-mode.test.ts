import { expect, test } from "bun:test"
import { sessionPlans } from "../src/instructions/apply.js"
import { controlRecordError } from "../src/instructions/agent-controls.js"
import { fingerprint, type Item } from "../src/instructions/model.js"
import { saveText } from "../src/instructions/ops.js"
import { permissionTable } from "../src/instructions/permission-enforce.js"
import { query, matchedTree } from "../src/instructions/query.js"
import { expandedTree, type MemoInput } from "../src/instructions/tree.js"
import { toolModeItem } from "../src/instructions/tool-mode.js"

const tool: Item = { id: "tool:read", kind: "tool", group: "native", title: "read", text: "Read a file", enabled: true, fingerprint: fingerprint("Read a file") }
const input: MemoInput = {
  items: [tool, toolModeItem(tool)], records: [],
  agents: [{ id: "build", scope: "project", origin: "native" }, { id: "plan", scope: "project", origin: "native" }],
}

test("exposure is an editable shared row and moves only its owner's runtime and tree", () => {
  const changed = saveText(input, "item:project:build:toolmode:read", "codemode")
  if ("refusal" in changed) throw new Error(changed.refusal)
  const next = { ...input, records: changed.records }
  expect(query(next, { where: "id:item:project:build:toolmode:read", fields: ["text"] }).rows[0]?.text).toBe("codemode")
  const path = matchedTree(next, "id:item:project:build:tool:read").rows.map((row) => row.label)
  expect(path).toContain("Code Mode")
  expect(query(next, { where: "agent:build item:tool codemode:true" }).rows.map((row) => row.id)).toContain("item:project:build:tool:read")
  expect(query(next, { where: "agent:plan item:tool codemode:true" }).rows).toEqual([])
  expect(matchedTree(next, "id:item:project:plan:tool:read").rows.map((row) => row.label)).not.toContain("Code Mode")
  expect(expandedTree(next).filter((row) => row.id === "item:project:build:toolmode:read")).toHaveLength(1)
  const plans = sessionPlans({
    items: input.items, records: changed.records, splits: [],
    agents: [{ id: "build", level: "project" }, { id: "plan", level: "project" }],
    scopes: { global: new Set(), defaults: new Set() },
  }, permissionTable({ items: [], teamMembers: [], resolve: () => { throw new Error("no permissions") } }))
  expect(plans.exposure).toEqual([{ agent: "build", tool: "read", mode: "codemode" }])
  expect(plans.native.some((entry) => entry.agent === "build")).toBe(false)
})

test("exposure rejects unknown modes, sections, switches and the host execute entry point", () => {
  expect(controlRecordError({ item: "toolmode:read", section: null, text: "codemode" })).toBeUndefined()
  expect(controlRecordError({ item: "toolmode:read", section: null, text: "unknown" })).toContain("direct or codemode")
  expect(controlRecordError({ item: "toolmode:read", section: "part", text: "direct" })).toContain("not sections")
  expect(controlRecordError({ item: "toolmode:read", section: null, state: "off" })).toContain("on/off")
  expect(controlRecordError({ item: "toolmode:execute", section: null, text: "direct" })).toContain("host-owned")
})
