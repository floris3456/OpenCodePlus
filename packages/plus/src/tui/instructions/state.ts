import type { Plugin } from "@opencode/plugin/tui"
import { createMemo, createSignal } from "solid-js"
import {
  applies,
  fingerprint,
  merge,
  reset,
  resolve,
  resolveResolution,
  resolveSplit,
  scopesOf,
  threeWay,
} from "../../instructions/model.js"
import { manual, slice, type Split } from "../../instructions/sections.js"
import type {
  Address,
  AgentSource,
  CustomizationRecord,
  Item,
  SplitRecord,
} from "../../instructions/model.js"
import { expandedTree, tree, type TeamInput, type TreeNode } from "../../instructions/tree.js"
import { Definition, type Snapshot, type SnapshotRecord } from "../../rpc.js"

export type { TreeNode }

function agentSourcesOf(snapshot: Snapshot): AgentSource[] {
  return snapshot.agents.map((entry) => ({
    id: entry.id,
    scope: entry.scope,
    ...(entry.path === undefined ? {} : { path: entry.path }),
    ...(entry.base === undefined ? {} : { base: entry.base }),
  }))
}

function customizationsOf(records: readonly SnapshotRecord[]): CustomizationRecord[] {
  return records.flatMap((record): CustomizationRecord[] => {
    if (record.type !== "customization") return []
    return [
      {
        type: "customization",
        level: record.level,
        agent: record.agent,
        item: record.item,
        section: record.section,
        ...(record.text === undefined ? {} : { text: record.text }),
        ...(record.state === undefined ? {} : { state: record.state }),
        basedOn: record.basedOn,
        ...(record.basedOnText === undefined ? {} : { basedOnText: record.basedOnText }),
        ...(record.acknowledged === undefined ? {} : { acknowledged: record.acknowledged }),
        updated: record.updated,
      },
    ]
  })
}

function splitsOf(records: readonly SnapshotRecord[]): (SplitRecord & { updated: string })[] {
  return records.flatMap((record): (SplitRecord & { updated: string })[] => {
    if (record.type !== "split") return []
    return [
      {
        type: "split",
        level: record.level,
        agent: record.agent,
        item: record.item,
        boundaries: [...record.boundaries],
        updated: record.updated,
      },
    ]
  })
}

function toRpcRecords(
  customizations: readonly CustomizationRecord[],
  splits: readonly (SplitRecord & { updated?: string })[],
): SnapshotRecord[] {
  return [
    ...customizations.map(
      (record): SnapshotRecord => ({
        type: "customization",
        level: record.level,
        agent: record.agent,
        item: record.item,
        section: record.section,
        ...(record.text === undefined ? {} : { text: record.text }),
        ...(record.state === undefined ? {} : { state: record.state }),
        basedOn: record.basedOn,
        ...(record.basedOnText === undefined ? {} : { basedOnText: record.basedOnText }),
        ...(record.acknowledged === undefined ? {} : { acknowledged: record.acknowledged }),
        updated: record.updated,
      }),
    ),
    ...splits.map((record): SnapshotRecord => {
      const known = record.updated ?? now()
      return {
        type: "split",
        level: record.level,
        agent: record.agent,
        item: record.item,
        boundaries: [...record.boundaries],
        updated: known,
      }
    }),
  ]
}

export function createInstructionsState(context: Plugin.Context) {
  const plus = context.client.rpc(Definition)
  const [snapshot, setSnapshot] = createSignal<Snapshot | undefined>(undefined)
  const [expanded, setExpanded] = createSignal<ReadonlySet<string>>(new Set())
  const [selectedId, setSelectedId] = createSignal<string | undefined>(undefined)
  const [filter, setFilter] = createSignal<string>("")
  const [status, setStatus] = createSignal<string>("")
  const [loading, setLoading] = createSignal<boolean>(true)
  let disposed = false
  let disabled = false
  let generation = 0

  const itemsForTree = createMemo<Item[]>(() => {
    const current = snapshot()
    if (!current) return []
    return current.items.map(
      (entry): Item => ({
        id: entry.id,
        kind: entry.kind,
        group: entry.group,
        ...(entry.server === undefined ? {} : { server: entry.server }),
        title: entry.title,
        text: entry.text,
        enabled: entry.enabled,
        fingerprint: entry.fingerprint,
        ...(entry.agents === undefined ? {} : { agents: [...entry.agents] }),
        ...(entry.order === undefined ? {} : { order: entry.order }),
        ...(entry.userBase === true ? { userBase: true as const } : {}),
        ...(entry.codemode === true ? { codemode: true as const } : {}),
      }),
    )
  })

  const recordsForTree = createMemo<(CustomizationRecord | SplitRecord)[]>(() => {
    const current = snapshot()
    if (!current) return []
    return [...customizationsOf(current.records), ...splitsOf(current.records)]
  })

  const agentsForTree = createMemo<AgentSource[]>(() => {
    const current = snapshot()
    if (!current) return []
    return agentSourcesOf(current)
  })

  const teamsForTree = createMemo<TeamInput[]>(() => {
    const current = snapshot()
    if (!current) return []
    return (current.teams ?? []).map((entry) => ({
      level: entry.level,
      team: entry.team,
      enabled: entry.enabled,
      agents: [...entry.agents],
    }))
  })

  const allNodes = createMemo<TreeNode[]>(() => {
    const current = snapshot()
    if (!current) return []
    return tree({
      items: itemsForTree(),
      records: recordsForTree(),
      agents: agentsForTree(),
      teams: teamsForTree(),
      expanded: expanded(),
    })
  })

  const fullTree = createMemo<TreeNode[]>(() => {
    const current = snapshot()
    if (!current) return []
    return expandedTree({ items: itemsForTree(), records: recordsForTree(), agents: agentsForTree(), teams: teamsForTree() })
  })

  function ancestorsOf(
    all: readonly TreeNode[],
    byId: ReadonlyMap<string, TreeNode>,
    indexById: ReadonlyMap<string, number>,
    node: TreeNode,
  ): TreeNode[] {
    // tree() emits the full logical pre-order list: ancestors of node are the
    // nearest preceding rows with strictly smaller depth.
    const index = indexById.get(node.id)
    if (index === undefined) return []
    const out: TreeNode[] = []
    let depth = node.depth
    for (let at = index - 1; at >= 0; at--) {
      const candidate = all[at]
      if (candidate === undefined) break
      if (candidate.depth < depth) {
        out.unshift(byId.get(candidate.id) ?? candidate)
        depth = candidate.depth
        if (depth <= 0) break
      }
    }
    return out
  }

  const nodes = createMemo<TreeNode[]>(() => {
    const query = filter().trim().toLowerCase()
    if (query.length === 0) return allNodes()
    // Reveal matches hidden inside collapsed ancestors: match against the
    // full logical tree and include each match with its ancestor chain.
    // Gated Code Mode sections never surface: their toggle/edit would report
    // success for content apply discards, and the tree path already refuses
    // to expand them. The gated item parent still matches by its own label.
    const full = fullTree()
    const byId = new Map(full.map((node) => [node.id, node]))
    const indexById = new Map(full.map((node, index) => [node.id, index] as const))
    const matched = full.filter((node) => {
      if (node.kind === "section" && node.actions?.toggle !== true) return false
      return node.label.toLowerCase().includes(query) || node.id.toLowerCase().includes(query)
    })
    const included = new Map<string, TreeNode>()
    for (const node of matched) {
      for (const ancestor of ancestorsOf(full, byId, indexById, node)) included.set(ancestor.id, ancestor)
      included.set(node.id, node)
    }
    return [...included.values()]
  })

  const selected = createMemo<TreeNode | undefined>(() => {
    return nodes().find((node) => node.id === selectedId())
  })

  function ensureSelection() {
    const list = nodes()
    if (list.length === 0) {
      setSelectedId(undefined)
      return
    }
    const current = selectedId()
    if (current !== undefined && list.some((node) => node.id === current)) return
    setSelectedId(list[0].id)
  }

  async function load() {
    if (disposed || disabled) return
    const requestGen = ++generation
    setLoading(true)
    try {
      const fresh = await plus["instructions.snapshot"](undefined, { location: context.location })
      if (disposed || disabled || requestGen !== generation) return
      const firstLoad = snapshot() === undefined
      setSnapshot(fresh)
      if (firstLoad && expanded().size === 0) {
        const roots = allNodes().filter((node) => node.kind === "root")
        if (roots.length > 0) setExpanded(new Set(roots.map((node) => node.id)))
      }
      setStatus("")
      ensureSelection()
    } catch (error: unknown) {
      if (disposed || disabled || requestGen !== generation) return
      setStatus(errorMessage(error))
    } finally {
      if (!disposed && !disabled && requestGen === generation) setLoading(false)
    }
  }

  async function refresh() {
    if (disposed || disabled) return
    const requestGen = ++generation
    setLoading(true)
    try {
      const fresh = await plus["instructions.refresh"](undefined, { location: context.location })
      if (disposed || disabled || requestGen !== generation) return
      setSnapshot(fresh)
      setStatus("Refreshed from host")
      ensureSelection()
    } catch (error: unknown) {
      if (disposed || disabled || requestGen !== generation) return
      setStatus(errorMessage(error))
    } finally {
      if (!disposed && !disabled && requestGen === generation) setLoading(false)
    }
  }

  function toggleExpanded(id: string) {
    setExpanded((previous) => {
      const next = new Set(previous)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  function select(id: string) {
    setSelectedId(id)
  }

  function selectAgent(agentId: string): boolean {
    if (disposed) return false
    const current = snapshot()
    if (!current) return false
    const entry = current.agents.find((candidate) => candidate.id === agentId)
    if (!entry) return false
    const next = new Set(expanded())
    // Agents live under their level's Agents group at every level, so reveal
    // the whole chain down to the agent.
    next.add(`root:${entry.scope}`)
    next.add(`group:${entry.scope}:agents`)
    setExpanded(next)
    setSelectedId(`agent:${entry.scope}:${agentId}`)
    return true
  }

  function move(delta: number) {
    const list = nodes()
    if (list.length === 0) return
    const current = selectedId()
    const index = list.findIndex((node) => node.id === current)
    if (index === -1) {
      const target = delta >= 0 ? list[0] : list[list.length - 1]
      setSelectedId(target.id)
      return
    }
    const next = Math.min(list.length - 1, Math.max(0, index + delta))
    setSelectedId(list[next].id)
  }

  function upstreamFor(items: readonly Item[], address: Address): Item | undefined {
    const matches = items.filter((entry) => entry.id === address.item)
    const owner = address.agent
    if (owner === null) return matches[0]
    return matches.find((entry) => applies(entry, owner)) ?? matches[0]
  }

  function chainFor(node: TreeNode):
    | { address: Address; upstream: Item; customizations: CustomizationRecord[]; splits: (SplitRecord & { updated: string })[] }
    | undefined {
    const current = snapshot()
    const address = node.address
    if (!current || !address) return undefined
    const found = upstreamFor(current.items, address)
    if (!found) return undefined
    const upstream: Item = {
      id: found.id,
      kind: found.kind,
      group: found.group,
      ...(found.server === undefined ? {} : { server: found.server }),
      title: found.title,
      text: found.text,
      enabled: found.enabled,
      fingerprint: found.fingerprint,
      ...(found.agents === undefined ? {} : { agents: [...found.agents] }),
      ...(found.order === undefined ? {} : { order: found.order }),
      ...(found.userBase === true ? { userBase: true as const } : {}),
      ...(found.codemode === true ? { codemode: true as const } : {}),
    }
    return {
      address,
      upstream,
      customizations: customizationsOf(current.records),
      splits: splitsOf(current.records),
    }
  }

  function scopes(): ReturnType<typeof scopesOf> {
    const current = snapshot()
    if (!current) return { global: new Set<string>(), defaults: new Set<string>() }
    return scopesOf(agentSourcesOf(current))
  }

  function resolvedText(node: TreeNode): string {
    const chain = chainFor(node)
    if (!chain) return ""
    const scopesValue = scopes()
    return resolve({
      upstream: chain.upstream,
      records: chain.customizations,
      splits: chain.splits,
      scopes: scopesValue,
      address: chain.address,
    }).text
  }

  function threeWayFor(node: TreeNode): { original: string; mine: string; upstream: string } | undefined {
    const chain = chainFor(node)
    if (!chain) return undefined
    return threeWay({
      upstream: chain.upstream,
      records: chain.customizations,
      splits: chain.splits,
      scopes: scopes(),
      address: chain.address,
    })
  }

  async function persist(
    nextCustomizations: readonly CustomizationRecord[],
    nextSplits: readonly (SplitRecord & { updated?: string })[],
    successStatus: string,
    retryHint: string,
  ): Promise<boolean> {
    const current = snapshot()
    if (!current) {
      setStatus("No snapshot loaded")
      return false
    }
    const requestGen = ++generation
    setLoading(true)
    try {
      const result = await plus["instructions.mutate"](
        {
          expectedRevision: current.revision,
          expectedGlobalRevision: current.globalRevision,
          records: toRpcRecords(nextCustomizations, nextSplits),
        },
        { location: context.location },
      )
      if (disposed || disabled || requestGen !== generation) return false
      if (result.ok) {
        setSnapshot(result.snapshot)
        setStatus(successStatus)
        ensureSelection()
        return true
      }
      setSnapshot(result.snapshot)
      setStatus(
        `Revision changed (expected ${current.revision}/${current.globalRevision}, latest ${result.snapshot.revision}/${result.snapshot.globalRevision}); ${retryHint}`,
      )
      ensureSelection()
      return false
    } catch (error: unknown) {
      if (disposed || disabled || requestGen !== generation) return false
      setStatus(errorMessage(error))
      return false
    } finally {
      if (!disposed && !disabled && requestGen === generation) setLoading(false)
    }
  }

  // Space: flip include/exclude state at the node's own address. Whole items
  // toggle enabled; sections toggle their own exclusion. Team rows carry no
  // address by design (a synthetic address would corrupt chainFor/persist),
  // so they toggle through team.setEnabled with the inverted snapshot state.
  // Unsupported rows (Code Mode tools and their sections, whole Role/persona
  // and whole base rows) refuse: persisting would report "Saved"/"Disabled"
  // for content apply discards, so the status names the row instead.
  async function toggle(node: TreeNode): Promise<boolean> {
    if (node.kind === "team") return toggleTeam(node)
    if (node.address === undefined) {
      setStatus(`"${node.label}" cannot be toggled`)
      return false
    }
    if (node.actions?.toggle !== true) {
      if (node.badges.unsupported === true) {
        setStatus(
          node.badges.unexcludable === true
            ? `"${node.label}" cannot be excluded and remains in effect`
            : `"${node.label}" is unsupported in Code Mode and cannot be toggled`,
        )
        return false
      }
      setStatus(`"${node.label}" cannot be toggled`)
      return false
    }
    const chain = chainFor(node)
    if (!chain) {
      setStatus(`Item not found for "${node.label}"`)
      return false
    }
    const resolved = resolve({
      upstream: chain.upstream,
      records: chain.customizations,
      splits: chain.splits,
      scopes: scopes(),
      address: chain.address,
    })
    const next = merge(chain.customizations, chain.address, { state: resolved.enabled ? "off" : "on" }, chain.upstream)
    return persist(
      next,
      chain.splits,
      resolved.enabled ? `Disabled "${node.label}"` : `Enabled "${node.label}"`,
      `toggled "${node.label}" against a stale revision; retry to apply`,
    )
  }

  // Team toggle: the tree row id is `team:<level>:<team>` (member rows hang
  // one level deeper as `team:<level>:<team>:<member>`). The match takes the
  // first segment after `team:` as the level and everything after as the
  // team name, so names containing colons still parse. Member rows carry no
  // toggle action, so only the team row itself reaches here. Enablement reads from the snapshot (same source the badge
  // renders), inverts, calls team.setEnabled, then refreshes from the host
  // exactly like agent.delete/mcp.remove do — the fresh snapshot rebuilds
  // the tree with the new state. Declared errors surface as status text
  // like every other action path.
  async function toggleTeam(node: TreeNode): Promise<boolean> {
    if (node.actions?.toggle !== true) {
      setStatus(`"${node.label}" cannot be toggled`)
      return false
    }
    const match = node.id.match(/^team:(project|global):(.+)$/)
    const level = match?.[1]
    const team = match === null || match === undefined ? undefined : match[2]
    if (level !== "project" && level !== "global") {
      setStatus(`"${node.label}" cannot be toggled`)
      return false
    }
    if (team === undefined) {
      setStatus(`"${node.label}" cannot be toggled`)
      return false
    }
    const current = snapshot()
    if (!current) {
      setStatus("No snapshot loaded")
      return false
    }
    const entry = (current.teams ?? []).find((candidate) => candidate.level === level && candidate.team === team)
    if (!entry) {
      setStatus(`"${node.label}" cannot be toggled`)
      return false
    }
    const next = !entry.enabled
    const requestGen = ++generation
    setLoading(true)
    try {
      const ref = await plus["team.setEnabled"]({ level, team, enabled: next }, { location: context.location })
      if (disposed || disabled || requestGen !== generation) return false
      if (ref.enabled !== next) {
        setStatus(`Team "${team}" reported ${ref.enabled ? "enabled" : "disabled"} instead of the requested state`)
        return false
      }
      await refresh()
      if (disposed || disabled) return false
      setStatus(next ? `Enabled team "${team}"` : `Disabled team "${team}"`)
      return true
    } catch (error: unknown) {
      if (disposed || disabled || requestGen !== generation) return false
      setStatus(errorMessage(error))
      return false
    } finally {
      if (!disposed && !disabled && requestGen === generation) setLoading(false)
    }
  }

  async function setEnabled(node: TreeNode, value: boolean): Promise<boolean> {
    if (node.address === undefined) {
      setStatus(`"${node.label}" cannot be toggled`)
      return false
    }
    if (node.actions?.toggle !== true) {
      setStatus(`"${node.label}" cannot be toggled`)
      return false
    }
    const chain = chainFor(node)
    if (!chain) {
      setStatus(`Item not found for "${node.label}"`)
      return false
    }
    const next = merge(chain.customizations, chain.address, { state: value ? "on" : "off" }, chain.upstream)
    return persist(
      next,
      chain.splits,
      value ? `Enabled "${node.label}"` : `Disabled "${node.label}"`,
      `toggled "${node.label}" against a stale revision; retry to apply`,
    )
  }

  // Enter (non-review): save a text override at the current address. Gated
  // rows refuse with the same unsupported wording as toggle so section edits
  // on Code Mode tools cannot report "Saved" for discarded content.
  async function saveText(node: TreeNode, text: string): Promise<boolean> {
    if (node.address === undefined) {
      setStatus(`"${node.label}" cannot be edited`)
      return false
    }
    if (node.actions?.edit !== true) {
      if (node.badges.unsupported === true) {
        setStatus(`"${node.label}" is unsupported in Code Mode and cannot be edited`)
        return false
      }
      setStatus(`"${node.label}" cannot be edited`)
      return false
    }
    const chain = chainFor(node)
    if (!chain) {
      setStatus(`Item not found for "${node.label}"`)
      return false
    }
    const next = merge(chain.customizations, chain.address, { text }, chain.upstream)
    return persist(
      next,
      chain.splits,
      `Saved "${node.label}"`,
      `saved "${node.label}" against a stale revision; retry to apply`,
    )
  }

  async function resetNode(node: TreeNode): Promise<boolean> {
    if (node.address === undefined) {
      setStatus(`"${node.label}" cannot be reset`)
      return false
    }
    const chain = chainFor(node)
    if (!chain) {
      setStatus(`Item not found for "${node.label}"`)
      return false
    }
    if (node.actions?.reset !== true) {
      setStatus(`"${node.label}" has no override to reset`)
      return false
    }
    const confirmed = await context.ui.dialog.confirm({
      title: `Reset "${node.label}"?`,
      message: `Reset "${node.label}" to its default? This discards the override and cannot be undone.`,
    })
    if (!confirmed) {
      setStatus(`Reset of "${node.label}" cancelled`)
      return false
    }
    return persist(
      reset(chain.customizations, chain.address),
      chain.splits,
      `Reset "${node.label}" to default`,
      `reset "${node.label}" against a stale revision; retry to apply`,
    )
  }

  // s: persist the item's manual split at the level it was made.
  async function saveSplit(
    node: TreeNode,
    boundaries: readonly { id: string; name: string; start: number }[],
  ): Promise<boolean> {
    const address = node.address
    if (!address) {
      setStatus(`"${node.label}" cannot be split`)
      return false
    }
    if (node.actions?.split !== true) {
      setStatus(`"${node.label}" cannot be split`)
      return false
    }
    const chain = chainFor(node)
    if (!chain) {
      setStatus(`Item not found for "${node.label}"`)
      return false
    }
    const rest = chain.splits.filter(
      (record) => !(record.level === address.level && record.agent === address.agent && record.item === address.item),
    )
    const nextSplits: (SplitRecord & { updated: string })[] = [
      ...rest,
      { type: "split", level: address.level, agent: address.agent, item: address.item, boundaries: [...boundaries], updated: now() },
    ]
    return persist(
      chain.customizations,
      nextSplits,
      `Split "${node.label}"`,
      `split "${node.label}" against a stale revision; retry to apply`,
    )
  }

  // a on an item row: append one section through the manual splitter path.
  // Both halves persist in one mutate: the SplitRecord boundary for the item
  // and the CustomizationRecord text for the new section. Appending at the
  // end keeps existing offsets stable, so the first add on an unsplit item
  // coherently splits its existing text plus the new section.
  async function addSection(node: TreeNode, name: string, text: string): Promise<boolean> {
    const address = node.address
    if (!address || node.kind !== "item") {
      setStatus(`"${node.label}" does not support sections`)
      return false
    }
    if (node.actions?.split !== true) {
      setStatus(`"${node.label}" does not support sections`)
      return false
    }
    const chain = chainFor(node)
    if (!chain) {
      setStatus(`Item not found for "${node.label}"`)
      return false
    }
    const currentText = resolvedText(node)
    // Keep existing manual boundaries (minus any preview-only preamble) and
    // append the new section at the end of the current text.
    const preview = resolveSplit({
      text: currentText,
      title: chain.upstream.title,
      splits: chain.splits,
      scopes: scopes(),
      address: chain.address,
    })
    const existing =
      preview.kind === "manual"
        ? preview.sections
            .filter((section) => section.id !== "preamble")
            .map((section) => ({ id: section.id, name: section.name, start: section.start }))
        : [{ id: "existing", name: chain.upstream.title, start: 0 }]
    const nextStart = currentText.length
    const used = new Set(existing.map((entry) => entry.id))
    const boundaries = [...existing, { id: claim(slugify(name), used), name, start: nextStart }]
    // Build through the same manual() call the splitter previews with so the
    // appended boundary and save always agree.
    const split = manual(currentText, boundaries)
    const added = split.sections.find((section) => section.start === nextStart && section.name === name)
    if (!added) {
      setStatus(`Could not add "${name}" to "${node.label}"`)
      return false
    }
    const rest = chain.splits.filter(
      (record) => !(record.level === address.level && record.agent === address.agent && record.item === address.item),
    )
    const nextSplits: (SplitRecord & { updated: string })[] = [
      ...rest,
      { type: "split", level: address.level, agent: address.agent, item: address.item, boundaries, updated: now() },
    ]
    const sectionAddress: Address = { ...address, section: added.id }
    const sectionUpstream = upstreamSliceOf(split, currentText, added.id)
    const nextCustomizations = merge(
      chain.customizations,
      sectionAddress,
      { text },
      { text: sectionUpstream, fingerprint: fingerprint(sectionUpstream) },
      scopes(),
      nextSplits,
    )
    return persist(
      nextCustomizations,
      nextSplits,
      `Added "${name}" to "${node.label}"`,
      `added "${name}" against a stale revision; retry to apply`,
    )
  }

  // Yellow (review) resolutions via threeWay/resolveResolution.
  async function resolveKeep(node: TreeNode): Promise<boolean> {
    const chain = chainFor(node)
    if (!chain || !node.address) {
      setStatus(`"${node.label}" cannot be resolved`)
      return false
    }
    const next = resolveResolution(
      {
        upstream: chain.upstream,
        records: chain.customizations,
        splits: chain.splits,
        scopes: scopes(),
        address: chain.address,
      },
      "keep",
    )
    return persist(next, chain.splits, `Kept "${node.label}"`, `resolved "${node.label}" against a stale revision; retry`)
  }

  async function resolveTake(node: TreeNode): Promise<boolean> {
    const chain = chainFor(node)
    if (!chain || !node.address) {
      setStatus(`"${node.label}" cannot be resolved`)
      return false
    }
    const next = resolveResolution(
      {
        upstream: chain.upstream,
        records: chain.customizations,
        splits: chain.splits,
        scopes: scopes(),
        address: chain.address,
      },
      "take",
    )
    return persist(next, chain.splits, `Took upstream for "${node.label}"`, `resolved "${node.label}" against a stale revision; retry`)
  }

  async function resolveEdit(node: TreeNode, edited: string): Promise<boolean> {
    const chain = chainFor(node)
    if (!chain || !node.address) {
      setStatus(`"${node.label}" cannot be resolved`)
      return false
    }
    const next = resolveResolution(
      {
        upstream: chain.upstream,
        records: chain.customizations,
        splits: chain.splits,
        scopes: scopes(),
        address: chain.address,
      },
      "edit",
      edited,
    )
    return persist(next, chain.splits, `Edited "${node.label}"`, `resolved "${node.label}" against a stale revision; retry`)
  }

  function splitPreview(node: TreeNode) {
    const chain = chainFor(node)
    if (!chain || !node.address) return undefined
    return resolveSplit({
      text: resolvedText(node),
      title: chain.upstream.title,
      splits: chain.splits,
      scopes: scopes(),
      address: chain.address,
    })
  }

  // d: delete rows whose tree actions allow remove. Agent rows go through
  // agent.delete, shared MCP rows through mcp.remove, project skills through
  // skill.delete, user base templates through base.delete, and project
  // instruction files through instruction.delete. Anything else keeps an
  // honest refusal naming why it cannot be deleted. The route offers d on
  // every item and section row so refusals reach the user as status text;
  // rows without remove actions never delete.
  async function remove(node: TreeNode): Promise<boolean> {
    if (node.kind === "agent") {
      if (node.actions?.remove !== true) {
        setStatus(`"${node.label}" cannot be deleted`)
        return false
      }
      const match = node.id.match(/^agent:(project|global|defaults):(.+)$/)
      const agentId = match?.[2]
      const scope = match?.[1]
      if (!agentId || !scope) {
        setStatus(`"${node.label}" cannot be deleted`)
        return false
      }
      if (scope !== "project" && scope !== "global") {
        setStatus(`"${node.label}" cannot be deleted: agent.delete supports scope project|global only`)
        return false
      }
      const confirmed = await context.ui.dialog.confirm({
        title: `Delete agent ${agentId}?`,
        message: `Delete ${scope} agent "${agentId}"? This cannot be undone.`,
      })
      if (confirmed !== true) {
        setStatus(`Delete of "${node.label}" cancelled`)
        return false
      }
      try {
        await plus["agent.delete"]({ scope, id: agentId }, { location: context.location })
        if (disposed) return false
        await refresh()
        if (disposed) return false
        setStatus(`Deleted agent ${agentId}`)
        return true
      } catch (error: unknown) {
        setStatus(errorMessage(error))
        return false
      }
    }
    const address = node.address
    if (node.kind === "item" && node.actions?.remove !== true) {
      const refusal = refusalFor(node)
      if (refusal !== undefined) {
        setStatus(refusal)
        return false
      }
      setStatus(`"${node.label}" cannot be deleted`)
      return false
    }
    if (node.kind === "section") {
      setStatus(`"${node.label}" cannot be deleted: sections are toggled or split, not deleted`)
      return false
    }
    if (node.actions?.remove !== true) {
      setStatus(`"${node.label}" cannot be deleted`)
      return false
    }
    if (address && address.item.startsWith("mcp:") && address.level === "defaults" && address.agent === null) {
      const name = address.item.slice("mcp:".length)
      const confirmed = await context.ui.dialog.confirm({
        title: `Remove MCP server ${name}?`,
        message: `Remove MCP server "${name}"? This cannot be undone.`,
      })
      if (confirmed !== true) {
        setStatus(`Delete of "${node.label}" cancelled`)
        return false
      }
      try {
        await plus["mcp.remove"]({ name }, { location: context.location })
        if (disposed) return false
        await refresh()
        if (disposed) return false
        setStatus(`Removed MCP server ${name}`)
        return true
      } catch (error: unknown) {
        setStatus(errorMessage(error))
        return false
      }
    }
    const itemId = address?.item ?? node.label
    const item = currentItem(address)
    if (item === undefined) {
      setStatus(`"${node.label}" cannot be deleted`)
      return false
    }
    if (item.kind === "skill" && itemId.startsWith("skill:")) {
      const skillId = itemId.slice("skill:".length)
      if (node.actions?.remove !== true || item.group !== "project") {
        setStatus(`"${node.label}" cannot be deleted: skill "${skillId}" is not project-owned`)
        return false
      }
      const confirmed = await context.ui.dialog.confirm({
        title: `Delete skill ${skillId}?`,
        message: `Delete project skill "${skillId}"? This cannot be undone.`,
      })
      if (confirmed !== true) {
        setStatus(`Delete of "${node.label}" cancelled`)
        return false
      }
      try {
        await plus["skill.delete"]({ id: skillId }, { location: context.location })
        if (disposed) return false
        await refresh()
        if (disposed) return false
        setStatus(`Deleted skill ${skillId}`)
        return true
      } catch (error: unknown) {
        setStatus(errorMessage(error))
        return false
      }
    }
    if (item.kind === "base" && itemId.startsWith("base:")) {
      const templateId = itemId.slice("base:".length)
      if (node.actions?.remove !== true) {
        setStatus(`"${node.label}" cannot be deleted: base template "${templateId}" is built in`)
        return false
      }
      const confirmed = await context.ui.dialog.confirm({
        title: `Delete base template ${templateId}?`,
        message: `Delete base template "${templateId}"? This cannot be undone.`,
      })
      if (confirmed !== true) {
        setStatus(`Delete of "${node.label}" cancelled`)
        return false
      }
      try {
        await plus["base.delete"]({ id: templateId }, { location: context.location })
        if (disposed) return false
        await refresh()
        if (disposed) return false
        setStatus(`Deleted base template ${templateId}`)
        return true
      } catch (error: unknown) {
        setStatus(errorMessage(error))
        return false
      }
    }
    if (item.kind === "system" && itemId.startsWith("system:") && itemId !== "system:role") {
      const relative = itemId.slice("system:".length)
      if (node.actions?.remove !== true) {
        setStatus(`"${node.label}" cannot be deleted: instruction "${relative}" is not project-owned`)
        return false
      }
      const confirmed = await context.ui.dialog.confirm({
        title: `Delete instruction ${relative}?`,
        message: `Delete instruction "${relative}"? This cannot be undone.`,
      })
      if (confirmed !== true) {
        setStatus(`Delete of "${node.label}" cancelled`)
        return false
      }
      try {
        await plus["instruction.delete"]({ name: relative }, { location: context.location })
        if (disposed) return false
        await refresh()
        if (disposed) return false
        setStatus(`Deleted instruction ${relative}`)
        return true
      } catch (error: unknown) {
        setStatus(errorMessage(error))
        return false
      }
    }
    if (item.kind === "system" && itemId === "system:role") {
      setStatus(`"${node.label}" cannot be deleted: the agent's own prompt body is not a file`)
      return false
    }
    setStatus(`"${node.label}" cannot be deleted`)
    return false
  }

  function refusalFor(node: TreeNode): string | undefined {
    const address = node.address
    if (address === undefined) return undefined
    const item = currentItem(address)
    if (item === undefined) return undefined
    if (item.kind === "skill") {
      const skillId = address.item.startsWith("skill:") ? address.item.slice("skill:".length) : address.item
      return `"${node.label}" cannot be deleted: skill "${skillId}" is not project-owned`
    }
    if (item.kind === "base") {
      const templateId = address.item.startsWith("base:") ? address.item.slice("base:".length) : address.item
      return `"${node.label}" cannot be deleted: base template "${templateId}" is built in`
    }
    if (item.kind === "system" && item.id !== "system:role") {
      const relative = address.item.startsWith("system:") ? address.item.slice("system:".length) : address.item
      return `"${node.label}" cannot be deleted: instruction "${relative}" is not project-owned`
    }
    if (node.kind === "section") return `"${node.label}" cannot be deleted: sections are toggled or split, not deleted`
    if (item.id === "system:role") return `"${node.label}" cannot be deleted: the agent's own prompt body is not a file`
    if (item.kind === "tool" || item.kind === "mcp")
      return `"${node.label}" cannot be deleted: ${item.kind} rows are not files`
    return undefined
  }

  function currentItem(address: Address | undefined) {
    if (address === undefined) return undefined
    const items = snapshot()?.items
    if (items === undefined) return undefined
    return upstreamFor(items, address)
  }

  void load()
  const unsubscribeInstructions = plus.events.on("instructions.changed", () => {
    void load()
  })
  const unsubscribeProject = plus.events.on("project.changed", (event) => {
    if (!event.data.enabled) {
      disabled = true
      generation++
      setSnapshot(undefined)
      setSelectedId(undefined)
      setLoading(false)
      setStatus("Project mode is disabled for this directory")
      return
    }
    disabled = false
    void load()
  })

  function dispose() {
    disposed = true
    generation++
    unsubscribeInstructions()
    unsubscribeProject()
  }

  return {
    snapshot,
    nodes,
    allNodes,
    selected,
    selectedId,
    expanded,
    filter,
    setFilter,
    status,
    loading,
    toggleExpanded,
    select,
    selectAgent,
    move,
    toggle,
    setEnabled,
    saveText,
    reset: resetNode,
    saveSplit,
    addSection,
    splitPreview,
    resolvedText,
    threeWay: threeWayFor,
    resolveKeep,
    resolveTake,
    resolveEdit,
    remove,
    refresh,
    dispose,
  }
}

export type InstructionsState = ReturnType<typeof createInstructionsState>

function upstreamSliceOf(split: Split, text: string, id: string): string {
  const section = split.sections.find((entry) => entry.id === id)
  if (section === undefined) return ""
  return slice(text, section)
}

// Same slug rules as the manual splitter so add-section ids match.
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

function now(): string {
  return new Date().toISOString()
}

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  if (typeof error === "object" && error !== null && "message" in error && typeof error.message === "string")
    return error.message
  return String(error)
}
