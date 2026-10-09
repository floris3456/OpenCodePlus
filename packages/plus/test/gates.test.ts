// B43 gate consistency: the production gate paths. One directed endpoint pair
// has one effective type; a nearer pair mask does not erase unrelated inherited
// gates on the same target; section gates evaluate the section address; shipped
// `<!-- requires -->` markers AND in with stored gates; the legacy
// `set({requires})` adapter writes only rowlinks. These exercise the real
// resolution and apply paths, not a reimplementation.
import { expect, test } from "bun:test"
import { resolvedFor, roleUpdates, rowGate, type ApplyInput } from "../src/instructions/apply.js"
import { guidanceContent } from "../src/instructions/guidance.js"
import { resolve, fingerprint, type CustomizationRecord, type Item, type Level } from "../src/instructions/model.js"
import { guidanceItemId } from "../src/instructions/paths.js"
import { chainContext } from "../src/instructions/presets.js"
import { gateAnswer, type RowlinkRecord } from "../src/instructions/rowlinks.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

const roleText = `# Role

## Always
Read the Brief.

## Checks
Run checks with team_check.
`

const items: Item[] = [
  { id: "system:role", kind: "system", group: "none", title: "Role", text: roleText, enabled: true, fingerprint: fingerprint(roleText), agents: ["alpha", "beta"] },
  { id: guidanceItemId, kind: "system", group: "plus", title: "Tools and rules", text: guidanceContent, enabled: true, fingerprint: fingerprint(guidanceContent) },
  { id: "tool:team_check", kind: "tool", group: "plus", title: "team_check", text: "Run a check.", enabled: true, fingerprint: "a" },
  { id: "tool:question", kind: "tool", group: "native", title: "question", text: "Ask.", enabled: true, fingerprint: "b" },
]

const agents = ["alpha", "beta"]
const links = agents.map((agent) => ({ type: "link" as const, level: "project" as Level, agent, preset: { kind: "agent" as const, id: "build" }, updated: UPDATED }))

function scopes(rowlinks: readonly RowlinkRecord[]) {
  return {
    ...chainContext({
      agents: agents.map((id) => ({ id, scope: "project", origin: "user" as const })),
      items,
      links,
      rowlinks,
    }),
    // Both project/alpha and global/alpha exist so an address chain carries a
    // node above its own level (for the inheritance/mask tests).
    global: new Set(agents),
  }
}
function gate(overrides: Partial<RowlinkRecord> & Pick<RowlinkRecord, "item" | "target" | "link">): RowlinkRecord {
  return { type: "rowlink", level: "project", agent: "alpha", section: null, targetSection: null, updated: UPDATED, ...overrides }
}

function off(agent: string, item: string): CustomizationRecord {
  return { type: "customization", level: "project", agent, item, section: null, state: "off", basedOn: "", updated: UPDATED }
}

function applyInput(rowlinks: readonly RowlinkRecord[], records: readonly CustomizationRecord[] = []): ApplyInput {
  return {
    items,
    records,
    splits: [],
    agents: agents.map((id) => ({ id, level: "project" as Level })),
    scopes: scopes(rowlinks),
  }
}

// A whole-row resolution of system:role with the section gate applied, exactly
// as apply builds it.
function roleWhole(agent: string, rowlinks: readonly RowlinkRecord[], records: readonly CustomizationRecord[] = []) {
  const input = applyInput(rowlinks, records)
  const role = items.find((item) => item.id === "system:role")!
  const resolved = resolvedFor(role, { id: agent, level: "project" }, input, rowGate(input, { id: agent, level: "project" }))
  return resolved
}

test("a section gate evaluates the section address during whole-row assembly (not the whole item)", () => {
  // alpha has question off; role/checks is gated on question: it must go.
  const gateOnQuestion = gate({ item: "tool:question", target: "system:role", targetSection: "role/checks", link: "shownWhenOn" })
  const offQuestion = [off("alpha", "tool:question")]
  const resolved = roleWhole("alpha", [gateOnQuestion], offQuestion)
  expect(resolved.assembled).not.toContain("## Checks")
  // beta has question on: it keeps the section.
  expect(roleWhole("beta", [gateOnQuestion]).assembled).toContain("## Checks")
})

test("a nearer pair mask keeps unrelated inherited gates on the same target", () => {
  const globalA = gate({ level: "global", item: "tool:question", target: "system:role", targetSection: "role/checks", link: "shownWhenOn" })
  const globalB = gate({ level: "global", item: "tool:team_check", target: "system:role", targetSection: "role/checks", link: "shownWhenOn" })
  // Project masks only the question pair.
  const maskA = gate({ item: "tool:question", target: "system:role", targetSection: "role/checks", link: "shownWhenOn", enabled: false })
  // alpha has team_check off: the surviving team_check gate drops the section.
  const resolved = roleWhole("alpha", [globalA, globalB, maskA], [off("alpha", "tool:team_check")])
  expect(resolved.assembled).not.toContain("## Checks")
  // The old whole-target rule would have dropped the team_check gate with the
  // masked question pair, sending the section anyway.
})

test("a shipped section marker ANDs in with stored gates and is stripped", () => {
  const role: Item = {
    ...items[0]!,
    text: `# Role\n\n## Checks\n<!-- requires: tool:question -->\nRun checks.\n`,
    fingerprint: fingerprint(`# Role\n\n## Checks\n<!-- requires: tool:question -->\nRun checks.\n`),
  }
  const extra = gate({ item: "tool:team_check", target: "system:role", targetSection: "role/checks", link: "shownWhenOn" })
  const withMarker = {
    items: [role, ...items.slice(1)],
    records: [off("alpha", "tool:question")],
    splits: [],
    agents: agents.map((id) => ({ id, level: "project" as Level })),
    scopes: scopes([extra]),
  } satisfies ApplyInput
  const agent = { id: "alpha", level: "project" as Level }
  const resolved = resolvedFor(role, agent, withMarker, rowGate(withMarker, agent))
  // Marker (question off) fails, stored team_check passes: both must hold.
  expect(resolved.assembled).not.toContain("## Checks")
  expect(resolved.assembled).not.toContain("<!--")
})

test("a gate refuses a section as its primary row rather than using the whole item's state", () => {
  // The link tool's refusal is covered in tools.test; this proves the pure
  // algebra keeps a section primary as a distinct pair (never read as the item).
  const bySection = gate({ item: "system:role", section: "role/checks", target: "tool:question", link: "shownWhenOn" })
  const answer = resolve({
    upstream: items.find((item) => item.id === "system:role")!,
    records: [],
    splits: [],
    scopes: scopes([bySection]),
    address: { level: "project", agent: "alpha", item: "system:role", section: null },
  })
  // The gate names tool:question as its target, not system:role: the whole role
  // row is not gated by it.
  expect(answer.requires).toBeUndefined()
})

test("a team-owned gate resolves for the member address through its team node", () => {
  const team = { level: "project" as Level, team: "crew" }
  const teamGate = gate({ item: "tool:question", target: "system:role", targetSection: "role/checks", link: "shownWhenOn", team })
  const memberScopes = chainContext({
    agents: [{ id: "alpha", scope: "project", origin: "user", team: "crew" }],
    items,
    links,
    rowlinks: [teamGate],
    teams: [{ team: "crew", agents: ["alpha"] }],
  })
  const answer = gateAnswer(
    [teamGate],
    memberScopes,
    { level: "project", agent: "alpha", item: "system:role", section: "role/checks", team, catalogue: "teams" },
  )
  expect(answer?.ids).toEqual(["tool:question"])
  // A plain agent address (no team) does not see the team-owned gate.
  expect(gateAnswer([teamGate], scopes([]), { level: "project", agent: "alpha", item: "system:role", section: "role/checks" })).toBeUndefined()
})

test("gates act for every text kind, not only system rows", () => {
  // A tool description with a section, gated on a row the agent has off.
  const toolText = `Read things.\n\n## Details\nMore.\n`
  const tool: Item = { id: "tool:reader", kind: "tool", group: "native", title: "reader", text: toolText, enabled: true, fingerprint: fingerprint(toolText) }
  const gateOnQuestion = gate({ item: "tool:question", target: "tool:reader", targetSection: "details", link: "shownWhenOn" })
  const input = {
    items: [...items, tool],
    records: [off("alpha", "tool:question")],
    splits: [],
    agents: agents.map((id) => ({ id, level: "project" as Level })),
    scopes: scopes([gateOnQuestion]),
  } satisfies ApplyInput
  const agent = { id: "alpha", level: "project" as Level }
  const resolved = resolvedFor(tool, agent, input, rowGate(input, agent))
  expect(resolved.assembled).not.toContain("## Details")
  expect(resolved.assembled).not.toContain("<!--")
  // beta has question on: it keeps the section.
  const beta = { id: "beta", level: "project" as Level }
  expect(resolvedFor(tool, beta, input, rowGate(input, beta)).assembled).toContain("## Details")
})
