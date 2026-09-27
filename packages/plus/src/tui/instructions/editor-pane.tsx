import { TextAttributes } from "@opentui/core"
import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createSignal, Show } from "solid-js"
import { unifiedDiff } from "../../instructions/diff-lines.js"
import { KeyHints } from "./row.js"

export interface EditorPaneProps {
  readonly context: Plugin.Context
  readonly title: string
  readonly path?: string
  readonly initial: string
  readonly active: () => boolean
  /** Resolves true when saved; a refusal keeps the draft open. */
  readonly onSave: (text: string) => Promise<boolean>
  readonly onClose: () => void
}

interface Editor {
  readonly plainText: string
  readonly isDestroyed: boolean
  focus(): void
  blur(): void
  gotoBufferEnd(): void
}

// Full-width text editor for one row. ctrl+d previews the change against the
// text the edit started from; esc asks before a changed draft is dropped.
export function EditorPane(props: EditorPaneProps) {
  const theme = () => props.context.theme
  const dimensions = useTerminalDimensions()
  const [draft, setDraft] = createSignal(props.initial)
  const [preview, setPreview] = createSignal(false)
  let area: Editor | undefined

  const dirty = () => draft() !== props.initial

  createEffect(() => {
    if (preview() || !props.active()) return
    const target = area
    if (target === undefined || target.isDestroyed) return
    target.focus()
    target.gotoBufferEnd()
  })

  async function save() {
    const text = area !== undefined && !area.isDestroyed ? area.plainText : draft()
    setDraft(text)
    if (await props.onSave(text)) props.onClose()
  }

  async function close() {
    if (preview()) {
      setPreview(false)
      return
    }
    if (dirty()) {
      const discard = await props.context.ui.dialog.confirm({
        title: "Discard changes?",
        message: `Your edit of "${props.title}" is not saved.`,
        label: { confirm: "Discard", cancel: "Keep editing" },
      })
      if (discard !== true) return
    }
    area?.blur()
    props.onClose()
  }

  props.context.keymap.layer(() => {
    if (!props.active()) return { commands: [] }
    return {
      commands: [
        { bind: "ctrl+s", title: "Save text", group: "Instructions", run: () => void save() },
        { bind: "ctrl+d", title: "Preview change", group: "Instructions", run: () => {
          if (area !== undefined && !area.isDestroyed) setDraft(area.plainText)
          setPreview(!preview())
        } },
        { bind: "escape", title: "Cancel editing", group: "Instructions", run: () => void close() },
      ],
    }
  })

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1}>
      <box flexDirection="row" flexShrink={0} gap={1}>
        <text flexShrink={0} fg={theme().text.default} attributes={TextAttributes.BOLD}>
          {props.title}
        </text>
        <Show when={props.path}>
          {(path) => (
            <text flexGrow={1} minWidth={0} wrapMode="none" truncate fg={theme().text.subdued}>
              {path()}
            </text>
          )}
        </Show>
        <text flexShrink={0} fg={dirty() ? theme().text.feedback.info.default : theme().text.subdued}>
          {dirty() ? "edited" : "editing"}
        </text>
      </box>
      <Show
        when={!preview()}
        fallback={
          <scrollbox flexGrow={1} minHeight={0} paddingTop={1}>
            <Show when={dirty()} fallback={<text fg={theme().text.subdued}>No changes yet</text>}>
              <diff
                diff={unifiedDiff(props.initial, draft(), { from: "before", to: "after" })}
                view={dimensions().width >= 120 ? "split" : "unified"}
                showLineNumbers={true}
                width="100%"
                wrapMode="word"
                fg={theme().text.default}
                addedBg={theme().diff.background.added}
                removedBg={theme().diff.background.removed}
                contextBg={theme().diff.background.context}
                addedSignColor={theme().diff.highlight.added}
                removedSignColor={theme().diff.highlight.removed}
                lineNumberFg={theme().diff.lineNumber.text}
                lineNumberBg={theme().diff.background.context}
                addedLineNumberBg={theme().diff.lineNumber.background.added}
                removedLineNumberBg={theme().diff.lineNumber.background.removed}
              />
            </Show>
          </scrollbox>
        }
      >
        <box flexGrow={1} minHeight={0} paddingTop={1}>
          <textarea
            flexGrow={1}
            initialValue={draft()}
            textColor={theme().text.formfield.default}
            focusedTextColor={theme().text.formfield.focused}
            cursorColor={theme().text.formfield.focused}
            ref={(next) => {
              area = next
            }}
            onContentChange={() => {
              if (area === undefined || area.isDestroyed) return
              setDraft(area.plainText)
            }}
          />
        </box>
      </Show>
      <KeyHints
        context={props.context}
        hints={preview() ? [["ctrl+d", "back to editing"], ["ctrl+s", "save"], ["esc", "back"]] : [["ctrl+s", "save"], ["ctrl+d", "preview change"], ["esc", dirty() ? "discard…" : "cancel"]]}
      />
    </box>
  )
}
