import { expect, test } from "bun:test"
import { resolvedFor, roleUpdates, rowGate, type ApplyInput } from "../src/instructions/apply.js"
import { badgeLabels } from "../src/instructions/from-label.js"
import { guidanceContent } from "../src/instructions/guidance.js"
import { fingerprint, type CustomizationRecord, type Item, type Level } from "../src/instructions/model.js"
import { setRequires } from "../src/instructions/ops.js"
import { guidanceItemId } from "../src/instructions/paths.js"
import { chainContext } from "../src/instructions/presets.js"
import { findCollapse, query } from "../src/instructions/query.js"
import { isReplacementBarrier, type RowlinkRecord } from "../src/instructions/rowlinks.js"
import { expandedTree, type MemoInput } from "../src/instructions/tree.js"

// "Shown when" is a setting of its own: a level can set which rows a system
// row or section is sent under, stored as rowlink gate records (B43) — not a
// customization field — so request assembly and the link tool read one
// authority. A target-local replacement barrier says the whole list is local,
// replacing the section's own `<!-- requires -->` line; `[]` means always and
// null drops the local list so the level above or the text decides again.

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

function memo(records: readonly CustomizationRecord[], rowlinks: readonly RowlinkRecord[] = []): MemoInput {
  return { items, records, rowlinks, agents: agents.map((id) => ({ id, scope: "project" as const, origin: "user" as const })), links, teams: [] }
}

function applyInput(records: readonly CustomizationRecord[], rowlinks: readonly RowlinkRecord[] = []): ApplyInput {
  const sources = agents.map((id) => ({ id, scope: "project" as const, origin: "user" as const }))
  return {
    items,
    records,
    splits: [],
    agents: agents.map((id) => ({ id, level: "project" as Level })),
    scopes: chainContext({ agents: sources, items, links, rowlinks }),
  }
}

function off(agent: string, item: string): CustomizationRecord {
  return { type: "customization", level: "project", agent, item, section: null, state: "off", basedOn: "", updated: UPDATED }
}

function result(outcome: ReturnType<typeof setRequires>): { records: CustomizationRecord[]; rowlinks: readonly RowlinkRecord[] } {
  if ("refusal" in outcome) throw new Error(`refused: ${outcome.refusal}`)
  return { records: outcome.records, rowlinks: outcome.rowlinks ?? [] }
}

const checks = "section:project:alpha:system:role:role/checks"
const questions = `section:project:alpha:${guidanceItemId}:tools-and-rules/questions`
const roleOf = (input: ApplyInput, agent: string) => roleUpdates(input).find((update) => update.agent === agent)?.text ?? ""

test("a level's condition replaces the section's own line; [] sends it always; null follows the line again", () => {
  // alpha: team_check on, question off.
  const base = [off("alpha", "tool:question")]
  expect(roleOf(applyInput(base), "alpha")).toContain("## Checks")
  const badges = (input: readonly CustomizationRecord[], rowlinks: readonly RowlinkRecord[], id: string) =>
    expandedTree(memo(input, rowlinks)).find((node) => node.id === id)?.badges
  expect(badges(base, [], checks)?.requires).toEqual([{ id: "tool:team_check", on: true, met: true }])
  expect(badges(base, [], checks)?.requiresFrom).toBe("its text")

  // Shown only while question is on: alpha has it off, so it goes; the text is
  // untouched and the condition lives only as rowlinks (one barrier + one pair).
  const onQuestion = result(setRequires(memo(base), checks, ["tool:question"]))
  expect(onQuestion.records.some((record) => record.section === "role/checks" && record.requires !== undefined)).toBe(false)
  expect(onQuestion.rowlinks.filter(isReplacementBarrier)).toHaveLength(1)
  expect(onQuestion.rowlinks.filter((link) => !isReplacementBarrier(link)).map((link) => [link.item, link.link])).toEqual([
    ["tool:question", "shownWhenOn"],
  ])
  expect(roleOf(applyInput(onQuestion.records, onQuestion.rowlinks), "alpha")).not.toContain("## Checks")
  // Set for alpha only: beta still follows the line in the text.
  expect(roleOf(applyInput(onQuestion.records, onQuestion.rowlinks), "beta")).toContain("## Checks")
  expect(badges(onQuestion.records, onQuestion.rowlinks, checks)?.requires).toEqual([{ id: "tool:question", on: true, met: false }])
  expect(badges(onQuestion.records, onQuestion.rowlinks, checks)?.requiresFrom).toBe("set here")
  expect(badges(onQuestion.records, onQuestion.rowlinks, checks)?.requiresHere).toBe(true)

  // Always: even with team_check off, the barrier-only list sends it.
  const always = result(setRequires(memo([...onQuestion.records, off("alpha", "tool:team_check")], onQuestion.rowlinks), checks, []))
  expect(roleOf(applyInput(always.records, always.rowlinks), "alpha")).toContain("## Checks\nRun checks with team_check.")
  expect(roleOf(applyInput(always.records, always.rowlinks), "alpha")).not.toContain("<!--")

  // null drops this level's condition: the text's line decides again.
  const follow = result(setRequires(memo(always.records, always.rowlinks), checks, null))
  expect(follow.rowlinks.filter((link) => link.target === "system:role" && link.targetSection === "role/checks")).toEqual([])
  expect(roleOf(applyInput(follow.records, follow.rowlinks), "alpha")).not.toContain("## Checks")
})

test("a Tools and rules section can be tied to another row, and the tool row lists it", () => {
  const tied = result(setRequires(memo([]), questions, ["tool:reader"]))
  const nodes = expandedTree(memo(tied.records, tied.rowlinks))
  const of = (id: string) => nodes.find((node) => node.id === id)?.badges.guidance ?? []
  expect(of("item:project:alpha:tool:reader")).toEqual(["Questions"])
  expect(of("item:project:alpha:tool:question")).toEqual([])
  const input = applyInput([...tied.records, off("alpha", "tool:reader")], tied.rowlinks)
  const row = items.find((item) => item.id === guidanceItemId)!
  const agent = { id: "alpha", level: "project" as Level }
  expect(resolvedFor(row, agent, input, rowGate(input, agent)).assembled).not.toContain("## Questions")
  // beta follows the shipped line (question on): it still gets the section.
  const beta = { id: "beta", level: "project" as Level }
  expect(resolvedFor(row, beta, input, rowGate(input, beta)).assembled).toContain("## Questions")
})

test("a whole instruction row can be conditioned; Role/persona as a whole cannot", () => {
  const whole = `item:project:alpha:${guidanceItemId}`
  const tied = result(setRequires(memo([]), whole, ["!tool:question"]))
  const input = applyInput(tied.records, tied.rowlinks)
  const row = items.find((item) => item.id === guidanceItemId)!
  const agent = { id: "alpha", level: "project" as Level }
  // alpha has question on, the row needs it off: nothing is sent.
  expect(resolvedFor(row, agent, input, rowGate(input, agent)).assembled).toBe("")
  expect(expandedTree(memo(tied.records, tied.rowlinks)).find((node) => node.id === whole)?.badges.requires).toEqual([
    { id: "tool:question", on: false, met: false },
  ])
  const role = setRequires(memo([]), "item:project:alpha:system:role", ["tool:question"])
  expect("refusal" in role && role.refusal).toContain("cannot be sent conditionally")
})

test("a condition names rows that exist, in the row id shape, never both on and off", () => {
  const refusal = (ids: string[]) => {
    const outcome = setRequires(memo([]), checks, ids)
    return "refusal" in outcome ? outcome.refusal : ""
  }
  expect(refusal(["question"])).toContain("is not a row id: use tool:<id>")
  expect(refusal(["tool:questoin"])).toContain('no row "tool:questoin" exists')
  expect(refusal(["tool:team_chec"])).toContain("did you mean tool:team_check")
  expect(refusal(["tool:question", "!tool:question"])).toContain("cannot be required both on and off")
  const tool = setRequires(memo([]), "item:project:alpha:tool:question", ["tool:team_check"])
  expect("refusal" in tool && tool.refusal).toContain("cannot be sent conditionally")
})

// Held back: on, but its "shown when" does not hold for the agent, so the
// agent does not get it. find({ is: "held-back" }) lists it, sections too,
// and its badges name what it needs.
test("a row or section its shown when keeps from the agent is held back, and find lists it", () => {
  const find = (input: MemoInput, where: string) => query(input, { where, collapse: findCollapse(where) }).rows
  const ids = (input: MemoInput, where: string) => find(input, where).map((row) => row.id)
  const betaChecks = checks.replace(":alpha:", ":beta:")
  const commands = (agent: string) => `section:project:${agent}:${guidanceItemId}:tools-and-rules/commands`

  // alpha has team_check off: its Checks section is held back; beta's is sent.
  const alphaOff = memo([off("alpha", "tool:team_check")])
  const nodes = expandedTree(alphaOff)
  const node = (id: string) => nodes.find((entry) => entry.id === id)
  expect(node(checks)?.badges.heldBack).toBe(true)
  expect(badgeLabels(node(checks)!)).toContain("held back (needs tool:team_check on)")
  expect(node(betaChecks)?.badges.heldBack).toBeUndefined()
  expect(ids(alphaOff, 'is:"held-back" agent:"alpha"')).toContain(checks)
  expect(ids(alphaOff, 'is:"held-back" agent:"beta"')).not.toContain(betaChecks)
  // A section whose condition holds (question is on) is not held back.
  expect(ids(alphaOff, 'is:"held-back" agent:"alpha"')).not.toContain(questions)
  expect(find(alphaOff, 'is:"held-back" agent:"alpha"').find((row) => row.id === checks)?.badges).toBe("on held back (needs tool:team_check on)")

  // Neither agent has a shell tool: Commands is held back for both, and
  // without agent it is one row that counts the other agent's copy.
  const shared = find(alphaOff, 'is:"held-back"').filter((row) => row.id.endsWith(":tools-and-rules/commands"))
  expect(shared).toHaveLength(1)
  expect(shared[0]?.copies).toBe(1)

  // A section of a row that is off is not held back: the row is off.
  const rowOff = memo([off("alpha", guidanceItemId)])
  expect(ids(rowOff, 'is:"held-back" agent:"alpha"')).not.toContain(commands("alpha"))
  expect(ids(rowOff, 'is:"held-back" agent:"beta"')).toContain(commands("beta"))
  // Nor is a section that is off itself.
  const sectionOff = memo([{ ...off("alpha", guidanceItemId), section: "tools-and-rules/commands" }])
  expect(ids(sectionOff, 'is:"held-back" agent:"alpha"')).not.toContain(commands("alpha"))

  // A whole row is held back by its own condition.
  const whole = `item:project:alpha:${guidanceItemId}`
  const tied = result(setRequires(memo([]), whole, ["!tool:question"]))
  expect(ids(memo(tied.records, tied.rowlinks), 'is:"held-back" agent:"alpha"')).toContain(whole)
  expect(ids(memo(tied.records, tied.rowlinks), 'is:"held-back" agent:"beta"')).not.toContain(`item:project:beta:${guidanceItemId}`)
})
