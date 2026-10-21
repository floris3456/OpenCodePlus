import type { Plugin } from "@opencode/plugin/tui"
import { Show } from "solid-js"

// Text an agent reads (a prompt, a skill, a tool's or an agent's description)
// rendered as markdown the way the chat renders a reply: the host's syntax
// style, code-block renderers and rendered/raw choice.
//
// opentui reuses the blocks of the previous content that are still a prefix of
// the new one, so a block the new text extends would render split in two. A
// `live` text (the editor's draft) keeps one view in streaming mode, which
// rereads its last blocks on each keystroke; any other text gets a fresh view
// for each new text (the sidebar moving between a section and its whole row).
export function MarkdownText(props: { readonly context: Plugin.Context; readonly content: string; readonly live?: boolean }) {
  const view = (content: () => string, streaming: boolean) => (
    <markdown
      flexShrink={0}
      syntaxStyle={props.context.markdown.syntax()}
      renderNode={props.context.markdown.renderNode()}
      content={content()}
      streaming={streaming}
      conceal={props.context.markdown.concealed()}
      internalBlockMode="top-level"
      tableOptions={{ style: "grid", cellPaddingX: 1 }}
      fg={props.context.theme.markdown.text}
      bg={props.context.theme.background.base}
    />
  )
  return (
    <Show when={props.live !== true} fallback={view(() => props.content, true)}>
      <Show when={props.content} keyed>
        {(content) => view(() => content, false)}
      </Show>
    </Show>
  )
}
