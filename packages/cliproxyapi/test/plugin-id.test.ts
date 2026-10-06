import { expect, test } from "bun:test"
import ServerPlugin, { ID } from "../src/index.js"
import TuiPlugin from "../src/tui.js"

// Plugin storage, the cached catalogue and quota bindings are keyed by plugin
// ID, so both halves must keep the plus-era ID through the package move.
test("server and TUI halves keep the opencode.plus.cliproxyapi plugin id", () => {
  expect(ID).toBe("opencode.plus.cliproxyapi")
  expect(ServerPlugin.id).toBe("opencode.plus.cliproxyapi")
  expect(TuiPlugin.id).toBe("opencode.plus.cliproxyapi")
})
