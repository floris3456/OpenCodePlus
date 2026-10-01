import type { SessionMessage } from "./message.js"

/** Derived from committed history, never from a queued compaction or a UI event. */
export function compactionBoundary(messages: ReadonlyArray<SessionMessage.Info>) {
  const index = messages.findLastIndex((message) => message.type === "compaction" && message.status === "completed")
  const checkpoint = messages[index]
  const portable = !messages.some(
    (message) => message.type === "compaction" && message.status === "completed" && !!message.providerContext,
  )
  const advanced = messages
    .slice(index + 1)
    .some((message) => message.type === "assistant" && (!message.error || message.content.length > 0))
  return {
    fresh: index < 0 && !advanced,
    portable,
    ...(portable && !advanced && checkpoint ? { checkpoint: checkpoint.id } : {}),
  }
}
