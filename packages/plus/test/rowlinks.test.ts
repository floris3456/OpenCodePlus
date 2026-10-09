// Row links (plus-1.2.0 S2a, B9–B12): the pure link algebra the tool and the
// request-time gates read. One stored concept covers a write-time switch
// (`either`/`oneway`) and a read-time gate (`shownWhenOn`/`shownWhenOff`); a
// tombstone masks a pair at its level. These tests use the real helpers and
// the real chain resolution, never a reimplementation.
import { expect, test } from "bun:test"
import type { Address, Scopes } from "../src/instructions/model.js"
import {
  conditionIds,
  effectiveRowlinks,
  gateAnswer,
  gatedConditions,
  linksTouching,
  migrateRequires,
  rowlinkKey,
  rowlinkView,
  sameOwnerView,
  switchedOff,
  switchPartners,
  writeRowlink,
  type RowlinkRecord,
} from "../src/instructions/rowlinks.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

for (const scenario of [
  { name: "nearer switch replaces inherited gate", links: [
    { level: "global", item: "tool:a", link: "shownWhenOn" },
    { level: "project", item: "tool:a", link: "oneway" },
  ], marker: [], ids: [], inspected: [["tool:a", "oneway"]] },
  { name: "stored opposite replaces shipped marker", links: [
    { level: "project", item: "tool:a", link: "shownWhenOff" },
  ], marker: ["tool:a"], ids: ["!tool:a"], inspected: [["tool:a", "shownWhenOff"]] },
  { name: "nearer gate survives inherited barrier", links: [
    { level: "global", item: "tool:s", link: "shownAlways" },
    { level: "project", item: "tool:b", link: "shownWhenOn" },
  ], marker: ["tool:m"], ids: ["tool:b"], inspected: [["tool:b", "shownWhenOn"]] },
  { name: "local barrier hides farther gates and markers", links: [
    { level: "global", item: "tool:a", link: "shownWhenOn" },
    { level: "project", item: "tool:s", link: "shownAlways" },
  ], marker: ["tool:m"], ids: [], inspected: [] },
] as const) {
  test(`gate/inspection consistency: ${scenario.name}`, () => {
    const records = scenario.links.map((entry) => link({ ...entry, target: "tool:s" }))
    const target = address({ item: "tool:s" })
    expect(gateAnswer(records, scopes(), target, scenario.marker)?.ids).toEqual(scenario.ids)
    expect(rowlinkView(records, scopes(), target, target, scenario.marker).map((entry) => [entry.item, entry.type])).toEqual(scenario.inspected.map((entry) => [...entry]))
  })
}

// A two-agent scope set: project/alpha and global/alpha both exist so an
// address's chain carries a node above its own level (for inheritance tests).
function scopes(overrides: Partial<Scopes> = {}): Scopes {
  return {
    global: new Set(["alpha"]),
    defaults: new Set<string>(),
    ...overrides,
  }
}

function link(
  overrides: Partial<RowlinkRecord> & Pick<RowlinkRecord, "item" | "target" | "link">,
): RowlinkRecord {
  return {
    type: "rowlink",
    level: "project",
    agent: "alpha",
    section: null,
    targetSection: null,
    updated: UPDATED,
    ...overrides,
  }
}

function address(overrides: Partial<Address> = {}): Address {
  return { level: "project", agent: "alpha", item: "tool:a", section: null, ...overrides }
}

test("effectiveRowlinks keeps the nearest level's record and masks a tombstone", () => {
  const scopesHere = scopes()
  const own = link({ item: "tool:a", target: "tool:b", link: "either" })
  // A tombstone at the same level as the live link replaces it; a live link
  // at a lower level is shadowed by a tombstone at a nearer level.
  const inherited = link({ level: "global", item: "tool:a", target: "tool:c", link: "shownWhenOn" })
  const masked = link({ item: "tool:a", target: "tool:c", link: "shownWhenOn", enabled: false })
  const { live, masked: gone } = effectiveRowlinks([own, inherited, masked], scopesHere, address())
  expect(live.map((record) => rowlinkKey(record))).toEqual([rowlinkKey(own)])
  expect(gone.map((record) => rowlinkKey(record))).toEqual([rowlinkKey(masked)])
})

test("effectiveRowlinks: a live record at this level shadows the level above", () => {
  const above = link({ level: "global", item: "tool:a", target: "tool:b", link: "either" })
  const here = link({ item: "tool:a", target: "tool:b", link: "oneway" })
  const { live } = effectiveRowlinks([above, here], scopes(), address())
  expect(live).toHaveLength(1)
  expect(live[0]?.link).toBe("oneway")
  expect(live[0]?.level).toBe("project")
})

test("sameOwnerView: level, owner, team and catalogue must all match", () => {
  expect(sameOwnerView(address(), address({ item: "tool:b" }))).toBe(true)
  expect(sameOwnerView(address(), address({ level: "global" }))).toBe(false)
  expect(sameOwnerView(address(), address({ agent: "beta" }))).toBe(false)
  expect(sameOwnerView(address(), address({ catalogue: "teams" }))).toBe(false)
})

test("writeRowlink upserts one record per pair at this level and stores a tombstone on enabled:false", () => {
  const first = writeRowlink([], address(), { item: "tool:a", section: null }, { item: "tool:b", section: null }, "either", undefined, UPDATED)
  expect(first).toEqual([link({ item: "tool:a", target: "tool:b", link: "either" })])
  const masked = writeRowlink(first, address(), { item: "tool:a", section: null }, { item: "tool:b", section: null }, "either", false, UPDATED)
  expect(masked).toHaveLength(1)
  expect(masked[0]?.enabled).toBe(false)
  // A different pair is added, not replacing the first.
  const both = writeRowlink(masked, address(), { item: "tool:a", section: null }, { item: "tool:c", section: null }, "oneway", undefined, UPDATED)
  expect(both).toHaveLength(2)
})

test("switchedOff fires one hop, symmetric for either and primary-only for oneway", () => {
  const either = link({ item: "tool:a", target: "tool:b", link: "either" })
  const oneway = link({ item: "tool:c", target: "tool:d", link: "oneway" })
  const links = [either, oneway]
  // Toggling either end of `either` turns the other off.
  expect(switchedOff(links, scopes(), address(), { item: "tool:a", section: null })).toEqual([{ item: "tool:b", section: null }])
  expect(switchedOff(links, scopes(), address(), { item: "tool:b", section: null })).toEqual([{ item: "tool:a", section: null }])
  // `oneway` fires only from its primary.
  expect(switchedOff(links, scopes(), address(), { item: "tool:c", section: null })).toEqual([{ item: "tool:d", section: null }])
  expect(switchedOff(links, scopes(), address(), { item: "tool:d", section: null })).toEqual([])
  // No cascade: turning the switched-off target on fires nothing.
  expect(switchedOff([either], scopes(), address(), { item: "tool:b", section: null })).toEqual([{ item: "tool:a", section: null }])
})

test("switchPartners reports the effective partner in both directions", () => {
  const either = link({ item: "tool:a", target: "tool:b", link: "either" })
  const oneway = link({ item: "tool:c", target: "tool:d", link: "oneway" })
  expect(switchPartners([either, oneway], scopes(), address(), { item: "tool:a", section: null }).map((p) => p.endpoint)).toEqual([
    { item: "tool:b", section: null },
  ])
  expect(switchPartners([either, oneway], scopes(), address(), { item: "tool:b", section: null }).map((p) => p.endpoint)).toEqual([
    { item: "tool:a", section: null },
  ])
  // oneway's target is not a partner in the reverse direction.
  expect(switchPartners([either, oneway], scopes(), address(), { item: "tool:d", section: null })).toEqual([])
})

test("linksTouching and rowlinkView report outgoing and incoming effective links", () => {
  const outgoing = link({ item: "tool:a", target: "tool:b", link: "either" })
  const incoming = link({ item: "tool:c", target: "tool:a", link: "shownWhenOn" })
  const touching = linksTouching([outgoing, incoming], scopes(), address(), { item: "tool:a", section: null })
  expect(touching.map(({ direction, link }) => [direction, link.target])).toEqual([
    ["outgoing", "tool:b"],
    ["incoming", "tool:a"],
  ])
  const view = rowlinkView([outgoing, incoming], scopes(), address(), { item: "tool:a", section: null })
  expect(view.map(({ direction, type, enabled }) => ({ direction, type, enabled }))).toEqual([
    { direction: "outgoing", type: "either", enabled: true },
    { direction: "incoming", type: "shownWhenOn", enabled: true },
  ])
})

test("gatedConditions reads the nearest level's gate list, tombstone means always", () => {
  const on = link({ item: "tool:x", target: "system:s", link: "shownWhenOn" })
  const off = link({ item: "tool:y", target: "system:s", link: "shownWhenOff" })
  const gate = gatedConditions([on, off], scopes(), address({ item: "system:s" }))
  expect(gate?.ids).toEqual(["tool:x", "!tool:y"])
  expect(gate?.here).toBe(true)
  // A tombstone at this level means "always" and replaces the upstream gate.
  const upstreamOn = link({ level: "global", item: "tool:x", target: "system:s", link: "shownWhenOn" })
  const mask = link({ item: "tool:x", target: "system:s", link: "shownWhenOn", enabled: false })
  const masked = gatedConditions([upstreamOn, mask], scopes(), address({ item: "system:s" }))
  expect(masked?.ids).toEqual([])
  // No gate link at all: the caller reads the text's own marker.
  expect(gatedConditions([link({ item: "tool:x", target: "tool:z", link: "either" })], scopes(), address({ item: "system:s" }))).toBeUndefined()
})

test("gateAnswer: a nearer pair mask keeps unrelated inherited gates on the same target", () => {
  // global: A on and B on both gate system:s. project masks only the A pair.
  const globalA = link({ level: "global", item: "tool:a", target: "system:s", link: "shownWhenOn" })
  const globalB = link({ level: "global", item: "tool:b", target: "system:s", link: "shownWhenOn" })
  const maskA = link({ item: "tool:a", target: "system:s", link: "shownWhenOn", enabled: false })
  const answer = gateAnswer([globalA, globalB, maskA], scopes(), address({ item: "system:s" }))
  // A is masked at project; B stays live from global. The old whole-target rule
  // would have dropped B with A.
  expect(answer?.ids).toEqual(["tool:b"])
  expect(answer?.pairs.map((pair) => pair.item)).toEqual(["tool:b"])
})

test("gateAnswer: shipped markers AND in with stored gates unless a pair masks them", () => {
  const stored = link({ item: "tool:x", target: "system:s", link: "shownWhenOn" })
  const combined = gateAnswer([stored], scopes(), address({ item: "system:s" }), ["tool:marker"])
  expect(combined?.ids).toEqual(["tool:x", "tool:marker"])
  expect(combined?.pairs.map((pair) => [pair.item, pair.shipped])).toEqual([
    ["tool:x", false],
    ["tool:marker", true],
  ])
  // A stored tombstone for the marker pair masks just that shipped pair.
  const mask = link({ item: "tool:marker", target: "system:s", link: "shownWhenOn", enabled: false })
  const masked = gateAnswer([stored, mask], scopes(), address({ item: "system:s" }), ["tool:marker"])
  expect(masked?.ids).toEqual(["tool:x"])
})

test("gateAnswer: a replacement barrier defines the whole list at its level", () => {
  const barrier = link({ item: "system:s", section: null, target: "system:s", targetSection: null, link: "shownAlways" })
  const local = link({ item: "tool:x", target: "system:s", link: "shownWhenOn" })
  const upstream = link({ level: "global", item: "tool:y", target: "system:s", link: "shownWhenOn" })
  const answer = gateAnswer([barrier, local, upstream], scopes(), address({ item: "system:s" }), ["tool:marker"])
  expect(answer?.barrier).toBe(true)
  expect(answer?.ids).toEqual(["tool:x"])
})

test("conditionIds: shownAlways (the migrated empty list) means no condition", () => {
  expect(conditionIds([link({ item: "tool:x", target: "system:s", link: "shownAlways" })])).toEqual([])
  expect(conditionIds([link({ item: "tool:x", target: "system:s", link: "shownWhenOn" })])).toEqual(["tool:x"])
})

test("migrateRequires turns a requires list into gates and is idempotent", () => {
  const records = [
    {
      type: "customization" as const,
      level: "project" as const,
      agent: "alpha",
      item: "system:tools-and-rules",
      section: "tools-and-rules/questions",
      requires: ["tool:question", "!perm:shell:git-push"],
      updated: UPDATED,
    },
  ]
  const once = migrateRequires(records)
  expect(once.migrated).toBe(true)
  expect(once.records[0]).not.toHaveProperty("requires")
  expect(once.rowlinks.map((record) => [record.item, record.target, record.link])).toEqual([
    ["system:tools-and-rules", "system:tools-and-rules", "shownAlways"],
    ["tool:question", "system:tools-and-rules", "shownWhenOn"],
    ["perm:shell:git-push", "system:tools-and-rules", "shownWhenOff"],
  ])
  // The first entry is the target-local replacement barrier: same endpoints on
  // both sides, marking the whole list local so unrelated inherited pairs do
  // not leak in.
  expect(once.rowlinks[0]).toMatchObject({ section: "tools-and-rules/questions", targetSection: "tools-and-rules/questions" })
  // An empty list is `shownAlways`; a store with no requires field is a no-op.
  const empty = migrateRequires([{ type: "customization" as const, level: "project" as const, agent: "alpha", item: "x", section: null, requires: [], updated: UPDATED }])
  expect(empty.rowlinks[0]?.link).toBe("shownAlways")
  const noop = migrateRequires([{ type: "customization" as const, level: "project" as const, agent: "alpha", item: "x", section: null, updated: UPDATED }])
  expect(noop.migrated).toBe(false)
  expect(noop.rowlinks).toEqual([])
  // Idempotent: migrating the already-migrated record yields no new rowlinks.
  expect(migrateRequires(once.records).migrated).toBe(false)
})
