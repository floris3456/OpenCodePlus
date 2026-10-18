import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal, For, Show } from "solid-js"
import { Definition, type Plus } from "../rpc.js"
import { formatTokens } from "./monitor/format.js"

// Cache notices: every miss or partial reuse on any session of this server,
// stacked in the corner of every open TUI until it is opened or outlives the
// lifetime set in Settings. Opening one shows it in the monitor.

const POLL_MS = 3_000
const SETTINGS_MS = 30_000
const SHOWN = 4
// A dismissal kept by this TUI alone outlives the longest lifetime, then is dropped.
const KEEP_DISMISSED = 86_400_000
const SPLIT = {
  topLeft: "",
  bottomLeft: "",
  vertical: "┃",
  topRight: "",
  bottomRight: "",
  horizontal: " ",
  bottomT: "",
  topT: "",
  cross: "",
  leftT: "",
  rightT: "",
}

type LocalSettings = {
  enabled?: boolean
  from?: "server" | "chat"
  dismissed?: Record<string, number>
}

export function createCacheNotices(context: Plugin.Context, options: { readonly open: (notice: Plus.MonitorNotice) => void }) {
  const plus = context.client.rpc(Definition)
  // The key the earlier on/off switch used, so its choice carries over.
  const [local, saveLocal] = context.storage.store<LocalSettings>("opencode.plus.miss-notices", { initial: { enabled: true } })
  const enabled = () => local.enabled ?? true
  const from = () => local.from ?? "server"
  const [notices, setNotices] = createSignal<readonly Plus.MonitorNotice[]>([])
  const [server, setServer] = createSignal<Plus.PlusSettings>()
  const [now, setNow] = createSignal(Date.now())

  const poll = { busy: false }
  const refresh = () => {
    setNow(Date.now())
    if (poll.busy || !enabled()) return
    poll.busy = true
    void plus["monitor.notices"](undefined)
      .then((answer) => setNotices(answer.notices), () => undefined)
      .finally(() => {
        poll.busy = false
      })
  }
  const readSettings = () => plus["settings.get"](undefined).then(setServer, () => undefined)
  refresh()
  void readSettings()
  const timers = [setInterval(refresh, POLL_MS), setInterval(() => void readSettings(), SETTINGS_MS)]
  const unsubscribe = context.data.on("session.step.ended", refresh)

  const chatRoot = () => {
    const route = context.ui.router.current()
    if (route.type !== "session") return undefined
    const up = (id: string, depth: number): string => {
      const parent = context.data.session.get(id)?.parentID
      return parent === undefined || depth > 16 ? id : up(parent, depth + 1)
    }
    return up(route.sessionID, 0)
  }
  const visible = () => {
    if (!enabled()) return []
    const root = from() === "chat" ? chatRoot() : undefined
    return notices().filter(
      (notice) =>
        local.dismissed?.[notice.requestID] === undefined &&
        (from() === "server" || (root !== undefined && (notice.rootID === root || notice.sessionID === root))),
    )
  }

  const openNotice = (notice: Plus.MonitorNotice) => {
    setNotices((list) => list.filter((entry) => entry.requestID !== notice.requestID))
    options.open(notice)
    if (server()?.noticeDismiss === "this-tui") {
      const at = Date.now()
      void saveLocal((draft) => {
        draft.dismissed = Object.fromEntries([
          ...Object.entries(draft.dismissed ?? {}).filter((entry) => at - entry[1] < KEEP_DISMISSED),
          [notice.requestID, at],
        ])
      })
      return
    }
    void plus["monitor.dismiss"]({ requestID: notice.requestID }).catch((error: unknown) =>
      context.ui.toast.show({ variant: "error", message: error instanceof Error ? error.message : String(error) }),
    )
  }

  const updateServer = async (patch: Plus.PlusSettingsInput) => {
    const next = await plus["settings.set"](patch).catch((error: unknown) => {
      context.ui.toast.show({ variant: "error", message: error instanceof Error ? error.message : String(error) })
      return undefined
    })
    if (next === undefined) return
    setServer(next)
    refresh()
  }
  const choose = async <T extends string | number>(title: string, current: T | undefined, choices: readonly { title: string; value: T }[]) => {
    const picked = await context.ui.dialog.select<T>({
      title,
      ...(current === undefined ? {} : { current }),
      options: choices.map((choice) => ({ title: choice.title, value: choice.value })),
    })
    context.ui.dialog.clear()
    return picked
  }
  const minutes = [15, 30, 60, 120].map((value) => ({ title: `${value} minutes`, value }))
  const minimums = [0, 1_000, 10_000, 50_000, 100_000].map((value) => ({
    title: value === 0 ? "any loss" : `${formatTokens(value)} tokens`,
    value,
  }))
  const kinds = [
    { title: "misses and partial reuse", value: "misses-and-partials" as const },
    { title: "misses only", value: "misses" as const },
  ]
  const dismissals = [
    { title: "in every TUI", value: "everywhere" as const },
    { title: "only in this TUI", value: "this-tui" as const },
  ]
  const sources = [
    { title: "every session on this server", value: "server" as const },
    { title: "this chat and its subagents", value: "chat" as const },
  ]
  const label = <T,>(choices: readonly { title: string; value: T }[], value: T | undefined) =>
    value === undefined ? undefined : choices.find((choice) => choice.value === value)?.title
  const disposeSettings = [
    context.ui.settings.register({
      id: "plus.miss-notices",
      title: "Cache notices",
      category: "OpenCodePlus",
      keywords: ["cache miss", "notices", "partial", "notifications"],
      value: () => (enabled() ? "on" : "off"),
      run: async () => {
        const next = !enabled()
        await saveLocal((draft) => {
          draft.enabled = next
        })
        if (next) refresh()
      },
    }),
    context.ui.settings.register({
      id: "plus.notices.from",
      title: "Cache notices from",
      category: "OpenCodePlus",
      keywords: ["cache miss", "notices", "sessions", "subagents"],
      value: () => label(sources, from()),
      run: async () => {
        const picked = await choose("Show cache notices from", from(), sources)
        if (picked === undefined) return
        await saveLocal((draft) => {
          draft.from = picked
        })
      },
    }),
    context.ui.settings.register({
      id: "plus.notices.minutes",
      title: "Cache notice lifetime",
      category: "OpenCodePlus",
      keywords: ["cache miss", "notices", "persist", "minutes"],
      value: () => label(minutes, server()?.noticeMinutes),
      run: async () => {
        const picked = await choose("Keep a cache notice for", server()?.noticeMinutes, minutes)
        if (picked !== undefined) await updateServer({ noticeMinutes: picked })
      },
    }),
    context.ui.settings.register({
      id: "plus.notices.minimum",
      title: "Cache notice minimum",
      category: "OpenCodePlus",
      keywords: ["cache miss", "notices", "threshold", "tokens"],
      value: () => label(minimums, server()?.noticeMinTokens),
      run: async () => {
        const picked = await choose("Notify when at least this much is not reused", server()?.noticeMinTokens, minimums)
        if (picked !== undefined) await updateServer({ noticeMinTokens: picked })
      },
    }),
    context.ui.settings.register({
      id: "plus.notices.kinds",
      title: "Cache notices for",
      category: "OpenCodePlus",
      keywords: ["cache miss", "notices", "partial"],
      value: () => label(kinds, server()?.noticeKinds),
      run: async () => {
        const picked = await choose("Raise a cache notice for", server()?.noticeKinds, kinds)
        if (picked !== undefined) await updateServer({ noticeKinds: picked })
      },
    }),
    context.ui.settings.register({
      id: "plus.notices.dismiss",
      title: "Opened cache notice disappears",
      category: "OpenCodePlus",
      keywords: ["cache miss", "notices", "dismiss", "every tui"],
      value: () => label(dismissals, server()?.noticeDismiss),
      run: async () => {
        const picked = await choose("An opened cache notice disappears", server()?.noticeDismiss, dismissals)
        if (picked !== undefined) await updateServer({ noticeDismiss: picked })
      },
    }),
  ]

  const disposeSlot = context.ui.slot({
    append: "app",
    render: () => (
      <Show when={visible().length > 0}>
        <NoticeStack context={context} notices={visible} now={now} onOpen={openNotice} />
      </Show>
    ),
  })

  return {
    enabled,
    dispose: () => {
      timers.forEach(clearInterval)
      unsubscribe()
      disposeSettings.forEach((dispose) => dispose())
      disposeSlot()
    },
  }
}

function NoticeStack(props: {
  readonly context: Plugin.Context
  readonly notices: () => readonly Plus.MonitorNotice[]
  readonly now: () => number
  readonly onOpen: (notice: Plus.MonitorNotice) => void
}) {
  const theme = () => props.context.theme
  const dimensions = useTerminalDimensions()
  const width = () => Math.min(64, dimensions().width - 6)
  // Each notice takes four rows; a short terminal shows fewer of them.
  const shown = () => Math.max(1, Math.min(SHOWN, Math.floor((dimensions().height - 8) / 4)))
  const fit = (text: string, room: number) => (text.length <= room ? text : `${text.slice(0, Math.max(0, room - 1))}…`)
  const age = (at: number) => {
    const minutes = Math.floor(Math.max(0, props.now() - at) / 60_000)
    return minutes === 0 ? "just now" : `${minutes} min ago`
  }
  return (
    <box position="absolute" top={1} right={2} width={width()} flexDirection="column">
      <For each={props.notices().slice(0, shown())}>
        {(notice) => (
          <box
            id={`plus-notice-${notice.requestID}`}
            width="100%"
            marginBottom={1}
            border={["left", "right"]}
            customBorderChars={SPLIT}
            borderColor={notice.verdict === "miss" ? theme().text.feedback.error.base : theme().text.feedback.warning.base}
            onMouseUp={() => {
              if (props.context.renderer.getSelection()?.getSelectedText()) return
              props.onOpen(notice)
            }}
          >
            <box width="100%" paddingLeft={1} paddingRight={1} backgroundColor={theme().background.raised.high}>
              <box flexDirection="row" width="100%">
                <text fg={theme().text.base} attributes={TextAttributes.BOLD} wrapMode="none" truncate flexGrow={1}>
                  {`${notice.verdict === "miss" ? "Cache miss" : "Partial cache reuse"} · ${formatTokens(notice.missTokens)} tokens not reused`}
                </text>
                <text fg={theme().text.muted} flexShrink={0} marginLeft={1} wrapMode="none">
                  {age(notice.at)}
                </text>
              </box>
              <text fg={theme().text.base} wrapMode="none">
                {fit([notice.title ?? notice.sessionID, notice.agent, notice.model].filter(Boolean).join(" · "), width() - 4)}
              </text>
              <text fg={theme().text.muted} wrapMode="none">
                {fit(notice.causeText, width() - 4)}
              </text>
            </box>
          </box>
        )}
      </For>
      <Show when={props.notices().length > shown()}>
        <text fg={theme().text.muted} wrapMode="none">
          {`+${props.notices().length - shown()} more cache notices`}
        </text>
      </Show>
    </box>
  )
}
