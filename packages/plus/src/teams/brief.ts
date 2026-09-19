import type { Brief } from "./schema.js"

export interface Budget {
  turns: number
  tokens: number
  wallMs: number
}

type EffortKey = "small" | "medium" | "large"

export function budgetFor(effort: EffortKey, policy: { effort: Record<EffortKey, Budget> }): Budget {
  return policy.effort[effort]
}

export interface RenderFilled {
  budget: Budget
  attached?: { path: string; content: string }
}

const ATTACH_CAP = 40 * 1024

export function render(brief: Brief, filled: RenderFilled): string {
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
  const deliverableLine =
    brief.deliverable.format !== undefined
      ? `${brief.deliverable.kind} — ${brief.deliverable.format}`
      : `${brief.deliverable.kind}`
  sections.push(`## Deliverable\n${deliverableLine}`)
  sections.push(`## Scope\nMay edit: ${paths.join(", ")}        Must not touch: ${forbidden.join(", ")}`)
  const ifaceBody = interfaces.map((i) => `- ${i.path}${i.symbol ? `#${i.symbol}` : ""} — ${i.note}`).join("\n")
  sections.push(`## Interfaces you touch\n${ifaceBody}`)
  sections.push(`## Decisions already made\n${decisions.map((d) => `- ${d}`).join("\n")}`)
  sections.push(`## Checks (run with team_check)\n${checks.map((c) => `- ${c.id}: ${c.argv.join(" ")}`).join("\n")}`)
  sections.push(
    `## Budget\neffort ${effort}: about ${budget.turns} turns / ${budget.tokens} tokens / ${budget.wallMs}ms wall. Stop and report before exhausting it.`,
  )
  if (brief.prompt !== undefined && brief.prompt.trim() !== "") sections.push(`## Extra instructions\n${brief.prompt}`)
  if (filled.attached !== undefined) {
    const attached = filled.attached
    const bytes = Buffer.byteLength(attached.content, "utf8")
    if (bytes > ATTACH_CAP)
      sections.push(`## Attached material\nPath: ${attached.path} (${bytes} bytes; content exceeds 40 KB, see file).`)
    else sections.push(`## Attached material\n${attached.content}`)
  }
  return sections.join("\n\n") + "\n"
}
