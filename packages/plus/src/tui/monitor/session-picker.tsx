import type { Plugin } from "@opencode/plugin/tui"
import type { Plus } from "../../rpc.js"
import { formatClock, formatTokens } from "./format.js"

export async function openSessionPicker(
  context: Plugin.Context,
  sessions: readonly Plus.MonitorSessionRow[] | undefined,
  onPick: (sessionID: string) => void,
): Promise<void> {
  if (sessions === undefined || sessions.length === 0) {
    context.ui.toast.show({ variant: "info", message: "No sessions found in ledger" })
    return
  }

  // Determine which rootIDs have multiple entries (trees) vs single stand-alone entries.
  const rootCounts = new Map<string, number>()
  for (const s of sessions) {
    rootCounts.set(s.rootID, (rootCounts.get(s.rootID) ?? 0) + 1)
  }

  const options = sessions.map((s) => {
    const isTree = (rootCounts.get(s.rootID) ?? 0) > 1
    const prefix = s.depth > 0 ? "  ".repeat(s.depth) + "└─ " : isTree ? "▼ " : "• "
    const name = s.title ?? s.role ?? s.agent ?? s.sessionID.slice(0, 12)
    const agent = s.agent ? ` · ${s.agent}` : ""
    const time = ` · ${formatClock(s.lastActive)}`
    const stats = ` · ${s.steps} steps · ${formatTokens(s.input + s.cacheRead)} in`
    return {
      title: `${prefix}${name}${agent}${time}${stats}`,
      value: s.sessionID,
    }
  })

  const picked = await context.ui.dialog.select<string>({
    title: "Pick session to scope",
    placeholder: "Search sessions…",
    options,
  })

  context.ui.dialog.clear()
  if (picked !== undefined && picked !== "") {
    onPick(picked)
  }
}
