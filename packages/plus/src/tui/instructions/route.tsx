import type { Plugin } from "@opencode/plugin/tui"
import { useTerminalDimensions } from "@opentui/solid"
import { createEffect, createSignal, onCleanup, Show } from "solid-js"
import type { Resolution } from "../../instructions/model.js"
import { isValueRow, limitOf } from "../../instructions/permission-catalog.js"
import { manual } from "../../instructions/sections.js"
import { controlKind, type TreeNode } from "../../instructions/tree.js"
import { DetailPane } from "./detail-pane.js"
import { DiffPane } from "./diff-pane.js"
import { createInstructionsDialogs, isLinkable } from "./dialogs.js"
import { Splitter } from "./splitter.js"
import { createInstructionsState } from "./state.js"
import { TreePane } from "./tree-pane.js"

export const WIDE_THRESHOLD = 100

type Mode = "tree" | "diff" | "split"

function isExpandable(node: TreeNode): boolean {
  if (node.kind === "item" && controlKind(node.address?.item) !== undefined) return false
  return node.kind === "root" || node.kind === "group" || node.kind === "agent" || node.kind === "item" || node.kind === "team"
}

function canToggle(node: TreeNode | undefined): boolean {
  // Team rows carry no address by design (a synthetic address would corrupt
  // the mutate path), so toggleability reads from their toggle action alone.
  if (node?.kind === "team" || node?.enabledRow !== undefined) return node?.actions?.toggle === true
  return node?.address !== undefined && node?.actions?.toggle === true
}

// Agent rows under the Agents groups (never team member rows, which are kind
// "team") can be made the current agent with ctrl+space. Space toggles their
// Enabled item; older snapshots with no controls retain space-to-select.
export function selectableAgentId(node: TreeNode | undefined): string | undefined {
  if (node?.kind !== "agent") return undefined
  // Presets (`agent:preset:…`) and Defaults entries are not agents.
  if (node.owner?.entry !== undefined) return undefined
  const match = node.id.match(/^agent:(project|global|defaults):(.+)$/)
  return match?.[2]
}

function canEdit(node: TreeNode | undefined): boolean {
  return node?.address !== undefined && node?.actions?.edit === true
}

function canReset(node: TreeNode | undefined): boolean {
  return (node?.address !== undefined || node?.enabledRow !== undefined) && node?.actions?.reset === true
}

function canDelete(node: TreeNode | undefined): boolean {
  return node?.actions?.remove === true
}

function canSplit(node: TreeNode | undefined): boolean {
  return node?.actions?.split === true
}

function canPin(node: TreeNode | undefined): boolean {
  return node?.address !== undefined && node?.actions?.pin === true
}

function isReview(node: TreeNode | undefined): boolean {
  return node?.badges.review === true
}

export function extractAgentId(data: unknown): string | undefined {
  if (typeof data !== "object" || data === null) return undefined
  if (!("agent" in data)) return undefined
  const value = data.agent
  if (typeof value === "string" && value.length > 0) return value
  return undefined
}

export const INITIAL_AGENT_RETRY_MS = 5000

export interface InstructionsRouteProps {
  readonly context: Plugin.Context
  readonly onClose: () => void
  readonly data?: unknown
  readonly initialAgentTimeoutMs?: number
}

export function InstructionsRoute(props: InstructionsRouteProps) {
  const state = createInstructionsState(props.context)
  const dialogs = createInstructionsDialogs(props.context, state)
  const dimensions = useTerminalDimensions()
  const wide = () => dimensions().width >= WIDE_THRESHOLD
  const [showDetail, setShowDetail] = createSignal(false)
  const [showHelp, setShowHelp] = createSignal(false)
  const [mode, setMode] = createSignal<Mode>("tree")
  const [diffNode, setDiffNode] = createSignal<TreeNode | undefined>(undefined)
  const [splitNode, setSplitNode] = createSignal<TreeNode | undefined>(undefined)
  const [detailEditing, setDetailEditing] = createSignal(false)
  const [detailDraft, setDetailDraft] = createSignal("")
  const route = props.context.ui.router.current()
  const navigationData: unknown = props.data ?? (route.type === "plugin" ? route.data : undefined)
  const initialAgent = extractAgentId(navigationData)

  // Core's config watcher debounces reloads (~100 ms), so the first snapshot
  // after agent.create often lacks the new agent. Retry until it appears.
  let initialApplied = initialAgent === undefined
  let baselineSelection: string | undefined
  let baselineSet = false
  let retryTimer: ReturnType<typeof setTimeout> | undefined

  function clearRetryTimer() {
    if (retryTimer !== undefined) {
      clearTimeout(retryTimer)
      retryTimer = undefined
    }
  }

  function giveUpWithToast() {
    if (initialApplied) return
    initialApplied = true
    clearRetryTimer()
    if (initialAgent !== undefined) {
      props.context.ui.toast.show({ variant: "warning", message: `Agent ${initialAgent} not visible yet` })
    }
  }

  if (initialAgent !== undefined) {
    retryTimer = setTimeout(giveUpWithToast, props.initialAgentTimeoutMs ?? INITIAL_AGENT_RETRY_MS)
  }

  onCleanup(() => {
    clearRetryTimer()
    state.dispose()
    dialogs.dispose()
  })

  createEffect(() => {
    if (initialApplied) return
    if (initialAgent === undefined) return
    const snap = state.snapshot()
    if (!snap) return
    const current = state.selectedId()
    if (!baselineSet) {
      if (current === undefined) return
      baselineSelection = current
      baselineSet = true
    } else if (current !== undefined && current !== baselineSelection) {
      // The user moved the selection themselves: stop hijacking it silently.
      initialApplied = true
      clearRetryTimer()
      return
    }
    if (state.selectAgent(initialAgent)) {
      initialApplied = true
      clearRetryTimer()
    }
  })

  // Drafts belong to one node: leaving the node exits the detail editor.
  createEffect((previous: string | undefined) => {
    const current = state.selectedId()
    if (previous !== undefined && current !== previous && detailEditing()) {
      setDetailEditing(false)
      setDetailDraft("")
    }
    return current
  }, undefined)

  function current(): TreeNode | undefined {
    return state.selected()
  }

  function collapseOrParent() {
    const node = current()
    if (!node) return
    if (isExpandable(node) && state.expanded().has(node.id)) {
      state.toggleExpanded(node.id)
      return
    }
    const list = state.nodes()
    const index = list.findIndex((entry) => entry.id === node.id)
    for (let at = index - 1; at >= 0; at--) {
      const candidate = list[at]
      if (candidate.depth < node.depth && isExpandable(candidate)) {
        state.select(candidate.id)
        return
      }
    }
  }

  function expandOrChild() {
    const node = current()
    if (!node) return
    if (!wide() && node.address !== undefined) {
      if (isExpandable(node) && !state.expanded().has(node.id)) state.toggleExpanded(node.id)
      setShowDetail(true)
      return
    }
    if (isExpandable(node)) state.toggleExpanded(node.id)
  }

  function back() {
    if (showHelp()) {
      setShowHelp(false)
      return
    }
    if (mode() !== "tree") {
      setMode("tree")
      setDiffNode(undefined)
      setSplitNode(undefined)
      return
    }
    if (!wide() && showDetail()) {
      if (detailEditing()) {
        setDetailEditing(false)
        setDetailDraft("")
        return
      }
      setShowDetail(false)
      return
    }
    if (detailEditing()) {
      setDetailEditing(false)
      setDetailDraft("")
      return
    }
    setShowHelp(false)
    props.onClose()
  }

  // Selection follows the picker: disabled, hidden, subagent-only and
  // maintenance agents stay editable but cannot become the current agent.
  function selectableAgent(node: TreeNode | undefined): string | undefined {
    const id = selectableAgentId(node)
    if (id === undefined) return undefined
    // Row badges describe the edited tier. Selection follows the current
    // location's host catalogue, where disabled agents are absent, just as the
    // core picker does; an unloaded catalogue offers no selection yet.
    const agent = props.context.data.location.agent.list(props.context.location)?.find((entry) => entry.id === id)
    if (agent === undefined || agent.hidden || agent.mode === "subagent") return undefined
    const entry = state.snapshot()?.agents.find((candidate) => candidate.id === id)
    if (entry?.origin === "special") return undefined
    return id
  }

  function toggle() {
    const node = current()
    if (!node) return
    if (canToggle(node)) {
      void state.toggle(node)
      return
    }
    selectAgent()
  }

  function selectAgent() {
    const node = current()
    const agentId = selectableAgent(node)
    if (agentId !== undefined) {
      props.context.ui.agents.set?.(agentId)
    }
  }

  function togglePin() {
    const node = current()
    if (!node) return
    void state.togglePin(node)
  }

  function add() {
    void dialogs.addFor(current())
  }

  function remove() {
    const node = current()
    if (!node) return
    void state.remove(node)
  }

  function resetRow() {
    const node = current()
    if (!node) return
    void state.reset(node)
  }

  // s opens the manual splitter: the user places boundaries in the item text
  // and names each section; save persists a split record via saveSplit.
  function splitRow() {
    const node = current()
    if (!node) return
    if (!canSplit(node)) return
    setSplitNode(node)
    setMode("split")
  }

  async function saveSplitBoundaries(boundaries: { id: string; name: string; start: number }[]): Promise<void> {
    const node = splitNode() ?? current()
    if (!node) {
      setMode("tree")
      return
    }
    // Validate through the same manual() call the splitter previews with so
    // preview and save always agree.
    manual(state.resolvedText(node), boundaries)
    await state.saveSplit(node, boundaries)
    setMode("tree")
    setSplitNode(undefined)
  }

  function cancelSplit() {
    setMode("tree")
    setSplitNode(undefined)
  }

  async function filterPrompt() {
    const raw = await props.context.ui.dialog.prompt({
      title: "Filter",
      description: "Filter: words or key:value (? help)",
      value: state.filter(),
    })
    if (raw === undefined) return
    state.setFilter(raw)
  }

  // Enter on a normal node opens the detail editor; Enter on a yellow review
  // node opens the review: a keep/take choice for a changed state, pin or
  // active model (§3.6), the three-pane diff for text (after the choice when
  // both are under review); Enter on a permission row opens the rule editor.
  function enter() {
    const node = current()
    if (!node || node.address === undefined) {
      expandOrChild()
      return
    }
    if (node.badges.disabled !== undefined) {
      state.setStatus(node.badges.disabled)
      return
    }
    const control = controlKind(node.address.item)
    if (control === "cycle") {
      void state.cycle(node)
      return
    }
    if (isReview(node)) {
      if (node.address.item.startsWith("model:")) {
        void reviewModel(node)
        return
      }
      const parts = node.badges.reviewOf ?? []
      if (parts.some((part) => part !== "text")) {
        void reviewState(node, parts.includes("text"))
        return
      }
      openDiff(node)
      return
    }
    if (control === "toggle") {
      void state.toggle(node)
      return
    }
    if (node.address.item.startsWith("perm:")) {
      const item = permItem(node)
      // A limit or bound is a number; a row with no patterns is a switch;
      // every other permission row opens the rule editor.
      if (item !== undefined && isValueRow(item)) {
        void editNumber(node)
        return
      }
      if (item !== undefined && (item.patterns ?? []).length === 0) {
        props.context.ui.toast.show({ variant: "info", message: `"${node.label}" is a switch: space turns it on or off` })
        return
      }
      void dialogs.editRule(node)
      return
    }
    if (!canEdit(node)) {
      expandOrChild()
      return
    }
    setShowDetail(true)
    setDetailDraft(state.resolvedText(node))
    setDetailEditing(true)
  }

  function openDiff(node: TreeNode) {
    setDiffNode(node)
    setMode("diff")
  }

  // State and pin: "Keep yours (off)" re-records the value above and keeps
  // yours; "Take from preset X (on)" drops yours so the row follows it again.
  // Text under review too opens the three-way diff afterwards.
  async function reviewState(node: TreeNode, text: boolean): Promise<void> {
    const choice = state.reviewChoice(node)
    if (choice === undefined) {
      if (text) openDiff(node)
      return
    }
    const picked = await props.context.ui.dialog.select<"keep" | "take">({
      title: `Review "${node.label}"`,
      placeholder: `The ${choice.parts.join(" and ")} above changed since you set yours`,
      options: [
        { title: `Keep yours (${choice.mine})`, value: "keep", description: "Your setting stays; the change above is acknowledged" },
        { title: `Take ${choice.from} (${choice.above})`, value: "take", description: "Drop yours and follow it again" },
      ],
    })
    if (picked === undefined) return
    const resolved = picked === "keep" ? await state.resolveKeep(node, choice.parts) : await state.resolveTake(node, choice.parts)
    if (resolved && text) openDiff(node)
  }

  // Active model: keep acknowledges the model above and keeps yours active;
  // take clears your active model so the one above wins again.
  async function reviewModel(node: TreeNode): Promise<void> {
    const choice = state.modelReview(node)
    if (choice === undefined) return
    const picked = await props.context.ui.dialog.select<"keep" | "take">({
      title: `Review "${node.label}"`,
      placeholder: "The active model above changed since you chose yours",
      options: [
        { title: `Keep yours (${choice.mine})`, value: "keep", description: "Your model stays active; the change above is acknowledged" },
        {
          title: choice.above === undefined ? "Take the model above (none)" : `Take ${choice.from} (${choice.above})`,
          value: "take",
          description: "Clear your active model and follow it again",
        },
      ],
    })
    if (picked === undefined) return
    await state.resolveModel(node, picked)
  }

  function relink() {
    void dialogs.relink(current())
  }

  // The permission row a node addresses; undefined for every other node.
  function permItem(node: TreeNode) {
    const item = node.address?.item
    if (item === undefined || !item.startsWith("perm:") || node.address?.section !== null) return undefined
    return state.snapshot()?.items.find((entry) => entry.id === item)
  }

  // Enter on a limit or bound row: the number is the row's text. Off (space)
  // removes the cap; the number stays for when it is switched back on.
  async function editNumber(node: TreeNode): Promise<void> {
    const raw = await props.context.ui.dialog.prompt({
      title: node.label,
      description: "A number. Space switches the cap off and on.",
      value: state.resolvedText(node),
    })
    if (raw === undefined) return
    const value = limitOf(raw)
    if (value === undefined) {
      props.context.ui.toast.show({ variant: "error", message: `"${node.label}" takes a number` })
      return
    }
    await state.saveText(node, String(value))
  }

  async function resolveDiff(resolution: Resolution, edited?: string): Promise<void> {
    const node = diffNode() ?? current()
    if (!node) {
      setMode("tree")
      return
    }
    if (resolution === "keep") await state.resolveKeep(node)
    else if (resolution === "take") await state.resolveTake(node)
    else if (edited !== undefined) await state.resolveEdit(node, edited)
    setMode("tree")
    setDiffNode(undefined)
  }

  function diffThreeWay(): { original: string; mine: string; upstream: string } | undefined {
    const node = diffNode() ?? current()
    if (!node) return undefined
    return state.threeWay(node)
  }

  function splitInitial(): { id: string; name: string; start: number }[] | undefined {
    const node = splitNode() ?? current()
    if (!node) return undefined
    const preview = state.splitPreview(node)
    if (!preview || preview.kind !== "manual") return undefined
    return preview.sections.map((section) => ({ id: section.id, name: section.name, start: section.start }))
  }

  function hintLine(): string {
    if (showHelp()) return "esc close help"
    if (mode() === "diff") return "k keep mine · t take new · e edit · esc back"
    if (mode() === "split") return "arrows move · b boundary · e rename · x remove · ctrl+s save · esc back"
    if (state.snapshot() === undefined) return "esc back"
    const node = current()
    const hints: string[] = ["arrows move"]
    if (node && isExpandable(node)) hints.push("left/right expand")
    if (!wide() && node && node.address !== undefined && !isExpandable(node) && !showDetail())
      hints.push("right detail")
    // A row with no patterns is a plain switch: space (below) is its only key.
    const perm = node === undefined ? undefined : permItem(node)
    const control = controlKind(node?.address?.item)
    if (node?.badges.disabled !== undefined) hints.push("local settings unavailable in Remote")
    else if (control === "cycle") hints.push("enter cycle")
    else if (node?.address !== undefined && isReview(node)) hints.push("enter review")
    else if (control === "toggle") hints.push("enter toggle")
    else if (perm !== undefined && isValueRow(perm)) hints.push("enter edit number")
    else if (perm !== undefined && (perm.patterns ?? []).length > 0 && node?.address?.item.startsWith("perm:") === true) hints.push("enter edit rule")
    else if (perm !== undefined) hints.push("space switch")
    else if (node?.address?.item.startsWith("perm:") === true) hints.push("enter edit rule")
    else if (canEdit(node)) hints.push("enter edit")
    else if (node && isExpandable(node)) hints.push("enter expand")
    if (canToggle(node) && !hints.includes("space switch")) hints.push("space toggle")
    else if (selectableAgent(node) !== undefined) hints.push("space select")
    if (canToggle(node) && selectableAgent(node) !== undefined) hints.push("ctrl+space select")
    if (canPin(node)) hints.push("p pin")
    hints.push("a add")
    if (isLinkable(node?.owner)) hints.push("l link")
    if (canDelete(node)) hints.push("d delete")
    if (canReset(node)) hints.push(node?.enabledRow === undefined ? "r reset" : "r reset controls")
    if (canSplit(node)) hints.push("s split")
    hints.push("/ filter")
    hints.push("? help")
    if (!wide() && showDetail()) hints.push("esc back to tree")
    else hints.push("esc back")
    return hints.join(" · ")
  }

  function helpText(): string {
    return [
      "arrows move · left collapse · right expand",
      "enter edit (rule editor on permission rows)",
      "enter Mode: Primary → Subagent → All; Strategy: Auto → Local → Remote",
      "space toggles agents and Enabled/Hidden settings · ctrl+space selects an enabled primary agent",
      "Hidden hides from the picker; Off disables the agent. Remote retains local compaction settings but locks edits.",
      "enter on a yellow review row: keep yours or take the new value (state, pin, model), diff for text",
      "space toggle include/exclude · p pin Code Mode tool · a add (name, then preset) · d delete (confirm)",
      "l link an agent, member, team, entry or User preset to a preset (or unlink)",
      "r reset override · s split into sections",
      "/ filter rows · ? help · esc back",
      "filter: words or key:value · ! negates · a,b ors · sort:key",
      "keys: kind item group server namespace level agent state modified review",
      "  source overridden active inactive unsupported codemode pinned execute can",
      "  has id label updated team acked excluded tool",
      "slow text: text upstream tokens delta overriders identical dead",
      "  shadowed orphan",
      "perms: item:perm tool:<id> (e.g. item:perm tool:shell)",
    ].join("\n")
  }

  props.context.keymap.layer(() => {
    if (showHelp()) {
      // Help floats above every sub-pane: outrank the newer detail/diff/
      // splitter editing escapes (same default priority) so one press closes
      // only help. Higher priority wins, then newer layers win.
      return {
        priority: 1,
        commands: [{ bind: "escape", title: "Close help", group: "Instructions", run: back }],
      }
    }
    if (state.snapshot() === undefined)
      return {
        commands: [{ bind: "escape", title: "Back", group: "Instructions", run: back }],
      }
    if (mode() !== "tree")
      return {
        commands: [{ bind: "escape", title: "Back to tree", group: "Instructions", run: back }],
      }
    const node = current()
    const narrowDetail = !wide() && showDetail()
    if (narrowDetail)
      return {
        commands: [
          ...(controlKind(node?.address?.item) !== undefined && !detailEditing()
            ? [
                { bind: "return", title: "Edit control", group: "Instructions", run: enter },
                ...(canToggle(node) ? [{ bind: "space", title: "Toggle control", group: "Instructions", run: toggle }] : []),
                ...(canReset(node) ? [{ bind: "r", title: "Reset override", group: "Instructions", run: resetRow }] : []),
              ]
            : []),
          { bind: "escape", title: "Back to tree", group: "Instructions", run: back },
        ],
      }
    return {
      commands: [
        { bind: "up", title: "Previous row", group: "Instructions", run: () => state.move(-1) },
        { bind: "down", title: "Next row", group: "Instructions", run: () => state.move(1) },
        { bind: "left", title: "Collapse", group: "Instructions", run: collapseOrParent },
        { bind: "right", title: "Expand", group: "Instructions", run: expandOrChild },
        { bind: "return", title: "Edit or diff", group: "Instructions", run: enter },
        ...(canToggle(node)
          ? [{ bind: "space", title: "Toggle include", group: "Instructions", run: toggle }]
          : selectableAgent(node) !== undefined
            ? [{ bind: "space", title: "Select agent", group: "Instructions", run: toggle }]
            : []),
        ...(canToggle(node) && selectableAgent(node) !== undefined
          ? [{ bind: "ctrl+space", title: "Select agent", group: "Instructions", run: selectAgent }]
          : []),
        ...(canPin(node) ? [{ bind: "p", title: "Pin Code Mode tool", group: "Instructions", run: togglePin }] : []),
        { bind: "a", title: "Add", group: "Instructions", run: add },
        ...(isLinkable(node?.owner) ? [{ bind: "l", title: "Link to preset", group: "Instructions", run: relink }] : []),
        { bind: "d", title: "Delete", group: "Instructions", run: remove },
        ...(canReset(node)
          ? [{ bind: "r", title: "Reset override", group: "Instructions", run: resetRow }]
          : []),
        ...(canSplit(node) ? [{ bind: "s", title: "Split", group: "Instructions", run: splitRow }] : []),
        { bind: "/", title: "Filter", group: "Instructions", run: () => void filterPrompt() },
        { bind: "?", title: "Help", group: "Instructions", run: () => setShowHelp(true) },
        { bind: "escape", title: "Back", group: "Instructions", run: back },
      ],
    }
  })

  return (
    <box width="100%" height="100%" flexDirection="column" backgroundColor={props.context.theme.background.default}>
      <Show
        when={state.snapshot() !== undefined}
        fallback={
          <box flexGrow={1} minHeight={0} flexDirection="column" paddingLeft={1} paddingRight={1}>
            <text fg={props.context.theme.text.feedback.info.default}>
              {state.status() || "No snapshot loaded"}
            </text>
          </box>
        }
      >
        <Show
          when={mode() === "diff" && diffThreeWay() !== undefined}
          fallback={
            <Show
              when={mode() === "split" && (splitNode() ?? current()) !== undefined}
              fallback={
                <box flexGrow={1} minHeight={0} flexDirection={wide() ? "row" : "column"}>
                  <Show
                    when={wide() || !showDetail()}
                    fallback={
                      <box flexGrow={1} flexDirection="column" minHeight={0}>
                        <DetailPane
                          context={props.context}
                          node={current}
                          snapshot={state.snapshot}
                          state={state}
                          editing={detailEditing}
                          onEditingChange={setDetailEditing}
                          draft={detailDraft}
                          onDraftChange={setDetailDraft}
                        />
                      </box>
                    }
                  >
                    <box flexGrow={wide() ? 1 : 0} width={wide() ? "50%" : "100%"} flexDirection="column" minHeight={0}>
                      <Show when={state.filter()}>
                        {(query) => (
                          <text fg={props.context.theme.text.subdued}>{`Filter: ${query()}`}</text>
                        )}
                      </Show>
                      <TreePane
                        context={props.context}
                        nodes={state.nodes}
                        expanded={state.expanded}
                        selectedId={state.selectedId}
                        loading={state.loading}
                      />
                    </box>
                    <Show when={wide() && state.snapshot() !== undefined}>
                      <box flexGrow={1} width="50%" flexDirection="column" minHeight={0}>
                        <DetailPane
                          context={props.context}
                          node={current}
                          snapshot={state.snapshot}
                          state={state}
                          editing={detailEditing}
                          onEditingChange={setDetailEditing}
                          draft={detailDraft}
                          onDraftChange={setDetailDraft}
                        />
                      </box>
                    </Show>
                  </Show>
                </box>
              }
            >
              <Show when={splitNode() ?? current()}>
                {(node) => (
                  <Splitter
                    context={props.context}
                    title={node().label}
                    text={state.resolvedText(node())}
                    initial={splitInitial()}
                    active={() => mode() === "split"}
                    onSave={(boundaries) => saveSplitBoundaries(boundaries)}
                    onCancel={cancelSplit}
                  />
                )}
              </Show>
            </Show>
          }
        >
          <Show when={diffNode() ?? current()}>
            {(node) => (
              <Show when={diffThreeWay()}>
                {(three) => (
                  <DiffPane
                    context={props.context}
                    title={node().label}
                    threeWay={three()}
                    active={() => mode() === "diff"}
                    review={node().badges.review}
                    onResolve={(resolution, edited) => resolveDiff(resolution, edited)}
                  />
                )}
              </Show>
            )}
          </Show>
        </Show>
      </Show>
      <Show when={showHelp()}>
        <text flexShrink={0} fg={props.context.theme.text.default}>
          {helpText()}
        </text>
      </Show>
      <Show when={state.status()}>
        {(line) => (
          <text flexShrink={0} fg={props.context.theme.text.feedback.info.default}>
            {line()}
          </text>
        )}
      </Show>
      <text flexShrink={0} fg={props.context.theme.text.subdued}>
        {hintLine()}
      </text>
    </box>
  )
}
