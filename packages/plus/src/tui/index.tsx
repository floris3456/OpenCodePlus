import { Plugin } from "@opencode/plugin/tui"
import { createProjectMode } from "./project-mode.js"

export default Plugin.define({
  id: "opencode.plus",
  setup(context) {
    const mode = createProjectMode(context)
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
          ],
        }))
        return null
      },
    })
    return () => {
      disposeSlot()
      mode.dispose()
    }
  },
})
