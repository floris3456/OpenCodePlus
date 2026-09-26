import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { createPlusApi, createState, deactivate } from "../src/index.js"
import { runRegistration } from "../src/instructions/apply.js"
import { controlItems, controlItemFor, type Compaction } from "../src/instructions/agent-controls.js"
import { resolve, type Address, type CustomizationRecord, type Item } from "../src/instructions/model.js"
import { reset, saveText, setAgentMode, setEnabled } from "../src/instructions/ops.js"
import { chainContext } from "../src/instructions/presets.js"
import { memoInputOf } from "../src/instructions/snapshot.js"
import { projectTeamsPath } from "../src/instructions/paths.js"
import { load, save } from "../src/instructions/store.js"
import { disable, enable } from "../src/project.js"
import { registerInstructionTools } from "../src/tools.js"
import { agentHarness, agentInfo, fullContext, toolHarness } from "./harness.js"

const roots: string[] = []
const states: ReturnType<typeof createState>[] = []
const env = { config: process.env.OPENCODE_CONFIG_DIR, data: process.env.XDG_DATA_HOME }
afterEach(async () => {
  for (const state of states.splice(0)) await Effect.runPromise(deactivate(state))
  if (env.config === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = env.config
  if (env.data === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = env.data
  for (const root of roots.splice(0)) await fs.rm(root, { recursive: true, force: true })
})

async function fixture(initial = [agentInfo("build"), agentInfo("compaction", "Global compaction instructions")]) {
  const root = await fs.mkdtemp("/home/bliss/OpenCodePlus/run/plus/tmp/opencodeplus/agent-controls-")
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  process.env.XDG_DATA_HOME = path.join(root, "data")
  const directory = path.join(root, "project")
  await disable(directory)
  await enable(directory)
  const agents = agentHarness(initial, directory)
  const tools = toolHarness()
  const ctx = { ...fullContext({ directory, classifications: new Map([["", "general"], ["worker", "general"]]) }), agent: agents.domain, tool: tools.domain }
  const state = createState()
  states.push(state)
  const api = createPlusApi(ctx, state)
  async function snapshot() {
    const result = await api.snapshot()
    if (!result.ok) throw new Error(result.error.message)
    return result.value
  }
  async function edit(op: ReturnType<typeof saveText>) {
    if ("refusal" in op) throw new Error(op.refusal)
    const before = await snapshot()
    const result = await api.mutate({
      expectedRevision: before.revision,
      expectedGlobalRevision: before.globalRevision,
      actor: { type: "tui" },
      records: [...before.records.filter((record) => record.type !== "customization" && record.type !== "split"), ...op.records, ...op.splits],
    })
    if (!result.ok) throw new Error(result.error.message)
    if (!result.value.ok) throw new Error("Unexpected stale write")
    return result.value.snapshot
  }
  return { root, directory, agents, tools, ctx, state, api, snapshot, edit }
}

test("published on/off survives discovery and replacement, and reset restores upstream agent fields", async () => {
  const f = await fixture()
  const first = await f.snapshot()
  const off = await f.edit(setEnabled(memoInputOf(first), "agent:project:build", false))
  expect(f.agents.state.has("build")).toBe(false)
  expect(off.agents.some((agent) => agent.id === "build")).toBe(true)
  expect(off.items.find((item) => item.id === "setting:enabled" && item.agents?.includes("build"))?.enabled).toBe(true)
  const fingerprint = f.state.fingerprint
  await f.api.refresh()
  expect(f.state.fingerprint).toBe(fingerprint)
  expect(f.agents.state.has("build")).toBe(false)
  const all = await f.edit(setAgentMode(memoInputOf(await f.snapshot()), "agent:project:build", "all"))
  expect(f.agents.state.has("build")).toBe(false)
  await f.edit(setEnabled(memoInputOf(all), "agent:project:build", true))
  expect(f.agents.state.get("build")?.mode).toBe("all")
  await f.edit(reset(memoInputOf(await f.snapshot()), "agent:project:build"))
  expect(f.agents.state.get("build")?.mode).toBe("primary")
  expect((await load(f.directory)).records.filter((record) => record.type === "customization")).toEqual([])
})

test("config-disabled agents are not recreated by retained mode/model/enable overrides", async () => {
  const f = await fixture()
  const disabled = { value: false }
  await runRegistration(f.ctx.agent.transform, (editor) => { if (disabled.value) editor.remove("build") })
  await f.edit(setAgentMode(memoInputOf(await f.snapshot()), "agent:project:build", "subagent"))
  await f.edit(setEnabled(memoInputOf(await f.snapshot()), "agent:project:build", true))
  const before = await f.snapshot()
  const modeled = await f.api.mutate({
    expectedRevision: before.revision, expectedGlobalRevision: before.globalRevision, actor: { type: "tui" },
    records: [...before.records, { type: "model", level: "project", agent: "build", providerID: "test", modelID: "worker", active: true, updated: "" }],
  })
  expect(modeled.ok).toBe(true)
  expect(f.agents.state.get("build")?.model).toEqual(Model.Ref.parse("test/worker"))
  disabled.value = true
  await Effect.runPromise(f.ctx.agent.reload())
  await f.api.refresh()
  expect(f.agents.state.has("build")).toBe(false)
  expect((await f.snapshot()).agents.some((agent) => agent.id === "build")).toBe(false)
})

test("parity fields apply, hidden is independent of enabled, and optional values can clear upstream", async () => {
  const original = { ...agentInfo("build"), hidden: true, color: "#123456", steps: 4 as Agent.Info["steps"] }
  const f = await fixture([original])
  for (const [item, text] of [["mode", "subagent"], ["description", "Review changes"], ["color", "#Aa09fF"], ["steps", "17"]])
    await f.edit(saveText(memoInputOf(await f.snapshot()), `item:project:build:setting:${item}`, text))
  await f.edit(setEnabled(memoInputOf(await f.snapshot()), "item:project:build:setting:hidden", false))
  expect(f.agents.state.get("build")).toMatchObject({ mode: "subagent", description: "Review changes", color: "#Aa09fF", steps: 17, hidden: false })
  for (const item of ["color", "steps"])
    await f.edit(saveText(memoInputOf(await f.snapshot()), `item:project:build:setting:${item}`, ""))
  expect(f.agents.state.get("build")?.steps).toBeUndefined()
  expect(f.agents.state.get("build")?.color).toBeUndefined()
  const fingerprint = f.state.fingerprint
  await f.api.refresh()
  expect(f.state.fingerprint).toBe(fingerprint)
  await f.edit(reset(memoInputOf(await f.snapshot()), "agent:project:build"))
  expect(f.agents.state.get("build")).toMatchObject({ hidden: true, color: "#123456", steps: 4 })
})

test("compaction inherits active model and global instructions, retains local overrides while remote, and resets", async () => {
  const f = await fixture()
  const initial = await f.snapshot()
  expect(initial.items.find((item) => item.id === "compaction:model" && item.agents?.includes("build"))?.text).toBe("")
  expect(initial.items.find((item) => item.id === "compaction:instructions" && item.agents?.includes("build"))?.text).toBe("Global compaction instructions")
  expect((f.agents.state.get("build") as Agent.Info & { compaction?: Compaction }).compaction).toBeUndefined()
  await f.edit(saveText(memoInputOf(initial), "item:global:compaction:system:role", "Customized global compaction"))
  expect((await f.snapshot()).items.find((item) => item.id === "compaction:instructions" && item.agents?.includes("build"))?.text).toBe("Customized global compaction")
  for (const [item, text] of [["model", "test/summarizer#fast"], ["instructions", "Keep unresolved tasks"], ["strategy", "remote"]])
    await f.edit(saveText(memoInputOf(await f.snapshot()), `item:project:build:compaction:${item}`, text))
  const current = () => (f.agents.state.get("build") as Agent.Info & { compaction?: Compaction }).compaction
  expect(current()).toEqual({ strategy: "remote", model: Model.Ref.parse("test/summarizer#fast"), system: "Keep unresolved tasks" })
  await f.edit(saveText(memoInputOf(await f.snapshot()), "item:project:build:compaction:strategy", "local"))
  expect(current()?.model).toEqual(Model.Ref.parse("test/summarizer#fast"))
  await f.edit(reset(memoInputOf(await f.snapshot()), "item:project:build:compaction:model"))
  expect(current()?.model).toBeUndefined()
  expect(current()?.system).toBe("Keep unresolved tasks")
  await f.edit(reset(memoInputOf(await f.snapshot()), "agent:project:build"))
  expect(current()).toBeUndefined()
})

test("published controls resolve preset and Defaults entries, shared defaults, and reset at the current level only", async () => {
  const f = await fixture()
  const stored = await load(f.directory)
  await save(f.directory, { expectedProjectRevision: stored.projectRevision, expectedGlobalRevision: stored.globalRevision, records: [
    ...stored.records,
    { type: "preset", level: "preset", kind: "agent", id: "custom-review", updated: "" },
    { type: "entry", level: "defaults", catalogue: "agents", name: "b*", updated: "" },
    { type: "link", level: "project", agent: "build", preset: { kind: "agent", id: "custom-review" }, updated: "" },
  ] })
  await f.api.refresh()
  await f.edit(saveText(memoInputOf(await f.snapshot()), "item:preset:custom-review:compaction:strategy", "local"))
  await f.edit(saveText(memoInputOf(await f.snapshot()), "item:defaults:b*:compaction:instructions", "Defaults entry guide"))
  await f.edit(saveText(memoInputOf(await f.snapshot()), "item:defaults::setting:steps", "9"))
  expect(f.agents.state.get("build")?.steps).toBe(9)
  expect((f.agents.state.get("build") as Agent.Info & { compaction?: Compaction }).compaction).toEqual({ strategy: "local", system: "Defaults entry guide" })
  await f.edit(saveText(memoInputOf(await f.snapshot()), "item:global:build:compaction:strategy", "remote"))
  await f.edit(saveText(memoInputOf(await f.snapshot()), "item:project:build:compaction:strategy", "auto"))
  await f.edit(reset(memoInputOf(await f.snapshot()), "item:project:build:compaction:strategy"))
  expect((f.agents.state.get("build") as Agent.Info & { compaction?: Compaction }).compaction?.strategy).toBe("remote")
  await f.edit(reset(memoInputOf(await f.snapshot()), "item:global:build:compaction:strategy"))
  expect((f.agents.state.get("build") as Agent.Info & { compaction?: Compaction }).compaction?.strategy).toBe("local")
})

test("mutation boundary rejects invalid controls through RPC records and preserves revision", async () => {
  const f = await fixture()
  const before = await f.snapshot()
  for (const [item, text] of [["setting:mode", "worker"], ["setting:steps", "0"], ["setting:steps", "2.5"], ["setting:steps", "-1"], ["setting:color", "red"], ["compaction:strategy", "native"], ["compaction:model", "no-provider"]]) {
    const result = await f.api.mutate({
      expectedRevision: before.revision, expectedGlobalRevision: before.globalRevision, actor: { type: "tui" },
      records: [{ type: "customization", level: "project", agent: "build", item, section: null, text, basedOn: "", updated: "" }],
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error.code).toBe("agent.invalid")
  }
  expect((await f.snapshot()).revision).toBe(before.revision)
})

test("ordinary user agents stay editable while disabled and final controls beat team upserts", async () => {
  const f = await fixture([])
  const file = path.join(f.directory, ".opencode", "agents", "writer.md")
  await fs.mkdir(path.dirname(file), { recursive: true })
  await fs.writeFile(file, "---\nmode: primary\n---\nWrite code")
  await Effect.runPromise(f.ctx.agent.reload())
  await f.edit(setEnabled(memoInputOf(await f.snapshot()), "agent:project:writer", false))
  expect(f.agents.state.has("writer")).toBe(false)
  expect((await f.snapshot()).agents.some((agent) => agent.id === "writer")).toBe(true)
  const member = path.join(projectTeamsPath(f.directory), "crew", "helper.md")
  await fs.mkdir(path.dirname(member), { recursive: true })
  await fs.writeFile(member, "---\nmode: subagent\ndescription: Team helper\n---\nHelp the crew")
  const store = await load(f.directory)
  await save(f.directory, { expectedProjectRevision: store.projectRevision, expectedGlobalRevision: store.globalRevision, records: [...store.records, { type: "team", level: "project", team: "crew", enabled: true, updated: "" }] })
  await f.api.refresh()
  expect(f.agents.state.get("helper")?.mode).toBe("subagent")
  await f.edit(setAgentMode(memoInputOf(await f.snapshot()), "team:project:crew:helper", "all"))
  expect(f.agents.state.get("helper")?.mode).toBe("all")
  await f.edit(setEnabled(memoInputOf(await f.snapshot()), "team:project:crew:helper", false))
  expect(f.agents.state.has("helper")).toBe(false)
  await f.api.refresh()
  expect(f.agents.state.has("helper")).toBe(false)
  await f.edit(setEnabled(memoInputOf(await f.snapshot()), "team:project:crew:helper", true))
  expect(f.agents.state.get("helper")?.mode).toBe("all")
  // A file-level disabled marker cannot be overridden by a saved enable row.
  await fs.writeFile(member, "---\ndisabled: true\n---\nHelp the crew")
  await f.api.refresh()
  expect(f.agents.state.has("helper")).toBe(false)
})

test("scope chain: project/global/preset/Defaults/shared and Teams catalogue remain distinct", () => {
  const items = [...controlItems("build"), ...controlItems()]
  const scopes = chainContext({ agents: [{ id: "build", scope: "defaults", origin: "native" }], items,
    entries: [{ type: "entry", level: "defaults", catalogue: "agents", name: "b*", updated: "" }],
    presets: [{ type: "preset", level: "preset", kind: "agent", id: "review", updated: "" }],
    links: [{ type: "link", level: "project", agent: "build", preset: { kind: "agent", id: "review" }, updated: "" }],
  })
  const records: CustomizationRecord[] = [
    { level: "defaults", agent: null, text: "shared" },
    { level: "defaults", agent: null, catalogue: "teams", text: "team shared" },
    { level: "defaults", agent: "b*", text: "entry" },
    { level: "preset", agent: "review", text: "preset" },
    { level: "global", agent: "build", text: "global" },
    { level: "project", agent: "build", text: "project" },
  ].map((record) => ({ type: "customization", item: "compaction:instructions", section: null, basedOn: "", updated: "", ...record }) as CustomizationRecord)
  const address: Address = { level: "project", agent: "build", item: "compaction:instructions", section: null }
  const upstream = controlItemFor(items, address) as Item
  const answer = (remaining: CustomizationRecord[], target = address) => resolve({ upstream, records: remaining, splits: [], scopes, address: target }).text
  expect(answer(records)).toBe("project")
  expect(answer(records.slice(0, -1))).toBe("global")
  expect(answer(records.slice(0, -2))).toBe("preset")
  expect(answer(records.slice(0, -3))).toBe("entry")
  expect(answer(records.slice(0, 2))).toBe("shared")
  expect(answer(records.slice(0, 2), { ...address, team: { level: "project", team: "crew" } })).toBe("team shared")
})

test("Tool set accepts agent state/mode and control text, reset uses the same records, guards still refuse protected agents", async () => {
  const f = await fixture()
  const registration = await registerInstructionTools(f.ctx, f.api)
  const toolContext: Tool.Context = { sessionID: Session.ID.make("ses_controls"), messageID: SessionMessage.ID.make("msg_controls"), agent: Agent.ID.make("operator"), id: Tool.CallID.make("call_controls"), progress: () => Effect.void }
  const call = async (name: string, input: unknown) => {
    const tool = f.tools.tools.get(`instructions_${name}`)
    if (tool === undefined) throw new Error(`Missing ${name}`)
    return Effect.runPromise(tool.execute(input, toolContext))
  }
  await call("set", { id: "agent:project:build", state: "off", mode: "all" })
  expect(f.agents.state.has("build")).toBe(false)
  await call("set", { id: "agent:project:build", state: "on" })
  expect(f.agents.state.get("build")?.mode).toBe("all")
  await call("set", { id: "item:project:build:compaction:strategy", text: "local" })
  await call("reset", { id: "agent:project:build" })
  expect(f.agents.state.get("build")?.mode).toBe("primary")
  const config = path.join(f.directory, ".opencodeplus", "project.json")
  const value = await Bun.file(config).json()
  await Bun.write(config, JSON.stringify({ ...value, protectedAgents: ["build"] }))
  await expect(call("set", { id: "agent:project:build", state: "off" })).rejects.toThrow("protected")
  await Effect.runPromise(registration.dispose)
})
