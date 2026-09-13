import type { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { Definition } from "../rpc.js"
import type { Status } from "../rpc.js"

export function createProjectMode(context: Plugin.Context) {
  const plus = context.client.rpc(Definition)
  const [status, setStatus] = createSignal<Status>({ enabled: false, directory: "" })

  void plus["project.status"](undefined, { location: context.location }).then(
    (current) => setStatus(current),
    (error: unknown) => {
      context.ui.toast.show({
        variant: "error",
        message: error instanceof Error ? error.message : String(error),
      })
    },
  )

  const unsubscribe = plus.events.on("project.changed", (event) => {
    setStatus(event.data)
  })

  async function toggle() {
    const current = status()
    const confirmed = await context.ui.dialog.confirm(
      current.enabled
        ? {
            title: "Disable project mode",
            message: `Disable project mode for ${current.directory}?`,
          }
        : {
            title: "Enable project mode",
            message: `Enable project mode for ${current.directory}?`,
          },
    )
    if (!confirmed) return
    try {
      const next = current.enabled
        ? await plus["project.disable"](undefined, { location: context.location })
        : await plus["project.enable"](undefined, { location: context.location })
      setStatus(next)
      context.ui.toast.show({
        variant: "success",
        message: next.enabled
          ? `Project mode enabled for ${next.directory}`
          : `Project mode disabled for ${next.directory}`,
      })
    } catch (error: unknown) {
      context.ui.toast.show({
        variant: "error",
        message: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return { status, toggle, dispose: unsubscribe }
}
