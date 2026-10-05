// T1, T5 and T2 of plus-1.1.12: the Global agent config dir (with delete
// cascading its stored records), Global/Project team members never leaking into
// Defaults, and a change through one Plus instance reaching the others.
//
// This file is separate from the per-area suites because the checks run those
// files as their command, so they are not committable by the worker that adds
// coverage. It exercises the same real boundaries: agents/files.ts, the RPC
// handlers, the snapshot/tree and the process-wide shared-store notification.
import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Effect, Exit, Queue, Scope, Stream } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { agentPath, create, formatMarkdown, remove, resolveDirectory } from "../src/agents/files.js"
import { createHandlers, createState, watchSharedStore } from "../src/index.js"
import { globalTeamsPath } from "../src/instructions/paths.js"
import { memoInputOf } from "../src/instructions/snapshot.js"
import { load, save } from "../src/instructions/store.js"
import { expandedTree } from "../src/instructions/tree.js"
import { resetSharedStoreListeners } from "../src/shared-store-bus.js"
import { agentHarness, agentInfo, context, fullContext } from "./harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR
const priorXdg = process.env.XDG_CONFIG_HOME
const priorProduct = process.env.OPENCODE_PRODUCT

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  if (priorXdg === undefined) delete process.env.XDG_CONFIG_HOME
  else process.env.XDG_CONFIG_HOME = priorXdg
  if (priorProduct === undefined) delete process.env.OPENCODE_PRODUCT
  else process.env.OPENCODE_PRODUCT = priorProduct
  resetSharedStoreListeners()
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<string> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-t1-t5-t2-"))
  roots.push(root)
  return root
}

const UPDATED = "2026-01-01T00:00:00.000Z"

const throwing = {
  error: (type: string, message: string, data?: unknown): never => {
    throw { type, message, data }
  },
}

async function until(check: () => boolean, ms = 4000): Promise<boolean> {
  const start = Date.now()
  while (!check() && Date.now() - start < ms) await Bun.sleep(25)
  return check()
}

// T1: a global agent's directory is the product's real global config dir, not
// the upstream `opencode` path. OPENCODE_CONFIG_DIR still wins when set;
// without it the Product namespace decides.
test("T1: global scope resolves the product namespace instead of a hardcoded opencode dir", async () => {
  const xdg = await tempRoot()
  delete process.env.OPENCODE_CONFIG_DIR
  process.env.XDG_CONFIG_HOME = xdg
  process.env.OPENCODE_PRODUCT = "opencodeplus"

  const dir = await resolveDirectory("global", "")
  expect(dir).toBe(path.join(xdg, "opencodeplus", "agent"))

  const created = await create({ scope: "global", projectDirectory: "", id: "ns-agent", prompt: "Namespace prompt" })
  expect(created.ok).toBe(true)
  if (!created.ok) return
  expect(created.path).toBe(path.join(xdg, "opencodeplus", "agent", "ns-agent.md"))
  expect(await agentPath("global", "", "ns-agent")).toBe(created.path)

  const removed = await remove({ scope: "global", projectDirectory: "", id: "ns-agent" })
  expect(removed.ok).toBe(true)
  expect(await Bun.file(created.path).exists()).toBe(false)
})

// T1: deleting a Global agent removes its stored records (customizations,
// splits, models, rules and link) in the same store revision, so recreating the
// id starts clean.
test("T1: deleting a global agent cascades its stored records in one store revision", async () => {
  const project = await tempRoot()
  const config = await tempRoot()
  process.env.OPENCODE_CONFIG_DIR = config

  const created = await create({ scope: "global", projectDirectory: "", id: "deepseek-worker", prompt: "role" })
  expect(created.ok).toBe(true)
  const loaded = await load(project)
  const saved = await save(project, {
    expectedProjectRevision: loaded.projectRevision,
    expectedGlobalRevision: loaded.globalRevision,
    records: [
      ...loaded.records,
      { type: "customization", level: "global", agent: "deepseek-worker", item: "system:role", section: null, text: "custom", basedOn: "", updated: UPDATED },
      { type: "split", level: "global", agent: "deepseek-worker", item: "tool:bash", boundaries: [{ id: "a", name: "A", start: 0 }], updated: UPDATED },
      { type: "model", level: "global", agent: "deepseek-worker", providerID: "acme", modelID: "nova-1", active: true, updated: UPDATED },
      { type: "rule", level: "global", agent: "deepseek-worker", tool: "shell", id: "guard", label: "Guard", patterns: ["rm *"], keywords: [], updated: UPDATED },
      { type: "link", level: "global", agent: "deepseek-worker", preset: { kind: "agent", id: "build" }, updated: UPDATED },
      { type: "customization", level: "global", agent: "deepseek-worker", team: { level: "global", team: "Basic" }, item: "system:role", section: null, text: "member custom", basedOn: "", updated: UPDATED },
      { type: "split", level: "global", agent: "deepseek-worker", team: { level: "global", team: "Basic" }, item: "tool:bash", boundaries: [{ id: "member", name: "Member", start: 0 }], updated: UPDATED },
    ],
  })
  expect(saved.ok).toBe(true)
  if (!saved.ok) return

  const memberRecords = (await load(project)).records.filter((record) => "agent" in record && record.agent === "deepseek-worker" && "team" in record && record.team)
  expect(memberRecords).toHaveLength(2)
  const handlers = createHandlers(fullContext({ directory: project }), createState())
  const removed = await Effect.runPromise(handlers["agent.delete"]({ scope: "global", id: "deepseek-worker" }, throwing))
  expect(removed.path).toBe(created.path)

  const after = await load(project)
  expect(after.records.filter((record) => "agent" in record && record.agent === "deepseek-worker" && record.level === "global" && !("team" in record && record.team))).toEqual([])
  // A same-id team member is a different owner and must retain its edits/splits.
  expect(after.records.filter((record) => "agent" in record && record.agent === "deepseek-worker" && "team" in record && record.team)).toEqual(
    memberRecords,
  )
  // One revision: the file delete and the whole cascade share one save.
  expect(after.globalRevision).toBe(saved.globalRevision + 1)

  const again = await create({ scope: "global", projectDirectory: "", id: "deepseek-worker", prompt: "fresh" })
  expect(again.ok).toBe(true)
  const recreated = await load(project)
  expect(recreated.records.filter((record) => "agent" in record && record.agent === "deepseek-worker" && record.level === "global" && !("team" in record && record.team))).toEqual([])
})

// T5: a Global team whose members link to shipped `basic` member presets must
// write only its team files and team-scoped links. The host echoes each
// installed member as an unbacked defaults agent; the tree must not list that
// echo under Defaults › Agents, and no Defaults entry may appear.
test("T5: a Global Basic team with preset-linked members writes no Defaults entry and lists no Defaults agent", async () => {
  const root = await tempRoot()
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const members = ["planner", "orchestrator"]
  const teamDir = path.join(globalTeamsPath(), "Basic")
  await fs.mkdir(teamDir, { recursive: true })
  for (const member of members) {
    await Bun.write(path.join(teamDir, `${member}.md`), formatMarkdown({ mode: "primary", description: `Basic/${member}` }, ""))
  }
  const loaded = await load(project)
  const saved = await save(project, {
    expectedProjectRevision: loaded.projectRevision,
    expectedGlobalRevision: loaded.globalRevision,
    records: [
      ...loaded.records,
      { type: "team", level: "global", team: "Basic", enabled: true, updated: UPDATED },
      ...members.map((member) => ({
        type: "link" as const,
        level: "global" as const,
        agent: member,
        team: { level: "global" as const, team: "Basic" },
        preset: { kind: "member" as const, team: "basic", id: member },
        updated: UPDATED,
      })),
    ],
  })
  expect(saved.ok).toBe(true)

  const handlers = createHandlers(fullContext({ directory: project }), createState(), { builtins: [] })
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))
  expect(snapshot.entries ?? []).toEqual([])
  const nodes = expandedTree(memoInputOf(snapshot))
  for (const member of members) {
    expect(nodes.some((node) => node.id === `team:global:Basic:${member}`)).toBe(true)
    expect(nodes.some((node) => node.id === `agent:defaults:${member}`)).toBe(false)
  }
  expect(nodes.some((node) => node.id === "team:defaults:Basic" || node.id === "team:defaults:basic")).toBe(false)
})

function emittingAgentDomain(
  harness: ReturnType<typeof agentHarness>,
  events: Queue.Queue<string>,
): ReturnType<typeof agentHarness>["domain"] {
  return {
    ...harness.domain,
    reload: () =>
      Effect.gen(function* () {
        yield* harness.domain.reload()
        yield* Queue.offer(events, Agent.Event.Updated.type)
      }),
  }
}

// T2: every Location has its own Plus instance in the one elected server, but
// the host Bus is Location-filtered. A Global change through one instance must
// reach the other, which re-reads the shared store, reapplies it and reloads
// its host registry (core's agent.updated).
test("T2: a Global change through one Plus instance reapplies in another and reloads its host agents", async () => {
  const root = await tempRoot()
  const config = path.join(root, "config")
  process.env.OPENCODE_CONFIG_DIR = config
  const project = path.join(root, "a")
  const projectB = path.join(root, "b")
  await fs.mkdir(path.join(config, "agent"), { recursive: true })
  await Bun.write(path.join(config, "agent", "worker.md"), "---\nmode: primary\n---\nworker role\n")

  const harnessA = agentHarness([agentInfo("worker", "worker role")], project)
  const harnessB = agentHarness([agentInfo("worker", "worker role")], projectB)
  const eventsA = Effect.runSync(Queue.unbounded<string>())
  const eventsB = Effect.runSync(Queue.unbounded<string>())
  const ctxA = context({
    ...fullContext({ directory: project }),
    agent: emittingAgentDomain(harnessA, eventsA),
    event: { subscribe: () => Stream.fromQueue(eventsA) as never },
  })
  const ctxB = context({
    ...fullContext({ directory: projectB }),
    agent: emittingAgentDomain(harnessB, eventsB),
    event: { subscribe: () => Stream.fromQueue(eventsB) as never },
  })
  const stateA = createState()
  const stateB = createState()
  const scopeA = await Effect.runPromise(Scope.make())
  const scopeB = await Effect.runPromise(Scope.make())
  try {
    await Effect.runPromise(watchSharedStore(ctxA, stateA).pipe(Scope.provide(scopeA)))
    await Effect.runPromise(watchSharedStore(ctxB, stateB).pipe(Scope.provide(scopeB)))
    const handlersA = createHandlers(ctxA, stateA)
    const handlersB = createHandlers(ctxB, stateB)
    await Effect.runPromise(handlersA["instructions.refresh"](undefined, throwing))
    await Effect.runPromise(handlersB["instructions.refresh"](undefined, throwing))
    expect(harnessA.state.has("worker")).toBe(true)
    expect(harnessB.state.has("worker")).toBe(true)
    const reloadsB = harnessB.reloads

    const snapA = await Effect.runPromise(handlersA["instructions.snapshot"](undefined, throwing))
    const mutated = await Effect.runPromise(
      handlersA["instructions.mutate"](
        {
          expectedRevision: snapA.revision,
          expectedGlobalRevision: snapA.globalRevision,
          records: [
            ...snapA.records,
            { type: "customization", level: "global", agent: "worker", item: "setting:enabled", section: null, state: "off", basedOn: "", updated: UPDATED },
          ],
        },
        throwing,
      ),
    )
    expect(mutated.ok).toBe(true)
    // The changing instance applies it at once.
    expect(harnessA.state.has("worker")).toBe(false)

    // The other Location follows the shared revision, reapplies, and reloads
    // its own host (core then publishes agent.updated there).
    expect(await until(() => !harnessB.state.has("worker"))).toBe(true)
    expect(harnessB.reloads).toBeGreaterThan(reloadsB)
    expect(await until(() => Effect.runSync(Queue.size(eventsB)) > 0)).toBe(true)
  } finally {
    await Effect.runPromise(Scope.close(scopeA, Exit.void))
    await Effect.runPromise(Scope.close(scopeB, Exit.void))
  }
})

// T2: a team created and filled registers its members without toggling it again.
test("T2: a team created and filled registers its members without toggling it again", async () => {
  const root = await tempRoot()
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  const agents = agentHarness([], project)
  const ctx = context({ ...fullContext({ directory: project }), agent: agents.domain })
  const handlers = createHandlers(ctx, createState(), { builtins: [] })
  await Effect.runPromise(handlers["team.create"]({ level: "project", team: "crew" }, throwing))
  await Effect.runPromise(handlers["team.setEnabled"]({ level: "project", team: "crew", enabled: true }, throwing))
  await Effect.runPromise(handlers["team.addAgent"]({ level: "project", team: "crew", id: "newbie" }, throwing))

  expect(agents.state.has("newbie")).toBe(true)
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwing))
  expect((snapshot.teams ?? []).find((team) => team.team === "crew")?.agents).toContain("newbie")
})
