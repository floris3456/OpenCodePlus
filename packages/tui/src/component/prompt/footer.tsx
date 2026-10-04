import type { BoxRenderable, RGBA } from "@opentui/core"
import { useTerminalDimensions, type JSX } from "@opentui/solid"
import { createEffect, createMemo, createSignal, on, Match, Show, Switch } from "solid-js"
import path from "path"
import { useConfig } from "../../config"
import { useData } from "../../context/data"
import { useEditorContext, type EditorSelection } from "../../context/editor"
import { useLocation } from "../../context/location"
import { useLocal } from "../../context/local"
import { useTuiPaths } from "../../context/runtime"
import { useTheme } from "../../context/theme"
import { abbreviateHome } from "../../runtime"
import { tint } from "../../theme/color"
import { createAnimatable, tween } from "../../ui/animation"
import { truncateFilePath } from "../../ui/file-path"
import { createColors, createFrames } from "../../ui/spinner"
import { useWorkingDirectoryActions } from "../../ui/working-directory-actions"
import { Slot } from "../../plugin/render"
import { Spinner } from "../spinner"
import { usePromptMove } from "./move"
import { Locale } from "../../util/locale"
import type { LocationRef } from "@opencode/client"

export function PromptInterruptStatus(props: {
  armed: boolean
  animations?: boolean
  text: RGBA
  subdued: RGBA
  warning: RGBA
  flash?: RGBA
}) {
  const ignition = createAnimatable(
    { level: 0 },
    { enabled: () => props.animations ?? false, transition: tween({ duration: 0.22 }) },
  )
  createEffect(
    on(
      () => props.armed,
      (armed) => {
        if (!armed || !props.animations) return ignition.jump({ level: 0 })
        ignition.jump({ level: 0.75 })
        ignition.animate({ level: 0 })
      },
      { defer: true },
    ),
  )
  const armedColor = createMemo(() => {
    const level = ignition.value().level
    if (level === 0 || !props.flash) return props.warning
    return tint(props.warning, props.flash, level)
  })

  return (
    <text fg={props.armed ? armedColor() : props.text} wrapMode="none" truncate flexShrink={1}>
      esc{" "}
      <span style={{ fg: props.armed ? armedColor() : props.subdued }}>
        {props.armed ? "again to interrupt" : "interrupt"}
      </span>
    </text>
  )
}

function hasEditorRangeSelection(selection: EditorSelection["ranges"][number]) {
  return (
    selection.selection.start.line !== selection.selection.end.line ||
    selection.selection.start.character !== selection.selection.end.character
  )
}

function getEditorRangeLabel(selection: EditorSelection["ranges"][number]) {
  if (!hasEditorRangeSelection(selection)) return
  if (selection.selection.start.line === selection.selection.end.line) return `#${selection.selection.start.line}`
  return `#${selection.selection.start.line}-${selection.selection.end.line}`
}

export type PromptFooterProps = {
  sessionID?: string
  mode?: "normal" | "shell"
  interrupt?: number
  hint?: JSX.Element
  spinnerColor?: RGBA
  move?: ReturnType<typeof usePromptMove>
  location?: LocationRef
  pendingDirectory?: string
  editorFileLabel?: string
  editorContextLabelState?: "none" | "pending" | "sent"
}

export function PromptFooter(props: PromptFooterProps) {
  const theme = useTheme()
  const config = useConfig().data
  const dimensions = useTerminalDimensions()
  const data = useData()
  const currentLocation = useLocation()
  const paths = useTuiPaths()
  const editor = useEditorContext()
  const local = useLocal()

  const status = createMemo(() => data.session.status(props.sessionID ?? ""))
  const animationsEnabled = createMemo(() => config.animations ?? true)

  const defaultMove = usePromptMove({
    projectID: () =>
      (props.sessionID ? data.session.get(props.sessionID)?.projectID : undefined) ??
      data.location.info()?.project.id,
    sessionID: () => props.sessionID,
  })
  const move = props.move ?? defaultMove

  const footerInput = () => ({
    sessionID: props.sessionID,
    mode: props.mode ?? "normal",
    showDetails: (props.interrupt ?? 0) === 0 || dimensions().width >= 80,
  })

  const footerLocation = createMemo(() => {
    if (props.location) return props.location
    if (!props.sessionID) {
      return currentLocation.ref ?? data.location.default()
    }
    if (status() !== "idle") return
    return data.session.get(props.sessionID)?.location
  })

  const locationLabel = createMemo(() => {
    const pending = props.pendingDirectory
    const location = pending ? { directory: pending } : footerLocation()
    if (!location) return
    const directory = abbreviateHome(location.directory, paths.home)
    const branch = data.location.vcs.info(location)?.branch.current
    return branch ? `${directory}:${branch}` : directory
  })

  const [locationWidth, setLocationWidth] = createSignal(dimensions().width)
  const locationLabelDisplay = createMemo(() => {
    const label = locationLabel()
    if (!label) return
    return truncateFilePath(label, locationWidth())
  })

  const locationActions = useWorkingDirectoryActions({
    directory: () => footerLocation()?.directory,
    onMove: () => void move.open(),
  })

  const spinnerDef = createMemo(() => {
    const agent = local.agent.current()
    const color = props.spinnerColor ?? (agent ? local.agent.color(agent.id) : undefined) ?? theme.border.base
    return {
      frames: createFrames({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        minAlpha: 0.3,
      }),
      color: createColors({
        color,
        style: "blocks",
        inactiveFactor: 0.6,
        minAlpha: 0.3,
      }),
    }
  })

  const editorContextLabelState = createMemo(() => props.editorContextLabelState ?? editor.labelState())
  const editorFileLabelDisplay = createMemo(() => {
    if (props.editorFileLabel !== undefined) return props.editorFileLabel
    const selection = editor.selection()
    const value = selection?.filePath
    if (!value) return
    const filename = path.basename(value)
    const file = /^index\.[^./]+$/.test(filename)
      ? [path.basename(path.dirname(value)), filename].filter(Boolean).join("/")
      : filename
    const label = selection.ranges?.length
      ? selection.ranges
          .slice(0, 3)
          .map(getEditorRangeLabel)
          .filter(Boolean)
          .join(" ")
      : ""
    const display = `${file.split(path.sep).join("/")}${label ? label : ""}`
    return Locale.truncateMiddle(display, Math.max(12, Math.min(48, Math.floor(dimensions().width / 3))))
  })

  return (
    <box width="100%" flexDirection="row" justifyContent="space-between" gap={2}>
      <Slot path="prompt.footer" input={footerInput()}>
        <Slot path="prompt.footer.status" input={footerInput()}>
          <box
            flexGrow={1}
            flexShrink={1}
            minWidth={0}
            onSizeChange={function (this: BoxRenderable) {
              const width = this.width
              queueMicrotask(() => setLocationWidth(width))
            }}
          >
            <Switch>
              <Match when={status() === "running"}>
                <box flexDirection="row" gap={1} flexGrow={1} justifyContent="flex-start">
                  <box marginLeft={1}>
                    <Show when={config.animations ?? true} fallback={<text fg={theme.text.muted}>[⋯]</text>}>
                      <spinner color={spinnerDef().color} frames={spinnerDef().frames} interval={40} />
                    </Show>
                  </box>
                  <PromptInterruptStatus
                    armed={(props.interrupt ?? 0) > 0}
                    animations={animationsEnabled()}
                    text={theme.text.base}
                    subdued={theme.text.muted}
                    warning={theme.text.feedback.warning.base}
                    flash={theme.decrease(theme.text.feedback.warning.base, 2)}
                  />
                </box>
              </Match>
              <Match when={move.progress()}>
                {(progress) => (
                  <box paddingLeft={3} height={1} minHeight={0} flexShrink={1}>
                    <Spinner color={theme.hue.accent[500]}>
                      {progress()}
                      <span style={{ fg: theme.text.muted }}>{".".repeat(move.creatingDots())}</span>
                    </Spinner>
                  </box>
                )}
              </Match>
              <Match when={move.pendingNew()}>
                <box paddingLeft={3} height={1} minHeight={0} flexShrink={1}>
                  <text fg={theme.hue.accent[500]} wrapMode="none" truncate>
                    (new worktree)
                  </text>
                </box>
              </Match>
              <Match when={true}>
                <Show when={!props.hint && locationLabelDisplay()} fallback={props.hint ?? <text />}>
                  {(location) => (
                    <text
                      id="prompt.footer.location"
                      fg={locationActions.hovered() ? theme.text.base : theme.text.muted}
                      wrapMode="none"
                      truncate
                      flexGrow={1}
                      flexShrink={1}
                      onMouseOver={locationActions.onMouseOver}
                      onMouseOut={locationActions.onMouseOut}
                      onMouseUp={locationActions.onMouseUp}
                    >
                      {location()}
                    </text>
                  )}
                </Show>
              </Match>
            </Switch>
          </box>
        </Slot>
        <Slot path="prompt.footer.file" input={footerInput()}>
          <Show when={editorContextLabelState() !== "none" ? editorFileLabelDisplay() : undefined}>
            {(file) => (
              <text
                wrapMode="none"
                truncate
                flexShrink={1}
                fg={editorContextLabelState() === "pending" ? theme.hue.accent[500] : theme.text.muted}
              >
                {file()}
              </text>
            )}
          </Show>
        </Slot>
      </Slot>
    </box>
  )
}
