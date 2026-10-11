import { expect, test } from "bun:test"
import { fingerprint, resolve, type Item, type CustomizationRecord } from "../src/instructions/model.js"
import { catalogItems, parameterApprovals } from "../src/instructions/permission-catalog.js"
import { decide, permissionTable } from "../src/instructions/permission-enforce.js"
import { expandedTree, type MemoInput } from "../src/instructions/tree.js"
import { saveText, setEnabled } from "../src/instructions/ops.js"
import { query, matchedTree } from "../src/instructions/query.js"

const tool: Item = { id: "tool:read", kind: "tool", group: "native", title: "read", text: "# Usage\nRead a file.\n\n# Limits\nKeep it short.\n", enabled: true, fingerprint: "read" }
const parameters: Item[] = ["path", "limit"].map((name) => ({
  id: `param:read:${name}`, kind: "param", group: "native", title: name,
  text: `The ${name} argument.`, enabled: true, fingerprint: fingerprint(name),
  paramTool: "read", paramType: name === "path" ? "string" : "number",
}))
const permissions = parameterApprovals(catalogItems([tool], (id) => id), parameters)
const input: MemoInput = {
  items: [tool, ...parameters, ...permissions], records: [],
  agents: [{ id: "build", scope: "project", origin: "native" }],
}
const prefix = "item:project:build:"

test("parameters are direct children and permission queries retain their real ancestors", () => {
  const nodes = expandedTree(input)
  const root = nodes.find((node) => node.id === `${prefix}tool:read`)
  if (!root) throw new Error("missing tool")
  const start = nodes.indexOf(root)
  const next = nodes.findIndex((node, index) => index > start && node.depth <= root.depth)
  const children = nodes.slice(start + 1, next).filter((node) => node.depth === root.depth + 1)
  expect(children.map((node) => node.id)).toEqual([`${root.id}:description`, `${prefix}param:read:path`, `${prefix}param:read:limit`])
  expect(nodes.some((node) => node.label === "Parameters" || node.label === "Permissions" || node.label === "Full text")).toBe(false)
  const approval = `${prefix}perm:read:approval.every@limit`
  const filtered = matchedTree(input, `id:${approval}`)
  expect(filtered.rows.map((node) => node.id)).toContain(`${prefix}param:read:limit`)
  expect(filtered.rows.map((node) => node.id)).not.toContain(`${prefix}param:read:path`)
  expect(query(input, { where: `id:${approval}` }).rows.map((row) => row.id)).toEqual([approval])
})

test("Description edits and section edits reflect each other without a second text store", () => {
  const description = `${prefix}tool:read:description`
  const section = "section:project:build:tool:read:usage"
  const changed = saveText(input, section, "# Usage\nChanged section.\n\n")
  if ("refusal" in changed) throw new Error(changed.refusal)
  const first = { ...input, records: changed.records }
  expect(query(first, { where: `id:${description}`, fields: ["text"] }).rows[0]?.text).toContain("Changed section.")
  const whole = saveText(first, description, "# Usage\nChanged description.\n\n# Limits\nKeep it short.\n")
  if ("refusal" in whole) throw new Error(whole.refusal)
  const second = { ...input, records: whole.records }
  expect(query(second, { where: `id:${section}`, fields: ["text"] }).rows[0]?.text).toContain("Changed description.")
  const flat = saveText(second, description, "Single description")
  if ("refusal" in flat) throw new Error(flat.refusal)
  const nodes = expandedTree({ ...input, records: flat.records })
  const row = nodes.find((node) => node.id === description)
  if (!row) throw new Error("missing Description")
  expect(row.expandable).toBe(false)
  expect(nodes[nodes.indexOf(row) + 1]?.depth).toBeLessThanOrEqual(row.depth)
})

test("argument approvals inherit legacy overrides and are independently enforced only when supplied", () => {
  const record: CustomizationRecord = {
    type: "customization", level: "project", agent: "build", item: "perm:read:approval.every", section: null,
    state: "on", basedOn: "approval", updated: "2026-10-11T00:00:00.000Z",
  }
  const scopes = { global: new Set<string>(), defaults: new Set<string>() }
  const table = (records: readonly CustomizationRecord[]) => permissionTable({
    items: permissions,
    teamMembers: [],
    resolve: (item) => resolve({ upstream: item, records, splits: [], scopes, address: { level: "project", agent: "build", item: item.id, section: null } }),
  })
  const decision = (records: readonly CustomizationRecord[], args: unknown) => decide(table(records).toolRows("build", "read"), {
    tool: "read", input: args, directory: "/repo", sessionID: "ses_example", teamMembers: new Set<string>(),
  })
  expect(decision([record], { path: "/repo/file" }).approval).toBe("read")
  const changed = setEnabled({ ...input, records: [record] }, `${prefix}perm:read:approval.every@path`, false)
  if ("refusal" in changed) throw new Error(changed.refusal)
  expect(decision(changed.records, { path: "/repo/file" }).approval).toBeUndefined()
  expect(decision(changed.records, { path: "/repo/file", limit: 10 }).approval).toBe("read")
  // Updating the inherited source must invalidate resolution caches as well.
  expect(decision([{ ...record, state: "off" }], { path: "/repo/file", limit: 10 }).approval).toBeUndefined()
})

test("zero-parameter tools keep their approval directly under the tool", () => {
  const empty: Item = { ...tool, id: "tool:empty", title: "empty", group: "plus", text: "No arguments." }
  const rows = parameterApprovals(catalogItems([empty], (id) => id), [])
  const nodes = expandedTree({ ...input, items: [empty, ...rows] })
  const root = nodes.find((node) => node.id === `${prefix}tool:empty`)
  const approval = nodes.find((node) => node.id === `${prefix}perm:empty:approval.every`)
  expect(approval?.depth).toBe((root?.depth ?? 0) + 1)
})

test("rediscovery preserves argument-level rule edits without duplicating or re-expanding them", () => {
  const original = permissions.find((row) => row.id === "perm:read:approval.every@limit")
  if (!original) throw new Error("missing argument approval")
  const edited = { ...original, title: "Confirm large reads", custom: true }
  const rows = parameterApprovals([edited, ...catalogItems([tool], (id) => id)], parameters)
  expect(rows.filter((row) => row.id === original.id)).toEqual([edited])
  expect(parameterApprovals(rows, parameters)).toEqual(rows)
})
