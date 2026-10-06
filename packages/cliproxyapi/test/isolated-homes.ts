// Bun test preload (bunfig.toml): every test process gets its own config,
// data, state and cache homes, so a test that never isolates them cannot
// write into the real ones. Before this, team tests that delegate appended
// each temporary repository to the real linked-projects.json. A test that
// needs its own directory still sets it; this is only the floor.
import { afterAll } from "bun:test"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-test-homes-"))
for (const [key, dir] of [
  ["XDG_CONFIG_HOME", "config"],
  ["XDG_DATA_HOME", "data"],
  ["XDG_STATE_HOME", "state"],
  ["XDG_CACHE_HOME", "cache"],
] as const) {
  process.env[key] = path.join(root, dir)
  fs.mkdirSync(process.env[key]!, { recursive: true })
}
// An inherited override would point every unisolated test at a real config.
delete process.env.OPENCODE_CONFIG_DIR
// Bun does not run process "exit" handlers here; a preload's afterAll is
// global and runs once after every test of the process.
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))
