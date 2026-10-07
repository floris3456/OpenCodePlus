import { warmingStore } from "../warming.js"

const armedCompactions = new Map<string, string>()

export function armColdCompaction(sessionID: string, model: string): void {
  armedCompactions.set(sessionID, model)
}

export function consumeColdCompaction(sessionID: string): string | undefined {
  const model = armedCompactions.get(sessionID)
  if (model === undefined) return undefined
  armedCompactions.delete(sessionID)
  return model
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
