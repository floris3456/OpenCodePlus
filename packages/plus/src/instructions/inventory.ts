// What Plus last wrote for an item plus the upstream text it replaced, so
// discovery can report upstream while the host still shows Plus's output.
// Prompts are keyed by agent id. File-backed agents additionally record the
// markdown body observed at baseline time (`file`): a later reread of that
// body is trusted as upstream only when `file` matched the host upstream at
// baseline time, proving the file owned the prompt; otherwise another config
// source owns it and the file is ignored. Tools and skills are keyed by item
// id (`tool:<id>`, `skill:<id>`) and never set `file`.
export interface PromptBaseline {
  readonly applied: string
  readonly upstream: string
  readonly file?: string
  readonly fileBacked: boolean
}

export interface ModelRefLike {
  readonly providerID: string
  readonly modelID: string
  readonly variant?: string
}

// Per-agent model baseline: what Plus installed (`applied`) plus the upstream
// model it replaced. Keyed by agent id. File-backed agents prefer their
// frontmatter reread, so they never need a baseline; only host-owned
// (non-file) agents retain one.
export interface ModelBaseline {
  readonly applied: ModelRefLike
  readonly upstream: ModelRefLike
}

export function sameModelRef(left: ModelRefLike | undefined, right: ModelRefLike | undefined): boolean {
  if (left === undefined || right === undefined) return left === right
  if (left.providerID !== right.providerID) return false
  if (left.modelID !== right.modelID) return false
  return (left.variant ?? "default") === (right.variant ?? "default")
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

// Model unmask: while the host agent model still shows exactly what Plus
// installed, report the retained upstream model instead. Any other host
// model is a genuine upstream edit and flows through untouched. File-backed
// agents never reach here: their upstream prefers the frontmatter reread,
// so host masking is irrelevant for them.
export function unmaskModel(
  current: ModelRefLike | undefined,
  baseline: ModelBaseline | undefined,
): ModelRefLike | undefined {
  if (baseline === undefined) return current
  if (!sameModelRef(current, baseline.applied)) return current
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
