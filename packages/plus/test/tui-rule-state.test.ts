import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createHandlers, createState } from "../src/index.js"
import { globalRecordsPath } from "../src/instructions/paths.js"
import { addSection, toggle } from "../src/instructions/ops.js"
import { memoInputOf } from "../src/instructions/snapshot.js"
import { load, type CustomizationRecord, type RuleRecord, type SplitRecord } from "../src/instructions/store.js"
import { expandedTree, type MemoInput, type TreeNode } from "../src/instructions/tree.js"
import type { ModelRecord } from "../src/instructions/model.js"
import { toRpcRecords } from "../src/tui/instructions/state.js"
import { enable } from "../src/project.js"
import type { Plus } from "../src/rpc.js"
import { fullContext, modelInfo } from "./harness.js"

// A TUI write resubmits the whole record set. `createInstructionsState`'s
// `persist` (`src/tui/instructions/state.ts`) converts the snapshot through
// `memoInputOf`, runs an op (`toggle` on a rule row, `addSection` on an item
// row, `activateModelRow` on a model row, …), serializes every customization,
// split, model and rule with `toRpcRecords`, and sends the result through
// `instructions.mutate`. These tests drive the real handlers, the real
// serializer and the real `toggle` and `addSection` ops — the same expressions
// `persist` runs — and read the result back from the snapshot and from disk: a
// Teams-catalogue shared rule's `message`, `catalogue` and state survive the
// resubmission, an unrelated Agents-catalogue rule does too, absent optional
// keys stay absent, and `catalogue` rides along on every stored record kind.
//
// The companion `test/tool-rule-state.test.ts` covers the same optional fields
// through the tool serializer (`tools.ts` `toSnapshotRecords`).

const roots: string[] = []
const priorConfigDir = process.env.OPENCODE_CONFIG_DIR
const priorDataHome = process.env.XDG_DATA_HOME

afterEach(async () => {
  if (priorConfigDir === undefined) delete process.env.OPENCODE_CONFIG_DIR
  else process.env.OPENCODE_CONFIG_DIR = priorConfigDir
  if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME
  else process.env.XDG_DATA_HOME = priorDataHome
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function tempProject(): Promise<string> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const root = await fs.mkdtemp(path.join(parent, "plus-tui-rule-state-"))
  roots.push(root)
  process.env.OPENCODE_CONFIG_DIR = path.join(root, "config")
  process.env.XDG_DATA_HOME = path.join(root, "data")
  const project = path.join(root, "project")
  await enable(project)
  return project
}

type Handlers = ReturnType<typeof createHandlers>

// The handlers fail through `context.error`; this test wants a thrown Error
// with the code in it rather than a captured failure record.
function throwingContext(): { error: (type: string, message: string, data?: unknown) => never } {
  return {
    error: (type, message, data) => {
      throw new Error(`${type}: ${message}${data === undefined ? "" : ` (${JSON.stringify(data)})`}`)
    },
  }
}

async function openHandlers(project: string): Promise<Handlers> {
  return createHandlers(
    fullContext({
      directory: project,
      tools: [{ id: "shell", description: "Run shell commands. Use git push to publish.", options: { codemode: false } }],
      models: [modelInfo("acme", "teams-model")],
    }),
    createState(),
  )
}

async function snapshotOf(handlers: Handlers): Promise<Plus.Snapshot> {
  return Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext()))
}

function rulesOf(memo: MemoInput): RuleRecord[] {
  return memo.records.filter((record): record is RuleRecord => record.type === "rule")
}

function modelsOf(memo: MemoInput): ModelRecord[] {
  return memo.records.filter((record): record is ModelRecord => record.type === "model")
}

// The shared Defaults row of one catalogue, never a team member's own row:
// `agent === null` and no `team` is what `catalogueField` keys on.
function isSharedDefaultsRow(node: TreeNode, item: string, catalogue: "teams" | undefined): boolean {
  return (
    node.address?.level === "defaults" &&
    node.address.agent === null &&
    node.address.team === undefined &&
    node.address.item === item &&
    node.address.catalogue === catalogue
  )
}

// One JSON object per stored record, after the header line.
async function storedLines(file: string): Promise<Record<string, unknown>[]> {
  const text = await fs.readFile(file, "utf8")
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .slice(1)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
}

describe("TUI whole-set resubmissions retain rule messages and catalogue identity", () => {
  test("a Teams shared rule's message, catalogue and state survive beside an unrelated Agents rule", async () => {
    const project = await tempProject()
    const handlers = await openHandlers(project)

    // A: the rule the TUI toggles off, shared Defaults in the Teams catalogue.
    await Effect.runPromise(
      handlers["rule.add"](
        {
          level: "defaults",
          agent: null,
          catalogue: "teams",
          tool: "shell",
          id: "no-push",
          label: "No push",
          patterns: ["git push *"],
          message: "pushing is not allowed in this team",
        },
        throwingContext(),
      ),
    )
    // B: unrelated shared Defaults rule in the Agents catalogue, never edited.
    await Effect.runPromise(
      handlers["rule.add"](
        {
          level: "defaults",
          agent: null,
          tool: "shell",
          id: "no-pull",
          label: "No pull",
          patterns: ["git pull *"],
          message: "pulls are not allowed here",
        },
        throwingContext(),
      ),
    )
    // C: a shared Defaults rule with no message, so absence has to stay absence.
    await Effect.runPromise(
      handlers["rule.add"](
        { level: "defaults", agent: null, tool: "shell", id: "no-fetch", label: "No fetch", patterns: ["git fetch *"] },
        throwingContext(),
      ),
    )
    // D: a shared Defaults model record in the Teams catalogue, preserved like
    // every model on a TUI write.
    await Effect.runPromise(
      handlers["model.add"](
        { level: "defaults", agent: null, catalogue: "teams", providerID: "acme", modelID: "teams-model" },
        throwingContext(),
      ),
    )

    const snapshot = await snapshotOf(handlers)
    const memo = memoInputOf(snapshot)
    const nodes = expandedTree(memo)
    const teamsRuleRow = nodes.find((node) => isSharedDefaultsRow(node, "perm:shell:no-push", "teams"))
    if (teamsRuleRow === undefined) throw new Error("missing Teams-catalogue rule row")
    expect(teamsRuleRow.id).toBe("item:defaults:/teams:perm:shell:no-push")
    const agentsRuleRow = nodes.find((node) => isSharedDefaultsRow(node, "perm:shell:no-pull", undefined))
    if (agentsRuleRow === undefined) throw new Error("missing Agents-catalogue rule row")
    expect(agentsRuleRow.id).toBe("item:defaults::perm:shell:no-pull")

    // Space on the Teams rule row: the real op behind the state's toggleRow.
    // Defaults "for every agent" falls back to off when nothing sets it
    // (DESIGN §3.3), so space stores it "on".
    const toggled = toggle(memo, teamsRuleRow.id)
    if ("refusal" in toggled) throw new Error(toggled.refusal)

    // What `persist` sends: the op's records and splits, and every model and
    // rule preserved from the snapshot, all through toRpcRecords.
    const resubmitted = toRpcRecords(toggled.records, toggled.splits, modelsOf(memo), rulesOf(memo))

    const payloadTeamsRule = resubmitted.find(
      (record): record is Plus.SnapshotRuleRecord => record.type === "rule" && record.id === "no-push",
    )
    expect(payloadTeamsRule?.catalogue).toBe("teams")
    expect(payloadTeamsRule?.message).toBe("pushing is not allowed in this team")
    const payloadState = resubmitted.find(
      (record): record is Plus.SnapshotCustomizationRecord => record.type === "customization" && record.item === "perm:shell:no-push",
    )
    expect(payloadState?.catalogue).toBe("teams")
    expect(payloadState?.state).toBe("on")
    const payloadModel = resubmitted.find((record): record is Plus.SnapshotModelRecord => record.type === "model")
    expect(payloadModel?.catalogue).toBe("teams")
    const payloadAgentsRule = resubmitted.find(
      (record): record is Plus.SnapshotRuleRecord => record.type === "rule" && record.id === "no-pull",
    )
    expect(payloadAgentsRule?.catalogue).toBeUndefined()
    expect(Object.keys(payloadAgentsRule ?? {}).includes("catalogue")).toBe(false)
    expect(payloadAgentsRule?.message).toBe("pulls are not allowed here")
    const payloadNoMessageRule = resubmitted.find(
      (record): record is Plus.SnapshotRuleRecord => record.type === "rule" && record.id === "no-fetch",
    )
    expect(payloadNoMessageRule?.message).toBeUndefined()
    expect(Object.keys(payloadNoMessageRule ?? {}).includes("message")).toBe(false)

    const mutated = await Effect.runPromise(
      handlers["instructions.mutate"](
        { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records: resubmitted },
        throwingContext(),
      ),
    )
    expect(mutated.ok).toBe(true)
    if (!mutated.ok) return

    const afterRules = mutated.snapshot.records.filter((record): record is Plus.SnapshotRuleRecord => record.type === "rule")
    const storedTeamsRule = afterRules.find((record) => record.id === "no-push")
    expect(storedTeamsRule?.catalogue).toBe("teams")
    expect(storedTeamsRule?.message).toBe("pushing is not allowed in this team")
    const storedAgentsRule = afterRules.find((record) => record.id === "no-pull")
    expect(storedAgentsRule?.catalogue).toBeUndefined()
    expect(Object.keys(storedAgentsRule ?? {}).includes("catalogue")).toBe(false)
    expect(storedAgentsRule?.message).toBe("pulls are not allowed here")
    const storedNoMessageRule = afterRules.find((record) => record.id === "no-fetch")
    expect(storedNoMessageRule?.message).toBeUndefined()
    expect(Object.keys(storedNoMessageRule ?? {}).includes("message")).toBe(false)
    const storedState = mutated.snapshot.records.find(
      (record): record is Plus.SnapshotCustomizationRecord => record.type === "customization" && record.item === "perm:shell:no-push",
    )
    expect(storedState?.catalogue).toBe("teams")
    expect(storedState?.state).toBe("on")
    const storedModel = mutated.snapshot.records.find((record): record is Plus.SnapshotModelRecord => record.type === "model")
    expect(storedModel?.catalogue).toBe("teams")

    // Disk keeps the same identity, including the raw JSONL optional keys.
    const stored = await load(project)
    const diskTeamsRule = stored.records.find((record): record is RuleRecord => record.type === "rule" && record.id === "no-push")
    expect(diskTeamsRule?.catalogue).toBe("teams")
    expect(diskTeamsRule?.message).toBe("pushing is not allowed in this team")
    const diskState = stored.records.find(
      (record): record is CustomizationRecord => record.type === "customization" && record.item === "perm:shell:no-push",
    )
    expect(diskState?.catalogue).toBe("teams")
    expect(diskState?.state).toBe("on")
    const globalLines = await storedLines(globalRecordsPath())
    const teamsRuleLine = globalLines.find((line) => line.type === "rule" && line.id === "no-push")
    expect(teamsRuleLine?.catalogue).toBe("teams")
    expect(teamsRuleLine?.message).toBe("pushing is not allowed in this team")
    const stateLine = globalLines.find((line) => line.type === "customization" && line.item === "perm:shell:no-push")
    expect(stateLine?.catalogue).toBe("teams")
    expect(stateLine?.state).toBe("on")
    const modelLine = globalLines.find((line) => line.type === "model")
    expect(modelLine?.catalogue).toBe("teams")
  })

  test("a Teams-catalogue section write keeps its split in the Teams catalogue", async () => {
    const project = await tempProject()
    const handlers = await openHandlers(project)

    const snapshot = await snapshotOf(handlers)
    const memo = memoInputOf(snapshot)
    const teamsToolRow = expandedTree(memo).find((node) => isSharedDefaultsRow(node, "tool:shell", "teams"))
    if (teamsToolRow === undefined) throw new Error("missing Teams-catalogue shell row")
    expect(teamsToolRow.id).toBe("item:defaults:/teams:tool:shell")

    // `a` on the Teams-catalogue tool row: the real op behind addSectionRow.
    const added = addSection(memo, teamsToolRow.id, "Refusal", "Refuse force pushes instead.")
    if ("refusal" in added) throw new Error(added.refusal)
    const newSplit = added.splits.find((record) => record.item === "tool:shell")
    expect(newSplit?.catalogue).toBe("teams")

    const resubmitted = toRpcRecords(added.records, added.splits, modelsOf(memo), rulesOf(memo))
    const payloadSplit = resubmitted.find((record) => record.type === "split" && record.item === "tool:shell")
    expect(payloadSplit?.catalogue).toBe("teams")

    const mutated = await Effect.runPromise(
      handlers["instructions.mutate"](
        { expectedRevision: snapshot.revision, expectedGlobalRevision: snapshot.globalRevision, records: resubmitted },
        throwingContext(),
      ),
    )
    expect(mutated.ok).toBe(true)
    if (!mutated.ok) return

    const storedSplits = mutated.snapshot.records.filter((record): record is Plus.SnapshotSplitRecord => record.type === "split")
    expect(storedSplits).toHaveLength(1)
    expect(storedSplits[0]?.item).toBe("tool:shell")
    expect(storedSplits[0]?.catalogue).toBe("teams")

    // The split stays in the Teams catalogue on disk, not re-targeted to Agents.
    const stored = await load(project)
    const diskSplit = stored.records.find(
      (record): record is SplitRecord => record.type === "split" && record.item === "tool:shell",
    )
    expect(diskSplit?.catalogue).toBe("teams")
    const globalLines = await storedLines(globalRecordsPath())
    const splitLine = globalLines.find((line) => line.type === "split" && line.item === "tool:shell")
    expect(splitLine?.catalogue).toBe("teams")
  })
})