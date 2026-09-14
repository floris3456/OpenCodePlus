import { expect, test } from "bun:test"
import fs from "node:fs"
import path from "node:path"
import { selfCommand, serviceDirectory } from "../src/util/process"

test("exported service directory is the package root containing package.json and tsconfig.json under a bun runtime", () => {
  const dir = serviceDirectory()
  expect(dir.endsWith(path.join("packages", "cli"))).toBe(true)
  expect(fs.existsSync(path.join(dir, "package.json"))).toBe(true)
  expect(fs.existsSync(path.join(dir, "tsconfig.json"))).toBe(true)
})

test("selfCommand is unchanged under a bun runtime", () => {
  const entrypoint = path.resolve(process.argv[1]!)
  expect(selfCommand()).toEqual([process.execPath, entrypoint])
})
