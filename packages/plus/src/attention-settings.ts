import path from "node:path"
import type { AttentionKind, AttentionSettings, AttentionSettingsInput } from "./rpc.js"

// The settings of the notification events (docs/plans/plus-1.3.18-notifications.md): pure, shared
// by the server, the TUI and `opencodeplus notify`.

export const ATTENTION_KINDS: readonly AttentionKind[] = ["done", "reply", "child", "question", "error", "cacheMiss"]

/** The sounds that ship with OpenCodePlus: @opencode/ui/audio/<id>.mp3 (tui attention-sounds). */
export const BUILT_IN_SOUNDS = [
  "alert-01", "alert-02", "alert-03", "alert-04", "alert-05", "alert-06", "alert-07", "alert-08", "alert-09", "alert-10",
  "bip-bop-01", "bip-bop-02", "bip-bop-03", "bip-bop-04", "bip-bop-05", "bip-bop-06", "bip-bop-07", "bip-bop-08", "bip-bop-09", "bip-bop-10",
  "nope-01", "nope-02", "nope-03", "nope-04", "nope-05", "nope-06", "nope-07", "nope-08", "nope-09", "nope-10", "nope-11", "nope-12",
  "staplebops-01", "staplebops-02", "staplebops-03", "staplebops-04", "staplebops-05", "staplebops-06", "staplebops-07",
  "yup-01", "yup-02", "yup-03", "yup-04", "yup-05", "yup-06",
] as const
export type BuiltInSound = (typeof BUILT_IN_SOUNDS)[number]

export const MAX_CHILD_DEPTH = 9

export const DEFAULT_ATTENTION: AttentionSettings = {
  done: { notify: true, sound: "bip-bop-01" },
  reply: { notify: false, sound: "off" },
  child: { notify: false, sound: "off", depth: 1 },
  question: { notify: true, sound: "bip-bop-03" },
  error: { notify: true, sound: "nope-03" },
  cacheMiss: { notify: false, sound: "off" },
}

/** The events' names in the words /settings and Instructions show. */
export const ATTENTION_LABELS: Readonly<Record<AttentionKind, string>> = {
  done: "Done",
  reply: "Reply",
  child: "Subagent or team member done",
  question: "Question",
  error: "Error",
  cacheMiss: "Cache miss",
}

export function isBuiltInSound(value: string): value is BuiltInSound {
  return (BUILT_IN_SOUNDS as readonly string[]).includes(value)
}

/** Why a sound value is refused: "off", a built-in sound id, or an absolute path to a sound file. */
export function soundError(value: string): string | undefined {
  if (value === "off" || isBuiltInSound(value)) return undefined
  if (path.isAbsolute(value)) return undefined
  return `Sound must be off, a built-in sound (${BUILT_IN_SOUNDS[0]} … ${BUILT_IN_SOUNDS.at(-1)}) or an absolute file path`
}

export function depthError(value: number): string | undefined {
  if (Number.isInteger(value) && value >= 1 && value <= MAX_CHILD_DEPTH) return undefined
  return `Depth must be a whole number from 1 to ${MAX_CHILD_DEPTH}`
}

/** A stored value, with anything unreadable falling back to the default field by field. */
export function attentionOf(value: unknown): AttentionSettings {
  const record = typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {}
  const event = <K extends AttentionKind>(kind: K) => {
    const raw = typeof record[kind] === "object" && record[kind] !== null ? (record[kind] as Record<string, unknown>) : {}
    const fallback = DEFAULT_ATTENTION[kind]
    return {
      notify: typeof raw.notify === "boolean" ? raw.notify : fallback.notify,
      sound: typeof raw.sound === "string" && soundError(raw.sound) === undefined ? raw.sound : fallback.sound,
    }
  }
  const child = typeof record.child === "object" && record.child !== null ? (record.child as Record<string, unknown>) : {}
  return {
    done: event("done"),
    reply: event("reply"),
    child: {
      ...event("child"),
      depth: typeof child.depth === "number" && depthError(child.depth) === undefined ? child.depth : DEFAULT_ATTENTION.child.depth,
    },
    question: event("question"),
    error: event("error"),
    cacheMiss: event("cacheMiss"),
  }
}

// Instructions › an agent › Settings › Notifications: one text row per field, empty (the
// upstream value) meaning "as in Settings". Notify rows hold on/off, sound rows a sound value,
// the depth row 1–9.
export const ATTENTION_ROWS = [
  "setting:attention.done.notify", "setting:attention.done.sound",
  "setting:attention.reply.notify", "setting:attention.reply.sound",
  "setting:attention.child.notify", "setting:attention.child.sound", "setting:attention.child.depth",
  "setting:attention.question.notify", "setting:attention.question.sound",
  "setting:attention.error.notify", "setting:attention.error.sound",
  "setting:attention.cacheMiss.notify", "setting:attention.cacheMiss.sound",
] as const
export type AttentionRow = (typeof ATTENTION_ROWS)[number]

export function isAttentionRow(id: string): id is AttentionRow {
  return (ATTENTION_ROWS as readonly string[]).includes(id)
}

function rowParts(id: AttentionRow) {
  const [kind, field] = id.slice("setting:attention.".length).split(".") as [AttentionKind, "notify" | "sound" | "depth"]
  return { kind, field }
}

export function attentionRowTitle(id: AttentionRow): string {
  const parts = rowParts(id)
  if (parts.field === "depth") return `${ATTENTION_LABELS.child}: levels`
  return `${ATTENTION_LABELS[parts.kind]}: ${parts.field === "notify" ? "notification" : "sound"}`
}

export function attentionRowChoices(id: AttentionRow): readonly string[] | undefined {
  const field = rowParts(id).field
  if (field === "notify") return ["on", "off"]
  if (field === "depth") return Array.from({ length: MAX_CHILD_DEPTH }, (_, index) => String(index + 1))
  return undefined
}

export function attentionRowError(id: AttentionRow, text: string): string | undefined {
  if (text === "") return undefined
  const field = rowParts(id).field
  if (field === "notify") return text === "on" || text === "off" ? undefined : "Notification must be on, off or empty (as in Settings)"
  if (field === "depth") return depthError(Number(text)) === undefined && /^\d$/.test(text) ? undefined : `${depthError(0)}, or empty (as in Settings)`
  return soundError(text)
}

/** The global settings with an agent's rows (resolved down its chain) laid over them. */
export function agentAttention(global: AttentionSettings, rows: Readonly<Partial<Record<AttentionRow, string>>>): AttentionSettings {
  const input: Record<string, Record<string, unknown>> = {}
  for (const id of ATTENTION_ROWS) {
    const text = rows[id]
    if (text === undefined || text === "" || attentionRowError(id, text) !== undefined) continue
    const parts = rowParts(id)
    input[parts.kind] = {
      ...input[parts.kind],
      [parts.field]: parts.field === "notify" ? text === "on" : parts.field === "depth" ? Number(text) : text,
    }
  }
  const merged = mergeAttention(global, input as AttentionSettingsInput)
  return "settings" in merged ? merged.settings : global
}

/** Whether an event does anything: a notification or a sound. */
export function attentionOn(settings: { readonly notify: boolean; readonly sound: string }): boolean {
  return settings.notify || settings.sound !== "off"
}

/** Apply a partial change; the first refused value is the error. */
export function mergeAttention(
  current: AttentionSettings,
  input: AttentionSettingsInput,
): { readonly settings: AttentionSettings } | { readonly error: string } {
  for (const kind of ATTENTION_KINDS) {
    const sound = input[kind]?.sound
    if (sound !== undefined && soundError(sound) !== undefined) return { error: `${ATTENTION_LABELS[kind]}: ${soundError(sound)}` }
  }
  if (input.child?.depth !== undefined && depthError(input.child.depth) !== undefined)
    return { error: `${ATTENTION_LABELS.child}: ${depthError(input.child.depth)}` }
  const merged = Object.fromEntries(
    ATTENTION_KINDS.map((kind) => [kind, { ...current[kind], ...Object.fromEntries(Object.entries(input[kind] ?? {}).filter((entry) => entry[1] !== undefined)) }]),
  )
  return { settings: attentionOf(merged) }
}
