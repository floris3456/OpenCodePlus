import { afterEach, expect, test } from "bun:test"
import { AbsolutePath } from "@opencode/schema/schema"
import { Skill } from "@opencode/schema/skill"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { discover } from "../src/instructions/discover.js"
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
  expect(teachingContent.length).toBeLessThanOrEqual(420)
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
    "set({ id, text?, state?, resolve? })",
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
