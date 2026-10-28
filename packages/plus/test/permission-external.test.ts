// Read's Where rule row (external_directory) through apply(): while it is off
// core refuses every path outside the checkout, except what read's Where allow
// rows that are on match. The rules are inspected as core evaluates them, so
// the test reads the order apply installed and core's own last-match-wins
// answer; no Plus logic is copied here.
import { expect, test } from "bun:test"
import { Effect } from "effect"
import { apply, type ApplyInput } from "../src/instructions/apply.js"
import type { CustomizationRecord } from "../src/instructions/model.js"
import { agentHarness, agentInfo, context, toolHarness } from "./harness.js"
import { change, linked, presetInput, type TeamMember } from "./teams/preset-table.js"

function hostFor(agents: readonly string[]) {
  const harness = agentHarness(agents.map((id) => agentInfo(id, "upstream")))
  const unused = () => Effect.die("unused in this test")
  const ctx = context({
    agent: harness.domain,
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
    tool: { ...toolHarness().domain, hook: () => Effect.succeed({ dispose: Effect.void }) },
    permission: { list: unused, get: unused, reply: unused, assert: unused, hook: () => Effect.succeed({ dispose: Effect.void }) },
    shell: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  return { ctx, harness }
}

// The rules one agent carries after apply, core's defaults included.
async function rulesAfterApply(agent: string, overrides: ApplyInput) {
  const host = hostFor([agent])
  const applied = await apply(host.ctx, overrides)
  const rules = [...(host.harness.state.get(agent)?.permissions ?? [])]
  for (const registration of applied.registrations.toReversed()) await Effect.runPromise(registration.dispose)
  return rules
}

// The theorysnap member from the report: no preset, every shared row off unless
// a record turns it on.
const runner: TeamMember = { id: "runner", team: "theorysnap" }

function inputFor(records: readonly CustomizationRecord[]): ApplyInput {
  return presetInput({ members: [runner], records })
}

const externalRules = <T extends { action: string }>(rules: readonly T[]) => rules.filter((rule) => rule.action === "external_directory")

test("a member's Temporary directories row on opens external_directory inside /tmp, and /etc still names the row", async () => {
  const { evaluate } = await import("../../core/src/permission.js")
  const rules = await rulesAfterApply("runner", inputFor([change(runner, "perm:read:where.tmp", { state: "on" })]))
  expect(evaluate("external_directory", "/tmp/opencodeplus/bench/*", rules).effect).not.toBe("deny")
  expect(evaluate("external_directory", "/tmp/*", rules).effect).not.toBe("deny")
  expect(evaluate("external_directory", "/home/x/run/plus/tmp/opencodeplus/notes/*", rules).effect).not.toBe("deny")
  expect(evaluate("external_directory", "/etc/*", rules)).toMatchObject({
    effect: "deny",
    message:
      'paths outside this checkout are not available here; still allowed: Temporary directories (denied by item:project:theorysnap/:runner:perm:read:where.external "Outside this checkout, for every tool (external_directory)": off by default (nothing sets it))',
  })
  expect(externalRules(rules)).toEqual([
    {
      action: "external_directory",
      resource: "*",
      effect: "deny",
      message:
        'paths outside this checkout are not available here; still allowed: Temporary directories (denied by item:project:theorysnap/:runner:perm:read:where.external "Outside this checkout, for every tool (external_directory)": off by default (nothing sets it))',
    },
    { action: "external_directory", resource: "/tmp/*", effect: "allow" },
    { action: "external_directory", resource: "*/run/plus/tmp/*", effect: "allow" },
  ])
})

test("with Temporary directories off the refusal says nothing is still allowed and installs no allow", async () => {
  const { evaluate } = await import("../../core/src/permission.js")
  const rules = await rulesAfterApply("runner", inputFor([]))
  expect(evaluate("external_directory", "/tmp/opencodeplus/bench/*", rules)).toMatchObject({
    effect: "deny",
    message:
      'paths outside this checkout are not available here (denied by item:project:theorysnap/:runner:perm:read:where.external "Outside this checkout, for every tool (external_directory)": off by default (nothing sets it))',
  })
  expect(externalRules(rules).filter((rule) => rule.effect === "allow")).toEqual([])
})

test("with the rule row on nothing is installed and /etc is not refused", async () => {
  const { evaluate } = await import("../../core/src/permission.js")
  const rules = await rulesAfterApply(
    "runner",
    inputFor([change(runner, "perm:read:where.tmp", { state: "on" }), change(runner, "perm:read:where.external", { state: "on" })]),
  )
  expect(externalRules(rules)).toEqual([])
  expect(evaluate("external_directory", "/etc/*", rules).effect).not.toBe("deny")
})

test("a shipped preset member keeps the same opening under its own row", async () => {
  const { evaluate } = await import("../../core/src/permission.js")
  const member = linked("ocp-implementer", "implementer")
  const rules = await rulesAfterApply(member.id, presetInput({ members: [member] }))
  expect(evaluate("external_directory", "/tmp/x/*", rules).effect).not.toBe("deny")
  expect(evaluate("external_directory", "/etc/*", rules)).toMatchObject({
    effect: "deny",
    message:
      'paths outside this checkout are not available here; still allowed: Temporary directories (denied by item:project:opencodeplus-team/:ocp-implementer:perm:read:where.external "Outside this checkout, for every tool (external_directory)": off, from preset basic › implementer)',
  })
})

test("a read row that is off still refuses inside /tmp: the opening is only on external_directory", async () => {
  const { evaluate } = await import("../../core/src/permission.js")
  const rules = await rulesAfterApply(
    "runner",
    inputFor([change(runner, "perm:read:where.tmp", { state: "on" }), change(runner, "perm:read:files.keys", { state: "off" })]),
  )
  expect(evaluate("external_directory", "/tmp/*", rules).effect).not.toBe("deny")
  expect(evaluate("read", "/tmp/x/id_rsa", rules).effect).toBe("deny")
})
