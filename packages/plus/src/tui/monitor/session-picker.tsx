import type { Plugin } from "@opencode/plugin/tui"
import type { Plus } from "../../rpc.js"
import { formatClock, formatTokens } from "./format.js"

export async function openSessionPicker(
  context: Plugin.Context,
  sessions: readonly Plus.MonitorSessionRow[] | undefined,
  onPick: (sessionID: string) => void,
  paging?: {
    page: Plus.MonitorPage | undefined
    load: (
      cursor: NonNullable<Plus.MonitorPage["next"]>,
    ) => Promise<{ sessions: readonly Plus.MonitorSessionRow[]; page: Plus.MonitorPage | undefined }>
  },
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
    placeholder: paging ? "Search sessions on this page…" : "Search sessions…",
    options: [
      ...options,
      ...(paging?.page?.previous ? [{ title: "Previous page", value: "\0previous" }] : []),
      ...(paging?.page?.next ? [{ title: "Next page", value: "\0next" }] : []),
    ],
  })

  context.ui.dialog.clear()
  if (paging && (picked === "\0next" || picked === "\0previous")) {
    const cursor = picked === "\0next" ? paging.page?.next : paging.page?.previous
    if (!cursor) return
    const next = await paging.load(cursor)
    return openSessionPicker(context, next.sessions, onPick, { ...paging, page: next.page })
  }
  if (picked !== undefined && picked !== "") {
    onPick(picked)
  }
}
