import { expect, test } from "bun:test"
import { Effect, Schema } from "effect"
import type { Info } from "@opencode/schema/tool"
import { definition } from "../src/tool/runtime"

test("the same tool replayed twice returns the identical inputSchema object", () => {
  const tool: Info = {
    name: "memo-tool",
    description: "Tool for testing inputSchema memoization",
    input: Schema.Struct({
      query: Schema.String,
      limit: Schema.optionalKey(Schema.Int),
    }),
    output: Schema.Struct({
      result: Schema.Array(Schema.String),
    }),
    execute: () => Effect.succeed({ content: "ok" }),
  }

  const def1 = definition(tool)
  const def2 = definition(tool)

  // Must return the identical object reference
  expect(def1.inputSchema).toBe(def2.inputSchema)
  expect(def1.outputSchema).toBe(def2.outputSchema)
})
