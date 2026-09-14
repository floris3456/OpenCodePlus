import { afterEach, expect, test } from "bun:test"
import { Effect, Exit } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHandlers, createState } from "../src/index.js"
import { fingerprint } from "../src/instructions/model.js"
import { enable } from "../src/project.js"
import { agentInfo, fullContext } from "./harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempRoot(): Promise<{ project: string; config: string }> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-base-templates-"))
  roots.push(root)
  const config = path.join(root, "config")
  process.env.OPENCODE_CONFIG_DIR = config
  return { project: path.join(root, "project"), config }
}

function throwingContext(captured: { current?: { type: string; message: string; data?: unknown } }): {
  error: (type: string, message: string, data?: unknown) => never
} {
  return {
    error: (type, message, data) => {
      const failure = data === undefined ? { type, message } : { type, message, data }
      captured.current = failure
      throw failure
    },
  }
}

async function expectDeclaredError(effect: Effect.Effect<unknown, unknown>, captured: { current?: { type: string } }, type: string): Promise<void> {
  const exit = await Effect.runPromiseExit(effect)
  expect(Exit.isFailure(exit)).toBe(true)
  expect(captured.current?.type).toBe(type)
}

test("user base template survives a host that reports its own templates", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const hostTemplates = [
    { id: "gpt", title: "GPT.txt", text: "host gpt base" },
    { id: "general", title: "General.txt", text: "host general base" },
  ]
  const handlers = createHandlers(
    fullContext({ directory: project, agents: [agentInfo("alpha", "upstream")], templates: hostTemplates }),
    createState(),
  )
  const created = await Effect.runPromise(
    handlers["base.create"]({ id: "custom", title: "Custom.txt", text: "custom base text" }, throwingContext({})),
  )
  expect(created).toEqual({ id: "custom" })
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const user = snapshot.items.find((item) => item.id === "base:custom")
  expect(user).toMatchObject({ kind: "base", group: "none", title: "Custom.txt", text: "custom base text", enabled: true })
  expect(user?.fingerprint).toBe(fingerprint("custom base text"))
  // Host templates still listed alongside the user template.
  expect(snapshot.items.find((item) => item.id === "base:gpt")?.text).toBe("host gpt base")
  const deleted = await Effect.runPromise(handlers["base.delete"]({ id: "custom" }, throwingContext({})))
  expect(deleted).toEqual({ id: "custom" })
  const after = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  expect(after.items.some((item) => item.id === "base:custom")).toBe(false)
  const builtin: { current?: { type: string; message: string; data?: unknown } } = {}
  await expectDeclaredError(handlers["base.delete"]({ id: "gpt" }, throwingContext(builtin)), builtin, "base.invalid")
})

test("a user template that is not the host's active answer is never applied", async () => {
  const { project } = await tempRoot()
  await enable(project)
  const hostTemplates = [
    { id: "trinity", title: "Trinity.txt", text: "host trinity base" },
    { id: "general", title: "General.txt", text: "host general base" },
  ]
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "")],
    templates: hostTemplates,
    models: [],
  })
  const handlers = createHandlers(ctx, createState())
  await Effect.runPromise(
    handlers["base.create"]({ id: "custom", title: "Custom.txt", text: "custom base text" }, throwingContext({})),
  )
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const user = snapshot.items.find((item) => item.id === "base:custom")
  expect(user?.text).toBe("custom base text")
  // The host classifier only ever answers with its own template ids
  // (harness harness.ts classify mirrors core: gpt/kimi/trinity/muse/general),
  // so a user id can never be the active answer and stored edits for it wait
  // until the agent switches model — which never selects it either.
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: snapshot.revision,
        expectedGlobalRevision: snapshot.globalRevision,
        records: [{
          type: "customization",
          level: "project",
          agent: "alpha",
          item: "base:custom",
          section: null,
          text: "customized user base",
          basedOn: user?.fingerprint ?? fingerprint("custom base text"),
          updated: "2026-01-01T00:00:00.000Z",
        }],
      },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  const assembled = await Effect.runPromise(handlers["instructions.assembled"]({ agent: "alpha" }, throwingContext({})))
  expect(assembled.system).not.toContain("customized user base")
})
