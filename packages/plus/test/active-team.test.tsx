import { afterEach, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { formatMarkdown } from "../src/agents/files.js"
import { createHandlers, createState } from "../src/index.js"
import { projectTeamsPath } from "../src/instructions/paths.js"
import { enable } from "../src/project.js"
import { createActiveTeam } from "../src/tui/active-team.js"
import { fullContext } from "./harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<{ project: string }> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-active-team-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  return { project: path.join(root, "project") }
}

function throwingContext(): {
  error: (type: string, message: string, data?: unknown) => never
} {
  return {
    error: (type, message, data) => {
      throw { type, message, data }
    },
  }
}

test("team.list contents before and after enable, teams.changed fires", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const teamDir = path.join(projectTeamsPath(project), "my-team")
  await fs.mkdir(teamDir, { recursive: true })
  await Bun.write(path.join(teamDir, "coder.md"), formatMarkdown({ mode: "primary" }, "You write code."))
  await Bun.write(path.join(teamDir, "reviewer.md"), formatMarkdown({ mode: "subagent" }, "You review code."))

  const state = createState()
  const emitted: string[] = []
  state.registration = {
    dispose: Effect.void,
    events: {
      emit: (name: string) =>
        Effect.sync(() => {
          emitted.push(name)
        }).pipe(Effect.asVoid),
    },
  } as any

  const ctx = fullContext({ directory: project })
  const handlers = createHandlers(ctx, state, { builtins: [] })

  // 1. Before enable
  const listBefore = await Effect.runPromise(handlers["team.list"](undefined, throwingContext()))
  const teamBefore = listBefore.teams.find((t) => t.team === "my-team")
  expect(teamBefore).toBeDefined()
  expect(teamBefore?.enabled).toBe(false)
  expect(teamBefore?.members).toEqual([
    { id: "coder", mode: "primary" },
    { id: "reviewer", mode: "subagent" },
  ])

  // 2. Enable team -> teams.changed fires
  await Effect.runPromise(
    handlers["team.setEnabled"]({ level: "project", team: "my-team", enabled: true }, throwingContext()),
  )
  expect(emitted).toContain("teams.changed")

  // 3. After enable
  const listAfter = await Effect.runPromise(handlers["team.list"](undefined, throwingContext()))
  const teamAfter = listAfter.teams.find((t) => t.team === "my-team")
  expect(teamAfter?.enabled).toBe(true)
  expect(teamAfter?.members).toEqual([
    { id: "coder", mode: "primary" },
    { id: "reviewer", mode: "subagent" },
  ])
})

test("createActiveTeam registers provider with enabled teams, tracks active team, persists, and handles disable toast", async () => {
  const toasts: { variant?: string; message: string }[] = []
  const teamListeners = new Set<() => void>()
  const [activeGroupSignal, setActiveGroupSignal] = createSignal<string | undefined>(undefined)
  let registeredProvider: (() => readonly any[] | undefined) | undefined = undefined

  let rawStorage: Record<string, any> = { activeTeamByProject: {} }
  const [storageState, setStorageState] = createStore<Record<string, any>>(rawStorage)

  const fakeTeams = [
    {
      level: "project" as const,
      team: "alpha",
      enabled: true,
      members: [{ id: "coder", mode: "primary" as const }],
    },
    {
      level: "project" as const,
      team: "beta",
      enabled: false,
      members: [{ id: "designer", mode: "primary" as const }],
    },
  ]

  const context: any = {
    location: { directory: "/my/project" },
    data: {
      location: {
        default: () => ({ directory: "/my/project" }),
        agent: {
          list: () => [{ id: "coder", mode: "primary" }],
        },
      },
    },
    client: {
      rpc: () => ({
        "team.list": async () => ({
          teams: fakeTeams.map((t) => ({ ...t, members: t.members.map((m) => ({ ...m })) })),
        }),
        events: {
          on: (event: string, handler: () => void) => {
            if (event === "teams.changed") teamListeners.add(handler)
            return () => teamListeners.delete(handler)
          },
        },
      }),
    },
    storage: {
      store: () => [
        storageState,
        (mutation: (draft: any) => void) => {
          const draft = structuredClone(rawStorage)
          mutation(draft)
          rawStorage = draft
          setStorageState(draft)
          return Promise.resolve()
        },
      ],
    },
    theme: {
      text: { subdued: "gray" },
    },
    ui: {
      toast: {
        show: (toast: any) => toasts.push(toast),
      },
      slot: () => () => {},
      agents: {
        groups: (provider: () => readonly any[] | undefined) => {
          registeredProvider = provider
          return () => {
            registeredProvider = undefined
          }
        },
        activeGroup: {
          current: () => activeGroupSignal(),
          set: (id: string | undefined) => {
            setActiveGroupSignal(id)
          },
        },
      },
    },
  }

  const manager = createActiveTeam(context)

  await new Promise((r) => setTimeout(r, 10))

  expect(registeredProvider).toBeDefined()
  const groups = registeredProvider!()
  expect(groups).toBeDefined()
  if (!groups) throw new Error("expected groups")
  expect(groups).toHaveLength(1)
  expect(groups[0]).toEqual({
    id: "team:project:alpha",
    label: "Team: alpha (project)",
    agents: ["coder"],
  })

  context.ui.agents.activeGroup.set("team:project:alpha")
  await new Promise((r) => setTimeout(r, 10))
  expect(manager.activeTeam()).toMatchObject({
    team: "alpha",
    name: "alpha",
    level: "project",
    members: ["coder"],
  })

  expect(storageState.activeTeamByProject["/my/project"]).toBe("team:project:alpha")

  fakeTeams[0]!.enabled = false
  for (const listener of teamListeners) listener()
  await new Promise((r) => setTimeout(r, 10))

  expect(context.ui.agents.activeGroup.current()).toBeUndefined()
  expect(manager.activeTeam()).toBeUndefined()
  expect(toasts.some((t) => t.message === "Team alpha disabled; back to Agents")).toBe(true)

  manager.dispose()
})
