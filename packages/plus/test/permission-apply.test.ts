// Permission rows through apply(): the core rules it installs, in the order
// core's last-match-wins evaluation needs, and the enforcement hooks it
// installs on the host seams. The seams record what Plus registers so the
// test calls the installed callbacks the way core would; no Plus code is
// replaced.
import { expect, test } from "bun:test"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import type { Registration } from "@opencode/plugin/effect/registration"
import type { ShellCreateBefore } from "@opencode/plugin/effect/shell"
import type { ToolHooks } from "@opencode/plugin/effect/tool"
import { Agent } from "@opencode/schema/agent"
import { Session } from "@opencode/schema/session"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect } from "effect"
import { apply, orderRules, type ApplyInput } from "../src/instructions/apply.js"
import { fingerprint, type CustomizationRecord, type Item } from "../src/instructions/model.js"
import { catalogItems } from "../src/instructions/permission-catalog.js"
import { decide, enforcementState, permissionTable } from "../src/instructions/permission-enforce.js"
import { actionForToolId } from "../src/instructions/tool-permissions.js"
import { agentHarness, agentInfo, context, toolHarness } from "./harness.js"
import { change, linked, presetInput } from "./teams/preset-table.js"

const UPDATED = "2026-01-01T00:00:00.000Z"

function toolItem(tool: string): Item {
  return { id: `tool:${tool}`, kind: "tool", group: "native", title: tool, text: tool, enabled: true, fingerprint: fingerprint(tool) }
}

function record(agent: string, item: string, state: "on" | "off"): CustomizationRecord {
  return { type: "customization", level: "project", agent, item, section: null, state, basedOn: fingerprint("upstream"), updated: UPDATED }
}

type Recorded = (event: never) => Effect.Effect<void, unknown>

// A host seam that keeps what Plus registers on it.
function recordingSeam() {
  const installed = new Map<string, Recorded>()
  const hook = (name: string, callback: Recorded) =>
    Effect.sync(() => {
      installed.set(name, callback)
      return {
        dispose: Effect.sync(() => {
          installed.delete(name)
        }),
      }
    })
  return { hook, installed }
}

type Seam = ReturnType<typeof recordingSeam>

function hostFor(agents: readonly string[]) {
  const harness = agentHarness(agents.map((id) => agentInfo(id, "upstream")))
  const tool = recordingSeam()
  const permission = recordingSeam()
  const shell = recordingSeam()
  const unused = () => Effect.die("unused in this test")
  const ctx = context({
    agent: harness.domain,
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
    tool: { ...toolHarness().domain, hook: tool.hook },
    permission: { list: unused, get: unused, reply: unused, rules: unused, hook: permission.hook },
    shell: { hook: shell.hook },
  })
  return { ctx, harness, tool, permission, shell }
}

function input(overrides: Partial<ApplyInput> & Pick<ApplyInput, "items" | "agents">): ApplyInput {
  return { records: [], splits: [], scopes: { global: new Set<string>(), defaults: new Set<string>() }, ...overrides }
}

// A native agent beside the members: its rows fall back to their shipped values.
function withNativeAlpha(base: ApplyInput): ApplyInput {
  return {
    ...base,
    agents: [...base.agents, { id: "alpha", level: "project" }],
    scopes: { ...base.scopes, native: new Set([...(base.scopes.native ?? []), "alpha"]) },
  }
}

async function dispose(registrations: readonly Registration[]) {
  for (const registration of registrations.toReversed()) await Effect.runPromise(registration.dispose)
}

// The rules one agent carries after apply, core's defaults included.
async function rulesAfterApply(agent: string, overrides: Partial<ApplyInput> & Pick<ApplyInput, "items" | "agents">) {
  const host = hostFor([agent])
  const applied = await apply(host.ctx, input(overrides))
  const rules = [...(host.harness.state.get(agent)?.permissions ?? [])]
  await dispose(applied.registrations)
  return rules
}

const baseline = agentInfo("alpha", "upstream").permissions.length

function beforeEvent(agent: string, tool: string, value: unknown, options: { call?: string; session?: string } = {}): ToolHooks["execute.before"] {
  return {
    tool,
    sessionID: Session.ID.make(options.session ?? "ses_watched"),
    agent: Agent.ID.make(agent),
    messageID: SessionMessage.ID.make("msg_permission_apply"),
    id: Tool.CallID.make(options.call ?? "call_1"),
    input: value,
  }
}

// Runs the installed execute.before like core does: a Tool.Error refuses the
// call before the tool runs. Answers the refusal text, or undefined.
async function refusalOf(seam: Seam, event: ToolHooks["execute.before"]): Promise<string | undefined> {
  const callback = seam.installed.get("execute.before") as ((event: ToolHooks["execute.before"]) => Effect.Effect<void, Tool.Error>) | undefined
  if (callback === undefined) throw new Error("execute.before was not installed")
  return Effect.runPromise(callback(event).pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => undefined })))
}

function afterEvent(agent: string, tool: string, result: Tool.Result) {
  return {
    tool,
    sessionID: Session.ID.make("ses_watched"),
    agent: Agent.ID.make(agent),
    messageID: SessionMessage.ID.make("msg_permission_apply"),
    id: Tool.CallID.make("call_1"),
    input: {},
    status: "completed" as const,
    result,
  }
}

// Runs the installed execute.after on a completed call; it may replace the result.
async function complete(seam: Seam, event: ToolHooks["execute.after"]): Promise<void> {
  const callback = seam.installed.get("execute.after") as ((event: ToolHooks["execute.after"]) => Effect.Effect<void>) | undefined
  if (callback === undefined) throw new Error("execute.after was not installed")
  await Effect.runPromise(callback(event))
}

async function authorize(seam: Seam, event: PermissionEvaluation): Promise<void> {
  const callback = seam.installed.get("evaluate") as ((event: PermissionEvaluation) => Effect.Effect<void>) | undefined
  if (callback === undefined) throw new Error("permission evaluate was not installed")
  await Effect.runPromise(callback(event))
}

async function spawn(seam: Seam, invocation: ShellCreateBefore): Promise<void> {
  const callback = seam.installed.get("create.before") as ((event: ShellCreateBefore) => Effect.Effect<void>) | undefined
  if (callback === undefined) throw new Error("shell create.before was not installed")
  await Effect.runPromise(callback(invocation))
}

function evaluation(call: string, effect: PermissionEvaluation["effect"] = "allow"): PermissionEvaluation {
  return {
    sessionID: Session.ID.make("ses_watched"),
    agent: Agent.ID.make("alpha"),
    action: "webfetch",
    resources: ["https://example.org"],
    source: { type: "tool", messageID: "msg_permission_apply", id: call },
    effect,
  }
}

// ── rule order ────────────────────────────────────────────────────────────

test("orderRules puts role defaults first (allow, ask, deny), then what lets through, then role refusals, and every row refusal last", () => {
  const rules = [
    { id: 1, resource: "git push *", effect: "deny" as const, refusal: true },
    { id: 2, resource: "*", effect: "deny" as const },
    { id: 3, resource: "/tmp/*", effect: "allow" as const },
    { id: 4, resource: "*", effect: "allow" as const },
    { id: 5, resource: ".git/**", effect: "deny" as const },
    { id: 6, resource: "docs/*", effect: "ask" as const },
    { id: 7, resource: "*", effect: "ask" as const },
    { id: 8, resource: "rm *", effect: "deny" as const, refusal: true },
    { id: 9, resource: "src/*", effect: "allow" as const },
    // A user rule of pattern `*` that is off is still a refusal: it lands
    // last, so no role allow can reopen it.
    { id: 10, resource: "*", effect: "deny" as const, refusal: true },
  ]
  expect(orderRules(rules).map((rule) => rule.id)).toEqual([4, 7, 2, 3, 9, 6, 5, 1, 8, 10])
})

// The old orchestrator role's shell restriction is the orchestrator preset's
// shell rows now: each change family refuses with its own row's reason, and
// turning one row back on reopens exactly that family.
test("an orchestrator-preset member's shell change rows refuse every change command with their own reason", async () => {
  const { evaluate } = await import("../../core/src/permission.js")
  const alice = linked("ocp-alice", "orchestrator")
  const rules = await rulesAfterApply(alice.id, presetInput({ members: [alice] }))
  expect(evaluate("shell", "git push origin main", rules)).toMatchObject({ effect: "deny", message: "pushing is not allowed here" })
  expect(evaluate("shell", "git commit -m x", rules)).toMatchObject({ effect: "deny", message: "committing is not allowed here" })
  expect(evaluate("shell", "git stash", rules)).toMatchObject({ effect: "deny", message: "changing the git working tree is not allowed here" })
  expect(evaluate("shell", "git worktree add ../x", rules)).toMatchObject({ effect: "deny", message: "changing git refs or worktrees is not allowed here" })
  expect(evaluate("shell", "echo x > f.txt", rules)).toMatchObject({ effect: "deny", message: "writing files from the shell is not allowed here" })
  expect(evaluate("shell", "git status", rules).effect).not.toBe("deny")
  expect(evaluate("shell", "bun test test/a.test.ts", rules).effect).not.toBe("deny")

  const reopened = await rulesAfterApply(alice.id, presetInput({ members: [alice], records: [change(alice, "perm:shell:git-push", { state: "on" })] }))
  expect(evaluate("shell", "git push origin main", reopened).effect).not.toBe("deny")
  expect(evaluate("shell", "git commit -m x", reopened).effect).toBe("deny")
})

test("Where and a Files fallback are checked on the call: closing them installs no core rule an allow could fight", async () => {
  const { evaluate } = await import("../../core/src/permission.js")
  const items = catalogItems([toolItem("read")], actionForToolId)
  const agents = [{ id: "alpha", level: "project" as const }]
  const keyDenies = ["*.key", "*.pem", "*.p12", "*.pfx", "id_rsa", "id_rsa.*", "*/id_rsa", "*/id_rsa.*", "id_ed25519", "*/id_ed25519", "*/id_ed25519.*", "*/id_ecdsa", "*/id_ecdsa.*"].map(
    (resource) => ({ action: "read", resource, effect: "deny" as const, message: "Private keys cannot be read here" }),
  )
  const closed = await rulesAfterApply("alpha", {
    items,
    agents,
    records: [record("alpha", "perm:read:files.keys", "off"), record("alpha", "perm:read:where.outside", "off"), record("alpha", "perm:read:files.*", "off")],
  })
  // Only the deny-list row became core rules; Where and Every other file did not.
  expect(closed.slice(baseline)).toEqual(keyDenies)
  expect(evaluate("read", "/tmp/.ssh/id_rsa", closed).effect).toBe("deny")
  const rows = catalogItems([toolItem("read")], actionForToolId)
  const table = permissionTable({
    items: rows,
    teamMembers: [],
    resolve: (item) => ({ enabled: ["perm:read:where.outside", "perm:read:files.*"].includes(item.id) ? false : item.enabled, text: item.text }),
  })
  const read = (file: string) => decide(table.toolRows("alpha", "read"), { tool: "read", input: { path: file }, sessionID: "ses", directory: "/work", teamMembers: new Set() })
  // Every other file off refuses every read, inside the checkout too.
  expect(read("src/index.ts").refuse).toContain("reading this file is not allowed here")
  const whereOnly = permissionTable({
    items: rows,
    teamMembers: [],
    resolve: (item) => ({ enabled: item.id === "perm:read:where.outside" ? false : item.enabled, text: item.text }),
  })
  const whereRead = (file: string) =>
    decide(whereOnly.toolRows("alpha", "read"), { tool: "read", input: { path: file }, sessionID: "ses", directory: "/work", teamMembers: new Set() })
  expect(whereRead("/etc/passwd").refuse).toContain("outside this checkout")
  expect(whereRead("/tmp/notes.txt").refuse).toBeUndefined()
  expect(whereRead("src/index.ts").refuse).toBeUndefined()
})

// ── enforcement hooks ──────────────────────────────────────────────────────

test("execute.before refuses an implementer-preset member's grep on secret files through its grep rows", async () => {
  const member = "ocp-deepseek-implementer"
  const host = hostFor([member, "alpha"])
  const applied = await apply(host.ctx, withNativeAlpha(presetInput({ members: [linked(member, "implementer")] })))
  expect(await refusalOf(host.tool, beforeEvent(member, "grep", { pattern: "KEY", path: ".env" }))).toBe("Permission denied: .env files is not allowed here")
  expect(await refusalOf(host.tool, beforeEvent(member, "grep", { pattern: "KEY", path: "config/.env.local" }))).toBe("Permission denied: .env files is not allowed here")
  expect(await refusalOf(host.tool, beforeEvent(member, "grep", { pattern: "KEY", include: "*.env" }))).toBe("Permission denied: searching .env files is not allowed here")
  expect(await refusalOf(host.tool, beforeEvent(member, "grep", { pattern: "KEY", path: "src" }))).toBeUndefined()
  // A native agent outside the team keeps the shipped rows, which search it.
  expect(await refusalOf(host.tool, beforeEvent("alpha", "grep", { pattern: "KEY", path: ".env" }))).toBeUndefined()

  // A search of the whole checkout drops the secret files from the member's results.
  const matches = [
    { entry: { path: "src/config.ts" }, line: 3, text: "const KEY = process.env.KEY" },
    { entry: { path: ".env" }, line: 1, text: "KEY=sk-live" },
  ]
  const text = "Found 2 matches\n/workspace/src/config.ts:\n  Line 3: const KEY = process.env.KEY\n\n/workspace/.env:\n  Line 1: KEY=sk-live"
  const searched = afterEvent(member, "grep", { output: matches, content: text })
  await complete(host.tool, searched)
  expect(searched.result.output).toEqual([matches[0]])
  const filtered = searched.result.content
  expect(Array.isArray(filtered) ? filtered.length : undefined).toBe(1)
  const shown = Array.isArray(filtered) ? filtered.map((part) => (part.type === "text" ? part.text : "")).join("\n") : ""
  expect(shown).toStartWith("Found 1 matches\n")
  expect(shown).toContain("  Line 3: const KEY = process.env.KEY")
  expect(shown).not.toContain("KEY=sk-live")
  const unfiltered = afterEvent("alpha", "grep", { output: matches, content: text })
  await complete(host.tool, unfiltered)
  expect(unfiltered.result).toEqual({ output: matches, content: text })

  await dispose(applied.registrations)
  expect(host.tool.installed.size).toBe(0)
})

// core/src/tool/plugin/grep.ts ends a result that hit its limit with a
// truncation notice (and says so in metadata). Dropping hidden files leaves
// the result exactly as truncated, so the model must still be told.
test("a grep result filtered for a team member still says it was truncated", async () => {
  const member = "ocp-deepseek-implementer"
  const host = hostFor([member])
  const applied = await apply(host.ctx, presetInput({ members: [linked(member, "implementer")] }))
  const matches = [
    { entry: { path: "src/config.ts" }, line: 3, text: "const KEY = process.env.KEY" },
    { entry: { path: ".env" }, line: 1, text: "KEY=sk-live" },
  ]
  const notice = "(Results are truncated: showing first 2 results. Consider using a more specific path or pattern.)"
  const searched = afterEvent(member, "grep", {
    output: matches,
    content: `Found 2 matches\n/workspace/src/config.ts:\n  Line 3: const KEY = process.env.KEY\n\n/workspace/.env:\n  Line 1: KEY=sk-live\n\n${notice}`,
    metadata: { matches: 2, truncated: true },
  })
  await complete(host.tool, searched)
  expect(searched.result.output).toEqual([matches[0]])
  const content = searched.result.content
  const text = typeof content === "string" ? content : content?.map((part) => (part.type === "text" ? part.text : "")).join("\n")
  expect(text).not.toContain("KEY=sk-live")
  expect(text).toContain("(Results are truncated")
  await dispose(applied.registrations)
})

test("execute.after masks secret values in instructions results while Show secret values is off", async () => {
  const host = hostFor(["alpha", "beta"])
  const applied = await apply(
    host.ctx,
    input({
      items: catalogItems([toolItem("instructions_show")], actionForToolId),
      agents: [
        { id: "alpha", level: "project" },
        { id: "beta", level: "project" },
      ],
      records: [record("alpha", "perm:instructions_show:secrets.values", "off")],
    }),
  )
  const row = { id: "mcp:search", config: { url: "https://mcp.example.org", headers: { Authorization: "Bearer sk-live" } } }
  // An MCP row is config through and through: its URL (which can carry a
  // key) is masked with its headers; its id stays.
  const masked = { id: "mcp:search", config: { url: "[masked]", headers: { Authorization: "[masked]" } } }
  expect(await refusalOf(host.tool, beforeEvent("alpha", "instructions_show", { id: "item:defaults::mcp:search" }))).toBeUndefined()
  const shown = afterEvent("alpha", "instructions_show", { output: row, content: JSON.stringify(row) })
  await complete(host.tool, shown)
  expect(shown.result).toEqual({ output: masked, content: [{ type: "text", text: JSON.stringify(masked, null, 2) }] })
  const open = afterEvent("beta", "instructions_show", { output: row, content: JSON.stringify(row) })
  await complete(host.tool, open)
  expect(open.result).toEqual({ output: row, content: JSON.stringify(row) })
  await dispose(applied.registrations)
})

test("the permission evaluate hook turns an approval row into a question for that very call", async () => {
  const host = hostFor(["alpha"])
  const enforcement = enforcementState()
  const applied = await apply(
    host.ctx,
    input({
      items: catalogItems([toolItem("webfetch")], actionForToolId),
      agents: [{ id: "alpha", level: "project" }],
      records: [record("alpha", "perm:webfetch:approval.every", "on")],
      enforcement,
    }),
  )
  expect(await refusalOf(host.tool, beforeEvent("alpha", "webfetch", { url: "https://example.org" }, { call: "call_1" }))).toBeUndefined()
  const asked = evaluation("call_1")
  await authorize(host.permission, asked)
  expect(asked.effect).toBe("ask")
  expect(asked.message).toContain("webfetch asks the human")
  // The call waits until the human answers: core's re-evaluation of the
  // pending request (after an "always" to something else) still asks.
  const again = evaluation("call_1")
  await authorize(host.permission, again)
  expect(again.effect).toBe("ask")

  // Another call is core's own.
  const other = evaluation("call_2")
  await authorize(host.permission, other)
  expect(other).toEqual(evaluation("call_2"))
  // Once answered, the call's later checks of the same action pass.
  for (const entry of enforcement.asks.values()) for (const ask of entry) ask.status = "answered"
  const answered = evaluation("call_1")
  await authorize(host.permission, answered)
  expect(answered).toEqual(evaluation("call_1"))

  // A deny core already reached stays a deny.
  expect(await refusalOf(host.tool, beforeEvent("alpha", "webfetch", { url: "https://example.org" }, { call: "call_3" }))).toBeUndefined()
  const denied = evaluation("call_3", "deny")
  await authorize(host.permission, denied)
  expect(denied).toEqual(evaluation("call_3", "deny"))
  await dispose(applied.registrations)
})

test("nobody is asked in a delegated run: approval and questions are refused there", async () => {
  const host = hostFor(["alpha"])
  const applied = await apply(
    host.ctx,
    input({
      items: catalogItems([toolItem("webfetch"), toolItem("question")], actionForToolId),
      agents: [{ id: "alpha", level: "project" }],
      records: [record("alpha", "perm:webfetch:approval.every", "on")],
      // A team is enabled, so "In delegated team runs" matters.
      teamAgents: ["ocp-deepseek-implementer"],
      enforcementDeps: { headless: async (sessionID) => sessionID === "ses_child" },
    }),
  )
  const unwatched = await refusalOf(host.tool, beforeEvent("alpha", "webfetch", { url: "https://example.org" }, { session: "ses_child" }))
  expect(unwatched).toStartWith("Permission denied: ")
  expect(unwatched).toContain("nobody watches a delegated run")
  const ask = { questions: [{ question: "Which one?", options: [] }] }
  expect(await refusalOf(host.tool, beforeEvent("alpha", "question", ask, { session: "ses_child" }))).toBe(
    "Permission denied: no human watches a delegated run; finish with needs_context instead of asking",
  )
  expect(await refusalOf(host.tool, beforeEvent("alpha", "question", ask))).toBeUndefined()
  await dispose(applied.registrations)
})

test("shell create.before strips secret variables from the command execute.before announced", async () => {
  const host = hostFor(["alpha", "beta"])
  const applied = await apply(
    host.ctx,
    input({
      items: catalogItems([toolItem("shell")], actionForToolId),
      agents: [
        { id: "alpha", level: "project" },
        { id: "beta", level: "project" },
      ],
      records: [record("alpha", "perm:shell:environment.secrets", "off")],
    }),
  )
  const env = { PATH: "/usr/bin", HOME: "/home/dev", OPENAI_API_KEY: "sk-1", GITHUB_TOKEN: "ghp_1", DB_PASSWORD: "p", AWS_REGION: "eu-west-1" }
  const invocation = (command: string): ShellCreateBefore => ({ command, cwd: "/workspace", timeout: 120000, shell: "/bin/bash", env: { ...env } })

  expect(await refusalOf(host.tool, beforeEvent("alpha", "shell", { command: "bun test" }))).toBeUndefined()
  const announced = invocation("bun test")
  await spawn(host.shell, announced)
  expect(announced.env).toEqual({ PATH: "/usr/bin", HOME: "/home/dev" })

  // One announcement strips one spawn; an unannounced command keeps its env.
  const repeated = invocation("bun test")
  await spawn(host.shell, repeated)
  expect(repeated.env).toEqual(env)
  const unannounced = invocation("ls")
  await spawn(host.shell, unannounced)
  expect(unannounced.env).toEqual(env)

  // An agent whose row is on inherits everything.
  expect(await refusalOf(host.tool, beforeEvent("beta", "shell", { command: "bun run build" }))).toBeUndefined()
  const inherited = invocation("bun run build")
  await spawn(host.shell, inherited)
  expect(inherited.env).toEqual(env)
  await dispose(applied.registrations)
})
