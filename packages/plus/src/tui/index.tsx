import { Plugin } from "@opencode/plugin/tui"
import { createSignal } from "solid-js"
import { Definition } from "../rpc.js"
import { InstructionsRoute } from "./instructions/route.js"
import { createActiveTeam } from "./active-team.js"
import { createSnapshotCache } from "./snapshot-cache.js"
import { createWarming } from "./warming.js"
import { createModelPick } from "./model-pick.js"
import { createMonitor } from "./monitor/index.js"
import { createChatRefresh } from "./refresh.js"
import { createCacheNotices } from "./cache-notices.js"
import { createThinkingToast } from "./thinking-toast.js"
import { createAttention } from "./attention.js"

export default Plugin.define({
  id: "opencode.plus",
  setup(context) {
    // One stale-while-revalidate cache for the whole plugin: closing the
    // screen keeps the last snapshot, and changes while it is closed only
    // mark it stale (nothing refetches until the next open or dialog read).
    const snapshots = createSnapshotCache({
      events: context.client.rpc(Definition).events,
    })
    const warming = createWarming(context)
    const modelPick = createModelPick(context)
    const activeTeam = createActiveTeam(context)
    const monitor = createMonitor(context, { team: activeTeam.activeTeam })
    const refresh = createChatRefresh(context)
    const thinkingToast = createThinkingToast(context)
    const notices = createCacheNotices(context, { open: (notice) => monitor.openAt(notice) })
    const attention = createAttention(context)
    // The server acts on this one: a message sent into a cold chat is first
    // summarized by the cold-cache models its model has in Instructions.
    const plus = context.client.rpc(Definition)
    const [coldCompact, setColdCompact] = createSignal<boolean>()
    void plus["settings.get"](undefined).then((settings) => setColdCompact(settings.coldCompact), () => {})
    context.ui.settings.register({
      id: "plus.cold-compact",
      title: "Compact cold chats first",
      category: "OpenCodePlus",
      keywords: ["cold cache", "cold-cache models", "compaction", "summary"],
      value: () => {
        const on = coldCompact()
        if (on === undefined) return undefined
        return on ? "on" : "off"
      },
      run: async () => {
        const next = await plus["settings.set"]({ coldCompact: coldCompact() !== true }).catch((error: unknown) => {
          context.ui.toast.show({ variant: "error", message: error instanceof Error ? error.message : String(error) })
          return undefined
        })
        if (next === undefined) return
        setColdCompact(next.coldCompact)
        await warming.refresh()
      },
    })
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
              title: "Open instructions",
              group: "OpenCodePlus",
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
              id: "plus.monitor.open",
              title: "Open monitor",
              group: "OpenCodePlus",
              palette: true,
              bind: "<leader>o",
              slash: { name: "monitor", aliases: ["tools"] },
              run: () => monitor.open(),
            },
            {
              id: "plus.chat.refresh",
              title: "Refresh",
              description: "Reload settings and files",
              group: "OpenCodePlus",
              palette: true,
              slash: { name: "refresh" },
              run: () => refresh.run(),
            },
            {
              id: "plus.warming.toggle",
              title: "Toggle cache warming",
              group: "OpenCodePlus",
              palette: true,
              bind: "<leader>k",
              run: () => warming.toggle(),
            },
            {
              id: "plus.compact.cold",
              title: "Toggle compact before cold",
              group: "OpenCodePlus",
              palette: true,
              bind: "<leader>j",
              slash: { name: "compact-warm" },
              run: () => warming.toggleCompact(),
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
      modelPick.dispose()
      monitor.dispose()
      activeTeam.dispose()
      thinkingToast.dispose()
      notices.dispose()
      attention.dispose()
      snapshots.dispose()
    }
  },
})

export { MonitorView } from "./monitor/view.js"
