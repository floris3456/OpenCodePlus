import { expect, test } from "bun:test"
import {
  acknowledgeActiveModel,
  clearModelActive,
  ensureActivateModel,
  fingerprint,
  merge,
  presetKey,
  resolve,
  resolveActiveModel,
  resolveResolution,
  type Address,
  type ChainContext,
  type ChainInput,
  type CustomizationRecord,
  type Item,
  type ModelRecord,
  type ModelRefLike,
} from "../src/instructions/model.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

const upstream: Item = {
  id: "tool:bash",
  kind: "tool",
  group: "native",
  title: "bash",
  text: "run commands",
  enabled: true,
  fingerprint: fingerprint("run commands"),
}

const own: Address = { level: "project", agent: "alice", item: "tool:bash", section: null }

function presetRecord(fields: Partial<CustomizationRecord>): CustomizationRecord {
  return {
    type: "customization",
    level: "preset",
    agent: "mine",
    item: "tool:bash",
    section: null,
    basedOn: upstream.fingerprint,
    updated: UPDATED,
    ...fields,
  }
}

function context(models: Record<string, ModelRefLike> = {}): ChainContext {
  return {
    global: new Set<string>(),
    defaults: new Set<string>(),
    native: new Set(["build"]),
    links: [{ type: "link", level: "project", agent: "alice", preset: { kind: "agent", id: "mine" }, updated: UPDATED }],
    entries: [{ type: "entry", level: "defaults", catalogue: "agents", name: "ali*", updated: UPDATED }],
    presets: {
      presets: [{ ref: { kind: "agent", id: "mine" }, origin: "plus" }],
      links: [],
      shipped: () => undefined,
      model: (preset) => models[presetKey(preset)],
    },
  }
}

function input(records: readonly CustomizationRecord[], scopes = context()): ChainInput {
  return { upstream, records, splits: [], scopes, address: own }
}

function ownRecord(records: readonly CustomizationRecord[]): CustomizationRecord | undefined {
  return records.find((record) => record.level === "project" && record.agent === "alice")
}

test("setting state with a chain context records the state above; a later change above raises review", () => {
  const preset = [presetRecord({ state: "on" })]
  const set = merge(preset, own, { state: "off" }, upstream, context())
  expect(ownRecord(set)?.basedOnState).toBe("on")
  expect(resolve(input(set)).review).toBe(false)
  expect(resolve(input(set)).reviewOf).toEqual([])
  // The preset now says off too: the override is no longer an override of "on".
  const moved = set.map((record) => (record.level === "preset" ? { ...record, state: "off" as const } : record))
  const resolved = resolve(input(moved))
  expect(resolved.enabled).toBe(false)
  expect(resolved.review).toBe(true)
  expect(resolved.reviewOf).toEqual(["state"])
  expect(resolved.modified).toBe(false)
})

test("keep acknowledges a state review; take drops the state and follows the preset", () => {
  const set = merge([presetRecord({ state: "off" })], own, { state: "on" }, upstream, context())
  expect(ownRecord(set)?.basedOnState).toBe("off")
  const moved = set.map((record) => (record.level === "preset" ? { ...record, state: "on" as const } : record))
  expect(resolve(input(moved)).reviewOf).toEqual(["state"])
  const kept = resolveResolution(input(moved), "keep")
  expect(ownRecord(kept)?.state).toBe("on")
  expect(ownRecord(kept)?.basedOnState).toBe("on")
  expect(resolve(input(kept)).review).toBe(false)
  // Keeping again changes nothing.
  expect(resolveResolution(input(kept), "keep")).toEqual(kept)
  const moved2 = kept.map((record) => (record.level === "preset" ? { ...record, state: "off" as const } : record))
  const withText = merge(moved2, own, { text: "my bash" }, upstream, context(), [])
  expect(resolve(input(withText)).reviewOf).toEqual(["state"])
  const taken = resolveResolution(input(withText), "take")
  // Only the part under review goes: the text edit stays.
  expect(ownRecord(taken)?.state).toBeUndefined()
  expect(ownRecord(taken)?.basedOnState).toBeUndefined()
  expect(ownRecord(taken)?.text).toBe("my bash")
  const after = resolve(input(taken))
  expect(after.enabled).toBe(false)
  expect(after.from).toEqual({ kind: "preset", id: "mine", shipped: false })
  expect(after.review).toBe(false)
})

test("take on a state-only review removes the record", () => {
  const set = merge([presetRecord({ state: "on" })], own, { state: "off" }, upstream, context())
  const moved = set.map((record) => (record.level === "preset" ? { ...record, state: "off" as const } : record))
  const taken = resolveResolution(input(moved), "take")
  expect(ownRecord(taken)).toBeUndefined()
})

// The TUI resolves a state review with its own choice before the text's
// three-way diff: `only` keeps the other parts under review untouched.
test("keep and take limited to the state leave a text review for the diff", () => {
  const preset = [presetRecord({ state: "on", text: "v1" })]
  const set = merge(preset, own, { state: "off", text: "mine" }, upstream, context(), [])
  const moved = set.map((record) => (record.level === "preset" ? { ...record, state: "off" as const, text: "v2" } : record))
  expect(resolve(input(moved)).reviewOf).toEqual(["text", "state"])
  const kept = resolveResolution(input(moved), "keep", undefined, ["state"])
  expect(ownRecord(kept)?.basedOnState).toBe("off")
  expect(ownRecord(kept)?.acknowledged).toBe(ownRecord(moved)?.acknowledged)
  expect(resolve(input(kept)).reviewOf).toEqual(["text"])
  const taken = resolveResolution(input(moved), "take", undefined, ["state"])
  expect(ownRecord(taken)?.state).toBeUndefined()
  expect(ownRecord(taken)?.text).toBe("mine")
  expect(resolve(input(taken)).reviewOf).toEqual(["text"])
  // Nothing of the named parts under review: nothing changes.
  expect(resolveResolution(input(moved), "take", undefined, ["pin"])).toEqual(moved)
})

test("a Defaults entry or Defaults for every agent changing under the override raises review", () => {
  const scopes = { ...context(), links: [] }
  const entry: CustomizationRecord = { ...presetRecord({ state: "on" }), level: "defaults", agent: "ali*" }
  const set = merge([entry], own, { state: "off" }, upstream, scopes)
  expect(ownRecord(set)?.basedOnState).toBe("on")
  const moved = set.map((record) => (record.agent === "ali*" ? { ...record, state: "off" as const } : record))
  expect(resolve(input(moved, scopes)).reviewOf).toEqual(["state"])
  // Defaults for every agent was on; removing it leaves the fallback (off for a user agent).
  const everyone: CustomizationRecord = { ...presetRecord({ state: "on" }), level: "defaults", agent: null }
  const onEveryone = merge([everyone], own, { state: "off" }, upstream, scopes)
  expect(ownRecord(onEveryone)?.basedOnState).toBe("on")
  expect(resolve(input(onEveryone, scopes)).review).toBe(false)
  const removed = onEveryone.filter((record) => record.level !== "defaults")
  expect(resolve(input(removed, scopes)).reviewOf).toEqual(["state"])
})

test("pin review follows the same rule", () => {
  const set = merge([presetRecord({ pin: true })], own, { pin: false }, upstream, context())
  expect(ownRecord(set)?.basedOnPin).toBe(true)
  expect(resolve(input(set)).review).toBe(false)
  const moved = set.map((record) => (record.level === "preset" ? { ...record, pin: false } : record))
  expect(resolve(input(moved)).reviewOf).toEqual(["pin"])
  const kept = resolveResolution(input(moved), "keep")
  expect(ownRecord(kept)?.basedOnPin).toBe(false)
  expect(resolve(input(kept)).review).toBe(false)
  const taken = resolveResolution(input(moved), "take")
  expect(ownRecord(taken)).toBeUndefined()
})

test("records without basedOnState or basedOnPin never flag", () => {
  const old: CustomizationRecord = {
    type: "customization",
    level: "project",
    agent: "alice",
    item: "tool:bash",
    section: null,
    state: "off",
    pin: true,
    basedOn: upstream.fingerprint,
    updated: UPDATED,
  }
  for (const preset of [presetRecord({ state: "on", pin: false }), presetRecord({ state: "off", pin: true })])
    expect(resolve(input([preset, old])).review).toBe(false)
  // Without a chain context merge records nothing, as before.
  const untracked = merge([presetRecord({ state: "on" })], own, { state: "off" }, upstream)
  expect(ownRecord(untracked)?.basedOnState).toBeUndefined()
  // Clearing the state drops what it was based on.
  const set = merge([presetRecord({ state: "on" })], own, { state: "off", pin: true }, upstream, context())
  const cleared = merge(set, own, { state: null }, upstream, context())
  expect(ownRecord(cleared)?.state).toBeUndefined()
  expect(ownRecord(cleared)?.basedOnState).toBeUndefined()
  expect(ownRecord(cleared)?.basedOnPin).toBe(false)
})

test("a section state override is reviewed against the section state above", () => {
  const address: Address = { ...own, item: "system:role", section: "two" }
  const role: Item = { ...upstream, id: "system:role", kind: "system", text: "# One\n\na\n\n# Two\n\nb\n" }
  const presetSection: CustomizationRecord = { ...presetRecord({ state: "on" }), item: "system:role", section: "two" }
  const set = merge([presetSection], address, { state: "off" }, role, context())
  expect(set.find((record) => record.level === "project")?.basedOnState).toBe("on")
  const moved = set.map((record) => (record.level === "preset" ? { ...record, state: "off" as const } : record))
  const resolved = resolve({ upstream: role, records: moved, splits: [], scopes: context(), address })
  expect(resolved.reviewOf).toEqual(["state"])
})

test("active model: activating records the model above; a change above raises review", () => {
  const opus = { providerID: "anthropic", modelID: "opus" }
  const gpt = { providerID: "openai", modelID: "gpt" }
  const scope = { level: "project" as const, agent: "alice" }
  const shipped = context({ "agent:mine": opus })
  const set = ensureActivateModel([], scope, gpt, UPDATED, { scopes: shipped })
  expect(set[0]?.basedOn).toBe("anthropic/opus")
  const read = (models: readonly ModelRecord[], scopes: ChainContext) =>
    resolveActiveModel({ models, scopes, level: "project", agent: "alice" })
  expect(read(set, shipped)).toEqual({ ...gpt, source: "project", from: { kind: "level", level: "project" } })
  // The preset now ships another model.
  const moved = context({ "agent:mine": { providerID: "google", modelID: "gemini" } })
  expect(read(set, moved)?.review).toBe(true)
  // keep: re-record the model above.
  const kept = acknowledgeActiveModel(set, scope, { scopes: moved })
  expect(kept[0]?.basedOn).toBe("google/gemini")
  expect(read(kept, moved)?.review).toBeUndefined()
  expect(acknowledgeActiveModel(kept, scope, { scopes: moved })).toEqual(kept)
  // take: drop the own active model and follow the preset.
  const taken = clearModelActive(set, scope)
  expect(read(taken, moved)).toEqual({
    providerID: "google",
    modelID: "gemini",
    source: "preset",
    from: { kind: "preset", id: "mine", shipped: true },
  })
})

test("active model: nothing above records an empty key; old active records never flag", () => {
  const gpt = { providerID: "openai", modelID: "gpt" }
  const scope = { level: "project" as const, agent: "alice" }
  const set = ensureActivateModel([], scope, gpt, UPDATED, { scopes: context() })
  expect(set[0]?.basedOn).toBe("")
  const old: ModelRecord[] = [{ type: "model", level: "project", agent: "alice", ...gpt, active: true, updated: UPDATED }]
  const shipped = context({ "agent:mine": { providerID: "anthropic", modelID: "opus" } })
  expect(resolveActiveModel({ models: old, scopes: shipped, level: "project", agent: "alice" })?.review).toBeUndefined()
  // Without a context activation records nothing, as before.
  expect(ensureActivateModel([], scope, gpt, UPDATED)[0]?.basedOn).toBeUndefined()
  // The upstream model counts as the model above.
  const upstreamModel = { providerID: "local", modelID: "llama" }
  const withUpstream = ensureActivateModel([], scope, gpt, UPDATED, { scopes: context(), upstream: upstreamModel })
  expect(withUpstream[0]?.basedOn).toBe("local/llama")
})
