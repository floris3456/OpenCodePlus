// Duplicate (instructions_clipboard action duplicate, TUI ctrl+d): the copy's
// name, the configuration it carries and the rows that refuse.
import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Deferred, Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import { createPlusApi, createState, type PlusApi } from "../src/index.js"
import { formatMarkdown } from "../src/agents/files.js"
import { copyName, systemOrderCopy } from "../src/instructions/duplicate.js"
import { load } from "../src/instructions/store.js"
import { memoInputOf } from "../src/instructions/snapshot.js"
import { expandedTree } from "../src/instructions/tree.js"
import { registerInstructionTools } from "../src/tools.js"
import { agentInfo, fullContext, skillInfo } from "./harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

type Tools = Map<string, Tool.Info & { readonly id: string }>

async function fixture(): Promise<{ api: PlusApi; tools: Tools; project: string }> {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-duplicate-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  await Bun.write(path.join(project, ".opencode", "agent", "alpha.md"), formatMarkdown({ description: "Alpha", mode: "primary" }, "Alpha's own prompt.\n"))
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha"), agentInfo("build")],
    tools: [{ id: "reader", description: "read things", options: { codemode: false } }, { id: "skill", description: "Load a skill", options: { codemode: false } }],
    skills: [skillInfo("notes", "skill body")],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  return { api, tools: await readTools(ctx), project }
}

async function readTools(ctx: Context): Promise<Tools> {
  return Effect.runPromise(Effect.scoped(Effect.gen(function* () {
    const deferred = yield* Deferred.make<readonly (Tool.Info & { readonly id: string })[], never>()
    yield* ctx.tool.transform((editor) => {
      Deferred.doneUnsafe(deferred, Effect.succeed([...editor.list()]))
    })
    return new Map((yield* Deferred.await(deferred)).map((tool) => [tool.id, tool]))
  })))
}

async function call(tools: Tools, name: string, input: unknown): Promise<{ readonly ok: true; readonly output: any } | { readonly ok: false; readonly message: string }> {
  const tool = tools.get(`instructions_${name}`)
  if (tool === undefined) throw new Error(`missing instructions_${name}`)
  const context = { sessionID: Session.ID.make("ses_duplicate"), agent: Agent.ID.make("alpha"), messageID: SessionMessage.ID.make("msg_duplicate"), id: Tool.CallID.make("call_duplicate"), progress: () => Effect.void }
  return Effect.runPromise(tool.execute(input, context).pipe(
    Effect.map((result) => ({ ok: true as const, output: (result as { output: unknown }).output })),
    Effect.catchTag("Tool.Error", (error) => Effect.succeed({ ok: false as const, message: error.message })),
  ))
}

async function ok(tools: Tools, name: string, input: unknown) {
  const result = await call(tools, name, input)
  if (!result.ok) throw new Error(`instructions_${name} failed: ${result.message}`)
  return result.output
}

async function rows(api: PlusApi) {
  return expandedTree(memoInputOf((await api.snapshot()).value))
}

async function state(api: PlusApi, id: string) {
  return (await rows(api)).find((row) => row.id === id)?.badges.state
}

test("a copy is named \"<name> copy\", then numbered; ids take -copy", () => {
  expect(copyName("Rules", new Set(), " ")).toBe("Rules copy")
  expect(copyName("Rules", new Set(["Rules copy", "Rules copy 2"]), " ")).toBe("Rules copy 3")
  expect(copyName("team/lead", new Set(["team/lead-copy"]), "-")).toBe("team/lead-copy-2")
})

test("a stored System order lists the copy right after the original", () => {
  const order = { type: "order" as const, level: "project" as const, scope: "group:group:project:alpha:system", items: ["system:role", "system:mine", "system:other"], updated: "2026-10-27" }
  expect(systemOrderCopy({ folders: [], orders: [order] }, "system:mine", "system:mine-copy", "now").orders[0]?.items).toEqual(["system:role", "system:mine", "system:mine-copy", "system:other"])
})

test("a user System row's copy carries its text and every agent's settings, and a second copy is numbered", async () => {
  const { api, tools } = await fixture()
  await ok(tools, "create", { kind: "system", id: "mine", title: "Mine", text: "My rules" })
  await ok(tools, "set", { id: "item:project:alpha:system:mine", state: "on" })
  await ok(tools, "set", { id: "item:project:build:system:mine", text: "Build's own rules" })
  const first = await ok(tools, "clipboard", { action: "duplicate", ids: ["item:project:alpha:system:mine"] })
  expect(first).toEqual({ status: 'Duplicated "Mine" as "Mine copy"', rows: ["item:project:alpha:system:mine-copy"] })
  const after = await rows(api)
  expect(after.find((row) => row.id === "item:project:alpha:system:mine-copy")).toMatchObject({ label: "Mine copy", badges: { state: "on" } })
  const read = await ok(tools, "read", { id: "item:project:build:system:mine-copy" })
  expect(JSON.stringify(read)).toContain("Build's own rules")
  expect(JSON.stringify(await ok(tools, "read", { id: "item:defaults::system:mine-copy" }))).toContain("My rules")
  const second = await ok(tools, "clipboard", { action: "duplicate", ids: ["item:project:alpha:system:mine"] })
  expect(second.status).toBe('Duplicated "Mine" as "Mine copy 2"')
  const named = await ok(tools, "clipboard", { action: "duplicate", ids: ["item:project:alpha:system:mine"], name: "Team rules" })
  expect(named.rows).toEqual(["item:project:alpha:system:team-rules"])
})

test("a user agent's copy is its file, its rows, its link and its folders, placed right after it", async () => {
  const { api, tools, project } = await fixture()
  await ok(tools, "set", { id: "agent:project:alpha", preset: "build" })
  await ok(tools, "set", { id: "item:project:alpha:tool:reader", text: "Alpha reads carefully." })
  await ok(tools, "create", { kind: "folder", id: "group:project:alpha:tools", name: "Files" })
  const copy = await ok(tools, "clipboard", { action: "duplicate", ids: ["agent:project:alpha"] })
  expect(copy).toEqual({ status: "Duplicated alpha as alpha-copy", rows: ["agent:project:alpha-copy"] })
  expect(await Bun.file(path.join(project, ".opencode", "agent", "alpha-copy.md")).text()).toBe(await Bun.file(path.join(project, ".opencode", "agent", "alpha.md")).text())
  expect(JSON.stringify(await ok(tools, "read", { id: "item:project:alpha-copy:tool:reader" }))).toContain("Alpha reads carefully.")
  const stored = await load(project)
  expect(stored.records).toContainEqual(expect.objectContaining({ type: "link", level: "project", agent: "alpha-copy", preset: { kind: "agent", id: "build" } }))
  const after = await rows(api)
  expect(after.some((row) => row.id.startsWith("group:project:alpha-copy:tools:folder:") && row.label === "Files")).toBe(true)
  const agents = after.filter((row) => row.kind === "agent" && row.id.startsWith("agent:project:")).map((row) => row.id)
  expect(agents.indexOf("agent:project:alpha-copy")).toBe(agents.indexOf("agent:project:alpha") + 1)
  // The original is untouched.
  expect(JSON.stringify(await ok(tools, "read", { id: "item:project:alpha:tool:reader" }))).toContain("Alpha reads carefully.")
})

test("an agent's copy goes right after its original in its catalogue list", async () => {
  // Two agents whose names sort either side of the copy's, so an unsaved
  // order (the file order) cannot accidentally place it right.
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-duplicate-order-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  await Bun.write(path.join(project, ".opencode", "agent", "alpha.md"), formatMarkdown({ mode: "primary" }, "a\n"))
  await Bun.write(path.join(project, ".opencode", "agent", "zulu.md"), formatMarkdown({ mode: "primary" }, "z\n"))
  const ctx = fullContext({ directory: project, agents: [agentInfo("alpha"), agentInfo("zulu")] })
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  const tools = await readTools(ctx)

  await ok(tools, "clipboard", { action: "duplicate", ids: ["agent:project:alpha"], name: "yyy" })
  const listed = await rows(api)
  const agents = listed.filter((row) => row.kind === "agent" && row.id.startsWith("agent:project:")).map((row) => row.id)
  expect(agents).toEqual(["agent:project:alpha", "agent:project:yyy", "agent:project:zulu"])
})

test("a built-in agent's copy is a user agent created from its preset, with this level's rows", async () => {
  const { tools, project, api } = await fixture()
  await ok(tools, "set", { id: "item:project:build:tool:reader", state: "off" })
  const copy = await ok(tools, "clipboard", { action: "duplicate", ids: ["agent:project:build"], name: "builder" })
  expect(copy).toEqual({ status: "Duplicated build as builder (a new agent from preset build)", rows: ["agent:project:builder"] })
  expect(await Bun.file(path.join(project, ".opencode", "agent", "builder.md")).exists()).toBe(true)
  expect((await load(project)).records).toContainEqual(expect.objectContaining({ type: "link", agent: "builder", preset: { kind: "agent", id: "build" } }))
  expect(await state(api, "item:project:builder:tool:reader")).toBe("off")
})

test("a team member's copy carries its file and rows; a user preset's copy its rows and its own link", async () => {
  const { tools, project, api } = await fixture()
  await ok(tools, "create", { kind: "team", team: "crew", level: "project" })
  await ok(tools, "create", { kind: "member", team: "crew", level: "project", id: "lead", preset: "build" })
  await ok(tools, "set", { id: "item:project:crew/:lead:tool:reader", state: "off" })
  expect(await ok(tools, "clipboard", { action: "duplicate", ids: ["team:project:crew:lead"] })).toEqual({ status: "Duplicated lead as lead-copy", rows: ["team:project:crew:lead-copy"] })
  const team = path.join(project, ".opencodeplus", "teams", "crew")
  expect(await Bun.file(path.join(team, "lead-copy.md")).text()).toBe(await Bun.file(path.join(team, "lead.md")).text())
  expect(await state(api, "item:project:crew/:lead-copy:tool:reader")).toBe("off")

  await ok(tools, "create", { kind: "preset", id: "careful", from: "build" })
  await ok(tools, "set", { id: "item:preset:careful:tool:reader", state: "off" })
  expect(await ok(tools, "clipboard", { action: "duplicate", ids: ["agent:preset:careful"] })).toEqual({ status: "Duplicated preset careful as careful-copy", rows: ["agent:preset:careful-copy"] })
  expect(await state(api, "item:preset:careful-copy:tool:reader")).toBe("off")
  // It stands next to the original instead of following it: same base preset.
  expect((await load(project)).records).toContainEqual(expect.objectContaining({ type: "link", level: "preset", agent: "careful-copy", preset: { kind: "agent", id: "build" } }))
  expect((await ok(tools, "clipboard", { action: "duplicate", ids: ["agent:preset:build"] })).status).toBe("Duplicated preset build as build-copy (created from it)")
})

test("a folder's copy is an empty folder right after it", async () => {
  const { tools, api } = await fixture()
  await ok(tools, "create", { kind: "folder", id: "group:project:alpha:tools", name: "Files" })
  await ok(tools, "create", { kind: "folder", id: "group:project:alpha:tools", name: "Other" })
  const folder = (await rows(api)).find((row) => row.label === "Files" && row.id.includes(":folder:"))!.id
  const copy = await ok(tools, "clipboard", { action: "duplicate", ids: [folder] })
  expect(copy.status).toBe('Duplicated folder "Files" as "Files copy" (empty: a row sits in one folder)')
  const folders = (await rows(api)).filter((row) => row.id.startsWith("group:project:alpha:tools:folder:")).map((row) => row.label)
  expect(folders).toEqual(["Files", "Files copy", "Other"])
})

test("rows that exist once refuse with the reason and write nothing; a mixed selection says which were left", async () => {
  const { tools, project } = await fixture()
  await ok(tools, "create", { kind: "team", team: "crew", level: "project" })
  const before = await load(project)
  for (const [id, reason] of [
    ["item:project:alpha:tool:reader", '"reader" exists once for each agent: copy it (ctrl+c) and paste it (ctrl+v) onto another agent instead'],
    ["item:project:alpha:tool:reader:description", '"Description" is part of a row\'s text'],
    ["team:project:crew", "Teams cannot be duplicated"],
    ["group:project:alpha:tools", '"Tools" is a fixed part of the screen'],
    ["agent:defaults:build", "Duplicate \"build\" at Project or Global"],
  ] as const) {
    const result = await call(tools, "clipboard", { action: "duplicate", ids: [id] })
    expect(result.ok ? "" : result.message).toContain(reason)
  }
  expect(await load(project)).toEqual(before)
  const mixed = await ok(tools, "clipboard", { action: "duplicate", ids: ["agent:project:alpha", "item:project:alpha:tool:reader"] })
  expect(mixed.rows).toEqual(["agent:project:alpha-copy"])
  expect(mixed.status).toContain('Duplicated alpha as alpha-copy; not duplicated: "reader" exists once for each agent')
})
