import { describe, expect, test } from "bun:test"
import { budgetFor, render } from "../../src/teams/brief.js"
import { render as renderReport } from "../../src/teams/report.js"

const policy = {
  effort: {
    small: { turns: 25, tokens: 400000, wallMs: 1200000 },
    medium: { turns: 60, tokens: 1500000, wallMs: 3600000 },
    large: { turns: 150, tokens: 5000000, wallMs: 5400000 },
  },
}

function briefBase() {
  return {
    requestID: "T3-a",
    role: "muse-implementer" as const,
    objective: "Make instructions list filter by agent correctly in all cases here",
    deliverable: { kind: "commit" as const },
    scope: { paths: ["packages/plus/src/a.ts"], forbidden: [] as string[] },
    context: { interfaces: [], decisions: [] as string[] },
    checks: [],
    effort: "medium" as const,
  }
}

describe("brief", () => {
  test("budgetFor selects the effort row", () => {
    expect(budgetFor("small", policy)).toEqual(policy.effort.small)
    expect(budgetFor("large", policy)).toEqual(policy.effort.large)
  })

  test("render keeps the exact section layout", () => {
    const out = render(
      {
        ...briefBase(),
        task: "T3",
        scope: { paths: ["a.ts"], forbidden: ["b.ts"] },
        context: {
          interfaces: [{ path: "q.ts", note: "parsed here" }],
          decisions: ["Do not change the grammar"],
        },
        checks: [{ id: "q", argv: ["bun", "test", "q.test.ts"] }],
        prompt: "Be quick",
      },
      { budget: policy.effort.medium },
    )
    const sections = out.split("\n\n")
    expect(sections[0]).toBe("# Brief — T3 — muse-implementer")
    expect(sections[1].startsWith("## Objective\n")).toBe(true)
    expect(sections[2]).toBe("## Deliverable\ncommit: commit your changes with team_checkpoint; your parent lands them.")
    expect(sections[3]).toBe("## Scope\nMay edit: a.ts\nMust not touch: b.ts")
    expect(sections[4]).toBe("## Interfaces to read first\n- q.ts — parsed here")
    expect(sections[5]).toBe("## Decisions already made\n- Do not change the grammar")
    expect(sections[6]).toBe("## Checks\n- q: bun test q.test.ts")
    // The budget is advisory everywhere: the Brief says so in the same words the roles use.
    expect(sections[7]).toBe(
      "## Budget\neffort medium: about 1.5M tokens and 60 min. A guide, not a limit: if you need more, keep going and say why in your report.",
    )
    expect(out).toContain("## Extra instructions\nBe quick")
    expect(out.endsWith("\n")).toBe(true)
  })

  test("a read-only brief says so and shows no empty sections", () => {
    const out = render(
      { ...briefBase(), scope: { paths: [], forbidden: [] }, deliverable: { kind: "report" as const, format: "file:line list" } },
      { budget: policy.effort.small },
    )
    expect(out).toContain("## Deliverable\nreport (file:line list): answer in your team_finish summary.")
    expect(out).toContain("## Scope\nMay edit: nothing (read-only task)\n\n")
    for (const empty of ["Must not touch", "## Interfaces", "## Decisions", "## Checks", "## Review", "## Extra"]) expect(out).not.toContain(empty)
  })

  test("a review brief names the exact diff call and the delegating run's check results", () => {
    const from = "a".repeat(40)
    const to = "b".repeat(40)
    const out = render(
      { ...briefBase(), scope: { paths: [], forbidden: [] }, deliverable: { kind: "findings" as const } },
      { budget: policy.effort.small, review: { run: "w-0123456789abcdef", from, to, checks: [{ id: "unit", passed: true }, { id: "lint", passed: false }, { id: "e2e", passed: null }] } },
    )
    expect(out).toContain(
      `## Review\nYour worktree holds the change's end state (${to.slice(0, 12)}). See the change with team_diff {run: "w-0123456789abcdef", from: "${from}"}; when the objective names one task's commits, review those alone (from: the commit before them).\nChecks at ${to.slice(0, 12)}: unit pass, lint FAIL, e2e not run.`,
    )
    const nothing = render(
      { ...briefBase(), deliverable: { kind: "findings" as const } },
      { budget: policy.effort.small, review: { run: "w-0123456789abcdef", from: to, to, checks: [] } },
    )
    expect(nothing).toContain(`Nothing has landed since ${to.slice(0, 12)}`)
    expect(nothing).toContain(`Checks at ${to.slice(0, 12)}: none recorded.`)
  })

  test("attached material over 40 KB is replaced with a pointer", () => {
    const big = "x".repeat(41 * 1024)
    const out = render(briefBase(), { budget: policy.effort.small, attached: { path: "big.md", content: big } })
    expect(out).toContain("## Attached: big.md\n(41984 bytes, over 40 KB: read the file itself.)")
    expect(out).not.toContain(big.slice(0, 100))
    const small = render(briefBase(), { budget: policy.effort.small, attached: { path: "s.md", content: "hello" } })
    expect(small).toContain("## Attached: s.md\nhello")
  })
})

describe("report", () => {
  test("render lists commits, sorted checks, and conditional sections", () => {
    const head = "a".repeat(40)
    const out = renderReport(
      {
        status: "blocked",
        summary: "Stuck on scope",
        concerns: ["flaky"],
        needs: [{ kind: "path", detail: "need x.ts" }],
        deferred: ["later"],
        findings: [{ severity: "warning", path: "a.ts", detail: "smell" }],
      },
      {
        run: "w-0123456789abcdef",
        attempt: 2,
        head,
        commits: [{ sha: head, subject: "feat: thing" }],
        checks: [
          { id: "b", passed: false },
          { id: "a", passed: true },
        ],
      },
    )
    expect(out.split("\n\n")[0]).toBe("# Report — w-0123456789abcdef — attempt 2 — blocked")
    expect(out).toContain(`- ${head.slice(0, 7)} feat: thing`)
    expect(out).toContain(`## Checks at ${head.slice(0, 7)}\n- a: pass\n- b: FAIL`)
    expect(out).toContain("## Concerns\n- flaky")
    expect(out).toContain("## Needs\n- path: need x.ts")
    expect(out).toContain("## Deferred\n- later")
    expect(out).toContain("## Findings\n- warning a.ts: smell")
  })

  test("needs only render for blocked-family statuses", () => {
    const withNeeds = { status: "done" as const, summary: "ok", needs: [{ kind: "path" as const, detail: "x" }] }
    const out = renderReport(withNeeds, { run: "r", attempt: 1, head: "", commits: [], checks: [] })
    expect(out).not.toContain("## Needs")
    expect(out).toContain("## Commits\n- none")
    expect(out).toContain("## Checks at unknown\n- none")
  })
})
