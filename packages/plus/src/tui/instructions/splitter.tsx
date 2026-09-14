import type { Plugin } from "@opencode/plugin/tui"
import { createEffect, createSignal, For, Show } from "solid-js"
import { manual, type Boundary } from "../../instructions/sections.js"

export interface SplitterProps {
  readonly context: Plugin.Context
  readonly title: string
  readonly text: string
  readonly initial?: readonly Boundary[]
  readonly active: () => boolean
  readonly onSave: (boundaries: Boundary[]) => Promise<void>
  readonly onCancel?: () => void
}

interface Draft {
  readonly name: string
  readonly start: number
}

// Manual split interaction for one item. The caller supplies the item text and
// persists the produced Boundary[] (compatible with sections.manual); the same
// manual() call drives the live preview, so preview and save always agree.
export function Splitter(props: SplitterProps) {
  const [bounds, setBounds] = createSignal<readonly Draft[]>(
    (props.initial ?? []).map((boundary) => ({ name: boundary.name, start: boundary.start })),
  )
  const [cursor, setCursor] = createSignal(0)
  const [naming, setNaming] = createSignal<number | undefined>(undefined)
  const [nameDraft, setNameDraft] = createSignal("")
  const [status, setStatus] = createSignal("")
  let field:
    | { plainText: string; isDestroyed: boolean; focus(): void; blur(): void; gotoBufferEnd(): void }
    | undefined

  const starts = () => lineStarts(props.text)
  const lines = () => props.text.split("\n")

  function boundaryAtLine(index: number): number | undefined {
    const at = starts()[index] ?? props.text.length
    const found = bounds().findIndex((boundary) => boundary.start === at)
    return found === -1 ? undefined : found
  }

  function move(delta: number) {
    const max = Math.max(0, lines().length - 1)
    setCursor(Math.min(max, Math.max(0, cursor() + delta)))
  }

  function place() {
    const at = starts()[cursor()] ?? props.text.length
    if (at >= props.text.length) {
      setStatus("cannot place a boundary on the final empty line")
      return
    }
    if (bounds().some((boundary) => boundary.start === at)) {
      setStatus("a boundary already starts on this line")
      return
    }
    const name = `Section ${bounds().length + 1}`
    setBounds([...bounds(), { name, start: at }])
    setStatus("")
    setNameDraft(name)
    setNaming(bounds().length - 1)
  }

  function renameFocused() {
    const index = boundaryAtLine(cursor())
    if (index === undefined) {
      setStatus("no boundary on this line: press b to place one")
      return
    }
    setStatus("")
    setNameDraft(bounds()[index]?.name ?? "")
    setNaming(index)
  }

  function removeFocused() {
    const index = boundaryAtLine(cursor())
    if (index === undefined) {
      setStatus("no boundary on this line")
      return
    }
    setBounds(bounds().filter((_, at) => at !== index))
    setStatus("")
  }

  function confirmName() {
    const target = field
    const index = naming()
    if (target === undefined || target.isDestroyed || index === undefined) return
    const name = target.plainText.trim()
    if (name.length === 0) {
      setStatus("section name cannot be empty")
      return
    }
    setBounds(bounds().map((boundary, at) => (at === index ? { ...boundary, name } : boundary)))
    target.blur()
    setNaming(undefined)
    setStatus("")
  }

  function cancelName() {
    field?.blur()
    setNaming(undefined)
    setStatus("")
  }

  async function save() {
    if (bounds().length === 0) {
      setStatus("place at least one boundary with b first")
      return
    }
    if (bounds().some((boundary) => boundary.name.trim().length === 0)) {
      setStatus("name every section before saving")
      return
    }
    await props.onSave(build())
  }

  function build(): Boundary[] {
    const used = new Set<string>()
    return [...bounds()]
      .sort((left, right) => left.start - right.start)
      .map((boundary) => ({ id: claim(slugify(boundary.name), used), name: boundary.name, start: boundary.start }))
  }

  createEffect(() => {
    if (naming() === undefined) return
    const target = field
    if (target === undefined || target.isDestroyed) return
    target.focus()
    target.gotoBufferEnd()
  })

  props.context.keymap.layer(() => {
    // Inactive means the route mounted another mode: stay silent so typing
    // and route keys pass through untouched.
    if (!props.active()) return { commands: [] }
    if (naming() !== undefined)
      return {
        commands: [
          { bind: "ctrl+s", title: "Confirm section name", group: "Instructions", run: confirmName },
          { bind: "escape", title: "Cancel naming", group: "Instructions", run: cancelName },
        ],
      }
    return {
      commands: [
        { bind: "up", title: "Previous line", group: "Instructions", run: () => move(-1) },
        { bind: "down", title: "Next line", group: "Instructions", run: () => move(1) },
        { bind: "b", title: "Place boundary", group: "Instructions", run: place },
        { bind: "e", title: "Rename section", group: "Instructions", run: renameFocused },
        { bind: "x", title: "Remove boundary", group: "Instructions", run: removeFocused },
        { bind: "ctrl+s", title: "Save sections", group: "Instructions", run: () => void save() },
        ...(props.onCancel === undefined
          ? []
          : [{ bind: "escape", title: "Cancel splitting", group: "Instructions", run: () => props.onCancel?.() }]),
      ],
    }
  })

  function rowText(line: string, index: number): string {
    const mark = cursor() === index ? "›" : " "
    const at = boundaryAtLine(index)
    const tag = at === undefined ? "" : ` ◆ ${bounds()[at]?.name ?? ""}`
    return `${mark} ${line}${tag}`
  }

  function hint(): string {
    if (naming() !== undefined) return "ctrl+s confirm name · esc cancel"
    const base = "up/down move · b boundary · e rename · x remove · ctrl+s save"
    return props.onCancel === undefined ? base : `${base} · esc cancel`
  }

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} paddingLeft={1} paddingRight={1}>
      <text flexShrink={0} fg={props.context.theme.text.default}>
        {props.title} · split into sections
      </text>
      <Show when={status()}>
        {(line) => (
          <text flexShrink={0} fg={props.context.theme.text.subdued}>
            {line()}
          </text>
        )}
      </Show>
      <scrollbox flexGrow={1}>
        <For each={lines()}>
          {(line, index) => (
            <text flexShrink={0} fg={props.context.theme.text.default}>
              {rowText(line, index())}
            </text>
          )}
        </For>
        <text flexShrink={0} fg={props.context.theme.text.subdued}>
          Sections preview
        </text>
        <For each={manual(props.text, build()).sections}>
          {(section) => (
            <text flexShrink={0} fg={props.context.theme.text.default}>
              {` ${section.name} (chars ${section.start}–${section.end})`}
            </text>
          )}
        </For>
      </scrollbox>
      <Show when={naming() !== undefined}>
        <text flexShrink={0} fg={props.context.theme.text.subdued}>
          Name section
        </text>
        <textarea
          height={1}
          wrapMode="none"
          initialValue={nameDraft()}
          textColor={props.context.theme.text.formfield.default}
          focusedTextColor={props.context.theme.text.formfield.focused}
          cursorColor={props.context.theme.text.formfield.focused}
          ref={(next) => {
            field = next
          }}
          onContentChange={() => {
            if (field === undefined || field.isDestroyed) return
            setNameDraft(field.plainText)
          }}
        />
      </Show>
      <text flexShrink={0} fg={props.context.theme.text.subdued}>
        {hint()}
      </text>
    </box>
  )
}

function lineStarts(text: string): number[] {
  const starts = [0]
  let at = text.indexOf("\n")
  while (at !== -1) {
    starts.push(at + 1)
    at = text.indexOf("\n", at + 1)
  }
  return starts
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.length > 0 ? slug : "section"
}

function claim(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let n = 2
  while (used.has(`${base}-${n}`)) n += 1
  used.add(`${base}-${n}`)
  return `${base}-${n}`
}
