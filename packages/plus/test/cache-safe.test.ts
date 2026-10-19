import { expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect } from "effect"
import { applyPublishParts } from "../src/instructions/apply.js"
import type { PublishPartsInput } from "../src/instructions/apply.js"
import {
  checkAndEmitChangeNote,
  computeChangeNote,
  createPlanSet,
  handlePromptBoundary,
  pinnedPermissions,
  SessionPinManager,
  sessionPins,
  sweepStoredPins,
  type PlanSet,
} from "../src/instructions/cache-safe.js"
import type { PermissionTable } from "../src/instructions/permission-enforce.js"
import { fingerprint, type Item } from "../src/instructions/model.js"
import { fingerprintWireBody } from "../src/monitor/fingerprint.js"
import { context, memoryStorage, modelInfo } from "./harness.js"
import type { Context } from "@opencode/plugin/effect/plugin"

function sessionEvent(
  sessionID: string,
  agentID: string,
  tools: SessionHooks["context"]["tools"],
  system: SessionHooks["context"]["system"],
  model: { providerID: string; id: string; variant?: string } = { providerID: "anthropic", id: "claude-3-5-sonnet" },
): SessionHooks["context"] {
  return {
    sessionID: Session.ID.make(sessionID),
    agent: Agent.ID.make(agentID),
    model: Model.Ref.make({
      providerID: Provider.ID.make(model.providerID),
      id: Model.ID.make(model.id),
      ...(model.variant ? { variant: Model.VariantID.make(model.variant) } : {}),
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
  const compactionCallbacks: Array<(event: SessionHooks["compaction"]) => Effect.Effect<void>> = []
  const synthetics: Array<{ sessionID: Session.ID; text: string; delivery?: string; resume?: boolean }> = []

  const ctx: Context = context({
    session: {
      hook: (name, callback) =>
        Effect.sync(() => {
          if (name === "context") contextCallbacks.push(callback as never)
          if (name === "compaction") compactionCallbacks.push(callback as never)
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

  return { ctx, contextCallbacks, compactionCallbacks, synthetics }
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
  await Effect.runPromise(sessionPins.markRebuild("ses_folding"))
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
  await Effect.runPromise(sessionPins.markRebuild("ses_tool_on"))
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
  const withRole = "You are helpful.\n\n## Rules\nBe nice."
  await applyPublishParts(ctx, state, alphaPlan(withRole))
  const note = await checkAndEmitChangeNote(ctx, sessionPins.getPin("ses_gained")!, state.currentPlanSet!, "alpha", "ses_gained")
  expect(note).toBeUndefined()
  hook = contextCallbacks.at(-1)!

  // The request after the adoption carries the role in its system prompt
  const adopted = sessionEvent("ses_gained", "alpha", READER, [{ type: "text", text: withRole }])
  await Effect.runPromise(hook(adopted))
  expect(adopted.system[0]?.text).toContain("Be nice.")
  expect(synthetics).toHaveLength(0)

  // The request after that keeps the same system prompt
  const following = sessionEvent("ses_gained", "alpha", READER, [{ type: "text", text: withRole }])
  await Effect.runPromise(hook(following))
  expect(following.system[0]?.text).toBe(adopted.system[0]?.text)
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

test("compaction hook shapes request from pin for same model and leaves others unchanged", async () => {
  sessionPins.clear()
  const { ctx, contextCallbacks, compactionCallbacks, synthetics } = createHarness()
  const state = { appliedParts: new Map(), currentPlanSet: undefined as PlanSet | undefined }

  const input1 = alphaPlan("You are helpful.\n\n## Rules\nBe nice.")
  await applyPublishParts(ctx, state, input1)
  const contextHook = contextCallbacks.at(-1)!

  // 1. Session pinned by one context-hook request
  const turn1 = sessionEvent(
    "ses_compact_cache",
    "alpha",
    { reader: { description: "read files", input: { type: "object" } } },
    [{ type: "text", text: "You are helpful.\n\n## Rules\nBe nice." }],
  )
  await Effect.runPromise(contextHook(turn1))

  const pin = sessionPins.getPin("ses_compact_cache")
  expect(pin).toBeDefined()
  const lastRequestAtBefore = pin!.lastRequestAt
  const lastNoteHashBefore = pin!.lastNoteHash

  // 2. Plan change (a role edit) that the next step would hold back as a note
  const input2 = alphaPlan("You are helpful.\n\n## Rules\nSpeak like a pirate.")
  await applyPublishParts(ctx, state, input2)
  const compactionHook = compactionCallbacks.at(-1)!
  expect(compactionHook).toBeDefined()

  // 3. Compaction-hook event with the same model whose system[0] is the agent's current raw system text and whose tools are the raw tools
  const compactionSameModel = sessionEvent(
    "ses_compact_cache",
    "alpha",
    { reader: { description: "read files", input: { type: "object" } } },
    [{ type: "text", text: "You are helpful.\n\n## Rules\nSpeak like a pirate." }],
  )
  await Effect.runPromise(compactionHook(compactionSameModel))

  // After the hook, its system parts and tool descriptions equal those of the step request the context hook produced
  // (pinned text, not the changed text)
  expect(compactionSameModel.system).toEqual(turn1.system)
  expect(compactionSameModel.tools).toEqual(turn1.tools)
  // No synthetic was admitted
  expect(synthetics).toHaveLength(0)
  // Pin's lastRequestAt and lastNoteHash are unchanged
  expect(pin!.lastRequestAt).toBe(lastRequestAtBefore)
  expect(pin!.lastNoteHash).toBe(lastNoteHashBefore)

  // 4. Another model on the compaction event: the event is left exactly as given
  const otherModelTools = { reader: { description: "read files", input: { type: "object" as const } } }
  const otherModelSystem = [{ type: "text" as const, text: "You are helpful.\n\n## Rules\nSpeak like a pirate." }]
  const compactionOtherModel = sessionEvent(
    "ses_compact_cache",
    "alpha",
    { ...otherModelTools },
    [...otherModelSystem],
    { providerID: "openai", id: "gpt-4o" },
  )
  await Effect.runPromise(compactionHook(compactionOtherModel))
  expect(compactionOtherModel.system).toEqual(otherModelSystem)
  expect(compactionOtherModel.tools).toEqual(otherModelTools)

  // 5. No pin for the session: the event is left exactly as given
  const noPinTools = { reader: { description: "read files", input: { type: "object" as const } } }
  const noPinSystem = [{ type: "text" as const, text: "Raw system text" }]
  const compactionNoPin = sessionEvent(
    "ses_no_pin",
    "alpha",
    { ...noPinTools },
    [...noPinSystem],
  )
  await Effect.runPromise(compactionHook(compactionNoPin))
  expect(compactionNoPin.system).toEqual(noPinSystem)
  expect(compactionNoPin.tools).toEqual(noPinTools)
})

test("variant model retains variant on repin and shapes matching compaction while ignoring different variant", async () => {
  sessionPins.clear()
  const { ctx, contextCallbacks, compactionCallbacks, synthetics } = createHarness()
  const state = { appliedParts: new Map(), currentPlanSet: undefined as PlanSet | undefined }

  const input1 = alphaPlan("You are helpful.\n\n## Rules\nBe nice.")
  await applyPublishParts(ctx, state, input1)
  const contextHook = contextCallbacks.at(-1)!

  // 1. Establish pin with a variant model
  const turn1 = sessionEvent(
    "ses_variant_cache",
    "alpha",
    { reader: { description: "raw tool desc", input: { type: "object" } } },
    [{ type: "text", text: "You are helpful.\n\n## Rules\nBe nice." }],
    { providerID: "anthropic", id: "claude-3-5-sonnet", variant: "high" },
  )
  await Effect.runPromise(contextHook(turn1))

  const pin = sessionPins.getPin("ses_variant_cache")
  expect(pin).toBeDefined()
  expect(pin!.model.variant).toBe("high")

  // 2. Repinned directly with pin.model (the path at ~line 340 in cache-safe.ts)
  sessionPins.repinSession("ses_variant_cache", pin!.model, state.currentPlanSet!)
  expect(pin!.model.variant).toBe("high")

  // Next step re-establishes pinned system for the session
  const turn2 = sessionEvent(
    "ses_variant_cache",
    "alpha",
    { reader: { description: "raw tool desc", input: { type: "object" } } },
    [{ type: "text", text: "You are helpful.\n\n## Rules\nBe nice." }],
    { providerID: "anthropic", id: "claude-3-5-sonnet", variant: "high" },
  )
  await Effect.runPromise(contextHook(turn2))
  expect(pin!.pinnedSystem0.get("alpha")).toBe(turn1.system[0]?.text)

  const compactionHook = compactionCallbacks.at(-1)!
  expect(compactionHook).toBeDefined()

  // 3. Same-model compaction event with matching variant is shaped from the pin
  const compactionSameVariant = sessionEvent(
    "ses_variant_cache",
    "alpha",
    { reader: { description: "raw tool desc", input: { type: "object" } } },
    [{ type: "text", text: "Raw unshaped system text" }],
    { providerID: "anthropic", id: "claude-3-5-sonnet", variant: "high" },
  )
  await Effect.runPromise(compactionHook(compactionSameVariant))

  expect(compactionSameVariant.system[0]?.text).toBe(turn1.system[0]?.text)
  expect(compactionSameVariant.tools).toEqual(turn1.tools)
  expect(synthetics).toHaveLength(0)

  // 4. Compaction with a different variant is left untouched
  const diffVariantTools = { reader: { description: "raw tool desc", input: { type: "object" as const } } }
  const diffVariantSystem = [{ type: "text" as const, text: "Raw unshaped system text" }]
  const compactionDiffVariant = sessionEvent(
    "ses_variant_cache",
    "alpha",
    { ...diffVariantTools },
    [...diffVariantSystem],
    { providerID: "anthropic", id: "claude-3-5-sonnet", variant: "low" },
  )
  await Effect.runPromise(compactionHook(compactionDiffVariant))
  expect(compactionDiffVariant.system).toEqual(diffVariantSystem)
  expect(compactionDiffVariant.tools).toEqual(diffVariantTools)

  // 5. Compaction without variant is also left untouched
  const noVariantTools = { reader: { description: "raw tool desc", input: { type: "object" as const } } }
  const noVariantSystem = [{ type: "text" as const, text: "Raw unshaped system text" }]
  const compactionNoVariant = sessionEvent(
    "ses_variant_cache",
    "alpha",
    { ...noVariantTools },
    [...noVariantSystem],
    { providerID: "anthropic", id: "claude-3-5-sonnet" },
  )
  await Effect.runPromise(compactionHook(compactionNoVariant))
  expect(compactionNoVariant.system).toEqual(noVariantSystem)
  expect(compactionNoVariant.tools).toEqual(noVariantTools)
})

test("mid-chat variant effort change updates pin variant on non-rebuild request and shapes matching compaction", async () => {
  sessionPins.clear()
  const { ctx, contextCallbacks, compactionCallbacks, synthetics } = createHarness()
  const state = { appliedParts: new Map(), currentPlanSet: undefined as PlanSet | undefined }

  const input = alphaPlan("You are helpful.\n\n## Rules\nBe nice.")
  await applyPublishParts(ctx, state, input)
  const contextHook = contextCallbacks.at(-1)!
  const compactionHook = compactionCallbacks.at(-1)!

  // 1. Initial request pins with variant "high"
  const turn1 = sessionEvent(
    "ses_effort_change",
    "alpha",
    { reader: { description: "raw tool desc", input: { type: "object" } } },
    [{ type: "text", text: "You are helpful.\n\n## Rules\nBe nice." }],
    { providerID: "anthropic", id: "claude-3-5-sonnet", variant: "high" },
  )
  await Effect.runPromise(contextHook(turn1))

  const pin = sessionPins.getPin("ses_effort_change")
  expect(pin).toBeDefined()
  expect(pin!.model.variant).toBe("high")

  // 2. Mid-chat effort change: context request with variant "xhigh" (not a rebuild moment)
  const turn2 = sessionEvent(
    "ses_effort_change",
    "alpha",
    { reader: { description: "raw tool desc", input: { type: "object" } } },
    [{ type: "text", text: "You are helpful.\n\n## Rules\nBe nice." }],
    { providerID: "anthropic", id: "claude-3-5-sonnet", variant: "xhigh" },
  )
  await Effect.runPromise(contextHook(turn2))
  expect(pin!.model.variant).toBe("xhigh")

  // 3. Compaction with new variant "xhigh" is shaped
  const rawTools = { reader: { description: "raw tool desc", input: { type: "object" as const } } }
  const rawSystem = [{ type: "text" as const, text: "Raw unshaped system text" }]
  const compactionXhigh = sessionEvent(
    "ses_effort_change",
    "alpha",
    { ...rawTools },
    [...rawSystem],
    { providerID: "anthropic", id: "claude-3-5-sonnet", variant: "xhigh" },
  )
  await Effect.runPromise(compactionHook(compactionXhigh))
  expect(compactionXhigh.system[0]?.text).toBe(turn1.system[0]?.text)
  expect(compactionXhigh.tools).toEqual(turn1.tools)
  expect(synthetics).toHaveLength(0)

  // 4. Compaction with old variant "high" is not shaped
  const compactionHigh = sessionEvent(
    "ses_effort_change",
    "alpha",
    { ...rawTools },
    [...rawSystem],
    { providerID: "anthropic", id: "claude-3-5-sonnet", variant: "high" },
  )
  await Effect.runPromise(compactionHook(compactionHigh))
  expect(compactionHigh.system).toEqual(rawSystem)
  expect(compactionHigh.tools).toEqual(rawTools)
})

const GUIDE = "/workspace/AGENTS.md"

function restartPlan(guide: string, rules: string, reader: string): PublishPartsInput {
  return {
    applyInput: {
      agents: [{ id: "alpha", level: "project" }],
      items: [
        makeItem({ id: "tool:reader", kind: "tool", text: reader, enabled: true, agents: ["alpha"] }),
        makeItem({ id: "system:role", kind: "system", text: `You are helpful.\n\n## Rules\n${rules}`, enabled: true, agents: ["alpha"] }),
        makeItem({ id: "system:AGENTS.md", kind: "system", text: guide, enabled: true, agents: ["alpha"] }),
      ],
      records: [],
      splits: [],
      scopes: { global: new Set(), defaults: new Set() },
    },
  }
}

// What core sends: its own system parts and tools, before Plus shapes them.
function restartRequest(rules: string, guide: string) {
  return sessionEvent("ses_restart", "alpha", { reader: { description: "read files", input: { type: "object" } } }, [
    { type: "text", text: `You are helpful.\n\n## Rules\n${rules}` },
    { type: "text", text: guide, metadata: { instruction: { path: GUIDE } } },
  ])
}

test("a restart keeps a chat's pinned prompt; what changed meanwhile arrives as one note", async () => {
  const { storage } = memoryStorage()
  const { ctx, contextCallbacks, synthetics } = createHarness()

  await applyPublishParts(ctx, { appliedParts: new Map(), sessionPins: new SessionPinManager(storage) }, restartPlan("Guide v1.", "Be nice.", "read files"))
  const first = restartRequest("Be nice.", "Guide v1.")
  await Effect.runPromise(contextCallbacks.at(-1)!(first))
  expect(first.system.map((part) => part.text)).toEqual(["You are helpful.\n\n## Rules\nBe nice.", "Guide v1."])

  // AGENTS.md, a role section and a tool description change; then Plus starts again
  // (a release, or a re-activation) with nothing in memory.
  const changed = restartPlan("Guide v2.", "Speak like a pirate.", "read files, carefully")
  await applyPublishParts(ctx, { appliedParts: new Map(), sessionPins: new SessionPinManager(storage) }, changed)
  const after = restartRequest("Speak like a pirate.", "Guide v2.")
  await Effect.runPromise(contextCallbacks.at(-1)!(after))

  expect(after.system, "the system prompt is the one the chat was sent").toEqual(first.system)
  expect(after.tools, "the tools are the ones the chat was sent").toEqual(first.tools)
  expect(synthetics).toHaveLength(1)
  // AGENTS.md is the file's own text: OpenCode announces that edit itself.
  expect(synthetics[0]?.text).not.toContain("Guide v2.")
  expect(synthetics[0]?.text).toContain("Speak like a pirate")
  expect(synthetics[0]?.text).toContain('Tool "reader" description changed')

  // The note was stored with the pin: another start does not announce it again.
  await applyPublishParts(ctx, { appliedParts: new Map(), sessionPins: new SessionPinManager(storage) }, changed)
  const again = restartRequest("Speak like a pirate.", "Guide v2.")
  await Effect.runPromise(contextCallbacks.at(-1)!(again))
  expect(again.system).toEqual(first.system)
  expect(synthetics).toHaveLength(1)

  // Without a store, the same start pins the changed files: the miss this prevents.
  await applyPublishParts(ctx, { appliedParts: new Map(), sessionPins: new SessionPinManager() }, changed)
  const unstored = restartRequest("Speak like a pirate.", "Guide v2.")
  await Effect.runPromise(contextCallbacks.at(-1)!(unstored))
  expect(unstored.system.map((part) => part.text)).toContain("Guide v2.")
})

function guidePlans(text: string, asSource: boolean): PlanSet {
  return createPlanSet({
    roles: new Map(),
    base: [],
    native: [],
    instructions: [{ agent: "alpha", path: GUIDE, text, enabled: true, ...(asSource ? { asSource: true as const } : {}) }],
    scrubByAgent: new Map(),
    needsNarrowing: false,
    permissions: answering("plans"),
    customByAgent: new Set(),
  })
}

test("an edited instruction file is left to OpenCode's notice; a Plus change to it is announced", async () => {
  const model = { providerID: "anthropic", id: "claude-3-5-sonnet" }
  const pin = new SessionPinManager().pinSession("ses_guide", model, guidePlans("Guide v1.", true))
  expect(computeChangeNote(pin, guidePlans("Guide v2.", true), "alpha"), "OpenCode announces its own file").toBeUndefined()
  expect(computeChangeNote(pin, guidePlans("Plus text.", false), "alpha")?.noteText).toContain("Plus text.")
  const overridden = new SessionPinManager().pinSession("ses_override", model, guidePlans("Plus text.", false))
  expect(computeChangeNote(overridden, guidePlans("Guide v2.", true), "alpha")?.noteText).toContain("Guide v2.")

  // The mark survives a restart with the stored pin.
  const { storage } = memoryStorage()
  const stored = new SessionPinManager(storage)
  await Effect.runPromise(stored.save(stored.pinSession("ses_stored", model, guidePlans("Guide v1.", true)), "alpha"))
  const restored = await Effect.runPromise(new SessionPinManager(storage).load("ses_stored", guidePlans("Guide v2.", true)))
  expect(restored?.planSet.instructions[0]?.asSource).toBe(true)
  expect(computeChangeNote(restored!, guidePlans("Guide v2.", true), "alpha")).toBeUndefined()
})

function answering(label: string): PermissionTable {
  return {
    rows: () => [],
    toolRows: (agent, tool) => [{ item: makeItem({ id: `tool:${tool}`, kind: "tool", text: tool }), on: true, text: `${label}: ${agent} ${tool}` }],
    ruleRows: () => [],
    teamMembers: new Set(),
    describe: (agent) => (agent === "quiet" ? undefined : `${label}: ${agent}`),
  }
}

function narrowingPlans(permissions: PermissionTable): PlanSet {
  return createPlanSet({
    roles: new Map(),
    base: [],
    native: [],
    instructions: [],
    scrubByAgent: new Map(),
    needsNarrowing: true,
    permissions,
    customByAgent: new Set(),
  })
}

test("after a restart, narrowing reads the permission answers the pin stored and asks the current table only what is new", async () => {
  const { storage } = memoryStorage()
  const model = { providerID: "anthropic", id: "claude-3-5-sonnet" }
  const before = new SessionPinManager(storage)
  const pin = before.pinSession("ses_answers", model, narrowingPlans(answering("before")))
  const asked = pinnedPermissions(pin, "alpha", pin.planSet.permissions)
  expect(asked.toolRows("alpha", "bash")[0]?.text).toBe("before: alpha bash")
  expect(asked.describe("quiet")).toBeUndefined()
  await Effect.runPromise(before.save(pin, "alpha"))

  const restored = await Effect.runPromise(new SessionPinManager(storage).load("ses_answers", narrowingPlans(answering("after"))))
  if (restored === undefined) throw new Error("expected the stored pin")
  const replayed = pinnedPermissions(restored, "alpha", restored.planSet.permissions)
  expect(replayed.toolRows("alpha", "bash")[0]?.text).toBe("before: alpha bash")
  expect(replayed.describe("quiet")).toBeUndefined()
  expect(replayed.toolRows("alpha", "edit")[0]?.text).toBe("after: alpha edit")
  expect(restored.planSet.needsNarrowing).toBe(true)
})

test("a stored pin keeps a rebuild marked before a restart or while unloaded, and goes when its chat is deleted", async () => {
  const { storage, entries } = memoryStorage()
  const model = { providerID: "anthropic", id: "claude-3-5-sonnet" }
  const plans = narrowingPlans(answering("now"))
  const first = new SessionPinManager(storage)
  await Effect.runPromise(first.save(first.pinSession("ses_life", model, plans), "alpha"))
  expect([...entries.keys()].filter((key) => key.includes("ses_life"))).toHaveLength(2)

  // Marked by an instance that never loaded the pin (a compaction right after a restart).
  await Effect.runPromise(new SessionPinManager(storage).markRebuild("ses_life"))
  const restored = await Effect.runPromise(new SessionPinManager(storage).load("ses_life", plans))
  expect(restored?.rebuildNeeded).toBe(true)

  await Effect.runPromise(new SessionPinManager(storage).dropPin("ses_life"))
  expect([...entries.keys()].filter((key) => key.includes("ses_life"))).toEqual([])
})

test("a stored pin from an earlier plan set is not restored, and pins idle past every cache lifetime are swept", async () => {
  const { storage, entries } = memoryStorage()
  const model = { providerID: "anthropic", id: "claude-3-5-sonnet" }
  const manager = new SessionPinManager(storage)
  const pin = manager.pinSession("ses_epoch", model, narrowingPlans(answering("first")))
  pinnedPermissions(pin, "alpha", pin.planSet.permissions).toolRows("alpha", "bash")
  await Effect.runPromise(manager.save(pin, "alpha"))
  // A rebuild moment: the pin takes another plan set; only the record is written before the next agent part.
  manager.repinSession("ses_epoch", model, narrowingPlans(answering("second")))
  await Effect.runPromise(manager.save(pin))
  const restored = await Effect.runPromise(new SessionPinManager(storage).load("ses_epoch", narrowingPlans(answering("third"))))
  if (restored === undefined) throw new Error("expected the stored pin")
  expect(pinnedPermissions(restored, "alpha", restored.planSet.permissions).toolRows("alpha", "bash")[0]?.text).toBe("third: alpha bash")

  const idle = new SessionPinManager(storage)
  const old = idle.pinSession("ses_idle", model, narrowingPlans(answering("old")))
  old.lastRequestAt = Date.now() - 25 * 60 * 60 * 1000
  await Effect.runPromise(idle.save(old, "alpha"))
  await Effect.runPromise(sweepStoredPins(storage, Date.now()))
  expect([...entries.keys()].filter((key) => key.includes("ses_idle"))).toEqual([])
  expect([...entries.keys()].filter((key) => key.includes("ses_epoch")).length).toBeGreaterThan(0)
})
