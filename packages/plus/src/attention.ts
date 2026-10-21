import { attentionOn } from "./attention-settings.js"
import type { AttentionEventSettings, AttentionKind, AttentionSettings } from "./rpc.js"

// Notifications and sounds for agent events (docs/plans/plus-1.3.18-notifications.md): what one
// server process remembers between events, and the decision of which event an occurrence is.

/** A sound player counts as connected this long after its last heartbeat. */
export const PLAYER_TTL_MS = 45_000

// Event ids already handled, background shells by session, and cache notices already raised:
// bounded, the newest kept.
const MAX_CLAIMS = 5_000
const MAX_PARENTS = 2_000
const MAX_NOTICES = 2_000

export interface AttentionStore {
  /** True the first time an event id is claimed: each event raises attention once per process. */
  claim(eventID: string): boolean
  /** A player's heartbeat; returns how many players are connected. */
  player(id: string): number
  players(): number
  shellStarted(shellID: string, sessionID: string): void
  shellExited(shellID: string): void
  /** Background shells this chat started that still run. */
  shells(sessionID: string): number
  /** The chat that started this one, once known (null: a top-level chat). */
  parent(sessionID: string): string | null | undefined
  setParent(sessionID: string, parent: string | null): void
  /** True the first time a cache notice is seen; notices from before this process are never new. */
  newNotice(requestID: string, at: number): boolean
  /** A TUI's report of the chats it has open; returns how many TUIs report now. */
  opened(id: string, sessionIDs: readonly string[]): number
  /** Whether any of these chats is open in a TUI. */
  isOpen(sessionIDs: readonly string[]): boolean
}

export function createAttentionStore(options: { readonly now?: () => number } = {}): AttentionStore {
  const now = options.now ?? Date.now
  const startedAt = now()
  const claims = new Set<string>()
  const players = new Map<string, number>()
  const shells = new Map<string, string>()
  const parents = new Map<string, string | null>()
  const notices = new Set<string>()
  const tuis = new Map<string, { readonly at: number; readonly chats: ReadonlySet<string> }>()
  const bounded = <T>(set: Set<T> | Map<T, unknown>, max: number) => {
    for (const key of [...set.keys()].slice(0, Math.max(0, set.size - max))) set.delete(key)
  }
  const live = () => {
    const at = now()
    for (const [id, seen] of players) if (at - seen >= PLAYER_TTL_MS) players.delete(id)
    return players.size
  }
  const reporting = () => {
    const at = now()
    for (const [id, report] of tuis) if (at - report.at >= PLAYER_TTL_MS) tuis.delete(id)
    return [...tuis.values()]
  }
  return {
    claim(eventID) {
      if (claims.has(eventID)) return false
      claims.add(eventID)
      bounded(claims, MAX_CLAIMS)
      return true
    },
    player(id) {
      players.delete(id)
      players.set(id, now())
      return live()
    },
    players: live,
    shellStarted(shellID, sessionID) {
      shells.set(shellID, sessionID)
    },
    shellExited(shellID) {
      shells.delete(shellID)
    },
    shells(sessionID) {
      return [...shells.values()].filter((owner) => owner === sessionID).length
    },
    parent: (sessionID) => parents.get(sessionID),
    setParent(sessionID, parent) {
      parents.set(sessionID, parent)
      bounded(parents, MAX_PARENTS)
    },
    opened(id, sessionIDs) {
      tuis.delete(id)
      if (sessionIDs.length > 0) tuis.set(id, { at: now(), chats: new Set(sessionIDs) })
      return reporting().length
    },
    isOpen: (sessionIDs) => reporting().some((report) => sessionIDs.some((id) => report.chats.has(id))),
    newNotice(requestID, at) {
      if (notices.has(requestID)) return false
      notices.add(requestID)
      bounded(notices, MAX_NOTICES)
      return at >= startedAt
    },
  }
}

/** The one store every Plus instance in this process shares: chats are global, not per directory. */
export const attentionStore = createAttentionStore()

/** What happened in a chat, before the settings say which event it is. */
export type AttentionOccurrence =
  /** A turn succeeded. `waiting`: something the chat started still runs (a child then is not done). */
  | { readonly type: "turn"; readonly waiting: boolean }
  | { readonly type: "failed" }
  | { readonly type: "question" }
  | { readonly type: "cacheMiss" }

/**
 * Which event an occurrence raises, if any. `depth` is how far below its root chat the chat is;
 * `own` are the settings of the chat's agent, `root` those of the root chat's agent.
 */
export function decideAttention(
  occurrence: AttentionOccurrence,
  depth: number,
  own: AttentionSettings,
  root: AttentionSettings,
): { readonly kind: AttentionKind; readonly settings: AttentionEventSettings } | undefined {
  const childReach = attentionOn(root.child) && depth <= root.child.depth
  if (occurrence.type === "question") return attentionOn(own.question) ? { kind: "question", settings: own.question } : undefined
  if (occurrence.type === "cacheMiss") return attentionOn(own.cacheMiss) ? { kind: "cacheMiss", settings: own.cacheMiss } : undefined
  if (occurrence.type === "failed") {
    if (!attentionOn(own.error) || (depth > 0 && !childReach)) return undefined
    return { kind: "error", settings: own.error }
  }
  if (depth > 0) return childReach && !occurrence.waiting ? { kind: "child", settings: root.child } : undefined
  if (!occurrence.waiting && attentionOn(own.done)) return { kind: "done", settings: own.done }
  return attentionOn(own.reply) ? { kind: "reply", settings: own.reply } : undefined
}
