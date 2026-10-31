import { expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
// Test-only, by path: plus must not depend on @opencode/core or codemode
// (tool-permissions.test.ts does the same). These are the functions that turn
// a registered tool into what the model is sent: the JSON schema of a direct
// tool and the TypeScript signature Code Mode's search returns.
import { definition } from "../../core/src/tool/runtime.js"
import { jsonSchemaToTypeScript } from "../../codemode/src/tool-schema.js"
import { createPlusApi, createState, deactivate } from "../src/index.js"
import { registerInstructionTools } from "../src/tools.js"
import { fullContext, toolHarness } from "./harness.js"

// What the instruction tools cost an agent before it calls one (cause 10).
// Phase 3 left them at 10,259 chars of descriptions and 27,775 of JSON input
// schema (20,369 as Code Mode signatures). DUMP_TOOL=<name> prints one schema.
test("the instruction tools' descriptions and input schemas stay small", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "tools-size-"))
  const previous = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const tools = toolHarness()
  const ctx = { ...fullContext({ directory: path.join(root, "project"), hooks: { current: 0 } }), tool: tools.domain }
  const state = createState()
  const registration = await registerInstructionTools(ctx, createPlusApi(ctx, state))
  const registered = [...tools.tools.values()].filter((tool) => tool.options?.namespace === "instructions")
  const rows = registered.map((tool) => {
    const schema = definition(tool).inputSchema
    if (process.env.DUMP_TOOL === tool.name) console.log(JSON.stringify(schema, null, 1))
    return { name: tool.name, description: tool.description.length, schema: JSON.stringify(schema).length, signature: jsonSchemaToTypeScript(schema, true).length }
  })
  await Effect.runPromise(registration.dispose)
  await Effect.runPromise(deactivate(state))
  if (previous === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = previous
  await fs.rm(root, { recursive: true, force: true })
  const total = (key: "description" | "schema" | "signature") => rows.reduce((sum, row) => sum + row[key], 0)
  console.log(JSON.stringify({ tools: rows.length, description: total("description"), schema: total("schema"), signature: total("signature"), rows }))
  expect(rows.length).toBe(14)
})
