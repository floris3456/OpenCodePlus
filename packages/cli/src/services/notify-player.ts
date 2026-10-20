import { Audio, type AudioSound } from "@opentui/core"
import { isBuiltInSound, type BuiltInSound } from "../../../plus/src/attention-settings.js"
import type { Plus } from "../../../plus/src/rpc.js"
import { errorMessage } from "../util/error"

// What `opencodeplus notify` does with one `attention` event (docs/plans/plus-1.3.18-notifications.md):
// play its sound on this machine and, with --desktop, show it as an OS notification.

/** Sounds closer together than this are dropped, so a burst of events plays one sound, not dozens. */
export const SOUND_GAP_MS = 300

/** Decodes a sound once per key and plays it; throws an Error that says why it cannot. */
export interface Speaker {
  load(key: string, bytes: Uint8Array): void
  play(key: string, volume: number): void
  dispose(): void
}

export type SoundResult = "none" | "played" | "too-soon" | "failed"
export type DesktopResult = "off" | "shown" | "failed"

export interface Handled {
  readonly sound: SoundResult
  readonly desktop: DesktopResult
  /** Why the sound or the notification failed. */
  readonly reason?: string
}

export interface PlayerDeps {
  readonly speaker: Speaker
  readonly volume: number
  /** Shows a desktop notification; absent when --desktop is off. */
  readonly notify?: (title: string, message: string) => Promise<void>
  readonly builtIn: (sound: BuiltInSound) => Promise<Uint8Array>
  /** Gets each distinct failure once; the next event with that sound tries again quietly. */
  readonly warn: (message: string) => void
  readonly now?: () => number
}

export type Player = ReturnType<typeof createPlayer>

export function createPlayer(deps: PlayerDeps) {
  const gate = createSoundGate(SOUND_GAP_MS, deps.now)
  const loads = new Map<string, Promise<void>>()
  const warned = new Set<string>()
  const warnOnce = (key: string, message: string) => {
    if (warned.has(key)) return
    warned.add(key)
    deps.warn(message)
  }

  // A sound that is not built in is a file on the server, fetched once through the connection.
  // A failed load is forgotten, so a later event fetches it again.
  const load = (sound: string, fetch: (sound: string) => Promise<Uint8Array>) => {
    const known = loads.get(sound)
    if (known) return known
    const task = (isBuiltInSound(sound) ? deps.builtIn(sound) : fetch(sound)).then((bytes) =>
      deps.speaker.load(sound, bytes),
    )
    loads.set(sound, task)
    task.catch(() => loads.delete(sound))
    return task
  }

  const playSound = (
    sound: string | undefined,
    fetch: (sound: string) => Promise<Uint8Array>,
  ): Promise<{ readonly sound: SoundResult; readonly reason?: string }> => {
    if (sound === undefined) return Promise.resolve({ sound: "none" })
    if (!gate.allow()) return Promise.resolve({ sound: "too-soon" })
    return load(sound, fetch)
      .then(() => deps.speaker.play(sound, deps.volume))
      .then(
        () => ({ sound: "played" as const }),
        (error: unknown) => {
          const reason = errorMessage(error)
          warnOnce(`sound\n${sound}\n${reason}`, `Sound ${sound} did not play: ${reason}`)
          return { sound: "failed" as const, reason }
        },
      )
  }

  const show = (attention: Plus.Attention): Promise<{ readonly desktop: DesktopResult; readonly reason?: string }> => {
    if (deps.notify === undefined || !attention.notify) return Promise.resolve({ desktop: "off" })
    return deps.notify(attention.title, attention.message).then(
      () => ({ desktop: "shown" as const }),
      (error: unknown) => {
        const reason = errorMessage(error)
        warnOnce(`desktop\n${reason}`, `Desktop notification failed: ${reason}`)
        return { desktop: "failed" as const, reason }
      },
    )
  }

  return {
    /** `fetch` reads a sound file from the server the event came from (`attention.sound`). */
    async handle(attention: Plus.Attention, fetch: (sound: string) => Promise<Uint8Array>): Promise<Handled> {
      const [sound, desktop] = await Promise.all([playSound(attention.sound, fetch), show(attention)])
      const reason = sound.reason ?? desktop.reason
      return { sound: sound.sound, desktop: desktop.desktop, ...(reason === undefined ? {} : { reason }) }
    },
  }
}

/** True for the first call and then at most once per `gapMs`. */
export function createSoundGate(gapMs = SOUND_GAP_MS, now: () => number = Date.now) {
  const state = { last: Number.NEGATIVE_INFINITY }
  return {
    allow() {
      const at = now()
      if (at - state.last < gapMs) return false
      state.last = at
      return true
    },
  }
}

/** OpenTUI's audio (miniaudio in its native library): no external player and no renderer. */
export function openTuiSpeaker(): Speaker {
  const state = { audio: undefined as Audio | undefined, error: "" }
  const sounds = new Map<string, AudioSound>()
  const audio = () => {
    if (state.audio !== undefined) return state.audio
    const created = Audio.create({ autoStart: false })
    // Audio says why a call returned null or false only through this event.
    created.on("error", (error: Error) => {
      state.error = error.message
    })
    state.audio = created
    return created
  }
  const why = (fallback: string) => (state.error === "" ? fallback : state.error)
  return {
    load(key, bytes) {
      const sound = audio().loadSound(bytes)
      if (sound === null) throw new Error(`the sound could not be decoded (${why("unknown format")})`)
      sounds.set(key, sound)
    },
    play(key, volume) {
      const current = audio()
      // The device opens with the first sound and stays open; after a failure the next sound tries again.
      if (!current.isStarted() && !current.start())
        throw new Error(`no sound device could be opened (${why("no device")})`)
      const sound = sounds.get(key)
      if (sound === undefined) throw new Error("the sound is not loaded")
      if (current.play(sound, { volume }) === null) throw new Error(`the sound could not be played (${why("no voice")})`)
    },
    dispose() {
      state.audio?.dispose()
      state.audio = undefined
      sounds.clear()
    },
  }
}

/**
 * The OS notification command, as argv (never a shell string): osascript on macOS, notify-send
 * elsewhere.
 */
export function desktopCommand(platform: NodeJS.Platform, title: string, message: string): string[] {
  // The title and message reach the script as its arguments, so no text is ever AppleScript code.
  if (platform === "darwin")
    return [
      "osascript",
      "-e",
      "on run argv",
      "-e",
      "display notification (item 2 of argv) with title (item 1 of argv)",
      "-e",
      "end run",
      title,
      message,
    ]
  // Notification servers may read the body as markup (KDE and GNOME do); the title is plain text.
  const body = message.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
  return ["notify-send", "--app-name=OpenCodePlus", "--", title, body]
}

/** A desktop notifier for this machine, or why there is none. */
export function desktopNotifier(platform: NodeJS.Platform = process.platform) {
  if (platform === "win32") return { error: "desktop notifications are not supported on Windows" }
  if (platform !== "darwin" && Bun.which("notify-send") === null) return { error: "notify-send is not on PATH" }
  return {
    notify: async (title: string, message: string) => {
      const command = desktopCommand(platform, title, message)
      const child = Bun.spawn(command, { stdin: "ignore", stdout: "ignore", stderr: "pipe" })
      const [stderr, code] = await Promise.all([new Response(child.stderr).text(), child.exited])
      if (code === 0) return
      const detail = stderr.trim().split("\n").at(-1) ?? ""
      throw new Error(`${command[0]} exited with ${code}${detail === "" ? "" : `: ${detail}`}`)
    },
  }
}
