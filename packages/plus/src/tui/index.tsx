import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { InstructionsRoute } from "./instructions/route.js"
import { createProjectMode } from "./project-mode.js"

export default Plugin.define({
  id: "opencode.plus",
  setup(context) {
    const mode = createProjectMode(context)
    const [previous, setPrevious] = createSignal({ ...context.ui.router.current() })
    const disposeRoute = context.ui.router.register({
      name: "instructions",
      render: () => <InstructionsRoute context={context} onClose={() => context.ui.router.navigate(previous())} />,
    })
    const disposeSlot = context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "plus.project.toggle",
              title: "Toggle project mode",
              group: "Project",
              palette: true,
              bind: "<leader>p",
              run: () => mode.toggle(),
            },
            {
              id: "plus.project.status",
              title: "Show project mode status",
              group: "Project",
              palette: true,
              enabled: () => mode.status().enabled,
              run: () => {
                context.ui.toast.show({ message: `Project mode directory: ${mode.status().directory}` })
              },
            },
            {
              id: "plus.instructions.open",
              title: "Instructions",
              group: "Project",
              palette: true,
              slash: { name: "instructions" },
              enabled: () => mode.status().enabled,
              run() {
                const current = context.ui.router.current()
                if (current.type === "plugin" && current.name === "instructions") return
                // The router exposes a mutable store; retain the route before navigating.
                setPrevious({ ...current })
                context.ui.dialog.clear()
                context.ui.router.navigate({ type: "plugin", name: "instructions" })
              },
            },
          ],
        }))
        return null
      },
    })
    return () => {
      disposeRoute()
      disposeSlot()
      mode.dispose()
    }
  },
})
