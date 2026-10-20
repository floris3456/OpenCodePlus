import { formatTokens } from "./tui/monitor/format.js"
import { attentionStore, decideAttention, type AttentionOccurrence, type AttentionStore } from "./attention.js"
import type { AttentionKind, AttentionSettings, Plus } from "./rpc.js"

// The server half of notifications (docs/plans/plus-1.3.18-notifications.md): each host event
// that can raise attention is decided once per process and emitted as the Plus RPC event
// `attention` to every client of the server.

export const ATTENTION_EVENTS: ReadonlySet<string> = new Set([
  "session.execution.succeeded",
  "session.execution.failed",
  "form.created",
  "permission.asked",
  "shell.created",
  "shell.exited",
  "session.step.ended",
])

export interface AttentionChat {
  readonly agent?: string
  readonly title?: string
}

export interface AttentionDeps {
  /** The chat that started this one: a subagent's parent, a team worker's lead (undefined: top level). */
  readonly parentOf: (sessionID: string) => Promise<string | undefined>
  readonly chatOf: (sessionID: string) => Promise<AttentionChat | undefined>
  /** The settings an agent resolves (undefined: the global ones). */
  readonly settingsFor: (agent: string | undefined) => Promise<AttentionSettings>
  /** Whether a subagent or team worker this chat started still runs. */
  readonly workRuns: (sessionID: string) => Promise<boolean>
  readonly notices: () => Promise<readonly Plus.MonitorNotice[]>
  readonly emit: (attention: Plus.Attention) => Promise<void>
  readonly store?: AttentionStore
  readonly now?: () => number
  /** How long after a step ends its cache notice is looked for (the monitor records it first). */
  readonly noticeDelayMs?: number
}

export interface AttentionHostEvent {
  readonly id: string
  readonly type: string
  readonly data?: unknown
}

// A chat's ancestry stops here, so a parent loop cannot hang an event.
const MAX_DEPTH = 16

export function createAttentionWatcher(deps: AttentionDeps) {
  const store = deps.store ?? attentionStore
  const now = deps.now ?? Date.now
  const timer = { notices: undefined as ReturnType<typeof setTimeout> | undefined }

  // The chat itself first, its root last. A known parent is remembered: it never changes.
  const chainOf = async (sessionID: string) => {
    const chain = [sessionID]
    while (chain.length <= MAX_DEPTH) {
      const current = chain[chain.length - 1]
      const known = store.parent(current)
      const parent = known ?? (await deps.parentOf(current).catch(() => undefined))
      if (parent === undefined || parent === null || chain.includes(parent)) break
      if (known === undefined) store.setParent(current, parent)
      chain.push(parent)
    }
    return chain
  }

  const raise = async (input: {
    readonly id: string
    readonly sessionID: string
    readonly occurrence: (depth: number) => Promise<AttentionOccurrence> | AttentionOccurrence
    readonly message: (subject: string | undefined, kind: AttentionKind) => string
    readonly agent?: string
  }) => {
    const chain = await chainOf(input.sessionID)
    // Only the chats open in a TUI notify; a subagent or team member counts through the chat above it.
    if (!store.isOpen(chain)) return
    const rootID = chain[chain.length - 1]
    const depth = chain.length - 1
    const [chat, root] = await Promise.all([
      deps.chatOf(input.sessionID).catch(() => undefined),
      depth === 0 ? undefined : deps.chatOf(rootID).catch(() => undefined),
    ])
    const agent = input.agent ?? chat?.agent
    const own = await deps.settingsFor(agent)
    const rootSettings = depth === 0 ? own : await deps.settingsFor(root?.agent)
    const decided = decideAttention(await input.occurrence(depth), depth, own, rootSettings)
    if (decided === undefined) return
    await deps.emit({
      id: input.id,
      kind: decided.kind,
      sessionID: input.sessionID,
      rootID,
      depth,
      ...(agent === undefined ? {} : { agent }),
      title: (depth === 0 ? chat?.title : root?.title) ?? "OpenCodePlus",
      message: input.message(depth === 0 ? undefined : (chat?.title ?? agent), decided.kind),
      notify: decided.settings.notify,
      ...(decided.settings.sound === "off" ? {} : { sound: decided.settings.sound }),
      player: store.players() > 0,
      at: now(),
    })
  }

  const lookForNotices = () => {
    clearTimeout(timer.notices)
    timer.notices = setTimeout(() => {
      void deps.notices().then(
        (notices) =>
          Promise.all(
            notices
              .filter((notice) => store.newNotice(notice.requestID, notice.at))
              .map((notice) =>
                raise({
                  id: `notice:${notice.requestID}`,
                  sessionID: notice.sessionID,
                  ...(notice.agent === undefined ? {} : { agent: notice.agent }),
                  occurrence: () => ({ type: "cacheMiss" }),
                  message: (subject) =>
                    `${subject === undefined ? "" : `${subject}: `}cache ${notice.verdict === "miss" ? "miss" : "partly reused"}, ${formatTokens(notice.missTokens)} tokens not reused (${notice.causeText})`,
                }).catch(() => undefined),
              ),
          ),
        () => undefined,
      )
    }, deps.noticeDelayMs ?? 1_500)
    timer.notices.unref?.()
  }

  const handle = async (event: AttentionHostEvent) => {
    if (!ATTENTION_EVENTS.has(event.type) || !store.claim(event.id)) return
    const data = (event.data ?? {}) as Record<string, unknown>
    const sessionID = typeof data.sessionID === "string" ? data.sessionID : undefined
    const prefixed = (subject: string | undefined, text: string) => (subject === undefined ? text : `${subject}: ${text}`)
    if (event.type === "shell.created") {
      const info = data.info as { readonly id?: unknown; readonly metadata?: { readonly sessionID?: unknown } } | undefined
      if (typeof info?.id === "string" && typeof info.metadata?.sessionID === "string") store.shellStarted(info.id, info.metadata.sessionID)
      return
    }
    if (event.type === "shell.exited") {
      if (typeof data.id === "string") store.shellExited(data.id)
      return
    }
    if (event.type === "session.step.ended") return lookForNotices()
    if (event.type === "session.execution.succeeded" && sessionID !== undefined)
      return raise({
        id: event.id,
        sessionID,
        // Only a top-level chat's own waiting work decides between done and reply.
        occurrence: async (depth) => ({
          type: "turn",
          waiting: depth === 0 && ((await deps.workRuns(sessionID).catch(() => false)) || store.shells(sessionID) > 0),
        }),
        message: (subject, kind) => (kind === "reply" ? "Replied; its work still runs" : subject === undefined ? "Done" : `${subject} is done`),
      })
    if (event.type === "session.execution.failed" && sessionID !== undefined) {
      const error = (data.error as { readonly message?: unknown } | undefined)?.message
      return raise({
        id: event.id,
        sessionID,
        occurrence: () => ({ type: "failed" }),
        message: (subject) => prefixed(subject, typeof error === "string" && error.length > 0 ? error : "Failed"),
      })
    }
    if (event.type === "form.created") {
      const form = data.form as { readonly sessionID?: unknown; readonly title?: unknown } | undefined
      if (typeof form?.sessionID !== "string") return
      return raise({
        id: event.id,
        sessionID: form.sessionID,
        occurrence: () => ({ type: "question" }),
        message: (subject) => prefixed(subject, typeof form.title === "string" && form.title.length > 0 ? form.title : "Input needs a response"),
      })
    }
    if (event.type === "permission.asked" && sessionID !== undefined)
      return raise({
        id: event.id,
        sessionID,
        occurrence: () => ({ type: "question" }),
        message: (subject) => prefixed(subject, `Permission needs input${typeof data.action === "string" ? `: ${data.action}` : ""}`),
      })
  }

  return {
    handle,
    dispose() {
      clearTimeout(timer.notices)
    },
  }
}
