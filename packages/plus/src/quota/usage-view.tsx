import type { Plugin } from "@opencode/plugin/tui"
import { ScrollBoxRenderable, type BoxRenderable, type Renderable } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createMemo, createSignal, Index, on, onCleanup, Show } from "solid-js"
import {
  barCells,
  identity,
  percentLabel,
  usageArguments,
  windowDetail,
  windowShort,
  windowState,
  windowTail,
  type WindowState,
} from "./usage-format.js"
import { createUsageStore, type UsageStore } from "./usage-store.js"
import type { UsageSnapshot, UsageWindow } from "./usage.js"

type Credential = UsageSnapshot["credentials"][number]
type Theme = Plugin.Context["theme"]

/** Fixed cells of a window row besides its label and bar: " " bar " " "100%" " " tail(7). */
const ROW_FIXED = 1 + 1 + 4 + 1 + 7
/** Left accent border plus padding in front of each credential. */
const CREDENTIAL_INDENT = 2
/** Widest inline panel content; matches the home prompt's width. */
const INLINE_MAX_WIDTH = 64

/**
 * Registers the sidebar section, the inline fallback (narrow sessions, hidden
 * sidebar, home screen) and the OpenCodePlus palette/slash commands.
 */
export function createUsage(context: Plugin.Context, options: { interval?: number } = {}) {
  const store = createUsageStore(context, options)
  const [inline, setInline] = createSignal({ open: false, collapsed: false })
  const [focus, setFocus] = createSignal<{ sessionID: string; at: number }>()
  const routeSession = () => {
    const route = context.ui.router.current()
    return route.type === "session" ? route.sessionID : undefined
  }
  const inlineShown = () => {
    if (!inline().open) return false
    const route = context.ui.router.current()
    if (route.type === "home") return true
    return route.type === "session" && !store.sidebarVisible(route.sessionID)
  }
  const toggle = () => {
    setInline((value) => ({ ...value, collapsed: !value.collapsed }))
  }
  const close = () => {
    setInline({ open: false, collapsed: false })
  }
  const releases = [
    context.ui.slot({
      append: "sidebar.content",
      render: (input) => <SidebarUsage context={context} store={store} sessionID={input.sessionID} focus={focus()} />,
    }),
    context.ui.slot({
      append: "session.composer.top",
      render: (input) => (
        <Show when={inlineShown() && routeSession() === input.sessionID}>
          <InlineUsage
            context={context}
            store={store}
            collapsed={inline().collapsed}
            onToggle={toggle}
            onClose={close}
          />
        </Show>
      ),
    }),
    context.ui.slot({
      before: "home.footer",
      render: () => (
        <Show when={inlineShown() && context.ui.router.current().type === "home"}>
          <box width="100%" alignItems="center" paddingLeft={2} paddingRight={2} flexShrink={0}>
            <box width="100%" maxWidth={75}>
              <InlineUsage
                context={context}
                store={store}
                collapsed={inline().collapsed}
                onToggle={toggle}
                onClose={close}
              />
            </box>
          </box>
        </Show>
      ),
    }),
    context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "plus.usage.open",
              title: "Credential usage",
              group: "OpenCodePlus",
              palette: true,
              slash: { name: "usage", arguments: true },
              run(input) {
                const all = usageArguments(input)
                if (all === undefined) {
                  context.ui.toast.show({ variant: "warning", message: "Usage: /usage [--all]" })
                  return
                }
                store.setScope(all ? "all" : "model")
                // The compact panel above the prompt stands in whenever this chat's
                // sidebar is not visible (narrow terminal, hidden sidebar, home), and
                // follows resizes. A visible sidebar section is revealed instead.
                // Never change the sidebar preference or open a modal.
                setInline({ open: true, collapsed: false })
                const sessionID = routeSession()
                if (sessionID && store.sidebarVisible(sessionID)) setFocus({ sessionID, at: Date.now() })
              },
            },
            {
              id: "plus.usage.scope",
              title:
                store.scope() === "all"
                  ? "Usage: show the selected model's credentials"
                  : "Usage: show all credentials",
              group: "OpenCodePlus",
              palette: true,
              run: () => {
                store.setScope(store.scope() === "all" ? "model" : "all")
              },
            },
            {
              id: "plus.usage.details",
              title: store.details() ? "Usage: hide exact resets and notes" : "Usage: show exact resets and notes",
              group: "OpenCodePlus",
              palette: true,
              run: () => {
                store.setDetails(!store.details())
              },
            },
            {
              id: "plus.usage.collapse",
              title: inline().collapsed ? "Usage: expand panel" : "Usage: collapse panel",
              group: "OpenCodePlus",
              palette: true,
              enabled: inlineShown,
              run: toggle,
            },
            {
              id: "plus.usage.close",
              title: "Usage: close panel",
              group: "OpenCodePlus",
              palette: true,
              enabled: () => inline().open,
              run: close,
            },
          ],
        }))
        return null
      },
    }),
  ]
  return () => {
    releases.forEach((release) => release())
    store.dispose()
  }
}

function SidebarUsage(props: {
  context: Plugin.Context
  store: UsageStore
  sessionID: string
  focus: { sessionID: string; at: number } | undefined
}) {
  const theme = props.context.theme
  const [width, setWidth] = createSignal(0)
  const [flash, setFlash] = createSignal(false)
  let node: BoxRenderable | undefined
  onCleanup(props.store.view())
  onCleanup(props.store.sidebar(props.sessionID))
  // Scroll the sidebar so the section's header is at the top. Layout runs after
  // this effect, and a scope change grows the section when its reading arrives,
  // so the reveal repeats briefly after each reading while highlighted.
  const reveal = () =>
    setTimeout(() => {
      if (!node || node.isDestroyed) return
      const scroll = scrollParent(node)
      if (scroll) scroll.scrollTo(scroll.scrollTop + node.y - scroll.viewport.y)
    }, 50)
  createEffect(
    on(
      () => props.focus,
      (focus) => {
        if (!focus || focus.sessionID !== props.sessionID) return
        setFlash(true)
        const timers = [reveal(), setTimeout(() => setFlash(false), 2000)]
        onCleanup(() => timers.forEach(clearTimeout))
      },
      { defer: true },
    ),
  )
  createEffect(
    on(
      () => props.store.reading(),
      () => {
        if (!flash()) return
        const timer = reveal()
        onCleanup(() => clearTimeout(timer))
      },
      { defer: true },
    ),
  )
  return (
    <box
      ref={(value: BoxRenderable) => (node = value)}
      flexShrink={0}
      onSizeChange={function () {
        setWidth(this.width)
      }}
    >
      <box flexDirection="row" gap={1}>
        <text fg={flash() ? theme.text.action.primary.base : theme.text.base} flexShrink={0}>
          <b>Usage</b>
        </text>
        <box flexGrow={1} minWidth={0} alignItems="flex-end">
          <Status context={props.context} store={props.store} />
        </box>
      </box>
      <Controls context={props.context} store={props.store} />
      <Body context={props.context} store={props.store} width={width()} />
    </box>
  )
}

function InlineUsage(props: {
  context: Plugin.Context
  store: UsageStore
  collapsed: boolean
  onToggle: () => void
  onClose: () => void
}) {
  const theme = props.context.theme
  const dimensions = useTerminalDimensions()
  const [width, setWidth] = createSignal(0)
  // A fixed height keeps the transcript and prompt still while readings change.
  const height = createMemo(() => Math.max(6, Math.min(16, Math.floor(dimensions().height * 0.4))))
  onCleanup(props.store.view())
  return (
    <box
      flexShrink={0}
      height={props.collapsed ? 1 : height()}
      backgroundColor={theme.background.raised.base}
      paddingLeft={1}
      paddingRight={1}
    >
      {/* Keep a compact column on wide panes so labels stay next to their bars. */}
      <box
        width="100%"
        maxWidth={INLINE_MAX_WIDTH}
        flexGrow={1}
        minHeight={0}
        onSizeChange={function () {
          setWidth(this.width)
        }}
      >
        <box flexDirection="row" flexShrink={0} gap={1}>
          <text fg={theme.text.base} flexShrink={0} onMouseUp={props.onToggle}>
            {props.collapsed ? "▶" : "▼"} <b>Usage</b>
          </text>
          <box flexGrow={1} flexShrink={1} minWidth={0}>
            <Show when={props.collapsed} fallback={<Status context={props.context} store={props.store} />}>
              <Summary context={props.context} store={props.store} />
            </Show>
          </box>
          <text fg={theme.text.action.secondary.base} flexShrink={0} onMouseUp={props.onClose}>
            ✕
          </text>
        </box>
        <Show when={!props.collapsed}>
          <Controls context={props.context} store={props.store} />
          <scrollbox
            flexGrow={1}
            minHeight={0}
            horizontalScrollbarOptions={{ visible: false }}
            verticalScrollbarOptions={{
              position: "absolute",
              right: 0,
              top: 0,
              width: 1,
              height: "100%",
              trackOptions: {
                backgroundColor: theme.background.raised.base,
                foregroundColor: theme.scrollbar.base,
              },
            }}
          >
            <box flexShrink={0} paddingRight={1}>
              <Body context={props.context} store={props.store} width={Math.max(0, width() - 2)} />
            </box>
          </scrollbox>
        </Show>
      </box>
    </box>
  )
}

/** Header status; empty while healthy so routine refreshes cannot flicker. */
function Status(props: { context: Plugin.Context; store: UsageStore }) {
  const theme = props.context.theme
  return (
    <text fg={theme.text.feedback.warning.base} wrapMode="none" truncate>
      {props.store.reading()?.failure ? "retrying" : ""}
    </text>
  )
}

function Controls(props: { context: Plugin.Context; store: UsageStore }) {
  const theme = props.context.theme
  const option = (selected: () => boolean, label: string, run: () => void) => (
    <text flexShrink={0} onMouseUp={run} fg={selected() ? theme.text.base : theme.text.muted}>
      <span style={{ fg: selected() ? theme.text.formfield.selected : theme.text.formfield.base }}>
        {selected() ? "●" : "○"}
      </span>{" "}
      {label}
    </text>
  )
  return (
    <box flexDirection="row" gap={2} flexShrink={0}>
      {option(
        () => props.store.scope() === "model",
        "model",
        () => props.store.setScope("model"),
      )}
      {option(
        () => props.store.scope() === "all",
        "all",
        () => props.store.setScope("all"),
      )}
      <box flexGrow={1} />
      {option(props.store.details, "details", () => props.store.setDetails(!props.store.details()))}
    </box>
  )
}

/** One line for the collapsed panel: the credential this chat uses, else the first one. */
function Summary(props: { context: Plugin.Context; store: UsageStore }) {
  const theme = props.context.theme
  const text = createMemo(() => {
    const snapshot = props.store.reading()?.snapshot
    if (!snapshot) return props.store.reading()?.result?.message ?? "Loading…"
    const credential = snapshot.credentials.find((item) => identity(snapshot, item.id)) ?? snapshot.credentials[0]
    if (!credential) return "No credential quotas"
    const tag = identity(snapshot, credential.id)
    const windows = credential.windows
      .filter((window) => !window.not_applicable)
      .map((window) => `${windowShort(window)} ${percentLabel(window.remaining)}`)
      .join(" · ")
    return `${credential.alias}${tag === "active" ? " IN USE" : tag === "last" ? " LAST USED" : ""}  ${windows}`
  })
  return (
    <text fg={theme.text.muted} wrapMode="none" truncate>
      {text()}
    </text>
  )
}

function Body(props: { context: Plugin.Context; store: UsageStore; width: number }) {
  const theme = props.context.theme
  const reading = () => props.store.reading()
  const message = () => {
    if (!props.store.input()) return "Select a model to view credential usage."
    const value = reading()
    if (!value?.result) return "Loading credential quotas…"
    return value.result.message ?? ""
  }
  return (
    <box flexShrink={0}>
      {/* Above the list, so a long or scrolled list cannot hide why readings are old. */}
      <Show when={reading()?.failure}>
        {(failure) => <Note theme={theme} text={`${failure()} Showing the last reading.`} warning />}
      </Show>
      <Show when={reading()?.snapshot} fallback={<Note theme={theme} text={message()} warning={!!reading()?.result} />}>
        {(snapshot) => (
          <Credentials context={props.context} store={props.store} snapshot={snapshot()} width={props.width} />
        )}
      </Show>
    </box>
  )
}

function Note(props: { theme: Theme; text: string; warning?: boolean }) {
  return (
    <text fg={props.warning ? props.theme.text.feedback.warning.base : props.theme.text.muted} wrapMode="word">
      {props.text}
    </text>
  )
}

function Credentials(props: { context: Plugin.Context; store: UsageStore; snapshot: UsageSnapshot; width: number }) {
  const theme = props.context.theme
  const label = () => {
    if (props.store.scope() === "model" && props.snapshot.all)
      return props.store.reading()?.result?.fallback === "untracked"
        ? "All credentials · CPA is not tracking this chat, so the credential in use is unknown"
        : "All credentials · no request from this chat yet"
    if (props.snapshot.all) return "All credentials"
    const input = props.store.input()
    return input ? `${input.providerID}/${input.modelID}` : props.snapshot.model
  }
  const labelWidth = createMemo(() =>
    Math.max(
      2,
      ...props.snapshot.credentials.flatMap((item) =>
        limited(item.windows).map((window) => windowShort(window).length),
      ),
    ),
  )
  const barWidth = () => Math.max(4, props.width - CREDENTIAL_INDENT - labelWidth() - ROW_FIXED)
  return (
    <box flexShrink={0} gap={1}>
      <box flexShrink={0}>
        <text fg={theme.text.muted} wrapMode="word">
          {label()}
        </text>
        <Show when={props.store.details()}>
          <text fg={theme.text.muted} wrapMode="word">
            {props.snapshot.active.length
              ? "IN USE: CPA confirmed this credential for this chat's running request."
              : props.snapshot.current
                ? "LAST USED: this chat's latest request; the next may use another credential."
                : "No credential has served this chat yet."}
          </text>
        </Show>
      </box>
      <Show
        when={props.snapshot.credentials.length}
        fallback={<Note theme={theme} text="No credential quotas are available." />}
      >
        <box flexShrink={0} gap={1}>
          <Index each={props.snapshot.credentials}>
            {(credential) => (
              <CredentialView
                context={props.context}
                store={props.store}
                snapshot={props.snapshot}
                credential={credential()}
                labelWidth={labelWidth()}
                barWidth={barWidth()}
              />
            )}
          </Index>
        </box>
      </Show>
    </box>
  )
}

function CredentialView(props: {
  context: Plugin.Context
  store: UsageStore
  snapshot: UsageSnapshot
  credential: Credential
  labelWidth: number
  barWidth: number
}) {
  const theme = props.context.theme
  const tag = () => identity(props.snapshot, props.credential.id)
  const accent = () => {
    if (tag() === "active") return theme.text.feedback.info.base
    if (tag() === "last") return theme.text.muted
    return theme.background.raised.base
  }
  return (
    <box
      flexShrink={0}
      border={["left"]}
      borderColor={accent()}
      customBorderChars={tag() ? ACCENT : RULE}
      paddingLeft={CREDENTIAL_INDENT - 1}
    >
      <box flexDirection="row" gap={1}>
        <text fg={theme.text.base} wrapMode="word" flexGrow={1} flexShrink={1} minWidth={0}>
          <b>{props.credential.alias}</b>
        </text>
        <Show when={tag()}>
          {(value) => (
            <text flexShrink={0} fg={value() === "active" ? theme.text.feedback.info.base : theme.text.muted}>
              {value() === "active" ? <b>IN USE</b> : "LAST USED"}
            </text>
          )}
        </Show>
      </box>
      <text fg={theme.text.muted} wrapMode="char">
        {props.credential.provider} · {props.credential.id}
      </text>
      <Show when={props.credential.shared_with.length}>
        <text fg={theme.text.muted} wrapMode="word">
          <span style={{ fg: theme.text.base }}>Shared quota</span> with {props.credential.shared_with.join(", ")}
        </text>
      </Show>
      <Show
        when={limited(props.credential.windows).length}
        fallback={
          <Note
            theme={theme}
            text={props.credential.windows.length ? "No limited quota windows." : "No quota reading yet."}
          />
        }
      >
        <Index each={limited(props.credential.windows)}>
          {(window) => (
            <WindowView
              context={props.context}
              store={props.store}
              snapshot={props.snapshot}
              window={window()}
              labelWidth={props.labelWidth}
              barWidth={props.barWidth}
            />
          )}
        </Index>
      </Show>
    </box>
  )
}

function WindowView(props: {
  context: Plugin.Context
  store: UsageStore
  snapshot: UsageSnapshot
  window: UsageWindow
  labelWidth: number
  barWidth: number
}) {
  const theme = props.context.theme
  const now = () => props.store.now()
  const state = () => windowState(props.window, props.snapshot, now())
  const cells = () => barCells(props.window.remaining, props.barWidth)
  const dim = () => state() !== "normal" && state() !== "low" && state() !== "critical"
  return (
    <box flexShrink={0}>
      <Show when={props.window.scope !== "all"}>
        <text fg={theme.text.muted} wrapMode="none" truncate>
          {" ".repeat(props.labelWidth + 1)}
          {props.window.scope}
        </text>
      </Show>
      <text wrapMode="none" truncate>
        <span style={{ fg: theme.text.muted }}>{windowShort(props.window).padEnd(props.labelWidth)} </span>
        <Show
          when={state() !== "unlimited"}
          fallback={<span style={{ fg: theme.text.muted }}>{"no limit".padEnd(props.barWidth)}</span>}
        >
          <span style={{ fg: dim() ? theme.text.muted : severity(theme, state()) }}>{cells().filled}</span>
          <span style={{ fg: theme.text.muted }}>{cells().empty}</span>
        </Show>
        <span style={{ fg: dim() ? theme.text.muted : theme.text.base }}>
          {" "}
          {(state() === "unlimited" ? "" : percentLabel(props.window.remaining)).padStart(4)}
        </span>
        <span
          style={{
            fg: state() === "stale" || state() === "reset" ? theme.text.feedback.warning.base : theme.text.muted,
          }}
        >
          {" "}
          {windowTail(props.window, state(), now()).padStart(7)}
        </span>
      </text>
      <Show when={props.store.details()}>
        <box paddingLeft={props.labelWidth + 1}>
          <text fg={theme.text.muted} wrapMode="word">
            {windowDetail(props.window, state(), now())}
          </text>
        </box>
      </Show>
    </box>
  )
}

/**
 * Windows the provider reports as not applicable (for example Anthropic's separate
 * weekly Opus/Sonnet caps on accounts without them) carry no capacity; hide them.
 */
function limited(windows: readonly UsageWindow[]) {
  return windows.filter((window) => !window.not_applicable)
}

const BORDER = {
  topLeft: "",
  bottomLeft: "",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}
/** Accent for the credential this chat uses or last used; other credentials keep the same indent. */
const ACCENT = { ...BORDER, vertical: "┃" }
const RULE = { ...BORDER, vertical: " " }

function severity(theme: Theme, state: WindowState) {
  if (state === "critical") return theme.text.feedback.error.base
  if (state === "low") return theme.text.feedback.warning.base
  return theme.text.feedback.success.base
}

function scrollParent(node: Renderable) {
  for (let current = node.parent; current; current = current.parent) {
    if (current instanceof ScrollBoxRenderable) return current
  }
}
