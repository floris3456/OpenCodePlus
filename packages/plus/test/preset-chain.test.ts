import { expect, test } from "bun:test"
import {
  fingerprint,
  presetKey,
  resolutionChain,
  resolve,
  resolveActiveModel,
  scopesOf,
  type Address,
  type ChainContext,
  type ChainNode,
  type CustomizationRecord,
  type EntryRecord,
  type Item,
  type LinkRecord,
  type ModelRefLike,
  type PresetCatalog,
  type PresetRef,
  type ShippedValue,
  type TeamRef,
} from "../src/instructions/model.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

function item(overrides?: Partial<Item>): Item {
  const text = overrides?.text ?? "run commands"
  return {
    id: "tool:bash",
    kind: "tool",
    group: "native",
    title: "bash",
    text,
    enabled: true,
    fingerprint: fingerprint(text),
    ...overrides,
  }
}

function record(
  scope: { level: CustomizationRecord["level"]; agent: string | null; team?: TeamRef },
  fields: Partial<CustomizationRecord>,
): CustomizationRecord {
  return {
    type: "customization",
    level: scope.level,
    agent: scope.agent,
    ...(scope.team === undefined ? {} : { team: scope.team }),
    item: "tool:bash",
    section: null,
    basedOn: fingerprint("run commands"),
    updated: UPDATED,
    ...fields,
  }
}

function link(
  owner: { level: LinkRecord["level"]; agent: string | null; team?: TeamRef },
  preset: PresetRef,
): LinkRecord {
  return {
    type: "link",
    level: owner.level,
    agent: owner.agent,
    ...(owner.team === undefined ? {} : { team: owner.team }),
    preset,
    updated: UPDATED,
  }
}

function entry(name: string, team?: string): EntryRecord {
  return {
    type: "entry",
    level: "defaults",
    catalogue: team === undefined ? "agents" : "teams",
    ...(team === undefined ? {} : { team }),
    name,
    updated: UPDATED,
  }
}

const agentPreset = (id: string): PresetRef => ({ kind: "agent", id })

// Shipped content keyed by preset, then item id; whole items only.
function catalog(
  shipped: Record<string, Record<string, ShippedValue>> = {},
  models: Record<string, ModelRefLike> = {},
  links: readonly LinkRecord[] = [],
): PresetCatalog {
  return {
    presets: [
      { ref: agentPreset("build"), origin: "native" },
      { ref: agentPreset("orchestrator"), origin: "plus" },
      { ref: agentPreset("scout"), origin: "plus" },
      { ref: { kind: "member", team: "crew", id: "scout" }, origin: "plus" },
      { ref: agentPreset("mine"), origin: "user" },
    ],
    links,
    shipped: (preset, id, section) => (section === null ? shipped[presetKey(preset)]?.[id] : undefined),
    model: (preset) => models[presetKey(preset)],
  }
}

function context(overrides?: Partial<ChainContext>): ChainContext {
  return {
    global: new Set<string>(),
    defaults: new Set<string>(),
    native: new Set(["build", "explore"]),
    links: [],
    entries: [],
    presets: catalog(),
    ...overrides,
  }
}

function address(overrides?: Partial<Address>): Address {
  return { level: "project", agent: "opus-orchestrator", item: "tool:bash", section: null, ...overrides }
}

// One readable token per node: `shipped:` marks virtual preset content.
function names(chain: readonly ChainNode[]): string[] {
  return chain.map(
    (node) =>
      `${node.shipped === undefined ? "" : "shipped:"}${node.level}/${node.agent ?? "null"}${node.team === undefined ? "" : `@${node.team.team}`}`,
  )
}

test("chain: own nodes, the linked preset, exact then pattern entries, then Defaults for every agent", () => {
  const ctx = context({
    global: new Set(["opus-orchestrator"]),
    links: [link({ level: "global", agent: "opus-orchestrator" }, agentPreset("orchestrator"))],
    entries: [entry("opus-*"), entry("*orchestrator*"), entry("opus-orchestrator"), entry("planner")],
  })
  expect(names(resolutionChain(address(), ctx))).toEqual([
    "project/opus-orchestrator",
    "global/opus-orchestrator",
    "preset/orchestrator",
    "shipped:preset/orchestrator",
    "defaults/opus-orchestrator",
    "defaults/*orchestrator*",
    "defaults/opus-*",
    "defaults/null",
  ])
  expect(names(resolutionChain(address({ level: "global" }), ctx))).toEqual([
    "global/opus-orchestrator",
    "preset/orchestrator",
    "shipped:preset/orchestrator",
    "defaults/opus-orchestrator",
    "defaults/*orchestrator*",
    "defaults/opus-*",
    "defaults/null",
  ])
})

test("chain: other addresses follow §3.1", () => {
  const ctx = context({
    defaults: new Set(["build"]),
    entries: [entry("*orchestrator*"), entry("*")],
    links: [link({ level: "defaults", agent: "*orchestrator*" }, agentPreset("orchestrator"))],
  })
  // A Defaults entry reads its own link, never the other entries.
  expect(names(resolutionChain(address({ level: "defaults", agent: "*orchestrator*" }), ctx))).toEqual([
    "defaults/*orchestrator*",
    "preset/orchestrator",
    "shipped:preset/orchestrator",
    "defaults/null",
  ])
  expect(names(resolutionChain(address({ level: "defaults", agent: "build" }), ctx))).toEqual([
    "defaults/build",
    "defaults/null",
  ])
  expect(names(resolutionChain(address({ level: "preset", agent: "mine" }), ctx))).toEqual([
    "preset/mine",
    "defaults/null",
  ])
  expect(names(resolutionChain(address({ level: "defaults", agent: null }), ctx))).toEqual(["defaults/null"])
  // A native agent's own Defaults node is its exact entry.
  expect(names(resolutionChain(address({ agent: "build" }), ctx))).toEqual([
    "project/build",
    "defaults/build",
    "defaults/*",
    "defaults/null",
  ])
  // An entry's link is expanded right after the entry.
  expect(names(resolutionChain(address({ agent: "my-orchestrator" }), ctx))).toEqual([
    "project/my-orchestrator",
    "defaults/*orchestrator*",
    "preset/orchestrator",
    "shipped:preset/orchestrator",
    "defaults/*",
    "defaults/null",
  ])
})

test("a bare { global, defaults } keeps the pre-preset chain", () => {
  const scopes = { global: new Set(["alpha"]), defaults: new Set(["alpha"]) }
  expect(names(resolutionChain(address({ agent: "alpha" }), scopes))).toEqual([
    "project/alpha",
    "global/alpha",
    "defaults/alpha",
    "defaults/null",
  ])
  const team = { level: "project" as const, team: "crew" }
  expect(names(resolutionChain(address({ agent: "alpha", team }), scopes))).toEqual([
    "project/alpha@crew",
    "project/alpha",
    "global/alpha",
    "defaults/alpha",
    "defaults/null",
  ])
})

test("the preset wins over Defaults entries and the agent's own edit wins over both", () => {
  const ctx = context({
    links: [link({ level: "project", agent: "opus-orchestrator" }, agentPreset("mine"))],
    entries: [entry("opus-orchestrator"), entry("*")],
  })
  const records = [
    record({ level: "defaults", agent: "opus-orchestrator" }, { text: "exact entry", state: "off" }),
    record({ level: "defaults", agent: "*" }, { text: "every name", state: "off" }),
    record({ level: "preset", agent: "mine" }, { text: "preset", state: "on" }),
  ]
  const resolved = resolve({ upstream: item(), records, splits: [], scopes: ctx, address: address() })
  expect(resolved.text).toBe("preset")
  expect(resolved.enabled).toBe(true)
  expect(resolved.source).toBe("preset")
  expect(resolved.from).toEqual({ kind: "preset", id: "mine", shipped: false })
  const own = [...records, record({ level: "project", agent: "opus-orchestrator" }, { text: "mine", state: "off" })]
  const edited = resolve({ upstream: item(), records: own, splits: [], scopes: ctx, address: address() })
  expect(edited.text).toBe("mine")
  expect(edited.enabled).toBe(false)
  expect(edited.from).toEqual({ kind: "level", level: "project" })
  // Without the preset the exact entry answers, then the pattern.
  const unlinked = context({ entries: ctx.entries })
  const byEntry = resolve({ upstream: item(), records, splits: [], scopes: unlinked, address: address() })
  expect(byEntry.text).toBe("exact entry")
  expect(byEntry.from).toEqual({ kind: "default", name: "opus-orchestrator" })
  const byPattern = resolve({ upstream: item(), records: records.slice(1), splits: [], scopes: unlinked, address: address() })
  expect(byPattern.textFrom).toEqual({ kind: "default", name: "*" })
})

test("each setting falls through independently to the next node that sets it", () => {
  const ctx = context({
    links: [link({ level: "project", agent: "opus-orchestrator" }, agentPreset("mine"))],
    entries: [entry("*orchestrator*")],
  })
  const records = [
    record({ level: "preset", agent: "mine" }, { text: "preset text" }),
    record({ level: "defaults", agent: "*orchestrator*" }, { state: "on" }),
    record({ level: "defaults", agent: null }, { pin: true }),
  ]
  const resolved = resolve({ upstream: item(), records, splits: [], scopes: ctx, address: address() })
  expect(resolved.text).toBe("preset text")
  expect(resolved.textFrom).toEqual({ kind: "preset", id: "mine", shipped: false })
  expect(resolved.enabled).toBe(true)
  expect(resolved.from).toEqual({ kind: "default", name: "*orchestrator*" })
  expect(resolved.pinned).toBe(true)
  expect(resolved.pinFrom).toEqual({ kind: "defaults-everyone" })
})

test("the nearest link wins: a project link beats the global link", () => {
  const ctx = context({
    global: new Set(["opus-orchestrator"]),
    links: [
      link({ level: "global", agent: "opus-orchestrator" }, agentPreset("orchestrator")),
      link({ level: "project", agent: "opus-orchestrator" }, agentPreset("mine")),
    ],
  })
  expect(names(resolutionChain(address(), ctx))).toEqual([
    "project/opus-orchestrator",
    "global/opus-orchestrator",
    "preset/mine",
    "defaults/null",
  ])
  // At Global only the global link is in reach.
  expect(names(resolutionChain(address({ level: "global" }), ctx))).toEqual([
    "global/opus-orchestrator",
    "preset/orchestrator",
    "shipped:preset/orchestrator",
    "defaults/null",
  ])
})

// The tree addresses a member without its team (Teams catalogue); apply
// addresses it with its team. Both pick the nearest link among the member's
// own nodes, the team-scoped node first: an unscoped Global link of the same
// id never beats the member's team-scoped Project link.
test("a member's link: the team-less tree address and the team-scoped runtime address pick the same link", () => {
  const crew: TeamRef = { level: "project", team: "crew" }
  const ctx = context({
    global: new Set(["ocp-bob"]),
    links: [
      link({ level: "global", agent: "ocp-bob" }, agentPreset("scout")),
      link({ level: "project", agent: "ocp-bob", team: crew }, agentPreset("orchestrator")),
    ],
    memberTeams: new Map([["ocp-bob", ["crew"]]]),
    presets: catalog({
      "agent:orchestrator": { "tool:bash": { state: "on" } },
      "agent:scout": { "tool:bash": { state: "off" } },
    }),
  })
  const runtime = address({ agent: "ocp-bob", team: crew })
  const shown = address({ agent: "ocp-bob", catalogue: "teams" })
  expect(names(resolutionChain(runtime, ctx))).toEqual([
    "project/ocp-bob@crew",
    "project/ocp-bob",
    "global/ocp-bob",
    "preset/orchestrator",
    "shipped:preset/orchestrator",
    "defaults/null",
  ])
  expect(names(resolutionChain(shown, ctx))).toEqual([
    "project/ocp-bob",
    "global/ocp-bob",
    "preset/orchestrator",
    "shipped:preset/orchestrator",
    "defaults/null",
  ])
  const answer = (at: Address) => {
    const resolved = resolve({ upstream: item(), records: [], splits: [], scopes: ctx, address: at })
    return { enabled: resolved.enabled, from: resolved.from }
  }
  expect(answer(shown)).toEqual(answer(runtime))
  expect(answer(runtime)).toEqual({ enabled: true, from: { kind: "preset", id: "orchestrator", shipped: true } })
  // Without a team-scoped link both fall through to the Global link.
  const unscoped = context({ ...ctx, links: [link({ level: "global", agent: "ocp-bob" }, agentPreset("scout"))] })
  const off = (at: Address) => resolve({ upstream: item(), records: [], splits: [], scopes: unscoped, address: at }).from
  expect(off(shown)).toEqual(off(runtime))
  expect(off(runtime)).toEqual({ kind: "preset", id: "scout", shipped: true })
})

test("a preset created from another preset expands through it; cycles are cut", () => {
  const chained = context({
    links: [
      link({ level: "project", agent: "opus-orchestrator" }, agentPreset("mine")),
      link({ level: "preset", agent: "mine" }, agentPreset("orchestrator")),
    ],
  })
  expect(names(resolutionChain(address(), chained))).toEqual([
    "project/opus-orchestrator",
    "preset/mine",
    "preset/orchestrator",
    "shipped:preset/orchestrator",
    "defaults/null",
  ])
  const cyclic = context({
    links: [
      link({ level: "project", agent: "opus-orchestrator" }, agentPreset("a")),
      link({ level: "preset", agent: "a" }, agentPreset("b")),
      link({ level: "preset", agent: "b" }, agentPreset("a")),
    ],
    entries: [entry("*")],
  })
  const chain = names(resolutionChain(address(), cyclic))
  expect(chain).toEqual(["project/opus-orchestrator", "preset/a", "preset/b", "defaults/*", "defaults/null"])
  // A preset reached again through an entry's link is not repeated.
  const again = context({
    links: [
      link({ level: "project", agent: "opus-orchestrator" }, agentPreset("mine")),
      link({ level: "defaults", agent: "*" }, agentPreset("mine")),
    ],
    entries: [entry("*")],
  })
  expect(names(resolutionChain(address(), again))).toEqual([
    "project/opus-orchestrator",
    "preset/mine",
    "defaults/*",
    "defaults/null",
  ])
})

test("a member preset never falls through to the stand-alone agent preset of the same name", () => {
  const crew = { level: "preset" as const, team: "crew" }
  const records = [record({ level: "preset", agent: "scout" }, { text: "agent preset", state: "on" })]
  const member = address({ level: "preset", agent: "scout", team: crew })
  const unlinked = context()
  expect(names(resolutionChain(member, unlinked))).toEqual([
    "preset/scout@crew",
    "shipped:preset/scout@crew",
    "defaults/null",
  ])
  const resolved = resolve({ upstream: item(), records, splits: [], scopes: unlinked, address: member })
  expect(resolved.text).toBe("run commands")
  expect(resolved.enabled).toBe(false)
  expect(resolved.from).toEqual({ kind: "off" })
  // Only an explicit link (here: shipped with the Plus team) reaches it.
  const linked = context({
    presets: catalog({}, {}, [link({ level: "preset", agent: "scout", team: crew }, agentPreset("scout"))]),
  })
  expect(names(resolutionChain(member, linked))).toEqual([
    "preset/scout@crew",
    "shipped:preset/scout@crew",
    "preset/scout",
    "shipped:preset/scout",
    "defaults/null",
  ])
  expect(resolve({ upstream: item(), records, splits: [], scopes: linked, address: member }).text).toBe("agent preset")
})

test("Teams entries match the team pattern and the member pattern, most specific first", () => {
  const ctx = context({
    entries: [
      entry("sc*", "cr*"),
      entry("scout", "*"),
      entry("*", "other"),
      entry("scout"),
      entry("*", "crew"),
    ],
    memberTeams: new Map([["scout", ["crew"]]]),
  })
  // A member addressed by id in the Teams catalogue: its teams come from the context.
  expect(names(resolutionChain(address({ agent: "scout", catalogue: "teams" }), ctx))).toEqual([
    "project/scout",
    "defaults/scout@*",
    "defaults/*@crew",
    "defaults/sc*@cr*",
    "defaults/null",
  ])
  // A team-scoped address matches its own team's name.
  const team = { level: "project" as const, team: "other" }
  expect(names(resolutionChain(address({ agent: "scout", team }), ctx))).toEqual([
    "project/scout@other",
    "project/scout",
    "defaults/scout@*",
    "defaults/*@other",
    "defaults/null",
  ])
  // The stand-alone agent reads Agents entries only.
  expect(names(resolutionChain(address({ agent: "scout" }), ctx))).toEqual([
    "project/scout",
    "defaults/scout",
    "defaults/null",
  ])
  // A Teams entry itself never reads the Agents entry of its member name.
  expect(
    names(resolutionChain(address({ level: "defaults", agent: "scout", team: { level: "defaults", team: "*" } }), ctx)),
  ).toEqual(["defaults/scout@*", "defaults/null"])
  const records = [record({ level: "defaults", agent: "*", team: { level: "defaults", team: "crew" } }, { state: "on" })]
  const resolved = resolve({
    upstream: item(),
    records,
    splits: [],
    scopes: ctx,
    address: address({ agent: "scout", catalogue: "teams" }),
  })
  expect(resolved.enabled).toBe(true)
  expect(resolved.from).toEqual({ kind: "default", name: "*", team: "crew" })
})

test("fallback: a user agent is off, a native agent and an owned item read upstream", () => {
  const ctx = context()
  const user = resolve({ upstream: item(), records: [], splits: [], scopes: ctx, address: address({ agent: "alice" }) })
  expect(user.enabled).toBe(false)
  expect(user.from).toEqual({ kind: "off" })
  expect(user.source).toBe("upstream")
  const native = resolve({ upstream: item(), records: [], splits: [], scopes: ctx, address: address({ agent: "build" }) })
  expect(native.enabled).toBe(true)
  expect(native.from).toEqual({ kind: "native" })
  const role = item({ id: "system:role", kind: "system", text: "You are alice.", agents: ["alice"] })
  const owned = resolve({
    upstream: role,
    records: [],
    splits: [],
    scopes: ctx,
    address: address({ agent: "alice", item: "system:role" }),
  })
  expect(owned.enabled).toBe(true)
  expect(owned.from).toEqual({ kind: "upstream" })
  // Upstream off stays off for a native agent: the fallback is the item's own state.
  const disabled = resolve({
    upstream: item({ enabled: false }),
    records: [],
    splits: [],
    scopes: ctx,
    address: address({ agent: "build" }),
  })
  expect(disabled.enabled).toBe(false)
})

test("fallback: only the state goes off; a limit row keeps its upstream text", () => {
  const limit = item({ id: "perm:team_delegate:limits.paths", kind: "perm", text: "5", permKind: "limit" })
  const resolved = resolve({
    upstream: limit,
    records: [],
    splits: [],
    scopes: context(),
    address: address({ agent: "alice", item: limit.id }),
  })
  expect(resolved.enabled).toBe(false)
  expect(resolved.text).toBe("5")
  expect(resolved.textFrom).toEqual({ kind: "upstream" })
  expect(resolved.pinFrom).toEqual({ kind: "upstream" })
})

test("fallback: Defaults for every agent and entries are off; a team's Special agent and a Native preset are native", () => {
  const ctx = context({ entries: [entry("*")] })
  const everyone = resolve({
    upstream: item(),
    records: [],
    splits: [],
    scopes: ctx,
    address: address({ level: "defaults", agent: null }),
  })
  expect(everyone.enabled).toBe(false)
  const pattern = resolve({
    upstream: item(),
    records: [],
    splits: [],
    scopes: ctx,
    address: address({ level: "defaults", agent: "*" }),
  })
  expect(pattern.enabled).toBe(false)
  const special = resolve({
    upstream: item(),
    records: [],
    splits: [],
    scopes: ctx,
    address: address({ agent: "explore", team: { level: "project", team: "crew" } }),
  })
  expect(special.enabled).toBe(true)
  expect(special.from).toEqual({ kind: "native" })
  const nativePreset = resolve({
    upstream: item(),
    records: [],
    splits: [],
    scopes: ctx,
    address: address({ level: "preset", agent: "build" }),
  })
  expect(nativePreset.from).toEqual({ kind: "native" })
  expect(nativePreset.enabled).toBe(true)
  const userPreset = resolve({
    upstream: item(),
    records: [],
    splits: [],
    scopes: ctx,
    address: address({ level: "preset", agent: "mine" }),
  })
  expect(userPreset.enabled).toBe(false)
  expect(userPreset.from).toEqual({ kind: "off" })
})

test("a bare { global, defaults } keeps the upstream fallback; scopesOf marks native agents only", () => {
  const legacy = resolve({
    upstream: item(),
    records: [],
    splits: [],
    scopes: { global: new Set<string>(), defaults: new Set<string>() },
    address: address({ agent: "alice" }),
  })
  expect(legacy.enabled).toBe(true)
  expect(legacy.from).toEqual({ kind: "upstream" })
  const scopes = scopesOf([
    { id: "build", scope: "defaults", origin: "native" },
    { id: "explore", scope: "defaults", origin: "special" },
    { id: "planner", scope: "defaults", origin: "plus" },
    { id: "alice", scope: "project", origin: "user" },
  ])
  expect([...(scopes.native ?? [])].toSorted()).toEqual(["build", "explore"])
  expect(resolve({ upstream: item(), records: [], splits: [], scopes, address: address({ agent: "alice" }) }).enabled).toBe(
    false,
  )
  expect(resolve({ upstream: item(), records: [], splits: [], scopes, address: address({ agent: "build" }) }).enabled).toBe(
    true,
  )
})

test("shipped preset content answers through the link, never stored", () => {
  const ctx = context({
    links: [link({ level: "project", agent: "alice" }, agentPreset("orchestrator"))],
    presets: catalog({ "agent:orchestrator": { "tool:bash": { state: "on", text: "shipped text", pin: true } } }),
  })
  const resolved = resolve({ upstream: item(), records: [], splits: [], scopes: ctx, address: address({ agent: "alice" }) })
  expect(resolved.enabled).toBe(true)
  expect(resolved.text).toBe("shipped text")
  expect(resolved.pinned).toBe(true)
  expect(resolved.source).toBe("preset")
  expect(resolved.from).toEqual({ kind: "preset", id: "orchestrator", shipped: true })
  expect(resolved.overriddenHere).toBe(false)
  // The human's edit of the Plus preset wins over its shipped content.
  const edited = resolve({
    upstream: item(),
    records: [record({ level: "preset", agent: "orchestrator" }, { state: "off" })],
    splits: [],
    scopes: ctx,
    address: address({ agent: "alice" }),
  })
  expect(edited.enabled).toBe(false)
  expect(edited.from).toEqual({ kind: "preset", id: "orchestrator", shipped: false })
  expect(edited.text).toBe("shipped text")
})

test("active model walks presets and entries; a shipped preset carries its model", () => {
  const opus = { providerID: "anthropic", modelID: "opus" }
  const ctx = context({
    links: [link({ level: "project", agent: "alice" }, agentPreset("orchestrator"))],
    entries: [entry("ali*")],
    presets: catalog({}, { "agent:orchestrator": opus }),
  })
  const upstream = { providerID: "openai", modelID: "gpt" }
  const active = resolveActiveModel({ models: [], scopes: ctx, level: "project", agent: "alice", upstream })
  expect(active).toEqual({ ...opus, source: "preset", from: { kind: "preset", id: "orchestrator", shipped: true } })
  const byEntry = resolveActiveModel({
    models: [
      {
        type: "model",
        level: "defaults",
        agent: "ali*",
        providerID: "google",
        modelID: "gemini",
        active: true,
        updated: UPDATED,
      },
    ],
    scopes: context({ entries: ctx.entries }),
    level: "project",
    agent: "alice",
    upstream,
  })
  expect(byEntry?.modelID).toBe("gemini")
  expect(byEntry?.from).toEqual({ kind: "default", name: "ali*" })
  const none = resolveActiveModel({ models: [], scopes: context(), level: "project", agent: "alice", upstream })
  expect(none).toEqual({ ...upstream, source: "upstream", from: { kind: "upstream" } })
})
