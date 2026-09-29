import { expect, test } from "bun:test"
import { App } from "@opencode/core/app"

test("formats app metadata as a user agent", () => {
  expect(App.useragent(App.make({ name: "sdk", version: "1.2.3", channel: "beta" }))).toBe("opencode/beta/1.2.3/sdk")
})

test("a derived build reports the OpenCode release it contains, with its own version as build metadata", () => {
  expect(App.useragent(App.make({ name: "cli", version: "0.0.0-plus-r5.0", channel: "plus", upstream: "2.0.18" }))).toBe(
    "opencode/plus/2.0.18+0.0.0-plus-r5.0/cli",
  )
  // The build's own version stays what every other surface shows.
  expect(App.make({ version: "0.0.0-plus-r5.0", upstream: "2.0.18" }).version).toBe("0.0.0-plus-r5.0")
})
