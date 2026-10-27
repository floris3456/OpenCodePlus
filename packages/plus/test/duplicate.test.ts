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

// Decision: a copy is never linked, so a preset-linked agent's copy carries the
// values it resolves to now as its own records, not a link to the preset.
test("a user agent's copy is its file, its rows and its folders, placed right after it, and is not linked to the original's preset", async () => {
  const { api, tools, project } = await fixture()
  await ok(tools, "set", { id: "agent:project:alpha", preset: "build" })
  await ok(tools, "set", { id: "item:project:alpha:tool:reader", text: "Alpha reads carefully." })
  await ok(tools, "set", { id: "item:project:alpha:tool:reader", state: "off" })
  await ok(tools, "set", { id: "item:project:alpha:setting:mode", text: "subagent" })
  await ok(tools, "create", { kind: "folder", id: "group:project:alpha:tools", name: "Files" })
  const copy = await ok(tools, "clipboard", { action: "duplicate", ids: ["agent:project:alpha"] })
  expect(copy).toEqual({ status: "Duplicated alpha as alpha-copy", rows: ["agent:project:alpha-copy"] })
  expect(await Bun.file(path.join(project, ".opencode", "agent", "alpha-copy.md")).text()).toBe(await Bun.file(path.join(project, ".opencode", "agent", "alpha.md")).text())
  const after = await rows(api)
  // No link at all, to the original or to its preset.
  expect((await load(project)).records.filter((record) => record.type === "link" && record.agent === "alpha-copy")).toEqual([])
  expect(after.find((row) => row.id === "agent:project:alpha-copy")?.owner?.link).toBeUndefined()
  // The same effective values, row for row, for a few rows.
  expect(after.find((row) => row.id === "item:project:alpha:tool:reader")?.badges.state).toBe("off")
  for (const suffix of ["tool:reader", "tool:execute", "setting:mode", "setting:enabled", "skill:notes", "system:role"]) {
    const original = after.find((row) => row.id === `item:project:alpha:${suffix}`)
    const copied = after.find((row) => row.id === `item:project:alpha-copy:${suffix}`)
    expect(copied?.badges.state, suffix).toBe(original?.badges.state)
    expect(copied?.badges.value, suffix).toBe(original?.badges.value)
    expect(copied, suffix).toBeDefined()
    const [before, next] = [JSON.stringify(await ok(tools, "read", { id: original!.id, view: "resolved" })), JSON.stringify(await ok(tools, "read", { id: copied!.id, view: "resolved" }))]
    expect(next.includes("Alpha reads carefully."), suffix).toBe(before.includes("Alpha reads carefully."))
  }
  expect(after.some((row) => row.id.startsWith("group:project:alpha-copy:tools:folder:") && row.label === "Files")).toBe(true)
  const agents = after.filter((row) => row.kind === "agent" && row.id.startsWith("agent:project:")).map((row) => row.id)
  expect(agents.indexOf("agent:project:alpha-copy")).toBe(agents.indexOf("agent:project:alpha") + 1)
  // The original is untouched.
  expect(JSON.stringify(await ok(tools, "read", { id: "item:project:alpha:tool:reader" }))).toContain("Alpha reads carefully.")
})

test("a built-in agent's copy is a user agent with the built-in's effective configuration, and no link", async () => {
  const { tools, project, api } = await fixture()
  await ok(tools, "set", { id: "item:project:build:tool:reader", state: "off" })
  const copy = await ok(tools, "clipboard", { action: "duplicate", ids: ["agent:project:build"], name: "builder" })
  expect(copy).toEqual({ status: "Duplicated build as builder", rows: ["agent:project:builder"] })
  expect(await Bun.file(path.join(project, ".opencode", "agent", "builder.md")).exists()).toBe(true)
  expect((await load(project)).records.filter((record) => record.type === "link" && record.agent === "builder")).toEqual([])
  expect(await state(api, "item:project:builder:tool:reader")).toBe("off")
  expect(await state(api, "item:project:builder:tool:reader")).toBe(await state(api, "item:project:build:tool:reader"))
})

test("a team member's copy carries its file and rows; a preset's copy its rows, and neither stays linked", async () => {
  const { tools, project, api } = await fixture()
  await ok(tools, "create", { kind: "team", team: "crew", level: "project" })
  await ok(tools, "create", { kind: "member", team: "crew", level: "project", id: "lead", preset: "build" })
  await ok(tools, "set", { id: "item:project:crew/:lead:tool:reader", state: "off" })
  expect(await ok(tools, "clipboard", { action: "duplicate", ids: ["team:project:crew:lead"] })).toEqual({ status: "Duplicated lead as lead-copy", rows: ["team:project:crew:lead-copy"] })
  const team = path.join(project, ".opencodeplus", "teams", "crew")
  expect(await Bun.file(path.join(team, "lead-copy.md")).text()).toBe(await Bun.file(path.join(team, "lead.md")).text())
  expect(await state(api, "item:project:crew/:lead-copy:tool:reader")).toBe("off")
  expect((await load(project)).records.filter((record) => record.type === "link" && record.agent === "lead-copy")).toEqual([])

  await ok(tools, "create", { kind: "preset", id: "careful", from: "build" })
  await ok(tools, "set", { id: "item:preset:careful:tool:reader", state: "off" })
  expect(await ok(tools, "clipboard", { action: "duplicate", ids: ["agent:preset:careful"] })).toEqual({ status: "Duplicated preset careful as careful-copy", rows: ["agent:preset:careful-copy"] })
  expect(await state(api, "item:preset:careful-copy:tool:reader")).toBe("off")
  // The copy is its own records: it neither follows careful nor careful's preset.
  expect((await load(project)).records.filter((record) => record.type === "link" && record.level === "preset" && record.agent === "careful-copy")).toEqual([])
  // A built-in preset's copy copies its values too (no link, no "created from it").
  expect((await ok(tools, "clipboard", { action: "duplicate", ids: ["agent:preset:build"] })).status).toBe("Duplicated preset build as build-copy")
  expect((await load(project)).records.filter((record) => record.type === "link" && record.level === "preset" && record.agent === "build-copy")).toEqual([])
})

test("a folder's copy holds a copy of every subfolder and row inside it that can exist twice, in order, and says what it skipped", async () => {
  const { api, tools } = await fixture()
  await ok(tools, "create", { kind: "folder", id: "group:project:alpha:tools", name: "Files" })
  await ok(tools, "create", { kind: "folder", id: "group:project:alpha:tools", name: "Other" })
  const family = (await rows(api)).find((row) => row.label === "Files" && row.id.includes(":folder:"))!.id
  await ok(tools, "create", { kind: "folder", id: family, name: "Inner" })
  // Rows that exist once (tools), inside the folder and inside its subfolder.
  await ok(tools, "move", { id: "item:project:alpha:tool:reader", into: family })
  const inner = (await rows(api)).find((row) => row.label === "Inner" && row.id.includes(":folder:"))!.id
  await ok(tools, "move", { id: "item:project:alpha:tool:skill", into: inner })
  const copy = await ok(tools, "clipboard", { action: "duplicate", ids: [family] })
  expect(copy.status).toMatch(/^Duplicated folder "Files" as "Files copy": .*skipped \(they exist once per agent\)/)
  const after = await rows(api)
  const folders = after.filter((row) => row.id.startsWith("group:project:alpha:tools:folder:")).map((row) => row.label)
  expect(folders).toEqual(["Files", "Inner", "Files copy", "Inner", "Other"])
  // The copied subfolder sits inside the copied folder, in order.
  const copied = after.findIndex((row) => row.label === "Files copy")
  expect(after[copied + 1]).toMatchObject({ label: "Inner", depth: after[copied]!.depth + 1 })
})

test("rows that exist once refuse with the reason and write nothing; a mixed selection says which were left", async () => {
  const { tools, project } = await fixture()
  await ok(tools, "create", { kind: "team", team: "crew", level: "project" })
  const before = await load(project)
  for (const [id, reason] of [
    ["item:project:alpha:tool:reader", '"reader" exists once for each agent: copy it (ctrl+c) and paste it (ctrl+v) onto another agent instead'],
    ["item:project:alpha:tool:reader:description", '"Description" is part of a row\'s text'],

    ["group:project:alpha:tools", '"Tools" is a fixed part of the screen'],
    ["agent:defaults:build", "Duplicate \"build\" at Project or Global"],
    ["item:project:alpha:system:role", "the request carries one Role/persona"],
    ["item:project:alpha:system:opencode/tools", "one tool definitions part"],
  ] as const) {
    const result = await call(tools, "clipboard", { action: "duplicate", ids: [id] })
    expect(result.ok ? "" : result.message).toContain(reason)
  }
  expect(await load(project)).toEqual(before)
  const mixed = await ok(tools, "clipboard", { action: "duplicate", ids: ["agent:project:alpha", "item:project:alpha:tool:reader"] })
  expect(mixed.rows).toEqual(["agent:project:alpha-copy"])
  expect(mixed.status).toContain('Duplicated alpha as alpha-copy; not duplicated: "reader" exists once for each agent')
})

test("a skill row duplicates as a new skill file with the same text", async () => {
  const { tools, project } = await fixture()
  const made = await ok(tools, "clipboard", { action: "duplicate", ids: ["item:project:alpha:skill:notes"] })
  expect(made).toEqual({ status: "Duplicated skill notes as notes-copy", rows: ["item:project:alpha:skill:notes-copy"] })
  // The copy is a project skill of its own, with the original's body; the host
  // lists it on its next skills rescan.
  const file = path.join(project, ".opencode", "skill", "notes-copy", "SKILL.md")
  expect(await Bun.file(file).text()).toContain("skill body")
  expect(await Bun.file(file).text()).toContain("name: notes-copy")
})

test("a built-in System row duplicates as a user System row with the text this owner sees, right after it", async () => {
  const { tools, api, project } = await fixture()
  await ok(tools, "set", { id: "item:project:alpha:system:tools-and-rules", text: "Alpha's own tools text" })
  const made = await ok(tools, "clipboard", { action: "duplicate", ids: ["item:project:alpha:system:tools-and-rules"] })
  expect(made).toEqual({ status: 'Duplicated "Tools and rules" as "Tools and rules copy"', rows: ["item:project:alpha:system:tools-and-rules-copy"] })
  const after = await rows(api)
  expect(after.find((row) => row.id === "item:project:alpha:system:tools-and-rules-copy")?.label).toBe("Tools and rules copy")
  // The copy is a user System row whose file carries the text this owner saw,
  // so it needs no records; the original's own edit stays where it was.
  expect(JSON.stringify(await ok(tools, "read", { id: "item:project:alpha:system:tools-and-rules-copy" }))).toContain("Alpha's own tools text")
  expect((await load(project)).records.some((record) => record.type === "customization" && record.item === "system:tools-and-rules-copy")).toBe(false)
  expect(JSON.stringify(await ok(tools, "read", { id: "item:project:alpha:system:tools-and-rules" }))).toContain("Alpha's own tools text")
})

test("a team duplicates as <team>-copy at the same level, with independent copies of its members", async () => {
  const { tools, api, project } = await fixture()
  await ok(tools, "create", { kind: "team", team: "crew", level: "project" })
  await ok(tools, "create", { kind: "member", team: "crew", level: "project", id: "lead", preset: "build" })
  await ok(tools, "create", { kind: "member", team: "crew", level: "project", id: "hand", preset: "build" })
  await ok(tools, "set", { id: "item:project:crew/:lead:tool:reader", state: "off" })
  const copy = await ok(tools, "clipboard", { action: "duplicate", ids: ["team:project:crew"] })
  expect(copy).toMatchObject({ rows: ["team:project:crew-copy"] })
  expect(copy.status).toContain('Duplicated team "crew" as "crew-copy": 2 members copied')
  const after = await rows(api)
  const copied = after.find((row) => row.id === "team:project:crew-copy")
  expect(copied?.label).toBe("crew-copy")
  expect(copied?.badges.state).toBe("off")
  // Each member is a copy of its own, with its own file and configuration.
  const dir = path.join(project, ".opencodeplus", "teams", "crew-copy")
  for (const member of ["lead", "hand"]) expect(await Bun.file(path.join(dir, `${member}.md`)).exists()).toBe(true)
  expect(after.find((row) => row.id === "team:project:crew-copy:lead")).toBeDefined()
  expect(await state(api, "item:project:crew-copy/:lead:tool:reader")).toBe("off")
  // No link keeps any of them following the original's presets.
  expect((await load(project)).records.filter((record) => record.type === "link" && (record.team?.team === "crew-copy" || record.agent === "lead" && record.team === undefined))).toEqual([])
  expect((await ok(tools, "clipboard", { action: "duplicate", ids: ["team:project:crew"] })).status).toContain('as "crew-copy-2"')
})
