import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createMemo, createSignal, Index, onCleanup, Show } from "solid-js"
import {
  barCells,
  percentLabel,
  usageArguments,
  windowDetail,
  windowShort,
  windowState,
  windowTail,
} from "./usage-format.js"
import { createUsageStore, type UsageStore } from "./usage-store.js"
import type { UsageSnapshot, UsageWindow } from "./usage.js"

type Credential = UsageSnapshot["credentials"][number]

/** The sidebar stays selected-provider-scoped; the dialog alone owns the inspection scope. */
export function createUsage(context: Plugin.Context, options: { interval?: number; enabled?: () => boolean } = {}) {
  const store = createUsageStore(context, options)
  const open = (input?: string) => {
    const all = usageArguments(input)
    if (all === undefined) {
      context.ui.toast.show({ variant: "warning", message: "Usage: /usage [--all]" })
      return
    }
    context.ui.dialog.show(() => <UsageDialog context={context} store={store} all={all} />)
  }
  const releases = [
    context.ui.slot({
      append: "sidebar.content",
      render: () => (
        <Show when={options.enabled?.() ?? true}>
          <SidebarUsage context={context} store={store} />
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
              group: "Pacer",
              palette: true,
              slash: { name: "usage", arguments: "optional" },
              run: open,
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

function selectedProviders(snapshot: UsageSnapshot) {
  const providers = snapshot.providers ?? [snapshot.provider]
  return snapshot.credentials.filter((credential) => providers.includes(credential.provider))
}

function SidebarUsage(props: { context: Plugin.Context; store: UsageStore }) {
  const [width, setWidth] = createSignal(37)
  onCleanup(props.store.view())
  const snapshot = () => props.store.reading()?.snapshot
  const credentials = () => (snapshot() ? selectedProviders(snapshot()!) : [])
  return (
    <Show when={credentials().length}>
      <box
        flexShrink={0}
        onSizeChange={function () {
          setWidth(this.width)
        }}
      >
        <text fg={props.context.theme.text.base} onMouseUp={() => props.context.keymap.dispatch("plus.usage.open")}>
          <b>Usage</b>
        </text>
        <Index each={credentials()}>
          {(credential) => (
            <CredentialView
              context={props.context}
              store={props.store}
              snapshot={snapshot()!}
              credential={credential()}
              width={width()}
            />
          )}
        </Index>
      </box>
    </Show>
  )
}

function UsageDialog(props: { context: Plugin.Context; store: UsageStore; all: boolean }) {
  props.context.ui.dialog.set({ size: "large", centered: true })
  props.store.setScope(props.all ? "all" : "model")
  onCleanup(props.store.view())
  onCleanup(() => {
    props.store.setScope("model")
    props.store.setDetails(false)
  })
  const dimensions = useTerminalDimensions()
  const [width, setWidth] = createSignal(70)
  const [page, setPage] = createSignal(0)
  const snapshot = () => props.store.reading()?.snapshot
  // Page cards to fit the terminal; unusually large credentials continue on the next page.
  const pages = createMemo(() => {
    const budget = Math.max(3, dimensions().height - 10)
    return (snapshot()?.credentials ?? [])
      .flatMap((credential) => {
        const windows = credentialWindows(credential)
        const header = 2 + (props.store.details() ? 1 + Number(credential.shared_with.length > 0) : 0)
        const count = Math.max(1, Math.floor((budget - header) / (props.store.details() ? 2 : 1)))
        return Array.from({ length: Math.max(1, Math.ceil(windows.length / count)) }, (_, index) => ({
          ...credential,
          windows: windows.slice(index * count, (index + 1) * count),
        }))
      })
      .reduce<{ rows: Credential[]; height: number }[]>((pages, credential) => {
        const height =
          2 +
          (props.store.details() ? 1 + Number(credential.shared_with.length > 0) : 0) +
          credential.windows.length * (props.store.details() ? 2 : 1)
        const last = pages.at(-1)
        if (last && last.height + height <= budget) {
          last.rows.push(credential)
          last.height += height
          return pages
        }
        pages.push({ rows: [credential], height })
        return pages
      }, [])
  })
  const current = () => Math.min(page(), Math.max(0, pages().length - 1))
  const move = (delta: number) => setPage(Math.max(0, Math.min(pages().length - 1, current() + delta)))
  const scope = () => {
    props.store.setScope(props.store.scope() === "all" ? "model" : "all")
    setPage(0)
  }
  props.context.keymap.layer(() => ({
    mode: "modal",
    commands: [
      { id: "plus.usage.close", bind: "escape", run: () => props.context.ui.dialog.clear() },
      { id: "plus.usage.previous", bind: "left", run: () => move(-1) },
      { id: "plus.usage.next", bind: "right", run: () => move(1) },
      { id: "plus.usage.scope", bind: "a", run: scope },
      {
        id: "plus.usage.details",
        bind: "d",
        run: () => {
          props.store.setDetails(!props.store.details())
          setPage(0)
        },
      },
    ],
  }))
  const theme = props.context.theme
  return (
    <box
      paddingLeft={2}
      paddingRight={2}
      paddingBottom={1}
      gap={1}
      onSizeChange={function () {
        setWidth(Math.max(20, this.width - 4))
      }}
    >
      <box flexDirection="row">
        <text fg={theme.text.base}>
          <b>Credential usage</b>
        </text>
        <box flexGrow={1} />
        <text fg={theme.text.action.secondary.base} onMouseUp={() => props.context.ui.dialog.clear()}>
          esc
        </text>
      </box>
      <text fg={theme.text.muted}>
        {props.store.scope() === "all" || snapshot()?.all ? "All credentials" : "Selected model’s providers"}
        {props.store.reading()?.failure ? " · retrying" : ""}
      </text>
      <Show
        when={pages().length}
        fallback={
          <text fg={theme.text.muted}>
            {props.store.reading()?.result?.message ??
              (snapshot() ? "No credential quotas available." : "Loading credential quotas…")}
          </text>
        }
      >
        <Index each={pages()[current()]?.rows ?? []}>
          {(credential) => (
            <CredentialView
              context={props.context}
              store={props.store}
              snapshot={snapshot()!}
              credential={credential()}
              width={width()}
              details={props.store.details()}
            />
          )}
        </Index>
      </Show>
      <box flexDirection="row" gap={2}>
        <text fg={theme.text.action.secondary.base} onMouseUp={scope}>
          a {props.store.scope() === "all" ? "model" : "all"}
        </text>
        <text
          fg={theme.text.action.secondary.base}
          onMouseUp={() => {
            props.store.setDetails(!props.store.details())
            setPage(0)
          }}
        >
          d details
        </text>
        <box flexGrow={1} />
        <Show when={pages().length > 1}>
          <text fg={theme.text.action.secondary.base} onMouseUp={() => move(-1)}>
            ←
          </text>
          <text fg={theme.text.muted}>
            {current() + 1}/{pages().length}
          </text>
          <text fg={theme.text.action.secondary.base} onMouseUp={() => move(1)}>
            →
          </text>
        </Show>
      </box>
    </box>
  )
}

function CredentialView(props: {
  context: Plugin.Context
  store: UsageStore
  snapshot: UsageSnapshot
  credential: Credential
  width: number
  details?: boolean
}) {
  const theme = props.context.theme
  const windows = createMemo(() => credentialWindows(props.credential))
  const labelWidth = () => Math.min(18, Math.max(2, ...windows().map((window) => label(window).length)))
  const identity = () => {
    const session = props.store.input()?.sessionID
    if (
      session &&
      props.context.data.session.status(session) === "running" &&
      props.snapshot.active.includes(props.credential.id)
    )
      return "IN USE"
    if (props.snapshot.current === props.credential.id) return "LAST USED"
  }
  // Pacer's preview: FORCE USE where a forced move will send the chat, else NEXT USE where it goes once
  // its cache is cold: another account (auth), or its own when Pacer keeps it there (cold_stay, no auth).
  const next = () => {
    const value = props.snapshot.next_use
    if (
      !value ||
      value.expires_ms <= props.store.now() * 1000 ||
      value.model !== props.snapshot.model ||
      value.provider !== props.credential.provider
    )
      return
    const own = props.credential.id === props.snapshot.current
    if (!own && value.force_auth === props.credential.id) return { label: "FORCE USE", mode: value.mode }
    if (!own && value.auth === props.credential.id) return { label: "NEXT USE", mode: value.mode }
    if (own && !value.auth && value.reason === "cold_stay") return { label: "NEXT USE", mode: value.mode }
  }
  return (
    <box flexShrink={0}>
      <box flexDirection="row">
        <text fg={theme.text.base} wrapMode="none" truncate flexShrink={1}>
          <b>{props.credential.alias}</b>
          <span style={{ fg: theme.text.muted }}> · {props.credential.provider}</span>
        </text>
        <Show when={identity()}>
          <text
            flexShrink={0}
            fg={identity() === "IN USE" ? theme.text.feedback.success.base : theme.text.feedback.info.base}
          >
            {" "}
            · {identity()}
          </text>
        </Show>
        <Show when={next()}>
          <text
            flexShrink={0}
            fg={next()?.label === "FORCE USE" ? theme.text.feedback.warning.base : theme.text.feedback.info.base}
          >
            {" "}
            · {next()?.label}
            {next()?.mode === "dry-run" ? " · dry-run" : ""}
          </text>
        </Show>
      </box>
      <Show when={props.details}>
        <text fg={theme.text.muted} wrapMode="none" truncate>
          {props.credential.id}
        </text>
        <Show when={props.credential.shared_with.length}>
          <text fg={theme.text.muted} wrapMode="none" truncate>
            Shared quota: {props.credential.shared_with.join(", ")}
          </text>
        </Show>
      </Show>
      <Show when={windows().length} fallback={<text fg={theme.text.muted}>No quota reading yet.</text>}>
        <Index each={windows()}>
          {(window) => {
            const state = () => windowState(window(), props.snapshot, props.store.now())
            const cells = () => barCells(window().remaining, Math.max(4, props.width - labelWidth() - 15))
            const color = () =>
              state() === "critical"
                ? theme.text.feedback.error.base
                : state() === "low"
                  ? theme.text.feedback.warning.base
                  : state() === "normal"
                    ? theme.text.feedback.success.base
                    : theme.text.muted
            return (
              <box flexShrink={0}>
                <text wrapMode="none" truncate>
                  <span style={{ fg: theme.text.muted }}>
                    {label(window()).slice(0, labelWidth()).padEnd(labelWidth())}{" "}
                  </span>
                  <span style={{ fg: color() }}>{cells().filled}</span>
                  <span style={{ fg: theme.text.muted }}>{cells().empty}</span>
                  <span style={{ fg: theme.text.base }}> {percentLabel(window().remaining).padStart(4)}</span>
                  <span style={{ fg: theme.text.muted }}>
                    {" "}
                    {windowTail(window(), state(), props.store.now()).padStart(7)}
                  </span>
                </text>
                <Show when={props.details}>
                  <text fg={theme.text.muted} wrapMode="none" truncate>
                    {windowDetail(window(), state(), props.store.now())}
                  </text>
                </Show>
              </box>
            )
          }}
        </Index>
      </Show>
    </box>
  )
}

function credentialWindows(credential: Credential) {
  const windows = credential.windows.filter((window) => !window.not_applicable)
  if (credential.provider !== "antigravity") return windows
  return windows.sort((left, right) => left.scope.localeCompare(right.scope) || left.seconds - right.seconds)
}

function label(window: UsageWindow) {
  return `${windowShort(window)}${window.scope === "all" ? "" : ` ${window.scope}`}`
}
