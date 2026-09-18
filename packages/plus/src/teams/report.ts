import type { Finding, Need, ReportStatus } from "./schema.js"

export interface ReportCommit {
  sha: string
  subject: string
}

export interface ReportCheck {
  id: string
  passed: boolean
  head?: string
  at?: number | string
}

export interface ReportInput {
  status: ReportStatus
  summary: string
  concerns?: string[]
  needs?: Need[]
  deferred?: string[]
  findings?: Finding[]
}

export interface ReportFilled {
  run: string
  attempt: number
  head: string
  commits: ReportCommit[]
  checks: ReportCheck[]
}

type RenderReport = ReportInput & Partial<ReportFilled>
type RenderFilled = Partial<ReportFilled>

const NEEDS_STATUSES: ReadonlySet<string> = new Set(["blocked", "needs_context", "rejected"])

function short7(sha: string): string {
  return sha.length >= 7 ? sha.slice(0, 7) : sha
}

export function render(report: RenderReport, filled?: RenderFilled): string {
  const f = filled ?? {}
  const run = f.run ?? report.run ?? "unknown"
  const attempt = f.attempt ?? report.attempt ?? 1
  const head = f.head ?? report.head ?? ""
  const commits = f.commits ?? report.commits ?? []
  const checks = f.checks ?? report.checks ?? []
  const status: string = report.status
  const summary: string = report.summary ?? ""
  const concerns = report.concerns ?? []
  const needs = report.needs ?? []
  const deferred = report.deferred ?? []
  const findings = report.findings ?? []

  const sections: string[] = []
  sections.push(`# Report — ${run} — attempt ${attempt} — ${status}`)
  sections.push(summary)

  const commitBody = commits.length === 0 ? "- none" : commits.map((c) => `- ${short7(c.sha)} ${c.subject}`).join("\n")
  sections.push(`## Commits\n${commitBody}`)

  const head7 = head ? short7(head) : "unknown"
  const sortedChecks = [...checks].sort((a, b) => a.id.localeCompare(b.id))
  const checksBody =
    sortedChecks.length === 0 ? "- none" : sortedChecks.map((c) => `- ${c.id}: ${c.passed ? "pass" : "FAIL"}`).join("\n")
  sections.push(`## Checks at ${head7}\n${checksBody}`)

  if (concerns.length > 0) sections.push(`## Concerns\n${concerns.map((c) => `- ${c}`).join("\n")}`)
  if (NEEDS_STATUSES.has(status) && needs.length > 0)
    sections.push(`## Needs\n${needs.map((n) => `- ${n.kind}: ${n.detail}`).join("\n")}`)
  if (deferred.length > 0) sections.push(`## Deferred\n${deferred.map((d) => `- ${d}`).join("\n")}`)
  if (findings.length > 0)
    sections.push(`## Findings\n${findings.map((x) => `- ${x.severity} ${x.path}: ${x.detail}`).join("\n")}`)

  return sections.join("\n\n") + "\n"
}
