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
    expect(sections[2]).toBe("## Deliverable\ncommit")
    expect(sections[3]).toContain("## Scope")
    expect(sections[3]).toContain("May edit: a.ts")
    expect(sections[4]).toBe("## Interfaces you touch\n- q.ts — parsed here")
    expect(sections[5]).toBe("## Decisions already made\n- Do not change the grammar")
    expect(sections[6]).toBe("## Checks (run with team_check)\n- q: bun test q.test.ts")
    expect(sections[7]).toContain("## Budget\neffort medium:")
    expect(out).toContain("## Extra instructions\nBe quick")
    expect(out.endsWith("\n")).toBe(true)
  })

  test("attached material over 40 KB is replaced with a pointer", () => {
    const big = "x".repeat(41 * 1024)
    const out = render(briefBase(), { budget: policy.effort.small, attached: { path: "big.md", content: big } })
    expect(out).toContain("content exceeds 40 KB, see file")
    expect(out).not.toContain(big.slice(0, 100))
    const small = render(briefBase(), { budget: policy.effort.small, attached: { path: "s.md", content: "hello" } })
    expect(small).toContain("## Attached material\nhello")
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
