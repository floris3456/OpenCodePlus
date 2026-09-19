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
// (non-file) agents retain one. `upstream` may be absent: an absent upstream
// is information (the host owned no model), not "nothing to record", and must
// be preserved so the next discovery unmasks Plus's own output back to absent
// instead of reporting it as upstream.
export interface ModelBaseline {
  readonly applied: ModelRefLike
  readonly upstream: ModelRefLike | undefined
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
// agents whose frontmatter defines a model never reach here; file agents
// without a defining model fall through to the host and unmask like any
// other agent.
export function unmaskModel(
  current: ModelRefLike | undefined,
  baseline: ModelBaseline | undefined,
): ModelRefLike | undefined {
  if (baseline === undefined) return current
  if (!sameModelRef(current, baseline.applied)) return current
  return baseline.upstream
}

// Team member unmask: built-in (and file) team installs write full agent
// fields — description, mode, and a permissions allowlist/denylist — through
// the shared applyTeamAgent, but the prompt/model baselines above cover only
// system text and model. While the host still shows exactly what the team
// member installed (system body plus every defined field, permissions as a
// superset since core defaults remain), the host entry is Plus output and
// must report upstream (absent) instead of flipping the publish fingerprint
// into a dispose/reinstall loop. Any divergence is a genuine upstream edit
// and flows through untouched so the team correctly loses to it.
export interface TeamAppliedFields {
  readonly description?: string
  readonly mode?: string
  readonly hidden?: boolean
  readonly color?: string
  readonly steps?: number
  readonly permissions: readonly { readonly action: string; readonly resource: string; readonly effect: string }[]
  readonly model?: string
  readonly variant?: string
}

export function matchesTeamApplied(
  host: { readonly system?: string; readonly description?: string; readonly mode?: string; readonly hidden?: boolean; readonly color?: string; readonly steps?: number; readonly permissions: readonly { readonly action: string; readonly resource: string; readonly effect: string }[]; readonly model?: { readonly providerID: string; readonly id: string; readonly variant?: string } },
  appliedBody: string,
  applied: TeamAppliedFields,
): boolean {
  if ((host.system ?? "") !== appliedBody) return false
  if (applied.description !== undefined && host.description !== applied.description) return false
  if (applied.mode !== undefined && host.mode !== applied.mode) return false
  if (applied.hidden !== undefined && host.hidden !== applied.hidden) return false
  if (applied.color !== undefined && host.color !== applied.color) return false
  if (applied.steps !== undefined && host.steps !== applied.steps) return false
  if (applied.model !== undefined) {
    const suffixed = applied.variant === undefined || applied.model.includes("#") ? applied.model : `${applied.model}#${applied.variant}`
    const slash = suffixed.indexOf("/")
    const hash = suffixed.lastIndexOf("#")
    const wantProvider = slash === -1 ? "" : suffixed.slice(0, slash)
    const wantModel = slash === -1 ? "" : hash === -1 ? suffixed.slice(slash + 1) : suffixed.slice(slash + 1, hash)
    const wantVariant = hash === -1 ? undefined : suffixed.slice(hash + 1)
    // An unparseable model never reaches the host (applyTeamAgent leaves the
    // registry entry untouched), so it cannot identify Plus output; skip the
    // model check rather than mismatching a genuine upstream model into a loop.
    if (wantProvider.length > 0 && wantModel.length > 0) {
      if (host.model === undefined) return false
      if (String(host.model.providerID) !== wantProvider) return false
      if (String(host.model.id) !== wantModel) return false
      const gotVariant = host.model.variant === undefined ? undefined : String(host.model.variant)
      if ((gotVariant ?? "default") !== (wantVariant ?? "default")) return false
    }
  }
  for (const rule of applied.permissions) {
    const found = host.permissions.some(
      (entry) => entry.action === rule.action && entry.resource === rule.resource && entry.effect === rule.effect,
    )
    if (!found) return false
  }
  return true
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
