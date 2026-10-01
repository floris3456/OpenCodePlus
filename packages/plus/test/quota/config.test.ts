import { expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { quotaConfig } from "../../src/quota/config.js"

test("built-in quota activation reads only the explicit host config root", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "quota-config-"))
  try {
    expect(await quotaConfig(undefined, directory)).toBeUndefined()
    await Bun.write(path.join(directory, "quota-handoff.json"), '{"routes":{"proxy":"https://proxy.invalid"}}')
    expect(await quotaConfig(undefined, directory)).toEqual({ routes: { proxy: "https://proxy.invalid" } })
    expect(await quotaConfig({ routes: { embedded: "https://embed.invalid" } }, directory)).toEqual({
      routes: { embedded: "https://embed.invalid" },
    })
    await Bun.write(path.join(directory, "quota-handoff.json"), '{"routes":{"proxy":42}}')
    await expect(quotaConfig(undefined, directory)).rejects.toThrow()
  } finally {
    await rm(directory, { recursive: true })
  }
})
