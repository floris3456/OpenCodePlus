import { expect, test } from "bun:test"
import type { Plugin } from "@opencode/plugin/tui"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createSignal } from "solid-js"
import { enable, read } from "../src/project.js"
import type { Status } from "../src/rpc.js"
import { createProjectMode } from "../src/tui/project-mode.js"

interface StatusCall {
  readonly directory: string | undefined
}

interface ProjectModeHarness {
  readonly context: Plugin.Context
  readonly calls: StatusCall[]
  readonly toasts: { variant?: string; message: string }[]
  readonly setLocation: (location: { directory: string; workspaceID?: string } | undefined) => void
  readonly emitChanged: (status: Status) => void
}

function createHarness(options: {
  readonly defaultDirectory: string
  readonly enabledDirectories: readonly string[]
  readonly failStatus?: boolean
}): ProjectModeHarness {
  const calls: StatusCall[] = []
  const toasts: { variant?: string; message: string }[] = []
  const listeners = new Set<(event: { data: Status }) => void>()
  const [location, setLocation] = createSignal<{ directory: string; workspaceID?: string } | undefined>(undefined)

  function statusFor(directory: string | undefined): Status {
    if (options.failStatus === true) throw new Error("status unavailable")
    if (directory !== undefined && options.enabledDirectories.includes(directory))
      return { enabled: true, directory }
    return { enabled: false, directory: directory ?? "" }
  }

  const raw: {} = {
    get location() {
      return location()
    },
    data: {
      location: {
        default: () => ({ directory: options.defaultDirectory }),
      },
    },
    client: {
      rpc: () => ({
        "project.status": async (
          _input: unknown,
          rpcOptions?: { location?: { directory?: string; workspace?: string } },
        ) => {
          const directory = rpcOptions?.location?.directory
          calls.push({ directory })
          return statusFor(directory)
        },
        "project.enable": async () => ({ enabled: true, directory: options.defaultDirectory }),
        "project.disable": async () => ({ enabled: false, directory: options.defaultDirectory }),
        events: {
          on: (_name: string, handler: (event: { data: Status }) => void) => {
            listeners.add(handler)
            return () => {
              listeners.delete(handler)
            }
          },
        },
      }),
    },
    ui: {
      dialog: {
        confirm: async (): Promise<boolean | undefined> => {
          throw new Error("toggle must not run during status resolution")
        },
      },
      toast: {
        show: (toast: { variant?: string; message: string }) => {
          toasts.push(toast)
        },
      },
    },
  }

  return {
    context: raw as Plugin.Context,
    calls,
    toasts,
    setLocation,
    emitChanged: (status: Status) => {
      for (const listener of listeners) listener({ data: status })
    },
  }
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 2000
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition")
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test("project status resolves as enabled on launch without a toggle", async () => {
  const harness = createHarness({ defaultDirectory: "/sample", enabledDirectories: ["/sample"] })
  const mode = createProjectMode(harness.context)
  try {
    await waitFor(() => harness.calls.length > 0)
    await waitFor(() => mode.status().enabled)
    expect(harness.calls.length).toBeGreaterThanOrEqual(1)
    for (const call of harness.calls) expect(call.directory).toBe("/sample")
    expect(mode.status()).toEqual({ enabled: true, directory: "/sample" })
  } finally {
    mode.dispose()
  }
})

test("project status refetches when the location changes", async () => {
  const harness = createHarness({ defaultDirectory: "/sample", enabledDirectories: ["/sample"] })
  const mode = createProjectMode(harness.context)
  try {
    await waitFor(() => mode.status().enabled)
    harness.setLocation({ directory: "/elsewhere" })
    await waitFor(() => harness.calls.length >= 2)
    await waitFor(() => mode.status().enabled === false)
    const last = harness.calls[harness.calls.length - 1]
    expect(last.directory).toBe("/elsewhere")
  } finally {
    mode.dispose()
  }
})

test("project.changed events keep updating the status", async () => {
  const harness = createHarness({ defaultDirectory: "/sample", enabledDirectories: ["/sample"] })
  const mode = createProjectMode(harness.context)
  try {
    await waitFor(() => mode.status().enabled)
    harness.emitChanged({ enabled: false, directory: "/sample" })
    await waitFor(() => mode.status().enabled === false)
    harness.emitChanged({ enabled: true, directory: "/sample" })
    await waitFor(() => mode.status().enabled)
  } finally {
    mode.dispose()
  }
})

test("a failing status request surfaces an error toast", async () => {
  const harness = createHarness({ defaultDirectory: "/sample", enabledDirectories: ["/sample"], failStatus: true })
  const mode = createProjectMode(harness.context)
  try {
    await waitFor(() => harness.calls.length > 0)
    await waitFor(() => harness.toasts.length > 0)
    expect(mode.status().enabled).toBe(false)
    expect(harness.toasts[0].variant).toBe("error")
  } finally {
    mode.dispose()
  }
})

// Project mode resolves upward: a session opened below an enabled directory
// reads the same project, and the nearest config wins. A team worktree outside
// the parent's tree carries no copy and is activated through the run record's
// projectDirectory instead (packages/plus/src/index.ts activationDirectory).
test("project mode resolves upward from a nested directory to the nearest config", async () => {
  const tmp = await mkdtemp(join(tmpdir(), "plus-project-mode-"))
  try {
    const root = join(tmp, "repo")
    const nested = join(root, "packages", "plus")
    await mkdir(nested, { recursive: true })
    await enable(root)
    expect(await read(nested)).toEqual({ version: 1, protectedAgents: [] })

    await mkdir(join(root, "packages", ".opencodeplus"), { recursive: true })
    await writeFile(
      join(root, "packages", ".opencodeplus", "project.json"),
      `${JSON.stringify({ version: 1, protectedAgents: ["muse-implementer"] }, null, 2)}\n`,
    )
    expect(await read(nested)).toEqual({ version: 1, protectedAgents: ["muse-implementer"] })
    // The root's own config is unchanged by the nested one.
    expect(await read(root)).toEqual({ version: 1, protectedAgents: [] })
  } finally {
    await rm(tmp, { recursive: true, force: true })
  }
})
