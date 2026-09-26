// The per-tool permission catalog is data plus the two helpers every enforcer
// shares. These tests pin the data's shape for every tool of the real
// inventory, the rows catalogItems turns it into, and the wildcard copy
// against core's own matcher.
import { expect, test } from "bun:test"
import { fingerprint, permItemId, type Item } from "../src/instructions/model.js"
import {
  catalogFor,
  catalogItems,
  categoryLabel,
  categoryOfRow,
  categoryOrder,
  categorySummary,
  hostOf,
  isValueRow,
  limitOf,
  secretFilePatterns,
  valuesAt,
  wildcardMatch,
  type CategorySpec,
} from "../src/instructions/permission-catalog.js"
// Plus cannot depend on core, so its matcher is a copy; the test pins the copy
// to the original by path.
import { match } from "../../core/src/util/wildcard.ts"

function toolItem(tool: string): Item {
  return { id: `tool:${tool}`, kind: "tool", group: "native", title: tool, text: tool, enabled: true, fingerprint: fingerprint(tool) }
}

const browserTools = [
  "back",
  "check",
  "click",
  "console",
  "cpu_analyze",
  "cpu_start",
  "cpu_stop",
  "dialog",
  "drag",
  "evaluate",
  "files_drop",
  "files_get",
  "files_list",
  "files_upload",
  "fill",
  "fill_form",
  "find",
  "forward",
  "frames",
  "heap_compare",
  "heap_object",
  "heap_query",
  "heap_snapshot",
  "heap_summary",
  "hover",
  "lighthouse",
  "navigate",
  "network_get",
  "network_list",
  "press",
  "reload",
  "screenshot",
  "scroll",
  "select",
  "snapshot",
  "stop",
  "tabs_close",
  "tabs_focus",
  "tabs_list",
  "tabs_open",
  "trace_analyze",
  "trace_start",
  "trace_stop",
  "wait",
].map((name) => `browser_${name}`)

const instructionTools = ["list", "show", "log", "set", "reset", "split", "create", "delete"].map((name) => `instructions_${name}`)

const teamToolIds = [
  "delegate",
  "finish",
  "followup",
  "integrate",
  "checkpoint",
  "set_checks",
  "supersede",
  "stop",
  "status",
  "wait",
  "diff",
  "list",
  "get_context",
  "check",
].map((name) => `team_${name}`)

// The real inventory: native tools, Code Mode tools, the desktop browser
// plugin, the Plus instruction and team tools, and the MCP servers.
const inventory = [
  "read",
  "glob",
  "grep",
  "edit",
  "write",
  "patch",
  "shell",
  "question",
  "subagent",
  "skill",
  "webfetch",
  "websearch",
  "execute",
  "opencode_session_move",
  "opencode_session_rename",
  ...browserTools,
  ...instructionTools,
  "release_request",
  "release_status",
  "search_tavily_search",
  "search_tavily_extract",
  "search_exa_code_search",
  ...teamToolIds,
]

test("wildcardMatch answers exactly like core's wildcard matcher", () => {
  const cases: readonly (readonly [input: string, pattern: string, expected: boolean])[] = [
    // A trailing " *" also covers the bare head.
    ["git push", "git push *", true],
    ["git push origin main", "git push *", true],
    ["git pushx", "git push *", false],
    ["git pushing", "git push *", false],
    ["git status", "git push *", false],
    ["git", "git *", true],
    ["gitk", "git *", false],
    ["tee", "tee *", true],
    ["git push", "git push*", true],
    // `*` spans any run, `/` included.
    ["a/b/c.ts", "*.ts", true],
    ["src/deep/nested/file.ts", "src/*", true],
    ["/home/user/.env", "*/.env", true],
    [".env", "*/.env", false],
    ["", "*", true],
    ["anything at all", "*", true],
    ["echo hi > out.txt", "* > *", true],
    // `?` is exactly one character.
    ["file.tx", "file.t?", true],
    ["file.t", "file.t?", false],
    ["file.txt", "file.t?", false],
    ["x", "?", true],
    ["xy", "?", false],
    // Backslashes read as `/` on both sides.
    ["C:\\Users\\me\\.env", "*/.env", true],
    ["src\\index.ts", "src/*", true],
    ["a/b", "a\\b", true],
    // Regex metacharacters are literal.
    ["a.b", "a.b", true],
    ["axb", "a.b", false],
    ["(x)", "(x)", true],
    ["a+b", "a+b", true],
    ["aab", "a+b", false],
    ["$HOME", "$HOME", true],
    ["a|b", "a|b", true],
    ["a", "a|b", false],
    ["[x]", "[x]", true],
    ["x", "[x]", false],
    ["{a}", "{a}", true],
    ["^a", "^a", true],
    // `.` spans newlines, and matching is case-sensitive here.
    ["line1\nline2", "line1*", true],
    ["FILE.PNG", "*.png", false],
    ["http://localhost:4096/api", "http://localhost*", true],
    ["https://127.0.0.1/", "http://127.*", false],
  ]
  for (const [input, pattern, expected] of cases) {
    expect([input, pattern, wildcardMatch(input, pattern)]).toEqual([input, pattern, match(input, pattern)])
    expect([input, pattern, wildcardMatch(input, pattern)]).toEqual([input, pattern, expected])
  }
})

test("valuesAt walks dotted paths and [] arrays and yields nothing for missing fields", () => {
  expect(valuesAt({ scope: { paths: ["a.ts", "b/*"] } }, "scope.paths[]")).toEqual(["a.ts", "b/*"])
  expect(valuesAt({ scope: { paths: [] } }, "scope.paths[]")).toEqual([])
  expect(valuesAt({ scope: { paths: "a.ts" } }, "scope.paths[]")).toEqual([])
  expect(valuesAt({ scope: {} }, "scope.paths[]")).toEqual([])
  expect(
    valuesAt({ questions: [{ question: "a", multiple: true }, { question: "b", multiple: false }, { question: "c" }] }, "questions[].multiple"),
  ).toEqual([true, false])
  expect(valuesAt({ checks: [{ id: "t", argv: ["bun", "test", "x.test.ts"] }, { id: "s", argv: ["bun", "run", "lint"] }] }, "checks[].argv")).toEqual([
    ["bun", "test", "x.test.ts"],
    ["bun", "run", "lint"],
  ])
  expect(valuesAt({ needs: [{ kind: "path" }, { kind: "info" }] }, "needs[].kind")).toEqual(["path", "info"])
  expect(valuesAt({ fields: [{ value: "a" }, { name: "b" }] }, "fields[].value")).toEqual(["a"])
  expect(valuesAt({ artifact: { target: "linux-x64" } }, "artifact.target")).toEqual(["linux-x64"])
  expect(valuesAt({ contents: { text: { maxCharacters: 10 } } }, "contents.text")).toEqual([{ maxCharacters: 10 }])
  // Without [] an array is one value.
  expect(valuesAt({ urls: ["a", "b"] }, "urls")).toEqual([["a", "b"]])
  expect(valuesAt({ urls: ["a", "b"] }, "urls[]")).toEqual(["a", "b"])
  // null, 0 and false are values; undefined is not.
  expect(valuesAt({ approvalRef: null }, "approvalRef")).toEqual([null])
  expect(valuesAt({ timeout: 0 }, "timeout")).toEqual([0])
  expect(valuesAt({ ack: false }, "ack")).toEqual([false])
  expect(valuesAt({ timeout: undefined }, "timeout")).toEqual([])
  expect(valuesAt({}, "a.b")).toEqual([])
  expect(valuesAt(null, "a")).toEqual([])
  expect(valuesAt("text", "length")).toEqual([])
  expect(valuesAt({ a: 1 }, "a.b")).toEqual([])
})

test("the inventory list is the real one", () => {
  expect(browserTools).toHaveLength(44)
  expect(new Set(inventory).size).toBe(inventory.length)
})

test("every tool of the inventory lists its Permissions categories; team_status lists only its Runs rows", () => {
  expect(catalogFor("team_status").map((category) => category.id)).toEqual(["runs"])
  const empty = inventory.filter((tool) => catalogFor(tool).length === 0)
  expect(empty).toEqual([])
})

test("every catalog row carries what its kind is enforced by", () => {
  const problems = inventory.flatMap((tool) => {
    const categories = catalogFor(tool)
    const categoryIds = categories.map((category) => category.id)
    const ruleIds = categories.flatMap((category) => rowsOf(category).map((row) => `${category.id}.${row.id}`))
    return [
      ...(new Set(categoryIds).size === categoryIds.length ? [] : [`${tool}: duplicate category ids ${categoryIds.join(",")}`]),
      ...ruleIds.filter((id, index) => ruleIds.indexOf(id) !== index).map((id) => `${tool}: duplicate row id ${id}`),
      ...categories.flatMap((category) => categoryProblems(tool, category)),
    ]
  })
  expect(problems).toEqual([])
})

function rowsOf(category: CategorySpec) {
  return [...(category.fallback === undefined ? [] : [category.fallback]), ...category.rows]
}

function categoryProblems(tool: string, category: CategorySpec): string[] {
  const where = `${tool} ${category.id}`
  const own = [
    ...(category.label.trim().length > 0 ? [] : [`${where}: empty category label`]),
    ...(category.summary.trim().length > 0 ? [] : [`${where}: empty summary`]),
    ...(category.kind === "limit" && (category.mode === undefined || category.measure === undefined) ? [`${where}: limit category without mode or measure`] : []),
  ]
  return [
    ...own,
    ...rowsOf(category).flatMap((row) => {
      const at = `${where}.${row.id}`
      const field = row.field ?? category.field ?? ""
      return [
        ...(row.label.trim().length > 0 ? [] : [`${at}: empty label`]),
        ...(category.kind === "limit" && !(typeof row.limit === "number" && Number.isFinite(row.limit)) ? [`${at}: limit row without a number`] : []),
        ...(category.kind === "limit" && (row.field ?? "").length === 0 ? [`${at}: limit row without a field`] : []),
        ...(category.kind === "value" && row.value === undefined ? [`${at}: value row without a value`] : []),
        ...(category.kind === "value" && field.length === 0 ? [`${at}: value row without a field`] : []),
        ...(category.kind === "input" && field.length === 0 ? [`${at}: input row without a field`] : []),
        ...(category.kind === "param" && field.length === 0 ? [`${at}: param row without a field`] : []),
        ...(category.kind === "rule" && (row.patterns ?? []).length === 0 ? [`${at}: rule row without patterns`] : []),
      ]
    }),
  ]
}

// An unknown tool gets Approval only when a permission check reaches it (an
// MCP leaf, the plugin gate): a question the host would never ask is not
// offered. Browser tools carry no plugin origin, so theirs is page rows only.
test("unknown MCP and plugin tools get an approval category; tools no check reaches get nothing they cannot honour", () => {
  expect(catalogFor("mcp_weather_forecast", "mcp").map((category) => [category.id, category.kind])).toEqual([["approval", "approval"]])
  expect(catalogFor("plugin_tool", "plus").map((category) => category.id)).toEqual(["approval"])
  expect(catalogFor("mystery_native", "native")).toEqual([])
  expect(catalogFor("browser_something_new").map((category) => category.id)).toEqual(["sites"])
})

const shippedActions = new Map([
  ["edit", "edit"],
  ["write", "edit"],
  ["patch", "edit"],
])

test("catalogItems turns every category into unique perm rows with the tool's action", () => {
  const tools = ["read", "grep", "edit", "write", "patch", "shell", "webfetch", "glob", "release_request", "team_status"]
  const items = catalogItems(
    [
      ...tools.map(toolItem),
      { ...toolItem("mcp_weather_forecast"), group: "mcp" as const },
      // Not tool rows: no Permissions of their own.
      { ...toolItem("notes"), id: "skill:notes", kind: "skill" },
      { ...toolItem("stray"), id: "stray" },
    ],
    (tool) => shippedActions.get(tool),
  )
  const ids = items.map((item) => item.id)
  expect(new Set(ids).size).toBe(ids.length)
  expect(ids.some((id) => id.startsWith("perm:notes:") || id.startsWith("perm:stray:"))).toBe(false)
  expect(items.filter((item) => item.permTool === "team_status").map((item) => [item.id, item.enabled, item.permKind])).toEqual([
    ["perm:team_status:runs.descendants", false, "team"],
    ["perm:team_status:runs.others", false, "team"],
  ])

  for (const item of items) {
    expect(item.kind).toBe("perm")
    expect(item.id).toBe(permItemId(item.permTool ?? "", item.ruleId ?? ""))
    expect(item.ruleId?.startsWith(`${item.category}.`)).toBe(true)
    // Catalog rows never scrub prompt lines and are mentioned by nothing.
    expect(item.keywords).toEqual([])
    expect(item.provenance).toEqual([])
    expect(item.fingerprint).toBe(fingerprint(item.text))
    expect(item.permKind).toBeDefined()
  }

  // The action comes from actionOf, and falls back to the tool id.
  const actions = new Map(items.map((item) => [item.permTool, item.permAction]))
  expect(Object.fromEntries(actions)).toEqual({
    read: "read",
    grep: "grep",
    edit: "edit",
    write: "edit",
    patch: "edit",
    shell: "shell",
    webfetch: "webfetch",
    glob: "glob",
    release_request: "release_request",
    team_status: "team_status",
    mcp_weather_forecast: "mcp_weather_forecast",
  })
  // A row that denies another core action names it: read's Where row for
  // every tool's paths outside the checkout.
  expect(items.find((item) => item.id === "perm:read:where.external")).toMatchObject({ permAction: "external_directory", permKind: "rule", patterns: ["*"], enabled: true })

  // Exactly the "Everything else" rows are flagged; no other row carries the key.
  expect(items.filter((item) => item.fallback === true).map((item) => item.id).toSorted()).toEqual(
    ["perm:edit:allowed.*", "perm:edit:where.outside", "perm:grep:files.*", "perm:read:files.*", "perm:read:where.outside", "perm:shell:commands.*"].toSorted(),
  )
  expect(items.filter((item) => "fallback" in item && item.fallback !== true)).toEqual([])

  const byId = new Map(items.map((item) => [item.id, item]))
  expect(byId.get("perm:mcp_weather_forecast:approval.every")).toMatchObject({ enabled: false, permKind: "approval", category: "approval" })
  expect(items.filter((item) => item.permTool === "mcp_weather_forecast")).toHaveLength(1)

  // A limit row's text is its number; the field and how it applies come along.
  expect(byId.get("perm:read:limits.lines")).toMatchObject({
    text: "2000",
    enabled: false,
    permKind: "limit",
    field: "limit",
    measure: "value",
    mode: "clamp",
  })
  expect(byId.get("perm:write:limits.size")).toMatchObject({ text: "200000", field: "content", measure: "length", mode: "refuse", permAction: "edit" })
  // Every other row's text is its label and patterns.
  expect(byId.get("perm:shell:commands.kill-by-name")?.text).toBe("Stopping processes by name\npkill\npkill *\nkillall\nkillall *")
  // An allow-list row, and a fallback with its refusal: both checked on the
  // call's own path (input rows), never installed as core rules.
  expect(byId.get("perm:read:where.tmp")).toMatchObject({ allow: true, enabled: true, permKind: "input", field: "path", patterns: ["/tmp/*", "*/run/plus/tmp/*"] })
  expect(byId.get("perm:read:where.outside")).toMatchObject({ fallback: true, enabled: true, permKind: "input", patterns: ["/*"], message: "reading outside this checkout is not allowed here" })
  // A rule category's fallback is an input row beside its rule rows.
  expect(byId.get("perm:read:files.*")).toMatchObject({ fallback: true, permKind: "input", field: "path" })
  expect(byId.get("perm:read:files.keys")).toMatchObject({ permKind: "rule" })
  expect(byId.get("perm:shell:commands.*")).toMatchObject({ fallback: true, permKind: "input", field: "command" })
  // One permission shared by edit, write and patch.
  expect(byId.get("perm:edit:protected.ci")?.alsoUnder).toEqual(["write", "patch"])
  expect(byId.get("perm:edit:where.outside")?.alsoUnder).toEqual(["write", "patch"])
  expect(byId.get("perm:write:operations.create")).toMatchObject({ permKind: "input", field: "path", permAction: "edit" })
  expect(byId.get("perm:patch:operations.move")).toMatchObject({ permKind: "input", field: "patchText", permAction: "edit" })
  // Value rows take the category's field and carry their literal.
  expect(byId.get("perm:webfetch:format.html")).toMatchObject({ permKind: "value", field: "format", value: "html" })
  // Param rows carry the value that counts as using them, or none at all.
  expect(byId.get("perm:glob:parameters.hidden")).toMatchObject({ permKind: "param", field: "hidden", value: true })
  expect(byId.get("perm:shell:parameters.no-timeout")).toMatchObject({ field: "timeout", value: 0 })
  expect("value" in (byId.get("perm:shell:parameters.workdir") ?? {})).toBe(false)
  const noApproval = byId.get("perm:release_request:parameters.no-approval")
  expect(noApproval !== undefined && "value" in noApproval && noApproval.value === null).toBe(true)
  // An input row's field is its own when it has one, else the category's.
  expect(byId.get("perm:grep:files.env")).toMatchObject({ permKind: "input", field: "path", enabled: true })
  expect(byId.get("perm:grep:include.env")).toMatchObject({ permKind: "input", field: "include" })
  expect(byId.get("perm:shell:environment.secrets")?.permKind).toBe("env")
  // A category's fallback lists before its other rows.
  const readFiles = items.filter((item) => item.permTool === "read" && item.category === "files")
  expect(readFiles.toSorted((left, right) => (left.order ?? 0) - (right.order ?? 0))[0]?.id).toBe("perm:read:files.*")
  // Shipped state is the row's `on`.
  expect(byId.get("perm:read:approval.every")?.enabled).toBe(false)
  expect(byId.get("perm:shell:commands.git-changes")?.enabled).toBe(true)
})

test("categoryOfRow lists catalog, team, mined, curated and custom rows where they belong", () => {
  // A catalog or team row carries its own category.
  expect(categoryOfRow({ category: "files", permTool: "grep" }, false)).toBe("files")
  expect(categoryOfRow({ category: "to", permTool: "team_delegate", policy: { on: [], off: [] } }, false)).toBe("to")
  // A team policy row without one is the member's role.
  expect(categoryOfRow({ permTool: "shell", policy: { on: [], off: [] } }, false)).toBe("role")
  // A mined row (provenance, nothing curated behind it) is a suggestion.
  expect(categoryOfRow({ permTool: "shell", provenance: ["tool:shell"], ruleId: "docker-build" }, false)).toBe("suggested")
  // Curated and user rows take their tool's legacy category.
  expect(categoryOfRow({ permTool: "shell", provenance: ["tool:shell"], ruleId: "git-push" }, true)).toBe("commands")
  expect(categoryOfRow({ permTool: "shell", provenance: ["base:gpt"], custom: true, ruleId: "mine" }, false)).toBe("commands")
  expect(categoryOfRow({ permTool: "edit", ruleId: "env" }, true)).toBe("files")
  expect(categoryOfRow({ permTool: "write", ruleId: "env" }, true)).toBe("files")
  expect(categoryOfRow({ permTool: "patch", ruleId: "env" }, true)).toBe("files")
  expect(categoryOfRow({ permTool: "read", ruleId: "env" }, true)).toBe("files")
  expect(categoryOfRow({ permTool: "webfetch", ruleId: "github" }, true)).toBe("sites")
  expect(categoryOfRow({ permTool: "glob", ruleId: "git" }, true)).toBe("patterns")
  expect(categoryOfRow({ permTool: "grep", ruleId: "git" }, true)).toBe("patterns")
  expect(categoryOfRow({ permTool: "subagent", ruleId: "explore" }, true)).toBe("agents")
  expect(categoryOfRow({ permTool: "skill", ruleId: "notes" }, true)).toBe("skills")
  // A tool with no legacy category lists its rows under Rules.
  expect(categoryOfRow({ permTool: "mcp_weather_forecast", custom: true, ruleId: "x" }, false)).toBe("rules")
  expect(categoryOfRow({ custom: true, ruleId: "x" }, false)).toBe("rules")
})

test("categoryLabel reads the catalog, then the host tool, then the fixed labels", () => {
  expect(categoryLabel("grep", "files")).toBe("Files")
  expect(categoryLabel("shell", "commands")).toBe("Commands")
  expect(categoryLabel("read", "where")).toBe("Where")
  expect(categoryLabel("team_delegate", "limits")).toBe("Limits")
  expect(categoryLabel("team_integrate", "branches")).toBe("Branches it lands on")
  // Rows with no tool of their own read their host's catalog.
  expect(categoryLabel("external_directory", "where")).toBe("Where")
  expect(categoryLabel("task", "team-members")).toBe("Team members")
  expect(categoryLabel("search", "queries")).toBe("Queries")
  // Legacy and fixed categories.
  expect(categoryLabel("glob", "patterns")).toBe("Search patterns")
  expect(categoryLabel("webfetch", "sites")).toBe("Sites")
  expect(categoryLabel("subagent", "agents")).toBe("Agents")
  expect(categoryLabel("skill", "skills")).toBe("Skills")
  expect(categoryLabel("shell", "suggested")).toBe("Mentioned in instructions")
  expect(categoryLabel("shell", "role")).toBe("Team role")
  expect(categoryLabel("team_delegate", "to")).toBe("Delegate to")
  expect(categoryLabel("team_status", "runs")).toBe("Runs")
  expect(categoryLabel("team_delegate", "access")).toBe("Access")
  expect(categoryLabel("edit", "scopes")).toBe("Run edit scopes")
  expect(categoryLabel("mcp_weather_forecast", "rules")).toBe("Rules")
  expect(categoryLabel("mcp_weather_forecast", "odd-one")).toBe("Odd-one")
})

test("categoryOrder puts team rows first, then the legacy category, the catalog, rules and suggestions", () => {
  const head = ["to", "runs", "access", "role"]
  expect(categoryOrder("shell")).toEqual([...head, "commands", "directories", "parameters", "environment", "limits", "approval", "rules", "suggested"])
  expect(categoryOrder("grep")).toEqual([...head, "patterns", "files", "include", "roots", "limits", "approval", "rules", "suggested"])
  expect(categoryOrder("read")).toEqual([...head, "files", "where", "content", "limits", "approval", "rules", "suggested"])
  expect(categoryOrder("team_status")).toEqual([...head, "approval", "rules", "suggested"])
  expect(categoryOrder("mcp_weather_forecast")).toEqual([...head, "approval", "rules", "suggested"])
})

test("hostOf maps the rows with no tool of their own", () => {
  expect(hostOf("external_directory")).toBe("read")
  expect(hostOf("task")).toBe("subagent")
  expect(hostOf("search")).toBe("search_tavily_search")
  expect(hostOf("shell")).toBe("shell")
  expect(hostOf("team_delegate")).toBe("team_delegate")
})

test("limitOf reads the first integer of a row's text", () => {
  expect(limitOf("2000")).toBe(2000)
  expect(limitOf("200_000")).toBe(200000)
  expect(limitOf("at most 5 files")).toBe(5)
  expect(limitOf("-1")).toBe(-1)
  expect(limitOf("no number")).toBeUndefined()
  expect(limitOf("")).toBeUndefined()
})

test("secretFilePatterns is every secret-file pattern once", () => {
  const patterns = secretFilePatterns()
  expect(new Set(patterns).size).toBe(patterns.length)
  for (const pattern of [".env", "*.pem", "id_rsa", "auth.json", "*/.config/opencodeplus/opencode.json", "*/run/team/*/runs/*/config/*", "*.sqlite"])
    expect(patterns).toContain(pattern)
  // They are the grep Files rows' patterns.
  const grepFiles = catalogFor("grep").find((category) => category.id === "files")
  expect([...new Set(grepFiles?.rows.flatMap((row) => row.patterns ?? []))]).toEqual(patterns)
})

// DESIGN §6: every former hidden team rule is a shared catalogue row with a
// label, the words the model reads when it refuses, a category that lists it
// under the right tool, and a line saying who enforces it.
test("the former team rules are shared catalogue rows under the tool and category that enforce them", async () => {
  const { enforcementLine } = await import("../src/tui/instructions/detail-pane.js")
  const tools = ["team_get_context", "team_delegate", "team_finish", "team_status", "team_followup", "read", "edit"]
  const items = catalogItems(tools.map(toolItem), (tool) => (tool.startsWith("team_") ? `team.${tool.slice("team_".length)}` : tool))
  const rows: Record<string, { label: string; category: string; message?: boolean; enforced: string }> = {
    "perm:team_get_context:bootstrap.chat": { label: "Start a team run from a chat", category: "Team runs", message: true, enforced: "when a chat of this member calls one" },
    "perm:team_delegate:access.delegated": { label: "Delegate from a delegated run", category: "Access", message: true, enforced: "for the member that calls them" },
    "perm:team_get_context:accepts.scope-paths": { label: "Scope paths for a commit", category: "Briefs it accepts", message: true, enforced: "not for the caller" },
    "perm:team_get_context:accepts.plan-files": { label: "Plan files only", category: "Briefs it accepts", message: true, enforced: "not for the caller" },
    "perm:team_get_context:accepts.reason": { label: "A reason", category: "Briefs it accepts", message: true, enforced: "not for the caller" },
    "perm:team_get_context:accepts.check": { label: "A check", category: "Briefs it accepts", message: true, enforced: "not for the caller" },
    "perm:team_get_context:accepts.followup": { label: "Corrections by followup", category: "Briefs it accepts", message: true, enforced: "not for the caller" },
    "perm:team_get_context:limits.paths": { label: "Paths per brief", category: "Brief limits", enforced: "not for the caller" },
    "perm:team_get_context:limits.checks": { label: "Checks per brief", category: "Brief limits", enforced: "not for the caller" },
    "perm:team_finish:requirements.clean": { label: "Worktree committed before done", category: "Requirements for done", enforced: "for the member that calls them" },
    "perm:team_status:runs.others": { label: "Any other run (other members, teams and projects)", category: "Runs", message: true, enforced: "for the member that calls them" },
    "perm:team_followup:runs.descendants": { label: "Deeper descendants (grandchildren and below)", category: "Runs", message: true, enforced: "for the member that calls them" },
    "perm:read:where.external": { label: "Outside this checkout, for every tool (external_directory)", category: "Where", message: true, enforced: "core rule on external_directory" },
    "perm:edit:allowed.*": { label: "Every other file", category: "Files it may change", message: true, enforced: "refuses everything this category's allowed rows do not let through" },
    "perm:edit:allowed.plans": { label: "Plan files (docs/plans/, docs/handoffs/)", category: "Files it may change", enforced: "on lets its patterns through" },
  }
  for (const [id, expected] of Object.entries(rows)) {
    const item = items.find((entry) => entry.id === id)
    if (item === undefined) throw new Error(`missing row ${id}`)
    const tool = item.permTool ?? ""
    expect([id, item.title, categoryLabel(tool, item.category ?? ""), item.agents]).toEqual([id, expected.label, expected.category, undefined])
    expect([id, (categorySummary(tool, item.category ?? "") ?? "").length > 0]).toEqual([id, true])
    expect([id, categoryOrder(tool).includes(item.category ?? "")]).toEqual([id, true])
    if (expected.message === true) expect([id, (item.message ?? "").length > 0]).toEqual([id, true])
    expect([id, enforcementLine(item)]).toEqual([id, expect.stringContaining(expected.enforced)])
  }
  // The number rows are value rows the TUI edits as numbers.
  for (const id of ["perm:team_get_context:limits.paths", "perm:team_get_context:limits.checks"]) {
    const item = items.find((entry) => entry.id === id)
    expect([id, item !== undefined && isValueRow(item), item?.text]).toEqual([id, true, id.endsWith("paths") ? "5" : "1"])
  }
  // The caller-side reason row is gone: a reason is what the target accepts.
  expect(items.some((item) => item.id === "perm:team_delegate:requirements.reason")).toBe(false)
})
