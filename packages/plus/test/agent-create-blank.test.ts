import { afterEach, expect, test } from "bun:test"
import type { Rpc } from "@opencode/schema/rpc"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createPlusApi, createState, type PlusState } from "../src/index.js"
import { Plus } from "../src/rpc.js"
import { enable } from "../src/project.js"
import { fullContext } from "./harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

function captureEmits(state: PlusState): Array<{ name: string; data: unknown }> {
  const emitted: Array<{ name: string; data: unknown }> = []
  state.registration = {
    dispose: Effect.void,
    events: {
      emit: (...args: Rpc.EventInput<typeof Plus.Definition>) =>
        Effect.sync(() => {
          emitted.push({ name: args[0], data: args[1] })
        }).pipe(Effect.asVoid),
    },
  }
  return emitted
}

test("blank-prompt agent create writes the file, emits one instructions.changed, and snapshots blank", async () => {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-agent-create-blank-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  const project = path.join(root, "project")
  await enable(project)
  const ctx = fullContext({ directory: project })
  const state = createState()
  const api = createPlusApi(ctx, state)
  // Prime the publish fingerprint so the create path exercises the
  // fingerprint-unchanged early return instead of the first-publish path.
  const primed = await api.refresh()
  if (!primed.ok) throw new Error(`priming refresh failed: ${primed.error.message}`)
  // Subscribe to the Plus event stream before the create call.
  const emitted = captureEmits(state)
  const created = await api.createAgent({ scope: "project", id: "blank", fields: { mode: "primary" }, prompt: "" })
  if (!created.ok) throw new Error(`createAgent failed: ${created.error.message}`)
  // (a) the agent file exists with the exact formatMarkdown bytes for a blank prompt.
  expect(await Bun.file(created.value.path).exists()).toBe(true)
  expect(await Bun.file(created.value.path).text()).toBe("---\nmode: primary\n---\n")
  // (b) exactly one instructions.changed is emitted synchronously by the create call.
  const changed = emitted.filter((entry) => entry.name === "instructions.changed")
  expect(changed).toHaveLength(1)
  // (c) the next snapshot lists the new agent.
  const snapshot = await api.snapshot()
  if (!snapshot.ok) throw new Error(`snapshot failed: ${snapshot.error.message}`)
  expect(snapshot.value.agents.map((agent) => agent.id)).toContain("blank")
})
