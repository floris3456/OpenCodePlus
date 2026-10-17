import type { SessionMessage } from "./message.js"

/** Derived from committed history, never from a queued compaction or a UI event. */
export function compactionBoundary(messages: ReadonlyArray<SessionMessage.Info>) {
  const index = messages.findLastIndex((message) => message.type === "compaction" && message.status === "completed")
  const checkpoint = messages[index]
  const portable = !messages.some(
    (message) => message.type === "compaction" && message.status === "completed" && !!message.providerContext,
  )
  // A step held for a retry leaves an empty, unfinished assistant behind; it consumed nothing.
  const advanced = messages
    .slice(index + 1)
    .some(
      (message) =>
        message.type === "assistant" &&
        (message.content.length > 0 || (message.time.completed !== undefined && !message.error)),
    )
  return {
    fresh: index < 0 && !advanced,
    portable,
    ...(portable && !advanced && checkpoint ? { checkpoint: checkpoint.id } : {}),
  }
}
