import type { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { ATTENTION_KINDS, ATTENTION_LABELS, BUILT_IN_SOUNDS, isBuiltInSound, MAX_CHILD_DEPTH, soundError } from "../attention-settings.js"
import { Definition, type Plus } from "../rpc.js"

// Notifications and sounds in the TUI (docs/plans/plus-1.3.18-notifications.md): the server
// decides each event; this TUI shows the ones of the chats it has open, as Alerts allows, and
// leaves the sound to a connected sound player (`opencodeplus notify`). Settings › Notifications
// edits the global settings.

const SETTINGS_MS = 30_000
// A chat's ancestry stops here, so a parent loop cannot hang the check.
const MAX_DEPTH = 16
const FILE_CHOICE = "\u0000file"

export function createAttention(context: Plugin.Context) {
  const plus = context.client.rpc(Definition)
  const [settings, setSettings] = createSignal<Plus.AttentionSettings>()
  const read = () => plus["settings.get"](undefined).then((next) => setSettings(next.attention), () => undefined)
  void read()
  const timer = setInterval(() => void read(), SETTINGS_MS)

  // The chat open here, the tabs, and the chats above them: an event of any of their trees.
  const openChats = () => {
    const route = context.ui.router.current()
    const roots = [...(route.type === "session" ? [route.sessionID] : []), ...(context.ui.tabs.enabled() ? context.ui.tabs.list().map((tab) => tab.sessionID) : [])]
    return new Set(
      roots.flatMap((id) => {
        const chain = [id]
        for (let parent = context.data.session.get(id)?.parentID; parent !== undefined && chain.length <= MAX_DEPTH && !chain.includes(parent); parent = context.data.session.get(parent)?.parentID)
          chain.push(parent)
        return chain
      }),
    )
  }
  const show = (attention: Plus.Attention, when: "blurred" | "always") =>
    context.attention.notify({
      title: attention.title,
      message: attention.message,
      notification: attention.notify ? { when } : false,
      sound: attention.sound === undefined || attention.player ? false : { file: attention.sound, when: "always" },
    })
  const disposeEvents = plus.events.on("attention", (event) => {
    const attention = event.data
    // A test is shown by the TUI that asked for it (and played by any sound player).
    if (attention.test === true) return
    const open = openChats()
    if (!open.has(attention.rootID) && !open.has(attention.sessionID)) return
    void show(attention, "blurred")
  })

  const fail = (error: unknown) => {
    context.ui.toast.show({ variant: "error", message: error instanceof Error ? error.message : String((error as { message?: unknown })?.message ?? error) })
    return undefined
  }
  const update = async (patch: Plus.AttentionSettingsInput) => {
    const next = await plus["settings.set"]({ attention: patch }).catch(fail)
    if (next !== undefined) setSettings(next.attention)
  }
  const preview = (sound: string) => {
    if (sound === "off" || sound === FILE_CHOICE) return
    void context.attention.notify({ message: sound, notification: false, sound: { file: sound, when: "always" } })
  }
  const pickSound = async (kind: Plus.AttentionKind) => {
    const current = settings()?.[kind].sound
    const file = current !== undefined && current !== "off" && !isBuiltInSound(current) ? current : undefined
    const picked = await context.ui.dialog.select<string>({
      title: `${ATTENTION_LABELS[kind]}: sound`,
      ...(current === undefined ? {} : { current: file === undefined ? current : FILE_CHOICE }),
      options: [
        { title: "Off", value: "off" },
        ...BUILT_IN_SOUNDS.map((id) => ({ title: id, value: id, category: id.replace(/-\d+$/, "") })),
        { title: file === undefined ? "A sound file on the server…" : `File: ${context.ui.format.path(file)}`, value: FILE_CHOICE, category: "file" },
      ],
      actions: [{ bind: "ctrl+p", title: "play", onTrigger: preview }],
    })
    context.ui.dialog.clear()
    if (picked === undefined) return
    if (picked !== FILE_CHOICE) return update({ [kind]: { sound: picked } })
    const path = await context.ui.dialog.prompt({
      title: `${ATTENTION_LABELS[kind]}: sound file`,
      description: "An absolute path to an .mp3, .wav, .ogg or .flac file on the server",
      ...(file === undefined ? {} : { value: file }),
    })
    context.ui.dialog.clear()
    if (path === undefined || path.trim() === "") return
    const error = soundError(path.trim())
    if (error !== undefined) return void fail(new Error(error))
    return update({ [kind]: { sound: path.trim() } })
  }
  const pickDepth = async () => {
    const picked = await context.ui.dialog.select<number>({
      title: `${ATTENTION_LABELS.child}: levels below the chat`,
      ...(settings() === undefined ? {} : { current: settings()!.child.depth }),
      options: Array.from({ length: MAX_CHILD_DEPTH }, (_, index) => ({
        title: index === 0 ? "1: the chat's own subagents and team members" : `${index + 1} levels`,
        value: index + 1,
      })),
    })
    context.ui.dialog.clear()
    if (picked !== undefined) await update({ child: { depth: picked } })
  }
  const test = async () => {
    const kind = await context.ui.dialog.select<Plus.AttentionKind>({
      title: "Test a notification",
      options: ATTENTION_KINDS.map((value) => ({ title: ATTENTION_LABELS[value], value })),
    })
    context.ui.dialog.clear()
    if (kind === undefined) return
    const attention = await plus["attention.test"]({ kind }).catch(fail)
    if (attention === undefined) return
    if (!attention.notify && attention.sound === undefined) return void context.ui.toast.show({ message: `${ATTENTION_LABELS[kind]}: notification and sound are both off` })
    if (attention.player && attention.sound !== undefined) context.ui.toast.show({ message: "The sound plays on the connected sound player" })
    await show(attention, "always")
  }

  const disposeSettings = [
    ...ATTENTION_KINDS.flatMap((kind) => [
      context.ui.settings.register({
        id: `plus.attention.${kind}.notify`,
        title: `${ATTENTION_LABELS[kind]}: notification`,
        category: "Notifications",
        keywords: ["attention", "desktop notifications", "alerts", kind],
        value: () => {
          const current = settings()?.[kind]
          return current === undefined ? undefined : current.notify ? "on" : "off"
        },
        run: async () => {
          const current = settings()?.[kind]
          if (current !== undefined) await update({ [kind]: { notify: !current.notify } })
        },
      }),
      context.ui.settings.register({
        id: `plus.attention.${kind}.sound`,
        title: `${ATTENTION_LABELS[kind]}: sound`,
        category: "Notifications",
        keywords: ["attention", "sounds", "audio", "alerts", kind],
        value: () => {
          const sound = settings()?.[kind].sound
          return sound === undefined || isBuiltInSound(sound) || sound === "off" ? sound : context.ui.format.path(sound)
        },
        run: () => pickSound(kind),
      }),
    ]),
    context.ui.settings.register({
      id: "plus.attention.child.depth",
      title: `${ATTENTION_LABELS.child}: levels`,
      category: "Notifications",
      keywords: ["attention", "subagents", "team members", "depth"],
      value: () => (settings() === undefined ? undefined : String(settings()!.child.depth)),
      run: pickDepth,
    }),
    context.ui.settings.register({
      id: "plus.attention.test",
      title: "Test a notification",
      category: "Notifications",
      keywords: ["attention", "sounds", "sound player", "notify"],
      run: test,
    }),
  ]

  return {
    dispose() {
      clearInterval(timer)
      disposeEvents()
      disposeSettings.forEach((dispose) => dispose())
    },
  }
}
