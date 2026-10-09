import type { Plugin } from "@opencode/plugin/tui"
import { For } from "solid-js"
import type { Plus } from "../../rpc.js"

/** The selected bounded evidence collection; every allow-listed field is
 * inspectable, including facts that used to appear only as an aggregate count. */
export function RequestFacts(props: {
  context: Plugin.Context
  detail: Plus.MonitorRequestDetail
  collection: Plus.MonitorPageSection
}) {
  const facts = () => {
    const detail = props.detail
    switch (props.collection) {
      case "detail.lines":
        return detail.lines
      case "detail.calls":
        return (detail.calls ?? []).map((call) => JSON.stringify(call))
      case "detail.pings":
        return detail.pings.map((ping) => JSON.stringify(ping))
      case "detail.accounts":
        return detail.accounts.map((account) => JSON.stringify(account))
      case "detail.instructions":
        return detail.instructions.map((entry) => JSON.stringify(entry))
      case "detail.reverts":
        return detail.reverts.map((revert) => JSON.stringify(revert))
      default:
        return detail.segments.map((segment) => JSON.stringify(segment))
    }
  }
  return (
    <box flexDirection="column" flexGrow={1} minHeight={0}>
      <text
        fg={props.context.theme.text.base}
      >{`Request Detail: ${props.detail.request.id} · ${props.collection}`}</text>
      <scrollbox flexGrow={1} minHeight={0}>
        <For each={facts()} fallback={<text fg={props.context.theme.text.muted}>No facts on this page.</text>}>
          {(fact) => (
            <text fg={props.context.theme.text.base} flexShrink={0}>
              {fact}
            </text>
          )}
        </For>
      </scrollbox>
    </box>
  )
}
