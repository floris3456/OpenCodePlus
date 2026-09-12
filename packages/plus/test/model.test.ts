import { expect, test } from "bun:test"
import {
  applies,
  effective,
  fingerprint,
  mergeCustomization,
  override,
  type Customization,
  type Item,
  type Snapshot,
} from "../src/instructions/model.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

function makeItem(overrides?: Partial<Item>): Item {
  const text = overrides?.text ?? "default text"
  return {
    id: "item-1",
    kind: "prompt",
    owner: "owner",
    title: "title",
    text,
    agents: [],
    fingerprint: fingerprint(text),
    available: true,
    ...overrides,
  }
}

function makeCustomization(overrides?: Partial<Customization>): Customization {
  return {
    item: "item-1",
    agent: "*",
    state: "inherit",
    basedOn: fingerprint("default text"),
    updated: UPDATED,
    ...overrides,
  }
}

function makeSnapshot(customizations: Customization[]): Snapshot {
  return { revision: 1, items: [], customizations }
}

test("applies matches empty agents to every agent", () => {
  expect(applies(makeItem(), "anything")).toBe(true)
})

test("applies matches listed agents only", () => {
  const item = makeItem({ agents: ["alpha", "beta"] })
  expect(applies(item, "alpha")).toBe(true)
  expect(applies(item, "gamma")).toBe(false)
})

test("override returns undefined without records", () => {
  expect(override(makeSnapshot([]), "item-1", "alpha")).toBeUndefined()
})

test("override falls back to the shared record", () => {
  const shared = makeCustomization({ text: "shared", state: "disabled" })
  const resolved = override(makeSnapshot([shared]), "item-1", "alpha")
  expect(resolved).toEqual(shared)
})

test("override returns the per-agent record without shared", () => {
  const own = makeCustomization({ agent: "alpha", text: "own" })
  expect(override(makeSnapshot([own]), "item-1", "alpha")).toEqual(own)
})

test("override merges per-agent over shared", () => {
  const shared = makeCustomization({ text: "shared", state: "disabled" })
  const own = makeCustomization({ agent: "alpha", state: "inherit" })
  const resolved = override(makeSnapshot([shared, own]), "item-1", "alpha")
  expect(resolved?.text).toBe("shared")
  expect(resolved?.state).toBe("disabled")
  expect(resolved?.agent).toBe("alpha")
})

test("override keeps per-agent values that diverge from shared", () => {
  const shared = makeCustomization({ text: "shared", state: "disabled" })
  const own = makeCustomization({ agent: "alpha", text: "own", state: "enabled" })
  const resolved = override(makeSnapshot([shared, own]), "item-1", "alpha")
  expect(resolved?.text).toBe("own")
  expect(resolved?.state).toBe("enabled")
})

test("override for the shared agent returns the shared record as-is", () => {
  const shared = makeCustomization({ text: "shared", state: "disabled" })
  const resolved = override(makeSnapshot([shared]), "item-1", "*")
  expect(resolved).toEqual(shared)
})

test("effective falls back to item text and availability without records", () => {
  const item = makeItem()
  expect(effective(makeSnapshot([]), item, "alpha")).toEqual({
    text: "default text",
    enabled: true,
    customized: false,
    review: false,
  })
})

test("effective disables unavailable items", () => {
  const item = makeItem({ available: false })
  const result = effective(makeSnapshot([]), item, "alpha")
  expect(result.enabled).toBe(false)
  expect(result.customized).toBe(false)
})

test("effective resolves custom text and disabled state", () => {
  const item = makeItem()
  const record = makeCustomization({ agent: "alpha", text: "custom", state: "disabled" })
  const result = effective(makeSnapshot([record]), item, "alpha")
  expect(result.text).toBe("custom")
  expect(result.enabled).toBe(false)
  expect(result.customized).toBe(true)
})

test("effective keeps the item text when only the state changes", () => {
  const item = makeItem()
  const record = makeCustomization({ agent: "alpha", state: "disabled" })
  const result = effective(makeSnapshot([record]), item, "alpha")
  expect(result.text).toBe("default text")
  expect(result.enabled).toBe(false)
  expect(result.customized).toBe(true)
})

test("activation equal to the default is not a customization", () => {
  const enabled = makeItem({ available: true })
  const enableRecord = makeCustomization({ agent: "alpha", state: "enabled" })
  expect(effective(makeSnapshot([enableRecord]), enabled, "alpha").customized).toBe(false)

  const disabled = makeItem({ available: false })
  const disableRecord = makeCustomization({ agent: "alpha", state: "disabled" })
  expect(effective(makeSnapshot([disableRecord]), disabled, "alpha").customized).toBe(false)
})

test("activation against the default is a customization", () => {
  const enabled = makeItem({ available: true })
  const disableRecord = makeCustomization({ agent: "alpha", state: "disabled" })
  expect(effective(makeSnapshot([disableRecord]), enabled, "alpha").customized).toBe(true)

  const disabled = makeItem({ available: false })
  const enableRecord = makeCustomization({ agent: "alpha", state: "enabled" })
  expect(effective(makeSnapshot([enableRecord]), disabled, "alpha").customized).toBe(true)
})

test("inherited state without text is not a customization", () => {
  const item = makeItem()
  const record = makeCustomization({ agent: "alpha", state: "inherit" })
  expect(effective(makeSnapshot([record]), item, "alpha").customized).toBe(false)
})

test("review flags upstream changes after authoring", () => {
  const item = makeItem({ text: "revised text" })
  const record = makeCustomization({ agent: "alpha", text: "custom", basedOn: fingerprint("default text") })
  const result = effective(makeSnapshot([record]), item, "alpha")
  expect(result.customized).toBe(true)
  expect(result.review).toBe(true)
})

test("review clears once the change is reviewed", () => {
  const item = makeItem({ text: "revised text" })
  const record = makeCustomization({
    agent: "alpha",
    text: "custom",
    basedOn: fingerprint("default text"),
    reviewed: fingerprint("revised text"),
  })
  const result = effective(makeSnapshot([record]), item, "alpha")
  expect(result.customized).toBe(true)
  expect(result.review).toBe(false)
})

test("review stays false when nothing changed upstream", () => {
  const item = makeItem()
  const record = makeCustomization({ agent: "alpha", text: "custom", basedOn: item.fingerprint })
  expect(effective(makeSnapshot([record]), item, "alpha").review).toBe(false)
})

test("review stays false without a customization", () => {
  const item = makeItem({ text: "revised text" })
  expect(effective(makeSnapshot([]), item, "alpha").review).toBe(false)
})

test("mergeCustomization acknowledge sets reviewed and clears the review flag", () => {
  const item = makeItem({ text: "revised text" })
  const customizations = mergeCustomization([], item, "alpha", { reviewed: item.fingerprint })
  expect(customizations).toHaveLength(1)
  expect(customizations[0].reviewed).toBe(item.fingerprint)
  expect(effective(makeSnapshot(customizations), item, "alpha").review).toBe(false)
})

test("mergeCustomization save text sets text and marks the item customized", () => {
  const item = makeItem()
  const customizations = mergeCustomization([], item, "alpha", { text: "custom" })
  expect(customizations).toHaveLength(1)
  expect(customizations[0].text).toBe("custom")
  expect(effective(makeSnapshot(customizations), item, "alpha").customized).toBe(true)
})

test("mergeCustomization acknowledge preserves the other fields of an existing record", () => {
  const item = makeItem({ text: "revised text" })
  const existing = makeCustomization({
    agent: "alpha",
    text: "custom",
    state: "disabled",
    basedOn: fingerprint("default text"),
  })
  const customizations = mergeCustomization([existing], item, "alpha", { reviewed: item.fingerprint })
  expect(customizations).toHaveLength(1)
  const record = customizations[0]
  expect(record.text).toBe("custom")
  expect(record.state).toBe("disabled")
  expect(record.basedOn).toBe(fingerprint("default text"))
  expect(record.reviewed).toBe(item.fingerprint)
})

test("mergeCustomization save text preserves the other fields of an existing record", () => {
  const item = makeItem({ text: "revised text" })
  const existing = makeCustomization({
    agent: "alpha",
    state: "disabled",
    basedOn: fingerprint("default text"),
    reviewed: fingerprint("revised text"),
  })
  const customizations = mergeCustomization([existing], item, "alpha", { text: "custom" })
  expect(customizations).toHaveLength(1)
  const record = customizations[0]
  expect(record.text).toBe("custom")
  expect(record.state).toBe("disabled")
  expect(record.basedOn).toBe(fingerprint("default text"))
  expect(record.reviewed).toBe(fingerprint("revised text"))
})

test("mergeCustomization replaces the matching record instead of appending a duplicate", () => {
  const item = makeItem()
  const other = makeCustomization({ item: "item-2", agent: "alpha", text: "other" })
  const existing = makeCustomization({ agent: "alpha", text: "before" })
  const customizations = mergeCustomization([other, existing], item, "alpha", { text: "after" })
  expect(customizations).toHaveLength(2)
  expect(customizations.filter((record) => record.item === "item-1" && record.agent === "alpha")).toHaveLength(1)
  expect(customizations.find((record) => record.item === "item-1")?.text).toBe("after")
  expect(customizations.find((record) => record.item === "item-2")).toEqual(other)
})

test("mergeCustomization defaults basedOn to the item fingerprint and omits undefined optionals", () => {
  const item = makeItem()
  const customizations = mergeCustomization([], item, "alpha", { state: "disabled" })
  expect(customizations).toHaveLength(1)
  const record = customizations[0]
  expect(record.basedOn).toBe(item.fingerprint)
  expect("text" in record).toBe(false)
  expect("reviewed" in record).toBe(false)
})
