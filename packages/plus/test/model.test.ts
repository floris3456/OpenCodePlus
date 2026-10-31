import { expect, test } from "bun:test"
import {
  activateModel,
  addModelRecord,
  applies,
  canReset,
  countReview,
  fingerprint,
  merge,
  modelCandidates,
  modelItemId,
  parseModelItemId,
  parsePermItemId,
  permItemId,
  reset,
  resolve,
  resolveActiveModel,
  resolveModelWarming,
  resolveResolution,
  resolveSplit,
  threeWay,
  tombstoneModelRecord,
  upstreamForEdit,
  type Address,
  type ChainInput,
  type CustomizationRecord,
  type Item,
  type ModelRecord,
  type Scopes,
  type SplitRecord,
} from "../src/instructions/model.js"
import { derive } from "../src/instructions/sections.js"
import { expandedTree } from "../src/instructions/tree.js"
import { activateModelRow, toggle } from "../src/instructions/ops.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

function makeItem(overrides?: Partial<Item>): Item {
  const text = overrides?.text ?? "default text"
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

function makeRecord(overrides?: Partial<CustomizationRecord> & { type?: "customization" }): CustomizationRecord {
  return {
    type: "customization",
    level: "project",
    agent: "alpha",
    item: "tool:bash",
    section: null,
    basedOn: fingerprint("default text"),
    updated: UPDATED,
    ...overrides,
  }
}

const scopes: Scopes = { global: new Set(["alpha"]), defaults: new Set(["alpha"]) }

function input(overrides?: Partial<ChainInput>): ChainInput {
  const upstream = overrides?.upstream ?? makeItem()
  return {
    upstream,
    records: [],
    splits: [],
    scopes,
    address: { level: "project", agent: "alpha", item: upstream.id, section: null },
    ...overrides,
  }
}

test("an emptied text and a record without text resolve apart, in either order through the cache", () => {
  const emptied = makeRecord({ text: "", basedOnText: "default text" })
  const { text: _text, basedOnText: _based, ...plain } = emptied
  expect(resolve(input({ records: [emptied] })).text).toBe("")
  expect(resolve(input({ records: [plain] })).text).toBe("default text")
  const later = makeRecord({ updated: "2026-01-02T00:00:00.000Z" })
  expect(resolve(input({ records: [later] })).text).toBe("default text")
  expect(resolve(input({ records: [{ ...later, text: "" }] })).text).toBe("")
})

test("unmodified nodes resolve upstream", () => {
  const resolved = resolve(input())
  expect(resolved.text).toBe("default text")
  expect(resolved.source).toBe("upstream")
  expect(resolved.modified).toBe(false)
  expect(resolved.review).toBe(false)
})

test("project inherits the global override, then the defaults template, then shared", () => {
  const upstream = makeItem({ text: "upstream" })
  const records = [
    makeRecord({ level: "defaults", agent: null, text: "shared" }),
    makeRecord({ level: "defaults", agent: "alpha", text: "template" }),
    makeRecord({ level: "global", agent: "alpha", text: "global" }),
  ]
  expect(resolve(input({ upstream, records })).text).toBe("global")
  const withoutGlobal = records.filter((record) => record.level !== "global")
  expect(resolve(input({ upstream, records: withoutGlobal })).text).toBe("template")
  const sharedOnly = records.filter((record) => record.agent === null)
  expect(resolve(input({ upstream, records: sharedOnly })).text).toBe("shared")
})

test("global skips the global level of other agents and project rows", () => {
  const upstream = makeItem({ text: "upstream" })
  const address: Address = { level: "global", agent: "alpha", item: upstream.id, section: null }
  const records = [
    makeRecord({ level: "defaults", agent: null, text: "shared" }),
    makeRecord({ level: "defaults", agent: "alpha", text: "template" }),
    makeRecord({ level: "project", agent: "alpha", text: "project" }),
    makeRecord({ level: "global", agent: "beta", text: "other" }),
  ]
  expect(resolve(input({ upstream, records, address })).text).toBe("template")
})

test("text and state resolve independently", () => {
  const upstream = makeItem({ text: "upstream", enabled: true })
  const records = [
    makeRecord({ level: "defaults", agent: null, text: "shared text" }),
    makeRecord({ level: "global", agent: "alpha", state: "off" }),
  ]
  const resolved = resolve(input({ upstream, records }))
  expect(resolved.text).toBe("shared text")
  expect(resolved.enabled).toBe(false)
  expect(resolved.source).toBe("global")
})

test("state-only override never marks modified and never raises review", () => {
  const upstream = makeItem({ text: "revised text" })
  const records = [makeRecord({ state: "off" })]
  const resolved = resolve(input({ upstream, records }))
  expect(resolved.text).toBe("revised text")
  expect(resolved.enabled).toBe(false)
  expect(resolved.modified).toBe(false)
  expect(resolved.review).toBe(false)
  expect(resolved.overriddenHere).toBe(true)
})

test("review is text-only: disabled-but-unmodified keeps taking upstream silently", () => {
  const first = makeItem({ text: "v1" })
  const records = [makeRecord({ state: "off", basedOn: first.fingerprint })]
  const second = makeItem({ text: "v2" })
  const resolved = resolve(input({ upstream: second, records }))
  expect(resolved.text).toBe("v2")
  expect(resolved.review).toBe(false)
})

test("review raises when upstream moved past basedOn and acknowledged", () => {
  const upstream = makeItem({ text: "v2" })
  const records = [
    makeRecord({
      text: "mine",
      basedOn: fingerprint("v1"),
      basedOnText: "v1",
      acknowledged: fingerprint("v1"),
    }),
  ]
  expect(resolve(input({ upstream, records })).review).toBe(true)
})

test("review clears when upstream matches basedOn or acknowledged", () => {
  const v2 = makeItem({ text: "v2" })
  const based = [makeRecord({ text: "mine", basedOn: v2.fingerprint, basedOnText: "v1" })]
  expect(resolve(input({ upstream: v2, records: based })).review).toBe(false)
  const v3 = makeItem({ text: "v3" })
  const acked = [makeRecord({ text: "mine", basedOn: fingerprint("v1"), basedOnText: "v1", acknowledged: v3.fingerprint })]
  expect(resolve(input({ upstream: v3, records: acked })).review).toBe(false)
})

test("live propagation: unmodified nodes see upstream changes with no user action", () => {
  const records = [makeRecord({ level: "defaults", agent: null, text: "shared v1" })]
  const v2 = makeItem({ text: "upstream v2" })
  expect(resolve(input({ upstream: v2, records })).text).toBe("shared v1")
  const upstreamOnly = input({ upstream: makeItem({ text: "upstream v2" }) })
  expect(resolve(upstreamOnly).text).toBe("upstream v2")
})

test("live propagation across Defaults to Global to Project", () => {
  const upstream = makeItem({ text: "base" })
  const records = [makeRecord({ level: "defaults", agent: null, text: "shared" })]
  for (const address of [
    { level: "defaults", agent: null, item: upstream.id, section: null },
    { level: "global", agent: "alpha", item: upstream.id, section: null },
    { level: "project", agent: "alpha", item: upstream.id, section: null },
  ] as Address[])
    expect(resolve(input({ upstream, records, address })).text).toBe("shared")
  const changed = makeItem({ text: "changed" })
  expect(resolve(input({ upstream: changed })).text).toBe("changed")
})

test("threeWay reports original, mine, and current upstream", () => {
  const upstream = makeItem({ text: "v2" })
  const records = [makeRecord({ text: "mine", basedOnText: "v1", basedOn: fingerprint("v1") })]
  expect(threeWay(input({ upstream, records }))).toEqual({ original: "v1", mine: "mine", upstream: "v2" })
})

test("threeWay is undefined without a text override", () => {
  expect(threeWay(input({ records: [makeRecord({ state: "off" })] }))).toBeUndefined()
})

test("keep acknowledges without changing text", () => {
  const upstream = makeItem({ text: "v2" })
  const records = [makeRecord({ text: "mine", basedOnText: "v1", basedOn: fingerprint("v1") })]
  const next = resolveResolution(input({ upstream, records }), "keep")
  expect(next[0].text).toBe("mine")
  expect(next[0].acknowledged).toBe(upstream.fingerprint)
  expect(resolve(input({ upstream, records: next })).review).toBe(false)
})

test("take drops the text override so propagation resumes", () => {
  const upstream = makeItem({ text: "v2" })
  const records = [makeRecord({ text: "mine", basedOnText: "v1", basedOn: fingerprint("v1") })]
  const next = resolveResolution(input({ upstream, records }), "take")
  expect(next).toHaveLength(0)
  const resolved = resolve(input({ upstream, records: next }))
  expect(resolved.modified).toBe(false)
  expect(resolved.text).toBe("v2")
})

test("take keeps a state-only record", () => {
  const upstream = makeItem({ text: "v2" })
  const records = [makeRecord({ text: "mine", state: "off", basedOnText: "v1", basedOn: fingerprint("v1") })]
  const next = resolveResolution(input({ upstream, records }), "take")
  expect(next).toHaveLength(1)
  expect(next[0].text).toBeUndefined()
  expect(next[0].state).toBe("off")
})

test("edit replaces text and re-bases review", () => {
  const upstream = makeItem({ text: "v2" })
  const records = [makeRecord({ text: "mine", basedOnText: "v1", basedOn: fingerprint("v1") })]
  const next = resolveResolution(input({ upstream, records }), "edit", "newer")
  expect(next[0].text).toBe("newer")
  expect(next[0].basedOn).toBe(upstream.fingerprint)
  expect(next[0].acknowledged).toBe(upstream.fingerprint)
  expect(resolve(input({ upstream, records: next })).review).toBe(false)
})

test("merge writes the same record as edit, so a computed merge is not an edit", () => {
  const upstream = makeItem({ text: "v2" })
  const records = [makeRecord({ text: "mine", basedOnText: "v1", basedOn: fingerprint("v1") })]
  const next = resolveResolution(input({ upstream, records }), "merge", "merged result")
  expect(next[0].text).toBe("merged result")
  expect(next[0].basedOn).toBe(upstream.fingerprint)
  expect(next[0].basedOnText).toBe("v2")
  expect(next[0].acknowledged).toBe(upstream.fingerprint)
  expect(resolve(input({ upstream, records: next })).review).toBe(false)
  // Without text there is nothing to write, exactly like edit; the op layer
  // refuses that before reaching here.
  expect(resolveResolution(input({ upstream, records }), "merge")).toEqual(records)
})

test("merge applies a field change and reset removes the level row", () => {
  const upstream = makeItem()
  const merged = merge([], { level: "project", agent: "alpha", item: upstream.id, section: null }, { text: "mine" }, upstream)
  expect(merged).toHaveLength(1)
  expect(canReset(merged, { level: "project", agent: "alpha", item: upstream.id, section: null })).toBe(true)
  expect(reset(merged, { level: "project", agent: "alpha", item: upstream.id, section: null })).toHaveLength(0)
})

test("sections warn independently", () => {
  const text = "# One\n\na\n\n# Two\n\nb\n"
  const upstream = makeItem({ id: "system:role", kind: "system", group: "none", text, title: "role" })
  const one = "# One\n\na\n"
  const edited = "# One\n\na edited\n"
  const records = [
    makeRecord({
      item: "system:role",
      section: "one",
      text: edited,
      basedOn: fingerprint(one),
      basedOnText: one,
    }),
  ]
  const oneAddress: Address = { level: "project", agent: "alpha", item: "system:role", section: "one" }
  const twoAddress: Address = { level: "project", agent: "alpha", item: "system:role", section: "two" }
  const oneResolved = resolve(input({ upstream, records, address: oneAddress }))
  expect(oneResolved.text).toBe(edited)
  expect(oneResolved.modified).toBe(true)
  expect(resolve(input({ upstream, records, address: twoAddress })).review).toBe(false)
  const entries = [
    { address: oneAddress, resolved: oneResolved },
    { address: twoAddress, resolved: resolve(input({ upstream, records, address: twoAddress })) },
  ]
  expect(countReview(entries, { level: "project", agent: "alpha", item: "system:role" })).toBe(
    oneResolved.review ? 1 : 0,
  )
})

test("assembled drops excluded sections", () => {
  const text = "# One\n\na\n\n# Two\n\nb\n"
  const upstream = makeItem({ text, title: "role" })
  const split = derive(text, "role")
  expect(split.sections.map((section) => section.id)).toEqual(["one", "two"])
  const records = [makeRecord({ section: "two", state: "off" })]
  const resolved = resolve(input({ upstream, records }))
  expect(resolved.assembled).not.toContain("b")
  expect(resolved.assembled).toContain("a")
})

test("resolveSplit prefers a manual split record down the chain", () => {
  const upstream = makeItem({ text: "plain text", title: "bash" })
  const address: Address = { level: "project", agent: "alpha", item: upstream.id, section: null }
  expect(resolveSplit({ text: upstream.text, title: "bash", splits: [], scopes, address }).kind).toBe("whole")
  const splits: SplitRecord[] = [
    { type: "split", level: "defaults", agent: null, item: upstream.id, boundaries: [{ id: "a", name: "A", start: 0 }], updated: UPDATED },
  ]
  const split = resolveSplit({
    text: upstream.text,
    title: "bash",
    splits: splits.map((entry) => ({ ...entry })),
    scopes,
    address,
  })
  expect(split.kind).toBe("manual")
  expect(split.sections.map((section) => section.id)).toEqual(["a"])
})

test("applies matches unset agents lists to every agent", () => {
  expect(applies(makeItem(), "anything")).toBe(true)
  expect(applies(makeItem({ agents: ["alpha"] }), "beta")).toBe(false)
})

test("item id forms ride through resolution untouched", () => {
  for (const id of ["tool:bash", "base:gpt", "skill:review", "system:role", "system:AGENTS.md", "mcp:server"]) {
    const upstream = makeItem({ id })
    const resolved = resolve(input({ upstream, address: { level: "project", agent: "alpha", item: id, section: null } }))
    expect(resolved.text).toBe(upstream.text)
  }
})

function sectionItem(): Item {
  const text = "# One\n\na\n\n# Two\n\nb\n"
  return makeItem({ id: "system:role", kind: "system", group: "none", title: "role", text })
}

function sectionAddress(section: string, overrides?: Partial<Address>): Address {
  return { level: "project", agent: "alpha", item: "system:role", section, ...overrides }
}

test("whole assembled incorporates a section-only text edit", () => {
  const upstream = sectionItem()
  const edited = "# Two\n\nb edited\n"
  const records = [
    makeRecord({ item: "system:role", section: "two", text: edited, basedOn: fingerprint("# Two\n\nb\n"), basedOnText: "# Two\n\nb\n" }),
  ]
  const resolved = resolve(input({ upstream, records }))
  expect(resolved.assembled).toContain("b edited")
  expect(resolved.assembled).not.toContain("# Two\n\nb\n")
})

test("whole assembled inherits a Defaults section edit", () => {
  const upstream = sectionItem()
  const edited = "# Two\n\nshared edit\n"
  const records = [
    makeRecord({
      level: "defaults",
      agent: null,
      item: "system:role",
      section: "two",
      text: edited,
      basedOn: fingerprint("# Two\n\nb\n"),
      basedOnText: "# Two\n\nb\n",
    }),
  ]
  const resolved = resolve(input({ upstream, records }))
  expect(resolved.assembled).toContain("shared edit")
  expect(resolve(input({ upstream, records, address: sectionAddress("two") })).text).toBe(edited)
})

test("excluding a parent still drops an edited child", () => {
  const text = "# Communication\n\nTalk well.\n\n## Intermediate Commentary\n\nNarrate progress.\n\n# Working in codebases\n\nRead before editing.\n"
  const upstream = makeItem({ id: "system:role", kind: "system", group: "none", title: "role", text })
  const records = [
    makeRecord({
      item: "system:role",
      section: "communication/intermediate-commentary",
      text: "edited",
      basedOn: fingerprint("x"),
      basedOnText: "x",
    }),
    makeRecord({ item: "system:role", section: "communication", state: "off" }),
  ]
  const resolved = resolve(input({ upstream, records }))
  expect(resolved.assembled).not.toContain("edited")
  expect(resolved.assembled).not.toContain("Narrate progress.")
  expect(resolved.assembled).toContain("Read before editing.")
})

test("editing a child does not resurrect an excluded parent, but keeps siblings", () => {
  const text = "# Communication\n\nTalk well.\n\n## Intermediate Commentary\n\nNarrate progress.\n\n## Final Answer\n\nAnswer crisply.\n"
  const upstream = makeItem({ id: "system:role", kind: "system", group: "none", title: "role", text })
  const records = [
    makeRecord({
      item: "system:role",
      section: "communication/intermediate-commentary",
      text: "edited",
      basedOn: fingerprint("x"),
      basedOnText: "x",
    }),
    makeRecord({ item: "system:role", section: "communication/final-answer", state: "off" }),
  ]
  const resolved = resolve(input({ upstream, records }))
  expect(resolved.assembled).toContain("Talk well.")
  expect(resolved.assembled).toContain("edited")
  expect(resolved.assembled).not.toContain("Answer crisply.")
})

test("editing a section when upstream has not moved leaves it not-in-review", () => {
  const upstream = sectionItem()
  const original = "# Two\n\nb\n"
  const edited = "# Two\n\nb edited\n"
  const basedOn = fingerprint(original)
  const records = [
    makeRecord({ item: "system:role", section: "two", text: edited, basedOn, basedOnText: original, acknowledged: basedOn }),
  ]
  expect(resolve(input({ upstream, records, address: sectionAddress("two") })).review).toBe(false)
})

test("keep and edit each clear a genuine section review", () => {
  const upstream = sectionItem()
  const original = "# Two\n\nb\n"
  const stale = fingerprint("older")
  const records = [
    makeRecord({ item: "system:role", section: "two", text: "# Two\n\nmine\n", basedOn: stale, basedOnText: "older" }),
  ]
  const address = sectionAddress("two")
  expect(resolve(input({ upstream, records, address })).review).toBe(true)
  const kept = resolveResolution(input({ upstream, records, address }), "keep")
  expect(kept[0].acknowledged).toBe(fingerprint(upstreamForEdit(input({ upstream, records, address }))))
  expect(resolve(input({ upstream, records: kept, address })).review).toBe(false)
  const edited = resolveResolution(input({ upstream, records, address }), "edit", "# Two\n\nnewer\n")
  expect(edited[0].basedOn).toBe(fingerprint(upstreamForEdit(input({ upstream, records, address }))))
  expect(edited[0].acknowledged).toBe(fingerprint(upstreamForEdit(input({ upstream, records, address }))))
  expect(resolve(input({ upstream, records: edited, address })).review).toBe(false)
})

test("project override over global text reviews only on global moves, and keep clears it", () => {
  const upstream = makeItem({ text: "upstream" })
  const projectAddress: Address = { level: "project", agent: "alpha", item: upstream.id, section: null }
  const records = [
    makeRecord({ level: "global", agent: "alpha", text: "global v1" }),
    makeRecord({
      text: "mine",
      basedOn: fingerprint("global v1"),
      basedOnText: "global v1",
      acknowledged: fingerprint("global v1"),
    }),
  ]
  expect(resolve(input({ upstream, records, address: projectAddress })).review).toBe(false)
  const moved = [makeRecord({ level: "global", agent: "alpha", text: "global v2" }), records[1]]
  expect(resolve(input({ upstream, records: moved, address: projectAddress })).review).toBe(true)
  const kept = resolveResolution(input({ upstream, records: moved, address: projectAddress }), "keep")
  expect(resolve(input({ upstream, records: kept, address: projectAddress })).review).toBe(false)
})

test("fingerprint caches identical text and separates different texts", () => {
  const first = fingerprint("cache me")
  const second = fingerprint("cache me")
  expect(second).toBe(first)
  expect(first).toMatch(/^[0-9a-f]{64}$/)
  expect(fingerprint("cache me not")).not.toBe(first)
})

test("aboveSectionText honors an ancestor section edit", () => {
  const upstream = sectionItem()
  const edited = "# Two\n\nshared edit\n"
  const records = [
    makeRecord({
      level: "defaults",
      agent: null,
      item: "system:role",
      section: "two",
      text: edited,
      basedOn: fingerprint("x"),
      basedOnText: "x",
    }),
  ]
  const seen = upstreamForEdit(input({ upstream, records, address: sectionAddress("two") }))
  expect(seen).toBe(edited)
})

test("pin resolves down the chain with Defaults, global, then project order", () => {
  const upstream = makeItem()
  expect(resolve(input({ upstream })).pinned).toBe(false)
  expect(resolve(input({ upstream: makeItem({ pinned: true }) })).pinned).toBe(true)
  const records = [
    makeRecord({ level: "defaults", agent: null, pin: true }),
    makeRecord({ level: "defaults", agent: "alpha", pin: false }),
    makeRecord({ level: "global", agent: "alpha", pin: true }),
  ]
  expect(resolve(input({ upstream, records })).pinned).toBe(true)
  const withoutGlobal = records.filter((record) => record.level !== "global")
  expect(resolve(input({ upstream, records: withoutGlobal })).pinned).toBe(false)
  const sharedOnly = records.filter((record) => record.agent === null)
  expect(resolve(input({ upstream, records: sharedOnly })).pinned).toBe(true)
  const projectPin = [...records, makeRecord({ pin: false })]
  expect(resolve(input({ upstream, records: projectPin })).pinned).toBe(false)
})

test("pin falls back to upstream.pinned when no record defines it", () => {
  const address: Address = { level: "project", agent: "alpha", item: "tool:bash", section: null }
  expect(resolve(input({ upstream: makeItem({ pinned: true }), address })).pinned).toBe(true)
  expect(resolve(input({ upstream: makeItem({ pinned: false }), address })).pinned).toBe(false)
  expect(resolve(input({ upstream: makeItem(), address })).pinned).toBe(false)
  const records = [makeRecord({ state: "off" })]
  expect(resolve(input({ upstream: makeItem({ pinned: true }), records, address })).pinned).toBe(true)
})

test("a section address reports the whole item's resolved pinned", () => {
  const text = "# One\n\na\n\n# Two\n\nb\n"
  const upstream = makeItem({ id: "system:role", kind: "system", group: "none", title: "role", text, pinned: true })
  const address: Address = { level: "project", agent: "alpha", item: "system:role", section: "one" }
  expect(resolve(input({ upstream, address })).pinned).toBe(true)
  const records = [makeRecord({ item: "system:role", pin: false })]
  expect(resolve(input({ upstream, records, address })).pinned).toBe(false)
  expect(resolve(input({ upstream, records })).pinned).toBe(false)
})

test("merge sets a pin and keeps a pin-only record", () => {
  const upstream = makeItem()
  const address: Address = { level: "project", agent: "alpha", item: upstream.id, section: null }
  const set = merge([], address, { pin: true }, upstream)
  expect(set).toHaveLength(1)
  expect(set[0]?.pin).toBe(true)
  expect(set[0]?.text).toBeUndefined()
  expect(set[0]?.state).toBeUndefined()
  const kept = merge([], address, { pin: false }, upstream)
  expect(kept).toHaveLength(1)
  expect(kept[0]?.pin).toBe(false)
})

test("merge clears a pin with null and never emits pin undefined", () => {
  const upstream = makeItem()
  const address: Address = { level: "project", agent: "alpha", item: upstream.id, section: null }
  const set = merge([], address, { pin: true }, upstream)
  expect(merge(set, address, { pin: null }, upstream)).toHaveLength(0)
  const both = merge([], address, { text: "mine", pin: true }, upstream)
  const cleared = merge(both, address, { pin: null }, upstream)
  expect(cleared).toHaveLength(1)
  expect(cleared[0]?.text).toBe("mine")
  expect("pin" in (cleared[0] ?? {})).toBe(false)
  const textOnly = merge([], address, { text: "mine" }, upstream)
  expect("pin" in (textOnly[0] ?? {})).toBe(false)
  expect(resolve(input({ upstream, records: set })).pinned).toBe(true)
})

test("model item ids round-trip with and without a variant", () => {
  expect(modelItemId({ providerID: "openai", modelID: "gpt-5" })).toBe("model:openai/gpt-5")
  expect(modelItemId({ providerID: "openai", modelID: "gpt-5", variant: "high" })).toBe("model:openai/gpt-5@high")
  expect(parseModelItemId("model:openai/gpt-5")).toEqual({ providerID: "openai", modelID: "gpt-5" })
  expect(parseModelItemId("model:openai/gpt-5@high")).toEqual({ providerID: "openai", modelID: "gpt-5", variant: "high" })
})

test("model item id parsing rejects malformed ids", () => {
  expect(parseModelItemId("tool:bash")).toBeUndefined()
  expect(parseModelItemId("model:openai")).toBeUndefined()
  expect(parseModelItemId("model:/gpt-5")).toBeUndefined()
  expect(parseModelItemId("model:openai/")).toBeUndefined()
  expect(parseModelItemId("model:openai/@high")).toBeUndefined()
})

test("perm item ids round-trip and keep extra colons in the rule id", () => {
  expect(permItemId("shell", "git-push")).toBe("perm:shell:git-push")
  expect(parsePermItemId("perm:shell:git-push")).toEqual({ tool: "shell", ruleId: "git-push" })
  expect(parsePermItemId(permItemId("shell", "a:b"))).toEqual({ tool: "shell", ruleId: "a:b" })
  expect(parsePermItemId("tool:bash")).toBeUndefined()
  expect(parsePermItemId("perm:shell")).toBeUndefined()
  expect(parsePermItemId("perm::x")).toBeUndefined()
})

test("row ids tolerate /, @, and extra : in the item segment through the real tree path", () => {
  // Row ids are built by concatenation and matched by exact string equality
  // (ops.ts findNode): nothing splits the item segment apart, so the future
  // `model:<provider>/<model>[@variant]` and `perm:<tool>:<rule>` forms ride
  // through untouched. This pins that tolerance through tree build + toggle.
  const memo = {
    items: [
      makeItem({ id: "perm:shell:git-push", title: "git-push" }),
      makeItem({ id: "model:openai/gpt-5@high", title: "gpt-5" }),
    ],
    records: [],
    agents: [{ id: "alpha", scope: "project" as const }],
  }
  const ids = expandedTree(memo).map((node) => node.id)
  expect(ids).toContain("item:project:alpha:perm:shell:git-push")
  expect(ids).toContain("item:project:alpha:model:openai/gpt-5@high")
  // alpha is a user agent: an unset row falls back to off (DESIGN §3.3), so
  // the toggle writes "on".
  const perm = toggle(memo, "item:project:alpha:perm:shell:git-push")
  if ("refusal" in perm) throw new Error(`expected toggle success, got ${perm.refusal}`)
  expect(perm.records.some((record) => record.item === "perm:shell:git-push" && record.state === "on")).toBe(true)
  const model = toggle(memo, "item:project:alpha:model:openai/gpt-5@high")
  if ("refusal" in model) throw new Error(`expected toggle success, got ${model.refusal}`)
  expect(model.records.some((record) => record.item === "model:openai/gpt-5@high" && record.state === "on")).toBe(true)
})

test("a perm: item resolves enabled through the existing chain with no new logic", () => {
  const upstream = makeItem({ id: "perm:shell:git-push", title: "git-push" })
  const address: Address = { level: "project", agent: "alpha", item: upstream.id, section: null }
  expect(resolve(input({ upstream, address })).enabled).toBe(true)
  const off = [makeRecord({ item: upstream.id, state: "off" })]
  expect(resolve(input({ upstream, records: off, address })).enabled).toBe(false)
  const on = [makeRecord({ level: "global", agent: "alpha", item: upstream.id, state: "on" })]
  expect(resolve(input({ upstream, records: [...off, ...on], address })).enabled).toBe(false)
  expect(resolve(input({ upstream, records: on, address })).enabled).toBe(true)
})

function modelRecord(overrides?: Partial<ModelRecord>): ModelRecord {
  return {
    type: "model",
    level: "project",
    agent: "alpha",
    providerID: "openai",
    modelID: "gpt-5",
    updated: UPDATED,
    ...overrides,
  }
}

test("activateModel flips active within one (level, agent) pair only", () => {
  const records = [
    modelRecord({ modelID: "gpt-5", active: true }),
    modelRecord({ modelID: "claude-4" }),
    modelRecord({ level: "global", modelID: "gpt-5", active: true }),
    modelRecord({ agent: "beta", modelID: "gpt-5", active: true }),
  ]
  const next = activateModel(records, { level: "project", agent: "alpha" }, { providerID: "openai", modelID: "claude-4" })
  expect(next.find((record) => record.level === "project" && record.agent === "alpha" && record.modelID === "claude-4")?.active).toBe(true)
  expect(next.find((record) => record.level === "project" && record.agent === "alpha" && record.modelID === "gpt-5")?.active).toBeUndefined()
  expect("active" in (next.find((record) => record.level === "project" && record.agent === "alpha" && record.modelID === "gpt-5") ?? {})).toBe(false)
  // Other levels and agents are untouched.
  expect(next.find((record) => record.level === "global")?.active).toBe(true)
  expect(next.find((record) => record.agent === "beta")?.active).toBe(true)
  // At most one active record per (level, agent) is the invariant.
  const actives = next.filter((record) => record.active === true)
  const pairs = new Set(actives.map((record) => `${record.level}:${record.agent ?? ""}`))
  expect(pairs.size).toBe(actives.length)
})

test("activateModel is a no-op on re-activate and on an unknown target", () => {
  const records = [modelRecord({ active: true }), modelRecord({ modelID: "claude-4" })]
  expect(activateModel(records, { level: "project", agent: "alpha" }, { providerID: "openai", modelID: "gpt-5" })).toEqual(records)
  expect(
    activateModel(records, { level: "project", agent: "alpha" }, { providerID: "openai", modelID: "ghost" }),
  ).toEqual(records)
})

test("activateModel distinguishes variants and preserves timestamps", () => {
  const records = [
    modelRecord({ modelID: "gpt-5", variant: "high", active: true, updated: "2026-02-01T00:00:00.000Z" }),
    modelRecord({ modelID: "gpt-5", updated: "2026-03-01T00:00:00.000Z" }),
  ]
  const next = activateModel(records, { level: "project", agent: "alpha" }, { providerID: "openai", modelID: "gpt-5" })
  expect(next.find((record) => record.variant === undefined)?.active).toBe(true)
  expect(next.find((record) => record.variant === "high")?.active).toBeUndefined()
  expect(next.map((record) => record.updated)).toEqual(["2026-02-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z"])
})

// Tombstones: `d` on an inherited or upstream candidate stores a `removed`
// record at the row's level. Resolution hides the candidate for addresses
// whose chain reads that node; a more specific live record still shows over a
// less specific tombstone, and re-adding clears the tombstone.
test("a tombstone hides its candidate from the chain that reads its node, not from other levels", () => {
  const models: ModelRecord[] = [
    modelRecord({ modelID: "base" }),
    modelRecord({ level: "global", modelID: "chosen", active: true }),
  ]
  const visible = resolveActiveModel({ models, scopes, level: "project", agent: "alpha", upstream: { providerID: "openai", modelID: "host" } })
  expect(visible?.modelID).toBe("chosen")
  const hiddenModels = tombstoneModelRecord(models, { level: "project", agent: "alpha" }, { providerID: "openai", modelID: "chosen" }, UPDATED)
  // Project reads the tombstone: the Global active record no longer wins and
  // the chain falls through to the host model.
  const projectView = resolveActiveModel({ models: hiddenModels, scopes, level: "project", agent: "alpha", upstream: { providerID: "openai", modelID: "host" } })
  expect(projectView?.source).toBe("upstream")
  expect(modelCandidates({ models: hiddenModels, scopes, level: "project", agent: "alpha", upstream: { providerID: "openai", modelID: "host" } }).map((entry) => entry.modelID)).toEqual(["base", "host"])
  // Global does not resolve through the Project tombstone.
  const globalView = resolveActiveModel({ models: hiddenModels, scopes, level: "global", agent: "alpha", upstream: { providerID: "openai", modelID: "host" } })
  expect(globalView?.modelID).toBe("chosen")
  expect(modelCandidates({ models: hiddenModels, scopes, level: "global", agent: "alpha", upstream: { providerID: "openai", modelID: "host" } }).map((entry) => entry.modelID)).toEqual(["chosen", "host"])
})

test("a more specific live record wins over a less specific tombstone", () => {
  const models: ModelRecord[] = [
    modelRecord({ level: "defaults", modelID: "mine" }),
    modelRecord({ modelID: "mine" }),
  ]
  const tombstoned = tombstoneModelRecord(models, { level: "defaults", agent: "alpha" }, { providerID: "openai", modelID: "mine" }, UPDATED)
  // Project names the candidate itself: the live record wins over the
  // Defaults tombstone.
  expect(modelCandidates({ models: tombstoned, scopes, level: "project", agent: "alpha" }).map((entry) => entry.modelID)).toContain("mine")
  // Defaults still hides it there.
  expect(modelCandidates({ models: tombstoned, scopes, level: "defaults", agent: "alpha" }).map((entry) => entry.modelID)).not.toContain("mine")
})

test("re-adding a tombstoned candidate clears its tombstone and never steals active", () => {
  const models: ModelRecord[] = [
    modelRecord({ level: "global", modelID: "chosen", active: true }),
    tombstoneModelRecord([], { level: "project", agent: "alpha" }, { providerID: "openai", modelID: "chosen" }, UPDATED)[0]!,
  ]
  const hidden = resolveActiveModel({ models, scopes, level: "project", agent: "alpha" })
  expect(hidden).toBeUndefined()
  const readded = addModelRecord(models, { level: "project", agent: "alpha" }, { providerID: "openai", modelID: "chosen" }, UPDATED)
  expect(readded.some((record) => record.removed === true)).toBe(false)
  const visible = resolveActiveModel({ models: readded, scopes, level: "project", agent: "alpha" })
  expect(visible?.source).toBe("global")
})

test("warming is hidden with its tombstoned candidate", () => {
  const models: ModelRecord[] = [modelRecord({ modelID: "chosen", warming: "45m" })]
  const target = { providerID: "openai", modelID: "chosen" }
  expect(resolveModelWarming({ models, scopes, level: "project", agent: "alpha" }, target)?.value).toBe("45m")
  const hidden = tombstoneModelRecord(models, { level: "project", agent: "alpha" }, target, UPDATED)
  expect(resolveModelWarming({ models: hidden, scopes, level: "project", agent: "alpha" }, target)).toBeUndefined()
})

// T7 issue #6: a field row shows the effective value and its real source, not
// the Defaults value whenever the source level differs from the row's. A
// Global record inherited at Project names Global on every field, and an
// explicit variant belongs to the candidate so Effort inherits with it.
test("model field rows name the level that set an inherited value, not the Defaults value", () => {
  const record: ModelRecord = {
    type: "model",
    level: "global",
    agent: "alpha",
    providerID: "acme",
    modelID: "nova",
    variant: "high",
    warming: "30m",
    interval: "4m",
    prompt: "keep alive",
    updated: UPDATED,
  }
  const memo = {
    items: [] as Item[],
    records: [record],
    agents: [
      { id: "alpha", scope: "project" as const },
      { id: "alpha", scope: "global" as const },
    ],
  }
  const rows = expandedTree(memo)
  const fields = rows.filter((row) => row.id.startsWith("item:project:alpha:modelfield:"))
  // The row's layout (plus-1.1.18 §2): Model, Effort, then Warming's fields
  // (Warming, Ping every, Warm while waiting, Warm as subagent, Keep-alive
  // prompt, Compact before cold, Compact cold chats first), Compaction's
  // (Strategy, Input/Output token threshold, Model, Instructions) and Images'
  // (Convert large image, Shrink large image, When image context is full).
  // The thresholds came with 8baab5d111, the image rows with a81272d051 and
  // Compact cold chats first with 702a7b69a6.
  expect(fields.map((row) => [row.label, row.badges.value, row.actions?.reset])).toEqual([
    ["Model", "acme/nova@high · global", false],
    ["Effort", "high · global", false],
    ["Warming", "30m · global", false],
    ["Ping every", "4m · global", false],
    ["Warm while waiting", "2h · built-in", false],
    ["Warm as subagent", "off · built-in", false],
    ["Keep-alive prompt", "keep alive · global", false],
    ["Compact before cold", "off · built-in", false],
    ["Compact cold chats first", "as in Settings", false],
    ["Strategy", "Auto · built-in", false],
    ["Input token threshold", "off · built-in", false],
    ["Output token threshold", "off · built-in", false],
    ["Model", "Inherited model · built-in", false],
    ["Instructions", "Empty prompt · built-in", false],
    ["Convert large image", "WebP 90 · built-in", false],
    ["Shrink large image", "Max: 2,000 px · built-in", false],
    ["When image context is full", "Compact the chat · built-in", false],
  ])
})

// The same rule for a preset member and a team member: their own candidate's
// fields are named with the level that set them, and a preset row at its own
// level reads as own.
test("preset and team member field rows name their own level when set there", () => {
  const presetRecord: ModelRecord = {
    type: "model",
    level: "preset",
    agent: "reader",
    team: { level: "preset", team: "crew" },
    providerID: "acme",
    modelID: "nova",
    warming: "30m",
    subagent: "on",
    updated: UPDATED,
  }
  const presetRows = expandedTree({
    items: [] as Item[],
    records: [presetRecord],
    agents: [],
    presets: [
      { type: "preset" as const, level: "preset" as const, kind: "team" as const, id: "crew", updated: UPDATED },
      { type: "preset" as const, level: "preset" as const, kind: "agent" as const, id: "reader", team: "crew", updated: UPDATED },
    ],
  })
  const presetWarming = presetRows.find((row) => row.id === "item:preset:crew/:reader:modelfield:warming:acme/nova")
  expect(presetWarming?.badges.value).toBe("30m")
  expect(presetWarming?.actions?.reset).toBe(true)
  expect(presetRows.find((row) => row.id === "item:preset:crew/:reader:modelfield:subagent:acme/nova")).toMatchObject({
    label: "Warm as subagent",
    badges: { value: "on" },
    actions: { edit: true, reset: true },
  })
  const presetModel = presetRows.find((row) => row.id === "item:preset:crew/:reader:modelfield:model:acme/nova")
  expect(presetModel?.badges.value).toBe("acme/nova")

  const teamRecord: ModelRecord = {
    type: "model",
    level: "global",
    agent: "Planner",
    providerID: "acme",
    modelID: "nova",
    warming: "45m",
    subagent: "off",
    updated: UPDATED,
  }
  const teamRows = expandedTree({
    items: [] as Item[],
    records: [teamRecord],
    agents: [],
    teams: [{ level: "global" as const, team: "Basic", enabled: true, agents: ["Planner"] }],
  })
  const memberWarming = teamRows.find((row) => row.id === "item:global:Basic/:Planner:modelfield:warming:acme/nova")
  expect(memberWarming?.badges.value).toBe("45m")
  expect(memberWarming?.actions?.reset).toBe(true)
  expect(teamRows.find((row) => row.id === "item:global:Basic/:Planner:modelfield:subagent:acme/nova")).toMatchObject({
    label: "Warm as subagent",
    badges: { value: "off" },
    actions: { edit: true, reset: true },
  })
})

// team, so the tool activation writes a flat `global/Planner` record (no team
// owner path, exactly what the log showed). That flat record must take effect
// for the member's chain — both the runtime chain (level + team) and the
// tree's memberOf chain — or the write is a silent no-op for the user.
test("tool activation of a member-only agent's model row writes a flat record its member chain reads", () => {
  const candidate: ModelRecord = {
    type: "model",
    level: "defaults",
    agent: null,
    catalogue: "teams",
    providerID: "acme",
    modelID: "base",
    updated: UPDATED,
  }
  const memo = {
    items: [] as Item[],
    records: [candidate],
    agents: [] as { id: string; scope: "global" }[],
    teams: [{ level: "global" as const, team: "Basic", enabled: true, agents: ["Planner"] }],
  }
  const row = expandedTree(memo).find((node) => node.id === "item:global:Basic/:Planner:model:acme/base")
  expect(row).toBeDefined()
  if (row === undefined) return
  const op = activateModelRow(memo, row.id)
  if ("refusal" in op) throw new Error(`expected activation, got ${op.refusal}`)
  const written = op.models.find((record) => record.level === "global" && record.agent === "Planner")
  expect(written?.active).toBe(true)
  expect(written?.team).toBeUndefined()
  const emptyScopes: Scopes = { global: new Set<string>(), defaults: new Set<string>() }
  const runtime = resolveActiveModel({
    models: op.models,
    scopes: emptyScopes,
    level: "global",
    agent: "Planner",
    team: { level: "global", team: "Basic" },
  })
  expect(runtime?.providerID).toBe("acme")
  expect(runtime?.modelID).toBe("base")
  const treeView = resolveActiveModel({
    models: op.models,
    scopes: emptyScopes,
    level: "global",
    agent: "Planner",
    memberOf: { level: "global", team: "Basic" },
  })
  expect(treeView?.modelID).toBe("base")
})

test("lazyModelField shows independent Model and Effort source when only one is edited", () => {
  // Candidate originally inherited from Global (openai/gpt-5@high).
  // Case A: Only Model is edited at Project (to google/gemini).
  const modelOnlyRecord: ModelRecord = {
    type: "model",
    level: "project",
    agent: "alpha",
    providerID: "google",
    modelID: "gemini",
    variant: "high",
    originalCandidate: {
      providerID: "openai",
      modelID: "gpt-5",
      variant: "high",
      source: "global",
      editedFields: ["model"],
    },
    updated: UPDATED,
  }
  const rowsA = expandedTree({
    items: [] as Item[],
    records: [modelOnlyRecord],
    agents: [{ id: "alpha", scope: "project" as const }],
  })
  const modelFieldA = rowsA.find((r) => r.id === "item:project:alpha:modelfield:model:google/gemini@high")
  expect(modelFieldA?.badges.value).toBe("google/gemini@high")
  expect(modelFieldA?.actions?.reset).toBe(true)
  const effortFieldA = rowsA.find((r) => r.id === "item:project:alpha:modelfield:effort:google/gemini@high")
  expect(effortFieldA?.badges.value).toBe("high · global")
  expect(effortFieldA?.actions?.reset).toBe(false)

  // Case B: Only Effort is edited at Project (to low).
  const effortOnlyRecord: ModelRecord = {
    type: "model",
    level: "project",
    agent: "alpha",
    providerID: "openai",
    modelID: "gpt-5",
    variant: "low",
    originalCandidate: {
      providerID: "openai",
      modelID: "gpt-5",
      variant: "high",
      source: "global",
      editedFields: ["effort"],
    },
    updated: UPDATED,
  }
  const rowsB = expandedTree({
    items: [] as Item[],
    records: [effortOnlyRecord],
    agents: [{ id: "alpha", scope: "project" as const }],
  })
  const modelFieldB = rowsB.find((r) => r.id === "item:project:alpha:modelfield:model:openai/gpt-5@low")
  expect(modelFieldB?.badges.value).toBe("openai/gpt-5@low · global")
  expect(modelFieldB?.actions?.reset).toBe(false)
  const effortFieldB = rowsB.find((r) => r.id === "item:project:alpha:modelfield:effort:openai/gpt-5@low")
  expect(effortFieldB?.badges.value).toBe("low")
  expect(effortFieldB?.actions?.reset).toBe(true)
})
