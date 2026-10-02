import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, onCleanup, Show } from "solid-js"
import { UsageDefinition, type UsageInput, type UsageResult, type UsageSnapshot, type UsageWindow } from "./usage.js"

export function usageArguments(input = "") {
  const value = input.trim()
  if (value === "") return false
  if (value === "--all") return true
  return undefined
}

export function windowLabel(window: UsageWindow) {
  const duration = window.seconds === 18000 ? "5 hours" : window.seconds === 604800 ? "7 days" : `${window.seconds}s`
  return window.scope === "all" ? duration : `${duration} · ${window.scope}`
}

export function usageBar(window: UsageWindow, width: number) {
  if (window.not_applicable) return "Not applicable"
  const remaining = Math.max(0, Math.min(100, window.remaining))
  const count = Math.round((remaining / 100) * width)
  return `${"█".repeat(count)}${"░".repeat(width - count)} ${Number(remaining.toFixed(1))}% remaining`
}

export function staleWindow(window: UsageWindow, snapshot: UsageSnapshot, now: number) {
  return (
    now - window.observed > snapshot.max_age_seconds ||
    (!window.dormant && !window.not_applicable && window.reset <= now)
  )
}

export function resetLabel(window: UsageWindow, now: number) {
  if (window.not_applicable) return "No limit for this window"
  if (window.dormant) return "Window has not started"
  if (window.reset <= now) return "Reset time passed; awaiting a fresh reading"
  const minutes = Math.ceil((window.reset - now) / 60)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const rest = minutes % 60
  const relative = [days ? `${days}d` : "", hours ? `${hours}h` : "", rest ? `${rest}m` : ""].filter(Boolean).join(" ")
  return `Resets in ${relative} · ${new Date(window.reset * 1000).toLocaleString()}`
}

export function UsageView(props: { context: Plugin.Context; input: UsageInput }) {
  const dimensions = useTerminalDimensions()
  const rpc = props.context.client.rpc(UsageDefinition)
  const [all, setAll] = createSignal(props.input.all)
  const [result, setResult] = createSignal<UsageResult>()
  const [loading, setLoading] = createSignal(false)
  const [clock, setClock] = createSignal(Date.now())
  const state = { request: 0, closed: false, received: 0 }
  const load = async () => {
    const request = ++state.request
    setLoading(true)
    const next = await rpc.read({ ...props.input, all: all() }).catch(
      (): UsageResult => ({
        status: "unavailable",
        message: "Credential usage could not be retrieved. Press r to retry.",
      }),
    )
    if (state.closed || request !== state.request) return
    state.received = Date.now()
    setClock(state.received)
    setResult(next)
    setLoading(false)
  }
  void load()
  const tick = setInterval(() => {
    setClock(Date.now())
    if (!loading()) void load()
  }, 5000)
  onCleanup(() => {
    state.closed = true
    state.request++
    clearInterval(tick)
  })
  props.context.keymap.layer(() => ({
    mode: "modal",
    commands: [
      { bind: "r", title: "Refresh usage", run: () => load() },
      {
        bind: "a",
        title: "Toggle all credentials",
        run: () => {
          setAll(!all())
          setResult(undefined)
          return load()
        },
      },
    ],
  }))
  const theme = props.context.theme
  const now = () => (result()?.snapshot?.now ?? 0) + Math.max(0, (clock() - state.received) / 1000)
  const width = () => Math.max(6, Math.min(28, dimensions().width - 30))
  return (
    <box flexDirection="column" paddingLeft={2} paddingRight={2} paddingBottom={1}>
      <text fg={theme.text.base} marginBottom={1}>
        {all() ? "Credential usage · all" : "Credential usage · active model"}
      </text>
      <text fg={theme.text.muted}>
        {props.input.providerID}/{props.input.modelID}
      </text>
      <text fg={theme.text.muted} marginBottom={1}>
        r refresh · a {all() ? "active model" : "all credentials"} · esc close{loading() ? " · refreshing…" : ""}
      </text>
      <Show when={result()} fallback={<text fg={theme.text.muted}>Loading credential quotas…</text>}>
        {(value) => (
          <Show when={value().snapshot} fallback={<text fg={theme.text.feedback.warning.base}>{value().message}</text>}>
            {(snapshot) => (
              <scrollbox focused height={Math.max(4, Math.min(28, dimensions().height - 10))}>
                <text fg={theme.text.muted} marginBottom={1}>
                  {snapshot().active.length
                    ? "IN USE marks this chat’s running model request."
                    : snapshot().current
                      ? "LAST USED marks this chat’s most recent model request; the next request may use another credential."
                      : "No credential has been used for this chat yet."}
                </text>
                <Show when={snapshot().credentials.length} fallback={<text>No credential quotas are available.</text>}>
                  <For each={snapshot().credentials}>
                    {(credential) => (
                      <box flexDirection="column" marginBottom={1}>
                        <text fg={theme.text.base}>
                          {credential.alias} · {credential.provider}
                          {snapshot().active.includes(credential.id)
                            ? "  [IN USE]"
                            : snapshot().current === credential.id
                              ? "  [LAST USED]"
                              : ""}
                        </text>
                        <text fg={theme.text.muted}>Credential: {credential.id}</text>
                        <Show when={credential.shared_with.length}>
                          <text fg={theme.text.muted}>Shares quota with: {credential.shared_with.join(", ")}</text>
                        </Show>
                        <Show
                          when={credential.windows.length}
                          fallback={<text fg={theme.text.muted}>No quota reading available.</text>}
                        >
                          <For each={credential.windows}>
                            {(window) => (
                              <box flexDirection="column">
                                <text fg={theme.text.base}>{windowLabel(window)}</text>
                                <text
                                  fg={
                                    staleWindow(window, snapshot(), now()) || window.not_applicable
                                      ? theme.text.muted
                                      : window.remaining <= 10
                                        ? theme.text.feedback.error.base
                                        : window.remaining <= 20
                                          ? theme.text.feedback.warning.base
                                          : theme.text.feedback.success.base
                                  }
                                >
                                  {usageBar(window, width())}
                                  {staleWindow(window, snapshot(), now()) ? " · STALE" : ""}
                                </text>
                                <text fg={theme.text.muted}>{resetLabel(window, now())}</text>
                              </box>
                            )}
                          </For>
                        </Show>
                      </box>
                    )}
                  </For>
                </Show>
              </scrollbox>
            )}
          </Show>
        )}
      </Show>
    </box>
  )
}

export function createUsage(context: Plugin.Context) {
  return context.ui.slot({
    append: "app",
    render() {
      context.keymap.layer(() => ({
        mode: "global",
        commands: [
          {
            id: "plus.usage.open",
            title: "Credential usage",
            group: "Session",
            palette: true,
            slash: { name: "usage", arguments: true },
            run(input) {
              const all = usageArguments(input)
              if (all === undefined) {
                context.ui.toast.show({ variant: "warning", message: "Usage: /usage [--all]" })
                return
              }
              const model = context.ui.model.current()
              if (!model) {
                context.ui.toast.show({ variant: "warning", message: "Select a model to view credential usage." })
                return
              }
              const route = context.ui.router.current()
              const sessionID = route.type === "session" ? route.sessionID : undefined
              context.ui.dialog.show(() => <UsageView context={context} input={{ ...model, sessionID, all }} />)
              context.ui.dialog.set({ size: "large", centered: true })
            },
          },
        ],
      }))
      return null
    },
  })
}
