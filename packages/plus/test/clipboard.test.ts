import { expect, test } from "bun:test"
import { captureRows, pasteRows } from "../src/instructions/clipboard.js"
import { fingerprint, type Item } from "../src/instructions/model.js"
import { planFolderCreate, planRowMove, saveText, setEnabled } from "../src/instructions/ops.js"
import { catalogItems, parameterApprovals } from "../src/instructions/permission-catalog.js"
import { query } from "../src/instructions/query.js"
import { toolModeItem } from "../src/instructions/tool-mode.js"
import { buildTreeMemo, expandedTree, findLazy, type MemoInput } from "../src/instructions/tree.js"
import { rowlinkView, writeRowlink } from "../src/instructions/rowlinks.js"

const tool: Item = { id: "tool:read", kind: "tool", group: "native", title: "read", text: "Read a file", enabled: true, fingerprint: fingerprint("Read a file") }
const source: MemoInput = {
  items: [tool, toolModeItem(tool), { id: "param:read:path", kind: "param", group: "native", title: "path", paramTool: "read", text: "A path", enabled: true, fingerprint: fingerprint("A path") }],
  records: [], agents: [{ id: "build", scope: "project", origin: "native" }, { id: "plan", scope: "project", origin: "native" }],
}

test("copy snapshots configuration independently and refuses an in-owner tool duplicate", () => {
  const changed = saveText(source, "item:project:build:tool:read", "Original copied description")
  if ("refusal" in changed) throw new Error(changed.refusal)
  const before = { ...source, records: changed.records }
  const clipboard = captureRows(before, ["item:project:build:tool:read"], "copy")
  if ("refusal" in clipboard) throw new Error(clipboard.refusal)
  const later = saveText(before, "item:project:build:tool:read", "Later source edit")
  if ("refusal" in later) throw new Error(later.refusal)
  const pasted = pasteRows({ ...source, records: later.records }, clipboard, "group:project:plan:tools")
  if ("refusal" in pasted) throw new Error(pasted.refusal)
  expect(query(pasted.memo, { where: "id:item:project:plan:tool:read", fields: ["text"] }).rows[0]?.text).toBe("Original copied description")
  expect(query(pasted.memo, { where: "id:item:project:build:tool:read", fields: ["text"] }).rows[0]?.text).toBe("Later source edit")
  expect(pasteRows(source, clipboard, "group:project:build:tools")).toMatchObject({ refusal: expect.stringContaining("already have this tool") })
})

test("cut is only a draft and a misplaced paste cannot change its source", () => {
  const clipboard = captureRows(source, ["item:project:build:tool:read"], "cut")
  if ("refusal" in clipboard) throw new Error(clipboard.refusal)
  expect(source.records).toEqual([])
  expect(pasteRows(source, clipboard, "group:project:plan:system")).toHaveProperty("refusal")
  expect(source.records).toEqual([])
  const pasted = pasteRows(source, clipboard, "group:project:plan:tools")
  if ("refusal" in pasted) throw new Error(pasted.refusal)
  const memo = buildTreeMemo(pasted.memo)
  expect(findLazy(memo, "item:project:build:tool:read")?.partial().state).toBe("off")
  expect(findLazy(memo, "item:project:plan:tool:read")?.partial().state).toBe("on")
})

test("cutting a tool into Code Mode changes exposure and cutting back restores direct exposure", () => {
  const scripted: Item = { ...tool, id: "tool:scripted", title: "scripted", codemode: true }
  const input = { ...source, items: [...source.items, scripted, toolModeItem(scripted)] }
  const cut = captureRows(input, ["item:project:build:tool:read"], "cut")
  if ("refusal" in cut) throw new Error(cut.refusal)
  const code = pasteRows(input, cut, "group:project:build:tools:native:codemode")
  if ("refusal" in code) throw new Error(code.refusal)
  expect(query(code.memo, { where: "level:project agent:build item:tool codemode:true" }).rows.map((row) => row.id)).toContain("item:project:build:tool:read")
  const back = captureRows(code.memo, ["item:project:build:tool:read"], "cut")
  if ("refusal" in back) throw new Error(back.refusal)
  const direct = pasteRows(code.memo, back, "group:project:build:tools:native")
  if ("refusal" in direct) throw new Error(direct.refusal)
  expect(query(direct.memo, { where: "level:project agent:build item:tool codemode:true" }).rows.map((row) => row.id)).not.toContain("item:project:build:tool:read")
})

test("copying a populated category across owners preserves its independent membership", () => {
  const created = planFolderCreate(source, { folders: [], orders: [] }, "group:project:build:tools", "Files", "2026-10-11")
  if ("refusal" in created) throw new Error(created.refusal)
  const moved = planRowMove({ ...source, ...created.layout }, created.layout, "item:project:build:tool:read", { into: created.target }, "2026-10-11")
  if ("refusal" in moved) throw new Error(moved.refusal)
  const input = { ...source, ...moved.layout }
  const clip = captureRows(input, ["group:project:build:tools:folder:group:project:build:tools:files"], "copy")
  if ("refusal" in clip) throw new Error(clip.refusal)
  const pasted = pasteRows(input, clip, "group:project:plan:tools")
  if ("refusal" in pasted) throw new Error(pasted.refusal)
  expect(pasted.layout.folders.filter((folder) => folder.name === "Files")).toHaveLength(2)
  expect(query(pasted.memo, { where: "level:project agent:plan folder:Files item:tool" }).rows.map((row) => row.id)).toContain("item:project:plan:tool:read")
  expect(input.folders).toHaveLength(1)
})

test("tool copies include parameter approval and replace destination overrides", () => {
  const input = { ...source, items: [...source.items, ...parameterApprovals(catalogItems([tool], (id) => id), source.items.filter((item) => item.kind === "param"))] }
  const parameter = saveText(input, "item:project:build:param:read:path", "Source argument description")
  if ("refusal" in parameter) throw new Error(parameter.refusal)
  const approval = setEnabled({ ...input, records: parameter.records }, "item:project:build:perm:read:approval.every@path", true)
  if ("refusal" in approval) throw new Error(approval.refusal)
  const destination = saveText({ ...input, records: approval.records }, "item:project:plan:param:read:path", "Old destination value")
  if ("refusal" in destination) throw new Error(destination.refusal)
  const current = { ...input, records: destination.records }
  const copy = captureRows(current, ["item:project:build:tool:read"], "copy")
  if ("refusal" in copy) throw new Error(copy.refusal)
  const pasted = pasteRows(current, copy, "group:project:plan:tools")
  if ("refusal" in pasted) throw new Error(pasted.refusal)
  expect(query(pasted.memo, { where: "id:item:project:plan:param:read:path", fields: ["text"] }).rows[0]?.text).toBe("Source argument description")
  expect(findLazy(buildTreeMemo(pasted.memo), "item:project:plan:perm:read:approval.every@path")?.partial().state).toBe("on")
})

test("Description text can be pasted across typed categories", () => {
  const item: Item = { id: "system:note", kind: "system", group: "none", title: "Note", text: "Old note", enabled: true, fingerprint: fingerprint("Old note") }
  const input = { ...source, items: [...source.items, item] }
  const copy = captureRows(input, ["item:project:build:tool:read:description"], "copy")
  if ("refusal" in copy) throw new Error(copy.refusal)
  const pasted = pasteRows(input, copy, "item:project:plan:system:note")
  if ("refusal" in pasted) throw new Error(pasted.refusal)
  expect(query(pasted.memo, { where: "id:item:project:plan:system:note", fields: ["text"] }).rows[0]?.text).toBe(tool.text)
})

test("tool copies preserve numeric permission limits as well as their switch", () => {
  const input = { ...source, items: [...source.items, ...catalogItems([tool], (id) => id)] }
  const value = saveText(input, "item:project:build:perm:read:limits.lines", "17")
  if ("refusal" in value) throw new Error(value.refusal)
  const enabled = setEnabled({ ...input, records: value.records }, "item:project:build:perm:read:limits.lines", true)
  if ("refusal" in enabled) throw new Error(enabled.refusal)
  const current = { ...input, records: enabled.records }
  const copy = captureRows(current, ["item:project:build:tool:read"], "copy")
  if ("refusal" in copy) throw new Error(copy.refusal)
  const pasted = pasteRows(current, copy, "group:project:plan:tools")
  if ("refusal" in pasted) throw new Error(pasted.refusal)
  expect(pasted.memo.records).toContainEqual(expect.objectContaining({ type: "customization", agent: "plan", item: "perm:read:limits.lines", text: "17", state: "on" }))
})

test("cutting configuration between parameters within one owner transfers its value", () => {
  const argument: Item = { ...source.items[2]!, id: "param:read:other", title: "other", text: "Destination argument" }
  const input = { ...source, items: [...source.items, argument] }
  const cut = captureRows(input, ["item:project:build:param:read:path"], "cut")
  if ("refusal" in cut) throw new Error(cut.refusal)
  const pasted = pasteRows(input, cut, "item:project:build:param:read:other")
  if ("refusal" in pasted) throw new Error(pasted.refusal)
  expect(query(pasted.memo, { where: "id:item:project:build:param:read:other", fields: ["text"] }).rows[0]?.text).toBe("A path")
  expect(findLazy(buildTreeMemo(pasted.memo), "item:project:build:param:read:path")?.partial().state).toBe("off")
})

test("model copies add a candidate and retain its warming settings", () => {
  const input: MemoInput = { ...source, records: [{ type: "model", level: "project", agent: "build", providerID: "acme", modelID: "first", warming: "30m", interval: "2m", active: true, updated: "2026-10-11" }] }
  const copy = captureRows(input, ["item:project:build:model:acme/first"], "copy")
  if ("refusal" in copy) throw new Error(copy.refusal)
  const pasted = pasteRows(input, copy, "group:project:plan:models")
  if ("refusal" in pasted) throw new Error(pasted.refusal)
  expect(pasted.memo.records).toContainEqual(expect.objectContaining({ type: "model", level: "project", agent: "plan", providerID: "acme", modelID: "first", warming: "30m", interval: "2m", active: true }))
})

test("several active source models cannot silently overwrite each other in one destination", () => {
  const input: MemoInput = { ...source, agents: [...source.agents, { id: "destination", scope: "project", origin: "user" }], records: ["build", "plan"].map((agent) => ({ type: "model", level: "project", agent, providerID: "acme", modelID: agent, active: true, updated: "2026-10-11" })) }
  const copy = captureRows(input, ["item:project:build:model:acme/build", "item:project:plan:model:acme/plan"], "copy")
  if ("refusal" in copy) throw new Error(copy.refusal)
  expect(pasteRows(input, copy, "group:project:destination:models")).toEqual({ refusal: "Only one pasted model can be active per destination owner" })
  expect(input.records).toHaveLength(2)
})

test("cutting a text section removes its source span and pastes one independent section", () => {
  const read = { ...tool, text: "# First\nKeep this\n\n# Second\nMove this\n" }
  const note: Item = { id: "system:note", kind: "system", group: "none", title: "Note", text: "# Existing\nA note\n", enabled: true, fingerprint: "note" }
  const input = { ...source, items: [read, toolModeItem(read), note] }
  const section = expandedTree(input).find((row) => row.address?.agent === "build" && row.address.level === "project" && row.kind === "section" && row.label === "Second")
  if (section === undefined) throw new Error("missing section")
  const disabled = setEnabled(input, section.id, false)
  if ("refusal" in disabled) throw new Error(disabled.refusal)
  const current = { ...input, records: disabled.records }
  const cut = captureRows(current, [section.id], "cut")
  if ("refusal" in cut) throw new Error(cut.refusal)
  const pasted = pasteRows(current, cut, "item:project:plan:system:note")
  if ("refusal" in pasted) throw new Error(pasted.refusal)
  const readText = query(pasted.memo, { where: "id:item:project:build:tool:read", fields: ["text"] }).rows[0]?.text
  const noteText = query(pasted.memo, { where: "id:item:project:plan:system:note", fields: ["text"] }).rows[0]?.text
  expect(readText).toContain("Keep this")
  expect(readText).not.toContain("Second")
  expect(noteText).toContain("Move this")
  expect(noteText?.match(/Second/g)).toHaveLength(1)
  expect(findLazy(buildTreeMemo(pasted.memo), pasted.rows[0]!)?.partial().state).toBe("off")
})

test("pasting replaces destination-only switches before they can affect unrelated rows", () => {
  const other: Item = { ...tool, id: "tool:other", title: "other" }
  const input = { ...source, items: [...source.items, other, toolModeItem(other)] }
  const disabled = setEnabled(input, "item:project:plan:tool:read", false)
  if ("refusal" in disabled) throw new Error(disabled.refusal)
  const current: MemoInput = { ...input, records: [...disabled.records, ...writeRowlink([], { level: "project", agent: "plan" }, { item: tool.id, section: null }, { item: other.id, section: null }, "either", true, "2026-10-11")] }
  const copy = captureRows(current, ["item:project:build:tool:read"], "copy")
  if ("refusal" in copy) throw new Error(copy.refusal)
  const pasted = pasteRows(current, copy, "group:project:plan:tools")
  if ("refusal" in pasted) throw new Error(pasted.refusal)
  const memo = buildTreeMemo(pasted.memo)
  expect(findLazy(memo, "item:project:plan:tool:read")?.partial().state).toBe("on")
  expect(findLazy(memo, "item:project:plan:tool:other")?.partial().state).toBe("on")
  expect(rowlinkView(memo.ctx.scopes.rowlinks ?? [], memo.ctx.scopes, { level: "project", agent: "plan", item: tool.id, section: null }, { item: tool.id, section: null })).toEqual([expect.objectContaining({ enabled: false })])
})

test("a copy equal to what the destination inherits stores nothing, so the destination keeps following upstream", () => {
  const read = { ...tool, text: "# First\nOriginal first\n\n# Second\nOriginal second\n" }
  const input = { ...source, items: [read, toolModeItem(read)] }
  const copy = captureRows(input, ["item:project:build:tool:read"], "copy")
  if ("refusal" in copy) throw new Error(copy.refusal)
  const pasted = pasteRows(input, copy, "group:project:plan:tools")
  if ("refusal" in pasted) throw new Error(pasted.refusal)
  expect(pasted.memo.records.some((record) => record.type === "customization" && record.agent === "plan" && record.item === tool.id && record.text !== undefined)).toBe(false)
  const changed = { ...pasted.memo, items: pasted.memo.items.map((item) => item.id === tool.id ? { ...item, text: "# First\nChanged upstream\n\n# Second\nChanged second\n", fingerprint: fingerprint("changed") } : item) }
  expect(query(changed, { where: "id:item:project:plan:tool:read", fields: ["text"] }).rows[0]?.text).toContain("Changed upstream")
  expect(query(changed, { where: "id:item:project:build:tool:read", fields: ["text"] }).rows[0]?.text).toContain("Changed upstream")
})

test("cutting a section remaps its links and masks the old endpoint", () => {
  const read = { ...tool, text: "# First\nKeep\n\n# Second\nMove\n" }
  const note: Item = { id: "system:note", kind: "system", group: "none", title: "Note", text: "# Existing\nA note\n", enabled: true, fingerprint: "note" }
  const input = { ...source, items: [read, toolModeItem(read), note] }
  const section = expandedTree(input).find((row) => row.address?.agent === "build" && row.address.level === "project" && row.kind === "section" && row.label === "Second")
  if (section?.address === undefined) throw new Error("missing section")
  const current = { ...input, records: writeRowlink([], section.address, { item: tool.id, section: null }, section.address, "shownWhenOff", true, "2026-10-11") }
  const cut = captureRows(current, [section.id], "cut")
  if ("refusal" in cut) throw new Error(cut.refusal)
  const pasted = pasteRows(current, cut, "item:project:plan:system:note")
  if ("refusal" in pasted) throw new Error(pasted.refusal)
  const memo = buildTreeMemo(pasted.memo)
  const inserted = findLazy(memo, pasted.rows[0] ?? "")
  if (inserted?.address === undefined) throw new Error("missing pasted section")
  expect(rowlinkView(memo.ctx.scopes.rowlinks ?? [], memo.ctx.scopes, inserted.address, inserted.address)).toContainEqual(expect.objectContaining({ item: tool.id, target: note.id, targetSection: inserted.address.section, type: "shownWhenOff", enabled: true }))
  expect(rowlinkView(memo.ctx.scopes.rowlinks ?? [], memo.ctx.scopes, section.address, section.address)).toContainEqual(expect.objectContaining({ enabled: false }))
})
