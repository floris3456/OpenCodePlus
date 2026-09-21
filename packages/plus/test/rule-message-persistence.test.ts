import { afterEach, describe, expect, test } from "bun:test"
import { Deferred, Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { enable } from "../src/project.js"
import { createHandlers, createPlusApi, createState, type PlusApi } from "../src/index.js"
import { registerInstructionTools } from "../src/tools.js"
import {
  canonical,
  load,
  save,
  stable,
  type CustomizationRecord,
  type Level,
  type RuleRecord,
  type StoredRecord,
} from "../src/instructions/store.js"
import { projectRecordsPath } from "../src/instructions/paths.js"
import { memoInputOf, ruleOf } from "../src/instructions/snapshot.js"
import { toRpcRecords } from "../src/tui/instructions/state.js"
import { expandedTree } from "../src/instructions/tree.js"
import { apply } from "../src/instructions/apply.js"
import { fingerprint } from "../src/instructions/model.js"
import type { Plus } from "../src/rpc.js"
import { agentHarness, agentInfo, context, fullContext } from "./harness.js"

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR
const priorDataHome = process.env.XDG_DATA_HOME
const UPDATED = "2026-09-22T00:00:00.000Z"

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = priorDataHome
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempProject(): Promise<{ project: string; root: string }> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-rule-persist-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  process.env.XDG_DATA_HOME = path.join(root, "data")
  const project = path.join(root, "project")
  await enable(project)
  return { project, root }
}

function toolContext(agent = "alpha"): Tool.Context {
  return {
    sessionID: Session.ID.make("ses_rule_persist"),
    agent: Agent.ID.make(agent),
    messageID: SessionMessage.ID.make("msg_rule_persist"),
    id: Tool.CallID.make("call_rule_persist"),
    progress: () => Effect.void,
  }
}

async function readTools(ctx: ReturnType<typeof fullContext>): Promise<Map<string, Tool.Info & { readonly id: string }>> {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const deferred = yield* Deferred.make<readonly (Tool.Info & { readonly id: string })[], never>()
        yield* ctx.tool.transform((editor) => {
          Deferred.doneUnsafe(deferred, Effect.succeed([...editor.list()]))
        })
        const list = yield* Deferred.await(deferred)
        return new Map(list.map((tool) => [tool.id, tool]))
      }),
    ),
  )
}

function need<T>(map: Map<string, T>, key: string): T {
  const value = map.get(key)
  if (value === undefined) throw new Error(`missing tool ${key}`)
  return value
}

async function runOk(tool: Tool.Info & { readonly id: string }, input: unknown): Promise<unknown> {
  const outcome = await Effect.runPromise(
    tool.execute(input, toolContext()).pipe(
      Effect.map((result) => ({ ok: true as const, result })),
      Effect.catchTag("Tool.Error", (error) => Effect.succeed({ ok: false as const, error })),
    ),
  )
  if (!outcome.ok) throw new Error(`expected tool to succeed: ${outcome.error.message}`)
  return (outcome.result as { output: unknown }).output
}

async function snapshotOf(api: PlusApi): Promise<Plus.Snapshot> {
  const result = await api.snapshot()
  if (!result.ok) throw new Error(`snapshot failed: ${result.error.message}`)
  return result.value
}

interface CapturedError {
  type: string
  message: string
  data?: unknown
}

function throwingContext(captured: { current?: CapturedError } = {}): {
  error: (type: string, message: string, data?: unknown) => never
} {
  return {
    error: (type, message, data) => {
      const failure: CapturedError = data === undefined ? { type, message } : { type, message, data }
      captured.current = failure
      throw failure
    },
  }
}

function sampleRule(overrides?: Partial<RuleRecord>): RuleRecord {
  return {
    type: "rule",
    level: "project",
    agent: "alpha",
    tool: "shell",
    id: "no-force",
    label: "No Force Push",
    patterns: ["git push --force *"],
    keywords: ["git push"],
    updated: UPDATED,
    ...overrides,
  }
}

describe("rule message persistence across boundaries", () => {
  describe("store.ts persistence, serialization, and stability", () => {
    test("rule with message round-trips through save and load", async () => {
      const { project } = await tempProject()
      const ruleWithMsg = sampleRule({ message: "force pushes are strictly prohibited" })
      const ruleWithoutMsg = sampleRule({ id: "no-drop", label: "No Drop DB", patterns: ["drop database *"] })

      const saved = await save(project, {
        expectedProjectRevision: 0,
        expectedGlobalRevision: 0,
        records: [ruleWithMsg, ruleWithoutMsg],
      })
      if (!saved.ok) throw new Error("save failed")
      expect(saved.projectRevision).toBe(1)

      const loaded = await load(project)
      const foundWithMsg = loaded.records.find((r): r is RuleRecord => r.type === "rule" && r.id === "no-force")
      const foundWithoutMsg = loaded.records.find((r): r is RuleRecord => r.type === "rule" && r.id === "no-drop")

      expect(foundWithMsg).toBeDefined()
      expect(foundWithMsg?.message).toBe("force pushes are strictly prohibited")

      expect(foundWithoutMsg).toBeDefined()
      expect(foundWithoutMsg?.message).toBeUndefined()
    })

    test("stable() preserves optional message and disk JSON includes message key only when set", async () => {
      const { project } = await tempProject()
      const ruleWithMsg = sampleRule({ message: "denied: cannot force push" })
      const ruleWithoutMsg = sampleRule({ id: "no-pull", label: "No Pull", patterns: ["git pull *"] })

      expect(stable(ruleWithMsg)).toEqual(ruleWithMsg)
      expect(stable(ruleWithoutMsg)).toEqual(ruleWithoutMsg)

      await save(project, {
        expectedProjectRevision: 0,
        expectedGlobalRevision: 0,
        records: [ruleWithMsg, ruleWithoutMsg],
      })

      const projectFile = projectRecordsPath(project)
      const content = await fs.readFile(projectFile, "utf8")
      const lines = content.split("\n").filter((l) => l.trim().length > 0).slice(1) // skip header

      const parsedRecords = lines.map((l) => JSON.parse(l))
      const jsonWithMsg = parsedRecords.find((r: Record<string, unknown>) => r.id === "no-force")
      const jsonWithoutMsg = parsedRecords.find((r: Record<string, unknown>) => r.id === "no-pull")

      expect(jsonWithMsg.message).toBe("denied: cannot force push")
      expect(jsonWithoutMsg).not.toHaveProperty("message")
    })

    test("unchanged save containing rule message is a no-op; changing message triggers save", async () => {
      const { project } = await tempProject()
      const initial = sampleRule({ message: "initial refusal message" })

      const first = await save(project, {
        expectedProjectRevision: 0,
        expectedGlobalRevision: 0,
        records: [initial],
      })
      if (!first.ok) throw new Error("first save failed")
      expect(first.projectRevision).toBe(1)
      expect(first.changed).toEqual({ project: true, global: false })

      // Exact same records -> no-op
      const unchanged = await save(project, {
        expectedProjectRevision: 1,
        expectedGlobalRevision: 0,
        records: [initial],
      })
      if (!unchanged.ok) throw new Error("unchanged save failed")
      expect(unchanged.projectRevision).toBe(1)
      expect(unchanged.changed).toEqual({ project: false, global: false })

      // Changed message -> bumps revision
      const updated = sampleRule({ message: "changed refusal message", updated: "2026-09-22T01:00:00.000Z" })
      const changed = await save(project, {
        expectedProjectRevision: 1,
        expectedGlobalRevision: 0,
        records: [updated],
      })
      if (!changed.ok) throw new Error("changed save failed")
      expect(changed.projectRevision).toBe(2)
      expect(changed.changed).toEqual({ project: true, global: false })

      const loaded = await load(project)
      const stored = loaded.records.find((r): r is RuleRecord => r.type === "rule" && r.id === "no-force")
      expect(stored?.message).toBe("changed refusal message")
    })
  })

  describe("snapshot.ts ruleOf and state.ts toRpcRecords", () => {
    test("ruleOf carries message from SnapshotRuleRecord and omits when absent", () => {
      const snapWithMsg: Plus.SnapshotRuleRecord = {
        type: "rule",
        level: "project",
        agent: "alpha",
        tool: "shell",
        id: "git-push",
        label: "Git push",
        patterns: ["git push *"],
        keywords: ["git push"],
        message: "pushing is forbidden",
        updated: UPDATED,
      }
      const modelWithMsg = ruleOf(snapWithMsg)
      expect(modelWithMsg.message).toBe("pushing is forbidden")

      const snapWithoutMsg: Plus.SnapshotRuleRecord = {
        type: "rule",
        level: "project",
        agent: "alpha",
        tool: "shell",
        id: "git-push",
        label: "Git push",
        patterns: ["git push *"],
        keywords: ["git push"],
        updated: UPDATED,
      }
      const modelWithoutMsg = ruleOf(snapWithoutMsg)
      expect(modelWithoutMsg.message).toBeUndefined()
    })

    test("memoInputOf preserves rule message in converted records", () => {
      const snapshot: Plus.Snapshot = {
        revision: 1,
        globalRevision: 1,
        agents: [{ id: "alpha", scope: "project", fileBacked: true }],
        items: [],
        records: [
          {
            type: "rule",
            level: "project",
            agent: "alpha",
            tool: "shell",
            id: "no-force",
            label: "No Force",
            patterns: ["git push --force *"],
            keywords: ["git push"],
            message: "force pushing is denied",
            updated: UPDATED,
          },
        ],
        servers: [],
        protectedAgents: [],
      }
      const memo = memoInputOf(snapshot)
      const rule = memo.records.find((r): r is RuleRecord => r.type === "rule")
      expect(rule?.message).toBe("force pushing is denied")
    })

    test("toRpcRecords carries rule message and preserves undefined", () => {
      const rules: RuleRecord[] = [
        sampleRule({ id: "with-msg", message: "refusal text" }),
        sampleRule({ id: "without-msg" }),
      ]
      const rpcRecords = toRpcRecords([], [], undefined, rules)
      const ruleWithMsg = rpcRecords.find((r) => r.type === "rule" && r.id === "with-msg") as Plus.SnapshotRuleRecord
      const ruleWithoutMsg = rpcRecords.find((r) => r.type === "rule" && r.id === "without-msg") as Plus.SnapshotRuleRecord

      expect(ruleWithMsg?.message).toBe("refusal text")
      expect(ruleWithoutMsg?.message).toBeUndefined()
    })
  })

  describe("RPC handlers: rule.add, rule.update, and instructions.mutate", () => {
    test("rule.add saves message to disk and exposes it in instructions.snapshot", async () => {
      const { project } = await tempProject()
      const handlers = createHandlers(fullContext({ directory: project }), createState())

      const addResult = await Effect.runPromise(
        handlers["rule.add"](
          {
            level: "project",
            agent: null,
            tool: "shell",
            id: "no-push",
            label: "No pushes",
            patterns: ["git push --force *"],
            message: "  force pushes are not allowed here  ",
          },
          throwingContext(),
        ),
      )
      expect(addResult.id).toBe("no-push")

      // Snapshot returned by RPC carries the rule record with trimmed message
      const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
      const snapRecord = snapshot.records.find((r): r is Plus.SnapshotRuleRecord => r.type === "rule" && r.id === "no-push")
      expect(snapRecord).toBeDefined()
      expect(snapRecord?.message).toBe("force pushes are not allowed here")

      // On-disk store has persisted the message
      const stored = await load(project)
      const storedRule = stored.records.find((r): r is RuleRecord => r.type === "rule" && r.id === "no-push")
      expect(storedRule?.message).toBe("force pushes are not allowed here")
    })

    test("rule.update: new message updates, blank clears, omission preserves", async () => {
      const { project } = await tempProject()
      const handlers = createHandlers(fullContext({ directory: project }), createState())

      // 1. Initial add
      await Effect.runPromise(
        handlers["rule.add"](
          {
            level: "project",
            agent: null,
            tool: "shell",
            id: "no-push",
            label: "No pushes",
            patterns: ["git push --force *"],
            message: "initial refusal",
          },
          throwingContext(),
        ),
      )

      // 2. Update with new message
      await Effect.runPromise(
        handlers["rule.update"](
          {
            level: "project",
            agent: null,
            tool: "shell",
            id: "no-push",
            label: "No pushes",
            patterns: ["git push --force *"],
            message: "updated refusal message",
          },
          throwingContext(),
        ),
      )
      const snapAfterUpdate = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
      const recordAfterUpdate = snapAfterUpdate.records.find((r): r is Plus.SnapshotRuleRecord => r.type === "rule" && r.id === "no-push")
      expect(recordAfterUpdate?.message).toBe("updated refusal message")

      const storedAfterUpdate = await load(project)
      expect(storedAfterUpdate.records.find((r): r is RuleRecord => r.type === "rule" && r.id === "no-push")?.message).toBe(
        "updated refusal message",
      )

      // 3. Update with omitted message preserves stored text
      await Effect.runPromise(
        handlers["rule.update"](
          {
            level: "project",
            agent: null,
            tool: "shell",
            id: "no-push",
            label: "Updated Label Only",
            patterns: ["git push --force *"],
          },
          throwingContext(),
        ),
      )
      const snapAfterOmission = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
      const recordAfterOmission = snapAfterOmission.records.find((r): r is Plus.SnapshotRuleRecord => r.type === "rule" && r.id === "no-push")
      expect(recordAfterOmission?.label).toBe("Updated Label Only")
      expect(recordAfterOmission?.message).toBe("updated refusal message") // PRESERVED

      const storedAfterOmission = await load(project)
      expect(storedAfterOmission.records.find((r): r is RuleRecord => r.type === "rule" && r.id === "no-push")?.message).toBe(
        "updated refusal message",
      )

      // 4. Update with blank message clears stored text
      await Effect.runPromise(
        handlers["rule.update"](
          {
            level: "project",
            agent: null,
            tool: "shell",
            id: "no-push",
            label: "No pushes",
            patterns: ["git push --force *"],
            message: "   ",
          },
          throwingContext(),
        ),
      )
      const snapAfterClear = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
      const recordAfterClear = snapAfterClear.records.find((r): r is Plus.SnapshotRuleRecord => r.type === "rule" && r.id === "no-push")
      expect(recordAfterClear?.message).toBeUndefined() // CLEARED

      const storedAfterClear = await load(project)
      expect(storedAfterClear.records.find((r): r is RuleRecord => r.type === "rule" && r.id === "no-push")?.message).toBeUndefined()
    })

    test("instructions.mutate preserves rule messages across mutation cycle", async () => {
      const { project } = await tempProject()
      const handlers = createHandlers(fullContext({ directory: project }), createState())

      await Effect.runPromise(
        handlers["rule.add"](
          {
            level: "project",
            agent: null,
            tool: "shell",
            id: "no-push",
            label: "No pushes",
            patterns: ["git push --force *"],
            message: "preserved across mutate",
          },
          throwingContext(),
        ),
      )

      const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
      expect(snapshot.records.find((r) => r.type === "rule")?.message).toBe("preserved across mutate")

      // TUI resubmits records converted via toRpcRecords
      const memo = memoInputOf(snapshot)
      const customizations = memo.records.filter((r): r is CustomizationRecord => r.type === "customization")
      const rules = memo.records.filter((r): r is RuleRecord => r.type === "rule")
      const rpcRecords = toRpcRecords(customizations, [], undefined, rules)

      const mutateResult = await Effect.runPromise(
        handlers["instructions.mutate"](
          {
            expectedRevision: snapshot.revision,
            expectedGlobalRevision: snapshot.globalRevision,
            records: rpcRecords,
          },
          throwingContext(),
        ),
      )
      expect(mutateResult.ok).toBe(true)
      if (mutateResult.ok) {
        const mutatedRule = mutateResult.snapshot.records.find((r): r is Plus.SnapshotRuleRecord => r.type === "rule" && r.id === "no-push")
        expect(mutatedRule?.message).toBe("preserved across mutate")
      }

      // Re-read disk to confirm persistence
      const reloaded = await load(project)
      expect(reloaded.records.find((r): r is RuleRecord => r.type === "rule" && r.id === "no-push")?.message).toBe("preserved across mutate")
    })
  })

  describe("tool surface: instructions_create, instructions_show, instructions_set", () => {
    test("create kind: 'rule' with message, show display, and disk persistence", async () => {
      const { project } = await tempProject()
      const ctx = fullContext({
        directory: project,
        agents: [agentInfo("alpha", "upstream role")],
        tools: [{ id: "shell", description: "Run shell. Use git push to publish.", options: { codemode: false } }],
        session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
      })
      const api = createPlusApi(ctx, createState())
      await registerInstructionTools(ctx, api)
      const tools = await readTools(ctx)

      // Create rule with message
      const created = (await runOk(need(tools, "instructions_create"), {
        kind: "rule",
        tool: "shell",
        id: "no-force-push",
        label: "No Force Push",
        patterns: ["git push --force *"],
        message: "force pushing destroys history",
      })) as { tool: string; id: string }
      expect(created).toMatchObject({ tool: "shell", id: "no-force-push" })

      // Locate row in tree
      const snapshot = await snapshotOf(api)
      const customRow = expandedTree(memoInputOf(snapshot)).find((node) => node.address?.item === "perm:shell:no-force-push")
      if (customRow === undefined) throw new Error("missing custom perm row")

      // instructions_show (default view) returns message
      const shownDefault = (await runOk(need(tools, "instructions_show"), { id: customRow.id })) as {
        tool: string
        rule: string
        message?: string
      }
      expect(shownDefault.tool).toBe("shell")
      expect(shownDefault.rule).toBe("no-force-push")
      expect(shownDefault.message).toBe("force pushing destroys history")

      // instructions_show view: "record" returns RuleRecord with message
      const shownRecord = (await runOk(need(tools, "instructions_show"), { id: customRow.id, view: "record" })) as {
        record: { type?: string; message?: string } | null
      }
      expect(shownRecord.record?.type).toBe("rule")
      expect(shownRecord.record?.message).toBe("force pushing destroys history")

      // Persisted to disk
      const stored = await load(project)
      const storedRule = stored.records.find((r): r is RuleRecord => r.type === "rule" && r.id === "no-force-push")
      expect(storedRule?.message).toBe("force pushing destroys history")
    })

    test("set on custom perm row: update message, blank clears, omission preserves", async () => {
      const { project } = await tempProject()
      const ctx = fullContext({
        directory: project,
        agents: [agentInfo("alpha", "upstream role")],
        tools: [{ id: "shell", description: "Run shell. Use git push to publish.", options: { codemode: false } }],
        session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
      })
      const api = createPlusApi(ctx, createState())
      await registerInstructionTools(ctx, api)
      const tools = await readTools(ctx)

      await runOk(need(tools, "instructions_create"), {
        kind: "rule",
        tool: "shell",
        id: "no-force-push",
        label: "No Force Push",
        patterns: ["git push --force *"],
        message: "initial refusal message",
      })

      const snapshot = await snapshotOf(api)
      const customRow = expandedTree(memoInputOf(snapshot)).find((node) => node.address?.item === "perm:shell:no-force-push")
      if (customRow === undefined) throw new Error("missing custom perm row")

      // 1. Update message via instructions_set
      const updated = (await runOk(need(tools, "instructions_set"), {
        id: customRow.id,
        message: "updated refusal text",
      })) as { status: string }
      expect(updated.status).toContain("Updated")

      const shownAfterUpdate = (await runOk(need(tools, "instructions_show"), { id: customRow.id })) as { message?: string }
      expect(shownAfterUpdate.message).toBe("updated refusal text")

      // 2. Update label only (omitted message) -> message preserved
      await runOk(need(tools, "instructions_set"), {
        id: customRow.id,
        label: "Updated Label",
      })
      const shownAfterOmission = (await runOk(need(tools, "instructions_show"), { id: customRow.id })) as {
        label?: string
        message?: string
      }
      expect(shownAfterOmission.label).toBe("Updated Label")
      expect(shownAfterOmission.message).toBe("updated refusal text")

      const storedAfterOmission = await load(project)
      expect(storedAfterOmission.records.find((r): r is RuleRecord => r.type === "rule" && r.id === "no-force-push")?.message).toBe(
        "updated refusal text",
      )

      // 3. Set blank message -> clears message
      await runOk(need(tools, "instructions_set"), {
        id: customRow.id,
        message: "",
      })
      const shownAfterClear = (await runOk(need(tools, "instructions_show"), { id: customRow.id })) as { message?: string }
      expect(shownAfterClear.message).toBeUndefined()

      const shownRecordAfterClear = (await runOk(need(tools, "instructions_show"), { id: customRow.id, view: "record" })) as {
        record: { type?: string; message?: string } | null
      }
      expect(shownRecordAfterClear.record?.message).toBeUndefined()

      const storedAfterClear = await load(project)
      expect(storedAfterClear.records.find((r): r is RuleRecord => r.type === "rule" && r.id === "no-force-push")?.message).toBeUndefined()
    })

    test("curated rule: show returns shipped message, set creates custom override, blank restores curated", async () => {
      const { project } = await tempProject()
      const ctx = fullContext({
        directory: project,
        agents: [agentInfo("alpha", "upstream role")],
        tools: [{ id: "shell", description: "Run shell. Use git push to publish.", options: { codemode: false } }],
        session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
      })
      const api = createPlusApi(ctx, createState())
      await registerInstructionTools(ctx, api)
      const tools = await readTools(ctx)

      const snapshot = await snapshotOf(api)
      const curatedRow = expandedTree(memoInputOf(snapshot)).find((node) => node.address?.item === "perm:shell:git-push")
      if (curatedRow === undefined) throw new Error("missing curated perm row perm:shell:git-push")

      // Shipped message is displayed
      const initialShown = (await runOk(need(tools, "instructions_show"), { id: curatedRow.id })) as { message?: string }
      expect(initialShown.message).toBe("pushing is not allowed here")

      // Set custom message on the curated row (materializes a custom override)
      const overrideResult = (await runOk(need(tools, "instructions_set"), {
        id: curatedRow.id,
        message: "company policy: never git push directly",
      })) as { status: string }
      expect(overrideResult.status).toContain("Updated")

      const shownCustom = (await runOk(need(tools, "instructions_show"), { id: curatedRow.id })) as { message?: string }
      expect(shownCustom.message).toBe("company policy: never git push directly")

      // Blank message on the override clears the custom text (user rule with no message keeps generic refusal)
      await runOk(need(tools, "instructions_set"), {
        id: curatedRow.id,
        message: "",
      })
      const shownCleared = (await runOk(need(tools, "instructions_show"), { id: curatedRow.id })) as { message?: string }
      expect(shownCleared.message).toBeUndefined()

      // Deleting the custom override restores the curated rule and its shipped message
      await runOk(need(tools, "instructions_delete"), {
        id: curatedRow.id,
        confirm: true,
      })
      const shownRestored = (await runOk(need(tools, "instructions_show"), { id: curatedRow.id })) as { message?: string }
      expect(shownRestored.message).toBe("pushing is not allowed here")
    })
  })

  describe("core Permission.evaluate integration", () => {
    test("Permission.evaluate receives custom user rule message", async () => {
      const { evaluate } = await import("../../core/src/permission.js")
      const agents = agentHarness([agentInfo("alpha", "upstream")])
      const ctx = context({
        agent: agents.domain,
        session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
      })

      const permText = "No force pushes\ngit push --force *"
      const items = [
        { id: "tool:shell", kind: "tool" as const, group: "native" as const, title: "shell", text: "shell tool", enabled: true, fingerprint: fingerprint("shell tool") },
        {
          id: "perm:shell:no-push",
          kind: "perm" as const,
          group: "none" as const,
          title: "No force pushes",
          text: permText,
          enabled: true,
          fingerprint: fingerprint(permText),
          permTool: "shell",
          ruleId: "no-push",
          patterns: ["git push --force *"],
          keywords: ["git push"],
          provenance: [] as string[],
          custom: true,
        },
      ]
      const records = [
        {
          type: "customization" as const,
          item: "perm:shell:no-push",
          agent: "alpha",
          level: "project" as Level,
          section: null,
          state: "off" as const,
          basedOn: fingerprint(permText),
          updated: UPDATED,
        },
      ]
      const rules: RuleRecord[] = [
        {
          type: "rule",
          level: "project",
          agent: "alpha",
          tool: "shell",
          id: "no-push",
          label: "No force pushes",
          patterns: ["git push --force *"],
          keywords: ["git push"],
          message: "force pushes are strictly prohibited by repo rule",
          updated: UPDATED,
        },
      ]

      await apply(ctx, {
        agents: [{ id: "alpha", level: "project" }],
        items,
        records,
        splits: [],
        rules,
        scopes: { global: new Set<string>(), defaults: new Set<string>() },
      })

      const alphaRules = agents.state.get("alpha")?.permissions ?? []

      const denial = evaluate("shell", "git push --force origin main", alphaRules)
      expect(denial.effect).toBe("deny")
      expect(denial.message).toBe("force pushes are strictly prohibited by repo rule")
    })
  })
})
