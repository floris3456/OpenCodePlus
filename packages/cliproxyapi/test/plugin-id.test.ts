import { expect, test } from "bun:test"
import ServerPlugin, { ID } from "../src/server.js"
import TuiPlugin from "../src/tui.js"

test("server and TUI are independently toggled as opencode-pacer", () => {
  expect(ID).toBe("opencode-pacer")
  expect(ServerPlugin.id).toBe("opencode-pacer")
  expect(TuiPlugin.id).toBe("opencode-pacer")
})
