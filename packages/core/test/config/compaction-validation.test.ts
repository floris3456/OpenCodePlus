import { expect, test } from "bun:test"
import { ConfigNormalize } from "@opencode/core/config/normalize"

test("K1 misplaced model compaction.mode is diagnosed with the supported key", () => {
  const result = ConfigNormalize.normalize({ providers: { fixture: { models: { model: { compaction: { mode: "local" } } } } } })
  expect(result.diagnostics.some((d) => d.path.join(".").includes("compaction") && d.message.includes("settings.compaction.type"))).toBe(true)
})

test("K1 unknown keys alongside a valid model compaction policy are diagnosed", () => {
  const result = ConfigNormalize.normalize({ providers: { fixture: { models: { model: { settings: { compaction: { type: "summary", mode: "local" } } } } } } })
  expect(result.diagnostics.some((d) => d.path.at(-1) === "mode")).toBe(true)
})
