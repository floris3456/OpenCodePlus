import { expect, test } from "bun:test"
import { Schema } from "effect"
import type { Rpc } from "@opencode/schema/rpc"
import { Plus } from "../src/rpc.js"

// Compile-time guard: the TUI promise client only accepts PortableDefinition,
// so this assignment fails typecheck if any schema is left unwrapped.
const portable: Rpc.PortableDefinition = Plus.Definition

test("definition satisfies portable client contract and id", () => {
  expect(portable.id).toBe("opencode.plus")
  expect(Plus.Definition.id).toBe("opencode.plus")
})

test("every method and event is declared", () => {
  const expectedMethods = [
    "project.status",
    "project.enable",
    "project.disable",
    "instructions.snapshot",
    "instructions.refresh",
    "instructions.mutate",
    "instructions.log",
    "instructions.assembled",
    "agent.create",
    "agent.rename",
    "agent.delete",
    "skill.create",
    "skill.import",
    "skill.delete",
    "base.create",
    "base.delete",
    "instruction.create",
    "instruction.delete",
    "mcp.add",
    "mcp.remove",
    "team.create",
    "team.setEnabled",
    "model.add",
    "model.remove",
    "catalog.models",
    "rule.add",
    "rule.remove",
    "rule.update",
  ]

  for (const name of expectedMethods) {
    expect(name in Plus.Definition.methods, `missing method ${name}`).toBe(true)
  }
  expect(Object.keys(Plus.Definition.methods).sort()).toEqual(expectedMethods.sort())

  const expectedEvents = ["project.changed", "instructions.changed"]
  for (const name of expectedEvents) {
    expect(name in Plus.Definition.events, `missing event ${name}`).toBe(true)
  }
  expect(Object.keys(Plus.Definition.events).sort()).toEqual(expectedEvents.sort())
})

test("every method input, output, error, and event schema is portable", () => {
  for (const [name, method] of Object.entries(Plus.Definition.methods)) {
    expect("~standard" in method.input, `${name} input`).toBe(true)
    expect("~standard" in method.output, `${name} output`).toBe(true)
    if ("errors" in method && method.errors !== undefined) {
      for (const [error, schema] of Object.entries(method.errors)) {
        expect("~standard" in (schema as object), `${name} error ${error}`).toBe(true)
      }
    }
  }
  for (const [name, event] of Object.entries(Plus.Definition.events)) {
    expect("~standard" in event.schema, `${name} event`).toBe(true)
  }
})

test("every declared error is reachable through the definition", () => {
  const expectedDeclaredErrors = [
    "project.disabled",
    "agent.exists",
    "agent.missing",
    "agent.invalid",
    "agent.unknown",
    "skill.exists",
    "skill.missing",
    "skill.invalid",
    "base.exists",
    "base.missing",
    "base.invalid",
    "instruction.exists",
    "instruction.missing",
    "instruction.invalid",
    "mcp.exists",
    "mcp.missing",
    "mcp.invalid",
    "team.exists",
    "team.unknown",
    "team.invalid",
    "team.create",
    "model.exists",
    "model.missing",
    "model.invalid",
    "rule.exists",
    "rule.missing",
    "rule.invalid",
  ]

  const reachableErrors = new Set<string>()
  for (const method of Object.values(Plus.Definition.methods)) {
    if ("errors" in method && method.errors !== undefined) {
      for (const errorName of Object.keys(method.errors)) {
        reachableErrors.add(errorName)
      }
    }
  }

  for (const errorName of expectedDeclaredErrors) {
    expect(reachableErrors.has(errorName), `error ${errorName} is not reachable through definition`).toBe(true)
  }
})

test("error schemas are correctly bound to their corresponding methods", () => {
  const instructionsAndMutatingMethods = [
    "instructions.snapshot",
    "instructions.refresh",
    "instructions.mutate",
    "instructions.log",
    "instructions.assembled",
    "agent.create",
    "agent.rename",
    "agent.delete",
    "skill.create",
    "skill.import",
    "skill.delete",
    "base.create",
    "base.delete",
    "instruction.create",
    "instruction.delete",
    "mcp.add",
    "mcp.remove",
    "team.create",
    "team.setEnabled",
    "model.add",
    "model.remove",
    "catalog.models",
    "rule.add",
    "rule.remove",
    "rule.update",
  ] as const satisfies readonly (keyof typeof Plus.Definition.methods)[]

  for (const method of instructionsAndMutatingMethods) {
    const entry = Plus.Definition.methods[method]
    expect("errors" in entry ? entry.errors : undefined).toBeDefined()
    expect("project.disabled" in ("errors" in entry && entry.errors !== undefined ? entry.errors : {})).toBe(true)
  }

  expect("agent.unknown" in errorsOf("instructions.assembled")).toBe(true)

  expect("agent.exists" in errorsOf("agent.create")).toBe(true)
  expect("agent.invalid" in errorsOf("agent.create")).toBe(true)

  expect("agent.missing" in errorsOf("agent.rename")).toBe(true)
  expect("agent.exists" in errorsOf("agent.rename")).toBe(true)
  expect("agent.invalid" in errorsOf("agent.rename")).toBe(true)

  expect("agent.missing" in errorsOf("agent.delete")).toBe(true)
  expect("agent.invalid" in errorsOf("agent.delete")).toBe(true)

  expect("skill.exists" in errorsOf("skill.create")).toBe(true)
  expect("skill.invalid" in errorsOf("skill.create")).toBe(true)
  expect("skill.exists" in errorsOf("skill.import")).toBe(true)
  expect("skill.invalid" in errorsOf("skill.import")).toBe(true)

  expect("skill.missing" in errorsOf("skill.delete")).toBe(true)
  expect("skill.invalid" in errorsOf("skill.delete")).toBe(true)

  expect("base.exists" in errorsOf("base.create")).toBe(true)
  expect("base.invalid" in errorsOf("base.create")).toBe(true)

  expect("base.missing" in errorsOf("base.delete")).toBe(true)
  expect("base.invalid" in errorsOf("base.delete")).toBe(true)

  expect("instruction.exists" in errorsOf("instruction.create")).toBe(true)
  expect("instruction.invalid" in errorsOf("instruction.create")).toBe(true)

  expect("instruction.missing" in errorsOf("instruction.delete")).toBe(true)
  expect("instruction.invalid" in errorsOf("instruction.delete")).toBe(true)

  expect("mcp.exists" in errorsOf("mcp.add")).toBe(true)
  expect("mcp.invalid" in errorsOf("mcp.add")).toBe(true)

  expect("mcp.missing" in errorsOf("mcp.remove")).toBe(true)
  expect("mcp.invalid" in errorsOf("mcp.remove")).toBe(true)

  expect("team.exists" in errorsOf("team.create")).toBe(true)
  expect("team.invalid" in errorsOf("team.create")).toBe(true)
  expect("team.create" in errorsOf("team.create")).toBe(true)

  expect("team.unknown" in errorsOf("team.setEnabled")).toBe(true)
  expect("team.invalid" in errorsOf("team.setEnabled")).toBe(true)

  expect("model.exists" in errorsOf("model.add")).toBe(true)
  expect("model.invalid" in errorsOf("model.add")).toBe(true)

  expect("model.missing" in errorsOf("model.remove")).toBe(true)
  expect("model.invalid" in errorsOf("model.remove")).toBe(true)

  expect("rule.exists" in errorsOf("rule.add")).toBe(true)
  expect("rule.invalid" in errorsOf("rule.add")).toBe(true)

  expect("rule.missing" in errorsOf("rule.remove")).toBe(true)
  expect("rule.invalid" in errorsOf("rule.remove")).toBe(true)

  expect("rule.invalid" in errorsOf("rule.update")).toBe(true)
})

function errorsOf(method: keyof typeof Plus.Definition.methods): Record<string, unknown> {
  const entry = Plus.Definition.methods[method]
  if (!("errors" in entry) || entry.errors === undefined) return {}
  return entry.errors as Record<string, unknown>
}

// Core serves RPC results as JSON through HttpApi, whose success schema is
// the canonical JSON codec of RpcOutput. Unknown encodes to Json on that
// path, so a present-but-undefined key fails with "Expected JSON value".
const RpcBody = Schema.toCodecJson(Schema.Struct({ output: Schema.optionalKey(Schema.Unknown) }))

function expectRpcBody(value: unknown) {
  expect(() => Schema.encodeUnknownSync(RpcBody)({ output: value })).not.toThrow()
}

function assertNoUndefinedValues(obj: unknown, path = ""): void {
  if (obj === null || typeof obj !== "object") return
  for (const [key, value] of Object.entries(obj)) {
    const currentPath = path ? `${path}.${key}` : key
    expect(value, `found undefined value at ${currentPath}`).not.toBeUndefined()
    assertNoUndefinedValues(value, currentPath)
  }
}

test("representative Snapshot with omitted optional fields encodes without undefined keys", () => {
  const representative: Plus.Snapshot = {
    revision: 1,
    globalRevision: 2,
    agents: [
      {
        id: "build",
        scope: "project",
        fileBacked: true,
      },
    ],
    items: [
      {
        id: "tool:bash",
        kind: "tool",
        group: "native",
        title: "Bash",
        text: "Run commands",
        enabled: true,
        fingerprint: "fp-123",
      },
    ],
    records: [
      {
        type: "customization",
        level: "project",
        agent: "build",
        item: "tool:bash",
        section: null,
        basedOn: "fp-123",
        updated: "2026-09-14T00:00:00.000Z",
      },
      {
        type: "split",
        level: "defaults",
        agent: null,
        item: "tool:bash",
        boundaries: [{ id: "section-1", name: "Section 1", start: 0 }],
        updated: "2026-09-14T00:00:00.000Z",
      },
    ],
    teams: [
      {
        level: "project",
        team: "crew",
        enabled: true,
        agents: ["alpha", "nested/beta"],
      },
    ],
    servers: [
      {
        name: "test-server",
        enabled: true,
      },
    ],
    protectedAgents: ["build"],
  }

  const encoded = Schema.encodeSync(Plus.Snapshot)(representative)

  expectRpcBody(encoded)
  assertNoUndefinedValues(encoded)

  // Verify optional fields are omitted from encoded representation
  const encodedAgent = encoded.agents[0]
  expect("path" in encodedAgent).toBe(false)
  expect("base" in encodedAgent).toBe(false)
  expect(Object.keys(encodedAgent).sort()).toEqual(["fileBacked", "id", "scope"].sort())

  const encodedItem = encoded.items[0]
  expect("server" in encodedItem).toBe(false)
  expect("agents" in encodedItem).toBe(false)
  expect("order" in encodedItem).toBe(false)
  expect(Object.keys(encodedItem).sort()).toEqual(
    ["enabled", "fingerprint", "group", "id", "kind", "text", "title"].sort(),
  )

  const encodedRecord = encoded.records[0]
  expect("text" in encodedRecord).toBe(false)
  expect("state" in encodedRecord).toBe(false)
  expect("basedOnText" in encodedRecord).toBe(false)
  expect("acknowledged" in encodedRecord).toBe(false)
  expect(Object.keys(encodedRecord).sort()).toEqual(
    ["agent", "basedOn", "item", "level", "section", "type", "updated"].sort(),
  )

  const decoded = Schema.decodeUnknownSync(Plus.Snapshot)(encoded)
  expect(decoded).toEqual(representative)
})

test("Snapshot without teams still decodes and team schemas round-trip", () => {
  const withoutTeams = {
    revision: 1,
    globalRevision: 1,
    agents: [],
    items: [],
    records: [],
    servers: [],
    protectedAgents: [],
  }
  const decoded = Schema.decodeUnknownSync(Plus.Snapshot)(withoutTeams)
  expect(decoded.teams).toBeUndefined()

  const entry: Plus.TeamEntry = { level: "global", team: "ops", enabled: false, agents: [] }
  const encodedEntry = Schema.encodeSync(Plus.TeamEntry)(entry)
  expectRpcBody(encodedEntry)
  expect(Schema.decodeUnknownSync(Plus.TeamEntry)(encodedEntry)).toEqual(entry)

  const toggle: Plus.SetTeamEnabledInput = { level: "project", team: "crew", enabled: true }
  expect(Schema.decodeUnknownSync(Plus.SetTeamEnabledInput)(Schema.encodeSync(Plus.SetTeamEnabledInput)(toggle))).toEqual(toggle)
  const ref: Plus.TeamRef = { level: "project", team: "crew", enabled: true }
  expect(Schema.decodeUnknownSync(Plus.TeamRef)(Schema.encodeSync(Plus.TeamRef)(ref))).toEqual(ref)
})

test("Snapshot with populated optional fields round-trips correctly", () => {
  const fullSnapshot: Plus.Snapshot = {
    revision: 10,
    globalRevision: 20,
    agents: [
      {
        id: "reviewer",
        scope: "global",
        path: "/path/to/reviewer",
        base: "gpt",
        fileBacked: false,
      },
    ],
    items: [
      {
        id: "skill:lint",
        kind: "skill",
        group: "plus",
        server: "plus-server",
        title: "Linter",
        text: "Run lint",
        enabled: false,
        fingerprint: "fp-lint-456",
        agents: ["reviewer"],
        order: 5,
      },
      {
        id: "tool:bash",
        kind: "tool",
        group: "native",
        title: "Bash",
        text: "Run commands",
        enabled: true,
        fingerprint: "fp-bash-789",
        codemode: true,
        namespace: "ns",
        pinned: true,
      },
      {
        id: "tool:execute",
        kind: "tool",
        group: "native",
        title: "execute",
        text: "Host-owned Code Mode entry point",
        enabled: true,
        fingerprint: "fp-execute-000",
        codemode: false,
        execute: true,
      },
    ],
    records: [
      {
        type: "customization",
        level: "global",
        agent: "reviewer",
        item: "skill:lint",
        section: "details",
        text: "Custom lint text",
        state: "on",
        pin: true,
        basedOn: "fp-lint-456",
        basedOnText: "Base lint text",
        acknowledged: "fp-lint-456",
        updated: "2026-09-14T01:00:00.000Z",
      },
    ],
    servers: [
      {
        name: "plus-server",
        enabled: true,
      },
    ],
    protectedAgents: ["build", "reviewer"],
  }

  const encoded = Schema.encodeSync(Plus.Snapshot)(fullSnapshot)
  expectRpcBody(encoded)
  assertNoUndefinedValues(encoded)

  // The Code Mode keys ride the snapshot that carries them without undefined
  // values, alongside the populated optional fields above.
  const encodedTool = encoded.items.find((entry) => entry.id === "tool:bash")
  expect(encodedTool?.namespace).toBe("ns")
  expect(encodedTool?.pinned).toBe(true)
  const encodedExecute = encoded.items.find((entry) => entry.id === "tool:execute")
  expect(encodedExecute?.execute).toBe(true)
  expect(encoded.records[0]).toMatchObject({ pin: true })

  const decoded = Schema.decodeUnknownSync(Plus.Snapshot)(encoded)
  expect(decoded).toEqual(fullSnapshot)
})

test("Address schema handles null agent and section correctly", () => {
  const addressWithNulls: Plus.Address = {
    level: "defaults",
    agent: null,
    item: "tool:bash",
    section: null,
  }
  const encodedNulls = Schema.encodeSync(Plus.Address)(addressWithNulls)
  expect(Schema.decodeUnknownSync(Plus.Address)(encodedNulls)).toEqual(addressWithNulls)

  const addressWithValues: Plus.Address = {
    level: "project",
    agent: "developer",
    item: "base:gpt",
    section: "preamble",
  }
  const encodedValues = Schema.encodeSync(Plus.Address)(addressWithValues)
  expect(Schema.decodeUnknownSync(Plus.Address)(encodedValues)).toEqual(addressWithValues)
})

test("Assembled schema round-trips correctly", () => {
  const assembled: Plus.Assembled = {
    agent: "developer",
    system: ["You are a helpful assistant", "Follow conventions"],
    tools: [
      { id: "read", description: "Read files" },
      { id: "write", description: "Write files" },
    ],
    skills: [{ id: "skill:test", content: "Test instructions" }],
  }

  const encoded = Schema.encodeSync(Plus.Assembled)(assembled)
  expectRpcBody(encoded)
  expect(Schema.decodeUnknownSync(Plus.Assembled)(encoded)).toEqual(assembled)
})

test("MutateInput and MutateResult schemas round-trip correctly", () => {
  const snapshot: Plus.Snapshot = {
    revision: 1,
    globalRevision: 1,
    agents: [],
    items: [],
    records: [],
    teams: [],
    servers: [],
    protectedAgents: [],
  }

  const input: Plus.MutateInput = {
    expectedRevision: 1,
    expectedGlobalRevision: 1,
    records: [
      {
        type: "customization",
        level: "project",
        agent: null,
        item: "item:1",
        section: null,
        basedOn: "fp-1",
        updated: "2026-09-14T00:00:00.000Z",
      },
    ],
  }
  const encodedInput = Schema.encodeSync(Plus.MutateInput)(input)
  expect(Schema.decodeUnknownSync(Plus.MutateInput)(encodedInput)).toEqual(input)

  const success: Plus.MutateResult = {
    ok: true,
    revision: 2,
    globalRevision: 2,
    snapshot,
  }
  const encodedSuccess = Schema.encodeSync(Plus.MutateResult)(success)
  expectRpcBody(encodedSuccess)
  expect(Schema.decodeUnknownSync(Plus.MutateResult)(encodedSuccess)).toEqual(success)

  const conflict: Plus.MutateResult = {
    ok: false,
    reason: "stale",
    store: "project",
    snapshot,
  }
  const encodedConflict = Schema.encodeSync(Plus.MutateResult)(conflict)
  expectRpcBody(encodedConflict)
  expect(Schema.decodeUnknownSync(Plus.MutateResult)(encodedConflict)).toEqual(conflict)
})

test("MutateInput with actor and Log schemas round-trip without undefined keys", () => {
  const withActor: Plus.MutateInput = {
    expectedRevision: 1,
    expectedGlobalRevision: 2,
    records: [],
    actor: { type: "tool", agent: "alpha", sessionID: "ses_1", messageID: "msg_1" },
  }
  const encodedActor = Schema.encodeSync(Plus.MutateInput)(withActor)
  expect(Schema.decodeUnknownSync(Plus.MutateInput)(encodedActor)).toEqual(withActor)
  expectRpcBody(encodedActor)
  assertNoUndefinedValues(encodedActor)

  const withoutActor: Plus.MutateInput = { expectedRevision: 1, expectedGlobalRevision: 2, records: [] }
  const encodedBare = Schema.encodeSync(Plus.MutateInput)(withoutActor)
  expect("actor" in encodedBare).toBe(false)
  expect(Schema.decodeUnknownSync(Plus.MutateInput)(encodedBare)).toEqual(withoutActor)

  const entry: Plus.LogEntry = {
    ts: "2026-09-14T00:00:00.000Z",
    actor: { type: "tui" },
    op: "mutate",
    target: "item:project:alpha:tool:bash",
    summary: "mutate item:project:alpha:tool:bash",
    revision: 1,
  }
  const encodedEntry = Schema.encodeSync(Plus.LogEntry)(entry)
  expectRpcBody(encodedEntry)
  assertNoUndefinedValues(encodedEntry)
  expect(Schema.decodeUnknownSync(Plus.LogEntry)(encodedEntry)).toEqual(entry)

  const output: Plus.LogOutput = { entries: [entry], total: 1 }
  const encodedOutput = Schema.encodeSync(Plus.LogOutput)(output)
  expectRpcBody(encodedOutput)
  assertNoUndefinedValues(encodedOutput)
  expect(Schema.decodeUnknownSync(Plus.LogOutput)(encodedOutput)).toEqual(output)

  const filtered: Plus.LogInput = { where: "op:mutate", limit: 10, offset: 0 }
  expect(Schema.decodeUnknownSync(Plus.LogInput)(Schema.encodeSync(Plus.LogInput)(filtered))).toEqual(filtered)
  const empty: Plus.LogInput = {}
  const encodedEmpty = Schema.encodeSync(Plus.LogInput)(empty)
  expect("where" in encodedEmpty).toBe(false)
  expect("limit" in encodedEmpty).toBe(false)
  expect("offset" in encodedEmpty).toBe(false)
  expect(Schema.decodeUnknownSync(Plus.LogInput)(encodedEmpty)).toEqual(empty)
})

test("agent.create input with template round-trips correctly", () => {
  const withTemplate: Plus.CreateAgentInput = {
    scope: "project",
    id: "specialist",
    template: "general",
    prompt: "Custom prompt",
  }
  const encodedWith = Schema.encodeSync(Plus.CreateAgentInput)(withTemplate)
  expect(Schema.decodeUnknownSync(Plus.CreateAgentInput)(encodedWith)).toEqual(withTemplate)

  const withoutTemplate: Plus.CreateAgentInput = {
    scope: "global",
    id: "general-agent",
    prompt: "Prompt",
  }
  const encodedWithout = Schema.encodeSync(Plus.CreateAgentInput)(withoutTemplate)
  expect("template" in encodedWithout).toBe(false)
  expect(Schema.decodeUnknownSync(Plus.CreateAgentInput)(encodedWithout)).toEqual(withoutTemplate)
})

test("MCP and Skill input/output schemas round-trip correctly", () => {
  const addMcp: Plus.AddMcpInput = {
    name: "github",
    config: { token: "secret", endpoint: "https://api.github.com" },
  }
  const encodedAddMcp = Schema.encodeSync(Plus.AddMcpInput)(addMcp)
  expect(Schema.decodeUnknownSync(Plus.AddMcpInput)(encodedAddMcp)).toEqual(addMcp)

  const mcpRef: Plus.McpRef = { name: "github" }
  const encodedMcpRef = Schema.encodeSync(Plus.McpRef)(mcpRef)
  expect(Schema.decodeUnknownSync(Plus.McpRef)(encodedMcpRef)).toEqual(mcpRef)

  const createSkill: Plus.CreateSkillInput = {
    name: "deploy",
    body: "Deployment steps",
  }
  const encodedSkill = Schema.encodeSync(Plus.CreateSkillInput)(createSkill)
  expect(Schema.decodeUnknownSync(Plus.CreateSkillInput)(encodedSkill)).toEqual(createSkill)

  const skillRef: Plus.SkillRef = { id: "skill:deploy", path: "/skills/deploy" }
  const encodedSkillRef = Schema.encodeSync(Plus.SkillRef)(skillRef)
  expect(Schema.decodeUnknownSync(Plus.SkillRef)(encodedSkillRef)).toEqual(skillRef)
})

test("new Code Mode keys decode and never encode as undefined", () => {
  const item: Plus.SnapshotItem = {
    id: "tool:bash",
    kind: "tool",
    group: "native",
    title: "Bash",
    text: "Run commands",
    enabled: true,
    fingerprint: "fp-123",
    namespace: "ns",
    pinned: true,
    execute: true,
  }
  const encoded = Schema.encodeSync(Plus.SnapshotItem)(item)
  expectRpcBody(encoded)
  assertNoUndefinedValues(encoded)
  expect(encoded.namespace).toBe("ns")
  expect(encoded.pinned).toBe(true)
  expect(encoded.execute).toBe(true)
  expect(Schema.decodeUnknownSync(Plus.SnapshotItem)(encoded)).toEqual(item)

  const bare: Plus.SnapshotItem = {
    id: "tool:bash",
    kind: "tool",
    group: "native",
    title: "Bash",
    text: "Run commands",
    enabled: true,
    fingerprint: "fp-123",
  }
  const encodedBare = Schema.encodeSync(Plus.SnapshotItem)(bare)
  expect("namespace" in encodedBare).toBe(false)
  expect("pinned" in encodedBare).toBe(false)
  expect("execute" in encodedBare).toBe(false)
  expect(Schema.decodeUnknownSync(Plus.SnapshotItem)(encodedBare)).toEqual(bare)

  const record: Plus.SnapshotCustomizationRecord = {
    type: "customization",
    level: "project",
    agent: "build",
    item: "tool:bash",
    section: null,
    pin: true,
    basedOn: "fp-123",
    updated: "2026-09-14T00:00:00.000Z",
  }
  const encodedRecord = Schema.encodeSync(Plus.SnapshotCustomizationRecord)(record)
  expectRpcBody(encodedRecord)
  assertNoUndefinedValues(encodedRecord)
  expect(encodedRecord.pin).toBe(true)
  expect(Schema.decodeUnknownSync(Plus.SnapshotCustomizationRecord)(encodedRecord)).toEqual(record)

  const bareRecord: Plus.SnapshotCustomizationRecord = {
    type: "customization",
    level: "project",
    agent: "build",
    item: "tool:bash",
    section: null,
    basedOn: "fp-123",
    updated: "2026-09-14T00:00:00.000Z",
  }
  const encodedBareRecord = Schema.encodeSync(Plus.SnapshotCustomizationRecord)(bareRecord)
  expect("pin" in encodedBareRecord).toBe(false)
  expect(Schema.decodeUnknownSync(Plus.SnapshotCustomizationRecord)(encodedBareRecord)).toEqual(bareRecord)
})
