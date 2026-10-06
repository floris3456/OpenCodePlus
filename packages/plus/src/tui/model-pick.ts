import type { Plugin } from "@opencode/plugin/tui"
import { Definition } from "../rpc.js"

// A completed user pick (/models, the variant dialog, Ctrl+T cycle effort)
// becomes the agent's active model row in Plus, so it survives new chats and
// agent switches. The local selection already applies to this chat; a failed
// save only shows an error toast and changes nothing else. Programmatic model
// changes do not emit, so commands, subagents and team runs never rewrite the
// user's rows.
export function createModelPick(context: Plugin.Context) {
  const plus = context.client.rpc(Definition)
  const dispose = context.ui.model.onPick((pick) => {
    void plus["model.pick"](
      {
        agent: pick.agent,
        providerID: pick.providerID,
        modelID: pick.modelID,
        ...(pick.variant === undefined ? {} : { variant: pick.variant }),
      },
      { location: pick.location },
    ).catch((error: unknown) => {
      context.ui.toast.show({ variant: "error", message: error instanceof Error ? error.message : String(error) })
    })
  })
  return { dispose }
}
