import { expect, test } from "bun:test"
import { deactivateModel, ensureActivateModel, modelCandidates, resolveActiveModel, type ModelRecord } from "../src/instructions/model.js"

test("explicit model off masks inherited/upstream active selection without hiding or losing settings", () => {
  const scopes = { global: new Set(["alpha"]), defaults: new Set<string>() }
  const target = { providerID: "acme", modelID: "a" }
  const address = { level: "project" as const, agent: "alpha" }
  const models: ModelRecord[] = [{ type: "model", level: "global", agent: "alpha", ...target, active: true, warming: "on", prompt: "keep", compactWarm: "on", compactionInstructions: "C1", updated: "old" }]
  const off = deactivateModel(models, address, target, "new", scopes)
  const input = { ...address, models: off, scopes, upstream: target }
  expect(resolveActiveModel(input)).toBeUndefined()
  expect(modelCandidates(input)).toHaveLength(1)
  expect(off.find((record) => record.level === "project")).toMatchObject({ active: false, prompt: "keep", compactWarm: "on", compactionInstructions: "C1" })
  const on = ensureActivateModel(off, address, target, "again", { scopes, upstream: target })
  expect(resolveActiveModel({ ...input, models: on })).toMatchObject(target)
  expect(on.find((record) => record.level === "project")).toMatchObject({ active: true, prompt: "keep", compactionInstructions: "C1" })
  // Ordinary omission still falls through to the existing active model above.
  expect(resolveActiveModel({ ...input, models: off.map((record) => record.level === "project" ? { ...record, active: undefined } : record) })).toMatchObject(target)
})
