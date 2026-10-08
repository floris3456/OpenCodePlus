import { warmingStore } from "../warming.js"

// One armed list per session: #1 writes the next compaction's summary, #2… are
// its fallbacks. A team `compactWith` arms a list of one; `compaction.cold`
// arms the chat's cold-cache list.
const armedCompactions = new Map<string, readonly string[]>()

export function armColdCompaction(sessionID: string, models: readonly string[]): void {
  armedCompactions.set(sessionID, models)
}

export function consumeColdCompaction(sessionID: string): readonly string[] | undefined {
  const models = armedCompactions.get(sessionID)
  if (models === undefined) return undefined
  armedCompactions.delete(sessionID)
  return models
}

export async function isSessionWarm(sessionID: string, now = Date.now()): Promise<boolean> {
  const status = await warmingStore.status(sessionID, now)
  if (status.source === undefined && status.expires === undefined) {
    return true
  }
  if (status.active || (status.expires !== undefined && now < status.expires)) {
    return true
  }
  if (status.lastWarm !== undefined && status.interval !== undefined && now - status.lastWarm < status.interval) {
    return true
  }
  return false
}
