import type { Plugin } from "@opencode/plugin/tui"
import type { PromptSendInput } from "@opencode/plugin/tui/context"
import { createEffect, createSignal, Show } from "solid-js"
import { Definition, type Plus } from "../rpc.js"

// Cache warming in the TUI: a countdown under the prompt to when warming stops
// for this chat, a per-chat on/off switch (<leader>k), and a confirmation
// before a message goes into a cold cache.

/** How long a held send waits for the confirming second submit, as interrupting a running chat does. */
export const CONFIRM_MS = 5000

/** 1:05:09, 23:41, 0:07. */
export function formatRemaining(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000))
  const hours = Math.floor(seconds / 3600)
  const minutes = Math.floor((seconds % 3600) / 60)
  const rest = String(seconds % 60).padStart(2, "0")
  if (hours > 0) return `${hours}:${String(minutes).padStart(2, "0")}:${rest}`
  return `${minutes}:${rest}`
}

/**
 * The footer for a status at local time `now` (already corrected for server
 * clock skew); undefined shows nothing. Once a window has run out the footer
 * stays and warns that the cache is cold, until the next reply opens a new one.
 */
export function warmingLabel(
  status: Plus.WarmingStatus | undefined,
  now: number,
): { text: string; tone: "muted" | "warning" } | undefined {
  if (status === undefined) return undefined
  if (status.chat === "off") return { text: "cache warming off", tone: "muted" }
  if (status.active && status.expires !== undefined && status.expires > now)
    return { text: `cache warm · ${formatRemaining(status.expires - now)} left`, tone: "muted" }
  if (status.expires !== undefined)
    return {
      text: status.chat === "on" ? "cache cold · warming starts after the next reply" : "cache cold",
      tone: "warning",
    }
  if (status.chat === "on") return { text: "cache warming on · starts after the next reply", tone: "muted" }
  return undefined
}

/** The footer while a send into a cold cache waits for its confirming submit. */
export function confirmText(key: string): string {
  return `cache cold · ${key} again to send`
}

/** What the switch turns the chat to: off while warming runs or is switched on, else on. */
export function nextChatSwitch(status: Plus.WarmingStatus | undefined, now: number): "on" | "off" {
  if (status === undefined) return "on"
  if (status.chat === "on") return "off"
  if (status.chat === "off") return "on"
  return status.active && status.expires !== undefined && status.expires > now ? "off" : "on"
}

export function createWarming(context: Plugin.Context) {
  const plus = context.client.rpc(Definition)
  const [status, setStatus] = createSignal<Plus.WarmingStatus | undefined>()
  const [now, setNow] = createSignal(Date.now())
  const tracked = { sessionID: undefined as string | undefined, skew: 0 }

  const load = async (sessionID: string) => {
    const next = await plus["warming.status"]({ sessionID }).catch(() => undefined)
    if (next === undefined || tracked.sessionID !== sessionID) return
    tracked.skew = next.now - Date.now()
    setStatus(next)
  }
  const track = (sessionID: string | undefined) => {
    if (tracked.sessionID === sessionID) return
    tracked.sessionID = sessionID
    setStatus(undefined)
    if (sessionID !== undefined) void load(sessionID)
  }
  const disposeEvents = plus.events.on("warming.changed", (event) => {
    if (event.data.sessionID === tracked.sessionID) void load(event.data.sessionID)
  })
  // One clock for the countdown; a slow poll catches windows another
  // directory's Plus instance decided (its events do not reach this client).
  const tick = setInterval(() => {
    setNow(Date.now())
    const sessionID = tracked.sessionID
    if (sessionID !== undefined && Math.floor(Date.now() / 1000) % 15 === 0) void load(sessionID)
  }, 1000)

  const label = () => warmingLabel(status(), now() + tracked.skew)

  // A message into a cold cache pays for the whole prompt again. The first
  // submit holds it and the footer asks for a second, like interrupting a
  // running chat; a second submit within CONFIRM_MS sends. A running chat is
  // using its cache, and a chat that never warmed shows nothing to confirm.
  const [armed, setArmed] = createSignal<string | undefined>()
  const [flash, setFlash] = createSignal(false)
  const timers = { disarm: undefined as ReturnType<typeof setTimeout> | undefined, flash: undefined as ReturnType<typeof setTimeout> | undefined }
  function guard(input: PromptSendInput): boolean {
    const sessionID = input.sessionID
    if (sessionID === undefined || input.mode !== "normal" || sessionID !== tracked.sessionID) return true
    if (label()?.tone !== "warning" || context.data.session.status(sessionID) === "running") return true
    clearTimeout(timers.disarm)
    clearTimeout(timers.flash)
    if (armed() === sessionID) {
      setArmed(undefined)
      setFlash(false)
      return true
    }
    setArmed(sessionID)
    setFlash(true)
    timers.flash = setTimeout(() => setFlash(false), 220)
    timers.disarm = setTimeout(() => setArmed(undefined), CONFIRM_MS)
    return false
  }
  const disposeGuard = context.ui.prompt.guard(guard)

  async function toggle(): Promise<void> {
    const route = context.ui.router.current()
    if (route.type !== "session") {
      context.ui.toast.show({ variant: "warning", message: "Open a chat to switch its cache warming" })
      return
    }
    const sessionID = route.sessionID
    const current = tracked.sessionID === sessionID ? status() : await plus["warming.status"]({ sessionID }).catch(() => undefined)
    const chat = nextChatSwitch(current, Date.now() + tracked.skew)
    const next = await plus["warming.set"]({ sessionID, chat }).catch((error: unknown) => {
      context.ui.toast.show({ variant: "error", message: error instanceof Error ? error.message : String(error) })
      return undefined
    })
    if (next === undefined) return
    if (tracked.sessionID === sessionID) setStatus(next)
    context.ui.toast.show({
      variant: "info",
      message:
        chat === "off"
          ? "Cache warming off for this chat"
          : next.active
            ? "Cache warming on for this chat"
            : "Cache warming on for this chat; it starts after the next reply",
    })
  }

  async function follow(): Promise<void> {
    const route = context.ui.router.current()
    if (route.type !== "session") return
    const next = await plus["warming.set"]({ sessionID: route.sessionID, chat: "default" }).catch(() => undefined)
    if (next !== undefined && tracked.sessionID === route.sessionID) setStatus(next)
    context.ui.toast.show({ variant: "info", message: "Cache warming for this chat follows the model settings" })
  }

  // The footer follows the prompt it sits under. A remount (dialogs, route
  // changes) may mount the new prompt before the old one cleans up, so the
  // last session stays tracked instead of being dropped on cleanup.
  function Footer(props: { readonly sessionID?: string }) {
    createEffect(() => track(props.sessionID))
    const warning = () => context.theme.text.feedback.warning.base
    const confirming = () => props.sessionID !== undefined && armed() === props.sessionID && label()?.tone === "warning"
    const key = () => context.keymap.shortcuts("prompt.submit")[0] ?? "enter"
    return (
      <Show when={props.sessionID !== undefined ? label() : undefined}>
        {(footer) => (
          <Show
            when={confirming()}
            fallback={
              <text fg={footer().tone === "warning" ? warning() : context.theme.text.muted} wrapMode="none" flexShrink={0}>
                {footer().text}
              </text>
            }
          >
            <text fg={flash() ? context.theme.decrease(warning(), 2) : warning()} wrapMode="none" flexShrink={0}>
              {confirmText(key())}
            </text>
          </Show>
        )}
      </Show>
    )
  }

  return {
    toggle,
    follow,
    Footer,
    dispose() {
      clearInterval(tick)
      clearTimeout(timers.disarm)
      clearTimeout(timers.flash)
      disposeEvents()
      disposeGuard()
    },
  }
}
