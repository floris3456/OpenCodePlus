import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPlusApi, createState } from "../src/index.js"
import { projectRecordsPath } from "../src/instructions/paths.js"
import { load } from "../src/instructions/store.js"
import { agentInfo, fullContext } from "./harness.js"

// The measured store the brief names: a copy of the live dev store (329
// records). It is copied into a temp config dir, never kept. When it is not
// present the benchmark is skipped rather than failing the suite.
const SOURCE =
  "/home/bliss/OpenCodePlus/run/plus-dev/worktrees-plus-1.1.17-opencode/config/opencode/opencodeplus/instructions/records.jsonl"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

test("mutate time on a ~300-record store: full form vs delta form", async () => {
  const source = Bun.file(SOURCE)
  if (!(await source.exists())) {
    console.log("write-path benchmark skipped: no source store at", SOURCE)
    return
  }
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-write-path-bench-"))
  roots.push(root)
  const config = path.join(root, "config")
  process.env.OPENCODE_CONFIG_DIR = config
  const project = path.join(root, "project")
  const target = path.join(config, "opencodeplus", "instructions", "records.jsonl")
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, await source.text())
  await Bun.write(projectRecordsPath(project), "")

  const state = createState()
  const api = createPlusApi(
    fullContext({ directory: project, agents: [agentInfo("alpha", "role"), agentInfo("beta", "role")] }),
    state,
  )
  const snapshot = await api.snapshot()
  const records = snapshot.value.records
  // Pick an ordinary inventory row (a toggle target), not a control row whose
  // text is validated.
  const targetRow = records.find(
    (record) => record.type === "customization" && !record.item.startsWith("setting:") && !record.item.startsWith("compaction:"),
  )
  if (targetRow === undefined || targetRow.type !== "customization") {
    console.log("write-path benchmark skipped: source store has no plain customization row")
    return
  }
  const stored = await load(project)
  const before = stored.records

  const current = (await api.snapshot()).value
  const fullStart = performance.now()
  const full = await api.mutate({
    expectedRevision: current.revision,
    expectedGlobalRevision: current.globalRevision,
    records: records.map((record) =>
      record === targetRow ? { ...targetRow, text: `${targetRow.text ?? ""} `, updated: new Date().toISOString() } : record,
    ),
  })
  const fullMs = performance.now() - fullStart
  if (!full.ok) throw new Error(`full mutate error: ${full.error.code} ${full.error.message}`)
  if (!full.value.ok)
    throw new Error(
      `full mutate stale: store=${full.value.store} expected=${current.revision}/${current.globalRevision} ` +
        `latest=${full.value.snapshot.revision}/${full.value.snapshot.globalRevision}`,
    )

  const deltaRow = { ...targetRow, text: `${targetRow.text ?? ""}  `, updated: new Date().toISOString() }
  const deltaStart = performance.now()
  const delta = await api.mutate({ changes: { upsert: [deltaRow], remove: [] } })
  const deltaMs = performance.now() - deltaStart
  if (!delta.ok) throw new Error(`delta mutate error: ${delta.error.code} ${delta.error.message}`)
  if (!delta.value.ok) throw new Error("delta mutate stale")

  // The delta request body is one row; the full body is the whole store.
  const fullBytes = JSON.stringify(records).length
  const deltaBytes = JSON.stringify({ changes: { upsert: [deltaRow], remove: [] } }).length
  const deltaStored = await load(project)
  const beforeBytes = JSON.stringify(before.map((record) => JSON.stringify(record))).length
  console.log(
    `write-path benchmark: records=${records.length} full=${fullMs.toFixed(1)}ms delta=${deltaMs.toFixed(1)}ms ` +
      `fullBody=${fullBytes}B deltaBody=${deltaBytes}B storedBefore=${beforeBytes}B`,
  )
  expect(deltaStored.records.length).toBe(before.length)
})
