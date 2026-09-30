import type { CliRenderer, CapturedFrame } from "@opentui/core"
import { RGBA } from "@opentui/core"
import { createTestRenderer, type MockMouse } from "@opentui/core/testing"
import { render, type JSX } from "@opentui/solid"
import type { Plugin } from "@opencode/plugin/tui"
import type { PromptSendInput } from "@opencode/plugin/tui/context"
import type { Agent } from "@opencode/schema/agent"
import { createComponent, createSignal } from "solid-js"
import { createStore } from "solid-js/store"
import { InstructionsRoute } from "../src/tui/instructions/route.js"
import { createSnapshotCache, type SnapshotCache } from "../src/tui/snapshot-cache.js"
import { Definition } from "../src/rpc.js"
import type {
  AddMcpInput,
  CreateAgentInput,
  CreateBaseInput,
  CreateInstructionInput,
  CreateSkillInput,
  CreateTeamInput,
  DeleteBaseInput,
  DeleteInstructionInput,
  DeleteSkillInput,
  EntryCreateInput,
  ImportSkillInput,
  InstructionsChanged,
  LinkSetInput,
  ModelAddInput,
  MutateInput,
  PresetAddMemberInput,
  PresetCreateInput,
  PresetDeleteInput,
  RuleAddInput,
  Snapshot,
  TeamAddAgentInput,
} from "../src/rpc.js"

export function createSnapshot(overrides?: Partial<Snapshot>): Snapshot {
  return {
    revision: overrides?.revision ?? 1,
    globalRevision: overrides?.globalRevision ?? 1,
    agents: overrides?.agents ?? [],
    items: overrides?.items ?? [],
    records: overrides?.records ?? [],
    ...(overrides?.links === undefined ? {} : { links: overrides.links }),
    ...(overrides?.entries === undefined ? {} : { entries: overrides.entries }),
    ...(overrides?.presets === undefined ? {} : { presets: overrides.presets }),
    ...(overrides?.teams === undefined ? {} : { teams: overrides.teams }),
    ...(overrides?.listing === undefined ? {} : { listing: overrides.listing }),
    servers: overrides?.servers ?? [],
    protectedAgents: overrides?.protectedAgents ?? [],
  }
}

export function createTestTheme() {
  const white = RGBA.fromHex("#ffffff")
  const black = RGBA.fromHex("#000000")
  const gray = RGBA.fromHex("#888888")
  const yellow = RGBA.fromHex("#ffff00")
  const blue = RGBA.fromHex("#0000ff")
  const selectedBg = RGBA.fromHex("#333333")
  const focusedBg = RGBA.fromHex("#555555")

  const green = RGBA.fromHex("#00ff00")
  const red = RGBA.fromHex("#ff0000")
  const stateful = (base: RGBA, focused: RGBA) => {
    const states = { base, hovered: focused, focused, pressed: focused, selected: focused, disabled: gray }
    return {
      ...states,
      state: (input: Partial<Record<"hovered" | "focused" | "pressed" | "selected" | "disabled", boolean>>) =>
        states[
          (["hovered", "focused", "pressed", "selected", "disabled"] as const).find((key) => input[key]) ?? "base"
        ],
    }
  }
  const scale = (color: RGBA) => Object.fromEntries([50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950].map((step) => [step, color]))

  return {
    // The real theme steps a colour along its hue scale; the test theme's scales are flat.
    increase: (color: RGBA) => color,
    decrease: (color: RGBA) => color,
    categorical: [scale(blue), scale(green), scale(yellow), scale(red)],
    border: { base: gray },
    scrollbar: { base: gray },
    diff: {
      text: { added: green, removed: red, context: white, hunkHeader: gray },
      background: { added: black, removed: black, context: black },
      highlight: { added: green, removed: red },
      lineNumber: { text: gray, background: { added: black, removed: black } },
    },
    text: {
      base: white,
      muted: gray,
      action: { primary: stateful(white, white), secondary: stateful(gray, white), destructive: stateful(red, red) },
      formfield: stateful(white, white),
      feedback: {
        info: { base: blue, muted: gray },
        warning: { base: yellow, muted: gray },
        error: { base: yellow, muted: gray },
        success: { base: blue, muted: gray },
      },
    },
    background: {
      base: black,
      raised: { base: black, high: selectedBg, max: selectedBg },
      // focused is distinct from raised.high so tests can tell the focused
      // cursor row from the unfocused one behind a dialog.
      action: { primary: stateful(focusedBg, focusedBg), secondary: stateful(black, selectedBg), destructive: stateful(red, red) },
      formfield: stateful(black, selectedBg),
      feedback: {
        info: { base: black },
        warning: { base: black },
        error: { base: black },
        success: { base: black },
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
  readonly skillDeletes: DeleteSkillInput[]
  readonly baseCreates: CreateBaseInput[]
  readonly baseDeletes: { id: string }[]
  readonly instructionCreates: CreateInstructionInput[]
  readonly instructionDeletes: { name: string }[]
  readonly mcpAdds: AddMcpInput[]
  readonly mcpRemoves: { name: string }[]
  readonly ruleAdds: RuleAddInput[]
  readonly teamCreates: CreateTeamInput[]
  readonly teamAddAgents: TeamAddAgentInput[]
  readonly entryCreates: EntryCreateInput[]
  readonly presetCreates: PresetCreateInput[]
  readonly presetAddMembers: PresetAddMemberInput[]
  readonly presetDeletes: PresetDeleteInput[]
  readonly linkSets: LinkSetInput[]
  readonly modelAdds: ModelAddInput[]
  /** Every toast shown, in order. */
  readonly toasts: { variant?: string; message: string }[]
  /** Full prompt and select inputs (titles, descriptions, options, current), in order. */
  readonly promptInputs: TestPromptInput[]
  readonly selectInputs: TestSelectInput[]
  readonly dialogPrompts: string[][]
  readonly dialogSelects: unknown[][]
  readonly dialogConfirms: unknown[][]
  readonly agentSelects: string[]
  /** How many `instructions.snapshot` RPCs have been served. */
  snapshotCalls: number
}

export interface TestPromptInput {
  readonly title: string
  readonly description?: string
  readonly placeholder?: string
  readonly value?: string
}

export interface TestSelectInput {
  readonly title: string
  readonly placeholder?: string
  readonly current?: unknown
  readonly options: readonly { readonly title: string; readonly value: unknown; readonly category?: string; readonly description?: string }[]
}

/** A declared RPC error the fake throws instead of answering (the shape the client raises). */
export interface TestRpcError {
  readonly type: string
  readonly message: string
  readonly data?: unknown
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
  /** The same frame with styled spans, for semantic colour assertions. */
  readonly captureSpans: () => CapturedFrame
  readonly waitForFrame: (predicate: (frame: string) => boolean) => Promise<string>
  /** Settle scheduled renders (mouse hover dispatch) before asserting. */
  readonly flush: () => Promise<void>
  /** The host keymap mode: "modal" while a dialog is open. */
  readonly setKeymapMode: (mode: string) => void
  /** Every ui.dialog.set call the rendered component made, in order. */
  readonly dialogSets: readonly { readonly size?: string; readonly centered?: boolean }[]
  /** The last value a `storage.memory` key was saved with. */
  readonly memoryValue: (key: string) => unknown
  /** The current value of a durable `storage.store` key (the shared backing map). */
  readonly storeValue: (key: string) => unknown
  /** Every key opened in `storage.memory`; durable keys must not appear here. */
  readonly memoryKeys: () => string[]
  readonly mockMouse: MockMouse
  readonly emitChanged: (next?: Snapshot) => Promise<void>
  readonly emitAgents: (agents: readonly Agent.Info[] | undefined) => void
  /** The plugin-level snapshot cache this fixture renders against. */
  readonly cache: SnapshotCache
  /** Resolves every held `instructions.snapshot` answer and stops holding. */
  readonly releaseSnapshots: () => Promise<void>
  readonly destroy: () => void
  readonly commands: () => readonly TestKeymapCommand[]
  readonly resize: (width: number, height: number) => void
  /** Types into the focused input (the filter bar, an editor). */
  readonly typeText: (text: string) => Promise<void>
  /** Runs the registered ui.prompt.guard checks as the host prompt does before a send; true when none holds it. */
  readonly send: (input: PromptSendInput) => boolean
  readonly [Symbol.asyncDispose]: () => Promise<void>
}

export interface RenderFixtureOptions {
  readonly snapshots: readonly Snapshot[]
  readonly render: (context: Plugin.Context, cache: SnapshotCache) => JSX.Element
  readonly width?: number
  readonly height?: number
  readonly routeData?: unknown
  readonly dialogs?: DialogScript
  readonly mutateResult?: unknown
  /** RPC name → the error it throws (link.set, preset.delete, …). */
  readonly rpcErrors?: Readonly<Record<string, TestRpcError>>
  readonly models?: readonly { providerID: string; modelID: string; variant?: string; name: string }[]
  readonly agents?: readonly Agent.Info[]
  /** Durable `storage.store` backing cells shared across fixtures, to model a TUI restart. */
  readonly storage?: Map<string, unknown>
  /** The plugin-level snapshot cache; a fresh one is created when absent. */
  readonly cache?: SnapshotCache
  /** Holds every `instructions.snapshot` answer until releaseSnapshots(). */
  readonly holdSnapshots?: boolean
  /** Extra RPC methods (monitor.query, …) answered by the test. */
  readonly rpc?: Readonly<Record<string, (input: never) => Promise<unknown>>>
  /** data.session.status per session id; idle when absent. */
  readonly sessionStatus?: Readonly<Record<string, "idle" | "running">>
}

export async function renderPlusFixture(options: RenderFixtureOptions): Promise<TestFixture> {
  const output = await createTestRenderer({
    width: options.width ?? 120,
    height: options.height ?? 40,
    remote: true,
    useThread: false,
  })

  const queue: Snapshot[] = [...options.snapshots]
  const [agents, setAgents] = createSignal<readonly Agent.Info[] | undefined>(options.agents)
  const fake: FakeRpc = {
    mutateInputs: [],
    agentCreates: [],
    agentDeletes: [],
    skillCreates: [],
    skillImports: [],
    skillDeletes: [],
    baseCreates: [],
    baseDeletes: [],
    instructionCreates: [],
    instructionDeletes: [],
    mcpAdds: [],
    mcpRemoves: [],
    ruleAdds: [],
    teamCreates: [],
    teamAddAgents: [],
    entryCreates: [],
    presetCreates: [],
    presetAddMembers: [],
    presetDeletes: [],
    linkSets: [],
    modelAdds: [],
    toasts: [],
    promptInputs: [],
    selectInputs: [],
    dialogPrompts: [],
    dialogSelects: [],
    dialogConfirms: [],
    agentSelects: [],
    snapshotCalls: 0,
  }
  const promptScript = [...(options.dialogs?.prompts ?? [])]
  const selectScript = [...(options.dialogs?.selects ?? [])]
  const confirmScript = [...(options.dialogs?.confirms ?? [])]
  type RpcListener = (event: { data: InstructionsChanged }) => void
  const instructionsListeners = new Set<RpcListener>()
  const layers: KeymapLayerCallback[] = []
  const dialogSets: { size?: string; centered?: boolean }[] = []
  const memoryCells = new Map<string, { value: unknown }>()
  const storeCells = options.storage ?? new Map<string, unknown>()
  const [keymapMode, setKeymapMode] = createSignal("normal")
  const promptGuards = new Set<(input: PromptSendInput) => boolean>()
  // Held snapshot answers: the test asserts on the frame while an RPC is in
  // flight, then releases it to observe the fresh snapshot replace the cached.
  const heldSnapshots: (() => void)[] = []
  let holdingSnapshots = options.holdSnapshots ?? false

  function commands(): readonly TestKeymapCommand[] {
    return [...layers]
      .reverse()
      .flatMap((fn) => fn().commands ?? [])
  }

  function fail(name: string): void {
    const error = options.rpcErrors?.[name]
    if (error !== undefined) throw error
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
        "instructions.snapshot": async () => {
          fake.snapshotCalls++
          if (holdingSnapshots) await new Promise<void>((release) => heldSnapshots.push(release))
          return nextSnapshot()
        },
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
        "skill.delete": async (input: DeleteSkillInput) => {
          fake.skillDeletes.push(input)
          return { id: input.id, path: `/skills/${input.id}` }
        },
        "base.create": async (input: CreateBaseInput) => {
          fake.baseCreates.push(input)
          return { id: input.id }
        },
        "base.delete": async (input: DeleteBaseInput) => {
          fake.baseDeletes.push(input)
          return { id: input.id }
        },
        "instruction.create": async (input: CreateInstructionInput) => {
          fake.instructionCreates.push(input)
          return { id: input.name, path: `/instructions/${input.name}` }
        },
        "instruction.delete": async (input: DeleteInstructionInput) => {
          fake.instructionDeletes.push(input)
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
        "rule.add": async (input: RuleAddInput) => {
          fake.ruleAdds.push(input)
          return { level: input.level, agent: input.agent, tool: input.tool, id: input.id, label: input.label }
        },
        "team.create": async (input: CreateTeamInput) => {
          fake.teamCreates.push(input)
          fail("team.create")
          return { level: input.level, team: input.team, enabled: false }
        },
        "team.addAgent": async (input: TeamAddAgentInput) => {
          fake.teamAddAgents.push(input)
          fail("team.addAgent")
          return { id: input.id, path: `/teams/${input.team}/${input.id}.md` }
        },
        "entry.create": async (input: EntryCreateInput) => {
          fake.entryCreates.push(input)
          fail("entry.create")
          return { id: `agent:defaults:${input.name}`, catalogue: input.catalogue, name: input.name }
        },
        "entry.delete": async () => {
          fail("entry.delete")
          return { id: "", catalogue: "agents" }
        },
        "preset.create": async (input: PresetCreateInput) => {
          fake.presetCreates.push(input)
          fail("preset.create")
          return { id: `preset:${input.id}`, ref: { kind: input.kind, id: input.id } }
        },
        "preset.addMember": async (input: PresetAddMemberInput) => {
          fake.presetAddMembers.push(input)
          fail("preset.addMember")
          return { id: `team:preset:${input.team}:${input.id}`, ref: { kind: "member", team: input.team, id: input.id } }
        },
        "preset.delete": async (input: PresetDeleteInput) => {
          fake.presetDeletes.push(input)
          fail("preset.delete")
          return { id: "", ref: input.ref }
        },
        "link.set": async (input: LinkSetInput) => {
          fake.linkSets.push(input)
          fail("link.set")
          return { level: input.level, agent: input.agent, ...(input.team === undefined ? {} : { team: input.team }), preset: input.preset }
        },
        "catalog.models": async () => ({ models: options.models ?? [] }),
        "model.add": async (input: ModelAddInput) => {
          fake.modelAdds.push(input)
          fail("model.add")
          return { level: input.level, agent: input.agent, providerID: input.providerID, modelID: input.modelID }
        },
        ...options.rpc,
        events: {
          on: (name: string, handler: RpcListener) => {
            instructionsListeners.add(handler)
            return () => {
              instructionsListeners.delete(handler)
            }
          },
        },
      }),
    },
    data: {
      session: {
        status: (sessionID: string) => options.sessionStatus?.[sessionID] ?? "idle",
      },
      location: {
        // No location is open in the fixture: callers fall back to none.
        default: () => undefined,
        agent: {
          list: agents,
          sync: async () => {},
        },
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
        current: keymapMode,
        push: () => () => {},
      },
    },
    storage: {
      // Durable cells backed by a shared map: the same map across fixtures
      // models the TUI writing to disk and reopening.
      store: <T extends object>(key: string, opts: { initial: T }) => {
        const initial = (storeCells.get(key) as T | undefined) ?? opts.initial
        const [value, setValue] = createStore<T>(initial)
        const raw = structuredClone(initial) as T
        const save = async (mutation: (draft: T) => void) => {
          mutation(raw)
          setValue(raw)
          storeCells.set(key, structuredClone(raw))
        }
        return [value, save] as const
      },
      memory: <T extends object>(key: string, opts: { initial: T }) => {
        const cell = memoryCells.get(key) ?? { value: opts.initial }
        memoryCells.set(key, cell)
        const save = (mutation: (draft: T) => void) => {
          const draft = structuredClone(cell.value) as T
          mutation(draft)
          cell.value = draft
        }
        return [cell.value as T, save] as const
      },
    },
    ui: {
      dialog: {
        show: () => {},
        set: (options: { readonly size?: "medium" | "large" | "xlarge"; readonly centered?: boolean }) => {
          dialogSets.push(options)
        },
        clear: () => {},
        alert: async () => {},
        confirm: async (input: unknown) => {
          fake.dialogConfirms.push([input])
          if (confirmScript.length > 0) return confirmScript.shift()
          return true
        },
        prompt: async (input: TestPromptInput) => {
          fake.promptInputs.push(input)
          fake.dialogPrompts.push([input.title])
          if (promptScript.length > 0) return promptScript.shift()
          return undefined
        },
        select: async (input: TestSelectInput) => {
          fake.selectInputs.push(input)
          fake.dialogSelects.push([input.title])
          if (selectScript.length > 0) return selectScript.shift()
          return undefined
        },
      },
      toast: {
        show: (toast: { variant?: string; message: string }) => {
          fake.toasts.push(toast)
        },
      },
      agents: {
        groups: () => () => {},
        activeGroup: { current: () => undefined, set: () => {} },
        open: () => {},
        current: () => undefined,
        set: (id: string) => {
          fake.agentSelects.push(id)
        },
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
      prompt: {
        guard: (check: (input: PromptSendInput) => boolean) => {
          promptGuards.add(check)
          return () => {
            promptGuards.delete(check)
          }
        },
      },
    },
  }

  // Cast to Plugin.Context: Plugin.Context requires full OpenCodeClient and ResolvedTheme
  // implementations from packages that are not dependencies of @opencode/plus.
  const context = rawContext as Plugin.Context
  // The plugin-level cache, wired to the same change events the plugin uses:
  // while the screen is closed it only marks entries stale.
  const cache = options.cache ?? createSnapshotCache({
    events: context.client.rpc(Definition).events,
  })

  await render(() => options.render(context, cache), output.renderer)
  output.renderer.start()

  function destroy() {
    if (!output.renderer.isDestroyed) output.renderer.destroy()
  }

  async function emitChanged(next?: Snapshot): Promise<void> {
    if (next !== undefined) queue.push(next)
    const data: InstructionsChanged = { revision: next?.revision ?? 1, globalRevision: next?.globalRevision ?? 1 }
    for (const listener of instructionsListeners) listener({ data })
  }

  async function releaseSnapshots(): Promise<void> {
    holdingSnapshots = false
    for (const release of heldSnapshots.splice(0)) release()
    await new Promise((resolve) => setTimeout(resolve, 0))
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
    captureSpans: () => output.captureSpans(),
    waitForFrame: (predicate) => output.waitForFrame(predicate),
    flush: () => output.flush(),
    setKeymapMode: (mode) => setKeymapMode(mode),
    dialogSets,
    memoryValue: (key) => memoryCells.get(key)?.value,
    storeValue: (key) => storeCells.get(key),
    memoryKeys: () => [...memoryCells.keys()],
    mockMouse: output.mockMouse,
    emitChanged,
    emitAgents: (next) => setAgents(next),
    cache,
    releaseSnapshots,
    destroy,
    commands,
    resize,
    typeText: (text) => output.mockInput.typeText(text),
    send: (input) => [...promptGuards].map((check) => check(input)).every(Boolean),
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
  readonly rpcErrors?: Readonly<Record<string, TestRpcError>>
  readonly models?: readonly { providerID: string; modelID: string; variant?: string; name: string }[]
  readonly agents?: readonly Agent.Info[]
  /** Durable `storage.store` backing cells shared across fixtures, to model a TUI restart. */
  readonly storage?: Map<string, unknown>
  /** The plugin-level snapshot cache; a fresh one is created when absent. */
  readonly cache?: SnapshotCache
  /** Holds every `instructions.snapshot` answer until releaseSnapshots(). */
  readonly holdSnapshots?: boolean
}

export async function renderInstructionsRoute(options: RenderRouteOptions): Promise<TestFixture> {
  return renderPlusFixture({
    snapshots: options.snapshots,
    routeData: options.data,
    width: options.width,
    height: options.height,
    dialogs: options.dialogs,
    mutateResult: options.mutateResult,
    ...(options.rpcErrors === undefined ? {} : { rpcErrors: options.rpcErrors }),
    ...(options.models === undefined ? {} : { models: options.models }),
    ...(options.agents === undefined ? {} : { agents: options.agents }),
    ...(options.storage === undefined ? {} : { storage: options.storage }),
    ...(options.cache === undefined ? {} : { cache: options.cache }),
    ...(options.holdSnapshots === undefined ? {} : { holdSnapshots: options.holdSnapshots }),
    render: (context, cache) =>
      createComponent(InstructionsRoute, {
        context,
        onClose: options.onClose ?? (() => {}),
        data: options.data,
        cache,
      }),
  })
}
