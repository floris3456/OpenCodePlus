import { useRenderer } from "@opentui/solid"
import { createSignal, For, onCleanup } from "solid-js"
import { Keymap } from "../context/keymap"
import { useTheme } from "../context/theme"

export function KeymapDebug() {
  const keymap = Keymap.use()
  const renderer = useRenderer()
  const theme = useTheme("overlay")
  const [entries, setEntries] = createSignal<readonly string[]>([])
  const [lastRaw, setLastRaw] = createSignal("")

  const offRaw = keymap.intercept("raw", (ctx) => {
    setLastRaw(ctx.sequence)
  })
  const offAfter = keymap.intercept("key:after", (ctx) => {
    const bytes = formatBytes(lastRaw())
    const name = ctx.event.name
    const kitty = renderer.useKittyKeyboard ? "on" : "off"
    const handledBy = ctx.handled ? `handled:${ctx.reason}` : ctx.reason
    const line = `${bytes} | ${name} | kitty:${kitty} | ${handledBy}`
    setEntries((prev) => [...prev.slice(-4), line])
    setLastRaw("")
  })
  onCleanup(() => {
    offRaw()
    offAfter()
  })

  return (
    <box
      position="absolute"
      zIndex={9000}
      bottom={1}
      left={0}
      right={0}
      flexDirection="column"
      backgroundColor={theme.background.feedback.info.default}
      border={["top"]}
      borderColor={theme.text.feedback.info.default}
      paddingLeft={2}
      paddingRight={2}
      paddingTop={1}
      paddingBottom={1}
    >
      <text fg={theme.text.feedback.info.default}>Keymap debug</text>
      <For each={entries()}>
        {(line) => <text fg={theme.text.feedback.info.default}>{line}</text>}
      </For>
    </box>
  )
}

function formatBytes(raw: string) {
  if (raw.length === 0) return "<none>"
  return JSON.stringify(raw).slice(1, -1)
}
