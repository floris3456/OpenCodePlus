import { expect, test } from "bun:test"
import { createComponent } from "solid-js"
import { createAgentActions } from "../src/tui/agents/create.js"
import { createInstructionsDialogs } from "../src/tui/instructions/dialogs.js"
import type { InstructionsState } from "../src/tui/instructions/state.js"
import { createSnapshotCache, type SnapshotCache } from "../src/tui/snapshot-cache.js"
import { createSnapshot, renderInstructionsRoute, renderPlusFixture } from "./tui.js"
import { sleep } from "./instructions-nav.js"

function projectAgent(id: string) {
  return { id, scope: "project" as const, fileBacked: true, origin: "user" as const }
}

// The plugin-level cache survives the screen: the load that populated it is
// the one the first open needed, and reopening renders it at once while the
// revalidating snapshot RPC is still pending.
test("P6: reopening renders the cached snapshot before the background reload answers", async () => {
  const first = createSnapshot({ agents: [projectAgent("Cached")] })
  const populate = await renderInstructionsRoute({
    snapshots: [first],
    data: { agent: "Cached" },
    width: 120,
    height: 40,
  })
  await populate.waitForFrame((frame) => frame.includes("Cached") && frame.includes("▌"))
  populate.destroy()
  // The route's own load filled the plugin cache.
  const cache = populate.cache
  expect(cache.fresh(undefined)?.agents.map((agent) => agent.id)).toEqual(["Cached"])

  const fresh = createSnapshot({ revision: 2, globalRevision: 2, agents: [projectAgent("Cached"), projectAgent("Fresh")] })
  const reopened = await renderInstructionsRoute({
    snapshots: [fresh],
    cache,
    data: { agent: "Cached" },
    width: 120,
    height: 40,
    holdSnapshots: true,
  })
  // The cached rows are on screen while the reload is held.
  await reopened.waitForFrame((frame) => frame.includes("Cached") && frame.includes("Instructions"))
  expect(reopened.fake.snapshotCalls).toBe(1)
  expect(reopened.captureCharFrame()).not.toContain("Fresh")
  await reopened.releaseSnapshots()
  await reopened.waitForFrame((frame) => frame.includes("Fresh"))
  expect(cache.fresh(undefined)?.agents.map((agent) => agent.id)).toEqual(["Cached", "Fresh"])
  reopened.destroy()
})

// Control: with an empty cache the screen behaves as before — the loading
// state until the first snapshot resolves.
test("P6 control: the first open with an empty cache shows the loading state until the snapshot answers", async () => {
  const cache = createSnapshotCache()
  const snapshot = createSnapshot({ agents: [projectAgent("Implementer")] })
  const fixture = await renderInstructionsRoute({
    snapshots: [snapshot],
    cache,
    data: { agent: "Implementer" },
    width: 120,
    height: 40,
    holdSnapshots: true,
  })
  await fixture.waitForFrame((frame) => frame.includes("No snapshot loaded"))
  expect(fixture.captureCharFrame()).not.toContain("Implementer")
  await fixture.releaseSnapshots()
  await fixture.waitForFrame((frame) => frame.includes("Implementer"))
  fixture.destroy()
})

// With the screen closed, a burst of change events only marks the cache
// stale: nothing refetches, and the next open fetches exactly once.
test("P6: closed screen marks the cache stale without fetching; the next open fetches once", async () => {
  const first = createSnapshot({ agents: [projectAgent("Cached")] })
  const closed = await renderInstructionsRoute({
    snapshots: [first],
    data: { agent: "Cached" },
    width: 120,
    height: 40,
  })
  await closed.waitForFrame((frame) => frame.includes("Cached") && frame.includes("▌"))
  const cache = closed.cache
  const openedCalls = closed.fake.snapshotCalls
  expect(openedCalls).toBe(1)
  closed.destroy()

  const second = createSnapshot({ revision: 2, globalRevision: 2, agents: [projectAgent("Cached"), projectAgent("Fresh")] })
  for (let event = 0; event < 5; event++) await closed.emitChanged(second)
  await sleep(50)
  expect(closed.fake.snapshotCalls).toBe(openedCalls)
  expect(cache.fresh(undefined)).toBeUndefined()

  const reopened = await renderInstructionsRoute({
    snapshots: [second],
    cache,
    data: { agent: "Cached" },
    width: 120,
    height: 40,
  })
  try {
    await reopened.waitForFrame((frame) => frame.includes("Fresh"))
    expect(reopened.fake.snapshotCalls).toBe(1)
  } finally {
    reopened.destroy()
  }
})

// The palette's agent actions read a fresh cache without an RPC and refill it
// once when it is stale.
test("P6: createAgentActions reads a fresh cache and fetches once when stale", async () => {
  async function renameWith(cache: SnapshotCache) {
    let actions: ReturnType<typeof createAgentActions> | undefined
    const fixture = await renderPlusFixture({
      snapshots: [createSnapshot()],
      cache,
      render: (context, fixtureCache) => {
        actions = createAgentActions(context, fixtureCache)
        return createComponent(() => <text>actions</text>, {})
      },
    })
    await actions?.renameAgent()
    await actions?.renameAgent()
    return fixture
  }

  const fresh = createSnapshotCache()
  fresh.put(undefined, createSnapshot())
  const freshFixture = await renameWith(fresh)
  try {
    expect(freshFixture.fake.snapshotCalls).toBe(0)
    expect(freshFixture.fake.toasts.some((toast) => toast.message === "No agents found")).toBe(true)
  } finally {
    freshFixture.destroy()
  }

  const stale = createSnapshotCache()
  stale.put(undefined, createSnapshot())
  stale.markStale(undefined)
  const staleFixture = await renameWith(stale)
  try {
    // One fetch refilled the cache; the second read used it.
    expect(staleFixture.fake.snapshotCalls).toBe(1)
    expect(stale.fresh(undefined)).toBeDefined()
  } finally {
    staleFixture.destroy()
  }
})

// The dialogs' currentSnapshot() follows the same rule: a fresh entry answers
// without an RPC; a stale one fetches exactly once.
test("P6: dialogs read a fresh cache and fetch once when stale", async () => {
  async function addAgentWith(cache: SnapshotCache) {
    let dialogs: ReturnType<typeof createInstructionsDialogs> | undefined
    const fixture = await renderPlusFixture({
      snapshots: [createSnapshot()],
      cache,
      dialogs: { prompts: ["my-agent"] },
      render: (context, fixtureCache) => {
        const state = { snapshot: () => undefined, refresh: async () => {} } as unknown as InstructionsState
        dialogs = createInstructionsDialogs(context, state, {}, fixtureCache)
        return createComponent(() => <text>dialogs</text>, {})
      },
    })
    const group = {
      id: "group:project:agents",
      kind: "group",
      label: "Agents",
      depth: 1,
      add: "agent",
      badges: {},
    } as unknown as Parameters<NonNullable<typeof dialogs>["addFor"]>[0]
    await dialogs?.addFor(group)
    await dialogs?.addFor(group)
    return fixture
  }

  const fresh = createSnapshotCache()
  fresh.put(undefined, createSnapshot())
  const freshFixture = await addAgentWith(fresh)
  try {
    expect(freshFixture.fake.snapshotCalls).toBe(0)
  } finally {
    freshFixture.destroy()
  }

  const stale = createSnapshotCache()
  stale.put(undefined, createSnapshot())
  stale.markStale(undefined)
  const staleFixture = await addAgentWith(stale)
  try {
    expect(staleFixture.fake.snapshotCalls).toBe(1)
    expect(stale.fresh(undefined)).toBeDefined()
  } finally {
    staleFixture.destroy()
  }
})
