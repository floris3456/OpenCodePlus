import type { SessionWarming, SessionWarmingSettings } from "@opencode/plugin/effect/session"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Product } from "@opencode/util/product"
import { type Level, type ResolvedModelFields } from "./instructions/model.js"
import {
  effectiveWarming,
  BUILT_IN_BASE,
  BUILT_IN_WARMING,
  type ModelSettingsRecord,
  type SettingFrom,
  type WarmingBase,
} from "./instructions/model-settings.js"

// Cache warming ("pinging"): core sends keep-alive requests after a chat's
// last real request so the provider prompt cache stays warm. Plus decides it
// per chat through the session `warming` hook, field by field:
//
//   per-chat switch (on/off)  >  the agent's model row  >  Defaults › Models
//   (this model, then Every model)  >  the host configuration core proposed
//   (opencode.json)  >  built-in defaults
//
// and remembers each chat's window so the TUI can count down to its end.
//
// Compact before cold is a second per-chat switch, off in every new chat: an
// idle chat compacts right before its prompt cache goes cold, so the summary
// request still reads a warm cache and the next message starts from the small
// compacted context. The cache stays warm until the warming window ends (its
// last keep-alive was at most one interval earlier, and the interval is kept
// under the provider's cache lifetime); without warming, one interval after
// the last request.

/** Core's defaults (core/src/config/warming.ts), used when the host configuration leaves warming off. */
export const WARMING_DEFAULTS: SessionWarmingSettings = {
  prompt: BUILT_IN_WARMING.prompt,
  interval: BUILT_IN_WARMING.interval,
  duration: BUILT_IN_WARMING.duration,
}

export type ChatSwitch = "on" | "off"
export type WarmingSource = "chat" | "model" | "config"

/** A Plus layer that decided some field: the agent's row, or the Defaults › Models rows. */
export interface WarmingRows {
  /** The agent's model row, each field with the level that set it. */
  readonly row?: ResolvedModelFields
  /** Defaults › Models › <this model>. */
  readonly model?: ModelSettingsRecord
  /** Defaults › Models › Every model. */
  readonly every?: ModelSettingsRecord
}

export interface WarmingDecision {
  readonly settings: SessionWarmingSettings | undefined
  readonly source: WarmingSource
  /** The level whose row decided, when a Plus row did: an agent row's level, or "defaults". */
  readonly level?: Level
}

/**
 * The settings Plus hands back to core. `configured` is what core proposes:
 * the host configuration at activity, the settings in force before a warming
 * request. Each field resolves down the layers; a total time on any Plus row
 * applies whenever warming runs.
 */
export function decideWarming(input: {
  readonly configured: SessionWarmingSettings | undefined
  readonly rows: WarmingRows
  readonly chat: ChatSwitch | undefined
}): WarmingDecision {
  const on = input.configured !== undefined || input.chat === "on"
  const base: WarmingBase =
    input.configured === undefined ? { ...BUILT_IN_BASE, on } : { on: true, ...input.configured, from: "config" }
  const effective = effectiveWarming({
    ...(input.rows.row === undefined ? {} : { row: input.rows.row }),
    ...(input.rows.model === undefined ? {} : { model: input.rows.model }),
    ...(input.rows.every === undefined ? {} : { every: input.rows.every }),
    base,
  })
  const level = plusLevel(effective.on, effective.duration, effective.interval, effective.prompt)
  if (input.chat === "off") return { settings: undefined, source: "chat" }
  // The chat switch turns warming on for this window wherever the rows would
  // leave it off; it still picks up their durations and prompt.
  if (input.chat === "on")
    return {
      settings: { prompt: effective.prompt.value, interval: effective.interval.value, duration: effective.duration.value },
      source: "chat",
    }
  const source: WarmingSource = level === undefined ? "config" : "model"
  if (!effective.on.value) return { settings: undefined, source, ...(level === undefined ? {} : { level }) }
  return {
    settings: { prompt: effective.prompt.value, interval: effective.interval.value, duration: effective.duration.value },
    source,
    ...(level === undefined ? {} : { level }),
  }
}

// The most specific Plus layer that decided any displayed field: a level for
// an agent row, "defaults" for a Defaults › Models row. Undefined when only
// the host configuration (or the built-in defaults) decided everything.
function plusLevel(...fields: { readonly from: SettingFrom }[]): Level | undefined {
  const levels = fields.map((field) => field.from)
  const agent = levels.find((from): from is Level => from === "project" || from === "global" || from === "defaults" || from === "preset")
  if (agent !== undefined) return agent
  if (levels.some((from) => from === "model" || from === "every")) return "defaults"
  return undefined
}

export interface WarmingWindow {
  readonly since: number
  readonly expires: number
  readonly interval: number
  readonly lastWarm?: number
}

export interface WarmingStatus {
  readonly sessionID: string
  readonly chat: ChatSwitch | "default"
  /** Compact before cold is on for this chat. */
  readonly compact: boolean
  /** When it compacts this chat, while a compaction is scheduled. */
  readonly compactAt?: number
  /** A warming window runs now: core keeps the cache warm until `expires`. */
  readonly active: boolean
  readonly source?: WarmingSource
  /** The level of the model row that decided, when the model row decided. */
  readonly level?: Level
  readonly since?: number
  readonly expires?: number
  readonly interval?: number
  readonly lastWarm?: number
  /** Server clock when this status was read. */
  readonly now: number
}

interface Tracked {
  readonly window?: WarmingWindow
  readonly source?: WarmingSource
  readonly level?: Level
}

export interface WarmingStore {
  /**
   * Decide one hook event and record the chat's window. `compact` compacts the
   * chat when compact before cold fires. Returns true when the visible status changed.
   */
  decide(event: SessionWarming, rows: WarmingRows, compact?: Compact): Promise<boolean>
  status(sessionID: string, now?: number): Promise<WarmingStatus>
  setChat(sessionID: string, chat: ChatSwitch | "default"): Promise<WarmingStatus>
  /** Switch compact before cold for one chat. */
  setCompact(sessionID: string, on: boolean): Promise<WarmingStatus>
  /** Whether the chat runs now: a running chat is using its cache and never compacts from here. */
  running(sessionID: string, running: boolean): void
  /** Stop every scheduled compaction (tests, shutdown). */
  dispose(): void
}

/** Compacts one chat; rejects when the host refuses. */
export type Compact = (sessionID: string) => Promise<unknown>

export interface WarmingStoreOptions {
  readonly now?: () => number
  readonly setTimer?: (run: () => void, ms: number) => unknown
  readonly clearTimer?: (timer: unknown) => void
}

export function warmingChatsPath(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  if (Product.namespace === "opencodeplus") return path.join(base, Product.namespace, "warming", "chats.json")
  return path.join(base, Product.namespace, "opencodeplus", "warming", "chats.json")
}

// Per-chat switches outlive restarts; the newest 500 are kept.
const MAX_CHATS = 500

interface Scheduled {
  readonly at: number
  readonly timer: unknown
}

export function createWarmingStore(file: string = warmingChatsPath(), options: WarmingStoreOptions = {}): WarmingStore {
  const now = options.now ?? Date.now
  // A scheduled compaction never keeps a process alive on its own.
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms).unref())
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  const tracked = new Map<string, Tracked>()
  const chats = { loaded: undefined as Promise<Map<string, ChatSwitch>> | undefined }
  // Compact before cold: the chats it is on for (persisted), when each chat's
  // cache goes cold, the scheduled compactions, how to compact each chat, the
  // chats running now, and the chats whose compaction this store started and
  // whose own request has not been seen yet.
  const compactFile = path.join(path.dirname(file), "compact.json")
  const compactChats = { loaded: undefined as Promise<Set<string>> | undefined }
  const coldAt = new Map<string, number>()
  const scheduled = new Map<string, Scheduled>()
  const compactors = new Map<string, Compact>()
  const busy = new Set<string>()
  const compacting = new Set<string>()
  const load = () => {
    chats.loaded ??= fs
      .readFile(file, "utf8")
      .then((text) => {
        const parsed: unknown = JSON.parse(text)
        if (typeof parsed !== "object" || parsed === null) return new Map<string, ChatSwitch>()
        return new Map(
          Object.entries(parsed).filter((entry): entry is [string, ChatSwitch] => entry[1] === "on" || entry[1] === "off"),
        )
      })
      .catch(() => new Map<string, ChatSwitch>())
    return chats.loaded
  }
  const loadCompact = () => {
    compactChats.loaded ??= fs
      .readFile(compactFile, "utf8")
      .then((text) => {
        const parsed: unknown = JSON.parse(text)
        if (!Array.isArray(parsed)) return new Set<string>()
        return new Set(parsed.filter((entry): entry is string => typeof entry === "string"))
      })
      .catch(() => new Set<string>())
    return compactChats.loaded
  }
  const write = async (target: string, value: unknown) => {
    await fs.mkdir(path.dirname(target), { recursive: true })
    const temp = `${target}.${process.pid}.tmp`
    await fs.writeFile(temp, JSON.stringify(value, null, 2) + "\n")
    await fs.rename(temp, target)
  }
  const persist = (map: Map<string, ChatSwitch>) => write(file, Object.fromEntries(map))
  const unschedule = (sessionID: string) => {
    const current = scheduled.get(sessionID)
    if (current === undefined) return
    clearTimer(current.timer)
    scheduled.delete(sessionID)
  }
  // Schedule this chat's compaction for when its cache goes cold. A cache
  // already cold (a window that ended before the switch came on) is left alone:
  // compacting it would pay for the whole prompt again.
  const schedule = (sessionID: string, decidedAt: number) => {
    unschedule(sessionID)
    const at = coldAt.get(sessionID)
    if (at === undefined || at < decidedAt) return
    const timer = setTimer(() => void fire(sessionID, at), Math.max(0, at - now()))
    scheduled.set(sessionID, { at, timer })
  }
  const fire = async (sessionID: string, at: number) => {
    if (scheduled.get(sessionID)?.at !== at) return
    scheduled.delete(sessionID)
    const compact = compactors.get(sessionID)
    if (compact === undefined || busy.has(sessionID) || !(await loadCompact()).has(sessionID)) return
    coldAt.delete(sessionID)
    compacting.add(sessionID)
    await compact(sessionID).catch(() => compacting.delete(sessionID))
  }
  const statusOf = (sessionID: string, chat: ChatSwitch | undefined, compact: boolean, now: number): WarmingStatus => {
    const entry = tracked.get(sessionID)
    const window = entry?.window
    const active = window !== undefined && now < window.expires && chat !== "off"
    const compactAt = compact ? scheduled.get(sessionID)?.at : undefined
    return {
      sessionID,
      chat: chat ?? "default",
      compact,
      ...(compactAt === undefined ? {} : { compactAt }),
      active,
      ...(entry?.source === undefined ? {} : { source: entry.source }),
      ...(entry?.level === undefined ? {} : { level: entry.level }),
      ...(window === undefined ? {} : { since: window.since, expires: window.expires, interval: window.interval }),
      ...(window?.lastWarm === undefined ? {} : { lastWarm: window.lastWarm }),
      now,
    }
  }
  return {
    async decide(event, rows, compact) {
      const chat = (await load()).get(event.sessionID)
      // The request of a compaction this store started: the chat is compacted
      // and its cache about to go cold, so warming the new context would only
      // cost. Nothing more is scheduled until the next real request.
      const activity = event.phase === "activity"
      const ours = activity && event.kind === "compaction" && compacting.has(event.sessionID)
      if (activity) compacting.delete(event.sessionID)
      const decided = decideWarming({ configured: event.settings, rows, chat })
      const decision = ours ? { ...decided, settings: undefined } : decided
      event.settings = decision.settings
      const before = tracked.get(event.sessionID)
      const beforeCompact = scheduled.get(event.sessionID)?.at
      const settings = decision.settings
      const window =
        settings === undefined
          ? undefined
          : {
              since: event.since,
              expires: event.since + settings.duration,
              interval: settings.interval,
              ...(event.phase === "warm"
                ? { lastWarm: event.now }
                : before?.window?.lastWarm === undefined || before.window.since !== event.since
                  ? {}
                  : { lastWarm: before.window.lastWarm }),
            }
      const next: Tracked = {
        ...(window === undefined ? {} : { window }),
        source: decision.source,
        ...(decision.source === "model" && decision.level !== undefined ? { level: decision.level } : {}),
      }
      tracked.set(event.sessionID, next)
      if (compact !== undefined) compactors.set(event.sessionID, compact)
      // A compaction's own request never schedules another: the context it
      // leaves is already small.
      if (activity && event.kind === "compaction") coldAt.delete(event.sessionID)
      else coldAt.set(event.sessionID, window?.expires ?? (activity ? event.now + coldInterval(decided, rows) : event.now))
      if ((await loadCompact()).has(event.sessionID)) schedule(event.sessionID, event.now)
      else unschedule(event.sessionID)
      return (
        beforeCompact !== scheduled.get(event.sessionID)?.at ||
        before?.window?.expires !== window?.expires ||
        before?.window?.interval !== window?.interval ||
        before?.source !== next.source ||
        (before?.window === undefined) !== (window === undefined)
      )
    },
    async status(sessionID, at = now()) {
      return statusOf(sessionID, (await load()).get(sessionID), (await loadCompact()).has(sessionID), at)
    },
    async setChat(sessionID, chat) {
      const map = await load()
      map.delete(sessionID)
      if (chat !== "default") map.set(sessionID, chat)
      for (const key of [...map.keys()].slice(0, Math.max(0, map.size - MAX_CHATS))) map.delete(key)
      await persist(map)
      // Off shows as inactive at once; core stops before its next warming
      // request, where the hook sees the switch. Switched back on before that,
      // the same window simply continues.
      return statusOf(sessionID, map.get(sessionID), (await loadCompact()).has(sessionID), now())
    },
    async setCompact(sessionID, on) {
      const set = await loadCompact()
      set.delete(sessionID)
      if (on) set.add(sessionID)
      for (const key of [...set].slice(0, Math.max(0, set.size - MAX_CHATS))) set.delete(key)
      await write(compactFile, [...set])
      if (on) schedule(sessionID, now())
      else unschedule(sessionID)
      return statusOf(sessionID, (await load()).get(sessionID), on, now())
    },
    running(sessionID, running) {
      if (running) busy.add(sessionID)
      else busy.delete(sessionID)
    },
    dispose() {
      for (const sessionID of [...scheduled.keys()]) unschedule(sessionID)
    },
  }
}

// How long a cache stays warm after a request when no warming window says so:
// the keep-alive interval, which is kept under the provider's cache lifetime.
function coldInterval(decided: WarmingDecision, rows: WarmingRows): number {
  if (decided.settings !== undefined) return decided.settings.interval
  return effectiveWarming({
    ...(rows.row === undefined ? {} : { row: rows.row }),
    ...(rows.model === undefined ? {} : { model: rows.model }),
    ...(rows.every === undefined ? {} : { every: rows.every }),
  }).interval.value
}

/** The one store every Plus instance in this process shares: chats are global, not per directory. */
export const warmingStore = createWarmingStore()
