import { describe, expect, test } from "bun:test"
import type { ModelInfo, SessionMessageInfo } from "@opencode/client"
import { contextUsage, lastAssistantWithUsage, sessionFamily, usageWindow } from "../../src/util/session"

const assistant = (id: string, input: number): SessionMessageInfo => ({
  id,
  type: "assistant",
  agent: "build",
  model: { id: "model", providerID: "provider" },
  content: [],
  tokens: { input, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: 0 },
})

describe("util.session", () => {
  test("flattens nested subagents from any session in the family", () => {
    const sessions = [
      { id: "root" },
      { id: "child-a", parentID: "root" },
      { id: "grandchild-a", parentID: "child-a" },
      { id: "great-grandchild-a", parentID: "grandchild-a" },
      { id: "grandchild-a2", parentID: "child-a" },
      { id: "child-b", parentID: "root" },
      { id: "grandchild-b", parentID: "child-b" },
    ]

    expect(sessionFamily(sessions, "great-grandchild-a")).toEqual([
      { session: sessions[1], prefix: "" },
      { session: sessions[2], prefix: "├─ " },
      { session: sessions[3], prefix: "│  └─ " },
      { session: sessions[4], prefix: "└─ " },
      { session: sessions[5], prefix: "" },
      { session: sessions[6], prefix: "└─ " },
    ])
  })

  test("tracks usage across undo and redo boundaries", () => {
    const messages = [assistant("msg_z", 10), assistant("msg_a", 30)]

    expect(lastAssistantWithUsage(messages)?.tokens.input).toBe(30)
    expect(lastAssistantWithUsage(messages, "msg_a")?.tokens.input).toBe(10)
    expect(lastAssistantWithUsage(messages, "msg_missing")).toBeUndefined()
    expect(lastAssistantWithUsage(messages)?.tokens.input).toBe(30)
  })

  test("resets usage at completed compaction until the next assistant reports it", () => {
    const compaction: SessionMessageInfo = {
      id: "msg_compaction",
      type: "compaction",
      status: "completed",
      reason: "manual",
      summary: "Current state",
      recent: "",
      time: { created: 0 },
    }
    const messages = [assistant("msg_before", 30), compaction]

    expect(lastAssistantWithUsage(messages)).toBeUndefined()

    messages.push(assistant("msg_after", 5))
    expect(lastAssistantWithUsage(messages)?.tokens.input).toBe(5)
  })

  test("measures usage against the input limit when the model has one", () => {
    const model = (limit: ModelInfo["limit"]) => ({ id: "model", providerID: "provider", limit }) as ModelInfo
    const messages = [assistant("a", 136_000)]
    // 272k prompt budget inside a 400k window: half the budget is used, not a third of the window.
    expect(contextUsage(messages, [model({ context: 400_000, input: 272_000, output: 128_000 })])?.percent).toBe(50)
    expect(contextUsage(messages, [model({ context: 272_000, output: 128_000 })])?.percent).toBe(50)
    expect(contextUsage(messages, [model({ context: 0, output: 0 })])?.percent).toBeUndefined()
    expect(usageWindow(undefined)).toBeUndefined()
    expect(usageWindow({ context: 400_000, input: 0 })).toBe(400_000)
  })
})
