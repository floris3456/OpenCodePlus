import { expect, test } from "bun:test"
import { addModelRecord, fingerprint, resolveResolution } from "../src/instructions/model.js"
import type { CustomizationRecord, ModelRecord } from "../src/instructions/model.js"
import { expandedTree } from "../src/instructions/tree.js"
import type { MemoInput } from "../src/instructions/tree.js"
import {
  activateModelRow,
  addSection,
  editModelRow,
  refusalFor,
  removalPlan,
  removeModelRow,
  reset,
  resetModelRow,
  resolveReview,
  saveSplit,
  saveText,
  setEnabled,
  setPin,
  teamPlan,
  toggle,
  unknownRowRefusal,
} from "../src/instructions/ops.js"

function baseInput(overrides?: Partial<MemoInput>): MemoInput {
  return {
    items: [
      {
        id: "tool:bash",
        kind: "tool",
        group: "native",
        title: "bash",
        text: "run commands",
        enabled: true,
        fingerprint: "fp-bash",
      },
      {
        id: "tool:coder",
        kind: "tool",
        group: "native",
        title: "coder",
        text: "# Alpha\n\na\n\n# Beta\n\nb\n",
        enabled: true,
        fingerprint: "fp-coder",
        codemode: true,
      },
      {
        id: "system:role",
        kind: "system",
        group: "none",
        title: "Role",
        text: "role text",
        enabled: true,
        fingerprint: "fp-role",
        agents: ["alpha"],
      },
      {
        id: "base:gpt",
        kind: "base",
        group: "none",
        title: "gpt.txt",
        text: "gpt base",
        enabled: true,
        fingerprint: "fp-gpt",
      },
      {
        id: "skill:proj-one",
        kind: "skill",
        group: "project",
        skillScope: "project",
        title: "proj-one",
        text: "project skill",
        enabled: true,
        fingerprint: "fp-proj",
      },
      {
        id: "skill:native-one",
        kind: "skill",
        group: "native",
        title: "native-one",
        text: "upstream skill",
        enabled: true,
        fingerprint: "fp-native",
      },
      {
        id: "mcp:sample",
        kind: "mcp",
        group: "none",
        title: "sample",
        text: "# Purpose\n\na\n\n# Usage\n\nb\n",
        enabled: true,
        fingerprint: "fp-sample",
      },
      {
        id: "system:AGENTS.md",
        kind: "system",
        group: "project",
        title: "AGENTS.md",
        text: "guide",
        enabled: true,
        fingerprint: "fp-guide",
      },
      {
        id: "base:custom",
        kind: "base",
        group: "none",
        title: "Custom.txt",
        text: "custom base",
        enabled: true,
        fingerprint: "fp-custom",
        userBase: true,
      },
    ],
    records: [],
    agents: [{ id: "alpha", scope: "project" }],
    // DESIGN §3.3: a user agent's shared rows fall back to off unless a preset
    // sets them. alpha stands for an agent created from the Native `build`
    // preset, so its rows keep their native value unless a test changes them.
    links: [{ type: "link", level: "project", agent: "alpha", preset: { kind: "agent", id: "build" }, updated: "2026-01-01T00:00:00.000Z" }],
    teams: [
      { level: "project", team: "crew", enabled: false, agents: ["alpha"] },
      { level: "project", team: "my:team", enabled: false, agents: [] },
    ],
    ...overrides,
  }
}

function findId(input: MemoInput, contains: string): string {
  const nodes = expandedTree(input)
  const node = nodes.find((candidate) => candidate.id.includes(contains))
  if (!node) throw new Error(`no row containing ${contains}`)
  return node.id
}

function exactId(input: MemoInput, id: string): string {
  const nodes = expandedTree(input)
  const node = nodes.find((candidate) => candidate.id === id)
  if (!node) throw new Error(`no row ${id}`)
  return node.id
}

test("toggle success disables a shared mcp row", () => {
  const input = baseInput()
  const rowId = findId(input, "mcp:sample")
  const result = toggle(input, rowId)
  if ("refusal" in result) throw new Error(`expected success, got refusal ${result.refusal}`)
  expect(result.status).toBe(`Disabled "sample"`)
  expect(result.retryHint).toBe(`toggled "sample" against a stale revision; retry to apply`)
  expect(result.records.some((record) => record.item === "mcp:sample" && record.state === "off")).toBe(true)
})

test("toggle succeeds on a Code Mode row", () => {
  const input = baseInput()
  const rowId = findId(input, "tool:coder")
  const result = toggle(input, rowId)
  if ("refusal" in result) throw new Error(`expected success, got refusal ${result.refusal}`)
  expect(result.status).toBe(`Disabled "coder"`)
  expect(result.retryHint).toBe(`toggled "coder" against a stale revision; retry to apply`)
  expect(result.records.some((record) => record.item === "tool:coder" && record.state === "off")).toBe(true)
})

test("toggle refuses whole Role/persona with the unexcludable wording", () => {
  const input = baseInput()
  const nodes = expandedTree(input)
  const node = nodes.find((candidate) => candidate.label === "Role/persona")
  if (!node) throw new Error("missing role row")
  const result = toggle(input, node.id)
  if (!("refusal" in result)) throw new Error("expected refusal")
  expect(result.refusal).toBe(`"Role/persona" cannot be excluded and remains in effect`)
})

test("setEnabled succeeds on Code Mode rows", () => {
  const input = baseInput()
  const rowId = findId(input, "mcp:sample")
  const ok = setEnabled(input, rowId, false)
  if ("refusal" in ok) throw new Error(`expected success ${ok.refusal}`)
  expect(ok.status).toBe(`Disabled "sample"`)
  const coder = setEnabled(input, findId(input, "tool:coder"), false)
  if ("refusal" in coder) throw new Error(`expected Code Mode success ${coder.refusal}`)
  expect(coder.status).toBe(`Disabled "coder"`)
  expect(coder.records.some((record) => record.item === "tool:coder" && record.state === "off")).toBe(true)
})

test("saveText succeeds on Code Mode rows", () => {
  const input = baseInput()
  const rowId = findId(input, "mcp:sample")
  const ok = saveText(input, rowId, "new config")
  if ("refusal" in ok) throw new Error(`expected success ${ok.refusal}`)
  expect(ok.status).toBe(`Saved "sample"`)
  expect(ok.retryHint).toBe(`saved "sample" against a stale revision; retry to apply`)
  expect(ok.records.some((record) => record.item === "mcp:sample" && record.text === "new config")).toBe(true)
  const coder = saveText(input, findId(input, "tool:coder"), "x")
  if ("refusal" in coder) throw new Error(`expected Code Mode success ${coder.refusal}`)
  expect(coder.status).toBe(`Saved "coder"`)
  expect(coder.records.some((record) => record.item === "tool:coder" && record.text === "x")).toBe(true)
})

test("reset success clears the override and refusal names a missing override", () => {
  const record: CustomizationRecord = {
    type: "customization",
    level: "defaults",
    agent: null,
    item: "mcp:sample",
    section: null,
    state: "off",
    basedOn: "fp-sample",
    updated: "2026-09-14T00:00:00.000Z",
  }
  const input = baseInput({ records: [record] })
  const rowId = findId(input, "mcp:sample")
  const ok = reset(input, rowId)
  if ("refusal" in ok) throw new Error(`expected success ${ok.refusal}`)
  expect(ok.status).toBe(`Reset "sample" to default`)
  expect(ok.records.length).toBe(0)
  const empty = baseInput()
  const missing = reset(empty, findId(empty, "mcp:sample"))
  if (!("refusal" in missing)) throw new Error("expected refusal")
  expect(missing.refusal).toBe(`"sample" has no override to reset`)
})

test("saveSplit success and refusal on an unsplittable row", () => {
  const input = baseInput()
  const rowId = findId(input, "tool:bash")
  const ok = saveSplit(input, rowId, [{ id: "a", name: "A", start: 0 }])
  if ("refusal" in ok) throw new Error(`expected success ${ok.refusal}`)
  expect(ok.status).toBe(`Split "bash"`)
  expect(ok.retryHint).toBe(`split "bash" against a stale revision; retry to apply`)
  expect(ok.splits.some((split) => split.item === "tool:bash")).toBe(true)
  const bad = saveSplit(input, findId(input, "mcp:sample"), [{ id: "a", name: "A", start: 0 }])
  if (!("refusal" in bad)) throw new Error("expected refusal")
  expect(bad.refusal).toBe(`"sample" cannot be split`)
})

test("addSection appends the boundary and customization pair", () => {
  const input = baseInput()
  const rowId = findId(input, "tool:bash")
  const body = "run commands"
  const ok = addSection(input, rowId, "Flags", "extra flags")
  if ("refusal" in ok) throw new Error(`expected success ${ok.refusal}`)
  expect(ok.status).toBe(`Added "Flags" to "bash"`)
  const split = ok.splits.find((entry) => entry.item === "tool:bash")
  if (!split) throw new Error("expected split")
  expect(split.boundaries).toHaveLength(2)
  expect(split.boundaries[1]).toMatchObject({ name: "Flags", start: body.length })
  const customization = ok.records.find((entry) => entry.item === "tool:bash" && entry.section !== null)
  if (!customization) throw new Error("expected customization")
  expect(customization.text).toBe("extra flags")
  expect(split.boundaries.some((boundary) => boundary.id === customization.section)).toBe(true)
  const bad = addSection(input, findId(input, "mcp:sample"), "Flags", "x")
  if (!("refusal" in bad)) throw new Error("expected refusal")
  expect(bad.refusal).toBe(`"sample" does not support sections`)
})

test("resolveReview keep/take/edit match resolveResolution", () => {
  const record: CustomizationRecord = {
    type: "customization",
    level: "defaults",
    agent: null,
    item: "mcp:sample",
    section: null,
    text: "mine",
    basedOn: "fp-old",
    basedOnText: "old-upstream",
    updated: "2026-09-14T00:00:00.000Z",
  }
  const withUpstream = baseInput({
    items: baseInput().items.map((item) => (item.id === "mcp:sample" ? { ...item, text: "new-upstream" } : item)),
    records: [record],
  })
  const rowId = findId(withUpstream, "mcp:sample")
  const nodes = expandedTree(withUpstream)
  const node = nodes.find((candidate) => candidate.id === rowId)
  if (!node || !node.address) throw new Error("missing address")
  const chain = {
    upstream: withUpstream.items.find((item) => item.id === "mcp:sample")!,
    records: withUpstream.records.filter((entry) => entry.type === "customization") as CustomizationRecord[],
    splits: [],
    scopes: { global: new Set<string>(), defaults: new Set<string>() },
    address: node.address,
  }
  const withoutUpdated = (records: readonly CustomizationRecord[]) =>
    records.map((entry) => {
      const { updated: _ignored, ...meaningful } = entry
      void _ignored
      return meaningful
    })
  const expectValidIso = (timestamp: string) => {
    expect(timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(Number.isNaN(Date.parse(timestamp))).toBe(false)
    expect(new Date(timestamp).toISOString()).toBe(timestamp)
  }
  const keep = resolveReview(withUpstream, rowId, "keep")
  if ("refusal" in keep) throw new Error(`keep refused ${keep.refusal}`)
  expect(keep.status).toBe(`Kept "sample"`)
  expect(withoutUpdated(keep.records)).toEqual(withoutUpdated(resolveResolution(chain, "keep")))
  keep.records.forEach((entry) => expectValidIso(entry.updated))
  const take = resolveReview(withUpstream, rowId, "take")
  if ("refusal" in take) throw new Error(`take refused ${take.refusal}`)
  expect(take.status).toBe(`Took upstream for "sample"`)
  expect(withoutUpdated(take.records)).toEqual(withoutUpdated(resolveResolution(chain, "take")))
  take.records.forEach((entry) => expectValidIso(entry.updated))
  const edit = resolveReview(withUpstream, rowId, "edit", "merged text")
  if ("refusal" in edit) throw new Error(`edit refused ${edit.refusal}`)
  expect(edit.status).toBe(`Edited "sample"`)
  expect(withoutUpdated(edit.records)).toEqual(withoutUpdated(resolveResolution(chain, "edit", "merged text")))
  edit.records.forEach((entry) => expectValidIso(entry.updated))
  expect(edit.records.some((entry) => entry.text === "merged text")).toBe(true)
  const merge = resolveReview(withUpstream, rowId, "merge", "merged text")
  if ("refusal" in merge) throw new Error(`merge refused ${merge.refusal}`)
  // The accepted take-result says "Merged", never "Edited".
  expect(merge.status).toBe(`Merged "sample"`)
  expect(withoutUpdated(merge.records)).toEqual(withoutUpdated(resolveResolution(chain, "merge", "merged text")))
  merge.records.forEach((entry) => expectValidIso(entry.updated))
  expect(merge.records.some((entry) => entry.text === "merged text")).toBe(true)
})

test("removalPlan agent delete success", () => {
  const input = baseInput()
  const rowId = exactId(input, "agent:project:alpha")
  const plan = removalPlan(input, rowId)
  if ("refusal" in plan) throw new Error(`expected plan ${plan.refusal}`)
  expect(plan.kind).toBe("agent.delete")
  if (plan.kind !== "agent.delete") throw new Error("wrong kind")
  expect(plan.id).toBe("alpha")
  expect(plan.scope).toBe("project")
  expect(plan.confirmTitle).toBe(`Delete agent alpha?`)
  expect(plan.confirmMessage).toBe(`Delete project agent "alpha"? This cannot be undone.`)
  expect(plan.successStatus).toBe(`Deleted agent alpha`)
})

test("removalPlan section refusal", () => {
  const input = baseInput()
  const nodes = expandedTree(input)
  const section = nodes.find((candidate) => candidate.kind === "section")
  if (!section) throw new Error("expected a section row")
  const plan = removalPlan(input, section.id)
  if (!("refusal" in plan)) throw new Error("expected refusal")
  expect(plan.refusal).toBe(`"${section.label}" cannot be deleted: sections are toggled or split, not deleted`)
})

test("removalPlan skill not project-owned refusal", () => {
  const input = baseInput()
  const nodes = expandedTree(input)
  const row = nodes.find((candidate) => candidate.address?.item === "skill:native-one")
  if (!row) throw new Error("missing native skill row")
  const plan = removalPlan(input, row.id)
  if (!("refusal" in plan)) throw new Error("expected refusal")
  expect(plan.refusal).toBe(`"${row.label}" cannot be deleted: skill "native-one" is not user-authored`)
})

test("removalPlan base built-in refusal", () => {
  const input = baseInput()
  const nodes = expandedTree(input)
  const row = nodes.find((candidate) => candidate.address?.item === "base:gpt")
  if (!row) throw new Error("missing base row")
  const plan = removalPlan(input, row.id)
  if (!("refusal" in plan)) throw new Error("expected refusal")
  expect(plan.refusal).toBe(`"${row.label}" cannot be deleted: base template "gpt" is built in`)
})

test("removalPlan role is-not-a-file refusal", () => {
  const input = baseInput()
  const nodes = expandedTree(input)
  const row = nodes.find((candidate) => candidate.label === "Role/persona")
  if (!row) throw new Error("missing role row")
  const plan = removalPlan(input, row.id)
  if (!("refusal" in plan)) throw new Error("expected refusal")
  expect(plan.refusal).toBe(`"Role/persona" cannot be deleted: the agent's own prompt body is not a file`)
})

test("removalPlan tool rows-are-not-files refusal", () => {
  const input = baseInput()
  const nodes = expandedTree(input)
  const row = nodes.find((candidate) => candidate.address?.item === "tool:bash" && candidate.actions?.remove !== true)
  if (!row) throw new Error("missing tool row without remove")
  const plan = removalPlan(input, row.id)
  if (!("refusal" in plan)) throw new Error("expected refusal")
  expect(plan.refusal).toBe(`"${row.label}" cannot be deleted: tool rows are not files`)
})

test("removalPlan skill delete success", () => {
  const input = baseInput()
  const nodes = expandedTree(input)
  const row = nodes.find((candidate) => candidate.address?.item === "skill:proj-one" && candidate.actions?.remove === true)
  if (!row) throw new Error("missing project skill row")
  const plan = removalPlan(input, row.id)
  if ("refusal" in plan) throw new Error(`expected plan ${plan.refusal}`)
  expect(plan.kind).toBe("skill.delete")
})

test("teamPlan success inverts the stored state", () => {
  const input = baseInput()
  const rowId = exactId(input, "team:project:crew")
  const plan = teamPlan(input, rowId)
  if ("refusal" in plan) throw new Error(`expected plan ${plan.refusal}`)
  expect(plan.kind).toBe("team.setEnabled")
  if (plan.kind !== "team.setEnabled") throw new Error("wrong kind")
  expect(plan.level).toBe("project")
  expect(plan.team).toBe("crew")
  expect(plan.enabled).toBe(true)
  expect(plan.successStatus).toBe(`Enabled team "crew"`)
})

test("teamPlan refusal on a non-team row", () => {
  const input = baseInput()
  const rowId = findId(input, "mcp:sample")
  const nodes = expandedTree(input)
  const node = nodes.find((candidate) => candidate.id === rowId)
  if (!node) throw new Error("missing row")
  const plan = teamPlan(input, rowId)
  if (!("refusal" in plan)) throw new Error("expected refusal")
  expect(plan.refusal).toBe(`"${node.label}" cannot be toggled`)
})

test("refusalFor explains delete blocks and stays silent on structural rows", () => {
  const input = baseInput()
  const nodes = expandedTree(input)
  const native = nodes.find((candidate) => candidate.address?.item === "skill:native-one")
  if (!native) throw new Error("missing native skill")
  expect(refusalFor(input, native.id)).toBe(`"${native.label}" cannot be deleted: skill "native-one" is not user-authored`)
  const agentId = exactId(input, "agent:project:alpha")
  expect(refusalFor(input, agentId)).toBeUndefined()
})

test("setEnabled shares toggle status for Code Mode rows and refusal for unexcludable rows", () => {
  const input = baseInput()
  const nodes = expandedTree(input)
  const coder = nodes.find((candidate) => candidate.address?.item === "tool:coder")
  if (!coder) throw new Error("missing coder row")
  const toggledCoder = toggle(input, coder.id)
  const setCoder = setEnabled(input, coder.id, false)
  if ("refusal" in toggledCoder || "refusal" in setCoder) throw new Error("expected both to succeed")
  expect(setCoder.status).toBe(toggledCoder.status)
  expect(setCoder.status).toBe(`Disabled "coder"`)
  const role = nodes.find((candidate) => candidate.label === "Role/persona")
  if (!role) throw new Error("missing role row")
  const toggledRole = toggle(input, role.id)
  const setRole = setEnabled(input, role.id, false)
  if (!("refusal" in toggledRole) || !("refusal" in setRole)) throw new Error("expected both to refuse")
  expect(setRole.refusal).toBe(toggledRole.refusal)
  expect(setRole.refusal).toBe(`"Role/persona" cannot be excluded and remains in effect`)
  const baseRow = nodes.find((candidate) => candidate.address?.item === "base:gpt")
  if (!baseRow) throw new Error("missing base row")
  const toggledBase = toggle(input, baseRow.id)
  const setBase = setEnabled(input, baseRow.id, false)
  if (!("refusal" in toggledBase) || !("refusal" in setBase)) throw new Error("expected both to refuse")
  expect(setBase.refusal).toBe(toggledBase.refusal)
})

test("Code Mode sections toggle like any other section", () => {
  const input = baseInput()
  const nodes = expandedTree(input)
  const section = nodes.find((candidate) => candidate.kind === "section" && candidate.address?.item === "tool:coder")
  if (!section) throw new Error("missing coder section")
  const toggled = toggle(input, section.id)
  if ("refusal" in toggled) throw new Error(`expected toggle success ${toggled.refusal}`)
  expect(toggled.status).toBe(`Disabled "${section.label}"`)
  const set = setEnabled(input, section.id, false)
  if ("refusal" in set) throw new Error(`expected set success ${set.refusal}`)
  expect(set.status).toBe(toggled.status)
})

test("setPin sets and clears a Code Mode pin", () => {
  const input = baseInput()
  const rowId = findId(input, "tool:coder")
  const pinned = setPin(input, rowId, true)
  if ("refusal" in pinned) throw new Error(`expected pin success ${pinned.refusal}`)
  expect(pinned.status).toBe(`Pinned "coder"`)
  expect(pinned.retryHint).toBe(`pinned "coder" against a stale revision; retry to apply`)
  expect(pinned.records.some((record) => record.item === "tool:coder" && record.pin === true)).toBe(true)
  const withPinned: MemoInput = { ...input, records: [...pinned.records, ...pinned.splits] }
  const unpinned = setPin(withPinned, rowId, false)
  if ("refusal" in unpinned) throw new Error(`expected unpin success ${unpinned.refusal}`)
  expect(unpinned.status).toBe(`Unpinned "coder"`)
  expect(unpinned.records.some((record) => record.item === "tool:coder" && record.pin === false)).toBe(true)
  const aged = unpinned.records.map((record) => ({ ...record, updated: "2020-01-01T00:00:00.000Z" }))
  const withAged: MemoInput = { ...input, records: [...aged, ...unpinned.splits] }
  const again = setPin(withAged, rowId, false)
  if ("refusal" in again) throw new Error(`expected second unpin: ${again.refusal}`)
  expect(again.records).toEqual(aged)
})

test("setPin refuses rows that cannot be pinned", () => {
  const input = baseInput()
  const nodes = expandedTree(input)
  const bash = nodes.find((candidate) => candidate.address?.item === "tool:bash")
  if (!bash) throw new Error("missing bash row")
  const notCode = setPin(input, bash.id, true)
  if (!("refusal" in notCode)) throw new Error("expected pin refusal")
  expect(notCode.refusal).toBe(`"bash" is not a Code Mode tool and cannot be pinned`)
  const withExecute = baseInput({
    items: [
      ...baseInput().items,
      {
        id: "tool:execute",
        kind: "tool",
        group: "native",
        title: "execute",
        text: "Host-owned Code Mode entry point",
        enabled: true,
        fingerprint: "fp-execute",
        codemode: false,
        execute: true,
      },
    ],
  })
  const executeNodes = expandedTree(withExecute)
  const execute = executeNodes.find((candidate) => candidate.address?.item === "tool:execute")
  if (!execute) throw new Error("missing execute row")
  const hostOwned = setPin(withExecute, execute.id, true)
  if (!("refusal" in hostOwned)) throw new Error("expected execute refusal")
  expect(hostOwned.refusal).toBe(`"execute" is host-owned: toggle only`)
})

test("resolveReview edit succeeds on Code Mode rows and still requires edited text", () => {
  const input = baseInput()
  const nodes = expandedTree(input)
  const coder = nodes.find((candidate) => candidate.address?.item === "tool:coder")
  if (!coder) throw new Error("missing coder row")
  const edited = resolveReview(input, coder.id, "edit", "new text")
  if ("refusal" in edited) throw new Error(`expected Code Mode edit success ${edited.refusal}`)
  expect(edited.status).toBe(`Edited "coder"`)
  expect(edited.records.some((record) => record.item === "tool:coder" && record.text === "new text")).toBe(true)
  const sample = nodes.find((candidate) => candidate.address?.item === "mcp:sample")
  if (!sample) throw new Error("missing sample row")
  const missing = resolveReview(input, sample.id, "edit")
  if (!("refusal" in missing)) throw new Error("expected missing-text refusal")
  expect(missing.refusal).toContain("cannot be edited")
  const missingMerge = resolveReview(input, sample.id, "merge")
  if (!("refusal" in missingMerge)) throw new Error("expected merge missing-text refusal")
  expect(missingMerge.refusal).toContain("cannot be merged")
  expect(missingMerge.refusal).toContain("merge requires the merged text")
})

test("re-submitting identical text, state, and boundaries keeps the existing record", () => {
  const OLD = "2020-01-01T00:00:00.000Z"
  const input = baseInput()
  const rowId = findId(input, "mcp:sample")
  const first = saveText(input, rowId, "same text")
  if ("refusal" in first) throw new Error(`expected save: ${first.refusal}`)
  const agedText = first.records.map((record) => ({ ...record, updated: OLD }))
  const withFirst: MemoInput = { ...input, records: [...agedText, ...first.splits] }
  const second = saveText(withFirst, rowId, "same text")
  if ("refusal" in second) throw new Error(`expected second save: ${second.refusal}`)
  expect(second.records).toEqual(agedText)
  expect(second.records[0]?.updated).toBe(OLD)
  const disabled = setEnabled(withFirst, rowId, false)
  if ("refusal" in disabled) throw new Error(`expected disable: ${disabled.refusal}`)
  const agedDisabled = disabled.records.map((record) => ({ ...record, updated: OLD }))
  const withDisabled: MemoInput = { ...withFirst, records: [...agedDisabled, ...disabled.splits] }
  const again = setEnabled(withDisabled, rowId, false)
  if ("refusal" in again) throw new Error(`expected second disable: ${again.refusal}`)
  expect(again.records).toEqual(agedDisabled)
  expect(again.records[0]?.updated).toBe(OLD)
  const splitRow = findId(input, "tool:bash")
  const splitFirst = saveSplit(input, splitRow, [{ id: "a", name: "A", start: 0 }])
  if ("refusal" in splitFirst) throw new Error(`expected split: ${splitFirst.refusal}`)
  const agedSplits = splitFirst.splits.map((split) => ({ ...split, updated: OLD }))
  const withSplit: MemoInput = { ...input, records: [...splitFirst.records, ...agedSplits] }
  const splitAgain = saveSplit(withSplit, splitRow, [{ id: "a", name: "A", start: 0 }])
  if ("refusal" in splitAgain) throw new Error(`expected second split: ${splitAgain.refusal}`)
  expect(splitAgain.splits).toEqual(agedSplits)
  expect(splitAgain.splits[0]?.updated).toBe(OLD)
})

test("teamPlan honours an explicit desired state and inverts only for bare ids", () => {
  const input = baseInput()
  const rowId = exactId(input, "team:project:crew")
  const inverted = teamPlan(input, rowId)
  if ("refusal" in inverted) throw new Error(`expected plan: ${inverted.refusal}`)
  if (inverted.kind !== "team.setEnabled") throw new Error("wrong kind")
  expect(inverted.enabled).toBe(true)
  const explicitOff = teamPlan(input, rowId, false)
  if ("refusal" in explicitOff) throw new Error(`expected explicit plan: ${explicitOff.refusal}`)
  if (explicitOff.kind !== "team.setEnabled") throw new Error("wrong kind")
  expect(explicitOff.enabled).toBe(false)
  expect(explicitOff.successStatus).toBe(`Disabled team "crew"`)
  const explicitOn = teamPlan(input, rowId, true)
  if ("refusal" in explicitOn) throw new Error(`expected explicit plan: ${explicitOn.refusal}`)
  if (explicitOn.kind !== "team.setEnabled") throw new Error("wrong kind")
  expect(explicitOn.successStatus).toBe(`Enabled team "crew"`)
})

test("unknown row refuses for every op", () => {
  const input = baseInput()
  const unknown = "item:project:alpha:does:not:exist"
  const expected = unknownRowRefusal(unknown)
  const results = [
    toggle(input, unknown),
    setEnabled(input, unknown, true),
    setPin(input, unknown, true),
    saveText(input, unknown, "x"),
    reset(input, unknown),
    saveSplit(input, unknown, []),
    addSection(input, unknown, "Name", "text"),
    resolveReview(input, unknown, "keep"),
    removalPlan(input, unknown),
    teamPlan(input, unknown),
  ]
  for (const result of results) {
    if (!("refusal" in result)) throw new Error("expected refusal for unknown row")
    expect(result.refusal).toBe(expected)
  }
  expect(refusalFor(input, unknown)).toBe(expected)
})

test("execute section writes refuse as unknown row and persist nothing", () => {
  const input = baseInput({
    items: [
      ...baseInput().items,
      {
        id: "tool:execute",
        kind: "tool",
        group: "native",
        title: "execute",
        text: "Host-owned Code Mode entry point",
        enabled: true,
        fingerprint: "fp-execute",
        codemode: false,
        execute: true,
      },
    ],
  })
  const nodes = expandedTree(input)
  const execute = nodes.find((candidate) => candidate.address?.item === "tool:execute")
  if (!execute) throw new Error("missing execute row")
  const sectionId = "section:project:alpha:tool:execute:whole"
  expect(nodes.some((candidate) => candidate.id === sectionId)).toBe(false)
  const expected = unknownRowRefusal(sectionId)
  const saved = saveText(input, sectionId, "x")
  if (!("refusal" in saved)) throw new Error("expected saveText refusal")
  expect(saved.refusal).toBe(expected)
  expect("records" in saved).toBe(false)
  const toggled = setEnabled(input, sectionId, false)
  if (!("refusal" in toggled)) throw new Error("expected setEnabled refusal")
  expect(toggled.refusal).toBe(expected)
  expect("records" in toggled).toBe(false)
})

test("row ids round-trip items with colons, sections, agents, and colon teams", () => {
  const input = baseInput()
  const nodes = expandedTree(input)
  const role = nodes.find((candidate) => candidate.address?.item === "system:role")
  if (!role) throw new Error("missing system:role row")
  expect(role.id).toContain("system:role")
  const roleResult = toggle(input, role.id)
  expect("refusal" in roleResult).toBe(true)
  if (!("refusal" in roleResult)) throw new Error("expected refusal")
  expect(roleResult.refusal).toBe(`"Role/persona" cannot be excluded and remains in effect`)
  const section = nodes.find((candidate) => candidate.kind === "section")
  if (!section) throw new Error("missing section")
  const parts = section.id.split(":")
  expect(parts[0]).toBe("section")
  const sectionToggle = toggle(input, section.id)
  expect("refusal" in sectionToggle || "status" in sectionToggle).toBe(true)
  const agentId = exactId(input, "agent:project:alpha")
  const agentPlan = removalPlan(input, agentId)
  if ("refusal" in agentPlan) throw new Error(`agent should plan ${agentPlan.refusal}`)
  expect(agentPlan.kind).toBe("agent.delete")
  const colonTeamId = exactId(input, "team:project:my:team")
  const colonPlan = teamPlan(input, colonTeamId)
  if ("refusal" in colonPlan) throw new Error(`colon team should plan ${colonPlan.refusal}`)
  if (colonPlan.kind !== "team.setEnabled") throw new Error("wrong kind")
  expect(colonPlan.team).toBe("my:team")
  expect(fingerprint("upstream")).not.toBe(fingerprint("other"))
})

test("removalPlan on team member row returns team.removeAgent or refusal for shipped defaults", () => {
  const input = baseInput({
    teams: [
      { level: "project", team: "crew", enabled: true, agents: ["CrewMate"] },
      { level: "defaults", team: "starter", enabled: true, agents: ["shipped", "ovl"], overlay: ["ovl"] },
    ],
  })
  const projectPlan = removalPlan(input, "team:project:crew:CrewMate")
  if ("refusal" in projectPlan) throw new Error(`expected team.removeAgent plan: ${projectPlan.refusal}`)
  if (projectPlan.kind !== "team.removeAgent") throw new Error("wrong kind")
  expect(projectPlan.kind).toBe("team.removeAgent")
  expect(projectPlan.level).toBe("project")
  expect(projectPlan.team).toBe("crew")
  expect(projectPlan.id).toBe("CrewMate")
  expect(projectPlan.confirmTitle).toBe("Delete team member CrewMate?")
  expect(projectPlan.confirmMessage).toBe('Delete member "CrewMate" from team "crew"? This cannot be undone.')
  expect(projectPlan.successStatus).toBe("Deleted team member CrewMate")

  const shippedPlan = removalPlan(input, "team:defaults:starter:shipped")
  if (!("refusal" in shippedPlan)) throw new Error("expected refusal for shipped member")
  expect(shippedPlan.refusal).toBe('"shipped" cannot be deleted: shipped member of built-in team "starter"')

  const ovlPlan = removalPlan(input, "team:defaults:starter:ovl")
  if ("refusal" in ovlPlan) throw new Error(`expected team.removeAgent plan for overlay: ${ovlPlan.refusal}`)
  if (ovlPlan.kind !== "team.removeAgent") throw new Error("wrong kind")
  expect(ovlPlan.kind).toBe("team.removeAgent")
  expect(ovlPlan.level).toBe("defaults")
  expect(ovlPlan.team).toBe("starter")
  expect(ovlPlan.id).toBe("ovl")
})

test("removalPlan on ambiguous team and member row id returns refusal", () => {
  const input = baseInput({
    teams: [
      { level: "project", team: "crew:alpha", enabled: false, agents: ["firstmate"] },
      { level: "project", team: "crew", enabled: false, agents: ["alpha"] },
    ],
  })
  const plan = removalPlan(input, "team:project:crew:alpha")
  expect(plan).toEqual({
    refusal: '"crew:alpha" is ambiguous: it matches both a team and a member of team "crew". Rename one to continue.',
  })
})

test("removalPlan on team row returns team.delete plan or refusal for defaults", () => {
  const input = baseInput({
    teams: [
      { level: "project", team: "crew", enabled: true, agents: ["CrewMate", "SecondMate"] },
      { level: "global", team: "globalcrew", enabled: false, agents: [] },
      { level: "defaults", team: "starter", enabled: true, agents: ["shipped"] },
    ],
  })
  const projectPlan = removalPlan(input, "team:project:crew")
  if ("refusal" in projectPlan) throw new Error(`expected team.delete plan: ${projectPlan.refusal}`)
  if (projectPlan.kind !== "team.delete") throw new Error("wrong kind")
  expect(projectPlan.kind).toBe("team.delete")
  expect(projectPlan.level).toBe("project")
  expect(projectPlan.team).toBe("crew")
  expect(projectPlan.memberCount).toBe(2)
  expect(projectPlan.enabled).toBe(true)
  expect(projectPlan.confirmTitle).toBe("Delete team crew?")
  expect(projectPlan.confirmMessage).toBe(
    'Delete project team "crew" and its 2 member file(s)? It is currently enabled. This cannot be undone.',
  )
  expect(projectPlan.successStatus).toBe("Deleted team crew")

  const globalPlan = removalPlan(input, "team:global:globalcrew")
  if ("refusal" in globalPlan) throw new Error(`expected team.delete plan: ${globalPlan.refusal}`)
  if (globalPlan.kind !== "team.delete") throw new Error("wrong kind")
  expect(globalPlan.kind).toBe("team.delete")
  expect(globalPlan.level).toBe("global")
  expect(globalPlan.team).toBe("globalcrew")
  expect(globalPlan.memberCount).toBe(0)
  expect(globalPlan.enabled).toBe(false)
  expect(globalPlan.confirmTitle).toBe("Delete team globalcrew?")
  expect(globalPlan.confirmMessage).toBe(
    'Delete global team "globalcrew" and its 0 member file(s)? It is currently disabled. This cannot be undone.',
  )
  expect(globalPlan.successStatus).toBe("Deleted team globalcrew")

  const defaultsPlan = removalPlan(input, "team:defaults:starter")
  if (!("refusal" in defaultsPlan)) throw new Error("expected refusal for defaults team")
  expect(defaultsPlan.refusal).toBe('"starter" cannot be deleted: team "starter" is built in')
})

test("toggle, reset, and model activation under a team special write records carrying team", () => {
  const input = baseInput({
    agents: [
      { id: "alpha", scope: "project" },
      { id: "title", scope: "defaults", origin: "special" },
    ],
    records: [
      {
        type: "model",
        level: "defaults",
        agent: null,
        providerID: "acme",
        modelID: "nova-2",
        updated: "2026-01-01T00:00:00.000Z",
      },
      // A team special agent resolves through the Teams catalogue, so its
      // candidate comes from the Teams copy of the shared row.
      {
        type: "model",
        level: "defaults",
        agent: null,
        catalogue: "teams",
        providerID: "acme",
        modelID: "nova-2",
        updated: "2026-01-01T00:00:00.000Z",
      },
    ],
    teams: [{ level: "project", team: "crew", enabled: true, agents: ["alpha"] }],
  })

  // 1. Toggle
  const toolRowId = "item:project:crew/:special:title:tool:bash"
  const toggleResult = toggle(input, toolRowId)
  expect("records" in toggleResult).toBe(true)
  if (!("records" in toggleResult)) throw new Error("expected toggle success")
  const custom = toggleResult.records.find((r) => r.item === "tool:bash" && r.agent === "title")
  expect(custom).toBeDefined()
  expect(custom?.level).toBe("project")
  expect(custom?.team).toEqual({ level: "project", team: "crew" })
  expect(custom?.state).toBe("off")

  // 2. Reset
  const resetResult = reset({ ...input, records: toggleResult.records }, toolRowId)
  expect("records" in resetResult).toBe(true)
  if (!("records" in resetResult)) throw new Error("expected reset success")
  const customAfterReset = resetResult.records.find((r) => r.item === "tool:bash" && r.agent === "title" && r.team?.team === "crew")
  expect(customAfterReset).toBeUndefined()

  // 3. Model activation
  const modelRowId = "item:project:crew/:special:title:model:acme/nova-2"
  const modelResult = activateModelRow(input, modelRowId)
  expect("models" in modelResult).toBe(true)
  if (!("models" in modelResult)) throw new Error("expected model activation success")
  const modelRec = modelResult.models.find((m) => m.providerID === "acme" && m.modelID === "nova-2" && m.agent === "title")
  expect(modelRec).toBeDefined()
  expect(modelRec?.level).toBe("project")
  expect(modelRec?.team).toEqual({ level: "project", team: "crew" })
  expect(modelRec?.active).toBe(true)
})

test("reset refusal distinguishes stored override on non-resettable row from absent override", () => {
  const withExecute = baseInput({
    items: [
      ...baseInput().items,
      {
        id: "tool:execute",
        kind: "tool",
        group: "native",
        title: "execute",
        text: "Host-owned Code Mode entry point",
        enabled: true,
        fingerprint: "fp-execute",
        codemode: false,
        execute: true,
      },
    ],
  })
  const executeNodes = expandedTree(withExecute)
  const execute = executeNodes.find((candidate) => candidate.address?.item === "tool:execute")
  if (!execute || !execute.address) throw new Error("missing execute row")

  // 1. A tool:execute row carrying a stored state: "off" customization record
  const record: CustomizationRecord = {
    type: "customization",
    level: execute.address.level,
    agent: execute.address.agent,
    item: execute.address.item,
    section: execute.address.section,
    state: "off",
    basedOn: "fp-execute",
    updated: "2026-09-14T00:00:00.000Z",
  }
  const inputWithRecord = { ...withExecute, records: [record] }
  const storedResult = reset(inputWithRecord, execute.id)
  if (!("refusal" in storedResult)) throw new Error("expected refusal for stored record on execute row")
  expect(storedResult.refusal).not.toContain("has no override to reset")
  expect(storedResult.refusal).toContain('set state "on" to clear the stored override')
  expect(storedResult.refusal).toBe(`"${execute.label}" cannot be reset; set state "on" to clear the stored override`)

  // 2. A clean non-resettable row with no stored record
  const cleanResult = reset(withExecute, execute.id)
  if (!("refusal" in cleanResult)) throw new Error("expected refusal for clean non-resettable row")
  expect(cleanResult.refusal).toBe(`"${execute.label}" has no override to reset`)
})

// An agent whose preset supplies its text saves its own text against that
// text, not against the raw upstream: its first edit is not "to review".
test("saveText records the text above the row (the preset's) as its baseline, so a first own edit is not to review", async () => {
  const { plusAgentPresets } = await import("../src/instructions/presets.js")
  const orchestratorRole = plusAgentPresets.find((preset) => preset.id === "orchestrator")?.role ?? ""
  const base = baseInput()
  const input: MemoInput = {
    ...base,
    items: [
      ...base.items,
      { id: "system:role", kind: "system", group: "none", title: "Role", text: "", enabled: true, fingerprint: fingerprint(""), agents: ["beta"] },
    ],
    agents: [...base.agents, { id: "beta", scope: "project" }],
    links: [...(base.links ?? []), { type: "link", level: "project", agent: "beta", preset: { kind: "agent", id: "orchestrator" }, updated: "2026-01-01T00:00:00.000Z" }],
  }
  const rowId = exactId(input, "item:project:beta:system:role")
  const saved = saveText(input, rowId, "my own role")
  if ("refusal" in saved) throw new Error(saved.refusal)
  const record = saved.records.find((entry) => entry.type === "customization" && entry.agent === "beta" && entry.item === "system:role") as CustomizationRecord | undefined
  expect(record?.basedOn).toBe(fingerprint(orchestratorRole))
  expect(record?.basedOnText).toBe(orchestratorRole)
  const after: MemoInput = { ...input, records: [...saved.records, ...saved.splits] }
  const row = expandedTree(after).find((node) => node.id === rowId)
  expect(row?.badges.review).toBe(false)
  expect(row?.badges.modified).toBe(true)
})

// ---- model delete (tombstones) and enter-edit ----

const MODEL_UPDATED = "2026-01-01T00:00:00.000Z"

function buildInput(records: ModelRecord[]): MemoInput {
  return baseInput({
    agents: [
      {
        id: "build",
        scope: "defaults",
        origin: "native",
        model: { providerID: "acme", modelID: "base" },
      },
    ],
    records,
  })
}

function modelRecord(overrides: Partial<ModelRecord>): ModelRecord {
  return {
    type: "model",
    level: "project",
    agent: "build",
    providerID: "acme",
    modelID: "nova",
    updated: MODEL_UPDATED,
    ...overrides,
  }
}

function rowIdOf(level: "project" | "global" | "defaults", model: string): string {
  return `item:${level}:build:model:${model}`
}

test("d on an upstream row hides it at this level only; the source views keep it", () => {
  const input = buildInput([modelRecord({ modelID: "mine", active: true, basedOn: "acme/base" })])
  const result = removeModelRow(input, rowIdOf("project", "acme/base"))
  if ("refusal" in result) throw new Error(`expected success, got ${result.refusal}`)
  expect(result.status).toBe('Hidden "acme/base" at this level')
  const tombstone = result.models.find((record) => record.removed === true)
  expect(tombstone).toMatchObject({ level: "project", agent: "build", providerID: "acme", modelID: "base" })
  const nodes = expandedTree({ items: [], records: result.models, agents: [{ id: "build", scope: "defaults", origin: "native", model: { providerID: "acme", modelID: "base" } }] })
  expect(nodes.some((node) => node.id === rowIdOf("project", "acme/base"))).toBe(false)
  // Global and Defaults do not resolve through the Project node: the upstream
  // candidate is still listed there.
  expect(nodes.some((node) => node.id === rowIdOf("global", "acme/base"))).toBe(true)
  expect(nodes.some((node) => node.id === rowIdOf("defaults", "acme/base"))).toBe(true)
  expect(nodes.find((node) => node.id === rowIdOf("project", "acme/mine"))?.badges.active).toBe(true)
})

test("d on an inherited global candidate hides it at Project only", () => {
  const input = buildInput([
    modelRecord({ modelID: "mine", active: true }),
    modelRecord({ modelID: "theirs", level: "global" }),
  ])
  const result = removeModelRow(input, rowIdOf("project", "acme/theirs"))
  if ("refusal" in result) throw new Error(`expected success, got ${result.refusal}`)
  const agents = [{ id: "build", scope: "defaults" as const, origin: "native" as const, model: { providerID: "acme", modelID: "base" } }]
  const nodes = expandedTree({ items: [], records: result.models, agents })
  expect(nodes.some((node) => node.id === rowIdOf("project", "acme/theirs"))).toBe(false)
  // The Global view does not resolve through the Project tombstone.
  expect(nodes.some((node) => node.id === rowIdOf("global", "acme/theirs"))).toBe(true)
  expect(nodes.find((node) => node.id === rowIdOf("project", "acme/mine"))?.badges.active).toBe(true)
})

test("re-adding a hidden model at the same level clears the tombstone", () => {
  const input = buildInput([modelRecord({ modelID: "mine", active: true })])
  const hidden = removeModelRow(input, rowIdOf("project", "acme/base"))
  if ("refusal" in hidden) throw new Error(`expected success, got ${hidden.refusal}`)
  const readded = addModelRecord(hidden.models, { level: "project", agent: "build" }, { providerID: "acme", modelID: "base" }, MODEL_UPDATED)
  expect(readded.some((record) => record.removed === true)).toBe(false)
  const nodes = expandedTree({ items: [], records: readded, agents: [{ id: "build", scope: "defaults", origin: "native", model: { providerID: "acme", modelID: "base" } }] })
  const row = nodes.find((node) => node.id === rowIdOf("project", "acme/base"))
  expect(row).toBeDefined()
  expect(row?.badges.active).toBeUndefined()
  // Hidden in a stale snapshot, live again once the save lands.
  const back = expandedTree({ items: [], records: hidden.models, agents: [{ id: "build", scope: "defaults", origin: "native", model: { providerID: "acme", modelID: "base" } }] })
  expect(back.some((node) => node.id === rowIdOf("project", "acme/base"))).toBe(false)
})

test("d refuses on the effective model: inherited, upstream and a lone local active", () => {
  const inherited = buildInput([
    modelRecord({ modelID: "theirs", level: "global", active: true }),
    modelRecord({ modelID: "base", level: "project" }), // upstream tombstone candidate context
  ])
  const inheritedRow = rowIdOf("project", "acme/theirs")
  const refused = removeModelRow(inherited, inheritedRow)
  if (!("refusal" in refused)) throw new Error("expected refusal for the inherited effective model")
  expect(refused.refusal).toBe(`"acme/theirs" is the active model here: activate another model first`)

  const upstreamOnly = buildInput([])
  const upstreamRefused = removeModelRow(upstreamOnly, rowIdOf("project", "acme/base"))
  if (!("refusal" in upstreamRefused)) throw new Error("expected refusal for the effective upstream model")
  expect(upstreamRefused.refusal).toBe(`"acme/base" is the active model here: activate another model first`)

  const lone = buildInput([modelRecord({ modelID: "mine", active: true })])
  const loneRefused = removeModelRow(lone, rowIdOf("project", "acme/mine"))
  if (!("refusal" in loneRefused)) throw new Error("expected refusal for the lone local active model")
  expect(loneRefused.refusal).toBe(`"acme/mine" is the active model here: activate another model first`)
})

test("d deletes a local active model when a lower level still resolves another stored model", () => {
  const input = buildInput([
    modelRecord({ modelID: "mine", active: true }),
    modelRecord({ modelID: "theirs", level: "global", active: true }),
  ])
  const result = removeModelRow(input, rowIdOf("project", "acme/mine"))
  if ("refusal" in result) throw new Error(`expected success, got ${result.refusal}`)
  expect(result.status).toBe('Removed "acme/mine"')
  expect(result.models.some((record) => record.level === "project" && record.modelID === "mine")).toBe(false)
  const nodes = expandedTree({ items: [], records: result.models, agents: [{ id: "build", scope: "defaults", origin: "native", model: { providerID: "acme", modelID: "base" } }] })
  const theirs = nodes.find((node) => node.id === rowIdOf("project", "acme/theirs"))
  expect(theirs?.badges.active).toBe(true)
  expect(theirs?.badges.activeFrom).toBe("global")
})

test("editModelRow replaces the candidate and keeps the effective model active", () => {
  const input = buildInput([modelRecord({ modelID: "mine", active: true, basedOn: "acme/base" })])
  const result = editModelRow(input, rowIdOf("project", "acme/mine"), { providerID: "acme", modelID: "mine", variant: "high", warming: "45m" })
  if ("refusal" in result) throw new Error(`expected success, got ${result.refusal}`)
  expect(result.status).toBe('Updated "acme/mine"')
  const replaced = result.models.find((record) => record.level === "project")
  expect(replaced).toMatchObject({ providerID: "acme", modelID: "mine", variant: "high", active: true, warming: "45m" })
  expect(result.models.some((record) => record.variant === undefined && record.modelID === "mine")).toBe(false)
  const nodes = expandedTree({ items: [], records: result.models, agents: [{ id: "build", scope: "defaults", origin: "native", model: { providerID: "acme", modelID: "base" } }] })
  const row = nodes.find((node) => node.id === rowIdOf("project", "acme/mine@high"))
  expect(row?.badges.active).toBe(true)
  expect(row?.badges.warming).toBe("45m")
})

test("editModelRow plants a local record for an inherited row, active for the effective upstream", () => {
  const input = buildInput([
    modelRecord({ modelID: "other", level: "global" }),
  ])
  const inactive = editModelRow(input, rowIdOf("project", "acme/other"), { providerID: "acme", modelID: "other", variant: "low", warming: "off" })
  if ("refusal" in inactive) throw new Error(`expected success, got ${inactive.refusal}`)
  expect(inactive.models.find((record) => record.level === "project" && record.modelID === "other")).toMatchObject({ variant: "low", warming: "off" })
  expect(inactive.models.find((record) => record.level === "project" && record.modelID === "other")?.active).toBeUndefined()

  // Nothing is active, so the host model is the effective one: editing its
  // Project row plants a local active record for the new candidate.
  const upstream = editModelRow(input, rowIdOf("project", "acme/base"), { providerID: "acme", modelID: "base", variant: "high" })
  if ("refusal" in upstream) throw new Error(`expected success, got ${upstream.refusal}`)
  expect(upstream.models.find((record) => record.level === "project" && record.modelID === "base")).toMatchObject({ variant: "high", active: true })
})

test("editModelRow validates warming and refuses an empty edit", () => {
  const input = buildInput([modelRecord({ modelID: "mine", active: true })])
  const bad = editModelRow(input, rowIdOf("project", "acme/mine"), { providerID: "acme", modelID: "mine", warming: "forever" })
  if (!("refusal" in bad)) throw new Error("expected warming refusal")
  expect(bad.refusal).toContain("not a warming time")
  const noop = editModelRow(input, rowIdOf("project", "acme/mine"), { providerID: "acme", modelID: "mine" })
  if (!("refusal" in noop)) throw new Error("expected no-change refusal")
  expect(noop.refusal).toBe('"acme/mine" has no changes to save')
})
