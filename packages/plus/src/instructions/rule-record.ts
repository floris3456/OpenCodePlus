import type { Plus } from "../rpc.js"
import { catalogueField, scopedTo, type RuleRecord } from "./model.js"
import type { StoredRecord } from "./store.js"
import { validateRuleInput } from "./tool-permissions.js"

// The record a new rule writes, or why it cannot: shared by addRule and a
// staged list (staged.ts), which writes it with the list's other rows.
export function ruleRecordFor(
  input: Plus.RuleAddInput,
  records: readonly StoredRecord[],
):
  | { ok: true; record: RuleRecord }
  | { ok: false; error: { code: "rule.invalid"; message: string; data: Plus.RuleInvalid } | { code: "rule.exists"; message: string; data: Plus.RuleExists } } {
  const validated = validateRuleInput({
    tool: input.tool,
    id: input.id,
    label: input.label,
    patterns: input.patterns,
    ...(input.keywords === undefined ? {} : { keywords: input.keywords }),
    ...(input.message === undefined ? {} : { message: input.message }),
  })
  if (!validated.ok)
    return { ok: false, error: { code: "rule.invalid", message: validated.reason, data: { tool: input.tool, id: input.id, reason: validated.reason } } }
  const existing = records.find(
    (record): record is RuleRecord => record.type === "rule" && record.tool === validated.tool && record.id === validated.id && scopedTo(record, input),
  )
  if (existing !== undefined)
    return {
      ok: false,
      error: {
        code: "rule.exists",
        message: `Rule ${validated.tool}:${validated.id} already exists`,
        data: { level: existing.level, agent: existing.agent, tool: validated.tool, id: validated.id },
      },
    }
  return {
    ok: true,
    record: {
      type: "rule",
      level: input.level,
      agent: input.agent,
      ...catalogueField({ agent: input.agent, ...(input.catalogue === undefined ? {} : { catalogue: input.catalogue }) }),
      ...(input.team === undefined ? {} : { team: input.team }),
      tool: validated.tool,
      id: validated.id,
      label: validated.label,
      patterns: validated.patterns,
      keywords: validated.keywords,
      ...(validated.message === undefined ? {} : { message: validated.message }),
      updated: new Date().toISOString(),
    },
  }
}
