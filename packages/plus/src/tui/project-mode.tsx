import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createRoot, createSignal } from "solid-js"
import { Definition } from "../rpc.js"
import type { Status } from "../rpc.js"

export function createProjectMode(context: Plugin.Context) {
  const plus = context.client.rpc(Definition)
  return createRoot((disposeRoot) => {
    const [status, setStatus] = createSignal<Status>({ enabled: false, directory: "" })
    let disposed = false
    let generation = 0

    // The RPC location query uses `workspace`; map the plugin location refs
    // (which carry `workspaceID`) instead of forwarding them verbatim.
    function targetLocation() {
      const current = context.location
      if (current !== undefined) return { directory: current.directory, workspace: current.workspaceID }
      const fallback = context.data.location.default()
      if (fallback === undefined) return undefined
      return { directory: fallback.directory, workspace: fallback.workspaceID }
    }

    function refresh() {
      const requestGen = ++generation
      const location = targetLocation()
      void plus["project.status"](undefined, { location }).then(
        (current) => {
          if (disposed || requestGen !== generation) return
          setStatus(current)
        },
        (error: unknown) => {
          if (disposed || requestGen !== generation) return
          context.ui.toast.show({
            variant: "error",
            message: error instanceof Error ? error.message : String(error),
          })
        },
      )
    }

    // Setup runs before location hydration lands, so a one-shot setup fetch
    // never observes the opened project. Resolve the status once the location
    // is ready and refetch whenever it changes instead.
    createEffect(() => {
      targetLocation()
      refresh()
    })

    const unsubscribe = plus.events.on("project.changed", (event) => {
      if (disposed) return
      generation++
      setStatus(event.data)
    })

  async function toggle() {
    const current = status()
    const location = targetLocation()
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
        ? await plus["project.disable"](undefined, { location })
        : await plus["project.enable"](undefined, { location })
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

  function dispose() {
    disposed = true
    generation++
    unsubscribe()
    disposeRoot()
  }

  return { status, toggle, dispose }
  })
}
