import type { CliRenderer } from "@opentui/core"
import { RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { render, type JSX } from "@opentui/solid"
import type { Plugin } from "@opencode/plugin/tui"
import { createComponent } from "solid-js"
import { InstructionsRoute } from "../src/tui/instructions/route.js"
import type {
  AddMcpInput,
  CreateAgentInput,
  CreateBaseInput,
  CreateInstructionInput,
  CreateSkillInput,
  ImportSkillInput,
  MutateInput,
  Snapshot,
  Status,
} from "../src/rpc.js"

export function createSnapshot(overrides?: Partial<Snapshot>): Snapshot {
  return {
    revision: overrides?.revision ?? 1,
    globalRevision: overrides?.globalRevision ?? 1,
    agents: overrides?.agents ?? [],
    items: overrides?.items ?? [],
    records: overrides?.records ?? [],
    servers: overrides?.servers ?? [],
    protectedAgents: overrides?.protectedAgents ?? [],
  }
}

function createTestTheme() {
  const white = RGBA.fromHex("#ffffff")
  const black = RGBA.fromHex("#000000")
  const gray = RGBA.fromHex("#888888")
  const yellow = RGBA.fromHex("#ffff00")
  const blue = RGBA.fromHex("#0000ff")
  const selectedBg = RGBA.fromHex("#333333")

  return {
    text: {
      default: white,
      subdued: gray,
      formfield: {
        default: white,
        selected: white,
        focused: white,
        hovered: white,
        disabled: gray,
      },
      feedback: {
        info: { default: blue, subdued: gray },
        warning: { default: yellow, subdued: gray },
        error: { default: yellow, subdued: gray },
        success: { default: blue, subdued: gray },
      },
    },
    background: {
      default: black,
      formfield: {
        default: black,
        selected: selectedBg,
        focused: selectedBg,
        hovered: selectedBg,
        disabled: black,
      },
      feedback: {
        info: { default: black },
        warning: { default: black },
        error: { default: black },
        success: { default: black },
      },
    },
  }
}

export type TestKeymapLayer = ReturnType<Parameters<Plugin.Context["keymap"]["layer"]>[0]>
export type TestKeymapCommand = NonNullable<TestKeymapLayer["commands"]>[number]
type KeymapLayerCallback = Parameters<Plugin.Context["keymap"]["layer"]>[0]

export interface FakeRpc {
  readonly mutateInputs: MutateInput[]
  readonly agentCreates: CreateAgentInput[]
  readonly agentDeletes: { scope: string; id: string }[]
  readonly skillCreates: CreateSkillInput[]
  readonly skillImports: ImportSkillInput[]
  readonly baseCreates: CreateBaseInput[]
  readonly instructionCreates: CreateInstructionInput[]
  readonly mcpAdds: AddMcpInput[]
  readonly mcpRemoves: { name: string }[]
  readonly dialogPrompts: string[][]
  readonly dialogSelects: unknown[][]
  readonly dialogConfirms: unknown[][]
}

export interface DialogScript {
  readonly prompts?: readonly (string | undefined)[]
  readonly selects?: readonly (unknown | undefined)[]
  readonly confirms?: readonly (boolean | undefined)[]
}

export interface TestFixture {
  readonly context: Plugin.Context
  readonly renderer: CliRenderer
  readonly fake: FakeRpc
  readonly captureCharFrame: () => string
  readonly waitForFrame: (predicate: (frame: string) => boolean) => Promise<string>
  readonly emitChanged: (next?: Snapshot) => Promise<void>
  readonly emitProjectChanged: (status?: Partial<Status>) => Promise<void>
  readonly destroy: () => void
  readonly commands: () => readonly TestKeymapCommand[]
  readonly resize: (width: number, height: number) => void
  readonly [Symbol.asyncDispose]: () => Promise<void>
}

export interface RenderFixtureOptions {
  readonly snapshots: readonly Snapshot[]
  readonly render: (context: Plugin.Context) => JSX.Element
  readonly width?: number
  readonly height?: number
  readonly routeData?: unknown
  readonly dialogs?: DialogScript
  readonly mutateResult?: unknown
}

export async function renderPlusFixture(options: RenderFixtureOptions): Promise<TestFixture> {
  const output = await createTestRenderer({
    width: options.width ?? 120,
    height: options.height ?? 40,
    remote: true,
    useThread: false,
  })

  const queue: Snapshot[] = [...options.snapshots]
  const fake: FakeRpc = {
    mutateInputs: [],
    agentCreates: [],
    agentDeletes: [],
    skillCreates: [],
    skillImports: [],
    baseCreates: [],
    instructionCreates: [],
    mcpAdds: [],
    mcpRemoves: [],
    dialogPrompts: [],
    dialogSelects: [],
    dialogConfirms: [],
  }
  const promptScript = [...(options.dialogs?.prompts ?? [])]
  const selectScript = [...(options.dialogs?.selects ?? [])]
  const confirmScript = [...(options.dialogs?.confirms ?? [])]
  type RpcListener = (event: { data: Status }) => void
  const instructionsListeners = new Set<RpcListener>()
  const projectListeners = new Set<RpcListener>()
  const layers: KeymapLayerCallback[] = []

  function commands(): readonly TestKeymapCommand[] {
    return [...layers]
      .reverse()
      .flatMap((fn) => fn().commands ?? [])
  }

  function nextSnapshot(): Snapshot {
    if (queue.length > 1) {
      const item = queue.shift()
      if (item !== undefined) return item
    }
    if (queue.length === 1) return queue[0]
    return createSnapshot()
  }

  const rawContext: {} = {
    options: {},
    location: undefined,
    app: { version: "0.0.0", channel: "test" },
    renderer: output.renderer,
    client: {
      rpc: () => ({
        "instructions.snapshot": async () => nextSnapshot(),
        "instructions.refresh": async () => nextSnapshot(),
        "instructions.mutate": async (input: MutateInput) => {
          fake.mutateInputs.push(input)
          if (options.mutateResult !== undefined) return options.mutateResult
          return { ok: true, revision: 1, globalRevision: 1, snapshot: nextSnapshot() }
        },
        "agent.create": async (input: CreateAgentInput) => {
          fake.agentCreates.push(input)
          return { id: input.id, path: `/agents/${input.id}.md` }
        },
        "agent.delete": async (input: { scope: string; id: string }) => {
          fake.agentDeletes.push(input)
          return { id: input.id, path: `/agents/${input.id}.md` }
        },
        "skill.create": async (input: CreateSkillInput) => {
          fake.skillCreates.push(input)
          return { id: input.name, path: `/skills/${input.name}` }
        },
        "skill.import": async (input: ImportSkillInput) => {
          fake.skillImports.push(input)
          return { id: input.path, path: input.path }
        },
        "base.create": async (input: CreateBaseInput) => {
          fake.baseCreates.push(input)
          return { id: input.id }
        },
        "instruction.create": async (input: CreateInstructionInput) => {
          fake.instructionCreates.push(input)
          return { id: input.name, path: `/instructions/${input.name}` }
        },
        "mcp.add": async (input: AddMcpInput) => {
          fake.mcpAdds.push(input)
          return { name: input.name }
        },
        "mcp.remove": async (input: { name: string }) => {
          fake.mcpRemoves.push(input)
          return { name: input.name }
        },
        events: {
          on: (name: string, handler: RpcListener) => {
            if (name === "project.changed") {
              projectListeners.add(handler)
              return () => {
                projectListeners.delete(handler)
              }
            }
            instructionsListeners.add(handler)
            return () => {
              instructionsListeners.delete(handler)
            }
          },
        },
      }),
    },
    data: {
      location: {
        model: {
          list: () => [],
          sync: async () => {},
        },
      },
    },
    attention: {
      notify: async () => ({ ok: true, notification: false, sound: false }),
    },
    theme: createTestTheme(),
    themeMode: "dark",
    markdown: {
      registerCodeBlockRenderer: () => () => {},
    },
    keymap: {
      layer: (fn: KeymapLayerCallback) => {
        layers.push(fn)
      },
      dispatch: () => {},
      shortcuts: () => [],
      commands: () => commands(),
      pending: () => [],
      active: () => [],
      mode: {
        current: () => "normal",
        push: () => () => {},
      },
    },
    storage: {
      store: <T extends object>(_key: string, opts: { initial: T }) => [opts.initial, async () => {}],
      memory: <T extends object>(_key: string, opts: { initial: T }) => [opts.initial, () => {}],
    },
    ui: {
      dialog: {
        show: () => {},
        set: () => {},
        clear: () => {},
        alert: async () => {},
        confirm: async (input: unknown) => {
          fake.dialogConfirms.push([input])
          if (confirmScript.length > 0) return confirmScript.shift()
          return true
        },
        prompt: async (input: { title: string }) => {
          fake.dialogPrompts.push([input.title])
          if (promptScript.length > 0) return promptScript.shift()
          return undefined
        },
        select: async (input: { title: string }) => {
          fake.dialogSelects.push([input.title])
          if (selectScript.length > 0) return selectScript.shift()
          return undefined
        },
      },
      toast: {
        show: () => {},
      },
      format: {
        path: (p: string) => p,
      },
      router: {
        register: () => () => {},
        navigate: () => {},
        current: () => ({
          type: "plugin",
          id: "opencode.plus",
          name: "instructions",
          data: options.routeData,
        }),
      },
      panel: {
        open: () => false,
        close: () => {},
        current: () => undefined,
      },
      tabs: {
        enabled: () => false,
        list: () => [],
        open: () => false,
        focus: () => false,
        move: () => false,
        close: () => false,
      },
      slot: () => () => {},
    },
  }

  // Cast to Plugin.Context: Plugin.Context requires full OpenCodeClient and ResolvedTheme
  // implementations from packages that are not dependencies of @opencode/plus.
  const context = rawContext as Plugin.Context

  await render(() => options.render(context), output.renderer)
  output.renderer.start()

  function destroy() {
    if (!output.renderer.isDestroyed) output.renderer.destroy()
  }

  async function emitChanged(next?: Snapshot): Promise<void> {
    if (next !== undefined) queue.push(next)
    for (const listener of instructionsListeners) listener({ data: { enabled: true, directory: "" } })
  }

  async function emitProjectChanged(status?: Partial<Status>): Promise<void> {
    const data: Status = {
      enabled: status?.enabled ?? false,
      directory: status?.directory ?? "",
    }
    for (const listener of projectListeners) listener({ data })
  }

  // Cast to ResizableRenderer: processResize is marked private in CliRenderer's type
  // definitions, but required to synchronously process resize events in tests.
  const resizableRenderer = output.renderer as unknown as {
    processResize: (width: number, height: number) => void
  }

  function resize(width: number, height: number): void {
    resizableRenderer.processResize(width, height)
  }

  return {
    context,
    renderer: output.renderer,
    fake,
    captureCharFrame: () => output.captureCharFrame(),
    waitForFrame: (predicate) => output.waitForFrame(predicate),
    emitChanged,
    emitProjectChanged,
    destroy,
    commands,
    resize,
    [Symbol.asyncDispose]: async () => {
      destroy()
    },
  }
}

export interface RenderRouteOptions {
  readonly snapshots: readonly Snapshot[]
  readonly data?: unknown
  readonly width?: number
  readonly height?: number
  readonly onClose?: () => void
  readonly dialogs?: DialogScript
  readonly mutateResult?: unknown
}

export async function renderInstructionsRoute(options: RenderRouteOptions): Promise<TestFixture> {
  return renderPlusFixture({
    snapshots: options.snapshots,
    routeData: options.data,
    width: options.width,
    height: options.height,
    dialogs: options.dialogs,
    mutateResult: options.mutateResult,
    render: (context) =>
      createComponent(InstructionsRoute, {
        context,
        onClose: options.onClose ?? (() => {}),
        data: options.data,
      }),
  })
}
