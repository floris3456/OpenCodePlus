import { describe, expect, test } from "bun:test"
import type { ModelInfo, SessionMessageInfo } from "@opencode/client"
import { contextUsage, sessionFamily, usageWindow } from "../../src/util/session"
import { usageWindows } from "../../src/util/usage-window"

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

  test("measures usage against a plugin's window for the chat when it is below the model's", () => {
    const models = [{ id: "model", providerID: "provider", limit: { context: 400_000, input: 272_000 } } as ModelInfo]
    const messages = [assistant("a", 136_000)]
    const seen: unknown[] = []
    // An early compaction threshold of 160k for this agent on this model.
    const unregister = usageWindows.register((input) => {
      seen.push(input)
      return input.agent === "build" ? 160_000 : undefined
    })
    const raised = usageWindows.register(() => 300_000)
    try {
      expect(contextUsage(messages, models, undefined, "session")?.percent).toBe(85)
      expect(seen).toEqual([{ sessionID: "session", agent: "build", providerID: "provider", modelID: "model" }])
      // Without the chat no plugin is asked; a window above the model's own leaves it.
      expect(contextUsage(messages, models)?.percent).toBe(50)
      unregister()
      expect(contextUsage(messages, models, undefined, "session")?.percent).toBe(50)
      // A model without a known window still gets one.
      expect(contextUsage(messages, undefined, undefined, "session")?.percent).toBe(45)
    } finally {
      unregister()
      raised()
    }
    expect(contextUsage(messages, models, undefined, "session")?.percent).toBe(50)
  })
})
