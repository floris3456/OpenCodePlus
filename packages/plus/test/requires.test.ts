import { expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { Session } from "@opencode/schema/session"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import { Effect } from "effect"
import { apply, roleUpdates, type ApplyInput } from "../src/instructions/apply.js"
import { discover } from "../src/instructions/discover.js"
import { guidanceContent } from "../src/instructions/guidance.js"
import { fingerprint, type CustomizationRecord, type Item, type Level } from "../src/instructions/model.js"
import { guidancePath, guidanceItemId } from "../src/instructions/paths.js"
import { chainContext } from "../src/instructions/presets.js"
import { applyRequires, gatedSections, mentionWarnings, mentions } from "../src/instructions/requires.js"
import { expandedTree } from "../src/instructions/tree.js"
import { agentHarness, agentInfo, context, skillHarness, skillInfo, toolHarness } from "./harness.js"

// Instructions follow capabilities: a section that depends on a row reaches
// an agent only while that row is as it requires for that agent, so turning a
// tool, skill or rule on or off also adds or removes the instructions that
// belong to it.

const UPDATED = "2026-01-01T00:00:00.000Z"

const text = `# Role

## Always
Read the Brief.

## Checks
<!-- requires: tool:team_check -->
Run checks with team_check.

### Detail
Fix causes.

## No push
<!-- requires: !perm:shell:git-push -->
You cannot push.

## Both
<!-- requires: tool:team_check, skill:pilotty -->
Check the TUI too.
`

test("a section is kept only while its rows are as it requires; markers never reach the model", () => {
  const all = applyRequires(text, (id) => ({ "tool:team_check": true, "perm:shell:git-push": false, "skill:pilotty": true })[id])
  expect(all).toContain("## Checks\nRun checks with team_check.\n\n### Detail\nFix causes.")
  expect(all).toContain("## No push\nYou cannot push.")
  expect(all).toContain("## Both\nCheck the TUI too.")
  expect(all).not.toContain("<!--")

  const none = applyRequires(text, (id) => ({ "tool:team_check": false, "perm:shell:git-push": true, "skill:pilotty": true })[id])
  // A section goes with its subsections; one failed requirement is enough.
  expect(none).toBe("# Role\n\n## Always\nRead the Brief.")
  // A row the agent does not have meets neither form.
  expect(applyRequires(text, () => undefined)).toBe("# Role\n\n## Always\nRead the Brief.")
  // A text without markers passes through byte for byte.
  expect(applyRequires("# A\n\n\n\nB\n", () => false)).toBe("# A\n\n\n\nB\n")
  // A heading left with nothing under it goes too.
  expect(applyRequires("# Only\n\n## Gated\n<!-- requires: tool:x -->\nbody\n", () => false)).toBe("")
})

test("a marker inside a code fence is text, not a requirement", () => {
  const fenced = "# A\n\n```\n## Not a heading\n<!-- requires: tool:x -->\n```\nkept\n"
  expect(gatedSections(fenced).map((section) => section.name)).toEqual(["A"])
})

test("mentions a marker does not cover are reported for the section that makes them", () => {
  const names = new Map([
    ["team_check", "tool:team_check"],
    ["team_status", "tool:team_status"],
  ])
  const off = (id: string) => (id === "tool:team_status" || id === "tool:team_check" ? false : true)
  const body = "# Role\n\n## Status\nRead team_status first.\n\n## Checks\n<!-- requires: tool:team_check -->\nRun team_check.\n"
  expect(mentionWarnings(body, names, off)).toEqual([{ section: "Status", word: "team_status", id: "tool:team_status" }])
})

// ── what an agent actually receives ───────────────────────────────────────

function sessionEvent(agentID: string): SessionHooks["context"] {
  return {
    sessionID: Session.ID.make("ses_requires"),
    agent: Agent.ID.make(agentID),
    model: Model.Ref.make({ providerID: Provider.ID.make("test"), id: Model.ID.make("test") }),
    system: [],
    messages: [],
    options: {},
    tools: {},
  }
}

function input(items: readonly Item[], records: readonly CustomizationRecord[], agents: readonly string[]): ApplyInput {
  const sources = agents.map((id) => ({ id, scope: "project" as const, origin: "user" as const }))
  return {
    items,
    records,
    splits: [],
    agents: agents.map((id) => ({ id, level: "project" as Level })),
    scopes: chainContext({
      agents: sources,
      items,
      links: agents.map((agent) => ({ type: "link", level: "project", agent, preset: { kind: "agent", id: "build" }, updated: UPDATED })),
    }),
  }
}

function off(agent: string, item: string): CustomizationRecord {
  return { type: "customization", level: "project", agent, item, section: null, state: "off", basedOn: "", updated: UPDATED }
}

test("turning a skill on for an agent brings its Tools and rules section; off takes it away", async () => {
  const callbacks: ((event: SessionHooks["context"]) => Effect.Effect<void>)[] = []
  const ctx = context({
    agent: agentHarness([agentInfo("alpha", "upstream"), agentInfo("beta", "upstream")]).domain,
    skill: skillHarness([skillInfo("pilotty", "Drive terminal apps.")]).domain,
    tool: toolHarness([{ id: "skill", description: "Load a skill", options: { codemode: false } }]).domain,
    session: {
      hook: (name, callback) => {
        if (name === "context") callbacks.push(callback as (event: SessionHooks["context"]) => Effect.Effect<void>)
        return Effect.succeed({ dispose: Effect.void })
      },
    },
  })
  const discovered = await discover({ ctx, records: [], baseTemplates: [], activeBase: () => undefined })
  expect(discovered.items.find((item) => item.id === guidanceItemId)?.text).toBe(guidanceContent)
  await apply(ctx, input(discovered.items, [off("beta", "skill:pilotty")], ["alpha", "beta"]))
  const run = callbacks[0]
  if (run === undefined) throw new Error("missing context hook")
  const alpha = sessionEvent("alpha")
  const beta = sessionEvent("beta")
  await Effect.runPromise(run(alpha))
  await Effect.runPromise(run(beta))
  const part = alpha.system.find((entry) => (entry.metadata as { instruction?: { path?: string } } | undefined)?.instruction?.path === guidancePath())
  expect(part?.text).toBe("# Tools and rules\n\n## Terminal UIs\nAfter changing terminal UI code, check it in a real terminal with the pilotty\nskill before you report it done.")
  // beta has pilotty off, and nothing else in the row applies to it: no part at all.
  expect(beta.system).toEqual([])
})

test("a role section that depends on a tool reaches only the agents that have it on", () => {
  const role: Item = {
    id: "system:role",
    kind: "system",
    group: "none",
    title: "Role",
    text,
    enabled: true,
    fingerprint: fingerprint(text),
    agents: ["alpha", "beta"],
  }
  const tool: Item = { id: "tool:team_check", kind: "tool", group: "plus", title: "team_check", text: "Run a check.", enabled: true, fingerprint: "fp" }
  const updates = roleUpdates(input([role, tool], [off("beta", "tool:team_check")], ["alpha", "beta"]))
  const of = (agent: string) => updates.find((update) => update.agent === agent)?.text ?? ""
  expect(of("alpha")).toContain("## Checks\nRun checks with team_check.")
  expect(of("beta")).not.toContain("team_check")
  for (const agent of ["alpha", "beta"]) expect(of(agent)).not.toContain("<!--")
})

test("the tree says when a section is shown, flags an uncovered mention, and links a tool to its instructions", () => {
  const body = "# Role\n\n## Checks\n<!-- requires: tool:team_check -->\nRun team_check.\n\n## Status\nRead team_status.\n"
  const items: Item[] = [
    { id: "system:role", kind: "system", group: "none", title: "Role", text: body, enabled: true, fingerprint: fingerprint(body), agents: ["alpha"] },
    { id: "tool:team_check", kind: "tool", group: "plus", title: "team_check", text: "Run a check.", enabled: true, fingerprint: "a" },
    { id: "tool:team_status", kind: "tool", group: "plus", title: "team_status", text: "Status.", enabled: true, fingerprint: "b" },
    { id: "tool:search_exa_code_search", kind: "tool", group: "mcp", server: "search", title: "search_exa_code_search", text: "Search.", enabled: true, fingerprint: "c" },
    { id: guidanceItemId, kind: "system", group: "plus", title: "Tools and rules", text: guidanceContent, enabled: true, fingerprint: fingerprint(guidanceContent) },
  ]
  const nodes = expandedTree({
    items,
    records: [off("alpha", "tool:team_check"), off("alpha", "tool:team_status")],
    agents: [{ id: "alpha", scope: "project", origin: "user" }],
    links: [{ type: "link", level: "project", agent: "alpha", preset: { kind: "agent", id: "build" }, updated: UPDATED }],
    teams: [],
  })
  const badges = (id: string) => nodes.find((node) => node.id === id)?.badges
  expect(badges("section:project:alpha:system:role:role/checks")?.requires).toEqual([{ id: "tool:team_check", on: true, met: false }])
  expect(badges("section:project:alpha:system:role:role/checks")?.mentions).toBeUndefined()
  expect(badges("section:project:alpha:system:role:role/status")?.mentions).toEqual([{ word: "team_status", id: "tool:team_status" }])
  expect(badges("item:project:alpha:tool:search_exa_code_search")?.guidance).toEqual(["Code search"])
})

test("a plain English word counts as a tool mention only where it reads as the tool", () => {
  expect(mentions("You have no shell: run checks with team_check.", "shell")).toBe(false)
  expect(mentions("Run it with the shell tool.", "shell")).toBe(true)
  expect(mentions("Use `shell` here.", "shell")).toBe(true)
  expect(mentions("Finish with a report.", "report")).toBe(false)
  expect(mentions("Read team_status.", "team_status")).toBe(true)
  expect(mentions("Read team_status_extra.", "team_status")).toBe(false)
})
