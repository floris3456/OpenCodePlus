import { expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect } from "effect"
import { applyPublishParts } from "../src/instructions/apply.js"
import type { PublishPartsInput } from "../src/instructions/apply.js"
import { checkAndEmitChangeNote, handlePromptBoundary, sessionPins, type PlanSet } from "../src/instructions/cache-safe.js"
import { fingerprint, type Item } from "../src/instructions/model.js"
import { fingerprintWireBody } from "../src/monitor/fingerprint.js"
import { context, modelInfo } from "./harness.js"
import type { Context } from "@opencode/plugin/effect/plugin"

function sessionEvent(
  sessionID: string,
  agentID: string,
  tools: SessionHooks["context"]["tools"],
  system: SessionHooks["context"]["system"],
  model = { providerID: "anthropic", id: "claude-3-5-sonnet" },
): SessionHooks["context"] {
  return {
    sessionID: Session.ID.make(sessionID),
    agent: Agent.ID.make(agentID),
    model: Model.Ref.make({
      providerID: Provider.ID.make(model.providerID),
      id: Model.ID.make(model.id),
    }),
    system,
    messages: [],
    options: {},
    tools,
  }
}

function makeItem(item: Partial<Item> & { id: string; kind: Item["kind"]; text: string }): Item {
  return {
    group: "native",
    title: item.id,
    enabled: true,
    fingerprint: fingerprint(item.text),
    ...item,
  }
}

type SessionRead = (sessionID: string) => Effect.Effect<{ readonly agent?: string }, unknown>

function createHarness(read: SessionRead = () => Effect.die("unused session.get")) {
  const contextCallbacks: Array<(event: SessionHooks["context"]) => Effect.Effect<void>> = []
  const synthetics: Array<{ sessionID: Session.ID; text: string; delivery?: string; resume?: boolean }> = []

  const ctx: Context = context({
    session: {
      hook: (name, callback) =>
        Effect.sync(() => {
          if (name === "context") contextCallbacks.push(callback as never)
          return { dispose: Effect.void }
        }),
      get: (input) => read(String(input.sessionID)) as never,
      synthetic: (input) =>
        Effect.sync(() => {
          synthetics.push(input as never)
          return { id: "syn_test" } as never
        }),
    },
    model: {
      list: () =>
        Effect.succeed({
          data: [
            modelInfo("anthropic", "claude-3-5-sonnet"),
            modelInfo("anthropic", "claude-3-haiku"),
          ],
          location: { directory: "/workspace" as never },
        }),
      default: () => Effect.succeed({ data: modelInfo("anthropic", "claude-3-5-sonnet"), location: { directory: "/workspace" as never } }),
      transform: () => Effect.succeed({ dispose: Effect.void }),
      reload: () => Effect.void,
    },
  })

  return { ctx, contextCallbacks, synthetics }
}

test("unchanged chat fingerprints identical over several turns", async () => {
  sessionPins.clear()
  const { ctx, contextCallbacks, synthetics } = createHarness()

  const state = { appliedParts: new Map() }
  const input: PublishPartsInput = {
    applyInput: {
      agents: [{ id: "alpha", level: "project" }],
      items: [
        makeItem({ id: "tool:reader", kind: "tool", text: "read files", enabled: true, agents: ["alpha"] }),
        makeItem({ id: "system:role", kind: "system", text: "You are helpful.\n\n## Rules\nBe nice.", enabled: true, agents: ["alpha"] }),
      ],
      records: [],
      splits: [],
      scopes: { global: new Set(), defaults: new Set() },
    },
  }

  await applyPublishParts(ctx, state, input)
  const hook = contextCallbacks.at(-1)!

  const turn1 = sessionEvent(
    "ses_unchanged",
    "alpha",
    { reader: { description: "read files", input: { type: "object" } } },
    [{ type: "text", text: "You are helpful.\n\n## Rules\nBe nice." }],
  )
  await Effect.runPromise(hook(turn1))
  const fp1 = fingerprintWireBody({
    system: turn1.system.map((s) => s.text).join("\n"),
    tools: Object.entries(turn1.tools).map(([name, t]) => ({ name, description: t.description })),
  })

  const turn2 = sessionEvent(
    "ses_unchanged",
    "alpha",
    { reader: { description: "read files", input: { type: "object" } } },
    [{ type: "text", text: "You are helpful.\n\n## Rules\nBe nice." }],
  )
  await Effect.runPromise(hook(turn2))
  const fp2 = fingerprintWireBody({
    system: turn2.system.map((s) => s.text).join("\n"),
    tools: Object.entries(turn2.tools).map(([name, t]) => ({ name, description: t.description })),
  })

  expect(fp2.bodyHash).toBe(fp1.bodyHash)
  expect(turn2.system).toEqual(turn1.system)
  expect(turn2.tools).toEqual(turn1.tools)
  expect(synthetics).toHaveLength(0)
})

test("a system-row or role change keeps prefix fingerprints and admits exactly one steered note", async () => {
  sessionPins.clear()
  const { ctx, contextCallbacks, synthetics } = createHarness()

  const state = { appliedParts: new Map() }
  const input1: PublishPartsInput = {
    applyInput: {
      agents: [{ id: "alpha", level: "project" }],
      items: [
        makeItem({ id: "tool:reader", kind: "tool", text: "read files", enabled: true, agents: ["alpha"] }),
        makeItem({ id: "system:role", kind: "system", text: "You are helpful.\n\n## Rules\nBe nice.", enabled: true, agents: ["alpha"] }),
      ],
      records: [],
      splits: [],
      scopes: { global: new Set(), defaults: new Set() },
    },
  }

  await applyPublishParts(ctx, state, input1)
  let hook = contextCallbacks.at(-1)!

  // Turn 1: establish pin
  const turn1 = sessionEvent(
    "ses_midchat",
    "alpha",
    { reader: { description: "read files", input: { type: "object" } } },
    [{ type: "text", text: "You are helpful.\n\n## Rules\nBe nice." }],
  )
  await Effect.runPromise(hook(turn1))
  const fp1 = fingerprintWireBody({
    system: turn1.system.map((s) => s.text).join("\n"),
    tools: Object.entries(turn1.tools).map(([name, t]) => ({ name, description: t.description })),
  })

  // Mid-chat change: edit ## Rules section in role
  const input2: PublishPartsInput = {
    applyInput: {
      agents: [{ id: "alpha", level: "project" }],
      items: [
        makeItem({ id: "tool:reader", kind: "tool", text: "read files", enabled: true, agents: ["alpha"] }),
        makeItem({ id: "system:role", kind: "system", text: "You are helpful.\n\n## Rules\nSpeak like a pirate.", enabled: true, agents: ["alpha"] }),
      ],
      records: [],
      splits: [],
      scopes: { global: new Set(), defaults: new Set() },
    },
  }
  await applyPublishParts(ctx, state, input2)
  hook = contextCallbacks.at(-1)!

  // Turn 2: next request in same session
  const turn2 = sessionEvent(
    "ses_midchat",
    "alpha",
    { reader: { description: "read files", input: { type: "object" } } },
    [{ type: "text", text: "You are helpful.\n\n## Rules\nSpeak like a pirate." }], // live system prompt from agent
  )
  await Effect.runPromise(hook(turn2))
  const fp2 = fingerprintWireBody({
    system: turn2.system.map((s) => s.text).join("\n"),
    tools: Object.entries(turn2.tools).map(([name, t]) => ({ name, description: t.description })),
  })

  // Prefix fingerprints are unchanged!
  expect(fp2.bodyHash).toBe(fp1.bodyHash)
  expect(turn2.system[0]?.text).toBe(turn1.system[0]?.text)

  // Exactly one note admitted
  expect(synthetics).toHaveLength(1)
  expect(synthetics[0].text).toContain("replaces the earlier text")
  expect(synthetics[0].text).toContain("Speak like a pirate")

  // The steered synthetic is the only delivery: no copy in the request messages
  expect(synthetics[0]?.delivery).toBe("steer")
  expect(turn2.messages).toHaveLength(0)
})

test("a mid-chat plan change is admitted once as a steered synthetic and never copied into messages", async () => {
  sessionPins.clear()
  const { ctx, contextCallbacks, synthetics } = createHarness()

  const state = { appliedParts: new Map() }
  const input1: PublishPartsInput = {
    applyInput: {
      agents: [{ id: "alpha", level: "project" }],
      items: [
        makeItem({ id: "tool:reader", kind: "tool", text: "read files", enabled: true, agents: ["alpha"] }),
        makeItem({ id: "system:role", kind: "system", text: "You are helpful.", enabled: true, agents: ["alpha"] }),
      ],
      records: [],
      splits: [],
      scopes: { global: new Set(), defaults: new Set() },
    },
  }

  await applyPublishParts(ctx, state, input1)
  let hook = contextCallbacks.at(-1)!

  const turn1 = sessionEvent(
    "ses_note_shape",
    "alpha",
    { reader: { description: "read files", input: { type: "object" } } },
    [{ type: "text", text: "You are helpful." }],
  )
  await Effect.runPromise(hook(turn1))
  expect(turn1.messages).toHaveLength(0)

  // Mid-chat change: a permission row flips, like the crash report
  const input2: PublishPartsInput = {
    applyInput: {
      agents: [{ id: "alpha", level: "project" }],
      items: [
        makeItem({ id: "tool:reader", kind: "tool", text: "read files", enabled: false, agents: ["alpha"] }),
        makeItem({ id: "system:role", kind: "system", text: "You are helpful.", enabled: true, agents: ["alpha"] }),
      ],
      records: [],
      splits: [],
      scopes: { global: new Set(), defaults: new Set() },
    },
  }
  await applyPublishParts(ctx, state, input2)
  hook = contextCallbacks.at(-1)!

  const turn2 = sessionEvent(
    "ses_note_shape",
    "alpha",
    { reader: { description: "read files", input: { type: "object" } } },
    [{ type: "text", text: "You are helpful." }],
  )
  await Effect.runPromise(hook(turn2))

  // The note is admitted once, as a steered synthetic, and is not copied into
  // the request messages: the host delivers it at the next step boundary.
  expect(synthetics).toHaveLength(1)
  expect(synthetics[0]?.delivery).toBe("steer")
  expect(turn2.messages).toHaveLength(0)

  // The next request with the same plan carries no copy and admits nothing more
  const turn3 = sessionEvent(
    "ses_note_shape",
    "alpha",
    { reader: { description: "read files", input: { type: "object" } } },
    [{ type: "text", text: "You are helpful." }],
  )
  await Effect.runPromise(hook(turn3))
  expect(turn3.messages).toHaveLength(0)
  expect(synthetics).toHaveLength(1)
})

test("folding in after compaction / model switch / new chat", async () => {
  sessionPins.clear()
  const { ctx, contextCallbacks, synthetics } = createHarness()

  const state = { appliedParts: new Map() }
  const input1: PublishPartsInput = {
    applyInput: {
      agents: [{ id: "alpha", level: "project" }],
      items: [
        makeItem({ id: "tool:reader", kind: "tool", text: "read files", enabled: true, agents: ["alpha"] }),
        makeItem({ id: "system:role", kind: "system", text: "You are helpful.\n\n## Rules\nBe nice.", enabled: true, agents: ["alpha"] }),
      ],
      records: [],
      splits: [],
      scopes: { global: new Set(), defaults: new Set() },
    },
  }

  await applyPublishParts(ctx, state, input1)
  let hook = contextCallbacks.at(-1)!

  // Turn 1
  const turn1 = sessionEvent(
    "ses_folding",
    "alpha",
    { reader: { description: "read files", input: { type: "object" } } },
    [{ type: "text", text: "You are helpful.\n\n## Rules\nBe nice." }],
  )
  await Effect.runPromise(hook(turn1))

  // Edit role
  const input2: PublishPartsInput = {
    applyInput: {
      agents: [{ id: "alpha", level: "project" }],
      items: [
        makeItem({ id: "tool:reader", kind: "tool", text: "read files", enabled: true, agents: ["alpha"] }),
        makeItem({ id: "system:role", kind: "system", text: "You are helpful.\n\n## Rules\nBe concise.", enabled: true, agents: ["alpha"] }),
      ],
      records: [],
      splits: [],
      scopes: { global: new Set(), defaults: new Set() },
    },
  }
  await applyPublishParts(ctx, state, input2)
  hook = contextCallbacks.at(-1)!

  // Turn 2 with pin: note emitted
  const turn2 = sessionEvent(
    "ses_folding",
    "alpha",
    { reader: { description: "read files", input: { type: "object" } } },
    [{ type: "text", text: "You are helpful.\n\n## Rules\nBe concise." }],
  )
  await Effect.runPromise(hook(turn2))
  expect(synthetics).toHaveLength(1)

  // 1. Compaction rebuild moment
  sessionPins.markRebuild("ses_folding")
  synthetics.length = 0

  const turn3 = sessionEvent(
    "ses_folding",
    "alpha",
    { reader: { description: "read files", input: { type: "object" } } },
    [{ type: "text", text: "You are helpful.\n\n## Rules\nBe concise." }],
  )
  await Effect.runPromise(hook(turn3))
  // After compaction: change is part of system text, notes are gone!
  expect(turn3.system[0]?.text).toContain("Be concise.")
  expect(synthetics).toHaveLength(0)

  // 2. Model switch rebuild moment
  const turnModelSwitch = sessionEvent(
    "ses_folding",
    "alpha",
    { reader: { description: "read files", input: { type: "object" } } },
    [{ type: "text", text: "You are helpful.\n\n## Rules\nBe concise." }],
    { providerID: "anthropic", id: "claude-3-haiku" },
  )
  await Effect.runPromise(hook(turnModelSwitch))
  expect(turnModelSwitch.system[0]?.text).toContain("Be concise.")
  expect(synthetics).toHaveLength(0)

  // 3. New chat starts cleanly with current text
  const turnNewChat = sessionEvent(
    "ses_new",
    "alpha",
    { reader: { description: "read files", input: { type: "object" } } },
    [{ type: "text", text: "You are helpful.\n\n## Rules\nBe concise." }],
  )
  await Effect.runPromise(hook(turnNewChat))
  expect(turnNewChat.system[0]?.text).toContain("Be concise.")
  expect(synthetics).toHaveLength(0)
})

test("a turned-off tool is refused at once while still listed", async () => {
  sessionPins.clear()
  const { ctx, contextCallbacks, synthetics } = createHarness()

  const state = { appliedParts: new Map() }
  const input1: PublishPartsInput = {
    applyInput: {
      agents: [{ id: "alpha", level: "project" }],
      items: [
        makeItem({ id: "tool:reader", kind: "tool", text: "read files", enabled: true, agents: ["alpha"] }),
        makeItem({ id: "tool:writer", kind: "tool", text: "write files", enabled: true, agents: ["alpha"] }),
      ],
      records: [],
      splits: [],
      scopes: { global: new Set(), defaults: new Set() },
    },
  }

  await applyPublishParts(ctx, state, input1)
  let hook = contextCallbacks.at(-1)!

  // Turn 1
  const turn1 = sessionEvent(
    "ses_tool_off",
    "alpha",
    {
      reader: { description: "read files", input: { type: "object" } },
      writer: { description: "write files", input: { type: "object" } },
    },
    [{ type: "text", text: "system" }],
  )
  await Effect.runPromise(hook(turn1))
  expect(turn1.tools.writer).toBeDefined()

  // Tool "writer" turned off mid-chat
  const input2: PublishPartsInput = {
    applyInput: {
      agents: [{ id: "alpha", level: "project" }],
      items: [
        makeItem({ id: "tool:reader", kind: "tool", text: "read files", enabled: true, agents: ["alpha"] }),
        makeItem({ id: "tool:writer", kind: "tool", text: "write files", enabled: false, agents: ["alpha"] }),
      ],
      records: [],
      splits: [],
      scopes: { global: new Set(), defaults: new Set() },
    },
  }

  await applyPublishParts(ctx, state, input2)
  hook = contextCallbacks.at(-1)!

  // Turn 2
  const turn2 = sessionEvent(
    "ses_tool_off",
    "alpha",
    {
      reader: { description: "read files", input: { type: "object" } },
      writer: { description: "write files", input: { type: "object" } },
    },
    [{ type: "text", text: "system" }],
  )
  await Effect.runPromise(hook(turn2))

  // Tool is still listed in prompt prefix!
  expect(turn2.tools.writer).toBeDefined()
  expect(turn2.tools.reader).toBeDefined()

  // Synthetic note tells model it is refused from now on
  expect(synthetics).toHaveLength(1)
  expect(synthetics[0].text).toContain("writer")
  expect(synthetics[0].text).toContain("refused from now on")
})

test("a native tool switched on appears only after a rebuild moment", async () => {
  sessionPins.clear()
  const { ctx, contextCallbacks, synthetics } = createHarness()

  const state = { appliedParts: new Map() }
  const input1: PublishPartsInput = {
    applyInput: {
      agents: [{ id: "alpha", level: "project" }],
      items: [
        makeItem({ id: "tool:reader", kind: "tool", text: "read files", enabled: true, agents: ["alpha"] }),
        makeItem({ id: "tool:finder", kind: "tool", text: "find files", enabled: false, agents: ["alpha"] }),
      ],
      records: [],
      splits: [],
      scopes: { global: new Set(), defaults: new Set() },
    },
  }

  await applyPublishParts(ctx, state, input1)
  let hook = contextCallbacks.at(-1)!

  // Turn 1
  const turn1 = sessionEvent(
    "ses_tool_on",
    "alpha",
    {
      reader: { description: "read files", input: { type: "object" } },
      finder: { description: "find files", input: { type: "object" } },
    },
    [{ type: "text", text: "system" }],
  )
  await Effect.runPromise(hook(turn1))
  expect(turn1.tools.finder).toBeUndefined()

  // Tool "finder" switched on mid-chat
  const input2: PublishPartsInput = {
    applyInput: {
      agents: [{ id: "alpha", level: "project" }],
      items: [
        makeItem({ id: "tool:reader", kind: "tool", text: "read files", enabled: true, agents: ["alpha"] }),
        makeItem({ id: "tool:finder", kind: "tool", text: "find files", enabled: true, agents: ["alpha"] }),
      ],
      records: [],
      splits: [],
      scopes: { global: new Set(), defaults: new Set() },
    },
  }

  await applyPublishParts(ctx, state, input2)
  hook = contextCallbacks.at(-1)!

  // Turn 2: still pinned, finder must NOT appear in tools yet
  const turn2 = sessionEvent(
    "ses_tool_on",
    "alpha",
    {
      reader: { description: "read files", input: { type: "object" } },
      finder: { description: "find files", input: { type: "object" } },
    },
    [{ type: "text", text: "system" }],
  )
  await Effect.runPromise(hook(turn2))
  expect(turn2.tools.finder).toBeUndefined()

  // Note indicates it will be available after the next rebuild
  expect(synthetics).toHaveLength(1)
  expect(synthetics[0].text).toContain("finder")
  expect(synthetics[0].text).toContain("available after the next rebuild")

  // Rebuild moment (compaction)
  sessionPins.markRebuild("ses_tool_on")
  const turn3 = sessionEvent(
    "ses_tool_on",
    "alpha",
    {
      reader: { description: "read files", input: { type: "object" } },
      finder: { description: "find files", input: { type: "object" } },
    },
    [{ type: "text", text: "system" }],
  )
  await Effect.runPromise(hook(turn3))

  // Now finder appears!
  expect(turn3.tools.finder).toBeDefined()
})

test("several page edits produce one update message when the page closes", async () => {
  sessionPins.clear()
  const { ctx, contextCallbacks, synthetics } = createHarness()

  const state = { appliedParts: new Map() }
  const input1: PublishPartsInput = {
    applyInput: {
      agents: [{ id: "alpha", level: "project" }],
      items: [
        makeItem({ id: "tool:reader", kind: "tool", text: "read files", enabled: true, agents: ["alpha"] }),
        makeItem({ id: "tool:writer", kind: "tool", text: "write files", enabled: true, agents: ["alpha"] }),
        makeItem({ id: "system:role", kind: "system", text: "You are helpful.\n\n## Personality\nFormal.", enabled: true, agents: ["alpha"] }),
      ],
      records: [],
      splits: [],
      scopes: { global: new Set(), defaults: new Set() },
    },
  }

  await applyPublishParts(ctx, state, input1)
  let hook = contextCallbacks.at(-1)!

  // Establish pin
  const turn1 = sessionEvent(
    "ses_burst",
    "alpha",
    {
      reader: { description: "read files", input: { type: "object" } },
      writer: { description: "write files", input: { type: "object" } },
    },
    [{ type: "text", text: "You are helpful.\n\n## Personality\nFormal." }],
  )
  await Effect.runPromise(hook(turn1))

  // Burst of edits 1: tool writer disabled
  const input2: PublishPartsInput = {
    applyInput: {
      agents: [{ id: "alpha", level: "project" }],
      items: [
        makeItem({ id: "tool:reader", kind: "tool", text: "read files", enabled: true, agents: ["alpha"] }),
        makeItem({ id: "tool:writer", kind: "tool", text: "write files", enabled: false, agents: ["alpha"] }),
        makeItem({ id: "system:role", kind: "system", text: "You are helpful.\n\n## Personality\nFormal.", enabled: true, agents: ["alpha"] }),
      ],
      records: [],
      splits: [],
      scopes: { global: new Set(), defaults: new Set() },
    },
  }
  await applyPublishParts(ctx, state, input2)

  // Burst of edits 2: role personality changed
  const input3: PublishPartsInput = {
    applyInput: {
      agents: [{ id: "alpha", level: "project" }],
      items: [
        makeItem({ id: "tool:reader", kind: "tool", text: "read files", enabled: true, agents: ["alpha"] }),
        makeItem({ id: "tool:writer", kind: "tool", text: "write files", enabled: false, agents: ["alpha"] }),
        makeItem({ id: "system:role", kind: "system", text: "You are helpful.\n\n## Personality\nCasual.", enabled: true, agents: ["alpha"] }),
      ],
      records: [],
      splits: [],
      scopes: { global: new Set(), defaults: new Set() },
    },
  }
  await applyPublishParts(ctx, state, input3)
  hook = contextCallbacks.at(-1)!

  // Next request occurs: exactly ONE combined synthetic note
  const turn2 = sessionEvent(
    "ses_burst",
    "alpha",
    {
      reader: { description: "read files", input: { type: "object" } },
      writer: { description: "write files", input: { type: "object" } },
    },
    [{ type: "text", text: "You are helpful.\n\n## Personality\nCasual." }],
  )
  await Effect.runPromise(hook(turn2))

  expect(synthetics).toHaveLength(1)
  expect(synthetics[0].text).toContain("writer")
  expect(synthetics[0].text).toContain("refused from now on")
  expect(synthetics[0].text).toContain("Personality")
  expect(synthetics[0].text).toContain("Casual")
})

const READER = { reader: { description: "read files", input: { type: "object" } } } as const

function alphaPlan(role: string | undefined, readerEnabled = true): PublishPartsInput {
  const roleItems =
    role === undefined ? [] : [makeItem({ id: "system:role", kind: "system", text: role, enabled: true, agents: ["alpha"] })]
  return {
    applyInput: {
      agents: [{ id: "alpha", level: "project" }],
      items: [
        makeItem({ id: "tool:reader", kind: "tool", text: "read files", enabled: readerEnabled, agents: ["alpha"] }),
        ...roleItems,
      ],
      records: [],
      splits: [],
      scopes: { global: new Set(), defaults: new Set() },
    },
  }
}

function twoAgentPlan(roleA: string, roleB: string): PublishPartsInput {
  return {
    applyInput: {
      agents: [
        { id: "A", level: "project" },
        { id: "B", level: "project" },
      ],
      items: [
        makeItem({ id: "system:role", kind: "system", text: roleA, enabled: true, agents: ["A"] }),
        makeItem({ id: "system:role", kind: "system", text: roleB, enabled: true, agents: ["B"] }),
      ],
      records: [],
      splits: [],
      scopes: { global: new Set(), defaults: new Set() },
    },
  }
}

test("a prompt boundary announces only the session's own agent", async () => {
  sessionPins.clear()
  const { ctx, contextCallbacks, synthetics } = createHarness(() => Effect.succeed({ agent: "B" }))
  const state = { appliedParts: new Map(), currentPlanSet: undefined as PlanSet | undefined }

  await applyPublishParts(ctx, state, twoAgentPlan("Role A v1.", "Role B v1."))
  const hook = contextCallbacks.at(-1)!
  await Effect.runPromise(hook(sessionEvent("ses_boundary", "B", {}, [{ type: "text", text: "Role B v1." }])))

  // Agent A's role changes, but this session belongs to B
  await applyPublishParts(ctx, state, twoAgentPlan("Role A v2.", "Role B v1."))
  await Effect.runPromise(handlePromptBoundary(ctx, state, "ses_boundary"))
  expect(synthetics).toHaveLength(0)

  // Agent B's role changes: one note, about B only
  await applyPublishParts(ctx, state, twoAgentPlan("Role A v2.", "Role B v2."))
  await Effect.runPromise(handlePromptBoundary(ctx, state, "ses_boundary"))
  expect(synthetics).toHaveLength(1)
  expect(synthetics[0]?.text).toContain("Role B v2.")
  expect(synthetics[0]?.text).not.toContain("Role A")
})

test("a prompt boundary whose session read fails announces nothing and does not throw", async () => {
  sessionPins.clear()
  const { ctx, contextCallbacks, synthetics } = createHarness(() => Effect.fail("session unavailable"))
  const state = { appliedParts: new Map(), currentPlanSet: undefined as PlanSet | undefined }

  await applyPublishParts(ctx, state, twoAgentPlan("Role A v1.", "Role B v1."))
  const hook = contextCallbacks.at(-1)!
  await Effect.runPromise(hook(sessionEvent("ses_unread", "B", {}, [{ type: "text", text: "Role B v1." }])))

  await applyPublishParts(ctx, state, twoAgentPlan("Role A v1.", "Role B v2."))
  await Effect.runPromise(handlePromptBoundary(ctx, state, "ses_unread"))
  expect(synthetics).toHaveLength(0)
})

test("a role gained after the pin is adopted silently, and its later change is announced", async () => {
  sessionPins.clear()
  const { ctx, contextCallbacks, synthetics } = createHarness()
  const state = { appliedParts: new Map(), currentPlanSet: undefined as PlanSet | undefined }

  await applyPublishParts(ctx, state, alphaPlan(undefined))
  let hook = contextCallbacks.at(-1)!
  await Effect.runPromise(hook(sessionEvent("ses_gained", "alpha", READER, [{ type: "text", text: "You are helpful." }])))

  // The role appears: adopted into the pin, so no note is returned or admitted
  await applyPublishParts(ctx, state, alphaPlan("You are helpful.\n\n## Rules\nBe nice."))
  const note = await checkAndEmitChangeNote(ctx, sessionPins.getPin("ses_gained")!, state.currentPlanSet!, "alpha", "ses_gained")
  expect(note).toBeUndefined()
  hook = contextCallbacks.at(-1)!
  await Effect.runPromise(hook(sessionEvent("ses_gained", "alpha", READER, [{ type: "text", text: "You are helpful." }])))
  expect(synthetics).toHaveLength(0)

  // The role changes again: announced once, against the adopted text
  await applyPublishParts(ctx, state, alphaPlan("You are helpful.\n\n## Rules\nSpeak like a pirate."))
  hook = contextCallbacks.at(-1)!
  await Effect.runPromise(hook(sessionEvent("ses_gained", "alpha", READER, [{ type: "text", text: "You are helpful." }])))
  expect(synthetics).toHaveLength(1)
  expect(synthetics[0]?.text).toContain("Speak like a pirate")
})

test("a role gained alongside another change announces that change but not the role", async () => {
  sessionPins.clear()
  const { ctx, contextCallbacks, synthetics } = createHarness()
  const state = { appliedParts: new Map(), currentPlanSet: undefined as PlanSet | undefined }

  await applyPublishParts(ctx, state, alphaPlan(undefined, true))
  const hook = contextCallbacks.at(-1)!
  await Effect.runPromise(hook(sessionEvent("ses_gained_tool", "alpha", READER, [{ type: "text", text: "You are helpful." }])))

  await applyPublishParts(ctx, state, alphaPlan("You are helpful.\n\n## Rules\nBe nice.", false))
  await Effect.runPromise(contextCallbacks.at(-1)!(sessionEvent("ses_gained_tool", "alpha", READER, [{ type: "text", text: "You are helpful." }])))
  expect(synthetics).toHaveLength(1)
  expect(synthetics[0]?.text).toContain("reader")
  expect(synthetics[0]?.text).not.toContain("Be nice")
})
