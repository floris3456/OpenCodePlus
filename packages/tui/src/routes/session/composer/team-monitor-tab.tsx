import { createSignal, For, onCleanup, onMount, type JSX } from "solid-js"
import { COMPOSER_TAB_BODY_HEIGHT, type ComposerHint } from "./context"
import { useComposerTab } from "./index"

export interface PluginComposerTabRegistration {
  id: string
  label: string
  render: (input: { sessionID: string; active: () => boolean; close: () => void }) => JSX.Element
  hints?: () => readonly ComposerHint[]
}

const [tabs, setTabs] = createSignal<readonly PluginComposerTabRegistration[]>([])

export const composerPluginTabs = {
  register(tab: PluginComposerTabRegistration): () => void {
    setTabs((prev) => [...prev.filter((t) => t.id !== tab.id), tab])
    return () => {
      setTabs((prev) => prev.filter((t) => t.id !== tab.id))
    }
  },
  list(): readonly PluginComposerTabRegistration[] {
    return tabs()
  },
  reset() {
    setTabs([])
  },
}

function SinglePluginTab(props: { tab: PluginComposerTabRegistration; sessionID: string }) {
  const composer = useComposerTab()

  onMount(() => {
    const unregister = composer.register({
      id: props.tab.id,
      label: props.tab.label,
      hints: props.tab.hints ? () => props.tab.hints!() as ComposerHint[] : undefined,
    })
    onCleanup(unregister)
  })

  const active = () => composer.active(props.tab.id)

  // Render the body once, for the tab's lifetime: a body that remounts on
  // every visit starts empty, draws a placeholder and jumps the composer when
  // its data arrives. The container keeps every plugin body at the native
  // body height and hides it, rather than unmounting it, while another tab is
  // active. `sessionID` stays live because the plugin reads it lazily.
  const body = props.tab.render({
    get sessionID() {
      return props.sessionID
    },
    active,
    close: composer.close,
  })

  return (
    <box visible={active()} height={COMPOSER_TAB_BODY_HEIGHT} overflow="hidden">
      <box flexShrink={0} flexDirection="column" minWidth={0}>
        {body}
      </box>
    </box>
  )
}

export function PluginComposerTabs(props: { sessionID: string }) {
  return (
    <For each={tabs()}>
      {(tab) => <SinglePluginTab tab={tab} sessionID={props.sessionID} />}
    </For>
  )
}
