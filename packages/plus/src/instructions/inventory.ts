import type { CustomizationRecord } from "./model.js"

// What Plus last wrote for an item plus the upstream text it replaced, so
// discovery can report upstream while the host still shows Plus's output.
// Prompts are keyed by agent id (file-backed agents additionally reread
// their markdown body); tools and skills are keyed by item id
// (`tool:<id>`, `skill:<id>`).
export interface PromptBaseline {
  readonly applied: string
  readonly upstream: string
  readonly file?: string
  readonly fileBacked: boolean
}

// Plus's transforms rewrite the host text that the next discovery reads
// back, so treating that as upstream would flip the publish fingerprint on
// every pass and produce a permanent dispose/reinstall storm. While the
// host still shows exactly what Plus last wrote, report the retained
// upstream instead; any other host text is a genuine upstream edit and
// flows through untouched.
export function unmaskText(current: string, baseline: PromptBaseline | undefined): string {
  if (baseline === undefined) return current
  if (current !== baseline.applied) return current
  return baseline.upstream
}

// Upstream enablement for tools, base prompts, skills, and system rows is
// not observable per item, so these default to enabled unless a Plus whole-
// item record says otherwise. `agents` is the item's agent scope: shared
// items (undefined) only honor the Defaults shared row, while per-agent
// items honor their own agent's records plus the shared row. The latest
// record by `updated` wins.
export function recordedEnabled(
  records: readonly CustomizationRecord[],
  item: string,
  agents: readonly string[] | undefined,
): boolean {
  const candidates = records.filter(
    (record) =>
      record.item === item &&
      record.section === null &&
      record.state !== undefined &&
      (record.agent === null || agents?.includes(record.agent) === true),
  )
  const latest = candidates.toSorted((left, right) =>
    left.updated < right.updated ? 1 : left.updated > right.updated ? -1 : 0,
  )[0]
  if (latest?.state === "off") return false
  return true
}
