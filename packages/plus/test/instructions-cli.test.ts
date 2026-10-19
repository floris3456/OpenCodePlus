import { describe, expect, test } from "bun:test"
import {
  isRefusal,
  listOps,
  runOp,
  unknownOpMessage,
  type InstructionActor,
  type InstructionCliRegistry,
} from "../src/instructions-cli"

function registry(): { registry: InstructionCliRegistry; seen: Array<{ input: unknown; actor: InstructionActor }> } {
  const seen: Array<{ input: unknown; actor: InstructionActor }> = []
  return {
    seen,
    registry: {
      read: {
        description: "Read one row",
        inputSchema: {
          type: "object",
          properties: { id: { type: "string", description: "Row id" } },
          required: ["id"],
        },
        run: async (input, actor) => {
          seen.push({ input, actor })
          return { id: (input as { id: string }).id, text: "hello" }
        },
      },
      find: {
        description: "Filter rows",
        inputSchema: { type: "object", properties: { limit: { type: "number" } } },
        run: async (input) => ({ rows: [], input }),
      },
    },
  }
}

describe("instructions-cli registry", () => {
  test("lists ops alphabetically with descriptions and input schemas", () => {
    const ops = listOps(registry().registry)
    expect(ops.map((op) => op.op)).toEqual(["find", "read"])
    expect(ops[1]).toEqual({
      op: "read",
      description: "Read one row",
      input: {
        type: "object",
        properties: { id: { type: "string", description: "Row id" } },
        required: ["id"],
      },
    })
  })

  test("runs an op and records the actor as cli", async () => {
    const fixture = registry()
    const result = await runOp(fixture.registry, "read", { id: "abc" })
    expect(result).toEqual({ id: "abc", text: "hello" })
    expect(fixture.seen).toEqual([{ input: { id: "abc" }, actor: { type: "cli" } }])
  })

  test("refuses an unknown op naming the known ones", async () => {
    const result = await runOp(registry().registry, "move", {})
    expect(result).toEqual({ error: { message: 'op.unknown: unknown op "move" (known: find, read)' } })
    expect(unknownOpMessage("move", registry().registry)).toContain("known: find, read")
  })

  test("turns a thrown op error into a refusal", async () => {
    const failing: InstructionCliRegistry = {
      delete: {
        description: "Delete a row",
        inputSchema: { type: "object", properties: {} },
        run: async () => {
          throw new Error("row.unknown: no such row")
        },
      },
      reset: {
        description: "Reset a row",
        inputSchema: { type: "object", properties: {} },
        run: async () => {
          // oxlint-disable-next-line typescript-eslint/only-throw-error
          throw "plain refusal"
        },
      },
    }
    expect(await runOp(failing, "delete", {})).toEqual({ error: { message: "row.unknown: no such row" } })
    expect(await runOp(failing, "reset", {})).toEqual({ error: { message: "plain refusal" } })
  })

  test("recognises refusals by value", () => {
    expect(isRefusal({ error: { message: "nope" } })).toBe(true)
    expect(isRefusal({ id: "abc" })).toBe(false)
    expect(isRefusal({ error: { message: 42 } })).toBe(false)
    expect(isRefusal(null)).toBe(false)
    expect(isRefusal("op.unknown")).toBe(false)
  })
})
