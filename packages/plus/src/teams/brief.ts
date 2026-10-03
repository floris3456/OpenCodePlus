import type { Brief, ResolvedBrief } from "./schema.js"

export interface Budget {
  turns: number
  tokens: number
  wallMs: number
}

type EffortKey = "small" | "medium" | "large"

export function budgetFor(effort: EffortKey, policy: { effort: Record<EffortKey, Budget> }): Budget {
  return policy.effort[effort]
}

/**
 * What a review needs that only the delegating run knows: where the change
 * under review starts (the reviewer's own worktree is where it ends), and the
 * delegating run's own check results there. A reviewer can neither run checks
 * nor read another run's status, so both travel in its Brief.
 */
export interface ReviewContext {
  /** The reviewer's own run id, for the exact team_diff call. */
  readonly run: string
  /** The commit the change under review starts from. */
  readonly from: string
  /** The commit the reviewer's worktree starts at: the end of the change. */
  readonly to: string
  /** The delegating run's checks at `to`; empty when it has none. */
  readonly checks: readonly { readonly id: string; readonly passed: boolean | null }[]
}

export interface RenderFilled {
  budget: Budget
  attached?: { path: string; content: string }
  review?: ReviewContext
}

const ATTACH_CAP = 40 * 1024

// One line per deliverable: what "done" means for it, so the child knows what
// to hand back without reading the tool schema.
const DELIVERABLE_MEANING: Readonly<Record<Brief["deliverable"]["kind"], string>> = {
  commit: "commit your changes with team_checkpoint; your parent lands them",
  report: "answer in your team_finish summary",
  plan: "write the plan file, commit it with team_checkpoint and name it in your team_finish summary",
  findings: "report each finding in team_finish findings; none is explicit approval",
}

function short(sha: string): string {
  return sha.slice(0, 12)
}

function tokens(n: number): string {
  return n >= 1_000_000 ? `${Number((n / 1_000_000).toFixed(1))}M` : `${Math.round(n / 1000)}k`
}

function minutes(ms: number): string {
  return `${Math.round(ms / 60_000)} min`
}

export function render(brief: ResolvedBrief, filled: RenderFilled): string {
  const taskOrReq = brief.task ?? brief.requestID
  const paths = brief.scope?.paths ?? []
  const forbidden = brief.scope?.forbidden ?? []
  const interfaces = brief.context?.interfaces ?? []
  const decisions = brief.context?.decisions ?? []
  const checks = brief.checks ?? []
  const effort = brief.effort ?? "medium"
  const budget = filled.budget

  const sections: string[] = []
  sections.push(`# Brief — ${taskOrReq} — ${brief.role}`)
  sections.push(`## Objective\n${brief.objective}`)
  const kind = brief.deliverable.kind
  const format = brief.deliverable.format === undefined ? "" : ` (${brief.deliverable.format})`
  sections.push(`## Deliverable\n${kind}${format}: ${DELIVERABLE_MEANING[kind]}.`)
  const scope = [`May edit: ${paths.length === 0 ? "nothing (read-only task)" : paths.join(", ")}`]
  if (forbidden.length > 0) scope.push(`Must not touch: ${forbidden.join(", ")}`)
  sections.push(`## Scope\n${scope.join("\n")}`)
  if (interfaces.length > 0)
    sections.push(`## Interfaces to read first\n${interfaces.map((i) => `- ${i.path}${i.symbol ? `#${i.symbol}` : ""} — ${i.note}`).join("\n")}`)
  if (decisions.length > 0) sections.push(`## Decisions already made\n${decisions.map((d) => `- ${d}`).join("\n")}`)
  if (checks.length > 0)
    sections.push(`## Checks (run with team_check; all must pass for done)\n${checks.map((c) => `- ${c.id}: ${c.argv.join(" ")}`).join("\n")}`)
  if (filled.review !== undefined) sections.push(reviewSection(filled.review))
  sections.push(
    `## Budget\neffort ${effort}: about ${tokens(budget.tokens)} tokens and ${minutes(budget.wallMs)}. A guide, not a limit: if you need more, keep going and say why in your report.`,
  )
  if (brief.prompt !== undefined && brief.prompt.trim() !== "") sections.push(`## Extra instructions\n${brief.prompt}`)
  if (filled.attached !== undefined) {
    const attached = filled.attached
    const bytes = Buffer.byteLength(attached.content, "utf8")
    if (bytes > ATTACH_CAP)
      sections.push(`## Attached: ${attached.path}\n(${bytes} bytes, over 40 KB: read the file itself.)`)
    else sections.push(`## Attached: ${attached.path}\n${attached.content}`)
  }
  return sections.join("\n\n") + "\n"
}

function reviewSection(review: ReviewContext): string {
  const lines = [`## Review`]
  if (review.from === review.to)
    lines.push(`Nothing has landed since ${short(review.from)}: review the files the objective names, as they are in your worktree.`)
  else
    lines.push(
      `Your worktree holds the change's end state (${short(review.to)}). See the change with team_diff {run: "${review.run}", from: "${review.from}"}.`,
    )
  const results =
    review.checks.length === 0
      ? "none recorded"
      : review.checks.map((check) => `${check.id} ${check.passed === null ? "not run" : check.passed ? "pass" : "FAIL"}`).join(", ")
  lines.push(`Checks at ${short(review.to)} (you cannot run checks): ${results}.`)
  return lines.join("\n")
}
