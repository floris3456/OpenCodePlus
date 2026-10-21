import type { SessionWarming, SessionWarmingSettings } from "@opencode/plugin/effect/session"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Product } from "@opencode/util/product"
import { type Level, type ResolvedModelFields } from "./instructions/model.js"
import {
  builtInWarming,
  effectiveWarming,
  BUILT_IN_WARMING,
  type ModelSettingsKey,
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
// Compact before cold is a second per-chat switch: an idle chat compacts right
// before its prompt cache goes cold, so the summary request still reads a warm
// cache and the next message starts from the small compacted context. The
// cache stays warm until the warming window ends (its last keep-alive was at
// most one interval earlier, and the interval is kept under the provider's
// cache lifetime); without warming, one interval after the last request.
// Warming switched off mid-window, core stops at its next keep-alive moment,
// one interval after the last request or keep-alive.
//
// The switch has three states: the chat's own on/off override, or "default"
// (no entry) which follows the model's effective `compactWarm`. Existing
// `compact.json` arrays (entries meant on) still read as on.

/** Core's defaults (core/src/config/warming.ts), used when the host configuration leaves warming off. */
export const WARMING_DEFAULTS: SessionWarmingSettings = {
  prompt: BUILT_IN_WARMING.prompt,
  interval: BUILT_IN_WARMING.interval,
  duration: BUILT_IN_WARMING.duration,
}

export type ChatSwitch = "on" | "off"
export type WarmingSource = "chat" | "model" | "config"

/** Where a chat's effective compact-before-cold came from: its own switch, or its model. */
export type CompactSource = "chat" | "model"

/**
 * The chat's model-level compact settings, resolved for its agent and model
 * (C1's `compactWarm`, `coldCompact` and cold list). The store falls back to
 * this whenever the chat has no override; `coldModels` is what C3a's cold
 * arming would compact with when it applies.
 */
export interface ChatCompactionDefaults {
  /** The model's effective "Compact before cold". */
  readonly compactWarm: boolean
  /** Where that value came from; "built-in" when no model row sets it. */
  readonly compactWarmFrom: "model" | "built-in"
  /** The models cold arming would try, when cold compact is on and the list is not empty. */
  readonly coldModels: readonly string[]
}

/** The chat's model-level compact defaults, read live (model settings can change between calls). */
export type CompactDefaultsReader = (sessionID: string) => Promise<ChatCompactionDefaults | undefined>

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
  /** Warm while waiting in milliseconds (0 off), with settings: the chat's window while it waits on its own work. */
  readonly waiting?: number
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
  /** A session with a parent uses Warm as subagent as its independent model switch. */
  readonly subagent?: boolean
  /** The chat's model: a row or the chat switch that turns warming on takes its own times. */
  readonly model?: ModelSettingsKey
}): WarmingDecision {
  // Without a proposal warming stays off unless a row or the chat turns it on: core's built-in
  // warming arrives as its proposal, so a hook that vetoed it keeps it vetoed.
  const on = input.configured !== undefined || input.chat === "on"
  const base: WarmingBase =
    input.configured === undefined ? { ...builtInWarming(input.model), on } : { on: true, ...input.configured, from: "config" }
  const effective = effectiveWarming({
    ...(input.rows.row === undefined ? {} : { row: input.rows.row }),
    ...(input.rows.model === undefined ? {} : { model: input.rows.model }),
    ...(input.rows.every === undefined ? {} : { every: input.rows.every }),
    base,
  })
  const enabled = input.subagent ? effective.subagent : effective.on
  const level = plusLevel(enabled, effective.duration, effective.interval, effective.prompt)
  if (input.chat === "off") return { settings: undefined, source: "chat" }
  // The chat switch turns warming on for this window wherever the rows would
  // leave it off; it still picks up their durations and prompt.
  if (input.chat === "on")
    return {
      settings: { prompt: effective.prompt.value, interval: effective.interval.value, duration: effective.duration.value },
      source: "chat",
      waiting: effective.waiting.value,
    }
  const source: WarmingSource = level === undefined ? "config" : "model"
  if (!enabled.value) return { settings: undefined, source, ...(level === undefined ? {} : { level }) }
  return {
    settings: { prompt: effective.prompt.value, interval: effective.interval.value, duration: effective.duration.value },
    source,
    ...(level === undefined ? {} : { level }),
    waiting: effective.waiting.value,
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
  /** Compact before cold is on for this chat (the effective value). */
  readonly compact: boolean
  /** Where the effective value came from: the chat's own switch, or its model. Absent for the built-in default. */
  readonly compactSource?: CompactSource
  /** The models cold arming would compact with first, when it applies. */
  readonly coldModels?: readonly string[]
  /** When it compacts this chat, while a compaction is scheduled. */
  readonly compactAt?: number
  /**
   * When the cache goes (or went) cold for a chat warming does not keep warm:
   * warming off for it, or switched off mid-window. Kept once it has passed, so
   * the chat reads as cold; absent once it is compacted.
   */
  readonly coldAt?: number
  /** Latest compaction completed after the last real request; absent otherwise. */
  readonly compacted?: boolean
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
  /** The settings the chat's rows decided, before a waiting chat's longer window. */
  readonly configured?: SessionWarmingSettings
  /** Warm while waiting as the chat's rows decided it (0 off), for settle(), which runs without rows. */
  readonly waiting?: number
}

export interface CompactionRecord {
  readonly completedAt: number
  /** Whether a real request (user/assistant) exists after this compaction in durable history. */
  readonly hasSubsequentRealRequest?: boolean
}

export type CompactionReader = (sessionID: string) => Promise<CompactionRecord | undefined>

export interface WarmingStore {
  /**
   * Decide one hook event and record the chat's window. `compact` compacts the
   * chat when compact before cold fires. Returns true when the visible status changed.
   */
  decide(event: SessionWarming, rows: WarmingRows, compact?: Compact): Promise<boolean>
  status(sessionID: string, now?: number): Promise<WarmingStatus>
  setChat(sessionID: string, chat: ChatSwitch | "default"): Promise<WarmingStatus>
  /**
   * Set the chat's compact before cold switch: "on"/"off" is an override,
   * "default" removes it (the model's `compactWarm` decides again).
   */
  setCompact(sessionID: string, chat: ChatSwitch | "default"): Promise<WarmingStatus>
  /** Whether the chat runs now: a running chat is using its cache and never compacts from here. */
  running(sessionID: string, running: boolean): void
  /**
   * A turn of this chat ended: re-decide its window and its parents' at once,
   * so they show the configured window instead of the waiting one. The chat's
   * own window, while it still runs, restarts from the end of the turn.
   * Returns the chats whose window changed.
   */
  settle(sessionID: string): Promise<string[]>
  /** End this window and cancel compact-before-cold; real activity can start a new one. */
  stop(sessionID: string): boolean
  /** Configure the host's read of the chats running now (core's active set). */
  setActiveReader(reader: ActiveReader): void
  /** The chat that started this one (a subagent's or team worker's parent): it keeps warm while this runs. */
  parent(sessionID: string, parent: string): void
  /** Whether something this chat started (a subagent, a team worker, at any depth) still runs; its own turn does not count. */
  workRuns(sessionID: string): Promise<boolean>
  /** Invalidate cached compaction truth for this chat. */
  invalidateCompaction(sessionID: string, completedAt?: number): void
  /** Configure the durable compaction history reader. */
  setCompactionReader(reader: CompactionReader): void
  /** Configure the reader of each chat's model-level compact defaults. */
  setCompactDefaultsReader(reader: CompactDefaultsReader): void
  /** Stop every scheduled compaction (tests, shutdown). */
  dispose(): void
}

/** Compacts one chat; rejects when the host refuses. */
export type Compact = (sessionID: string) => Promise<unknown>

/** The chats running now, as the host knows them (the set behind /api/session/active). */
export type ActiveReader = () => Promise<ReadonlySet<string>>

export interface WarmingStoreOptions {
  readonly now?: () => number
  readonly setTimer?: (run: () => void, ms: number) => unknown
  readonly clearTimer?: (timer: unknown) => void
  readonly compactionHistory?: CompactionReader
  readonly compactDefaults?: CompactDefaultsReader
  readonly activeSessions?: ActiveReader
}

export function warmingChatsPath(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  if (Product.namespace === "opencodeplus") return path.join(base, Product.namespace, "warming", "chats.json")
  return path.join(base, Product.namespace, "opencodeplus", "warming", "chats.json")
}

// Per-chat switches outlive restarts; the newest 500 are kept.
const MAX_CHATS = 500

// While a chat waits on its own work (a command or other tool call still
// running, or a subagent or team worker it started) its window is at least its
// Warm while waiting time (model rows; built-in 2h, WAITING_DEFAULT_MS): such a
// chat is likely to come back.

// Parent links (and each chat's configured duration) kept for the waiting check; the newest win.
const MAX_PARENTS = 2_000

interface Scheduled {
  readonly at: number
  readonly timer: unknown
}

export function createWarmingStore(file: string = warmingChatsPath(), options: WarmingStoreOptions = {}): WarmingStore {
  const now = options.now ?? Date.now
  // A scheduled compaction never keeps a process alive on its own.
  const setTimer = options.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms).unref())
  const clearTimer = options.clearTimer ?? ((timer: unknown) => clearTimeout(timer as ReturnType<typeof setTimeout>))
  let compactionReader: CompactionReader | undefined = options.compactionHistory
  let compactDefaults: CompactDefaultsReader | undefined = options.compactDefaults
  let activeReader: ActiveReader | undefined = options.activeSessions
  const compactionCache = new Map<string, Promise<CompactionRecord | undefined>>()
  const lastReal = new Map<string, number>()
  const inMemoryCompaction = new Map<string, number>()
  const tracked = new Map<string, Tracked>()
  const chats = { loaded: undefined as Promise<Map<string, ChatSwitch>> | undefined }
  // Compact before cold: the chats it is on for (persisted), when each chat's
  // cache goes cold, the scheduled compactions, how to compact each chat, and
  // the chats running now.
  const compactFile = path.join(path.dirname(file), "compact.json")
  const compactChats = { loaded: undefined as Promise<Map<string, ChatSwitch>> | undefined }
  const coldAt = new Map<string, number>()
  const scheduled = new Map<string, Scheduled>()
  const compactors = new Map<string, Compact>()
  const busy = new Set<string>()
  const parents = new Map<string, string>()
  // Core proposes at each warming request the settings this store returned last
  // time, so a waiting chat's longer window would come back as its own: each
  // chat's duration as configured at its last request stands in for it.
  const configuredDuration = new Map<string, number>()
  // The chat itself, or anything it started (at any depth), is in `running`.
  const runsFor = (running: Iterable<string>, sessionID: string) =>
    [...running].some((id) => ancestry(id).includes(sessionID))
  // A chat and the chats that started it, nearest first.
  const ancestry = (sessionID: string) => {
    const chain: string[] = []
    for (let current: string | undefined = sessionID; current !== undefined && !chain.includes(current); current = parents.get(current))
      chain.push(current)
    return chain
  }
  // The session events' busy set: the fast path, kept per Location's event stream.
  const waiting = (sessionID: string) => runsFor(busy, sessionID)
  // What runs now, from the host; undefined when it cannot be asked.
  const readActive = () => (activeReader === undefined ? Promise.resolve(undefined) : activeReader().catch(() => undefined))
  // At a keep-alive the host's running set decides, so a start event whose end
  // was missed or arrived out of order cannot hold the waiting window once
  // nothing runs. Without an answer from the host, the busy set does.
  const waitingAtKeepAlive = async (sessionID: string) => {
    const active = await readActive()
    return active === undefined ? waiting(sessionID) : runsFor(active, sessionID)
  }
  // When a turn of `ended` ends: its event cleared the busy flag already; a
  // busy flag left elsewhere in the chain is checked with the host. The ended
  // chat itself still shows as running there until its execution settles.
  const waitingAfterTurn = async (sessionID: string, ended: string) => {
    if (!waiting(sessionID)) return false
    const active = await readActive()
    return active === undefined || runsFor([...active].filter((id) => id !== ended), sessionID)
  }
  const getCompaction = (sessionID: string): Promise<CompactionRecord | undefined> => {
    if (!compactionReader) return Promise.resolve(undefined)
    let cached = compactionCache.get(sessionID)
    if (cached === undefined) {
      cached = compactionReader(sessionID).catch(() => undefined)
      compactionCache.set(sessionID, cached)
    }
    return cached
  }
  const isCompacted = async (sessionID: string, windowSince?: number): Promise<boolean> => {
    const compaction = await getCompaction(sessionID)
    const completedAt = compaction?.completedAt ?? inMemoryCompaction.get(sessionID)
    if (completedAt === undefined || Number.isNaN(completedAt)) return false

    const lastActivity = lastReal.get(sessionID)
    if (lastActivity !== undefined) {
      return completedAt > lastActivity
    }

    if (windowSince !== undefined) {
      return completedAt > windowSince
    }

    const entry = tracked.get(sessionID)
    if (entry?.window?.since !== undefined) {
      return completedAt > entry.window.since
    }

    return compaction ? compaction.hasSubsequentRealRequest !== true : true
  }
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
      .then((text): Map<string, ChatSwitch> => {
        const parsed: unknown = JSON.parse(text)
        // Backward compatible: the old file was an array of chats it was on
        // for. The new file is a map, an explicit "off" stored for a chat.
        if (Array.isArray(parsed))
          return new Map(parsed.filter((entry): entry is string => typeof entry === "string").map((id) => [id, "on"]))
        if (typeof parsed !== "object" || parsed === null) return new Map<string, ChatSwitch>()
        return new Map(
          Object.entries(parsed).filter((entry): entry is [string, ChatSwitch] => entry[1] === "on" || entry[1] === "off"),
        )
      })
      .catch(() => new Map<string, ChatSwitch>())
    return compactChats.loaded
  }
  // The chat's model-level defaults, read live; a failure leaves the built-in default.
  const compactDefaultsOf = async (sessionID: string): Promise<ChatCompactionDefaults | undefined> => {
    const reader = compactDefaults
    if (reader === undefined) return undefined
    return reader(sessionID).catch(() => undefined)
  }
  // Compact before cold for this chat: an explicit chat entry wins, else the
  // model's effective `compactWarm`, else off.
  const effectiveCompact = async (sessionID: string): Promise<boolean> => {
    const override = (await loadCompact()).get(sessionID)
    if (override !== undefined) return override === "on"
    return (await compactDefaultsOf(sessionID))?.compactWarm === true
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
    if (compact === undefined || busy.has(sessionID) || !(await effectiveCompact(sessionID))) return
    coldAt.delete(sessionID)
    await compact(sessionID).catch(() => {})
  }
  const statusOf = async (
    sessionID: string,
    chat: ChatSwitch | undefined,
    now: number,
  ): Promise<WarmingStatus> => {
    const compacted = await isCompacted(sessionID)
    const entry = tracked.get(sessionID)
    const window = entry?.window
    const active = !compacted && window !== undefined && now < window.expires && chat !== "off"
    const override = (await loadCompact()).get(sessionID)
    // Read even under a chat override: the cold-cache list does not depend on it.
    const defaults = await compactDefaultsOf(sessionID)
    const compact = override !== undefined ? override === "on" : defaults?.compactWarm === true
    const compactSource: CompactSource | undefined =
      override !== undefined ? "chat" : defaults?.compactWarmFrom === "model" ? "model" : undefined
    const compactAt = compact && !compacted ? scheduled.get(sessionID)?.at : undefined
    // A chat without a window (warming never on, or switched off before its reply)
    // goes cold one keep-alive interval after its last request, as decide() recorded.
    const cold = compacted
      ? undefined
      : window === undefined
        ? coldAt.get(sessionID)
        : chat === "off"
          ? coldMoment(chat, window, lastReal.get(sessionID))
          : undefined
    return {
      sessionID,
      chat: chat ?? "default",
      compact,
      ...(compactSource === undefined ? {} : { compactSource }),
      ...(defaults !== undefined && defaults.coldModels.length > 0 ? { coldModels: [...defaults.coldModels] } : {}),
      ...(compactAt === undefined ? {} : { compactAt }),
      ...(cold === undefined ? {} : { coldAt: cold }),
      ...(compacted ? { compacted: true } : {}),
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
      const activity = event.phase === "activity"
      // Core proposes the configured settings at activity and when a window resumes after a restart.
      const proposesConfigured = activity || event.phase === "resume"
      const isCompactionActivity = activity && event.kind === "compaction"

      if (isCompactionActivity) {
        inMemoryCompaction.set(event.sessionID, event.now)
      } else if (activity) {
        lastReal.set(event.sessionID, event.now)
      }

      const compacted = isCompactionActivity || (await isCompacted(event.sessionID, event.since))
      if (proposesConfigured && event.settings !== undefined) {
        configuredDuration.delete(event.sessionID)
        configuredDuration.set(event.sessionID, event.settings.duration)
        const oldest = configuredDuration.keys().next().value
        if (configuredDuration.size > MAX_PARENTS && oldest !== undefined) configuredDuration.delete(oldest)
      }
      const own = configuredDuration.get(event.sessionID)
      const configured =
        proposesConfigured || event.settings === undefined || own === undefined
          ? event.settings
          : { ...event.settings, duration: own }
      const model = { providerID: event.model.providerID, modelID: event.model.id }
      const decided = decideWarming({ configured, rows, chat, model, subagent: event.subagent })
      // A real request starts while its chat runs: the events' busy set answers.
      // Before a keep-alive, or when a window resumes, the host is asked what runs now.
      const waits =
        !compacted &&
        decided.settings !== undefined &&
        (activity ? waiting(event.sessionID) : await waitingAtKeepAlive(event.sessionID))
      const decision = compacted
        ? { ...decided, settings: undefined }
        : waits && decided.settings !== undefined
          ? { ...decided, settings: { ...decided.settings, duration: Math.max(decided.settings.duration, decided.waiting ?? 0) } }
          : decided
      event.settings = decision.settings
      const before = tracked.get(event.sessionID)
      const beforeCompact = scheduled.get(event.sessionID)?.at
      const beforeCold = coldAt.get(event.sessionID)
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
        ...(compacted || decided.settings === undefined ? {} : { configured: decided.settings, waiting: decided.waiting ?? 0 }),
      }
      tracked.set(event.sessionID, next)
      if (compact !== undefined) compactors.set(event.sessionID, compact)

      // A compaction never schedules another: the context it leaves is already small.
      if (compacted) {
        coldAt.delete(event.sessionID)
        unschedule(event.sessionID)
      } else {
        coldAt.set(
          event.sessionID,
          window?.expires ?? (activity ? event.now + coldInterval(decided, rows, configured, model) : event.now),
        )
        if (await effectiveCompact(event.sessionID)) schedule(event.sessionID, event.now)
        else unschedule(event.sessionID)
      }

      return (
        beforeCompact !== scheduled.get(event.sessionID)?.at ||
        before?.window?.expires !== window?.expires ||
        before?.window?.interval !== window?.interval ||
        before?.source !== next.source ||
        (before?.window === undefined) !== (window === undefined) ||
        (window === undefined && beforeCold !== coldAt.get(event.sessionID))
      )
    },
    async status(sessionID, at = now()) {
      return statusOf(sessionID, (await load()).get(sessionID), at)
    },
    stop(sessionID) {
      const changed = tracked.has(sessionID) || scheduled.has(sessionID) || coldAt.has(sessionID)
      unschedule(sessionID)
      tracked.delete(sessionID)
      coldAt.delete(sessionID)
      configuredDuration.delete(sessionID)
      compactors.delete(sessionID)
      busy.delete(sessionID)
      return changed
    },
    async setChat(sessionID, chat) {
      const map = await load()
      map.delete(sessionID)
      if (chat !== "default") map.set(sessionID, chat)
      for (const key of [...map.keys()].slice(0, Math.max(0, map.size - MAX_CHATS))) map.delete(key)
      await persist(map)
      // Off shows as inactive at once; core stops before its next warming
      // request, where the hook sees the switch, so the cache goes cold and a
      // scheduled compaction moves there. Switched back on before that, the
      // same window simply continues to its end.
      const window = tracked.get(sessionID)?.window
      if (window !== undefined && coldAt.has(sessionID) && !(await isCompacted(sessionID))) {
        coldAt.set(sessionID, coldMoment(map.get(sessionID), window, lastReal.get(sessionID)))
        if (await effectiveCompact(sessionID)) schedule(sessionID, now())
        else unschedule(sessionID)
      }
      return statusOf(sessionID, map.get(sessionID), now())
    },
    async setCompact(sessionID, chat) {
      const map = await loadCompact()
      map.delete(sessionID)
      if (chat !== "default") map.set(sessionID, chat)
      for (const key of [...map.keys()].slice(0, Math.max(0, map.size - MAX_CHATS))) map.delete(key)
      await write(compactFile, Object.fromEntries(map))
      // "default" with the model on still compacts; "off" (or a model set off)
      // drops the timer. A cache already cold schedules nothing either way.
      const compacted = await isCompacted(sessionID)
      if (!compacted && (await effectiveCompact(sessionID))) schedule(sessionID, now())
      else unschedule(sessionID)
      return statusOf(sessionID, (await load()).get(sessionID), now())
    },
    running(sessionID, running) {
      if (running) busy.add(sessionID)
      else busy.delete(sessionID)
    },
    async settle(sessionID) {
      const changed: string[] = []
      const at = now()
      const switches = await load()
      for (const chat of ancestry(sessionID)) {
        const entry = tracked.get(chat)
        const window = entry?.window
        if (window === undefined || entry?.configured === undefined) continue
        const configured = entry.configured.duration
        const waitingWindow = Math.max(configured, entry.waiting ?? 0)
        // Core applies the same window at its next keep-alive, which always
        // comes before either window ends. The chat whose turn ended restarts a
        // window that still runs, as core does: the full duration follows the
        // turn, however long it waited on its own work.
        const next =
          chat === sessionID && at < window.expires
            ? {
                ...window,
                since: at,
                expires: at + ((await waitingAfterTurn(chat, sessionID)) ? waitingWindow : configured),
              }
            : window.since + configured === window.expires || (await waitingAfterTurn(chat, sessionID))
              ? window
              : { ...window, expires: window.since + configured }
        if (next === window) continue
        tracked.set(chat, { ...entry, window: next })
        if (coldAt.has(chat)) {
          coldAt.set(chat, coldMoment(switches.get(chat), next, lastReal.get(chat)))
          if (await effectiveCompact(chat)) schedule(chat, at)
          else unschedule(chat)
        }
        changed.push(chat)
      }
      return changed
    },
    setActiveReader(reader) {
      activeReader = reader
    },
    workRuns: (sessionID) => waitingAfterTurn(sessionID, sessionID),
    parent(sessionID, parent) {
      // Links outlive a run: an idle subagent still links its own running subagent up.
      parents.delete(sessionID)
      parents.set(sessionID, parent)
      for (const key of [...parents.keys()].slice(0, Math.max(0, parents.size - MAX_PARENTS))) parents.delete(key)
    },
    invalidateCompaction(sessionID, completedAt) {
      compactionCache.delete(sessionID)
      if (completedAt !== undefined) {
        inMemoryCompaction.set(sessionID, completedAt)
      }
      coldAt.delete(sessionID)
      unschedule(sessionID)
    },
    setCompactionReader(reader) {
      compactionReader = reader
      compactionCache.clear()
    },
    setCompactDefaultsReader(reader) {
      compactDefaults = reader
    },
    dispose() {
      for (const sessionID of [...scheduled.keys()]) unschedule(sessionID)
    },
  }
}

// When a chat's cache goes cold: its warming window's end, or, with warming
// switched off, core's next keep-alive moment, where it stops pinging. Core
// times that from the last request or keep-alive: the end of a turn moves the
// window's start but not that. Without the last request (a window resumed
// after a restart), the window's start stands in for it.
function coldMoment(chat: ChatSwitch | undefined, window: WarmingWindow, lastRequest: number | undefined): number {
  if (chat !== "off") return window.expires
  return Math.min(Math.max(lastRequest ?? window.since, window.lastWarm ?? 0) + window.interval, window.expires)
}

// How long a cache stays warm after a request when no warming window says so:
// the keep-alive interval, which is kept under the provider's cache lifetime.
// The host configuration is the base under the rows, as in decideWarming.
function coldInterval(
  decided: WarmingDecision,
  rows: WarmingRows,
  configured: SessionWarmingSettings | undefined,
  model: ModelSettingsKey,
): number {
  if (decided.settings !== undefined) return decided.settings.interval
  return effectiveWarming({
    ...(rows.row === undefined ? {} : { row: rows.row }),
    ...(rows.model === undefined ? {} : { model: rows.model }),
    ...(rows.every === undefined ? {} : { every: rows.every }),
    base: configured === undefined ? builtInWarming(model) : { on: true, ...configured, from: "config" },
  }).interval.value
}

/** The one store every Plus instance in this process shares: chats are global, not per directory. */
export const warmingStore = createWarmingStore()
