import { expect, test } from "bun:test"
import path from "node:path"
import { selfCommand, serviceDirectory } from "../src/util/process"

test("exported service directory is the directory containing the resolved CLI entrypoint under a bun runtime", () => {
  const entrypoint = path.resolve(process.argv[1]!)
  expect(serviceDirectory()).toBe(path.dirname(entrypoint))
})

test("selfCommand is unchanged under a bun runtime", () => {
  const entrypoint = path.resolve(process.argv[1]!)
  expect(selfCommand()).toEqual([process.execPath, entrypoint])
})
