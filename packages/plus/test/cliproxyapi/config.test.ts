import { expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { cliproxyapiConfig } from "../../src/cliproxyapi/config.js"

test("cliproxyapi.json enables quota and catalogue by default; quota-handoff.json only quota", async () => {
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
      quota: { routes: { cpa: "https://cpa.invalid" } },
      catalog: {},
    })
    await Bun.write(
      path.join(directory, "cliproxyapi.json"),
      JSON.stringify({ routes: { cpa: "https://cpa.invalid" } }),
    )
    expect(await cliproxyapiConfig(directory)).toMatchObject({
      source: "cliproxyapi.json",
      quota: { routes: { cpa: "https://cpa.invalid" } },
      catalog: { cpa: "https://cpa.invalid" },
    })
    await Bun.write(
      path.join(directory, "cliproxyapi.json"),
      JSON.stringify({ routes: { cpa: "https://cpa.invalid" }, quota: false, catalog: false }),
    )
    expect(await cliproxyapiConfig(directory)).toMatchObject({ quota: undefined, catalog: {} })
    // The account-switch summary model and its fallback reach the quota controller's configuration.
    await Bun.write(
      path.join(directory, "cliproxyapi.json"),
      JSON.stringify({
        routes: { cpa: "https://cpa.invalid" },
        compactionModel: "cpa/deepseek-v4.1-flash-cheap",
        compactionFallback: "cpa/gemini-3.8-flash-high",
      }),
    )
    expect((await cliproxyapiConfig(directory))?.quota).toEqual({
      routes: { cpa: "https://cpa.invalid" },
      compactionModel: "cpa/deepseek-v4.1-flash-cheap",
      compactionFallback: "cpa/gemini-3.8-flash-high",
    })
    await Bun.write(path.join(directory, "cliproxyapi.json"), "{")
    await expect(cliproxyapiConfig(directory)).rejects.toThrow()
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})
