import type { SessionRequest } from "@opencode/plugin/effect/session"

type Message = SessionRequest["messages"][number]
type ContentPart = Message["content"][number]

/** Keep readable context and tool pairs, removing account-bound continuation proof. */
export function portableMessages(messages: ReadonlyArray<Message>) {
  return messages.map((message) => ({
    ...message,
    providerMetadata: undefined,
    native: undefined,
    content: message.content.flatMap((part): ContentPart[] => {
      if (part.type === "compaction")
        throw new Error("An opaque checkpoint needs local compaction before account handoff")
      if (part.type === "reasoning") return part.text ? [{ type: "text", text: part.text }] : []
      if (part.type === "effort") return []
      return [{ ...part, providerMetadata: undefined }]
    }),
  }))
}
