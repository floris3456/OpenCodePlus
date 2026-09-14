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

// Item enablement as the host provides it: tools, skills, base prompts, and
// system rows carry no per-item disable flag upstream, so they are always
// enabled at discovery. Plus records layer on top through resolution (the
// shared `level: "defaults"`, `agent: null` row carries shared toggles);
// folding them into `Item.enabled` hides whole-item offs from apply's
// no-op check and installs nothing while the tree shows `[off]`.
export function upstreamEnabled(): boolean {
  return true
}
