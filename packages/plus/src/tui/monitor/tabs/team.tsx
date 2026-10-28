import type { Plugin } from "@opencode/plugin/tui"
import { TextAttributes } from "@opentui/core"
import { createEffect, createSignal, For, Show } from "solid-js"
import { Definition, type Plus } from "../../../rpc.js"
import { TeamMonitorTab, type TeamPlace } from "../../active-team.js"
import { openProjectChecks } from "../../project-checks.js"

// The Monitor's Team tab, shown while a team is the active agent group: the
// runs the chat's team tree started, and the project checks a run may be given
// by name (.opencodeplus/checks.json). An orchestrator can also hand a worker
// any `bun test` / `bun run` check itself; the file adds named commands and a
// setup step for fresh worktrees.

export interface TeamTabProps {
  readonly context: Plugin.Context
  readonly sessionID: () => string | undefined
  readonly active: () => boolean
  readonly open: (sessionID: string, place: TeamPlace) => void
  readonly place?: () => TeamPlace | undefined
  readonly location: () => { directory: string; workspace?: string } | undefined
}

export function TeamTab(props: TeamTabProps) {
  const theme = () => props.context.theme
  const plus = props.context.client.rpc(Definition)
  const [checks, setChecks] = createSignal<Plus.ChecksSuggestion>()
  const [failure, setFailure] = createSignal<string>()

  const loadChecks = () => {
    const location = props.location()
    void plus["checks.suggest"](undefined, location === undefined ? undefined : { location }).then(
      (found) => {
        setChecks(found)
        setFailure(undefined)
      },
      (error: unknown) => setFailure(error instanceof Error ? error.message : String(error)),
    )
  }
  createEffect(() => {
    props.location()
    loadChecks()
  })

  props.context.keymap.layer(() => ({
    enabled: () => props.active(),
    priority: 2,
    commands: [
      {
        id: "plus.monitor.team.checks",
        bind: "e",
        title: "Edit project checks",
        group: "Team",
        run: () => void openProjectChecks(props.context).then(loadChecks),
      },
    ],
  }))

  return (
    <box flexDirection="column" flexGrow={1} minHeight={0} minWidth={0}>
      <text fg={theme().text.base} attributes={TextAttributes.BOLD} flexShrink={0}>
        Runs
      </text>
      <TeamMonitorTab
        sessionID={props.sessionID()}
        active={props.active}
        open={props.open}
        {...(props.place === undefined ? {} : { place: props.place })}
        context={props.context}
      />
      <box flexDirection="column" flexShrink={0} marginTop={1}>
        <box flexDirection="row">
          <text fg={theme().text.base} attributes={TextAttributes.BOLD} flexShrink={0}>
            Project checks
          </text>
          <text fg={theme().text.muted} wrapMode="none" truncate>
            {" · .opencodeplus/checks.json · e edit"}
          </text>
        </box>
        <Show when={failure()}>
          {(message) => <text fg={theme().text.feedback.error.base}>{`checks unavailable: ${message()}`}</text>}
        </Show>
        <Show when={checks()}>{(found) => <ChecksList context={props.context} found={found()} />}</Show>
      </box>
    </box>
  )
}

function ChecksList(props: { readonly context: Plugin.Context; readonly found: Plus.ChecksSuggestion }) {
  const theme = () => props.context.theme
  const command = (entry: Plus.ProjectCheckEntry) =>
    `${entry.argv.join(" ")}${entry.cwd === undefined ? "" : `  (in ${entry.cwd})`}`
  const empty = () => {
    if (props.found.root === undefined) return "need a git repository"
    const count = props.found.suggested.length
    if (count === 0) return "none · workers can still be given bun test / bun run checks"
    return `none · e picks from ${count} the project names`
  }
  return (
    <box flexDirection="column" paddingLeft={1}>
      <Show when={props.found.invalid}>
        {(reason) => <text fg={theme().text.feedback.warning.base} wrapMode="none" truncate>{reason()}</text>}
      </Show>
      <Show
        when={props.found.current.length > 0 || props.found.setup !== undefined}
        fallback={<text fg={theme().text.muted}>{empty()}</text>}
      >
        <For each={props.found.current}>
          {(entry) => (
            <box flexDirection="row">
              <text fg={theme().text.base} flexShrink={0}>{entry.id.padEnd(12)}</text>
              <text fg={theme().text.muted} wrapMode="none" truncate>{command(entry)}</text>
            </box>
          )}
        </For>
        <Show when={props.found.setup}>
          {(setup) => (
            <box flexDirection="row">
              <text fg={theme().text.base} flexShrink={0}>{"setup".padEnd(12)}</text>
              <text fg={theme().text.muted} wrapMode="none" truncate>{`${command(setup())} · fresh worktrees`}</text>
            </box>
          )}
        </Show>
      </Show>
    </box>
  )
}
