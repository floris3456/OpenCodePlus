import type { CliRenderer } from "@opentui/core"
import { RGBA } from "@opentui/core"
import { createTestRenderer } from "@opentui/core/testing"
import { render, type JSX } from "@opentui/solid"
import type { Plugin } from "@opencode/plugin/tui"
import { createComponent } from "solid-js"
import { InstructionsRoute } from "../src/tui/instructions/route.js"
import type { Snapshot } from "../src/rpc.js"

export function createSnapshot(overrides?: Partial<Snapshot>): Snapshot {
  return {
    revision: overrides?.revision ?? 1,
    agents: overrides?.agents ?? [],
    tools: overrides?.tools ?? [],
    items: overrides?.items ?? [],
    customizations: overrides?.customizations ?? [],
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

export interface TestFixture {
  readonly context: Plugin.Context
  readonly renderer: CliRenderer
  readonly captureCharFrame: () => string
  readonly waitForFrame: (predicate: (frame: string) => boolean) => Promise<string>
  readonly emitChanged: (next?: Snapshot) => Promise<void>
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
}

export async function renderPlusFixture(options: RenderFixtureOptions): Promise<TestFixture> {
  const output = await createTestRenderer({
    width: options.width ?? 120,
    height: options.height ?? 40,
    remote: true,
    useThread: false,
  })

  const queue: Snapshot[] = [...options.snapshots]
  const listeners = new Set<() => void>()
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
        "instructions.mutate": async () => ({ ok: true, revision: 1, snapshot: nextSnapshot() }),
        events: {
          on: (_name: string, handler: () => void) => {
            listeners.add(handler)
            return () => {
              listeners.delete(handler)
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
        confirm: async () => true,
        prompt: async () => undefined,
        select: async () => undefined,
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
    for (const listener of listeners) listener()
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
    captureCharFrame: () => output.captureCharFrame(),
    waitForFrame: (predicate) => output.waitForFrame(predicate),
    emitChanged,
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
}

export async function renderInstructionsRoute(options: RenderRouteOptions): Promise<TestFixture> {
  return renderPlusFixture({
    snapshots: options.snapshots,
    routeData: options.data,
    width: options.width,
    height: options.height,
    render: (context) =>
      createComponent(InstructionsRoute, {
        context,
        onClose: options.onClose ?? (() => {}),
        data: options.data,
      }),
  })
}
