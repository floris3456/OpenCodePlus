import { afterEach, expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect, Exit } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHandlers, createState } from "../src/index.js"
import { fingerprint } from "../src/instructions/model.js"
import { enable } from "../src/project.js"
import { agentInfo, fullContext, modelInfo, modelRef } from "./harness.js"

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
  // Project scope for alpha: a project-level base record only resolves for a
  // project-scoped agent (a file-less defaults agent never consults the
  // project level, so no base plan would exist and no hook would register).
  const agentPath = path.join(project, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(agentPath), { recursive: true })
  await Bun.write(agentPath, "upstream role\n")
  const hostTemplates = [
    { id: "trinity", title: "Trinity.txt", text: "host trinity base" },
    { id: "general", title: "General.txt", text: "host general base" },
  ]
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  // The agent's configured model classifies to trinity through the explicit
  // table, so discover pins base "trinity" and a trinity customization below
  // genuinely registers a session context hook. The user template can then be
  // proven excluded under conditions where application demonstrably happens.
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "", modelRef("test", "test-model"))],
    templates: hostTemplates,
    models: [modelInfo("test", "test-model")],
    classifications: { "": "general", "test-model": "trinity" },
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const handlers = createHandlers(ctx, createState())
  await Effect.runPromise(
    handlers["base.create"]({ id: "custom", title: "Custom.txt", text: "custom base text" }, throwingContext({})),
  )
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const user = snapshot.items.find((item) => item.id === "base:custom")
  expect(user?.text).toBe("custom base text")
  const trinity = snapshot.items.find((item) => item.id === "base:trinity")
  expect(trinity?.text).toBe("host trinity base")
  // The host classifier only ever answers from its explicit classification table,
  // so a user template id is never the active answer and session context hooks
  // leave system[0] alone for it — while the pinned trinity template applies.
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: snapshot.revision,
        expectedGlobalRevision: snapshot.globalRevision,
        records: [{
          type: "customization",
          level: "project",
          agent: "alpha",
          item: "base:trinity",
          section: null,
          text: "customized trinity base",
          basedOn: trinity?.fingerprint ?? fingerprint("host trinity base"),
          updated: "2026-01-01T00:00:00.000Z",
        }, {
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
  // Base templates apply through the session context hook. Verify against the real
  // hook callback on a session event: the active trinity customization applies
  // while the user template never reaches system[0].
  expect(callbacks).toHaveLength(1)
  const hook = callbacks[0]
  if (!hook) throw new Error("missing context hook")
  const event = {
    sessionID: Session.ID.make("ses_test"),
    agent: Agent.ID.make("alpha"),
    model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test-model") }),
    system: [{ type: "text" as const, text: "host trinity base" }],
    messages: [],
    options: {},
    tools: {},
  }
  await Effect.runPromise(hook(event))
  expect(event.system[0]?.text).toBe("customized trinity base")
  expect(event.system[0]?.text).not.toContain("customized user base")
})

test("a request model switch through publication applies the request model's customization", async () => {
  // DEFECT 1 through the real publication path: the agent is configured to a
  // gpt model (discover pins base "gpt"), both families are customized, but
  // the request arrives on a kimi model. The hook must serve the kimi text.
  const { project } = await tempRoot()
  await enable(project)
  const agentPath = path.join(project, ".opencode", "agent", "alpha.md")
  await fs.mkdir(path.dirname(agentPath), { recursive: true })
  await Bun.write(agentPath, "upstream role\n")
  const hostTemplates = [
    { id: "gpt", title: "GPT.txt", text: "host gpt base" },
    { id: "kimi", title: "Kimi.txt", text: "host kimi base" },
  ]
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const ctx = fullContext({
    directory: project,
    agents: [agentInfo("alpha", "", modelRef("openai", "gpt-4o"))],
    templates: hostTemplates,
    models: [modelInfo("openai", "gpt-4o"), modelInfo("moonshot", "kimi-k2")],
    classifications: { "": "general", "gpt-4o": "gpt", "kimi-k2": "kimi" },
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const handlers = createHandlers(ctx, createState())
  const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
  const gpt = snapshot.items.find((item) => item.id === "base:gpt")
  expect(gpt?.text).toBe("host gpt base")
  const kimi = snapshot.items.find((item) => item.id === "base:kimi")
  expect(kimi?.text).toBe("host kimi base")
  const mutated = await Effect.runPromise(
    handlers["instructions.mutate"](
      {
        expectedRevision: snapshot.revision,
        expectedGlobalRevision: snapshot.globalRevision,
        records: [{
          type: "customization",
          level: "project",
          agent: "alpha",
          item: "base:gpt",
          section: null,
          text: "customized gpt base",
          basedOn: gpt?.fingerprint ?? fingerprint("host gpt base"),
          updated: "2026-01-01T00:00:00.000Z",
        }, {
          type: "customization",
          level: "project",
          agent: "alpha",
          item: "base:kimi",
          section: null,
          text: "customized kimi base",
          basedOn: kimi?.fingerprint ?? fingerprint("host kimi base"),
          updated: "2026-01-01T00:00:00.000Z",
        }],
      },
      throwingContext({}),
    ),
  )
  expect(mutated.ok).toBe(true)
  expect(callbacks).toHaveLength(1)
  const hook = callbacks[0]
  if (!hook) throw new Error("missing context hook")
  const event = {
    sessionID: Session.ID.make("ses_test"),
    agent: Agent.ID.make("alpha"),
    model: Model.Ref.make({ providerID: Provider.ID.make("moonshot"), id: Model.ID.make("kimi-k2") }),
    system: [{ type: "text" as const, text: "host kimi base" }],
    messages: [],
    options: {},
    tools: {},
  }
  await Effect.runPromise(hook(event))
  expect(event.system[0]?.text).toBe("customized kimi base")
})
