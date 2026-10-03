import { expect, test } from "bun:test"
import { resolvedFor, roleUpdates, rowGate, type ApplyInput } from "../src/instructions/apply.js"
import { guidanceContent } from "../src/instructions/guidance.js"
import { fingerprint, type CustomizationRecord, type Item, type Level } from "../src/instructions/model.js"
import { setRequires } from "../src/instructions/ops.js"
import { guidanceItemId } from "../src/instructions/paths.js"
import { chainContext } from "../src/instructions/presets.js"
import { expandedTree, type MemoInput } from "../src/instructions/tree.js"

// "Shown when" is a setting of its own: a level can set which rows a system
// row or section is sent under (record field `requires`), replacing the
// section's own `<!-- requires -->` line, without touching its text.

const UPDATED = "2026-01-01T00:00:00.000Z"

const roleText = `# Role

## Always
Read the Brief.

## Checks
<!-- requires: tool:team_check -->
Run checks with team_check.
`

const items: Item[] = [
  { id: "system:role", kind: "system", group: "none", title: "Role", text: roleText, enabled: true, fingerprint: fingerprint(roleText), agents: ["alpha", "beta"] },
  { id: guidanceItemId, kind: "system", group: "plus", title: "Tools and rules", text: guidanceContent, enabled: true, fingerprint: fingerprint(guidanceContent) },
  { id: "tool:team_check", kind: "tool", group: "plus", title: "team_check", text: "Run a check.", enabled: true, fingerprint: "a" },
  { id: "tool:question", kind: "tool", group: "native", title: "question", text: "Ask.", enabled: true, fingerprint: "b" },
  { id: "tool:reader", kind: "tool", group: "native", title: "reader", text: "Read.", enabled: true, fingerprint: "c" },
]

const agents = ["alpha", "beta"]
const links = agents.map((agent) => ({ type: "link" as const, level: "project" as Level, agent, preset: { kind: "agent" as const, id: "build" }, updated: UPDATED }))

function memo(records: readonly CustomizationRecord[]): MemoInput {
  return { items, records, agents: agents.map((id) => ({ id, scope: "project" as const, origin: "user" as const })), links, teams: [] }
}

function applyInput(records: readonly CustomizationRecord[]): ApplyInput {
  const sources = agents.map((id) => ({ id, scope: "project" as const, origin: "user" as const }))
  return {
    items,
    records,
    splits: [],
    agents: agents.map((id) => ({ id, level: "project" as Level })),
    scopes: chainContext({ agents: sources, items, links }),
  }
}

function off(agent: string, item: string): CustomizationRecord {
  return { type: "customization", level: "project", agent, item, section: null, state: "off", basedOn: "", updated: UPDATED }
}

function records(result: ReturnType<typeof setRequires>): CustomizationRecord[] {
  if ("refusal" in result) throw new Error(`refused: ${result.refusal}`)
  return result.records
}

const checks = "section:project:alpha:system:role:role/checks"
const questions = `section:project:alpha:${guidanceItemId}:tools-and-rules/questions`
const roleOf = (input: ApplyInput, agent: string) => roleUpdates(input).find((update) => update.agent === agent)?.text ?? ""

test("a level's condition replaces the section's own line; [] sends it always; null follows the line again", () => {
  // alpha: team_check on, question off.
  const base = [off("alpha", "tool:question")]
  expect(roleOf(applyInput(base), "alpha")).toContain("## Checks")
  const badges = (input: readonly CustomizationRecord[], id: string) => expandedTree(memo(input)).find((node) => node.id === id)?.badges
  expect(badges(base, checks)?.requires).toEqual([{ id: "tool:team_check", on: true, met: true }])
  expect(badges(base, checks)?.requiresFrom).toBe("its text")

  // Shown only while question is on: alpha has it off, so it goes; the text is untouched.
  const onQuestion = records(setRequires(memo(base), checks, ["tool:question"]))
  expect(onQuestion.find((record) => record.section === "role/checks")).toMatchObject({ requires: ["tool:question"] })
  expect(onQuestion.find((record) => record.section === "role/checks")?.text).toBeUndefined()
  expect(roleOf(applyInput(onQuestion), "alpha")).not.toContain("## Checks")
  // Set for alpha only: beta still follows the line in the text.
  expect(roleOf(applyInput(onQuestion), "beta")).toContain("## Checks")
  expect(badges(onQuestion, checks)?.requires).toEqual([{ id: "tool:question", on: true, met: false }])
  expect(badges(onQuestion, checks)?.requiresFrom).toBe("set here")
  expect(badges(onQuestion, checks)?.requiresHere).toBe(true)
  expect(badges(base, checks)?.requiresHere).toBeUndefined()

  // Always: even with team_check off.
  const always = records(setRequires(memo([...onQuestion, off("alpha", "tool:team_check")]), checks, []))
  expect(roleOf(applyInput(always), "alpha")).toContain("## Checks\nRun checks with team_check.")
  expect(roleOf(applyInput(always), "alpha")).not.toContain("<!--")

  // null drops this level's condition: the text's line decides again.
  const follow = records(setRequires(memo(always), checks, null))
  expect(follow.some((record) => record.section === "role/checks")).toBe(false)
  expect(roleOf(applyInput(follow), "alpha")).not.toContain("## Checks")
})

test("a Tools and rules section can be tied to another row, and the tool row lists it", () => {
  const tied = records(setRequires(memo([]), questions, ["tool:reader"]))
  const nodes = expandedTree(memo(tied))
  const of = (id: string) => nodes.find((node) => node.id === id)?.badges.guidance ?? []
  expect(of("item:project:alpha:tool:reader")).toEqual(["Questions"])
  expect(of("item:project:alpha:tool:question")).toEqual([])
  const input = applyInput([...tied, off("alpha", "tool:reader")])
  const row = items.find((item) => item.id === guidanceItemId)!
  const agent = { id: "alpha", level: "project" as Level }
  expect(resolvedFor(row, agent, input, rowGate(input, agent)).assembled).not.toContain("## Questions")
  // beta follows the shipped line (question on): it still gets the section.
  const beta = { id: "beta", level: "project" as Level }
  expect(resolvedFor(row, beta, input, rowGate(input, beta)).assembled).toContain("## Questions")
})

test("a whole instruction row can be conditioned; Role/persona as a whole cannot", () => {
  const whole = `item:project:alpha:${guidanceItemId}`
  const tied = records(setRequires(memo([]), whole, ["!tool:question"]))
  const input = applyInput(tied)
  const row = items.find((item) => item.id === guidanceItemId)!
  const agent = { id: "alpha", level: "project" as Level }
  // alpha has question on, the row needs it off: nothing is sent.
  expect(resolvedFor(row, agent, input, rowGate(input, agent)).assembled).toBe("")
  expect(expandedTree(memo(tied)).find((node) => node.id === whole)?.badges.requires).toEqual([{ id: "tool:question", on: false, met: false }])
  const role = setRequires(memo([]), "item:project:alpha:system:role", ["tool:question"])
  expect("refusal" in role && role.refusal).toContain("cannot be sent conditionally")
})

test("a condition names rows that exist, in the row id shape, never both on and off", () => {
  const refusal = (ids: string[]) => {
    const result = setRequires(memo([]), checks, ids)
    return "refusal" in result ? result.refusal : ""
  }
  expect(refusal(["question"])).toContain("is not a row id: use tool:<id>")
  expect(refusal(["tool:questoin"])).toContain('no row "tool:questoin" exists')
  expect(refusal(["tool:team_chec"])).toContain("did you mean tool:team_check")
  expect(refusal(["tool:question", "!tool:question"])).toContain("cannot be required both on and off")
  const tool = setRequires(memo([]), "item:project:alpha:tool:question", ["tool:team_check"])
  expect("refusal" in tool && tool.refusal).toContain("cannot be sent conditionally")
})
