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
import { createActiveTeam, TeamMonitorTab } from "../src/tui/active-team.js"
import { createTestRenderer } from "@opentui/core/testing"
import { render } from "@opentui/solid"
import { RGBA } from "@opentui/core"
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

test("enabling a team from the server side activates it and selects its first installed member; a later normal-agent pick sticks", async () => {
  const teamListeners = new Set<() => void>()
  const [activeGroupSignal, setActiveGroupSignal] = createSignal<string | undefined>(undefined)
  const selected: string[] = []
  let rawStorage: Record<string, any> = { activeTeamByProject: {} }
  const [storageState, setStorageState] = createStore<Record<string, any>>(rawStorage)
  const fakeTeams = [
    { level: "project" as const, team: "alpha", enabled: false, members: [{ id: "coder", mode: "primary" as const }, { id: "tester", mode: "primary" as const }] },
    { level: "project" as const, team: "beta", enabled: false, members: [{ id: "designer", mode: "primary" as const }] },
  ]
  const context: any = {
    location: { directory: "/my/project" },
    data: {
      location: {
        default: () => ({ directory: "/my/project" }),
        // coder is not installed on the host yet: the first INSTALLED member wins.
        agent: { list: () => [{ id: "tester", mode: "primary" }, { id: "designer", mode: "primary" }, { id: "build", mode: "primary" }] },
      },
    },
    client: {
      rpc: () => ({
        "team.list": async () => ({ teams: fakeTeams.map((t) => ({ ...t, members: t.members.map((m) => ({ ...m })) })) }),
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
    theme: { text: { subdued: "gray" } },
    ui: {
      toast: { show: () => {} },
      slot: () => () => {},
      agents: {
        groups: () => () => {},
        activeGroup: { current: () => activeGroupSignal(), set: (id: string | undefined) => setActiveGroupSignal(id) },
        set: (id: string) => selected.push(id),
      },
    },
  }
  const manager = createActiveTeam(context)
  await new Promise((r) => setTimeout(r, 10))
  // Initial load with nothing enabled activates nothing.
  expect(activeGroupSignal()).toBeUndefined()
  expect(selected).toEqual([])

  // Enable alpha (as /instructions space would): alpha becomes the active ring.
  fakeTeams[0]!.enabled = true
  for (const listener of teamListeners) listener()
  await new Promise((r) => setTimeout(r, 10))
  expect(activeGroupSignal()).toBe("team:project:alpha")
  expect(selected).toEqual(["tester"])

  // The user picks a normal agent while alpha stays enabled: an unrelated
  // teams.changed (same enabled team) must not pull them back into alpha.
  setActiveGroupSignal(undefined)
  for (const listener of teamListeners) listener()
  await new Promise((r) => setTimeout(r, 10))
  expect(activeGroupSignal()).toBeUndefined()
  expect(selected).toEqual(["tester"])

  // Enabling beta (server flips alpha off) switches the ring to beta.
  fakeTeams[0]!.enabled = false
  fakeTeams[1]!.enabled = true
  for (const listener of teamListeners) listener()
  await new Promise((r) => setTimeout(r, 10))
  expect(activeGroupSignal()).toBe("team:project:beta")
  expect(selected).toEqual(["tester", "designer"])
  expect(manager.activeTeam()?.team).toBe("beta")
  manager.dispose()
})

test("createActiveTeam registers composer tab and hints, cleans up on dispose", async () => {
  let registeredTab: any = undefined
  let tabUnregistered = false

  const context: any = {
    location: { directory: "/my/project" },
    data: {
      location: {
        default: () => ({ directory: "/my/project" }),
        agent: { list: () => [] },
      },
    },
    client: {
      rpc: () => ({
        "team.list": async () => ({ teams: [] }),
        events: { on: () => () => {} },
      }),
    },
    storage: {
      store: () => [{ activeTeamByProject: {} }, async () => {}],
    },
    keymap: {
      shortcuts: (cmd: string) => (cmd === "composer.team.select" ? ["return"] : []),
      layer: () => {},
    },
    theme: { text: { subdued: "gray" } },
    ui: {
      toast: { show: () => {} },
      slot: () => () => {},
      agents: {
        groups: () => () => {},
        activeGroup: { current: () => undefined, set: () => {} },
      },
      composer: {
        tab: (tab: any) => {
          registeredTab = tab
          return () => {
            tabUnregistered = true
          }
        },
      },
    },
  }

  const manager = createActiveTeam(context)
  expect(registeredTab).toBeDefined()
  expect(registeredTab.id).toBe("team")
  expect(registeredTab.label).toBe("Team")
  const hints = registeredTab.hints()
  expect(hints).toEqual([{ label: "select", shortcut: "return" }])

  manager.dispose()
  expect(tabUnregistered).toBe(true)
})

test("TeamMonitorTab renders fallback when no team is active, and lists members with mode/model/status when active", async () => {
  const [activeTeamSignal, setActiveTeamSignal] = createSignal<any>(undefined)
  const [currentAgentSignal] = createSignal<string>("coder")
  let closeCalled = 0

  const white = RGBA.fromHex("#ffffff")
  const gray = RGBA.fromHex("#888888")
  const black = RGBA.fromHex("#000000")
  const testTheme = {
    text: {
      default: white,
      subdued: gray,
      action: {
        primary: { default: white, selected: white, focused: white },
      },
    },
    background: {
      default: black,
      action: {
        primary: { default: black, selected: black, focused: black },
      },
    },
  }

  const mockSessions = [
    { id: "ses_root", agent: "coder", projectID: "p" },
    { id: "ses_child_running", parentID: "ses_root", agent: "reviewer", projectID: "p" },
    { id: "ses_child_idle", parentID: "ses_root", agent: "coder", projectID: "p" },
  ]

  const mockAgents = [
    { id: "coder", mode: "primary", model: { id: "gpt-5", providerID: "openai" } },
    { id: "reviewer", mode: "subagent", model: { id: "claude-3-5-sonnet", providerID: "anthropic" } },
    { id: "scout", mode: "primary" },
  ]

  const context: any = {
    location: { directory: "/my/project" },
    theme: testTheme,
    data: {
      location: {
        agent: {
          list: () => mockAgents,
        },
      },
      session: {
        list: () => mockSessions,
        get: (id: string) => mockSessions.find((s) => s.id === id),
        root: () => "ses_root",
        status: (id: string) => (id === "ses_child_running" ? "running" : "idle"),
      },
    },
    keymap: {
      layer: () => {},
    },
    ui: {
      agents: {
        current: () => currentAgentSignal(),
        set: () => {},
      },
      router: {
        navigate: () => {},
      },
    },
  }

  const output = await createTestRenderer({ width: 100, height: 20 })
  render(
    () => (
      <TeamMonitorTab
        sessionID="ses_root"
        active={() => true}
        close={() => closeCalled++}
        activeTeam={activeTeamSignal}
        context={context}
      />
    ),
    output.renderer,
  )

  await output.renderOnce()
  expect(output.captureCharFrame()).toContain("No active team — select one with ctrl+x a")

  setActiveTeamSignal({
    team: "dev-team",
    name: "dev-team",
    level: "project",
    members: ["coder", "reviewer", "scout"],
  })

  await output.renderOnce()
  const frame = output.captureCharFrame()
  expect(frame).toContain("coder — primary — gpt-5")
  expect(frame).toContain("idle")
  expect(frame).toContain("reviewer — subagent — claude-3-5-sonnet")
  expect(frame).toContain("running")
  expect(frame).toContain("scout — primary — default")
  expect(frame).toContain("none")

  output.renderer.destroy()
})

test("TeamMonitorTab keymap commands: navigate on member with session, select agent on member without session, up closes when at 0", async () => {
  let commands: any[] = []
  let closeCalled = 0
  let navigated: any = undefined
  let selectedAgent: any = undefined

  const mockSessions = [
    { id: "ses_root", agent: "coder", projectID: "p" },
    { id: "ses_sub", parentID: "ses_root", agent: "coder", projectID: "p" },
  ]

  const mockAgents = [
    { id: "coder", mode: "primary", model: { id: "gpt-5", providerID: "openai" } },
    { id: "scout", mode: "primary" },
  ]

  const white = RGBA.fromHex("#ffffff")
  const black = RGBA.fromHex("#000000")
  const testTheme = {
    text: {
      default: white,
      subdued: white,
      action: { primary: { default: white, selected: white, focused: white } },
    },
    background: {
      default: black,
      action: { primary: { default: black, selected: black, focused: black } },
    },
  }

  const context: any = {
    location: { directory: "/my/project" },
    theme: testTheme,
    data: {
      location: {
        agent: { list: () => mockAgents },
      },
      session: {
        list: () => mockSessions,
        get: (id: string) => mockSessions.find((s) => s.id === id),
        root: () => "ses_root",
        status: () => "idle",
      },
    },
    keymap: {
      layer: (factory: any) => {
        const layer = factory()
        if (layer.commands) commands = layer.commands
      },
    },
    ui: {
      agents: {
        current: () => "coder",
        set: (id: string) => {
          selectedAgent = id
        },
      },
      router: {
        navigate: (dest: any) => {
          navigated = dest
        },
      },
    },
  }

  const activeTeam = () => ({
    team: "dev-team",
    name: "dev-team",
    level: "project" as const,
    members: ["coder", "scout"],
  })

  const output = await createTestRenderer({ width: 100, height: 20 })
  render(
    () => (
      <TeamMonitorTab
        sessionID="ses_root"
        active={() => true}
        close={() => closeCalled++}
        activeTeam={activeTeam}
        context={context}
      />
    ),
    output.renderer,
  )

  await output.renderOnce()
  expect(commands.length).toBe(3)
  const upCmd = commands.find((c) => c.id === "composer.team.up")
  const downCmd = commands.find((c) => c.id === "composer.team.down")
  const selectCmd = commands.find((c) => c.id === "composer.team.select")

  // Currently at index 0 (coder). Coder has a session ("ses_sub").
  selectCmd.run()
  expect(navigated).toEqual({ type: "session", sessionID: "ses_sub" })
  expect(closeCalled).toBe(1)

  // Move down to index 1 (scout). Scout has NO session.
  downCmd.run()
  await output.renderOnce()
  selectCmd.run()
  expect(selectedAgent).toEqual("scout")
  expect(closeCalled).toBe(2)

  // Move up to index 0 (coder).
  upCmd.run()
  await output.renderOnce()
  // At index 0, pressing up closes composer:
  upCmd.run()
  expect(closeCalled).toBe(3)

  output.renderer.destroy()
})
