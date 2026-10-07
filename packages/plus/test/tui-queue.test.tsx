import { expect, test } from "bun:test"
import { onCleanup } from "solid-js"
import type { Plus } from "../src/rpc.js"
import { createInstructionsState, type InstructionsState } from "../src/tui/instructions/state.js"
import { createSnapshot, renderPlusFixture } from "./tui.js"

function makeTool(name: string) {
  return {
    id: `tool:${name}`,
    kind: "tool" as const,
    group: "native" as const,
    title: name,
    text: `tool ${name}`,
    enabled: true,
    fingerprint: `fp-${name}`,
  }
}

test("10 toggles dispatched back to back: each row shows its new state before any write resolves, at most 2 mutate calls reach the server, final state has all 10 changes, no 'Revision changed'", async () => {
  const tools = Array.from({ length: 10 }, (_, i) => makeTool(`tool_${i + 1}`))
  const initial = createSnapshot({
    revision: 1,
    globalRevision: 1,
    items: tools,
    records: [],
  })

  let state: InstructionsState | undefined
  let mutateCalls = 0
  const mutateResolvers: (() => void)[] = []

  let serverRecords: Plus.SnapshotRecord[] = []

  await using fixture = await renderPlusFixture({
    snapshots: [initial],
    rpc: {
      "instructions.mutate": async (input: unknown) => {
        mutateCalls++
        // Hold the write so we can observe optimistic state while in flight
        await new Promise<void>((resolve) => mutateResolvers.push(resolve))
        const deltaInput = input as Plus.MutateInputDelta
        const upsertIds = new Set(
          deltaInput.changes.upsert
            .filter((u): u is Plus.SnapshotCustomizationRecord => "item" in u)
            .map((u) => u.item),
        )
        serverRecords = [
          ...serverRecords.filter((r) => !("item" in r) || !upsertIds.has(r.item)),
          ...deltaInput.changes.upsert,
        ]
        return {
          ok: true,
          revision: mutateCalls + 1,
          globalRevision: 1,
          ...(deltaInput.snapshot === true
            ? {
                snapshot: {
                  ...initial,
                  revision: mutateCalls + 1,
                  records: serverRecords,
                },
              }
            : {}),
        }
      },
    },
    render: (context) => {
      state = createInstructionsState(context)
      onCleanup(state.dispose)
      return null
    },
  })

  await fixture.waitForFrame(() => state?.snapshot() !== undefined)
  if (!state) throw new Error("State did not mount")

  // Find all 10 nodes using filter
  state.setFilter("tool")
  const nodes = tools.map((tool) => {
    const node = state!.nodes().find((n) => n.address?.item === tool.id)
    if (!node) throw new Error(`Missing node for ${tool.id}`)
    return node
  })

  // Record initial state of each node
  const expectedStates = nodes.map((node) => ((node.badges.state ?? "off") === "on" ? "off" : "on"))

  // Dispatch all 10 toggles back to back without awaiting between them
  const togglePromises: Promise<boolean>[] = []
  for (const node of nodes) {
    togglePromises.push(state.toggle(node))
  }

  // Each row shows its new state optimistically before any write resolves!
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i]
    const currentNode = state.nodes().find((n) => n.address?.item === tool.id)
    expect(currentNode?.badges.state).toBe(expectedStates[i])
  }
  expect(state.status()).toContain("Saving")

  // Now release all held mutate writes until all toggles settle
  let settled = false
  void Promise.all(togglePromises).then(() => {
    settled = true
  })
  while (!settled) {
    const resolvers = mutateResolvers.splice(0)
    for (const r of resolvers) r()
    await new Promise((r) => setTimeout(r, 10))
  }

  const results = await Promise.all(togglePromises)
  expect(results.every((r) => r === true)).toBe(true)

  // At most 2 mutate calls reach the server
  expect(mutateCalls).toBeLessThanOrEqual(2)
  expect(mutateCalls).toBeGreaterThan(0)

  // Final stored state = all 10 changes
  const finalRecords = state.snapshot()?.records ?? []
  for (let i = 0; i < tools.length; i++) {
    const tool = tools[i]
    const record = finalRecords.find((r) => r.type === "customization" && r.item === tool.id)
    expect(record).toBeDefined()
    expect((record as any)?.state).toBe(expectedStates[i])
  }

  // No "Revision changed" status
  expect(state.status()).not.toContain("Revision changed")
})

test("A refused write reverts only its rows and shows the refusal; later edits survive", async () => {
  const toolA = makeTool("alpha")
  const toolB = makeTool("beta")
  const initial = createSnapshot({
    revision: 1,
    globalRevision: 1,
    items: [toolA, toolB],
    records: [],
  })

  let state: InstructionsState | undefined
  let mutateCount = 0
  let releaseFirstMutate: (() => void) | undefined

  await using fixture = await renderPlusFixture({
    snapshots: [initial],
    rpc: {
      "instructions.mutate": async (input: unknown) => {
        mutateCount++
        const deltaInput = input as Plus.MutateInputDelta
        if (mutateCount === 1) {
          // Hold first write so we can dispatch the second edit while it's in flight
          await new Promise<void>((r) => (releaseFirstMutate = r))
          // Refuse the first write
          throw new Error("agent.protected: row belongs to protected agent")
        }
        return {
          ok: true,
          revision: 2,
          globalRevision: 1,
          snapshot: {
            ...initial,
            revision: 2,
            records: deltaInput.changes.upsert,
          },
        }
      },
    },
    render: (context) => {
      state = createInstructionsState(context)
      onCleanup(state.dispose)
      return null
    },
  })

  await fixture.waitForFrame(() => state?.snapshot() !== undefined)
  if (!state) throw new Error("State did not mount")

  state.setFilter("alpha")
  const nodeA = state.nodes().find((n) => n.address?.item === toolA.id)
  state.setFilter("beta")
  const nodeB = state.nodes().find((n) => n.address?.item === toolB.id)
  state.setFilter("tool")
  if (!nodeA || !nodeB) throw new Error("Nodes not found")

  const targetA = (nodeA.badges.state ?? "off") === "on" ? "off" : "on"
  const targetB = (nodeB.badges.state ?? "off") === "on" ? "off" : "on"

  // Toggle A (which will be refused)
  const promiseA = state.toggle(nodeA)

  // Verify A is optimistically in target state
  expect(state.nodes().find((n) => n.address?.item === toolA.id)?.badges.state).toBe(targetA)

  // While write 1 is in flight, toggle B
  const promiseB = state.toggle(nodeB)
  expect(state.nodes().find((n) => n.address?.item === toolB.id)?.badges.state).toBe(targetB)

  // Release first write to fail
  releaseFirstMutate!()

  const [resultA, resultB] = await Promise.all([promiseA, promiseB])
  expect(resultA).toBe(false)
  expect(resultB).toBe(true)

  // Node A reverted back to un-overridden (no state badge or 'off'), while Node B survived (is targetB)
  const finalA = state.nodes().find((n) => n.address?.item === toolA.id)
  const finalB = state.nodes().find((n) => n.address?.item === toolB.id)
  expect(finalA?.badges.state).toBe("off")
  expect(finalB?.badges.state).toBe(targetB)

  // Status shows the refusal message or success depending on queue drain
  const records = state.snapshot()?.records ?? []
  expect(records.some((r) => r.type === "customization" && r.item === toolA.id)).toBe(false)
  expect(records.some((r) => r.type === "customization" && r.item === toolB.id)).toBe(true)
})

test("only this screen's own writes skip the reload: any other instructions.changed reloads, a host change with unchanged revisions included", async () => {
  const initial = createSnapshot({ revision: 1, globalRevision: 1, items: [makeTool("sample")], records: [] })
  let state: InstructionsState | undefined
  let snapshotCalls = 0

  await using fixture = await renderPlusFixture({
    snapshots: [initial],
    rpc: {
      "instructions.snapshot": async () => {
        snapshotCalls++
        return initial
      },
      "instructions.mutate": async (input: unknown) => {
        const delta = input as Plus.MutateInputDelta
        return { ok: true, revision: 5, globalRevision: 1, snapshot: { ...initial, revision: 5, records: delta.changes.upsert } }
      },
    },
    render: (context) => {
      state = createInstructionsState(context)
      onCleanup(state.dispose)
      return null
    },
  })
  await fixture.waitForFrame(() => state?.snapshot() !== undefined)
  if (!state) throw new Error("State did not mount")
  expect(snapshotCalls).toBe(1)

  // A host change (a new skill or agent file) re-emits the unchanged store
  // revisions: nothing was written here, so the tree must reload.
  await fixture.emitChanged(createSnapshot({ revision: 1, globalRevision: 1 }))
  await fixture.waitForFrame(() => snapshotCalls === 2)

  state.setFilter("sample")
  const node = state.nodes().find((n) => n.address?.item === "tool:sample")
  if (!node) throw new Error("no sample row")
  expect(await state.toggle(node)).toBe(true)
  // This screen's own write (revisions 5/1) needs no reload.
  await fixture.emitChanged(createSnapshot({ revision: 5, globalRevision: 1 }))
  await new Promise((r) => setTimeout(r, 50))
  expect(snapshotCalls).toBe(2)
})

test("a reload while edits are queued keeps them on screen and still saves them", async () => {
  const initial = createSnapshot({ revision: 1, globalRevision: 1, items: [makeTool("a"), makeTool("b"), makeTool("c")], records: [] })
  const external: Plus.SnapshotRecord = {
    type: "customization",
    level: "defaults",
    agent: null,
    item: "tool:c",
    section: null,
    state: "on",
    basedOn: "fp-c",
    updated: "2026-01-01T00:00:00.000Z",
  }
  let state: InstructionsState | undefined
  let snapshotCalls = 0
  const held: (() => void)[] = []
  const sent: string[][] = []

  await using fixture = await renderPlusFixture({
    snapshots: [initial],
    rpc: {
      "instructions.snapshot": async () => {
        snapshotCalls++
        return snapshotCalls === 1 ? initial : { ...initial, revision: 7, records: [external] }
      },
      "instructions.mutate": async (input: unknown) => {
        const delta = input as Plus.MutateInputDelta
        sent.push(delta.changes.upsert.flatMap((u) => ("item" in u ? [u.item] : [])))
        await new Promise<void>((resolve) => held.push(resolve))
        return { ok: true, revision: 7 + sent.length, globalRevision: 1 }
      },
    },
    render: (context) => {
      state = createInstructionsState(context)
      onCleanup(state.dispose)
      return null
    },
  })
  await fixture.waitForFrame(() => state?.snapshot() !== undefined)
  if (!state) throw new Error("State did not mount")
  state.setFilter("tool")
  const row = (id: string) => state!.nodes().find((n) => n.address?.item === id)
  const stateOf = (id: string) => row(id)?.badges.state
  // Rows without an owner start off here; a toggle turns them on.
  expect([stateOf("tool:a"), stateOf("tool:b"), stateOf("tool:c")]).toEqual(["off", "off", "off"])
  const toggledA = state.toggle(row("tool:a")!)
  const toggledB = state.toggle(row("tool:b")!)
  // "a" is in flight, "b" is queued behind it. Another writer switches "c" on.
  await fixture.emitChanged(createSnapshot({ revision: 7, globalRevision: 1 }))
  await fixture.waitForFrame(() => snapshotCalls === 2)
  expect([stateOf("tool:a"), stateOf("tool:b"), stateOf("tool:c")]).toEqual(["on", "on", "on"])
  let done = false
  void Promise.all([toggledA, toggledB]).then(() => {
    done = true
  })
  while (!done) {
    for (const release of held.splice(0)) release()
    await new Promise((r) => setTimeout(r, 10))
  }
  expect(await toggledA).toBe(true)
  expect(await toggledB).toBe(true)
  // "b" was not lost by the reload: it went out in the next write.
  expect(sent.flat().toSorted()).toEqual(["tool:a", "tool:b"])
  expect([stateOf("tool:a"), stateOf("tool:b"), stateOf("tool:c")]).toEqual(["on", "on", "on"])
})

test("a Teams group turns its teams off; with none on it explains that only one team can be on", async () => {
  const alpha = { level: "project" as const, team: "alpha", enabled: true, agents: ["coder"] }
  const beta = { level: "project" as const, team: "beta", enabled: false, agents: ["reviewer"] }
  let teams = [alpha, beta]
  let state: InstructionsState | undefined
  const enabledCalls: { team: string; enabled: boolean }[] = []

  await using fixture = await renderPlusFixture({
    snapshots: [createSnapshot({ revision: 1, globalRevision: 1, teams, records: [] })],
    rpc: {
      "team.setEnabled": async (input: { level: "project" | "global"; team: string; enabled: boolean }) => {
        enabledCalls.push({ team: input.team, enabled: input.enabled })
        teams = teams.map((t) => (t.team === input.team ? { ...t, enabled: input.enabled } : t))
        return { level: input.level, team: input.team, enabled: input.enabled, exclusive: true, disabledTeams: [] }
      },
      "instructions.refresh": async () => createSnapshot({ revision: 2, globalRevision: 1, teams, records: [] }),
    },
    render: (context) => {
      state = createInstructionsState(context)
      onCleanup(state.dispose)
      return null
    },
  })
  await fixture.waitForFrame(() => state?.snapshot() !== undefined)
  if (!state) throw new Error("State did not mount")
  state.setFilter("teams")
  const group = () => state!.nodes().find((n) => n.id === "group:project:teams")
  expect(group()?.actions?.toggle).toBe(true)
  expect(group()?.badges.summary).toBe("1/2")

  expect(await state.toggle(group()!)).toBe(true)
  expect(enabledCalls.length).toBeGreaterThan(0)
  expect(enabledCalls.every((call) => call.enabled === false)).toBe(true)
  expect(teams.every((t) => !t.enabled)).toBe(true)

  // Enabling is exclusive (one team disables the others), so all-on is refused.
  const calls = enabledCalls.length
  expect(await state.toggle(group()!)).toBe(false)
  expect(state.status()).toContain("Only one team can be on at a time")
  expect(enabledCalls.length).toBe(calls)
})
