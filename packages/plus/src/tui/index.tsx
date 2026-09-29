import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { Definition } from "../rpc.js"
import { createAgentActions } from "./agents/create.js"
import { InstructionsRoute } from "./instructions/route.js"
import { createActiveTeam } from "./active-team.js"
import { createSnapshotCache } from "./snapshot-cache.js"
import { createWarming } from "./warming.js"

export default Plugin.define({
  id: "opencode.plus",
  setup(context) {
    // One stale-while-revalidate cache for the whole plugin: closing the
    // screen keeps the last snapshot, and changes while it is closed only
    // mark it stale (nothing refetches until the next open or dialog read).
    const snapshots = createSnapshotCache({
      events: context.client.rpc(Definition).events,
    })
    const agents = createAgentActions(context, snapshots)
    const activeTeam = createActiveTeam(context)
    const warming = createWarming(context)
    const [previous, setPrevious] = createSignal({ ...context.ui.router.current() })
    const disposeRoute = context.ui.router.register({
      name: "instructions",
      render: () => <InstructionsRoute context={context} cache={snapshots} onClose={() => context.ui.router.navigate(previous())} />,
    })
    const disposeSlot = context.ui.slot({
      append: "app",
      render() {
        context.keymap.layer(() => ({
          mode: "global",
          commands: [
            {
              id: "plus.instructions.open",
              title: "Instructions",
              group: "Project",
              palette: true,
              bind: "<leader>p",
              slash: { name: "instructions" },
              run() {
                const current = context.ui.router.current()
                if (current.type === "plugin" && current.name === "instructions") return
                // The router exposes a mutable store; retain the route before navigating.
                setPrevious({ ...current })
                context.ui.dialog.clear()
                context.ui.router.navigate({ type: "plugin", name: "instructions" })
              },
            },
            {
              id: "plus.warming.toggle",
              title: "Cache warming on/off for this chat",
              group: "Session",
              palette: true,
              bind: "<leader>k",
              run: () => warming.toggle(),
            },
            {
              id: "plus.warming.follow",
              title: "Cache warming: follow the model settings for this chat",
              group: "Session",
              palette: true,
              run: () => warming.follow(),
            },
            {
              id: "plus.agent.create",
              title: "Create agent",
              group: "Project",
              palette: true,
              run: () => agents.createAgent(),
            },
            {
              id: "plus.agent.rename",
              title: "Rename agent",
              group: "Project",
              palette: true,
              run: () => agents.renameAgent(),
            },
            {
              id: "plus.agent.delete",
              title: "Delete agent",
              group: "Project",
              palette: true,
              run: () => agents.deleteAgent(),
            },
            {
              id: "plus.team.select",
              title: "Select team",
              group: "Project",
              palette: true,
              run: () => {
                context.ui.agents.open({ filter: "Team:" })
              },
            },
          ],
        }))
        return null
      },
    })
    const disposeFooter = context.ui.slot({
      append: "prompt.footer",
      render: (props) => <warming.Footer sessionID={props.sessionID} />,
    })
    return () => {
      disposeRoute()
      disposeSlot()
      disposeFooter()
      warming.dispose()
      agents.dispose()
      activeTeam.dispose()
      snapshots.dispose()
    }
  },
})
