import { expect, test } from "bun:test"
import { fingerprint, type Item } from "../src/instructions/model.js"
import { catalogItems, parameterApprovals } from "../src/instructions/permission-catalog.js"
import { modelActivationRefusal, reflectedPeer, reflectedRows } from "../src/instructions/reflection.js"
import { buildTreeMemo, type MemoInput } from "../src/instructions/tree.js"
import { toolModeItem } from "../src/instructions/tool-mode.js"
import { setEnabled } from "../src/instructions/ops.js"

const tools: Item[] = ["read", "write", "search"].map((name) => ({ id: `tool:${name}`, kind: "tool", group: "native", title: name, text: "# Usage\nInstructions", enabled: true, fingerprint: fingerprint(name) }))
const params: Item[] = tools.map((tool) => ({
  id: `param:${tool.title}:${tool.title === "search" ? "query" : "path"}`, kind: "param", group: "native", title: tool.title === "search" ? "query" : "path",
  text: "An argument", enabled: true, fingerprint: fingerprint("An argument"), paramTool: tool.title, paramType: "string",
}))
const input: MemoInput = {
  items: [...tools, ...params, ...parameterApprovals(catalogItems(tools, (id) => id), params), ...tools.map(toolModeItem)], records: [],
  agents: [{ id: "build", scope: "project", origin: "native" }, { id: "plan", scope: "project", origin: "native" }],
}
const selected = tools.map((tool) => `item:project:build:${tool.id}`)

test("a parameter edit reflects to the same argument on selected tools and reports missing arguments", () => {
  const result = reflectedRows(buildTreeMemo(input), "item:project:build:param:read:path", selected)
  expect(result.targets.map((row) => row.id)).toEqual(["item:project:build:param:read:path", "item:project:build:param:write:path"])
  expect(result.skipped.map((row) => row.id)).toEqual(["item:project:build:tool:search"])
})

test("a parameter's approval reflects by rule identity across tools, not by its label", () => {
  const result = reflectedRows(buildTreeMemo(input), "item:project:build:perm:read:approval.every@path", selected)
  expect(result.targets.map((row) => row.id)).toEqual(["item:project:build:perm:read:approval.every@path", "item:project:build:perm:write:approval.every@path"])
  const changed = result.targets.reduce((memo, row) => {
    const next = setEnabled(memo, row.id, true)
    if ("refusal" in next) throw new Error(next.refusal)
    return { ...memo, records: next.records }
  }, input)
  expect(changed.records.filter((record) => record.type === "customization" && record.state === "on")).toHaveLength(2)
})

test("Descriptions and exposure settings correspond despite different tool ids", () => {
  const memo = buildTreeMemo(input)
  expect(reflectedRows(memo, `${selected[0]}:description`, selected).targets.map((row) => row.id)).toEqual(selected.map((id) => `${id}:description`))
  expect(reflectedRows(memo, "item:project:build:toolmode:read", selected).targets.map((row) => row.address?.item)).toEqual(["toolmode:read", "toolmode:write", "toolmode:search"])
})

test("agent selections match exact child identities and independent focus stays a single edit", () => {
  const memo = buildTreeMemo(input)
  expect(reflectedRows(memo, "item:project:build:param:read:path", ["agent:project:build", "agent:project:plan"]).targets.map((row) => row.id)).toEqual(["item:project:build:param:read:path", "item:project:plan:param:read:path"])
  expect(reflectedRows(memo, "item:project:plan:param:read:path", selected).targets.map((row) => row.id)).toEqual(["item:project:plan:param:read:path"])
  expect(reflectedRows(memo, selected[0]!, [selected[0]!, selected[0]!, "gone"]).skipped).toEqual([{ id: "gone", reason: "Row no longer exists" }])
})

test("link endpoints follow corresponding parameters and destination owners", () => {
  const memo = buildTreeMemo(input)
  expect(reflectedPeer(memo, selected[0]!, selected[1]!, selected, "item:project:build:param:read:path")?.id).toBe("item:project:build:param:write:path")
  expect(reflectedPeer(memo, selected[0]!, selected[2]!, selected, "item:project:build:param:read:path")).toBeUndefined()
  const owners = ["agent:project:build", "agent:project:plan"]
  expect(reflectedPeer(memo, selected[0]!, "item:project:plan:tool:read", owners, "item:project:build:tool:write")?.id).toBe("item:project:plan:tool:write")
  const across = [selected[0]!, "item:project:plan:tool:read"]
  expect(reflectedPeer(memo, across[0]!, across[1]!, across, "item:project:build:tool:write")?.id).toBe("item:project:plan:tool:write")
})

test("model settings reflect across candidates while conflicting activation refuses", () => {
  const records = ["first", "second"].map((modelID) => ({ type: "model" as const, level: "project" as const, agent: "build", providerID: "test", modelID, updated: "2026-10-11T00:00:00Z" }))
  const memo = buildTreeMemo({ ...input, records })
  const selected = records.map((record) => `item:project:build:model:test/${record.modelID}`)
  const rows = reflectedRows(memo, "item:project:build:modelfield:compactWarm:test/first", selected)
  expect(rows.targets.map((row) => row.address?.item)).toEqual(["modelfield:compactWarm:test/first", "modelfield:compactWarm:test/second"])
  expect(modelActivationRefusal(reflectedRows(memo, selected[0]!, selected).targets)).toContain("one model")
})
