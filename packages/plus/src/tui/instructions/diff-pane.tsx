import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, Show } from "solid-js"
import type { Resolution, ThreeWay } from "../../instructions/model.js"

export interface DiffPaneProps {
  readonly context: Plugin.Context
  readonly title: string
  readonly threeWay: ThreeWay
  readonly active: () => boolean
  readonly review?: boolean
  readonly onResolve: (resolution: Resolution, edited?: string) => Promise<void>
}

interface Editor {
  readonly plainText: string
  readonly isDestroyed: boolean
  focus(): void
  blur(): void
  gotoBufferEnd(): void
}

// Review UI for one node. It only knows ThreeWay strings plus a title, so the
// same pane works for whole items and for sections at any level.
export function DiffPane(props: DiffPaneProps) {
  const [editing, setEditing] = createSignal(false)
  const [draft, setDraft] = createSignal("")
  let area: Editor | undefined

  function startEdit() {
    setDraft(props.threeWay.mine)
    setEditing(true)
  }

  function cancelEdit() {
    area?.blur()
    setDraft("")
    setEditing(false)
  }

  async function saveEdit() {
    const target = area
    if (target === undefined || target.isDestroyed) return
    const text = target.plainText
    setDraft(text)
    await props.onResolve("edit", text)
    setEditing(false)
  }

  createEffect(() => {
    if (!editing()) return
    const target = area
    if (target === undefined || target.isDestroyed) return
    target.focus()
    target.gotoBufferEnd()
  })

  props.context.keymap.layer(() => {
    // Inactive means the route mounted another mode: stay silent so typing
    // and route keys pass through untouched.
    if (!props.active()) return { commands: [] }
    if (editing())
      return {
        commands: [
          { bind: "ctrl+s", title: "Save edit", group: "Instructions", run: () => void saveEdit() },
          { bind: "escape", title: "Cancel editing", group: "Instructions", run: cancelEdit },
        ],
      }
    return {
      commands: [
        { bind: "k", title: "Keep mine", group: "Instructions", run: () => void props.onResolve("keep") },
        { bind: "t", title: "Take new upstream", group: "Instructions", run: () => void props.onResolve("take") },
        { bind: "e", title: "Edit merged text", group: "Instructions", run: startEdit },
      ],
    }
  })

  function hint(): string {
    if (editing()) return "ctrl+s save · esc cancel"
    return "k keep mine · t take new · e edit"
  }

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1}>
      <text flexShrink={0} fg={props.context.theme.text.default}>
        {props.title}
      </text>
      <Show when={props.review !== false}>
        <text flexShrink={0} fg={props.context.theme.text.feedback.warning.default}>
          needs review
        </text>
      </Show>
      <Show
        when={editing()}
        fallback={
          <scrollbox flexGrow={1}>
            {pane(props.context, "Original upstream", props.threeWay.original)}
            {pane(props.context, "Yours", props.threeWay.mine)}
            {pane(props.context, "New upstream", props.threeWay.upstream)}
          </scrollbox>
        }
      >
        <text flexShrink={0} fg={props.context.theme.text.subdued}>
          Yours
        </text>
        <textarea
          flexGrow={1}
          initialValue={draft()}
          textColor={props.context.theme.text.formfield.default}
          focusedTextColor={props.context.theme.text.formfield.focused}
          cursorColor={props.context.theme.text.formfield.focused}
          ref={(next) => {
            area = next
          }}
          onContentChange={() => {
            if (area === undefined || area.isDestroyed) return
            setDraft(area.plainText)
          }}
        />
      </Show>
      <text flexShrink={0} fg={props.context.theme.text.subdued}>
        {hint()}
      </text>
    </box>
  )
}

function pane(context: Plugin.Context, label: string, body: string) {
  return (
    <box flexDirection="column" flexShrink={0}>
      <text fg={context.theme.text.subdued}>
        {label}
      </text>
      <text fg={context.theme.text.default}>
        {body}
      </text>
    </box>
  )
}
