import { expect, test } from "bun:test"
import { fingerprint, resolveResolution } from "../src/instructions/model.js"
import type { CustomizationRecord } from "../src/instructions/model.js"
import { expandedTree } from "../src/instructions/tree.js"
import type { MemoInput } from "../src/instructions/tree.js"
import {
  addSection,
  refusalFor,
  removalPlan,
  reset,
  resolveReview,
  saveSplit,
  saveText,
  setEnabled,
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

test("toggle refuses Code Mode tooling with the unsupported wording", () => {
  const input = baseInput()
  const rowId = findId(input, "tool:coder")
  const nodes = expandedTree(input)
  const node = nodes.find((candidate) => candidate.id === rowId)
  if (!node) throw new Error("missing coder row")
  const result = toggle(input, rowId)
  if (!("refusal" in result)) throw new Error("expected refusal")
  expect(result.refusal).toBe(`"${node.label}" is unsupported in Code Mode and cannot be toggled`)
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

test("setEnabled success and refusal", () => {
  const input = baseInput()
  const rowId = findId(input, "mcp:sample")
  const ok = setEnabled(input, rowId, false)
  if ("refusal" in ok) throw new Error(`expected success ${ok.refusal}`)
  expect(ok.status).toBe(`Disabled "sample"`)
  const gated = setEnabled(input, findId(input, "tool:coder"), false)
  if (!("refusal" in gated)) throw new Error("expected refusal")
  expect(gated.refusal).toBe(`"coder" cannot be toggled`)
})

test("saveText success and Code Mode refusal", () => {
  const input = baseInput()
  const rowId = findId(input, "mcp:sample")
  const ok = saveText(input, rowId, "new config")
  if ("refusal" in ok) throw new Error(`expected success ${ok.refusal}`)
  expect(ok.status).toBe(`Saved "sample"`)
  expect(ok.retryHint).toBe(`saved "sample" against a stale revision; retry to apply`)
  expect(ok.records.some((record) => record.item === "mcp:sample" && record.text === "new config")).toBe(true)
  const gated = saveText(input, findId(input, "tool:coder"), "x")
  if (!("refusal" in gated)) throw new Error("expected refusal")
  expect(gated.refusal).toBe(`"coder" is unsupported in Code Mode and cannot be edited`)
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
  const keep = resolveReview(withUpstream, rowId, "keep")
  if ("refusal" in keep) throw new Error(`keep refused ${keep.refusal}`)
  expect(keep.status).toBe(`Kept "sample"`)
  expect(keep.records).toEqual(resolveResolution(chain, "keep"))
  const take = resolveReview(withUpstream, rowId, "take")
  if ("refusal" in take) throw new Error(`take refused ${take.refusal}`)
  expect(take.status).toBe(`Took upstream for "sample"`)
  expect(take.records).toEqual(resolveResolution(chain, "take"))
  const edit = resolveReview(withUpstream, rowId, "edit", "merged text")
  if ("refusal" in edit) throw new Error(`edit refused ${edit.refusal}`)
  expect(edit.status).toBe(`Edited "sample"`)
  expect(edit.records).toEqual(resolveResolution(chain, "edit", "merged text"))
  expect(edit.records.some((entry) => entry.text === "merged text")).toBe(true)
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
  expect(plan.refusal).toBe(`"${row.label}" cannot be deleted: skill "native-one" is not project-owned`)
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
  expect(refusalFor(input, native.id)).toBe(`"${native.label}" cannot be deleted: skill "native-one" is not project-owned`)
  const agentId = exactId(input, "agent:project:alpha")
  expect(refusalFor(input, agentId)).toBeUndefined()
})

test("unknown row refuses for every op", () => {
  const input = baseInput()
  const unknown = "item:project:alpha:does:not:exist"
  const expected = unknownRowRefusal(unknown)
  const results = [
    toggle(input, unknown),
    setEnabled(input, unknown, true),
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
