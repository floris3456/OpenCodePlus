import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { cliproxyapiConfig } from "../src/config.js"

test("cliproxyapi.json syncs the catalogue by default and leaves quota to the CPA; quota-handoff.json forces quota on", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "cpa-config-"))
  try {
    expect(await cliproxyapiConfig(directory)).toBeUndefined()
    await Bun.write(
      path.join(directory, "quota-handoff.json"),
      JSON.stringify({ routes: { cpa: "https://cpa.invalid" } }),
    )
    expect(await cliproxyapiConfig(directory)).toEqual({
      source: "quota-handoff.json",
      routes: { cpa: "https://cpa.invalid" },
      quota: true,
      catalog: {},
    })
    await Bun.write(
      path.join(directory, "cliproxyapi.json"),
      JSON.stringify({ routes: { cpa: "https://cpa.invalid" } }),
    )
    // No `quota`: whether the CPA runs quota-handoff decides.
    expect(await cliproxyapiConfig(directory)).toMatchObject({
      source: "cliproxyapi.json",
      quota: undefined,
      catalog: { cpa: "https://cpa.invalid" },
    })
    await Bun.write(
      path.join(directory, "cliproxyapi.json"),
      JSON.stringify({ routes: { cpa: "https://cpa.invalid" }, quota: true }),
    )
    expect(await cliproxyapiConfig(directory)).toMatchObject({ quota: true, catalog: { cpa: "https://cpa.invalid" } })
    await Bun.write(
      path.join(directory, "cliproxyapi.json"),
      JSON.stringify({ routes: { cpa: "https://cpa.invalid" }, quota: false, catalog: false }),
    )
    expect(await cliproxyapiConfig(directory)).toMatchObject({ quota: false, catalog: {} })
    // The account-switch summary model and its fallback, for the quota controller.
    await Bun.write(
      path.join(directory, "cliproxyapi.json"),
      JSON.stringify({
        routes: { cpa: "https://cpa.invalid" },
        compactionModel: "cpa/deepseek-v4.1-flash-cheap",
        compactionFallback: "cpa/gemini-3.8-flash-high",
      }),
    )
    expect(await cliproxyapiConfig(directory)).toMatchObject({
      compactionModel: "cpa/deepseek-v4.1-flash-cheap",
      compactionFallback: "cpa/gemini-3.8-flash-high",
    })
    await Bun.write(path.join(directory, "cliproxyapi.json"), "{")
    await expect(cliproxyapiConfig(directory)).rejects.toThrow()
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
