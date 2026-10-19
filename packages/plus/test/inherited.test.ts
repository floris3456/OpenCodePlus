import { expect, test } from "bun:test"
import { fingerprint, type AgentSource, type CustomizationRecord, type Item, type LinkRecord } from "../src/instructions/model.js"
import { buildMemo, storedRecords, type MemoInput } from "../src/instructions/resolve-memo.js"
import { query } from "../src/instructions/query.js"

const OLD = "2026-01-01T00:00:00.000Z"

function item(id: string, text: string, overrides?: Partial<Item>): Item {
  return { id, kind: "tool", group: "native", title: id.split(":").at(-1) ?? id, text, enabled: true, fingerprint: fingerprint(text), ...overrides }
}

function record(overrides: Partial<CustomizationRecord>): CustomizationRecord {
  return { type: "customization", level: "project", agent: "Implementer", item: "tool:bash", section: null, basedOn: fingerprint("run commands"), updated: OLD, ...overrides }
}

const agents: AgentSource[] = [
  { id: "Implementer", scope: "project", origin: "user" },
  { id: "CrewMate", scope: "project", origin: "user" },
  { id: "Helper", scope: "global", origin: "user" },
]

// Implementer and Helper stand for agents made from the Native build preset;
// CrewMate is unlinked, so its rows fall back to off.
const links: LinkRecord[] = [
  { type: "link", level: "project", agent: "Implementer", preset: { kind: "agent", id: "build" }, updated: OLD },
  { type: "link", level: "global", agent: "Helper", preset: { kind: "agent", id: "build" }, updated: OLD },
]

function input(records: readonly CustomizationRecord[]): MemoInput {
  return {
    items: [item("tool:bash", "run commands"), item("tool:sectioned", "# One\n\nfirst\n\n# Two\n\nsecond\n")],
    records,
    agents,
    teams: [{ level: "project", team: "crew", enabled: true, agents: ["CrewMate"] }],
    links,
  }
}

const kept = (records: readonly CustomizationRecord[]) => buildMemo(input(records)).ctx.customizations

test("an agent's text or on/off equal to what its row inherits is no edit", () => {
  // The upstream text, and the on its preset gives.
  expect(kept([record({ text: "run commands" })])).toEqual([])
  expect(kept([record({ state: "on", basedOnState: "on" })])).toEqual([])
  // A real value stays, and only the part equal to the inherited one goes.
  expect(kept([record({ text: "custom" })])).toEqual([record({ text: "custom" })])
  expect(kept([record({ text: "run commands", basedOnText: "run commands", state: "off", basedOnState: "on" })])).toEqual([record({ state: "off", basedOnState: "on" })])
  // A condition is kept with its record.
  expect(kept([record({ text: "run commands", requires: ["tool:bash"] })])).toEqual([record({ requires: ["tool:bash"] })])
  // A section equal to its text above (final newline aside, as reviews compare).
  expect(kept([record({ item: "tool:sectioned", section: "two", text: "# Two\n\nsecond" })])).toEqual([])
  const changed = record({ item: "tool:sectioned", section: "two", text: "# Two\n\nmine\n" })
  expect(kept([changed])).toEqual([changed])
})

test("the row then shows where its value comes from, not an edit", () => {
  const found = query(input([record({ state: "on" }), record({ text: "run commands" })]), { where: "id:item:project:Implementer:tool:bash", fields: ["id", "badges", "from"], withoutAliases: true }).rows
  expect(found).toEqual([{ id: "item:project:Implementer:tool:bash", badges: "on", from: "from preset Build" }])
  expect(query(input([record({ text: "run commands" })]), { where: "is:changed" }).rows).toEqual([])
})

test("a value a more specific level repeats is no edit there", () => {
  const global = record({ level: "global", agent: "Helper", text: "mine" })
  expect(kept([global, record({ agent: "Helper", text: "mine" })])).toEqual([global])
})

test("a value kept for one reader stays for all", () => {
  // CrewMate alone falls back to off, but as a crew member it reads the
  // Teams catalogue's shared row, which is on: its off still matters there.
  const shared = record({ level: "defaults", agent: null, catalogue: "teams", state: "on" })
  const own = record({ agent: "CrewMate", state: "off" })
  expect(kept([shared, own])).toContainEqual(own)
  expect(kept([own])).toEqual([])
})

test("a shared row's on/off stays: each agent below falls back differently", () => {
  const off = record({ level: "defaults", agent: null, state: "off" })
  expect(kept([off])).toEqual([off])
  // Its text and pin fall back to the item's for every agent.
  expect(kept([record({ level: "defaults", agent: null, text: "run commands" })])).toEqual([])
  expect(kept([record({ level: "defaults", agent: null, text: "shared" })])).toHaveLength(1)
})

test("orphans, presets, team-scoped rows and pattern entries are left alone", () => {
  const ghost = record({ agent: "Ghost", text: "run commands" })
  const gone = record({ item: "tool:gone", text: "x" })
  const section = record({ item: "tool:sectioned", section: "nosuch", state: "on" })
  const preset = record({ level: "preset", agent: "build", text: "run commands" })
  const team = record({ agent: "CrewMate", team: { level: "project", team: "crew" }, text: "run commands" })
  const pattern = record({ level: "defaults", agent: "*mate", text: "run commands" })
  for (const left of [ghost, gone, section, preset, team, pattern]) expect(kept([left])).toEqual([left])
})

test("records are stored as the tree reads them", () => {
  const split = { type: "split" as const, level: "project" as const, agent: "Implementer", item: "tool:sectioned", boundaries: [], updated: OLD }
  expect(storedRecords(input([]), [record({ text: "run commands" }), split])).toEqual([split])
})
