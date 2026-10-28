// A skill body may carry its own frontmatter block (agents hand a whole
// SKILL.md over). createSkill merges it into the one block core reads instead
// of prepending a second one whose description is the body's literal "---".
import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createSkill } from "../src/agents/skills.js"

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function project(): Promise<string> {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-skill-frontmatter-"))
  roots.push(root)
  return path.join(root, "project")
}

// The file core reads: one leading block and a body. `matches` counts the
// blocks in the whole text, so a second one would show up here.
function blocks(text: string): { fields: Record<string, unknown>; body: string; count: number } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/)
  if (match === null) throw new Error(`no frontmatter block in ${JSON.stringify(text)}`)
  const fields = Bun.YAML.parse(match[1] ?? "") as Record<string, unknown>
  return { fields, body: match[2] ?? "", count: text.split(/^---$/m).length - 1 }
}

async function written(directory: string, id: string): Promise<string> {
  return Bun.file(path.join(directory, ".opencode", "skill", id, "SKILL.md")).text()
}

test("a body's own frontmatter is merged, keeping its extra keys and description", async () => {
  const directory = await project()
  const created = await createSkill({
    scope: "project",
    projectDirectory: directory,
    name: "notes",
    body: "---\nname: notes\ndescription: Keep notes.\ntype: Guide\n---\nTake notes as you go.\n",
  })
  if (!created.ok) throw new Error(`createSkill failed: ${JSON.stringify(created)}`)

  const file = blocks(await written(directory, "notes"))
  expect(file.count).toBe(2)
  expect(file.fields).toEqual({ name: "notes", description: "Keep notes.", type: "Guide" })
  expect(file.body).toBe("Take notes as you go.\n")
})

test("a missing name is added as the block's first line, and the description is derived", async () => {
  const directory = await project()
  const created = await createSkill({
    scope: "project",
    projectDirectory: directory,
    name: "notes",
    body: "---\ntype: Guide\n---\n\n  Take notes as you go.\nSecond line.\n",
  })
  if (!created.ok) throw new Error(`createSkill failed: ${JSON.stringify(created)}`)

  const file = blocks(await written(directory, "notes"))
  expect(file.count).toBe(2)
  expect(file.fields).toEqual({ name: "notes", description: "Take notes as you go.", type: "Guide" })
  expect(file.body).toBe("\n  Take notes as you go.\nSecond line.\n")
})

test("a missing name is added as the block's first line, keeping its description", async () => {
  const directory = await project()
  const created = await createSkill({
    scope: "project",
    projectDirectory: directory,
    name: "notes",
    body: "---\ndescription: Keep notes.\ntype: Guide\n---\nTake notes as you go.\n",
  })
  if (!created.ok) throw new Error(`createSkill failed: ${JSON.stringify(created)}`)

  const file = blocks(await written(directory, "notes"))
  expect(file.count).toBe(2)
  expect(file.fields).toEqual({ name: "notes", description: "Keep notes.", type: "Guide" })
  expect(file.body).toBe("Take notes as you go.\n")
})

test("a description that is not a string is replaced, since core would skip the file", async () => {
  const directory = await project()
  const created = await createSkill({
    scope: "project",
    projectDirectory: directory,
    name: "notes",
    body: "---\nname: notes\ndescription: 5\ntype: Guide\n---\nTake notes as you go.\n",
  })
  if (!created.ok) throw new Error(`createSkill failed: ${JSON.stringify(created)}`)

  const file = blocks(await written(directory, "notes"))
  expect(file.count).toBe(2)
  expect(file.fields).toEqual({ name: "notes", description: "Take notes as you go.", type: "Guide" })
  expect(file.body).toBe("Take notes as you go.\n")
})

test("a description falls back to the name when the body has no text after the block", async () => {
  const directory = await project()
  const created = await createSkill({
    scope: "project",
    projectDirectory: directory,
    name: "notes",
    body: "---\nname: notes\n---\n",
  })
  if (!created.ok) throw new Error(`createSkill failed: ${JSON.stringify(created)}`)

  expect(blocks(await written(directory, "notes")).fields).toEqual({ name: "notes", description: "notes" })
})

test("a frontmatter name that differs from the skill is refused before anything is written", async () => {
  const directory = await project()
  const refused = await createSkill({
    scope: "project",
    projectDirectory: directory,
    name: "notes",
    body: "---\nname: other\ndescription: Keep notes.\n---\nBody.\n",
  })
  expect(refused.ok).toBe(false)
  if (refused.ok || refused.reason !== "invalid") throw new Error("expected the create to be refused as invalid")
  expect(refused.reason).toBe("invalid")
  expect(refused.message).toBe('The body\'s frontmatter names "other" but the skill is "notes"; make them equal or leave name out.')
  expect(await Bun.file(path.join(directory, ".opencode", "skill", "notes", "SKILL.md")).exists()).toBe(false)
})

test("a block that is not valid YAML, or not a mapping, is refused before anything is written", async () => {
  const directory = await project()
  for (const body of ["---\nname: [unclosed\n---\nBody.\n", "---\n- notes\n- other\n---\nBody.\n"]) {
    const refused = await createSkill({ scope: "project", projectDirectory: directory, name: "notes", body })
    expect(refused.ok).toBe(false)
    if (refused.ok || refused.reason !== "invalid")
      throw new Error(`expected the create to be refused for ${JSON.stringify(body)}`)
    expect(refused.reason).toBe("invalid")
    expect(refused.message).toBe(
      "The body begins with a frontmatter block that is not valid YAML; fix it or leave it out.",
    )
  }
  expect(await Bun.file(path.join(directory, ".opencode", "skill", "notes", "SKILL.md")).exists()).toBe(false)
})

test("a body without frontmatter is written exactly as before", async () => {
  const directory = await project()
  const created = await createSkill({
    scope: "project",
    projectDirectory: directory,
    name: "notes",
    body: "Take notes as you go.\n",
  })
  if (!created.ok) throw new Error(`createSkill failed: ${JSON.stringify(created)}`)

  const text = await written(directory, "notes")
  expect(text).toBe('---\nname: notes\ndescription: "Take notes as you go."\n---\nTake notes as you go.\n')
  expect(blocks(text).count).toBe(2)
})
