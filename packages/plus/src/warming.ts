import type { SessionWarming, SessionWarmingSettings } from "@opencode/plugin/effect/session"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Product } from "@opencode/util/product"
import { parseWarming, type Level, type WarmingValue } from "./instructions/model.js"

// Cache warming ("pinging"): core sends keep-alive requests after a chat's
// last real request so the provider prompt cache stays warm. Plus decides it
// per chat through the session `warming` hook:
//
//   per-chat switch (on/off)  >  the agent's model row (off, on, total time)  >  host configuration
//
// and remembers each chat's window so the TUI can count down to its end.

/** Core's defaults (core/src/config/warming.ts), used when the host configuration leaves warming off. */
export const WARMING_DEFAULTS: SessionWarmingSettings = {
  prompt: "This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK",
  interval: 4 * 60 * 1000,
  duration: 30 * 60 * 1000,
}

export type ChatSwitch = "on" | "off"
export type WarmingSource = "chat" | "model" | "config"

export interface WarmingDecision {
  readonly settings: SessionWarmingSettings | undefined
  readonly source: WarmingSource
}

/**
 * The settings Plus hands back to core. `configured` is what core proposes:
 * the host configuration at activity, the settings in force before a warming
 * request. A total time on the model row applies whenever warming runs.
 */
export function decideWarming(input: {
  readonly configured: SessionWarmingSettings | undefined
  readonly row: WarmingValue | undefined
  readonly chat: ChatSwitch | undefined
}): WarmingDecision {
  const base = input.configured ?? WARMING_DEFAULTS
  const duration = input.row?.on === true && input.row.duration !== undefined ? input.row.duration : base.duration
  if (input.chat === "off") return { settings: undefined, source: "chat" }
  if (input.chat === "on") return { settings: { ...base, duration }, source: "chat" }
  if (input.row === undefined) return { settings: input.configured, source: "config" }
  if (!input.row.on) return { settings: undefined, source: "model" }
  return { settings: { ...base, duration }, source: "model" }
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
  /** Decide one hook event and record the chat's window. Returns true when the visible status changed. */
  decide(event: SessionWarming, row: { readonly value: string; readonly level: Level } | undefined): Promise<boolean>
  status(sessionID: string, now?: number): Promise<WarmingStatus>
  setChat(sessionID: string, chat: ChatSwitch | "default"): Promise<WarmingStatus>
}

export function warmingChatsPath(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  if (Product.namespace === "opencodeplus") return path.join(base, Product.namespace, "warming", "chats.json")
  return path.join(base, Product.namespace, "opencodeplus", "warming", "chats.json")
}

// Per-chat switches outlive restarts; the newest 500 are kept.
const MAX_CHATS = 500

export function createWarmingStore(file: string = warmingChatsPath()): WarmingStore {
  const tracked = new Map<string, Tracked>()
  const chats = { loaded: undefined as Promise<Map<string, ChatSwitch>> | undefined }
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
  const persist = async (map: Map<string, ChatSwitch>) => {
    await fs.mkdir(path.dirname(file), { recursive: true })
    const temp = `${file}.${process.pid}.tmp`
    await fs.writeFile(temp, JSON.stringify(Object.fromEntries(map), null, 2) + "\n")
    await fs.rename(temp, file)
  }
  const statusOf = (sessionID: string, chat: ChatSwitch | undefined, now: number): WarmingStatus => {
    const entry = tracked.get(sessionID)
    const window = entry?.window
    const active = window !== undefined && now < window.expires && chat !== "off"
    return {
      sessionID,
      chat: chat ?? "default",
      active,
      ...(entry?.source === undefined ? {} : { source: entry.source }),
      ...(entry?.level === undefined ? {} : { level: entry.level }),
      ...(window === undefined ? {} : { since: window.since, expires: window.expires, interval: window.interval }),
      ...(window?.lastWarm === undefined ? {} : { lastWarm: window.lastWarm }),
      now,
    }
  }
  return {
    async decide(event, row) {
      const chat = (await load()).get(event.sessionID)
      const parsed = row === undefined ? undefined : parseWarming(row.value)
      const value = parsed === undefined || "error" in parsed ? undefined : parsed
      const decision = decideWarming({ configured: event.settings, row: value, chat })
      event.settings = decision.settings
      const before = tracked.get(event.sessionID)
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
        ...(decision.source === "model" && row !== undefined ? { level: row.level } : {}),
      }
      tracked.set(event.sessionID, next)
      return (
        before?.window?.expires !== window?.expires ||
        before?.window?.interval !== window?.interval ||
        before?.source !== next.source ||
        (before?.window === undefined) !== (window === undefined)
      )
    },
    async status(sessionID, now = Date.now()) {
      return statusOf(sessionID, (await load()).get(sessionID), now)
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
      return statusOf(sessionID, map.get(sessionID), Date.now())
    },
  }
}

/** The one store every Plus instance in this process shares: chats are global, not per directory. */
export const warmingStore = createWarmingStore()
