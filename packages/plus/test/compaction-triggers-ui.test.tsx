import { expect, test } from "bun:test"
import { editCompactionTriggers, parseCompactionTrigger } from "../src/tui/compaction-triggers.js"
import { renderPlusFixture } from "./tui.js"

test("trigger token input preserves reset and rejects ambiguous or unsafe numbers", () => {
  expect(parseCompactionTrigger(" ")).toEqual({ value: null })
  expect(parseCompactionTrigger(" 120000 ")).toEqual({ value: 120000 })
  for (const value of ["0", "-1", "1.5", "1e5", "20k", "Infinity", "NaN", "9007199254740992"])
    expect(parseCompactionTrigger(value).error).toBeDefined()
})

test.each([
  { prompts: ["120000", "30000"], expected: { sessionID: "ses_triggers", input: 120000, output: 30000 } },
  { prompts: ["", ""], expected: { sessionID: "ses_triggers", input: null, output: null } },
])("both trigger fields save atomically without prompt submission: %j", async ({ prompts, expected }) => {
  const calls: unknown[] = []
  const action: { run?: () => Promise<void> } = {}
  await using fixture = await renderPlusFixture({
    snapshots: [],
    route: { type: "session", sessionID: "ses_triggers" },
    dialogs: { prompts },
    rpc: {
      "compaction.triggers": async () => ({ sessionID: "ses_triggers", input: 90000, output: 15000 }),
      "compaction.triggers.set": async (input: unknown) => {
        calls.push(input)
        return { sessionID: "ses_triggers", ...(expected.input === null ? {} : { input: expected.input }), ...(expected.output === null ? {} : { output: expected.output }) }
      },
    },
    render: (context) => { action.run = () => editCompactionTriggers(context); return null },
  })
  await action.run?.()
  expect(calls).toEqual([expected])
  expect(fixture.fake.toasts.at(-1)?.variant).toBe("success")
  expect(fixture.fake.toasts.at(-1)?.message).toContain("no message sent")
  expect(fixture.fake.dialogPrompts).toEqual([["Compaction input trigger · this chat"], ["Compaction output trigger · this chat"]])
  expect(fixture.fake.promptInputs.map((prompt) => prompt.value)).toEqual(["90000", "15000"])
  expect(fixture.fake.mutateInputs).toEqual([])
  expect(fixture.fake.snapshotCalls).toBe(0)
})

test.each([{ prompts: [undefined] }, { prompts: ["50000", undefined] }, { prompts: ["-1"] }, { prompts: ["50000", "1.5"] }])("cancel/invalid input never partially saves: %j", async ({ prompts }) => {
  const calls: unknown[] = []
  const action: { run?: () => Promise<void> } = {}
  await using fixture = await renderPlusFixture({
    snapshots: [],
    route: { type: "session", sessionID: "ses_triggers" },
    dialogs: { prompts },
    rpc: {
      "compaction.triggers": async () => ({ sessionID: "ses_triggers" }),
      "compaction.triggers.set": async (input: unknown) => { calls.push(input); return { sessionID: "ses_triggers" } },
    },
    render: (context) => { action.run = () => editCompactionTriggers(context); return null },
  })
  await action.run?.()
  expect(calls).toEqual([])
  expect(fixture.fake.toasts.some((toast) => toast.variant === "success")).toBe(false)
})

test("failed trigger persistence never reports applied", async () => {
  const action: { run?: () => Promise<void> } = {}
  await using fixture = await renderPlusFixture({
    snapshots: [],
    route: { type: "session", sessionID: "ses_triggers" },
    dialogs: { prompts: ["50000", "10000"] },
    rpc: {
      "compaction.triggers": async () => ({ sessionID: "ses_triggers" }),
      "compaction.triggers.set": async () => { throw new Error("synthetic storage refusal") },
    },
    render: (context) => { action.run = () => editCompactionTriggers(context); return null },
  })
  await action.run?.()
  expect(fixture.fake.toasts.at(-1)).toMatchObject({ variant: "error", message: "synthetic storage refusal" })
  expect(fixture.fake.toasts.some((toast) => toast.variant === "success")).toBe(false)
})
