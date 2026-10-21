import { expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { createPlusApi, createState, deactivate } from "../src/index.js"
import { fingerprint } from "../src/instructions/model.js"
import { load, save } from "../src/instructions/store.js"
import { memoInputOf } from "../src/instructions/snapshot.js"
import { expandedTree } from "../src/instructions/tree.js"
import { query } from "../src/instructions/query.js"
import { createTeamApi } from "../src/teams/api.js"
import { registerTeamTools } from "../src/teams/tools.js"
import { agentInfo, fullContext } from "./harness.js"

test("removed team tool records load, stay orphaned in the tree and do not block publication", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "plus-retired-tool-"))
  const before = { config: process.env.OPENCODE_CONFIG_DIR, data: process.env.XDG_DATA_HOME }
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  process.env.XDG_DATA_HOME = path.join(root, "data")
  const state = createState()
  try {
    const project = path.join(root, "project")
    const records = ["perm:team_set_checks:approval.every", "perm:team_set_checks:checks.tests", "tool:team_set_checks"].map((item) => ({
      type: "customization" as const,
      level: "project" as const,
      agent: "build",
      item,
      section: null,
      state: "off" as const,
      text: "retired customization",
      basedOn: fingerprint("old row"),
      updated: "2026-01-01T00:00:00.000Z",
    }))
    expect((await save(project, { expectedProjectRevision: 0, expectedGlobalRevision: 0, records })).ok).toBe(true)
    expect((await load(project)).records).toEqual(records)
    const ctx = fullContext({ directory: project, agents: [agentInfo("build")] })
    const registration = await registerTeamTools(ctx, createTeamApi(ctx, state))
    try {
      const api = createPlusApi(ctx, state)
      const published = await api.refresh()
      expect(published.ok).toBe(true)
      expect(published.value.items.some((item) => item.id.includes("team_set_checks"))).toBe(false)
      const memo = memoInputOf(published.value)
      expect(expandedTree(memo).some((node) => node.address?.item.includes("team_set_checks"))).toBe(false)
      expect(query(memo, { where: "is:orphaned" }).rows.map((row) => row.id).sort()).toEqual(records.map((record) => `item:project:build:${record.item}`).sort())
      expect((await load(project)).records).toEqual(records)
      expect((await api.refresh()).ok).toBe(true)
    } finally {
      await Effect.runPromise(registration.dispose)
    }
  } finally {
    await Effect.runPromise(deactivate(state))
    if (before.config === undefined) delete process.env.OPENCODE_CONFIG_DIR
    if (before.config !== undefined) process.env.OPENCODE_CONFIG_DIR = before.config
    if (before.data === undefined) delete process.env.XDG_DATA_HOME
    if (before.data !== undefined) process.env.XDG_DATA_HOME = before.data
    await rm(root, { recursive: true, force: true })
  }
})
