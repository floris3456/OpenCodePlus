// Core reads agent markdown in its config agent plugin, on a config reload:
// Agent.reload only re-runs the registered transforms over the documents it
// read last. So a project agent file Plus writes during a create, duplicate or
// rename is missing from the registry — and from the snapshot the Instructions
// screen paints — until that rescan. The write asks for the rescan and waits
// for the agent.updated it publishes, so the snapshot right after it lists the
// agent instead of leaving it to a restart.
import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Effect, Queue, Stream, type Types } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { AgentDomain } from "@opencode/plugin/effect/agent"
import { formatMarkdown, idFromPath, parseFrontmatter } from "../src/agents/files.js"
import { createPlusApi, createState } from "../src/index.js"
import { context, fullContext } from "./harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

// Core's agent registry as the real one behaves for files: `reload` (what
// Plus's file ops call) re-runs the installed transforms over the documents the
// config agent plugin read at its last load, and publishes agent.updated;
// `config.reload({ force: true })` is what rescans those documents from disk.
function coreAgents(directory: string) {
  const documents = new Map<string, Agent.Info>()
  const installed: Array<Parameters<AgentDomain["transform"]>[0]> = []
  const events = Effect.runSync(Queue.unbounded<{ readonly type: string }>())
  const counts = { reads: 0, reloads: 0 }
  const live = new Map<string, Types.DeepMutable<Agent.Info>>()

  function rebuild() {
    live.clear()
    for (const [id, agent] of documents) live.set(id, structuredClone(agent) as Types.DeepMutable<Agent.Info>)
    const editor = {
      list: () => Array.from(live.values()),
      get: (id: string) => live.get(id),
      default: () => undefined,
      update: (id: string, update: (agent: Types.DeepMutable<Agent.Info>) => void) => {
        const key = Agent.ID.make(id)
        const current = live.get(key) ?? Agent.Info.default(key)
        if (!live.has(key)) live.set(key, current)
        update(current)
        current.id = key
      },
      remove: (id: string) => {
        live.delete(id)
      },
    }
    for (const transform of installed) transform(editor)
  }

  async function read(directory: string): Promise<Map<string, Agent.Info>> {
    const found = new Map<string, Agent.Info>()
    const files = await fs.readdir(directory, { recursive: true, withFileTypes: true }).catch(() => [])
    for (const file of files) {
      if (!file.isFile() || !file.name.endsWith(".md")) continue
      const filepath = path.join(file.parentPath, file.name)
      const text = await fs.readFile(filepath, "utf8")
      const fields = parseFrontmatter(text)
      const id = Agent.ID.make(idFromPath(directory, filepath))
      // Core skips an empty file, and a body with no frontmatter still names an
      // agent (Info.default), exactly like its own decode.
      if (text.trim().length === 0) continue
      found.set(
        String(id),
        {
          ...Agent.Info.default(id),
          ...(fields?.mode === undefined ? {} : { mode: fields.mode }),
          ...(fields?.description === undefined ? {} : { description: fields.description }),
        } as Agent.Info,
      )
    }
    return found
  }

  const domain: AgentDomain = {
    get: () => Effect.die("unused agent.get"),
    list: () => Effect.sync(() => ({ location: fullContext({ directory }).location, data: Array.from(live.values()) })),
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
    // What Plus's file ops call: no rescan of the documents, only another pass.
    reload: () =>
      Effect.gen(function* () {
        counts.reloads++
        rebuild()
        yield* Queue.offer(events, { type: Agent.Event.Updated.type })
      }),
  }

  return {
    domain,
    events,
    counts,
    // What a config reload does: rescan the documents, then let the agent
    // domain rebuild and announce (config/plugin/agent.ts load).
    configReload: () =>
      Effect.gen(function* () {
        counts.reads++
        const found = yield* Effect.promise(() => read(path.join(directory, ".opencode", "agent")))
        documents.clear()
        for (const [id, agent] of found) documents.set(id, agent)
        rebuild()
        yield* Queue.offer(events, { type: Agent.Event.Updated.type })
      }),
  }
}

async function fixture() {
  const root = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-agent-rescan-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  await fs.mkdir(path.join(project, ".opencode", "agent"), { recursive: true })
  const core = coreAgents(project)
  const ctx = context({
    ...fullContext({ directory: project }),
    agent: core.domain,
    config: { reload: () => core.configReload() },
    event: { subscribe: () => Stream.fromQueue(core.events) as never },
  })
  // Boot reads the agent documents once, as the host does.
  await Effect.runPromise(core.configReload())
  const api = createPlusApi(ctx, createState())
  await api.refresh()
  return { api, core, project }
}

test("a created agent is in the snapshot at once, though the host registry only rescans on a config reload", async () => {
  const { api, core } = await fixture()
  const created = await api.createAgent({ scope: "project", id: "fresh" })
  if (!created.ok) throw new Error(`createAgent failed: ${created.error.message}`)

  const snapshot = await api.snapshot()
  expect(snapshot.value.agents.map((agent) => agent.id)).toContain("fresh")
  // The rescan it waited for is the host's config reload, not a restart.
  expect(core.counts.reads).toBeGreaterThan(0)
})

test("a duplicate's copy is in the snapshot at once too", async () => {
  const { api, project } = await fixture()
  await Bun.write(path.join(project, ".opencode", "agent", "original.md"), formatMarkdown({ mode: "primary" }, "Original prompt.\n"))
  await api.refresh()
  const created = await api.createAgent({ scope: "project", id: "original-copy", from: "original" })
  if (!created.ok) throw new Error(`createAgent failed: ${created.error.message}`)

  const snapshot = await api.snapshot()
  expect(snapshot.value.agents.map((agent) => agent.id)).toContain("original-copy")
})

test("a renamed agent's new id is in the snapshot at once", async () => {
  const { api } = await fixture()
  const created = await api.createAgent({ scope: "project", id: "before" })
  if (!created.ok) throw new Error(`createAgent failed: ${created.error.message}`)

  const renamed = await api.renameAgent({ scope: "project", from: "before", to: "after" })
  if (!renamed.ok) throw new Error(`renameAgent failed: ${renamed.error.message}`)

  const snapshot = await api.snapshot()
  expect(snapshot.value.agents.map((agent) => agent.id)).toContain("after")
  expect(snapshot.value.agents.map((agent) => agent.id)).not.toContain("before")
})

