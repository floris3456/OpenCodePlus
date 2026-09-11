import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Plus } from "../src/rpc.js"

test("definition id, methods, and events contract", () => {
  expect(Plus.Definition.id).toBe("opencode.plus")
  expect("project.status" in Plus.Definition.methods).toBe(true)
  expect("project.enable" in Plus.Definition.methods).toBe(true)
  expect("project.disable" in Plus.Definition.methods).toBe(true)
  expect("project.changed" in Plus.Definition.events).toBe(true)
})

test("status schema round-trip", () => {
  const status = { enabled: true, directory: "/path/to/project" }
  const encoded = Schema.encodeSync(Plus.Status)(status)
  const decoded = Schema.decodeUnknownSync(Plus.Status)(encoded)
  expect(decoded).toEqual(status)

  const disabledStatus = { enabled: false, directory: "/another/dir" }
  const encodedDisabled = Schema.encodeSync(Plus.Status)(disabledStatus)
  const decodedDisabled = Schema.decodeUnknownSync(Plus.Status)(encodedDisabled)
  expect(decodedDisabled).toEqual(disabledStatus)
})
