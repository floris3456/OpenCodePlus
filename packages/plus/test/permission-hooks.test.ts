// The permission hooks as the host drives them: execute.before, the
// permission evaluate hook, execute.after and shell create.before, installed
// by installEnforcement on a harness context whose tool, permission and shell
// seams record their callbacks. Plus's own code runs unstubbed.
import { expect, test } from "bun:test"
import type { Registration } from "@opencode/plugin/effect/registration"
import { Effect, Exit } from "effect"
import { catalogItems } from "../src/instructions/permission-catalog.js"
import {
  addressesAgent,
  decide,
  enforcementState,
  installEnforcement,
  maskSecrets,
  permissionTable,
  sweep,
  takeShell,
  type EnforcementState,
  type PermissionTable,
} from "../src/instructions/permission-enforce.js"
import { orderRules } from "../src/instructions/apply.js"
import { fingerprint, type Item } from "../src/instructions/model.js"
import { context } from "./harness.js"
import { change, linked, presetTable } from "./teams/preset-table.js"
import fs from "node:fs/promises"
import path from "node:path"
import os from "node:os"
import { teamsDataDir } from "../src/instructions/paths.js"
import { saveRun, type RunRecord } from "../src/teams/run.js"
import { atomicJson } from "../src/teams/store.js"

function toolRow(id: string, group: Item["group"] = "native"): Item {
  return { id: `tool:${id}`, kind: "tool", group, title: id, text: id, enabled: true, fingerprint: fingerprint(id) }
}

// Each tool's permission action, as the registry declares it (the three file
// tools share "edit", every instructions tool shares "instructions").
const actions: Record<string, string> = {
  edit: "edit",
  write: "edit",
  patch: "edit",
  instructions_set: "instructions",
  instructions_delete: "instructions",
  instructions_list: "instructions",
  team_delegate: "team.delegate",
}

// Catalog rows for the named tools with some rows switched: `off` and `on`
// name row ids (perm:<tool>:<category>.<row>) whose state differs from the
// shipped one. Texts may be overridden to set a limit.
function tableFor(tools: readonly string[], states: Record<string, boolean>, members: readonly string[] = []): PermissionTable {
  const items = catalogItems(
    tools.map((tool) => toolRow(tool, tool.startsWith("search_") ? "mcp" : tool.includes("_") ? "plus" : "native")),
    (tool) => actions[tool],
  )
  return permissionTable({
    items,
    teamMembers: members,
    resolve: (item) => ({ enabled: states[item.id] ?? item.enabled, text: item.text }),
  })
}

interface Recorded {
  before?: (event: { tool: string; sessionID: string; agent: string; messageID: string; id: string; input: unknown }) => Effect.Effect<void, unknown>
  after?: (event: Record<string, unknown>) => Effect.Effect<void>
  evaluate?: (event: { sessionID: string; agent?: string; action: string; resources: string[]; source?: unknown; effect: string; message?: string }) => Effect.Effect<void>
  shell?: (event: { command: string; cwd: string; timeout: number; shell: string; env: Record<string, string | undefined> }) => Effect.Effect<void>
}

async function installed(table: PermissionTable, state: EnforcementState = enforcementState(), headless = false) {
  const recorded: Recorded = {}
  const registration = (): Effect.Effect<Registration> => Effect.succeed({ dispose: Effect.void })
  const ctx = context({
    tool: {
      transform: () => registration(),
      reload: () => Effect.void,
      hook: ((name: string, callback: never) => {
        if (name === "execute.before") recorded.before = callback
        if (name === "execute.after") recorded.after = callback
        return registration()
      }) as never,
    },
    permission: {
      list: () => Effect.die("unused"),
      get: () => Effect.die("unused"),
      reply: () => Effect.die("unused"),
      rules: () => Effect.die("unused"),
      hook: ((name: string, callback: never) => {
        if (name === "evaluate") recorded.evaluate = callback
        return registration()
      }) as never,
    } as never,
    shell: {
      hook: ((name: string, callback: never) => {
        if (name === "create.before") recorded.shell = callback
        return registration()
      }) as never,
    },
  })
  const registrations = await installEnforcement(ctx, table, state, { headless: async () => headless })
  return { recorded, registrations, state }
}

async function before(recorded: Recorded, event: { tool: string; agent: string; input: unknown; id?: string; messageID?: string }) {
  const hook = recorded.before
  if (hook === undefined) throw new Error("execute.before not installed")
  const full = { sessionID: "ses_hooks", messageID: event.messageID ?? "msg_1", id: event.id ?? "call_1", ...event }
  const exit = await Effect.runPromiseExit(hook(full))
  return { exit, input: full.input }
}

async function evaluate(recorded: Recorded, action: string, id = "call_1", effect = "allow") {
  const hook = recorded.evaluate
  if (hook === undefined) throw new Error("permission evaluate not installed")
  const event = { sessionID: "ses_hooks", agent: "build", action, resources: ["*"], source: { type: "tool", messageID: "msg_1", id }, effect } as {
    sessionID: string
    agent: string
    action: string
    resources: string[]
    source: unknown
    effect: string
    message?: string
  }
  await Effect.runPromise(hook(event))
  return event
}

function refusal(exit: Exit.Exit<void, unknown>): string | undefined {
  if (Exit.isSuccess(exit)) return undefined
  const failure = exit.cause.toString()
  return failure
}

test("a member's own rows are recognised in Teams-catalogue ids, so targets.self holds for team members", () => {
  expect(addressesAgent("item:project:crew/:lab-planner:perm:grep:files.env", "lab-planner")).toBe(true)
  expect(addressesAgent("section:global:OCP Development/:ocp-build:tool:edit:whole", "ocp-build")).toBe(true)
  expect(addressesAgent("item:project:crew/:lab-reviewer:perm:grep:files.env", "lab-planner")).toBe(false)
  expect(addressesAgent("item:project:build:tool:edit", "build")).toBe(true)
  expect(addressesAgent("team:project:crew:lab-planner", "lab-planner")).toBe(true)
  expect(addressesAgent("agent:project:lab-planner", "lab-planner")).toBe(true)
  const table = tableFor(["instructions_set"], { "perm:instructions_set:targets.self": false })
  const decision = decide(table.toolRows("lab-planner", "instructions_set"), {
    tool: "instructions_set",
    input: { id: "item:project:crew/:lab-planner:perm:team_delegate:to.lab-reviewer", state: "on" },
    sessionID: "ses",
    directory: "/work",
    teamMembers: new Set(),
    agent: "lab-planner",
  })
  expect(decision.refuse).toContain("may not change its own rows")
})

test("session-aware edit permission isolates same-role runs and never upgrades allow/ask/deny", async () => {
  const tmp = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-scope-hooks-"))
  const prior = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = tmp
  try {
    const now = new Date().toISOString()
    for (const name of ["a", "b"]) {
      const run: RunRecord = { id: `w-${name}`, role: "maker", kind: "w", repo: "fixture", repoKey: "fixture", directory: `/workspace/${name}`, paths: [`src/${name}/*`], branch: name, base: "", head: "", state: "working", attempts: [], task: null, parent: "main-owned", children: [], briefSha: "", bundle: "fixture", budget: {}, createdAt: now, lastUsed: now, sessionID: `ses_${name}`, configDigest: null, history: [] }
      await saveRun(teamsDataDir(), run)
      await atomicJson(path.join(teamsDataDir(), "runs", run.id, "brief.json"), { scope: { paths: run.paths, forbidden: [`src/${name}/excluded.ts`] } })
    }
    const { recorded } = await installed(tableFor(["edit", "write", "patch"], {}, ["maker"]))
    const evaluate = recorded.evaluate
    if (evaluate === undefined) throw new Error("missing permission hook")
    for (const name of ["a", "b"]) {
      for (const effect of ["allow", "ask", "deny"]) {
        const event = { sessionID: `ses_${name}`, action: "edit", resources: [`/workspace/${name}/src/${name}/own.ts`], effect }
        await Effect.runPromise(evaluate(event))
        expect(event.effect).toBe(effect)
      }
      for (const resources of [
        [`/workspace/${name}/src/${name}/excluded.ts`],
        [`/workspace/${name}/src/${name === "a" ? "b" : "a"}/other.ts`],
        [`/workspace/${name}/.git/config`],
        [`/workspace/${name}/src/${name}/own.ts`, `/workspace/${name}/outside.ts`],
      ]) {
        const event = { sessionID: `ses_${name}`, action: "edit", resources, effect: "allow" }
        await Effect.runPromise(evaluate(event))
        expect(event.effect).toBe("deny")
      }
    }
    const ordinary = { sessionID: "ses_nonteam", action: "edit", resources: ["/workspace/ordinary.ts"], effect: "ask" }
    await Effect.runPromise(evaluate(ordinary))
    expect(ordinary.effect).toBe("ask")
  } finally {
    if (prior === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prior
    await fs.rm(tmp, { recursive: true, force: true })
  }
})

test("secrets are masked inside serialized config and diffs, and a key list is left alone", () => {
  const shown = {
    id: "item:defaults::mcp:search",
    text: '{"type":"remote","url":"https://x.test","headers":{"Authorization":"Bearer probe-value"},"apiKey":"probe-value"}',
    keywords: ["git push"],
  }
  const masked = maskSecrets(shown)
  const out = masked.value as typeof shown
  expect(out.text).not.toContain("probe-value")
  expect(out.text).toContain('"Authorization":"[masked]"')
  expect(out.keywords).toEqual(["git push"])
  const token = `ghp_${"a".repeat(24)}`
  const diff = maskSecrets({ mineDiff: `+  "GITHUB_TOKEN": "${token}"\n+  "url": "https://x.test"` }).value as { mineDiff: string }
  expect(diff.mineDiff).not.toContain(token)
  expect(diff.mineDiff).toContain("https://x.test")
})

test("an approval answers only its own permission action: a sibling Code Mode call cannot take it", async () => {
  const table = tableFor(["instructions_set", "team_delegate"], { "perm:instructions_set:approval.every": true })
  const { recorded, state } = await installed(table)
  // The execute call opens the key its inner calls share.
  await before(recorded, { tool: "execute", agent: "build", input: { code: "" } })
  expect((await before(recorded, { tool: "instructions_set", agent: "build", input: { id: "x", state: "on" } })).exit._tag).toBe("Success")
  // A sibling under another action is not asked, and does not consume the ask.
  const sibling = await evaluate(recorded, "team.delegate")
  expect(sibling.effect).toBe("allow")
  const own = await evaluate(recorded, "instructions")
  expect(own.effect).toBe("ask")
  expect(own.message).toContain("instructions_set")
  // Core re-evaluates the pending request after an "always" to something
  // else: the call still waits for its own answer.
  expect((await evaluate(recorded, "instructions")).effect).toBe("ask")
  // "Always" for this agent and tool stops the asking.
  state.always.add("build\u0000instructions_set")
  expect((await evaluate(recorded, "instructions")).effect).toBe("allow")
})

test("an always for one tool never covers a sibling of another tool under the same action", async () => {
  const table = tableFor(["instructions_set", "instructions_delete"], {
    "perm:instructions_set:approval.every": true,
    "perm:instructions_delete:approval.every": true,
  })
  const { recorded, state } = await installed(table)
  await before(recorded, { tool: "execute", agent: "build", input: { code: "" } })
  await before(recorded, { tool: "instructions_set", agent: "build", input: { id: "x" } })
  await before(recorded, { tool: "instructions_delete", agent: "build", input: { id: "y" } })
  state.always.add("build\u0000instructions_set")
  const asked = await evaluate(recorded, "instructions")
  expect(asked.effect).toBe("ask")
  expect(asked.message).toContain("instructions_delete")
})

test("an inner call that ends leaves its siblings' approvals alone; the execute call takes them", async () => {
  const table = tableFor(["instructions_set"], { "perm:instructions_set:approval.every": true })
  const { recorded, state } = await installed(table)
  await before(recorded, { tool: "execute", agent: "build", input: { code: "" } })
  await before(recorded, { tool: "instructions_set", agent: "build", input: { id: "x" } })
  const after = recorded.after
  if (after === undefined) throw new Error("execute.after not installed")
  // A sibling of the same tool ends (it may never have registered).
  await Effect.runPromise(after({ tool: "instructions_set", sessionID: "ses_hooks", agent: "build", messageID: "msg_1", id: "call_1", input: {}, status: "error", error: {} }))
  expect((await evaluate(recorded, "instructions")).effect).toBe("ask")
  await Effect.runPromise(after({ tool: "execute", sessionID: "ses_hooks", agent: "build", messageID: "msg_1", id: "call_1", input: {}, status: "error", error: {} }))
  expect(state.asks.size).toBe(0)
})

test("a row that is off refuses last, even with the pattern *, so no role allow reopens it", () => {
  const ordered = orderRules([
    { resource: "*", effect: "deny" as const, refusal: true },
    { resource: "*", effect: "deny" as const },
    { resource: "*docs/plans/*", effect: "allow" as const },
  ])
  expect(ordered.at(-1)).toEqual({ resource: "*", effect: "deny", refusal: true })
})

test("secrets inside a headers block of serialized config are masked whatever the header is called", () => {
  const shown = maskSecrets({ text: '{"url":"https://x.test","headers":{"X-Auth":"opaque-credential"}}' }).value as { text: string }
  expect(shown.text).not.toContain("opaque-credential")
  const diff = maskSecrets({ mineDiff: '+  "headers": { "X-Auth": "opaque-credential" },' }).value as { mineDiff: string }
  expect(diff.mineDiff).not.toContain("opaque-credential")
})

test("a delegated run, which nobody watches, is refused instead of asked", async () => {
  const table = tableFor(["instructions_set"], { "perm:instructions_set:approval.every": true })
  const { recorded } = await installed(table, enforcementState(), true)
  const result = await before(recorded, { tool: "instructions_set", agent: "build", input: { id: "x" } })
  expect(refusal(result.exit)).toContain("nobody watches a delegated run")
})

test("overlapping shell calls of one command all get the union of what any of them strips", () => {
  const state = enforcementState()
  const now = Date.now()
  state.shells.set("env", [
    { patterns: ["*_API_KEY"], at: now },
    { patterns: [], at: now },
  ])
  expect(takeShell(state, "env", now)).toEqual(["*_API_KEY"])
  expect(takeShell(state, "env", now)).toEqual(["*_API_KEY"])
  expect(takeShell(state, "env", now)).toEqual([])
  // A registration whose command never started expires after an hour.
  state.shells.set("ls", [{ patterns: ["*_TOKEN"], at: now - 61 * 60 * 1000 }])
  expect(takeShell(state, "ls", now)).toEqual([])
})

test("shell create.before strips the secret variables of the call that announced the command", async () => {
  const table = tableFor(["shell"], { "perm:shell:environment.secrets": false })
  const { recorded } = await installed(table)
  await before(recorded, { tool: "shell", agent: "build", input: { command: "printenv" } })
  const invocation = { command: "printenv", cwd: "/work", timeout: 1000, shell: "/bin/sh", env: { OPENAI_API_KEY: "x", PATH: "/bin", GH_TOKEN: "y" } as Record<string, string | undefined> }
  const hook = recorded.shell
  if (hook === undefined) throw new Error("shell create.before not installed")
  await Effect.runPromise(hook(invocation))
  expect(Object.keys(invocation.env).toSorted()).toEqual(["PATH"])
})

test("an off value is refused when the call leaves it to the tool's default", () => {
  const table = tableFor(["webfetch", "team_followup"], { "perm:webfetch:format.markdown": false, "perm:team_followup:delivery.queue": false })
  const call = (tool: string, input: unknown) =>
    decide(table.toolRows("build", tool), { tool, input, sessionID: "ses", directory: "/work", teamMembers: new Set() })
  expect(call("webfetch", { url: "https://x.test" }).refuse).toContain('format defaults to "markdown"')
  expect(call("webfetch", { url: "https://x.test", format: "text" }).refuse).toBeUndefined()
  expect(call("team_followup", { run: "w-1", requestID: "r", prompt: "p" }).refuse).toContain('delivery defaults to "queue"')
})

test("closing Where never reopens what Files it may change closed: no core allow is installed for an allow-list row", () => {
  // The Where and Files it may change rows are checked on the call, not installed as rules.
  const rows = catalogItems([toolRow("edit")], () => "edit").filter((item) => item.category === "where" || item.category === "allowed")
  expect(rows.every((item) => item.permKind === "input")).toBe(true)
  // A planner-preset member with Where closed: a path under an allowed
  // temporary directory passes Where, and its own Files it may change rows
  // still refuse it, because it is no plan file.
  const planner = linked("astra-planner", "planner")
  const table = presetTable({ members: [planner], records: [change(planner, "perm:edit:where.outside", { state: "off" })] })
  const edit = (file: string) =>
    decide(table.toolRows("astra-planner", "edit"), {
      tool: "edit",
      input: { path: file, oldString: "a", newString: "b" },
      sessionID: "ses",
      directory: "/work",
      teamMembers: new Set(),
    }).refuse
  expect(edit("/tmp/notes.md")).toBe("Permission denied: this file is not one you may change here; only the allowed files (Files it may change) are")
  expect(edit("/etc/hosts")).toContain("outside this checkout")
  expect(edit("docs/plans/p.md")).toBeUndefined()
})

test("siblings of one action are one question: it names every tool, and its always exempts none", async () => {
  const table = tableFor(["instructions_set", "instructions_delete"], {
    "perm:instructions_set:approval.every": true,
    "perm:instructions_delete:approval.every": true,
  })
  const { recorded, state } = await installed(table)
  await before(recorded, { tool: "execute", agent: "build", input: { code: "" } })
  await before(recorded, { tool: "instructions_set", agent: "build", input: { id: "x" } })
  await before(recorded, { tool: "instructions_delete", agent: "build", input: { id: "y" } })
  const asked = await evaluate(recorded, "instructions")
  expect(asked.effect).toBe("ask")
  expect(asked.message).toContain("instructions_set or instructions_delete")
  const raised = [...state.asks.values()].flat().find((entry) => entry.status === "raised")
  expect(raised?.ambiguous).toBe(true)
})

test("an MCP row's config is masked through and through, a diff hunk without its block heading included", () => {
  const diff = maskSecrets({
    id: "item:defaults::mcp:search",
    view: "diff",
    mineDiff: '@@ -3,2 +3,2 @@\n-    "FOO": "old-credential",\n+    "FOO": "new-credential",',
    summary: "mine differs by 2 lines, upstream by 0 lines",
  }).value as { mineDiff: string; summary: string; view: string }
  expect(diff.mineDiff).not.toContain("credential")
  expect(diff.summary).toBe("mine differs by 2 lines, upstream by 0 lines")
  expect(diff.view).toBe("diff")
  const text = maskSecrets({ id: "item:defaults::mcp:search", text: '{"type":"local","command":["bun","secret-arg"],"environment":{"FOO":"x"}}' }).value as { text: string }
  expect(JSON.parse(text.text)).toEqual({ type: "[masked]", command: ["[masked]", "[masked]"], environment: { FOO: "[masked]" } })
  // Any other row keeps its values but secrets.
  const other = maskSecrets({ id: "item:project:build:tool:shell", text: "run a command" }).value as { text: string }
  expect(other.text).toBe("run a command")
})

test("what an interrupted call leaves behind is swept once it is an hour old, but never a question still waiting for the human", () => {
  const state = enforcementState()
  const now = Date.now()
  const old = now - 2 * 60 * 60 * 1000
  for (let index = 0; index < 60; index++) {
    state.asks.set(`k${index}`, [{ agent: "a", tool: "t", action: "t", status: index % 2 === 0 ? "waiting" : "answered", at: old }])
    state.calls.set(`c${index}`, { count: 1, at: old })
  }
  state.asks.set("live", [{ agent: "a", tool: "t", action: "t", status: "waiting", at: now }])
  // A question asked overnight is still the human's to answer.
  state.asks.set("overnight", [{ agent: "a", tool: "t", action: "t", status: "raised", at: old }])
  sweep(state, now)
  expect([...state.asks.keys()].toSorted()).toEqual(["live", "overnight"])
  // An execute call's counter stays until that call ends.
  expect(state.calls.size).toBe(60)
})

test("a question shared by siblings stays shared after one of them is answered", async () => {
  const table = tableFor(["instructions_set", "instructions_delete"], {
    "perm:instructions_set:approval.every": true,
    "perm:instructions_delete:approval.every": true,
  })
  const { recorded, state } = await installed(table)
  await before(recorded, { tool: "execute", agent: "build", input: { code: "" } })
  await before(recorded, { tool: "instructions_set", agent: "build", input: { id: "x" } })
  await before(recorded, { tool: "instructions_delete", agent: "build", input: { id: "y" } })
  await evaluate(recorded, "instructions")
  for (const entry of state.asks.values()) for (const ask of entry) if (ask.status === "raised") ask.status = "answered"
  const second = await evaluate(recorded, "instructions")
  expect(second.message).toContain("instructions_set or instructions_delete")
  const raised = [...state.asks.values()].flat().find((entry) => entry.status === "raised")
  expect(raised?.ambiguous).toBe(true)
})

test("naming fields are kept only on the MCP row itself, never inside its headers", () => {
  const masked = maskSecrets({ id: "mcp:x", source: "project", config: { headers: { source: "credential" }, type: "remote" } }).value as {
    source: string
    config: { headers: { source: string }; type: string }
  }
  expect(masked.source).toBe("project")
  expect(masked.config.headers.source).toBe("[masked]")
  expect(masked.config.type).toBe("[masked]")
})
