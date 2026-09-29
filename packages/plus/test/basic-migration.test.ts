// Behavioural equivalence for the Basic migration: an agent linked to a
// retired Plus agent preset (build-seat, reviewer, …) must resolve exactly the
// same rows after the load-time migration and the new self-contained member
// presets. The expected rows in test/fixtures/basic-migration-equivalence.json
// were generated once by the same fixture against the pre-Basic catalogue
// (before this change); this test rebuilds the chain with the migrated links
// and compares every tool, perm and role row.
import { expect, test } from "bun:test"
import { fingerprint, resolve, type Item, type LinkRecord } from "../src/instructions/model.js"
import { migrateRemovedPresets } from "../src/instructions/store.js"
import { presetInput, type TeamMember } from "./teams/preset-table.js"

interface Snapshot {
  readonly note: string
  readonly agents: Record<string, { readonly role: string; readonly items: Record<string, { readonly state: string; readonly text: string }> }>
}

const fixture: Snapshot = await Bun.file(new URL("./fixtures/basic-migration-equivalence.json", import.meta.url)).json()

// The same fixture members the snapshot was generated from, still naming the
// retired agent presets (the shape a real store held).
const retiredMembers: TeamMember[] = [
  { id: "deepseek-worker", team: "crew", preset: { kind: "agent", id: "build-seat" } },
  { id: "astra-reviewer", team: "crew", preset: { kind: "agent", id: "reviewer" } },
  { id: "peer-planner", team: "crew", preset: { kind: "agent", id: "planner" } },
  { id: "peer-unlinked", team: "crew" },
]

const migratedInput = (() => {
  const before = presetInput({ members: retiredMembers })
  const migrated = migrateRemovedPresets(before.scopes.links ?? [])
  expect(migrated.migrated).toBe(true)
  const links = migrated.records.filter((record): record is LinkRecord => record.type === "link")
  // presetInput writes one link per member that has a preset.
  const members = retiredMembers.map((member) => {
    const link = links.find((record) => record.agent === member.id)
    return { ...member, ...(link === undefined ? {} : { preset: link.preset }) }
  })
  return { before, links, members, after: presetInput({ members }) }
})()

function resolvedFor(agentId: string): { role: string; items: Record<string, { state: string; text: string }> } {
  const input = migratedInput.after
  const agent = input.agents.find((entry) => entry.id === agentId)
  if (agent === undefined) throw new Error(`no member ${agentId}`)
  const items: Record<string, { state: string; text: string }> = {}
  for (const item of input.items) {
    if (item.agents !== undefined && !item.agents.includes(agentId)) continue
    const resolved = resolve({
      upstream: item,
      records: input.records,
      splits: input.splits,
      scopes: input.scopes,
      address: { level: agent.level, agent: agentId, item: item.id, section: null, ...(agent.team === undefined ? {} : { team: agent.team }) },
    })
    items[item.id] = { state: resolved.enabled ? "on" : "off", text: resolved.text }
  }
  const role: Item = {
    id: "system:role",
    kind: "system",
    group: "none",
    title: "Role/persona",
    text: "",
    enabled: true,
    fingerprint: fingerprint(""),
    agents: [agentId],
  }
  const resolvedRole = resolve({
    upstream: role,
    records: input.records,
    splits: input.splits,
    scopes: input.scopes,
    address: { level: agent.level, agent: agentId, item: "system:role", section: null, ...(agent.team === undefined ? {} : { team: agent.team }) },
  })
  return { role: resolvedRole.text, items }
}

test("the fixture is the pre-migration snapshot this test compares against", () => {
  expect(fixture.note).toContain("pre-Basic catalogue")
  expect(Object.keys(fixture.agents)).toEqual(["deepseek-worker", "astra-reviewer"])
  expect(Object.keys(fixture.agents["deepseek-worker"]?.items ?? {}).length).toBeGreaterThan(200)
  expect(fixture.agents["deepseek-worker"]?.role).toContain("team_get_context")
})

test("the migrated links name the Basic member preset of the retired role", () => {
  expect(migratedInput.links.map((link) => [link.agent, link.preset])).toEqual([
    ["deepseek-worker", { kind: "member", team: "basic", id: "build-seat" }],
    ["astra-reviewer", { kind: "member", team: "basic", id: "reviewer" }],
    ["peer-planner", { kind: "member", team: "basic", id: "planner" }],
  ])
})

test("an agent linked to the retired build-seat preset resolves every row exactly as before", () => {
  const now = resolvedFor("deepseek-worker")
  const before = fixture.agents["deepseek-worker"]
  if (before === undefined) throw new Error("missing fixture agent")
  expect(now).toEqual(before)
  // The provenance names the member preset, never a hidden agent preset.
  const delegate = resolve({
    upstream: migratedInput.after.items.find((item) => item.id === "perm:team_delegate:to.peer-unlinked") as Item,
    records: [],
    splits: [],
    scopes: migratedInput.after.scopes,
    address: { level: "project", agent: "deepseek-worker", item: "perm:team_delegate:to.peer-unlinked", section: null, team: { level: "project", team: "crew" } },
  })
  expect(delegate.from).toEqual({ kind: "preset", id: "build-seat", team: "basic", shipped: true })
})

test("an agent linked to the retired reviewer preset resolves every row exactly as before", () => {
  const now = resolvedFor("astra-reviewer")
  const before = fixture.agents["astra-reviewer"]
  if (before === undefined) throw new Error("missing fixture agent")
  expect(now).toEqual(before)
})

test("the fixture's delegate rows show the old behaviour: the build seat opens every teammate, the reviewer none", () => {
  const opened = (agent: string) =>
    Object.entries(fixture.agents[agent]?.items ?? {})
      .filter(([id, value]) => id.startsWith("perm:team_delegate:to.") && value.state === "on")
      .map(([id]) => id.slice("perm:team_delegate:to.".length))
      .toSorted()
  expect(opened("deepseek-worker")).toEqual(["astra-reviewer", "peer-planner", "peer-unlinked"])
  expect(opened("astra-reviewer")).toEqual([])
})