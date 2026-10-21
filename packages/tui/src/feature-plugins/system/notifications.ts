import { Plugin } from "@opencode/plugin/tui"
import type { AttentionSoundName } from "@opencode/plugin/tui/context"
import { Definition } from "@opencode/plus/rpc"

function notifyFor(
  context: Plugin.Context,
  sessionID: string | undefined,
  message: string,
  sound: AttentionSoundName,
  title?: string,
) {
  const session = sessionID ? context.data.session.get(sessionID) : undefined
  const isSubagent = session?.parentID !== undefined
  void context.attention.notify({
    title: title ?? session?.title,
    message,
    notification: isSubagent ? false : { when: "blurred" },
    sound: { name: sound, when: "always" },
  })
}

// A Plus server's RPC is also unavailable while its folder loads or reloads, so "no Plus" is
// asked again before a notification once that answer is older than this. Plus's answer is final.
const RECHECK_MS = 30_000

export default Plugin.define({
  id: "opencode.notifications",
  setup(context) {
    // An OpenCodePlus server decides notifications itself (its `attention` event, shown by
    // packages/plus/src/tui/attention.ts); these are for a server without Plus.
    const plus = { present: undefined as boolean | undefined, at: 0 }
    const probe = () => {
      plus.at = Date.now()
      return context.client.rpc(Definition)["settings.get"](undefined).then(
        () => (plus.present = true),
        (error: unknown) => (plus.present = (error as { type?: unknown } | undefined)?.type !== "rpc.unavailable"),
      )
    }
    void probe()
    const notify = (...args: Parameters<typeof notifyFor>) => {
      if (plus.present === true) return
      if (plus.present === false && Date.now() - plus.at < RECHECK_MS) return notifyFor(...args)
      void probe().then((present) => {
        if (!present) notifyFor(...args)
      })
    }
    const errored = new Set<string>()
    const terminal = new Set<string>()
    const forms = new Set<string>()
    const permissions = new Set<string>()

    const started = (sessionID: string) => {
      errored.delete(sessionID)
      terminal.delete(sessionID)
    }
    const ended = (sessionID: string) => {
      if (terminal.has(sessionID)) return
      terminal.add(sessionID)
      if (errored.has(sessionID)) {
        errored.delete(sessionID)
        return
      }
      const session = context.data.session.get(sessionID)
      notify(context, sessionID, "Session done", session?.parentID ? "subagent_done" : "done")
    }

    const dispose = [
      context.data.on("form.created", (event) => {
        if (forms.has(event.data.form.id)) return
        forms.add(event.data.form.id)
        notify(context, event.data.form.sessionID, "Input needs response", "question", event.data.form.title)
      }),
      context.data.on("form.replied", (event) => forms.delete(event.data.id)),
      context.data.on("form.cancelled", (event) => forms.delete(event.data.id)),
      context.data.on("permission.asked", (event) => {
        if (permissions.has(event.data.id)) return
        permissions.add(event.data.id)
        notify(context, event.data.sessionID, "Permission needs input", "permission")
      }),
      context.data.on("permission.replied", (event) => permissions.delete(event.data.requestID)),
      context.data.on("session.execution.started", (event) => started(event.data.sessionID)),
      context.data.on("session.execution.succeeded", (event) => ended(event.data.sessionID)),
      context.data.on("session.execution.interrupted", (event) => {
        if (event.data.reason !== "user") return ended(event.data.sessionID)
        // A stop the user made (Esc Esc, or a parent stopped with its subagent) is no news to them.
        terminal.add(event.data.sessionID)
        errored.delete(event.data.sessionID)
      }),
      context.data.on("session.execution.failed", (event) => {
        const sessionID = event.data.sessionID
        if (terminal.has(sessionID)) return
        if (errored.has(sessionID)) {
          ended(sessionID)
          return
        }
        errored.add(sessionID)
        notify(context, sessionID, event.data.error.message, "error")
        context.ui.toast.show({ sessionID, title: "Session failed", message: event.data.error.message, variant: "error" })
        ended(sessionID)
      }),
    ]

    return () => dispose.reverse().forEach((cleanup) => cleanup())
  },
})
