import { expect, test } from "bun:test"
import { createAttentionStore, decideAttention, PLAYER_TTL_MS } from "../src/attention.js"
import {
  agentAttention,
  attentionOf,
  attentionRowError,
  DEFAULT_ATTENTION,
  mergeAttention,
} from "../src/attention-settings.js"
import { createAttentionWatcher, type AttentionChat, type AttentionHostEvent } from "../src/attention-watch.js"
import { controlRecordError, controlItems } from "../src/instructions/agent-controls.js"
import { attentionRowsOf, controlPlans, type ApplyInput } from "../src/instructions/apply.js"
import type { AttentionSettings, Plus } from "../src/rpc.js"
import { controlRecord } from "./agent-controls-fixture.js"

const on = (sound = "bip-bop-01") => ({ notify: true, sound })
const off = { notify: false, sound: "off" }
const settings = (patch: Partial<AttentionSettings> = {}): AttentionSettings => ({ ...DEFAULT_ATTENTION, ...patch })

test("a top-level chat's reply is done when nothing it started runs, else a reply", () => {
  const all = settings({ reply: on("yup-01") })
  expect(decideAttention({ type: "turn", waiting: false }, 0, all, all)?.kind).toBe("done")
  expect(decideAttention({ type: "turn", waiting: true }, 0, all, all)?.kind).toBe("reply")
  // Done off: every final reply is a reply.
  const noDone = settings({ done: off, reply: on("yup-01") })
  expect(decideAttention({ type: "turn", waiting: false }, 0, noDone, noDone)?.kind).toBe("reply")
  // Reply off (the default): a reply while work runs raises nothing.
  expect(decideAttention({ type: "turn", waiting: true }, 0, settings(), settings())).toBeUndefined()
})

test("a subagent's or team member's reply raises child within the root agent's depth only", () => {
  const root = settings({ child: { ...on("yup-02"), depth: 2 } })
  expect(decideAttention({ type: "turn", waiting: false }, 1, settings(), root)).toEqual({ kind: "child", settings: root.child })
  expect(decideAttention({ type: "turn", waiting: false }, 2, settings(), root)?.kind).toBe("child")
  expect(decideAttention({ type: "turn", waiting: false }, 3, settings(), root)).toBeUndefined()
  // The child's own agent does not decide: the default (off) on the root means nothing.
  expect(decideAttention({ type: "turn", waiting: false }, 1, root, settings())).toBeUndefined()
})

test("errors of children follow the child reach; questions and cache misses come from any depth", () => {
  const root = settings({ child: { ...on(), depth: 1 } })
  expect(decideAttention({ type: "failed" }, 0, settings(), settings())?.kind).toBe("error")
  expect(decideAttention({ type: "failed" }, 1, settings(), settings())).toBeUndefined()
  expect(decideAttention({ type: "failed" }, 1, settings(), root)?.settings).toEqual(DEFAULT_ATTENTION.error)
  expect(decideAttention({ type: "question" }, 4, settings(), settings())?.kind).toBe("question")
  expect(decideAttention({ type: "cacheMiss" }, 0, settings(), settings())).toBeUndefined()
  expect(decideAttention({ type: "cacheMiss" }, 3, settings({ cacheMiss: on("alert-01") }), settings())?.kind).toBe("cacheMiss")
})

test("stored settings fall back field by field; a change with a bad value is refused whole", () => {
  expect(attentionOf(undefined)).toEqual(DEFAULT_ATTENTION)
  const read = attentionOf({ done: { notify: false, sound: "nope" }, child: { depth: 12, sound: "/sounds/ding.wav" } })
  expect(read.done).toEqual({ notify: false, sound: DEFAULT_ATTENTION.done.sound })
  expect(read.child).toEqual({ notify: false, sound: "/sounds/ding.wav", depth: 1 })
  expect(mergeAttention(DEFAULT_ATTENTION, { reply: { sound: "yup-04" }, child: { depth: 3 } })).toEqual({
    settings: { ...DEFAULT_ATTENTION, reply: { notify: false, sound: "yup-04" }, child: { ...DEFAULT_ATTENTION.child, depth: 3 } },
  })
  expect(mergeAttention(DEFAULT_ATTENTION, { done: { sound: "relative.mp3" } })).toHaveProperty("error")
  expect(mergeAttention(DEFAULT_ATTENTION, { child: { depth: 0 } })).toHaveProperty("error")
})

test("an agent's notification rows lay over the global settings; empty rows follow them", () => {
  const global = settings({ cacheMiss: on("alert-02") })
  expect(agentAttention(global, {})).toEqual(global)
  expect(
    agentAttention(global, {
      "setting:attention.done.notify": "off",
      "setting:attention.done.sound": "yup-01",
      "setting:attention.child.depth": "3",
      "setting:attention.cacheMiss.sound": "",
    }),
  ).toEqual({ ...global, done: { notify: false, sound: "yup-01" }, child: { ...global.child, depth: 3 } })
  expect(attentionRowError("setting:attention.done.notify", "maybe")).toBeDefined()
  expect(attentionRowError("setting:attention.child.depth", "10")).toBeDefined()
  expect(attentionRowError("setting:attention.question.sound", "/x/y.ogg")).toBeUndefined()
  expect(controlRecordError(controlRecord("setting:attention.error.sound", { text: "bell" }))).toBeDefined()
  expect(controlRecordError(controlRecord("setting:attention.error.sound", { text: "nope-05" }))).toBeUndefined()
  expect(controlRecordError(controlRecord("setting:attention.error.notify", { state: "on" }))).toBeDefined()
})

test("notification rows resolve per agent for Plus and are never installed into the agent", () => {
  const input: ApplyInput = {
    items: controlItems(),
    agents: [{ id: "build", level: "project" }, { id: "plan", level: "project" }],
    records: [
      controlRecord("setting:attention.done.sound", { text: "yup-03" }),
      controlRecord("setting:attention.done.notify", { text: "off" }),
    ],
    splits: [],
    scopes: { global: new Set(), defaults: new Set() },
  }
  expect(attentionRowsOf(input).get("build")).toEqual({
    "setting:attention.done.sound": "yup-03",
    "setting:attention.done.notify": "off",
  })
  expect(attentionRowsOf(input).get("plan")).toEqual({})
  expect(controlPlans(input)).toEqual([])
})

test("a sound player counts as connected until its heartbeat is 45 s old", () => {
  const clock = { now: 1_000 }
  const store = createAttentionStore({ now: () => clock.now })
  expect(store.players()).toBe(0)
  expect(store.player("pc")).toBe(1)
  expect(store.player("laptop")).toBe(2)
  clock.now += PLAYER_TTL_MS - 1
  expect(store.player("laptop")).toBe(2)
  clock.now += 1
  expect(store.players()).toBe(1)
})

function watcher(options: {
  readonly chats: Record<string, AttentionChat & { readonly parent?: string }>
  readonly settings?: Record<string, AttentionSettings>
  readonly running?: ReadonlySet<string>
  readonly notices?: readonly Plus.MonitorNotice[]
  /** The chats a TUI has open; default: every top-level chat. */
  readonly open?: readonly string[]
}) {
  const emitted: Plus.Attention[] = []
  const store = createAttentionStore({ now: () => 0 })
  store.opened("tui", options.open ?? Object.keys(options.chats).filter((id) => options.chats[id]?.parent === undefined))
  const waiters: (() => void)[] = []
  const watch = createAttentionWatcher({
    store,
    now: () => 7,
    noticeDelayMs: 0,
    parentOf: async (id) => options.chats[id]?.parent,
    chatOf: async (id) => options.chats[id],
    settingsFor: async (agent) => (agent === undefined ? undefined : options.settings?.[agent]) ?? DEFAULT_ATTENTION,
    workRuns: async (id) => options.running?.has(id) === true,
    notices: async () => options.notices ?? [],
    emit: async (attention) => {
      emitted.push(attention)
      waiters.splice(0).forEach((wake) => wake())
    },
  })
  const event = (id: string, type: string, data: unknown): AttentionHostEvent => ({ id, type, data })
  return { emitted, store, watch, event, emittedNext: () => new Promise<void>((wake) => waiters.push(wake)) }
}

test("a final reply raises done once per event, with the chat's title and agent", async () => {
  const lab = watcher({ chats: { ses_lead: { agent: "build", title: "Fix the parser" } } })
  const succeeded = lab.event("evt_1", "session.execution.succeeded", { sessionID: "ses_lead" })
  await lab.watch.handle(succeeded)
  await lab.watch.handle(succeeded)
  expect(lab.emitted).toEqual([
    {
      id: "evt_1",
      kind: "done",
      sessionID: "ses_lead",
      rootID: "ses_lead",
      depth: 0,
      agent: "build",
      title: "Fix the parser",
      message: "Done",
      notify: true,
      sound: "bip-bop-01",
      player: false,
      at: 7,
    },
  ])
})

test("a background shell or a running subagent makes the reply a reply, not done", async () => {
  const replies = settings({ reply: on("yup-05") })
  const lab = watcher({
    chats: { ses_lead: { agent: "build" }, ses_other: { agent: "build" } },
    settings: { build: replies },
    running: new Set(["ses_other"]),
  })
  await lab.watch.handle(lab.event("evt_shell", "shell.created", { info: { id: "sh_1", metadata: { sessionID: "ses_lead" } } }))
  await lab.watch.handle(lab.event("evt_2", "session.execution.succeeded", { sessionID: "ses_lead" }))
  await lab.watch.handle(lab.event("evt_exit", "shell.exited", { id: "sh_1" }))
  await lab.watch.handle(lab.event("evt_3", "session.execution.succeeded", { sessionID: "ses_lead" }))
  await lab.watch.handle(lab.event("evt_4", "session.execution.succeeded", { sessionID: "ses_other" }))
  expect(lab.emitted.map((attention) => [attention.id, attention.kind, attention.message])).toEqual([
    ["evt_2", "reply", "Replied; its work still runs"],
    ["evt_3", "done", "Done"],
    ["evt_4", "reply", "Replied; its work still runs"],
  ])
})

test("children raise child and questions at their depth under the root chat's title", async () => {
  const lab = watcher({
    chats: {
      ses_lead: { agent: "build", title: "Release" },
      ses_sub: { agent: "explore", title: "Find callers", parent: "ses_lead" },
      ses_deep: { agent: "general", parent: "ses_sub" },
    },
    settings: { build: settings({ child: { ...on("yup-01"), depth: 1 } }) },
  })
  lab.store.player("pc")
  await lab.watch.handle(lab.event("evt_a", "session.execution.succeeded", { sessionID: "ses_sub" }))
  await lab.watch.handle(lab.event("evt_b", "session.execution.succeeded", { sessionID: "ses_deep" }))
  await lab.watch.handle(lab.event("evt_c", "form.created", { form: { sessionID: "ses_deep", title: "Which branch?" } }))
  await lab.watch.handle(lab.event("evt_d", "permission.asked", { sessionID: "ses_sub", action: "bash" }))
  expect(lab.emitted.map((attention) => ({ id: attention.id, kind: attention.kind, depth: attention.depth, rootID: attention.rootID, title: attention.title, message: attention.message, player: attention.player }))).toEqual([
    { id: "evt_a", kind: "child", depth: 1, rootID: "ses_lead", title: "Release", message: "Find callers is done", player: true },
    { id: "evt_c", kind: "question", depth: 2, rootID: "ses_lead", title: "Release", message: "general: Which branch?", player: true },
    { id: "evt_d", kind: "question", depth: 1, rootID: "ses_lead", title: "Release", message: "Find callers: Permission needs input: bash", player: true },
  ])
})

test("a new cache notice after a step raises cacheMiss with the agent's settings", async () => {
  const notice: Plus.MonitorNotice = {
    requestID: "req_1",
    sessionID: "ses_lead",
    rootID: "ses_lead",
    agent: "build",
    verdict: "miss",
    missTokens: 12_000,
    causeText: "the system prompt changed",
    at: 5,
  }
  const lab = watcher({
    chats: { ses_lead: { agent: "build", title: "Chat" } },
    settings: { build: settings({ cacheMiss: { notify: false, sound: "alert-03" } }) },
    notices: [notice],
  })
  const raised = lab.emittedNext()
  await lab.watch.handle(lab.event("evt_s1", "session.step.ended", { sessionID: "ses_lead" }))
  await raised
  expect(lab.emitted.map((attention) => [attention.id, attention.kind, attention.notify, attention.sound, attention.message])).toEqual([
    ["notice:req_1", "cacheMiss", false, "alert-03", "cache miss, 12k tokens not reused (the system prompt changed)"],
  ])
  lab.watch.dispose()
})

test("only chats open in a TUI notify; a subagent counts through the chat above it", async () => {
  const lab = watcher({
    chats: {
      ses_open: { agent: "build" },
      ses_closed: { agent: "build" },
      ses_sub: { agent: "explore", parent: "ses_open" },
      ses_closed_sub: { agent: "explore", parent: "ses_closed" },
    },
    settings: { build: settings({ child: { ...on("yup-01"), depth: 1 } }) },
    open: ["ses_open"],
  })
  await lab.watch.handle(lab.event("e1", "session.execution.succeeded", { sessionID: "ses_closed" }))
  await lab.watch.handle(lab.event("e2", "session.execution.succeeded", { sessionID: "ses_closed_sub" }))
  await lab.watch.handle(lab.event("e3", "form.created", { form: { sessionID: "ses_closed", title: "Which?" } }))
  await lab.watch.handle(lab.event("e4", "session.execution.succeeded", { sessionID: "ses_sub" }))
  await lab.watch.handle(lab.event("e5", "session.execution.succeeded", { sessionID: "ses_open" }))
  expect(lab.emitted.map((attention) => [attention.id, attention.kind])).toEqual([
    ["e4", "child"],
    ["e5", "done"],
  ])
  // A TUI that closes reports no chats: nothing is open any more.
  lab.store.opened("tui", [])
  await lab.watch.handle(lab.event("e6", "session.execution.succeeded", { sessionID: "ses_open" }))
  expect(lab.emitted).toHaveLength(2)
})

test("a TUI's report of open chats lasts 45 s", () => {
  const clock = { now: 0 }
  const store = createAttentionStore({ now: () => clock.now })
  expect(store.opened("a", ["ses_1"])).toBe(1)
  expect(store.opened("b", ["ses_2"])).toBe(2)
  expect(store.isOpen(["ses_9", "ses_1"])).toBe(true)
  clock.now += PLAYER_TTL_MS
  expect(store.isOpen(["ses_1"])).toBe(false)
})
