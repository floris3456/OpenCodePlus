import { afterEach, expect, test } from "bun:test"
import { AbsolutePath } from "@opencode/schema/schema"
import { Skill } from "@opencode/schema/skill"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { defaultInclude, mergeUnits, renderMerge, withoutFinalNewline } from "../src/instructions/merge-units.js"
import {
  COMPACTION_STRATEGIES,
  MODEL_DEFAULT_FIELDS,
  MODEL_FIELD_NAMES,
  compactionFieldsOf,
  modelFieldItemId,
  modelSettingRowId,
  parseModelFieldItemId,
  parseModelSettingItemId,
} from "../src/instructions/model-settings.js"
import { discover } from "../src/instructions/discover.js"
import { query, rowTypes } from "../src/instructions/query.js"
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

// The text releases seeded from 5547160d98 on; installs seeded then still hold it.
const shippedBefore =
  "`tools.instructions.*` edits rows (tools/base/skills/system/MCP/models/teams/perms). " +
  "Ids: `item:<level>:<agent|''>:<itemId>`, `section:…:<sectionId>`, `agent:<level>:<id>`, `team:<level>:<name>[:<member>]`. " +
  "`create` returns `{id,item}`; `show`/`set`/`delete` take that `id`. " +
  "`list({where:\"review:true\"})`→`show({id,view:\"diff\"})`→`set({id,resolve:\"keep\"})`. " +
  "`list({where:\"agent:X item:tool\"})`→`set({id,text})`. " +
  "Patterns are core wildcards, not regex; shell resource is the parsed command, so `git *` matches bare `git`. " +
  "Skill `instructions-tools`: filters, views, create/delete, errors."

test("seeding replaces a text an earlier release seeded, but not one the person changed", async () => {
  await configDir()
  await fs.mkdir(path.dirname(teachingFilePath()), { recursive: true })
  await fs.writeFile(teachingFilePath(), shippedBefore)
  expect((await seedSystemInstruction()).content).toBe(teachingContent)
  expect(await fs.readFile(teachingFilePath(), "utf8")).toBe(teachingContent)
  await fs.writeFile(teachingFilePath(), `${shippedBefore}\nMy own line.`)
  expect((await seedSystemInstruction()).content).toBe(`${shippedBefore}\nMy own line.`)
  expect(await fs.readFile(teachingFilePath(), "utf8")).toBe(`${shippedBefore}\nMy own line.`)
})

test("the instruction content stays within its size budget", async () => {
  expect(teachingContent.length).toBeLessThanOrEqual(600)
  for (const phrase of [
    "tools.instructions.*",
    "item:<level>:<agent|''>:<itemId>",
    "section:…:<sectionId>",
    "agent:<level>:<id>",
    "team:<level>:<name>",
    'find({is:"review"})',
    'read({id,view:"diff"})',
    'set({id,resolve:"keep"})',
    'find({agent:"X",type:"tool"})',
    "edit({id,oldString,newString})",
    "id | badges | from",
    "instructions-tools",
  ]) {
    expect(teachingContent).toContain(phrase)
  }
})

test("the skill content covers the tool surface", async () => {
  for (const phrase of [
    "find({ agent?, team?, level?, type?, name?, in?, state?, text?, is?, where?, fields?, sort?, limit?, offset? })",
    'read({ id, view? })',
    "edit({ id, oldString, newString, replaceAll? })",
    "set({ id, text?, state?, pin?, active?, resolve?, warming?, interval?, waiting?, subagent?, prompt?, effort? })",
    "reset({ id })",
    "split({ id, boundaries?, add? })",
    "create({ kind, ...fields })",
    "delete({ id, confirm: true })",
    "log",
    "protectedAgents",
    "actor `tool`",
    "original→mine",
    "original→upstream",
    'set({ id, mode: "primary" })',
    "setting:<field>",
    "modeldefault:*",
    "compaction:strategy",
    "compaction:model",
    "compaction:instructions",
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

// find's parameters are the filter's terms, so each example call is checked
// as the terms the find tool builds from it.
test("every find example in the skill names real keys and values", async () => {
  // The signature (`find({ agent?, … })`) is not an example.
  const calls = [...teachingSkillContent.matchAll(/find\(\{([^}]*)\}\)/g)].map((match) => match[1] ?? "").filter((call) => !call.includes("?"))
  expect(calls.length).toBeGreaterThan(5)
  const snapshot = { items: [], records: [], agents: [], teams: [] }
  for (const call of calls) {
    const terms = [...call.matchAll(/(\w+):\s*"((?:[^"\\]|\\.)*)"/g)].map((match) => (match[1] === "where" ? (match[2] ?? "") : `${match[1]}:"${match[2]}"`))
    expect(terms.length).toBeGreaterThan(0)
    expect(() => query(snapshot, { where: terms.join(" ") })).not.toThrow()
  }
})

test("declared key values validate against the real query engine", async () => {
  const snapshot = { items: [], records: [], agents: [], teams: [] }
  const listed = (key: string) => {
    const line = teachingSkillContent.split("\n").find((entry) => entry.startsWith(`- \`${key}\`:`)) ?? ""
    return (line.match(/^- `\w+`: ([^.;]+)/)?.[1] ?? "").split(/, | or /).map((value) => value.trim())
  }
  expect(listed("type")).toEqual([...rowTypes])
  expect(listed("level")).toEqual(["project", "global", "defaults", "preset"])
  for (const type of listed("type")) expect(() => query(snapshot, { where: `type:${type}` })).not.toThrow()
  expect(teachingSkillContent).toContain("`_` is the shared rows")
  const line = teachingSkillContent.split("\n").find((entry) => entry.includes("More keys:")) ?? ""
  const declarations = [...line.matchAll(/`([A-Za-z]+)`\s*\(([^)]+)\)/g)].map((match) => ({ key: match[1] ?? "", raw: match[2] ?? "" }))
  const validated = declarations.flatMap((declaration) => {
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
    path: AbsolutePath.make("/skills/probe.md"),
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

test("documented per-model compaction ids are the ones the real parsers produce", async () => {
  for (const field of ["compactWarm", "coldFirst", "coldCompact", "coldModels", "compactionStrategy", "compactionModel", "compactionInstructions"] as const) {
    expect(MODEL_DEFAULT_FIELDS).toContain(field)
    expect(teachingSkillContent).toContain(field)
  }
  expect(MODEL_FIELD_NAMES).toContain("compactionModel")
  expect(MODEL_FIELD_NAMES).toContain("compactionInstructions")
  expect(MODEL_FIELD_NAMES).toContain("coldFirst")
  const coldFirst = modelSettingRowId({}, "coldFirst")
  expect(coldFirst).toBe("item:defaults:/models:modelsetting:coldFirst:*")
  expect(parseModelSettingItemId(coldFirst.replace("item:defaults:/models:", ""))).toEqual({ key: {}, field: "coldFirst" })
  expect(parseModelFieldItemId(modelFieldItemId({ providerID: "acme", modelID: "nova" }, "coldFirst"))).toEqual({
    target: { providerID: "acme", modelID: "nova" },
    field: "coldFirst",
  })

  const every = modelSettingRowId({}, "compactWarm")
  expect(every).toBe("item:defaults:/models:modelsetting:compactWarm:*")
  expect(parseModelSettingItemId(every.replace("item:defaults:/models:", ""))).toEqual({ key: {}, field: "compactWarm" })

  const one = modelSettingRowId({ providerID: "openai", modelID: "gpt-5" }, "compactionStrategy")
  expect(one).toBe("item:defaults:/models:modelsetting:compactionStrategy:openai/gpt-5")
  expect(parseModelSettingItemId(one.replace("item:defaults:/models:", ""))).toEqual({
    key: { providerID: "openai", modelID: "gpt-5" },
    field: "compactionStrategy",
  })
  // The stable shape the skill quotes for a Defaults field row.
  expect(teachingSkillContent).toContain("item:defaults:/models:modelsetting:<field>:<* or provider/model>")

  const agentField = modelFieldItemId({ providerID: "anthropic", modelID: "claude-opus-4", variant: "high" }, "compactionModel")
  expect(agentField).toBe("modelfield:compactionModel:anthropic/claude-opus-4@high")
  expect(parseModelFieldItemId(agentField)).toEqual({
    target: { providerID: "anthropic", modelID: "claude-opus-4", variant: "high" },
    field: "compactionModel",
  })
  expect(teachingSkillContent).toContain("modelfield:<field>:<provider>/<model>[@variant]")
})

test("documented compaction values validate with the real field parser", async () => {
  expect(COMPACTION_STRATEGIES).toEqual(["auto", "local", "remote"])
  expect(teachingSkillContent).toContain("`auto`, `local` or `remote`")

  const on = compactionFieldsOf({ compactWarm: "on" })
  expect("fields" in on && on.fields.compactWarm).toBe("on")
  // `coldFirst` takes the documented on|off and overrides the Settings switch per model.
  expect(teachingSkillContent).toContain("`coldFirst` (`on`|`off`)")
  expect(teachingSkillContent).toContain('the row reads "as in Settings" and the global switch decides')
  const coldFirst = compactionFieldsOf({ coldFirst: "off" })
  expect("fields" in coldFirst && coldFirst.fields.coldFirst).toBe("off")
  expect("error" in compactionFieldsOf({ coldFirst: "sometimes" })).toBe(true)
  const list = compactionFieldsOf({ coldModels: "a/one#high, b/two" })
  expect("fields" in list && list.fields.coldModels).toEqual(["a/one#high", "b/two"])
  const strategy = compactionFieldsOf({ compactionStrategy: "local" })
  expect("fields" in strategy && strategy.fields.compactionStrategy).toBe("local")
  const model = compactionFieldsOf({ compactionModel: "cheap/model#high" })
  expect("fields" in model && model.fields.compactionModel).toBe("cheap/model#high")
  const cleared = compactionFieldsOf({ coldModels: "" })
  expect("fields" in cleared && cleared.fields.coldModels).toBeNull()
  expect("error" in compactionFieldsOf({ compactionStrategy: "fast" })).toBe(true)
  expect("error" in compactionFieldsOf({ coldModels: "a/one, a/one" })).toBe(true)
})

test("the skill states the empty-instructions rule and the prompt-prefix timing", async () => {
  // Review point 1: empty compactionInstructions is an explicit empty summary
  // prompt, and reset resumes inheritance, unlike the other empty fields.
  expect(teachingSkillContent).toContain("explicit empty summary prompt")
  expect(teachingSkillContent).toContain("unlike the other fields")
  expect(teachingSkillContent).toContain("`reset` resumes inheritance")
  // The real parser keeps that distinction: "" clears every other compaction
  // field to null, but stores an explicit "" for the instructions.
  const cleared = compactionFieldsOf({
    compactWarm: "",
    coldCompact: "",
    coldModels: "",
    compactionStrategy: "",
    compactionModel: "",
    compactionInstructions: "",
  })
  if (!("fields" in cleared)) throw new Error("expected the cleared field values to parse")
  expect(cleared.fields).toEqual({
    compactWarm: null,
    coldCompact: null,
    coldModels: null,
    compactionStrategy: null,
    compactionModel: null,
    compactionInstructions: "",
  })
  const reset = compactionFieldsOf({ compactionInstructions: null })
  expect("fields" in reset && reset.fields.compactionInstructions).toBeNull()

  // Review point 2: setting edits alone do not rewrite a chat's prompt prefix;
  // the next actual compaction does.
  expect(teachingSkillContent).toContain("editing them does not itself rewrite an existing chat's prompt prefix")
  expect(teachingSkillContent).toContain("the next actual compaction does")
})

test("documented merge kinds, defaults and B41 match the real engine", async () => {
  const original = "Alpha one.\nBeta two.\nGamma three.\nDelta four.\nEpsilon five.\nZeta six.\nEta seven."
  const mine = "Alpha mine.\nBeta two.\nGamma three.\nDelta four.\nEpsilon yours.\nZeta six.\nEta same."
  const upstream = "Alpha one.\nBeta two.\nGamma upstream.\nDelta four.\nEpsilon upstream.\nZeta six.\nEta same.\n"
  const entries = mergeUnits(original, mine, upstream)
  const changes = entries.flatMap((entry) => (entry.type === "change" ? [entry] : []))
  expect(changes.map((entry) => [entry.id, entry.kind])).toEqual([
    ["m0", "yours"],
    ["m1", "upstream"],
    ["m2", "both"],
    ["m3", "same"],
  ])
  const both = changes.find((entry) => entry.kind === "both")
  expect(both?.upstreamId).toBe("m2:upstream")

  const defaults = defaultInclude(entries)
  expect(defaults.has("m2")).toBe(true)
  expect(defaults.has("m2:upstream")).toBe(false)
  const merged = renderMerge(entries, defaults)
  expect(merged).toBe("Alpha mine.\nBeta two.\nGamma upstream.\nDelta four.\nEpsilon yours.\nZeta six.\nEta same.")
  expect(merged).not.toContain("<<<<<<<")
  // The documented example include set shows both sides of a `both` unit, still
  // without markers, and defaults to the ids `show` returns.
  const chosen = renderMerge(entries, new Set(["m0", "m1", "m2", "m2:upstream", "m3"]))
  expect(chosen).toContain("Epsilon yours.")
  expect(chosen).toContain("Epsilon upstream.")
  expect(chosen).not.toContain("<<<<<<<")

  // B41: the final newline is not part of the comparison (the fixture above
  // ends in a `same` unit, not a `both`), and units compare without trailing
  // whitespace, so one appended sentence is one change, not two.
  expect(withoutFinalNewline(upstream)).toBe("Alpha one.\nBeta two.\nGamma upstream.\nDelta four.\nEpsilon upstream.\nZeta six.\nEta same.")
  expect(mergeUnits("A.\nB.", "A.\nB.", "A.\nB.\n").some((entry) => entry.type === "change")).toBe(false)
  expect(mergeUnits("One. Two.", "One. Two. Three.", "One. Two.").filter((entry) => entry.type === "change")).toHaveLength(1)
})

test("the skill documents the compact-warm switch and the global cold-chat setting", async () => {
  for (const phrase of ["/compact-warm", "<leader>j", "Settings › OpenCodePlus › Compact cold chats first", "`coldCompact` is refused", 'resolve: "merge"']) {
    expect(teachingSkillContent).toContain(phrase)
  }
  for (const gone of ["/compact-cold", "follow the model settings"]) expect(teachingSkillContent).not.toContain(gone)
})

test("the release workflow is listed under Plus skills without relabeling unrelated skills", async () => {
  await configDir()
  const ctx = context()
  const registration = await Effect.runPromise(Effect.scoped(ctx.skill.transform((editor) => {
    for (const [id, path] of [
      ["opencodeplus-release", "/config/opencodeplus/skills/opencodeplus-release/SKILL.md"],
      ["opencode", "/builtin/opencode/SKILL.md"],
      ["opencodeplus-unrelated", "/config/opencodeplus/skills/opencodeplus-unrelated/SKILL.md"],
      ["project-workflow", "/workspace/.opencode/skills/project-workflow/SKILL.md"],
    ]) {
      editor.add(Schema.decodeUnknownSync(Skill.Info)({ id, name: id, path, content: "workflow" }))
    }
  })))
  const discovered = await discover({ ctx, records: [], baseTemplates: [], activeBase: () => undefined })
  expect(discovered.items.filter((item) => item.kind === "skill").map((item) => [item.id, item.group])).toEqual([
    ["skill:opencodeplus-release", "plus"],
    ["skill:opencode", "native"],
    ["skill:opencodeplus-unrelated", "native"],
    ["skill:project-workflow", "project"],
  ])
  // Skills are listed under the skill tool, which core always registers.
  const skillTool = { id: "tool:skill", kind: "tool" as const, group: "native" as const, title: "skill", text: "Load a skill", enabled: true, fingerprint: "fp-skill" }
  const snapshot = {
    ...discovered,
    items: [...discovered.items, skillTool],
    records: [],
    agents: [{ id: "release", scope: "global" as const, origin: "user" as const }],
  }
  const plus = query(snapshot, { where: "kind:item item:skill level:global agent:release group:plus" })
  expect(plus.rows.map((row) => row.id)).toEqual(["item:global:release:skill:opencodeplus-release"])
  const native = query(snapshot, { where: "kind:item item:skill level:global agent:release group:native opencodeplus-release" })
  expect(native.rows).toEqual([])
  await Effect.runPromise(registration.dispose)
})
