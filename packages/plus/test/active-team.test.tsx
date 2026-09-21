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
  expect(hints).toEqual([
    { label: "move", shortcut: "↑↓" },
    { label: "attach", shortcut: "⏎" },
    { label: "active", shortcut: "ctrl+a" },
    { label: "stop|resume", shortcut: "ctrl+d" },
  ])

  manager.dispose()
  expect(tabUnregistered).toBe(true)
})

test("TeamMonitorTab renders active runs by default, toggles to inactive with ctrl+a, and navigates with select", async () => {
  let commands: any[] = []
  let closeCalled = 0
  let navigated: any = undefined
  const toasts: any[] = []
  const stopCalled: string[] = []

  const fakeRuns = [
    {
      id: "w-run-active",
      role: "gemini-implementer",
      state: "working",
      task: "T4",
      head: "abcdef",
      worktree: "present",
      lastUsed: "2026-09-10T12:00:00.000Z",
      sessionID: "ses_active",
      parent: "main-01",
    },
    {
      id: "w-run-idle",
      role: "muse-implementer",
      state: "idle",
      task: "T5",
      head: "abcdef",
      worktree: "present",
      lastUsed: "2026-09-10T11:00:00.000Z",
      sessionID: "ses_idle",
      parent: "main-01",
    },
    {
      id: "w-run-stopped",
      role: "deepseek-implementer",
      state: "stopped",
      task: "T3",
      head: "abcdef",
      worktree: "present",
      lastUsed: "2026-09-10T10:00:00.000Z",
      sessionID: "ses_stopped",
      parent: "main-01",
    },
    {
      id: "w-run-dead",
      role: "coder-implementer",
      state: "dead",
      task: null,
      head: "abcdef",
      worktree: "present",
      lastUsed: "2026-09-10T09:00:00.000Z",
      sessionID: "ses_dead",
      parent: "main-01",
    },
  ]

  const white = RGBA.fromHex("#ffffff")
  const gray = RGBA.fromHex("#888888")
  const black = RGBA.fromHex("#000000")
  const testTheme = {
    text: {
      default: white,
      subdued: gray,
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
      location: { default: () => ({ directory: "/my/project" }) },
      listen: () => () => {},
    },
    client: {
      rpc: () => ({
        "team.runs.list": async (args: { all?: boolean }) => ({
          runs: fakeRuns.filter((r) => {
            if (!args.all && (r.state === "superseded" || r.state === "reaped")) return false
            return true
          }),
        }),
        "team.runs.stop": async (args: { run: string }) => {
          stopCalled.push(args.run)
          return { run: args.run, state: "stopped" }
        },
        events: { on: () => () => {} },
      }),
    },
    keymap: {
      layer: (factory: any) => {
        const layer = factory()
        if (layer.commands) commands = layer.commands
      },
    },
    ui: {
      toast: { show: (t: any) => toasts.push(t) },
      router: {
        navigate: (dest: any) => {
          navigated = dest
        },
      },
    },
  }

  const [showInactiveSignal, setShowInactiveSignal] = createSignal(false)

  const output = await createTestRenderer({ width: 100, height: 20 })
  render(
    () => (
      <TeamMonitorTab
        sessionID="ses_root"
        active={() => true}
        close={() => closeCalled++}
        context={context}
        showInactive={showInactiveSignal}
        setShowInactive={setShowInactiveSignal}
      />
    ),
    output.renderer,
  )

  await output.renderOnce()

  // 1. Default view: active runs (w-run-active, w-run-idle)
  const defaultFrame = output.captureCharFrame()
  expect(defaultFrame).toContain("w-run-active — gemini-implementer — working — T4")
  expect(defaultFrame).toContain("w-run-idle — muse-implementer — idle — T5")
  expect(defaultFrame).not.toContain("w-run-stopped")
  expect(defaultFrame).not.toContain("w-run-dead")

  expect(commands.length).toBe(5)
  const upCmd = commands.find((c) => c.id === "composer.team.up")
  const downCmd = commands.find((c) => c.id === "composer.team.down")
  const selectCmd = commands.find((c) => c.id === "composer.team.select")
  const toggleCmd = commands.find((c) => c.id === "composer.team.toggle_activity")
  const actionCmd = commands.find((c) => c.id === "composer.team.action")

  // Enter on index 0 (w-run-active) navigates to its sessionID
  selectCmd.run()
  expect(navigated).toEqual({ type: "session", sessionID: "ses_active" })
  expect(closeCalled).toBe(1)

  // 2. Toggle to inactive runs with ctrl+a
  toggleCmd.run()
  await new Promise((r) => setTimeout(r, 10))
  await output.renderOnce()

  const inactiveFrame = output.captureCharFrame()
  expect(inactiveFrame).toContain("w-run-stopped — deepseek-implementer — stopped — T3")
  expect(inactiveFrame).toContain("w-run-dead — coder-implementer — dead")
  expect(inactiveFrame).not.toContain("w-run-active")
  expect(inactiveFrame).not.toContain("w-run-idle")

  // Enter on inactive row (w-run-stopped) attaches to its session
  selectCmd.run()
  expect(navigated).toEqual({ type: "session", sessionID: "ses_stopped" })
  expect(closeCalled).toBe(2)

  // 3. Toggle back to active
  toggleCmd.run()
  await new Promise((r) => setTimeout(r, 10))
  await output.renderOnce()
  expect(output.captureCharFrame()).toContain("w-run-active")

  output.renderer.destroy()
})

test("TeamMonitorTab ctrl+d actions: idle stops, stopped/dead resumes, working shows warning toast", async () => {
  let commands: any[] = []
  let closeCalled = 0
  let navigated: any = undefined
  const toasts: any[] = []
  const stopCalled: string[] = []

  const fakeRuns = [
    {
      id: "w-run-working",
      role: "gemini-implementer",
      state: "working",
      task: "T1",
      head: "abcdef",
      worktree: "present",
      lastUsed: "2026-09-10T12:00:00.000Z",
      sessionID: "ses_working",
      parent: "main-01",
    },
    {
      id: "w-run-idle",
      role: "muse-implementer",
      state: "idle",
      task: "T2",
      head: "abcdef",
      worktree: "present",
      lastUsed: "2026-09-10T11:00:00.000Z",
      sessionID: "ses_idle",
      parent: "main-01",
    },
    {
      id: "w-run-stopped",
      role: "deepseek-implementer",
      state: "stopped",
      task: "T3",
      head: "abcdef",
      worktree: "present",
      lastUsed: "2026-09-10T10:00:00.000Z",
      sessionID: "ses_stopped",
      parent: "main-01",
    },
  ]

  const white = RGBA.fromHex("#ffffff")
  const black = RGBA.fromHex("#000000")
  const testTheme = {
    text: { default: white, subdued: white, action: { primary: { default: white, selected: white, focused: white } } },
    background: { default: black, action: { primary: { default: black, selected: black, focused: black } } },
  }

  const context: any = {
    location: { directory: "/my/project" },
    theme: testTheme,
    data: {
      location: { default: () => ({ directory: "/my/project" }) },
      listen: () => () => {},
    },
    client: {
      rpc: () => ({
        "team.runs.list": async () => ({ runs: fakeRuns }),
        "team.runs.stop": async (args: { run: string }) => {
          stopCalled.push(args.run)
          return { run: args.run, state: "stopped" }
        },
        events: { on: () => () => {} },
      }),
    },
    keymap: {
      layer: (factory: any) => {
        const layer = factory()
        if (layer.commands) commands = layer.commands
      },
    },
    ui: {
      toast: { show: (t: any) => toasts.push(t) },
      router: {
        navigate: (dest: any) => {
          navigated = dest
        },
      },
    },
  }

  const [showInactiveSignal, setShowInactiveSignal] = createSignal(false)

  const output = await createTestRenderer({ width: 100, height: 20 })
  render(
    () => (
      <TeamMonitorTab
        sessionID="ses_root"
        active={() => true}
        close={() => closeCalled++}
        context={context}
        showInactive={showInactiveSignal}
        setShowInactive={setShowInactiveSignal}
      />
    ),
    output.renderer,
  )

  await output.renderOnce()
  const upCmd = commands.find((c) => c.id === "composer.team.up")
  const downCmd = commands.find((c) => c.id === "composer.team.down")
  const actionCmd = commands.find((c) => c.id === "composer.team.action")
  const toggleCmd = commands.find((c) => c.id === "composer.team.toggle_activity")

  // At index 0 (w-run-working): ctrl+d shows "Run must be interrupted first" toast
  actionCmd.run()
  expect(toasts.some((t) => t.message === "Run must be interrupted first")).toBe(true)
  expect(stopCalled).toHaveLength(0)

  // Move down to index 1 (w-run-idle): ctrl+d calls stop
  downCmd.run()
  await output.renderOnce()
  actionCmd.run()
  expect(stopCalled).toEqual(["w-run-idle"])

  // Up when at index 0 closes the composer
  upCmd.run()
  await output.renderOnce()
  upCmd.run()
  expect(closeCalled).toBe(1)

  // Toggle to inactive (w-run-stopped): ctrl+d attaches/resumes
  toggleCmd.run()
  await new Promise((r) => setTimeout(r, 10))
  await output.renderOnce()

  actionCmd.run()
  expect(navigated).toEqual({ type: "session", sessionID: "ses_stopped" })
  expect(closeCalled).toBe(2)

  output.renderer.destroy()
})

test("TeamMonitorTab ctrl+d surfaces warning toast when stop RPC is rejected", async () => {
  let commands: any[] = []
  const toasts: any[] = []

  const fakeRuns = [
    {
      id: "w-run-idle",
      role: "gemini-implementer",
      state: "idle",
      task: "T2",
      head: "abcdef",
      worktree: "present",
      lastUsed: "2026-09-10T11:00:00.000Z",
      sessionID: "ses_idle",
      parent: "main-01",
    },
  ]

  const white = RGBA.fromHex("#ffffff")
  const black = RGBA.fromHex("#000000")
  const testTheme = {
    text: { default: white, subdued: white, action: { primary: { default: white, selected: white, focused: white } } },
    background: { default: black, action: { primary: { default: black, selected: black, focused: black } } },
  }

  const context: any = {
    location: { directory: "/my/project" },
    theme: testTheme,
    data: {
      location: { default: () => ({ directory: "/my/project" }) },
      listen: () => () => {},
    },
    client: {
      rpc: () => ({
        "team.runs.list": async () => ({ runs: fakeRuns }),
        "team.runs.stop": async () => {
          throw new Error("Run is working; interrupt it first.")
        },
        events: { on: () => () => {} },
      }),
    },
    keymap: {
      layer: (factory: any) => {
        const layer = factory()
        if (layer.commands) commands = layer.commands
      },
    },
    ui: {
      toast: { show: (t: any) => toasts.push(t) },
      router: { navigate: () => {} },
    },
  }

  const output = await createTestRenderer({ width: 100, height: 20 })
  render(
    () => (
      <TeamMonitorTab
        sessionID="ses_root"
        active={() => true}
        close={() => {}}
        context={context}
      />
    ),
    output.renderer,
  )

  await output.renderOnce()
  const actionCmd = commands.find((c) => c.id === "composer.team.action")
  await actionCmd.run()
  expect(toasts.some((t) => t.message === "Run is working; interrupt it first.")).toBe(true)

  output.renderer.destroy()
})
