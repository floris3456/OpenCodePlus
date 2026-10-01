import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, For, onCleanup } from "solid-js"
import { Definition } from "./rpc.js"
import type { Status } from "./controller.js"

export function createQuota(context: Plugin.Context) {
  const rpc = context.client.rpc(Definition)
  return context.ui.slot({
    append: "session.composer.top",
    render(props) {
      const [notices, setNotices] = createSignal<Status[]>([])
      const load = async () => {
        const session = props.sessionID
        const result = await rpc.status({ sessionID: session }).catch(() => [])
        if (session === props.sessionID) setNotices([...result])
      }
      createEffect(() => {
        props.sessionID
        setNotices([])
        void load()
      })
      const tick = setInterval(() => {
        void load()
      }, 1000)
      onCleanup(() => clearInterval(tick))
      return (
        <For each={notices()}>
          {(notice) => (
            <text
              fg={
                notice.kind === "switched" || notice.kind === "recovered"
                  ? context.theme.text.feedback.success.base
                  : context.theme.text.feedback.warning.base
              }
            >
              {notice.text}
            </text>
          )}
        </For>
      )
    },
  })
}
