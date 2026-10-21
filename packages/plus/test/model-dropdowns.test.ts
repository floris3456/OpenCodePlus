// The dropdowns behind Warming, Ping every, Effort and Compaction › Model
// (plus-1.2.0 B32, I2b): what each one offers, and the lifetime that sets the
// Ping every values.
import { expect, test } from "bun:test"
import { cacheLifetimeOf, CUSTOM_CHOICE, modelFieldChoices, pingChoices } from "../src/instructions/model-settings.js"

test("Ping every offers the times below a 5m cache lifetime", () => {
  expect(pingChoices(300_000)).toEqual(["1m", "2m", "3m", "4m", "4m30s"])
})

test("Ping every offers the times below a 30m cache lifetime", () => {
  expect(pingChoices(1_800_000)).toEqual(["5m", "10m", "15m", "20m", "25m"])
})

test("Ping every offers the times below a 1h cache lifetime", () => {
  expect(pingChoices(3_600_000)).toEqual(["10m", "20m", "30m", "45m", "55m"])
})

test("Ping every falls back to the 5m list when the lifetime is unknown", () => {
  expect(pingChoices(undefined)).toEqual(["1m", "2m", "3m", "4m", "4m30s"])
})

test("the monitor's lifetime for a model row: Anthropic 5m, GPT-6 30m, unknown otherwise", () => {
  expect(cacheLifetimeOf({ providerID: "anthropic", modelID: "claude" })).toBe(300_000)
  expect(cacheLifetimeOf({ providerID: "openai", modelID: "gpt-6" })).toBe(1_800_000)
  expect(cacheLifetimeOf({ providerID: "acme", modelID: "nova" })).toBeUndefined()
  expect(cacheLifetimeOf({})).toBeUndefined()
})

test("Warming offers Inherit, Off, On, the fixed totals and Custom…", () => {
  const choices = modelFieldChoices("warming", { now: "off", everyModel: false })
  expect(choices.map((choice) => choice.title)).toEqual([
    "Inherit", "Off", "On", "15m", "30m", "45m", "1h", "1h30m", "2h", "4h", "8h", "Custom…",
  ])
  expect(choices.map((choice) => choice.value)).toEqual(["", "off", "on", "15m", "30m", "45m", "1h", "1h30m", "2h", "4h", "8h", CUSTOM_CHOICE])
})

test("Ping every's Inherit names the value it falls back to, then the lifetime's list and Custom…", () => {
  const choices = modelFieldChoices("interval", { now: "4m · built-in", lifetime: 1_800_000, everyModel: false })
  expect(choices.map((choice) => choice.title)).toEqual(["Inherit (now 4m · built-in)", "5m", "10m", "15m", "20m", "25m", "Custom…"])
  expect(choices[0]?.value).toBe("")
  expect(choices.at(-1)?.value).toBe(CUSTOM_CHOICE)
})

test("Warm while waiting's Inherit names the value it falls back to, then Off, the fixed times and Custom…", () => {
  const choices = modelFieldChoices("waiting", { now: "2h · built-in", everyModel: false })
  expect(choices.map((choice) => choice.title)).toEqual(["Inherit (now 2h · built-in)", "Off", "1h", "1h30m", "2h", "3h", "4h", "8h", "Custom…"])
  expect(choices.map((choice) => choice.value)).toEqual(["", "off", "1h", "1h30m", "2h", "3h", "4h", "8h", CUSTOM_CHOICE])
})

test("Effort offers the model's variants, and Every model adds Custom… since it has none of its own", () => {
  const model = modelFieldChoices("effort", { now: "", variants: ["low", "high"], everyModel: false })
  expect(model.map((choice) => choice.title)).toEqual(["(inherit / none)", "high", "low"])
  const every = modelFieldChoices("effort", { now: "", everyModel: true })
  expect(every.map((choice) => choice.title)).toEqual(["(inherit / none)", "Custom…"])
})

test.each([false, true])("Warm as subagent offers Inherit, Off, On, its times and Custom… (Every model: %s)", (everyModel) => {
  expect(modelFieldChoices("subagent", { now: "off · built-in", everyModel })).toEqual([
    { title: "Inherit (now off · built-in)", value: "" },
    { title: "Off", value: "off" },
    { title: "On", value: "on", description: "keeps the Warming time" },
    ...["5m", "10m", "15m", "30m", "45m", "1h", "2h"].map((time) => ({ title: time, value: time })),
    { title: "Custom…", value: CUSTOM_CHOICE },
  ])
})
