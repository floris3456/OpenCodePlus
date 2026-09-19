import { createSignal, For, onCleanup, onMount, Show, type JSX } from "solid-js"
import type { ComposerHint } from "./index"
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

  return (
    <Show when={active()}>
      {props.tab.render({
        sessionID: props.sessionID,
        active,
        close: composer.close,
      })}
    </Show>
  )
}

export function PluginComposerTabs(props: { sessionID: string }) {
  return (
    <For each={tabs()}>
      {(tab) => <SinglePluginTab tab={tab} sessionID={props.sessionID} />}
    </For>
  )
}
