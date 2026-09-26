import { expect, test } from "bun:test"
import { Schema } from "effect"
import { Agent } from "../src/agent.js"
import { ConfigAgent } from "../src/config/agent.js"
import { Model } from "../src/model.js"

test("Agent.Color preserves configured colors at the public boundary", () => {
  const encode = Schema.encodeSync(Agent.Color)

  expect(encode("info")).toBe("info")
  expect(encode("custom-color")).toBe("custom-color")
})

test("agent and config compaction share the canonical optional policy", () => {
  const policy = {
    strategy: "local" as const,
    model: Model.Ref.parse("example/summary#low"),
    system: "Preserve unresolved decisions.",
  }
  const agent = { ...Agent.Info.default(Agent.ID.make("build")), compaction: policy }
  expect(Schema.decodeUnknownSync(Agent.Info)(agent).compaction).toEqual(policy)
  expect(Schema.decodeUnknownSync(ConfigAgent.Info)({ compaction: policy }).compaction).toEqual(policy)
  for (const strategy of ["auto", "local", "remote"] as const) {
    expect(Schema.decodeUnknownSync(Agent.Compaction)({ ...policy, strategy })).toEqual({ ...policy, strategy })
  }
  expect(() => Schema.decodeUnknownSync(Agent.Compaction)({ strategy: "unknown" })).toThrow()
  expect(() => Schema.decodeUnknownSync(ConfigAgent.Info)({ compaction: { system: 1 } })).toThrow()
  expect(() => Schema.decodeUnknownSync(Agent.Compaction)({ model: "example/summary" })).toThrow()
})

test("compaction encoding omits undefined fields without introducing defaults", () => {
  expect(Schema.encodeSync(Agent.Compaction)({ strategy: undefined, model: undefined, system: undefined })).toEqual({})
  expect(Schema.encodeSync(ConfigAgent.Info)(new ConfigAgent.Info({ compaction: undefined }))).toEqual({})
  expect(Schema.encodeSync(Agent.Info)(Agent.Info.default(Agent.ID.make("build")))).not.toHaveProperty("compaction")
  expect(Schema.encodeSync(ConfigAgent.Info)(new ConfigAgent.Info({ compaction: {} }))).toEqual({ compaction: {} })
})
