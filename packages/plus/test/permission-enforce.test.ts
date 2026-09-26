// Enforcement of the per-tool permission rows core rules cannot express. Every
// decision here runs on rows the real catalog produces, resolved through the
// real permission table with explicit on/off states.
import { expect, test } from "bun:test"
import type { SessionContext } from "@opencode/plugin/effect/session"
import { Agent } from "@opencode/schema/agent"
import os from "node:os"
import path from "node:path"
import { fingerprint, type Item } from "../src/instructions/model.js"
import { catalogItems } from "../src/instructions/permission-catalog.js"
import {
  addressesAgent,
  decide,
  delegateTargets,
  filterGrep,
  grepHidden,
  isOutside,
  maskSecrets,
  narrowSchema,
  narrowTools,
  permissionTable,
  rowState,
  tableActive,
  tableNarrows,
  teamAllows,
  teamLimit,
  type Call,
  type PermRow,
} from "../src/instructions/permission-enforce.js"
import { policyMembersOf, teamPolicyItems } from "../src/instructions/team-policy-rows.js"
import { actionForToolId } from "../src/instructions/tool-permissions.js"
import { change, linked, presetTable, shippedMembers } from "./teams/preset-table.js"

function toolItem(tool: string): Item {
  return { id: `tool:${tool}`, kind: "tool", group: "native", title: tool, text: tool, enabled: true, fingerprint: fingerprint(tool) }
}

// Explicit states by rule id: `off` wins over `on`; `text` replaces a row's
// text (a limit row's number).
interface Changes {
  readonly off?: readonly string[]
  readonly on?: readonly string[]
  readonly text?: Readonly<Record<string, string>>
}

function tableOf(tools: readonly string[], changes: Changes = {}, extra: readonly Item[] = [], teamMembers: readonly string[] = []) {
  return permissionTable({
    items: [...catalogItems(tools.map(toolItem), actionForToolId), ...extra],
    teamMembers,
    resolve: (item) => {
      const id = item.ruleId ?? ""
      return {
        enabled: !(changes.off ?? []).includes(id) && ((changes.on ?? []).includes(id) || item.enabled),
        text: changes.text?.[id] ?? item.text,
      }
    },
  })
}

function rowsFor(tool: string, changes: Changes = {}, extra: readonly Item[] = []): readonly PermRow[] {
  return tableOf([tool], changes, extra).toolRows("alpha", tool)
}

function call(tool: string, input: unknown, extra: Partial<Call> = {}): Call {
  return { tool, input, sessionID: "ses_self", directory: "/repo", teamMembers: new Set<string>(), ...extra }
}

function messageOf(rows: readonly PermRow[], ruleId: string): string {
  const message = rows.find((row) => row.item.ruleId === ruleId)?.item.message
  if (message === undefined) throw new Error(`row ${ruleId} carries no message`)
  return `Permission denied: ${message}`
}

// An allow-list row a user adds to a category: while on, it lets its patterns
// through the category's closed fallback.
function allowRow(tool: string, category: string, id: string, field: string, patterns: readonly string[], enabled = true): Item {
  const text = [id, ...patterns].join("\n")
  return {
    id: `perm:${tool}:${category}.${id}`,
    kind: "perm",
    group: "none",
    title: id,
    text,
    enabled,
    fingerprint: fingerprint(text),
    permTool: tool,
    permAction: tool,
    ruleId: `${category}.${id}`,
    patterns: [...patterns],
    category,
    permKind: "input",
    field,
    allow: true,
  }
}

// ── input rows ──────────────────────────────────────────────────────────────

test("grep refuses a path a Files row turned off matches, and searches it while the row is on", () => {
  const off = rowsFor("grep", { off: ["files.env"] })
  for (const file of [".env", "src/.env", "config/.env.local", "/repo/.env"]) {
    const refusal = decide(off, call("grep", { pattern: "KEY", path: file })).refuse
    expect([file, refusal?.startsWith("Permission denied: ")]).toEqual([file, true])
    expect(refusal).toContain(".env files")
  }
  expect(decide(off, call("grep", { pattern: "KEY", path: "src/index.ts" }))).toEqual({})
  const on = rowsFor("grep")
  expect(decide(on, call("grep", { pattern: "KEY", path: ".env" }))).toEqual({})
})

const grepMatches = [
  { entry: { path: "src/a.ts" }, line: 1, text: "const a = 1" },
  { entry: { path: ".env" }, line: 2, text: "OPENAI_API_KEY=sk-live" },
  { entry: { path: "src/a.ts" }, line: 5, text: "export { a }" },
  { entry: { path: "config/.env.local" }, line: 1, text: "TOKEN=x" },
  { entry: { path: "src/b.ts" }, line: 3, text: "import { a } from './a'" },
]

test("grep results drop matches in hidden files and keep core's text format", () => {
  const filtered = filterGrep(grepMatches, grepHidden(rowsFor("grep", { off: ["files.env"] })), { directory: "/work" })
  expect(filtered?.output).toEqual([grepMatches[0], grepMatches[2], grepMatches[4]])
  // core/src/tool/plugin/grep.ts toModelContent: a count line, then each file
  // (absolute, as core shows it) with its lines, files separated by a blank line.
  expect(filtered?.text).toBe(
    ["Found 3 matches", "/work/src/a.ts:", "  Line 1: const a = 1", "  Line 5: export { a }", "", "/work/src/b.ts:", "  Line 3: import { a } from './a'"].join("\n"),
  )
  // A search core cut at its limit still says so after filtering.
  expect(filterGrep(grepMatches, grepHidden(rowsFor("grep", { off: ["files.env"] })), { directory: "/work", truncated: true })?.text).toEndWith(
    "\n\n(Results are truncated: showing first 3 results. Consider using a more specific path or pattern.)",
  )
  // Nothing hidden leaves the result alone, and a non-list result is not grep's.
  expect(filterGrep(grepMatches, grepHidden(rowsFor("grep")))).toBeUndefined()
  expect(filterGrep("not a list", () => true)).toBeUndefined()
  // Everything hidden reads like an empty search.
  expect(filterGrep(grepMatches.slice(1, 2), grepHidden(rowsFor("grep", { off: ["files.env"] })))).toEqual({ output: [], text: "No matches found" })
})

test("a closed Files fallback keeps only allow-listed files, and a deny-list row still wins inside them", () => {
  const source = allowRow("grep", "files", "source", "path", ["src/*"])
  const closed = rowsFor("grep", { off: ["files.*"] }, [source])
  const hidden = grepHidden(closed)
  expect(["src/a.ts", "src/.env", "docs/readme.md", ".env"].filter(hidden)).toEqual(["docs/readme.md", ".env"])
  expect(filterGrep(grepMatches, hidden)?.output).toEqual([grepMatches[0], grepMatches[2], grepMatches[4]])
  expect(decide(closed, call("grep", { pattern: "x", path: "src/a.ts" }))).toEqual({})
  expect(decide(closed, call("grep", { pattern: "x", path: "docs/readme.md" })).refuse).toBe(messageOf(closed, "files.*"))

  const denied = rowsFor("grep", { off: ["files.*", "files.env"] }, [source])
  expect(["src/a.ts", "src/.env"].filter(grepHidden(denied))).toEqual(["src/.env"])
  expect(decide(denied, call("grep", { pattern: "x", path: "src/.env" })).refuse).toContain(".env files")

  // An allow-list row that is off opens nothing.
  const shut = rowsFor("grep", { off: ["files.*"] }, [allowRow("grep", "files", "source", "path", ["src/*"], false)])
  expect(["src/a.ts", "docs/readme.md"].filter(grepHidden(shut))).toEqual(["src/a.ts", "docs/readme.md"])
})

test("an input category with a closed fallback lets through only its allow rows, and a deny row beats an allow row", () => {
  const docs = allowRow("browser_navigate", "sites", "docs", "url", ["*://docs.example.com*"])
  const rows = rowsFor("browser_navigate", { off: ["sites.*", "sites.http"] }, [docs])
  expect(decide(rows, call("browser_navigate", { tabID: "tab_1", url: "https://docs.example.com/guide" }))).toEqual({})
  expect(decide(rows, call("browser_navigate", { tabID: "tab_1", url: "https://example.org/" })).refuse).toBe(messageOf(rows, "sites.*"))
  // Plain HTTP is off: it refuses even the allow-listed host.
  const http = decide(rows, call("browser_navigate", { tabID: "tab_1", url: "http://docs.example.com/guide" })).refuse
  expect(http).toContain("Plain HTTP")
  expect(http).not.toBe(messageOf(rows, "sites.*"))

  // An open fallback leaves allow rows moot; a deny row that is off still refuses.
  const open = rowsFor("browser_navigate", { off: ["sites.localhost"] })
  expect(decide(open, call("browser_navigate", { tabID: "tab_1", url: "https://example.org/" }))).toEqual({})
  expect(decide(open, call("browser_navigate", { tabID: "tab_1", url: "http://localhost:4096/api" })).refuse).toContain("Localhost")

  // Every value of an array field is checked.
  const extract = rowsFor("search_tavily_extract", { off: ["sites.*"] }, [allowRow("search_tavily_extract", "sites", "docs", "urls[]", ["https://docs.example.com*"])])
  expect(decide(extract, call("search_tavily_extract", { urls: ["https://docs.example.com/a", "https://docs.example.com/b"] }))).toEqual({})
  expect(decide(extract, call("search_tavily_extract", { urls: ["https://docs.example.com/a", "https://evil.example/x"] })).refuse).toBe(
    messageOf(extract, "sites.*"),
  )
})

// ── value and param rows ───────────────────────────────────────────────────

test("a value row that is off refuses its literal and nothing else", () => {
  const rows = rowsFor("webfetch", { off: ["format.html"] })
  const refusal = decide(rows, call("webfetch", { url: "https://example.org", format: "html" })).refuse
  expect(refusal).toStartWith("Permission denied: ")
  expect(refusal).toContain(`format "html"`)
  expect(decide(rows, call("webfetch", { url: "https://example.org", format: "markdown" }))).toEqual({})
  expect(decide(rows, call("webfetch", { url: "https://example.org" }))).toEqual({})
})

test("a param row that is off refuses a call that uses the parameter", () => {
  const glob = rowsFor("glob", { off: ["parameters.hidden"] })
  expect(decide(glob, call("glob", { pattern: "*", hidden: true })).refuse).toStartWith("Permission denied: ")
  expect(decide(glob, call("glob", { pattern: "*", hidden: false }))).toEqual({})
  expect(decide(glob, call("glob", { pattern: "*" }))).toEqual({})

  const shell = rowsFor("shell", { off: ["parameters.no-timeout"] })
  expect(decide(shell, call("shell", { command: "sleep 1", timeout: 0 })).refuse).toContain("timeout: 0")
  expect(decide(shell, call("shell", { command: "sleep 1", timeout: 5000 }))).toEqual({})
  expect(decide(shell, call("shell", { command: "sleep 1" }))).toEqual({})

  const release = rowsFor("release_request", { off: ["parameters.no-approval"] })
  expect(decide(release, call("release_request", { requestID: "r-1", kind: "build", approvalRef: null })).refuse).toContain("approvalRef: null")
  expect(decide(release, call("release_request", { requestID: "r-1", kind: "build", approvalRef: "APR-7" }))).toEqual({})

  const question = rowsFor("question", { off: ["parameters.multiple"] })
  expect(
    decide(question, call("question", { questions: [{ question: "a?", multiple: false }, { question: "b?", multiple: true }] })).refuse,
  ).toContain("multiple: true")
  expect(decide(question, call("question", { questions: [{ question: "a?", multiple: false }, { question: "b?" }] })).refuse).toBeUndefined()

  // "Other sessions": naming another session refuses, naming its own or none does not.
  const move = rowsFor("opencode_session_move", { off: ["sessions.other"] })
  expect(decide(move, call("opencode_session_move", { sessionID: "ses_other", directory: "sub" })).refuse).toBe(messageOf(move, "sessions.other"))
  expect(decide(move, call("opencode_session_move", { sessionID: "ses_self", directory: "sub" }))).toEqual({})
  expect(decide(move, call("opencode_session_move", { directory: "sub" }))).toEqual({})
  const rename = rowsFor("opencode_session_rename", { off: ["sessions.other"] })
  expect(decide(rename, call("opencode_session_rename", { sessionID: "ses_other", title: "x" })).refuse).toBe(messageOf(rename, "sessions.other"))
  expect(decide(rename, call("opencode_session_rename", { title: "x" }))).toEqual({})
})

// ── limit rows ─────────────────────────────────────────────────────────────

test("a clamp limit that is on lowers a larger value to the cap and leaves smaller ones", () => {
  const rows = rowsFor("read", { on: ["limits.lines"], text: { "limits.lines": "500" } })
  const input = { path: "src/a.ts", limit: 2000 }
  expect(decide(rows, call("read", input))).toEqual({ input: { path: "src/a.ts", limit: 500 } })
  expect(input).toEqual({ path: "src/a.ts", limit: 2000 })
  expect(decide(rows, call("read", { path: "src/a.ts", limit: 500 }))).toEqual({})
  expect(decide(rows, call("read", { path: "src/a.ts", limit: 100 }))).toEqual({})
  // Off: no cap at all.
  expect(decide(rowsFor("read"), call("read", { path: "src/a.ts", limit: 2000 }))).toEqual({})
})

test("an omitted field takes the cap only when the row's value (the tool default) is higher", () => {
  const shipped = catalogItems([toolItem("read")], actionForToolId).find((item) => item.id === "perm:read:limits.lines")
  if (shipped === undefined) throw new Error("missing perm:read:limits.lines")
  const capped = (toolDefault: number): PermRow[] => [{ item: { ...shipped, value: toolDefault }, on: true, text: "500" }]
  expect(decide(capped(2000), call("read", { path: "src/a.ts" }))).toEqual({ input: { path: "src/a.ts", limit: 500 } })
  expect(decide(capped(500), call("read", { path: "src/a.ts" }))).toEqual({})
  expect(decide(capped(100), call("read", { path: "src/a.ts" }))).toEqual({})
})

// core's read returns up to 2000 lines when `limit` is omitted
// (core/src/tool/plugin/read.ts), so a cap of 500 must hold for that call too.
test("the shipped Lines per read cap holds for a read that relies on core's 2000-line default", () => {
  const rows = rowsFor("read", { on: ["limits.lines"], text: { "limits.lines": "500" } })
  expect(decide(rows, call("read", { path: "src/a.ts" }))).toEqual({ input: { path: "src/a.ts", limit: 500 } })
})

test("a refuse limit refuses by length and by count", () => {
  const write = rowsFor("write", { on: ["limits.size"], text: { "limits.size": "10" } })
  const long = decide(write, call("write", { path: "a.txt", content: "12345678901" })).refuse
  expect(long).toStartWith("Permission denied: ")
  expect(long).toContain("10")
  expect(long).toContain("11")
  expect(decide(write, call("write", { path: "a.txt", content: "1234567890" }))).toEqual({})

  // A patch counts its file headers.
  const patch = rowsFor("patch", { on: ["limits.files"], text: { "limits.files": "2" } })
  const three = ["*** Begin Patch", "*** Add File: a.ts", "+a", "*** Update File: b.ts", "@@", "-b", "+c", "*** Delete File: c.ts", "*** End Patch"].join("\n")
  const two = ["*** Begin Patch", "*** Add File: a.ts", "+a", "*** Update File: b.ts", "@@", "-b", "+c", "*** End Patch"].join("\n")
  const refused = decide(patch, call("patch", { patchText: three })).refuse
  expect(refused).toContain("2")
  expect(refused).toContain("3")
  expect(decide(patch, call("patch", { patchText: two }))).toEqual({})

  // An array field counts its entries.
  const upload = rowsFor("browser_files_upload", { on: ["limits.files"], text: { "limits.files": "2" } })
  expect(decide(upload, call("browser_files_upload", { tabID: "tab_1", paths: ["a.txt", "b.txt", "c.txt"] })).refuse).toContain("3")
  expect(decide(upload, call("browser_files_upload", { tabID: "tab_1", paths: ["a.txt", "b.txt"] }))).toEqual({})
  const question = rowsFor("question", { on: ["limits.questions", "when.delegated"], text: { "limits.questions": "1" } })
  expect(decide(question, call("question", { questions: [{ question: "a?" }, { question: "b?" }] })).refuse).toContain("2")
  expect(decide(question, call("question", { questions: [{ question: "a?" }] }))).toEqual({})

  // Code Mode's inner-call cap is counted by the hooks, never by one decision.
  const execute = rowsFor("execute", { on: ["limits.calls"], text: { "limits.calls": "1" } })
  expect(decide(execute, call("execute", { code: "await tools.a(); await tools.b()" }))).toEqual({})
})

// ── approval and env rows ─────────────────────────────────────────────────

test("approval asks, a question in a delegated run is refused there, and env rows strip variables", () => {
  const approval = decide(rowsFor("webfetch", { on: ["approval.every"] }), call("webfetch", { url: "https://example.org" }))
  expect(approval.refuse).toBeUndefined()
  // The decision names the permission action core checks the call under;
  // the hook asks at exactly that check.
  expect(approval.approval).toBe("webfetch")
  expect(decide(rowsFor("webfetch"), call("webfetch", { url: "https://example.org" }))).toEqual({})

  // "In delegated team runs" ships off: the call is refused only where nobody watches.
  const shipped = rowsFor("question")
  expect(decide(shipped, call("question", { questions: [{ question: "a?" }] }))).toEqual({ headlessRefusal: messageOf(shipped, "when.delegated") })
  expect(decide(rowsFor("question", { on: ["when.delegated"] }), call("question", { questions: [{ question: "a?" }] }))).toEqual({})

  const stripped = rowsFor("shell", { off: ["environment.secrets"] })
  const patterns = stripped.find((row) => row.item.ruleId === "environment.secrets")?.item.patterns
  expect(patterns).toContain("*_API_KEY")
  expect(decide(stripped, call("shell", { command: "bun test" }))).toEqual({ stripEnv: patterns })
  expect(decide(rowsFor("shell"), call("shell", { command: "bun test" }))).toEqual({})
})

// ── operation rows ─────────────────────────────────────────────────────────

test("write tells creating from overwriting through the exists check on the resolved path", () => {
  const asked: string[] = []
  const exists = (file: string) => {
    asked.push(file)
    return file === "/repo/src/present.ts"
  }
  const noCreate = rowsFor("write", { off: ["operations.create"] })
  expect(decide(noCreate, call("write", { path: "src/new.ts", content: "x" }, { exists })).refuse).toBe(messageOf(noCreate, "operations.create"))
  expect(decide(noCreate, call("write", { path: "src/present.ts", content: "x" }, { exists }))).toEqual({})
  const noOverwrite = rowsFor("write", { off: ["operations.overwrite"] })
  expect(decide(noOverwrite, call("write", { path: "/repo/src/present.ts", content: "x" }, { exists })).refuse).toBe(
    messageOf(noOverwrite, "operations.overwrite"),
  )
  expect(decide(noOverwrite, call("write", { path: "src/new.ts", content: "x" }, { exists }))).toEqual({})
  expect(decide(noOverwrite, call("write", { path: "~/notes.md", content: "x" }, { exists }))).toEqual({})
  expect(asked).toEqual(["/repo/src/new.ts", "/repo/src/present.ts", "/repo/src/present.ts", "/repo/src/new.ts", path.join(os.homedir(), "notes.md")])
})

test("patch refuses the operations that are off and nothing else", () => {
  const add = ["*** Begin Patch", "*** Add File: a.ts", "+a", "*** End Patch"].join("\n")
  const remove = ["*** Begin Patch", "*** Delete File: b.ts", "*** End Patch"].join("\n")
  const move = ["*** Begin Patch", "*** Update File: c.ts", "*** Move to: d.ts", "@@", "-c", "+d", "*** End Patch"].join("\n")
  const update = ["*** Begin Patch", "*** Update File: c.ts", "@@", "-c", "+d", "*** End Patch"].join("\n")
  const rows = rowsFor("patch", { off: ["operations.add", "operations.delete", "operations.move"] })
  expect(decide(rows, call("patch", { patchText: add })).refuse).toBe(messageOf(rows, "operations.add"))
  expect(decide(rows, call("patch", { patchText: remove })).refuse).toBe(messageOf(rows, "operations.delete"))
  expect(decide(rows, call("patch", { patchText: move })).refuse).toBe(messageOf(rows, "operations.move"))
  expect(decide(rows, call("patch", { patchText: update }))).toEqual({})
  const onlyDelete = rowsFor("patch", { off: ["operations.delete"] })
  expect(decide(onlyDelete, call("patch", { patchText: add }))).toEqual({})
  expect(decide(onlyDelete, call("patch", { patchText: move }))).toEqual({})
  expect(decide(onlyDelete, call("patch", { patchText: remove })).refuse).toBe(messageOf(onlyDelete, "operations.delete"))
})

test("the subagent team-members row refuses a team member id only", () => {
  const rows = rowsFor("subagent")
  const members = new Set(["ocp-deepseek-implementer"])
  const input = (agent: string) => ({ agent, description: "work", prompt: "do the work" })
  expect(decide(rows, call("subagent", input("ocp-deepseek-implementer"), { teamMembers: members })).refuse).toBe(messageOf(rows, "team-members.team-members"))
  expect(decide(rows, call("subagent", input("explore"), { teamMembers: members }))).toEqual({})
  expect(decide(rowsFor("subagent", { on: ["team-members.team-members"] }), call("subagent", input("ocp-deepseek-implementer"), { teamMembers: members }))).toEqual({})
})

// ── instructions targets ───────────────────────────────────────────────────

test("addressesAgent reads the owner of item, section, agent and team ids", () => {
  expect(addressesAgent("item:project:alpha:perm:shell:git-push", "alpha")).toBe(true)
  expect(addressesAgent("item:global:alpha:tool:read", "alpha")).toBe(true)
  expect(addressesAgent("section:project:alpha:tool:read:whole", "alpha")).toBe(true)
  expect(addressesAgent("item:project:crew/alpha:tool:read", "crew/alpha")).toBe(true)
  expect(addressesAgent("agent:project:alpha", "alpha")).toBe(true)
  expect(addressesAgent("team:project:OCP Development:ocp-build", "ocp-build")).toBe(true)
  // Other owners, the shared inventory and the team itself are not the agent.
  expect(addressesAgent("item:project:beta:perm:shell:git-push", "alpha")).toBe(false)
  expect(addressesAgent("item:project:alpha-two:tool:read", "alpha")).toBe(false)
  expect(addressesAgent("item:defaults::tool:read", "alpha")).toBe(false)
  expect(addressesAgent("agent:project:alpha-two", "alpha")).toBe(false)
  expect(addressesAgent("team:project:OCP Development", "ocp-build")).toBe(false)
  expect(addressesAgent("item:project:alpha:tool:read", "")).toBe(false)
})

// A member's rows in the Teams catalogue carry the `<team>/:<member>` owner
// path (instructions/tree.ts rowIdOf), so they address the member too.
test("addressesAgent reads a Teams-catalogue member path as the member", () => {
  expect(addressesAgent("item:defaults:OCP Development/:ocp-build:perm:shell:git-push", "ocp-build")).toBe(true)
  expect(addressesAgent("section:project:OCP Development/:ocp-build:tool:read:whole", "ocp-build")).toBe(true)
  expect(addressesAgent("item:defaults:OCP Development/:ocp-build:perm:shell:git-push", "ocp-opus-planner")).toBe(false)
})

test("the self row refuses a change to the caller's own rows and lets other rows through", () => {
  const rows = rowsFor("instructions_set", { off: ["targets.self"] })
  const refusal = messageOf(rows, "targets.self")
  const change = (id: string) => decide(rows, call("instructions_set", { id, state: "on" }, { agent: "alpha" })).refuse
  expect(change("item:project:alpha:perm:shell:git-push")).toBe(refusal)
  expect(change("section:project:alpha:tool:read:whole")).toBe(refusal)
  expect(change("agent:project:alpha")).toBe(refusal)
  expect(change("team:project:Crew:alpha")).toBe(refusal)
  expect(change("item:project:beta:perm:shell:git-push")).toBeUndefined()
  // Its own rows are open again while the self row is on.
  expect(decide(rowsFor("instructions_set"), call("instructions_set", { id: "item:project:alpha:perm:shell:git-push", state: "on" }, { agent: "alpha" }))).toEqual({})
  // The pattern rows refuse by id for any caller.
  const perms = rowsFor("instructions_set", { off: ["targets.permissions", "targets.global"] })
  expect(decide(perms, call("instructions_set", { id: "item:project:beta:perm:shell:git-push", state: "on" }, { agent: "alpha" })).refuse).toBe(
    messageOf(perms, "targets.permissions"),
  )
  expect(decide(perms, call("instructions_set", { id: "item:global:beta:tool:read", text: "x" }, { agent: "alpha" })).refuse).toBe(
    messageOf(perms, "targets.global"),
  )
  expect(decide(perms, call("instructions_set", { id: "item:project:beta:tool:read", text: "x" }, { agent: "alpha" }))).toEqual({})
})

test("the self row also guards the caller's rows in the Teams catalogue", () => {
  const rows = rowsFor("instructions_set", { off: ["targets.self"] })
  expect(
    decide(rows, call("instructions_set", { id: "item:defaults:OCP Development/:ocp-build:perm:shell:git-push", state: "on" }, { agent: "ocp-build" })).refuse,
  ).toBe(messageOf(rows, "targets.self"))
})

test("isOutside resolves relative, absolute, home and parent paths against the checkout", () => {
  expect(isOutside("src/a.ts", "/repo")).toBe(false)
  expect(isOutside(".", "/repo")).toBe(false)
  expect(isOutside("a/../b", "/repo")).toBe(false)
  expect(isOutside("/repo", "/repo")).toBe(false)
  expect(isOutside("/repo/src/a.ts", "/repo")).toBe(false)
  expect(isOutside("..foo", "/repo")).toBe(false)
  expect(isOutside("/etc/passwd", "/repo")).toBe(true)
  expect(isOutside("/repository/a.ts", "/repo")).toBe(true)
  expect(isOutside("..", "/repo")).toBe(true)
  expect(isOutside("../other", "/repo")).toBe(true)
  expect(isOutside("a/../../b", "/repo")).toBe(true)
  expect(isOutside("~", "/repo")).toBe(true)
  expect(isOutside("~/notes.md", "/repo")).toBe(true)
  expect(isOutside("~/notes.md", os.homedir())).toBe(false)
})

// ── schema narrowing ───────────────────────────────────────────────────────

// A tool's input schema as the session context hook receives it.
type Json = Record<string, unknown>

test("narrowSchema drops literals, parameters and their required entries, and sets numeric bounds", () => {
  const webfetch: Json = {
    type: "object",
    properties: {
      url: { type: "string" },
      format: { anyOf: [{ type: "string", enum: ["markdown", "text", "html"] }, { type: "null" }] },
      timeout: { type: "number" },
    },
    required: ["url"],
    additionalProperties: false,
  }
  expect(narrowSchema(webfetch, rowsFor("webfetch", { off: ["format.html"], on: ["limits.timeout"], text: { "limits.timeout": "20" } }))).toBe(true)
  expect(webfetch).toEqual({
    type: "object",
    properties: {
      url: { type: "string" },
      format: { anyOf: [{ type: "string", enum: ["markdown", "text"] }, { type: "null" }] },
      timeout: { type: "number", maximum: 20 },
    },
    required: ["url"],
    additionalProperties: false,
  })

  const search: Json = {
    type: "object",
    properties: {
      query: { type: "string" },
      type: { anyOf: [{ const: "fast" }, { const: "auto" }, { const: "neural" }, { type: "string", enum: ["keyword"] }] },
      depth: { type: "string", enum: ["fast", "neural"] },
    },
    required: ["query"],
  }
  expect(narrowSchema(search, rowsFor("search_exa_code_search", { off: ["types.neural", "types.keyword"] }))).toBe(true)
  expect(search).toEqual({
    type: "object",
    properties: {
      query: { type: "string" },
      type: { anyOf: [{ const: "fast" }, { const: "auto" }] },
      // Only the row's own field narrows.
      depth: { type: "string", enum: ["fast", "neural"] },
    },
    required: ["query"],
  })

  // Strict providers list every property as required.
  const shell: Json = {
    type: "object",
    properties: {
      command: { type: "string" },
      workdir: { anyOf: [{ type: "string" }, { type: "null" }] },
      timeout: { type: "integer", minimum: 0 },
      background: { anyOf: [{ type: "boolean" }, { type: "null" }] },
    },
    required: ["command", "workdir", "timeout", "background"],
    additionalProperties: false,
  }
  const shellRows = rowsFor("shell", {
    off: ["parameters.background", "parameters.workdir", "parameters.no-timeout"],
    on: ["limits.timeout"],
    text: { "limits.timeout": "300000" },
  })
  expect(narrowSchema(shell, shellRows)).toBe(true)
  expect(shell).toEqual({
    type: "object",
    properties: { command: { type: "string" }, timeout: { type: "integer", minimum: 1, maximum: 300000 } },
    required: ["command", "timeout"],
    additionalProperties: false,
  })

  const question: Json = {
    type: "object",
    properties: {
      questions: {
        type: "array",
        items: {
          type: "object",
          properties: { question: { type: "string" }, multiple: { anyOf: [{ type: "boolean" }, { type: "null" }] } },
          required: ["question", "multiple"],
        },
      },
    },
    required: ["questions"],
  }
  expect(narrowSchema(question, rowsFor("question", { off: ["parameters.multiple"] }))).toBe(true)
  expect(question).toEqual({
    type: "object",
    properties: {
      questions: { type: "array", items: { type: "object", properties: { question: { type: "string" } }, required: ["question"] } },
    },
    required: ["questions"],
  })
})

test("narrowSchema leaves a schema alone when nothing narrows it", () => {
  const shell = { type: "object", properties: { command: { type: "string" }, timeout: { type: "integer", minimum: 0 } }, required: ["command"] }
  const pristine = structuredClone(shell)
  expect(narrowSchema(shell, rowsFor("shell"))).toBe(false)
  expect(shell).toEqual(pristine)
  // "Other sessions" is refused per call: the parameter stays for the session's own id.
  const move = { type: "object", properties: { sessionID: { type: "string" }, directory: { type: "string" } }, required: ["directory"] }
  const kept = structuredClone(move)
  expect(narrowSchema(move, rowsFor("opencode_session_move", { off: ["sessions.other"] }))).toBe(false)
  expect(move).toEqual(kept)
})

test("narrowTools lists exactly the open members in team_delegate's role and never changes the schema it was given", () => {
  // The shipped team, each member resolved through its member preset, with
  // the orchestrator's hidden-files parameter turned off.
  const members = shippedMembers()
  const orchestratorMember = members.find((member) => member.id === "sol-orchestrator")
  if (orchestratorMember === undefined) throw new Error("no sol-orchestrator")
  const table = presetTable({ members, records: [change(orchestratorMember, "perm:glob:parameters.hidden", { state: "off" })] })
  // Core hands every request the same schema objects.
  const delegate = { type: "object", properties: { role: { type: "string" }, objective: { type: "string" } }, required: ["role", "objective"] }
  const glob = { type: "object", properties: { pattern: { type: "string" }, hidden: { type: "boolean" } }, required: ["pattern"] }
  const read = { type: "object", properties: { path: { type: "string" } }, required: ["path"] }
  const pristine = structuredClone({ delegate, glob, read })
  const request = (agent: string): Pick<SessionContext, "agent" | "tools"> => ({
    agent: Agent.ID.make(agent),
    tools: {
      team_delegate: { description: "Delegate a task.", input: delegate },
      glob: { description: "Find files.", input: glob },
      read: { description: "Read a file.", input: read },
    },
  })

  const orchestrator = request("sol-orchestrator")
  narrowTools(orchestrator, table)
  const open = ["astra-reviewer", "gemini-implementer", "muse-implementer", "opus-implementer", "opus-orchestrator", "scout", "spark-implementer"]
  expect(orchestrator.tools.team_delegate?.input).toEqual({
    type: "object",
    properties: { role: { type: "string", enum: open }, objective: { type: "string" } },
    required: ["role", "objective"],
  })
  expect(orchestrator.tools.team_delegate?.description).toBe(`Delegate a task.\nMembers you may delegate to: ${open.join(", ")}.`)
  expect(orchestrator.tools.glob?.input).toEqual({ type: "object", properties: { pattern: { type: "string" } }, required: ["pattern"] })

  const implementer = request("muse-implementer")
  narrowTools(implementer, table)
  expect(implementer.tools.team_delegate?.input).toEqual(pristine.delegate)
  expect(implementer.tools.team_delegate?.description).toBe("Delegate a task.\nNo member of your team is open to you for delegation.")
  // A tool none of whose rows narrows keeps the very object it came with.
  expect(implementer.tools.glob?.input).toBe(glob)

  // An agent with no "Delegate to" rows is told nothing about members.
  const outsider = request("build")
  narrowTools(outsider, table)
  expect(outsider.tools.team_delegate?.input).toBe(delegate)
  expect(outsider.tools.team_delegate?.description).toBe("Delegate a task.")

  expect({ delegate, glob, read }).toEqual(pristine)
})

test("delegateTargets lists the on members, sorted, never the other-teams row", () => {
  const members = [...shippedMembers(), linked("ocp-build", "build-seat")]
  const seat = members.find((member) => member.id === "ocp-build")
  if (seat === undefined) throw new Error("no build seat")
  const table = presetTable({ members, records: [change(seat, "perm:team_delegate:to.other-teams", { state: "on" })] })
  expect(delegateTargets(table.toolRows("ocp-build", "team_delegate"))).toEqual(members.map((member) => member.id).filter((id) => id !== "ocp-build").toSorted())
  expect(delegateTargets(table.toolRows("astra-planner", "team_delegate"))).toEqual(["opus-orchestrator", "sol-orchestrator"])
  expect(delegateTargets(table.toolRows("astra-reviewer", "team_delegate"))).toEqual([])
})

// ── result masking ─────────────────────────────────────────────────────────

test("maskSecrets masks secret keys and everything in headers and environments, and nothing else", () => {
  const row = {
    id: "agent:project:alpha",
    keywords: ["token", "apiKey", "password"],
    config: {
      url: "https://mcp.example.org",
      apiKey: "sk-live-1",
      token: "t-1",
      password: "p-1",
      key: "k-1",
      client_secret: "c-1",
      count: 3,
      enabled: true,
      headers: { Authorization: "Bearer x", "X-Trace": "y" },
      environment: { FOO: "bar", LIST: ["a", "b"] },
      env: { HOME: "/home/x" },
      command: ["bun", "run", "server.ts"],
      token_info: { issued: "today" },
    },
  }
  const pristine = structuredClone(row)
  const masked = maskSecrets(row)
  expect(masked.value).toEqual({
    id: "agent:project:alpha",
    keywords: ["token", "apiKey", "password"],
    config: {
      url: "https://mcp.example.org",
      apiKey: "[masked]",
      token: "[masked]",
      password: "[masked]",
      key: "[masked]",
      client_secret: "[masked]",
      count: 3,
      enabled: true,
      headers: { Authorization: "[masked]", "X-Trace": "[masked]" },
      environment: { FOO: "[masked]", LIST: ["[masked]", "[masked]"] },
      env: { HOME: "[masked]" },
      command: ["bun", "run", "server.ts"],
      token_info: { issued: "today" },
    },
  })
  expect(masked.masked).toBe(11)
  expect(row).toEqual(pristine)
  expect(maskSecrets([{ API_KEY: "x" }, "plain"])).toEqual({ value: [{ API_KEY: "[masked]" }, "plain"], masked: 1 })
  expect(maskSecrets("plain")).toEqual({ value: "plain", masked: 0 })
  expect(maskSecrets(null)).toEqual({ value: null, masked: 0 })

  // An MCP server row is config through and through: every string it carries
  // is masked, numbers and booleans and its naming fields stay.
  const server = maskSecrets({ ...structuredClone(row), id: "mcp:search" }).value as { id: string; keywords: string[]; config: Record<string, unknown> }
  expect(server.id).toBe("mcp:search")
  expect(server.keywords).toEqual(["token", "apiKey", "password"])
  expect(server.config).toEqual({
    url: "[masked]",
    apiKey: "[masked]",
    token: "[masked]",
    password: "[masked]",
    key: "[masked]",
    client_secret: "[masked]",
    count: 3,
    enabled: true,
    headers: { Authorization: "[masked]", "X-Trace": "[masked]" },
    environment: { FOO: "[masked]", LIST: ["[masked]", "[masked]"] },
    env: { HOME: "[masked]" },
    command: ["[masked]", "[masked]", "[masked]"],
    token_info: { issued: "[masked]" },
  })
})

// ── tables ─────────────────────────────────────────────────────────────────

test("tableActive installs the hooks only while some row refuses, clamps, asks or strips", () => {
  const active = (tools: readonly string[], changes: Changes = {}, extra: readonly Item[] = [], members: readonly string[] = []) =>
    tableActive(tableOf(tools, changes, extra, members), ["alpha"])
  const natives = ["read", "glob", "grep", "edit", "write", "patch", "shell", "webfetch", "subagent", "question"]
  expect(active(natives)).toBe(false)
  // The team-only rows matter once a team is enabled.
  expect(active(["subagent"], {}, [], ["ocp-build"])).toBe(true)
  expect(active(["question"], {}, [], ["ocp-build"])).toBe(true)
  expect(active(["read"], { on: ["limits.lines"] })).toBe(true)
  expect(active(["webfetch"], { on: ["approval.every"] })).toBe(true)
  expect(active(["shell"], { off: ["environment.secrets"] })).toBe(true)
  expect(active(["glob"], { off: ["parameters.hidden"] })).toBe(true)
  expect(active(["webfetch"], { off: ["format.html"] })).toBe(true)
  expect(active(["grep"], { off: ["files.env"] })).toBe(true)
  // An allow-list row that is off, and team rows, refuse nothing through a hook.
  expect(active(["grep"], {}, [allowRow("grep", "files", "source", "path", ["src/*"], false)])).toBe(false)
  expect(active(["team_delegate"], { off: ["limits.inflight", "access.delegated"] })).toBe(false)
  expect(active(["team_get_context"], { on: ["accepts.reason", "limits.paths"], off: ["bootstrap.chat"] })).toBe(false)
  // Only the agents asked about count: a member whose grep secret rows are off.
  const member = permissionTable({
    items: catalogItems([toolItem("grep")], actionForToolId),
    teamMembers: ["ocp-deepseek-implementer"],
    resolve: (item, agent) => ({ enabled: agent === "ocp-deepseek-implementer" && item.ruleId === "files.env" ? false : item.enabled, text: item.text }),
  })
  expect(tableActive(member, ["alpha"])).toBe(false)
  expect(tableActive(member, ["ocp-deepseek-implementer"])).toBe(true)
})

test("tableNarrows reacts to off values and parameters, on value caps and Delegate to rows", () => {
  const narrows = (tools: readonly string[], changes: Changes = {}) => tableNarrows(tableOf(tools, changes), ["alpha"])
  expect(narrows(["read", "glob", "grep", "shell", "webfetch", "write", "patch", "question"])).toBe(false)
  expect(narrows(["webfetch"], { off: ["format.html"] })).toBe(true)
  expect(narrows(["glob"], { off: ["parameters.hidden"] })).toBe(true)
  expect(narrows(["read"], { on: ["limits.lines"] })).toBe(true)
  // Length and count caps are refused per call; they have no schema bound.
  expect(narrows(["write"], { on: ["limits.size"] })).toBe(false)
  expect(narrows(["patch"], { on: ["limits.files"] })).toBe(false)
  expect(narrows(["webfetch"], { on: ["approval.every"] })).toBe(false)
  expect(narrows(["shell"], { off: ["environment.secrets"] })).toBe(false)
  const member = permissionTable({
    items: teamPolicyItems(policyMembersOf(["ocp-astra-reviewer"])),
    teamMembers: ["ocp-astra-reviewer"],
    resolve: (item) => ({ enabled: item.enabled, text: item.text }),
  })
  // Its only Delegate to row is off, and its role still lists no members.
  expect(tableNarrows(member, ["ocp-astra-reviewer"])).toBe(true)
  expect(tableNarrows(member, ["alpha"])).toBe(false)
})

test("permissionTable resolves lazily once per agent, keeps rule rows out, and lists shared rows under every tool", () => {
  const resolved: string[] = []
  const shared: Item = { ...allowRow("edit", "files", "shared", "path", ["docs/*"]), allow: false, alsoUnder: ["write", "patch"] }
  const table = permissionTable({
    items: [...catalogItems([toolItem("read"), toolItem("grep"), toolItem("edit")], actionForToolId), ...teamPolicyItems(policyMembersOf(["ocp-deepseek-implementer"])), shared],
    teamMembers: ["ocp-deepseek-implementer"],
    resolve: (item, agent) => {
      resolved.push(`${agent} ${item.id}`)
      return { enabled: item.enabled, text: item.text }
    },
  })
  expect(resolved).toEqual([])
  const rows = table.rows("alpha")
  expect(resolved).toHaveLength(rows.length)
  table.rows("alpha")
  table.toolRows("alpha", "grep")
  table.toolRows("alpha", "grep")
  expect(resolved).toHaveLength(rows.length)
  // Rule rows compile to core rules and never reach the table.
  expect(rows.filter((row) => row.item.permKind === undefined || row.item.permKind === "rule")).toEqual([])
  // A member's own rows apply to it alone.
  expect(rows.some((row) => row.item.id === "perm:team_delegate:to.other-teams")).toBe(false)
  expect(table.toolRows("ocp-deepseek-implementer", "team_delegate").map((row) => row.item.id)).toContain("perm:team_delegate:to.other-teams")
  expect(table.teamMembers.has("ocp-deepseek-implementer")).toBe(true)
  // One row shared by several tools lists under each of them.
  for (const tool of ["edit", "write", "patch"]) expect(table.toolRows("alpha", tool).map((row) => row.item.id)).toContain("perm:edit:files.shared")
  expect(table.toolRows("alpha", "read").map((row) => row.item.id)).not.toContain("perm:edit:files.shared")
})

test("rowState, teamLimit and teamAllows read a member's team rows, and a missing row or table reads as off", () => {
  const items = [...teamPolicyItems(policyMembersOf(["ocp-alice"])), ...catalogItems([toolItem("team_delegate"), toolItem("team_status")], (tool) => `team.${tool.slice("team_".length)}`)]
  const tableWith = (changes: Readonly<Record<string, { enabled?: boolean; text?: string }>>) =>
    permissionTable({
      items,
      teamMembers: ["ocp-alice"],
      resolve: (item) => ({ enabled: changes[item.id]?.enabled ?? item.enabled, text: changes[item.id]?.text ?? item.text }),
    })
  const agent = "ocp-alice"
  const shipped = tableWith({})
  expect(rowState(shipped, agent, "team_delegate", "limits.inflight")?.on).toBe(true)
  expect(teamLimit(shipped, agent, "team_delegate", "limits.inflight")).toBe(4)
  expect(teamLimit(tableWith({ "perm:team_delegate:limits.inflight": { text: "1" } }), agent, "team_delegate", "limits.inflight")).toBe(1)
  // Off removes the bound; so does a missing row or a missing table.
  expect(teamLimit(tableWith({ "perm:team_delegate:limits.inflight": { enabled: false } }), agent, "team_delegate", "limits.inflight")).toBeUndefined()
  expect(teamLimit(shipped, agent, "team_delegate", "limits.nothing")).toBeUndefined()
  expect(teamLimit(undefined, agent, "team_delegate", "limits.inflight")).toBeUndefined()
  // Runs rows ship off; a record turns one on; no table reads off.
  expect(teamAllows(shipped, agent, "team_status", "runs.others")).toBe(false)
  expect(teamAllows(tableWith({ "perm:team_status:runs.others": { enabled: true } }), agent, "team_status", "runs.others")).toBe(true)
  expect(teamAllows(undefined, agent, "team_status", "runs.others")).toBe(false)
  expect(teamAllows(shipped, agent, "team_delegate", "access.delegated")).toBe(true)
  expect(teamAllows(shipped, agent, "team_delegate", "no.such-row")).toBe(false)
  // A row is found under its own tool only.
  expect(rowState(shipped, agent, "team_wait", "limits.inflight")).toBeUndefined()
})
