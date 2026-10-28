// Core reads skill files in its config skill plugin, on a config reload:
// Skill.reload only re-runs the plugin's installed transform over the skills
// it read last. So a project skill file Plus writes during a create, import or
// delete is missing from the registry — and from the snapshot the Instructions
// screen paints — until that rescan. The write asks for the rescan and waits
// for the skill.updated it publishes, so the snapshot right after it lists the
// skill instead of leaving it to a restart. Skills in the watched global roots
// need none.
import { afterEach, expect, test } from "bun:test"
import { Tool } from "@opencode/schema/tool"
import { Skill } from "@opencode/schema/skill"
import { AbsolutePath } from "@opencode/schema/schema"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Deferred, Effect, PubSub, Stream, type Types } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SkillDomain } from "@opencode/plugin/effect/skill"
import { createPlusApi, createState } from "../src/index.js"
import { registerInstructionTools } from "../src/tools.js"
import { agentInfo, context, fullContext } from "./harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

// The fields core's skill-file parser reads from one SKILL.md.
function fieldsOf(text: string): { name?: string; description?: string; content: string } | undefined {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/)
  if (match === null) return undefined
  try {
    const data: unknown = Bun.YAML.parse(match[1] ?? "")
    if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined
    const fields = data as { name?: unknown; description?: unknown }
    return {
      ...(typeof fields.name === "string" ? { name: fields.name } : {}),
      ...(typeof fields.description === "string" ? { description: fields.description } : {}),
      content: match[2] ?? "",
    }
  } catch {
    return undefined
  }
}

// Core's skill registry as the real one behaves for files: `reload` re-runs
// the installed transforms over the skills the config skill plugin read at its
// last scan and publishes skill.updated; `config.reload({ force: true })` is
// what rescans those folders from disk, after which the plugin reloads the
// domain (config/plugin/skill.ts).
function coreSkills(directory: string, skillRoots: readonly string[]) {
  const documents = new Map<string, Skill.Info>()
  const installed: Array<Parameters<SkillDomain["transform"]>[0]> = []
  // Core's bus is a PubSub: every subscriber sees every event. A queue would
  // hand one event to whichever subscriber took it first.
  const events = Effect.runSync(PubSub.unbounded<{ readonly type: string }>())
  const counts = { reads: 0, reloads: 0 }
  const live = new Map<string, Types.DeepMutable<Skill.Info>>()

  function rebuild() {
    live.clear()
    for (const [id, skill] of documents) live.set(id, structuredClone(skill) as Types.DeepMutable<Skill.Info>)
    const editor = {
      list: () => Array.from(live.values()),
      get: (id: string) => live.get(id),
      add: (skill: Skill.Info) => {
        live.set(skill.id, structuredClone(skill) as Types.DeepMutable<Skill.Info>)
      },
      update: (id: string, update: (skill: Types.DeepMutable<Skill.Info>) => void) => {
        const current = live.get(id)
        if (current !== undefined) update(current)
      },
      remove: (id: string) => {
        live.delete(id)
      },
    }
    for (const transform of installed) transform(editor)
  }

  async function read(): Promise<Map<string, Skill.Info>> {
    const found = new Map<string, Skill.Info>()
    for (const root of skillRoots) {
      const files = await fs.readdir(root, { recursive: true, withFileTypes: true }).catch(() => [])
      for (const file of files) {
        if (!file.isFile() || file.name !== "SKILL.md") continue
        const filepath = path.join(file.parentPath, file.name)
        const fields = fieldsOf(await fs.readFile(filepath, "utf8"))
        // Core skips a file with no valid frontmatter, and the folder names it.
        if (fields === undefined) continue
        const id = Skill.ID.make(path.basename(path.dirname(filepath)))
        if (found.has(String(id))) continue
        found.set(String(id), {
          id,
          name: Skill.Name.make(fields.name ?? String(id)),
          ...(fields.description === undefined ? {} : { description: fields.description }),
          path: AbsolutePath.make(filepath),
          content: fields.content,
        })
      }
    }
    return found
  }

  const domain: SkillDomain = {
    list: () => Effect.succeed({ location: fullContext({ directory }).location, data: Array.from(live.values()) }),
    transform: (callback) =>
      Effect.sync(() => {
        installed.push(callback)
        rebuild()
        return {
          dispose: Effect.sync(() => {
            const index = installed.indexOf(callback)
            if (index === -1) return
            installed.splice(index, 1)
            rebuild()
          }),
        }
      }),
    // What core's Skill domain does: no rescan of the folders, only another
    // pass over the skills its plugin handed it, then skill.updated.
    reload: () =>
      Effect.gen(function* () {
        counts.reloads++
        rebuild()
        yield* PubSub.publish(events, { type: Skill.Event.Updated.type })
      }),
  }

  return {
    domain,
    events,
    counts,
    // What a config reload does: rescan the folders, then let the skill plugin
    // rebuild the domain and announce it.
    configReload: () =>
      Effect.gen(function* () {
        counts.reads++
        const found = yield* Effect.promise(() => read())
        documents.clear()
        for (const [id, skill] of found) documents.set(id, skill)
        rebuild()
        yield* PubSub.publish(events, { type: Skill.Event.Updated.type })
      }),
  }
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-skill-rescan-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  await fs.mkdir(path.join(project, ".opencode", "skill"), { recursive: true })
  const core = coreSkills(project, [path.join(project, ".opencode", "skill"), path.join(root, "config", "skills")])
  const ctx = context({
    ...fullContext({
      directory: project,
      // `alpha` is a user agent, which starts every row it does not set off;
      // `build` is an OpenCode agent, which keeps its upstream value.
      agents: [agentInfo("alpha"), agentInfo("build")],
      tools: [{ id: "skill", description: "Load a skill", options: { codemode: false } }],
    }),
    skill: core.domain,
    config: { reload: () => core.configReload() },
    event: { subscribe: () => Stream.fromPubSub(core.events) as never },
  })
  // Boot reads the skill folders once, as the host does.
  await Effect.runPromise(core.configReload())
  const api = createPlusApi(ctx, createState())
  await registerInstructionTools(ctx, api)
  await api.refresh()
  return { api, core, ctx }
}

type Tools = Map<string, Tool.Info & { readonly id: string }>

async function readTools(ctx: Context): Promise<Tools> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<readonly (Tool.Info & { readonly id: string })[], never>()
        yield* ctx.tool.transform((editor) => {
          Deferred.doneUnsafe(deferred, Effect.succeed([...editor.list()]))
        })
        return new Map((yield* Deferred.await(deferred)).map((tool) => [tool.id, tool]))
      }),
    ),
  )
}

function need(tools: Tools, id: string): Tool.Info & { readonly id: string } {
  const tool = tools.get(id)
  if (tool === undefined) throw new Error(`missing tool ${id}`)
  return tool
}

async function runOk(tool: Tool.Info & { readonly id: string }, input: unknown): Promise<unknown> {
  const outcome = await Effect.runPromise(
    tool.execute(input, {
      sessionID: Session.ID.make("ses_skill_rescan"),
      agent: Agent.ID.make("alpha"),
      messageID: SessionMessage.ID.make("msg_skill_rescan"),
      id: Tool.CallID.make("call_skill_rescan"),
      progress: () => Effect.void,
    }).pipe(
      Effect.map((result) => ({ ok: true as const, result })),
      Effect.catchTag("Tool.Error", (error) => Effect.succeed({ ok: false as const, error })),
    ),
  )
  if (!outcome.ok) throw new Error(`expected tool success, got error: ${outcome.error.message}`)
  return (outcome.result as { output: unknown }).output
}

type List = { readonly rows: readonly string[]; readonly total: number }
const ids = (list: List) => list.rows.map((row) => row.split(" | ")[0] ?? "")

test("a created project skill is listed at once, though the host registry only rescans on a config reload", async () => {
  const { api, core, ctx } = await fixture()
  const tools = await readTools(ctx)
  const created = (await runOk(need(tools, "instructions_create"), {
    kind: "skill",
    name: "notes",
    body: "---\ntype: Guide\ndescription: Keep notes.\n---\nTake notes as you go.\n",
  })) as { readonly id: string; readonly item: string }
  // No create.failed: the created row came back from the tree.
  expect(created.item).toBe("skill:notes")

  // No refresh call before this read: the create's own wait is what listed it.
  const list = (await runOk(need(tools, "instructions_find"), { type: "skill", limit: 500 })) as List
  expect(ids(list)).toContain(created.id)
  expect(list.rows.find((row) => row.startsWith(`${created.id} |`))).toBeDefined()
  // The rescan it waited for is the host's config reload, not a restart.
  expect(core.counts.reads).toBeGreaterThan(1)
  expect((await api.snapshot()).value.items.some((item) => item.id === "skill:notes")).toBe(true)
})

test("a deleted project skill is gone from the snapshot at once", async () => {
  const { api, core, ctx } = await fixture()
  const tools = await readTools(ctx)
  const created = (await runOk(need(tools, "instructions_create"), { kind: "skill", name: "doomed", body: "Doomed." })) as {
    readonly id: string
  }
  await runOk(need(tools, "instructions_delete"), { id: created.id, confirm: true })
  expect((await api.snapshot()).value.items.some((item) => item.id === "skill:doomed")).toBe(false)
  expect(core.counts.reads).toBeGreaterThan(1)
})

test("a new skill's row for a user agent resolves off; the OpenCode agent keeps it on", async () => {
  const { ctx } = await fixture()
  const tools = await readTools(ctx)
  const created = (await runOk(need(tools, "instructions_create"), { kind: "skill", name: "notes", body: "Take notes." })) as {
    readonly id: string
  }
  const rowFor = async (agent: string) =>
    ((await runOk(need(tools, "instructions_find"), { type: "skill", agent, limit: 500 })) as List).rows.find((row) =>
      row.startsWith(`${created.id} | `) || row.includes(":skill:notes |"),
    )
  // A user agent starts the skill off; an OpenCode agent keeps its upstream
  // value, which is what core's own availability check reads.
  expect(await rowFor("alpha")).toContain(" | off | off by default")
  expect(await rowFor("build")).toContain(" | on | OpenCode")
})
