import { afterEach, expect, test } from "bun:test"
import { AbsolutePath } from "@opencode/schema/schema"
import { Skill } from "@opencode/schema/skill"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { discover } from "../src/instructions/discover.js"
import { query } from "../src/instructions/query.js"
import { teachingFilePath, teachingItemId, teachingSkillId } from "../src/instructions/paths.js"
import { installTeaching, seedSystemInstruction, teachingContent, teachingSkillContent } from "../src/instructions/teaching.js"
import { context } from "./harness.js"

const roots: string[] = []
const previousConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (previousConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = previousConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function configDir(): Promise<string> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-teaching-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = root
  return root
}

test("seeding creates the file when missing", async () => {
  await configDir()
  const seeded = await seedSystemInstruction()
  expect(seeded.path).toBe(teachingFilePath())
  expect(seeded.content).toBe(teachingContent)
  expect(await fs.readFile(seeded.path, "utf8")).toBe(teachingContent)
})

test("seeding is idempotent", async () => {
  await configDir()
  const first = await seedSystemInstruction()
  const second = await seedSystemInstruction()
  expect(second).toEqual(first)
  expect(await fs.readFile(first.path, "utf8")).toBe(teachingContent)
})

test("seeding never overwrites user-edited content", async () => {
  await configDir()
  await fs.mkdir(path.dirname(teachingFilePath()), { recursive: true })
  await fs.writeFile(teachingFilePath(), "my own teaching\n")
  const seeded = await seedSystemInstruction()
  expect(seeded.content).toBe("my own teaching\n")
  expect(await fs.readFile(teachingFilePath(), "utf8")).toBe("my own teaching\n")
})

test("the instruction content stays within its size budget", async () => {
  expect(teachingContent.length).toBeLessThanOrEqual(600)
  for (const phrase of [
    "tools.instructions.*",
    "item:<level>:<agent|''>:<itemId>",
    "section:…:<sectionId>",
    "agent:<level>:<id>",
    "team:<level>:<name>",
    'list({where:"review:true"})',
    'show({id,view:"diff"})',
    'set({id,resolve:"keep"})',
    'list({where:"agent:X item:tool"})',
    "instructions-tools",
  ]) {
    expect(teachingContent).toContain(phrase)
  }
})

test("the skill content covers the tool surface", async () => {
  for (const phrase of [
    "list({ where?, fields?, sort?, limit?, offset? })",
    'show({ id, view? })',
    "set({ id, text?, state?, pin?, active?, resolve? })",
    "reset({ id })",
    "split({ id, boundaries?, add? })",
    "create({ kind, ...fields })",
    "delete({ id, confirm: true })",
    "log",
    "protectedAgents",
    "actor `tool`",
    "original→mine",
    "original→upstream",
  ]) {
    expect(teachingSkillContent).toContain(phrase)
  }
  expect(teachingSkillContent.length).toBeGreaterThan(2000)
})

test("every filter expression in the skill parses in the real query engine", async () => {
  const wheres = [...teachingSkillContent.matchAll(/where:\s*"((?:[^"\\]|\\.)*)"/g)].map((match) => match[1] ?? "")
  expect(wheres.length).toBeGreaterThan(0)
  const snapshot = { items: [], records: [], agents: [], teams: [] }
  for (const where of wheres) {
    const result = query(snapshot, { where })
    expect(result.rows).toEqual([])
    expect(result.total).toBe(0)
  }
})

test("declared structural key values validate against the real query engine", async () => {
  const line = teachingSkillContent.split("\n").find((entry) => entry.includes("Structural keys:")) ?? ""
  expect(line).toContain("Structural keys:")
  const declarations = [...line.matchAll(/`([A-Za-z]+)`\s*\(([^)]+)\)/g)].map((match) => ({ key: match[1] ?? "", raw: match[2] ?? "" }))
  expect(declarations.some((declaration) => declaration.key === "kind")).toBe(true)
  expect(declarations.some((declaration) => declaration.key === "item")).toBe(true)
  const snapshot = { items: [], records: [], agents: [], teams: [] }
  const validated = declarations.flatMap((declaration) => {
    if (declaration.key === "agent") {
      expect(declaration.raw).toContain("_")
      const agentShared = query(snapshot, { where: "agent:_" })
      expect(agentShared.total).toBe(agentShared.rows.length)
      return ["agent:_"]
    }
    const values = declaration.raw
      .split("|")
      .map((value) => value.trim())
      .filter((value) => value !== "" && !/[\s,;`]/.test(value))
    if (values.length < 2) return []
    values.forEach((value) => {
      const result = query(snapshot, { where: `${declaration.key}:${value}` })
      expect(result.total).toBe(result.rows.length)
    })
    return values.map((value) => `${declaration.key}:${value}`)
  })
  expect(validated.length).toBeGreaterThan(0)
})

test("installTeaching registers the instruction file and the skill", async () => {
  await configDir()
  const ctx = context()
  const registrations = await installTeaching(ctx)
  expect(registrations).toHaveLength(2)
  const files: { path: string; content: string }[] = []
  const probe = await Effect.runPromise(
    Effect.scoped(
      ctx.instruction.transform((editor) => {
        files.push(...editor.list())
      }),
    ),
  )
  await Effect.runPromise(probe.dispose)
  expect(files).toContainEqual({ path: teachingFilePath(), content: teachingContent })
  const listed = await Effect.runPromise(ctx.skill.list())
  expect(listed.data.some((skill) => skill.id === teachingSkillId)).toBe(true)
  const second = registrations[1]
  if (second === undefined) throw new Error("expected skill registration")
  await Effect.runPromise(second.dispose)
  const after = await Effect.runPromise(ctx.skill.list())
  expect(after.data.some((entry) => entry.id === teachingSkillId)).toBe(false)
})

test("a plugin origin does not survive Skill.Info decoding, so the skill matches by id", async () => {
  // Core registers plugin skills through Schema.decodeUnknownSync(Skill.Info)
  // (core/src/plugin/host.ts skill transform add), and Skill.Info declares no
  // origin field, so the extra key is dropped before it reaches skill state.
  const candidate = {
    id: Skill.ID.make("probe"),
    name: Skill.Name.make("probe"),
    location: AbsolutePath.make("/skills/probe.md"),
    content: "probe body",
    origin: { type: "plugin", name: "opencode.plus" },
  }
  const decoded = Schema.decodeUnknownSync(Skill.Info)(candidate)
  expect("origin" in decoded).toBe(false)
  await configDir()
  const ctx = context()
  const registrations = await installTeaching(ctx)
  expect(registrations).toHaveLength(2)
  const discovered = await discover({
    ctx,
    records: [],
    baseTemplates: [],
    activeBase: () => undefined,
  })
  const row = discovered.items.find((item) => item.id === `skill:${teachingSkillId}`)
  expect(row).toMatchObject({ kind: "skill", group: "plus" })
  const file = discovered.items.find((item) => item.id === teachingItemId)
  expect(file).toMatchObject({ kind: "system", group: "plus", title: "OpenCodePlus", text: teachingContent })
})
