// Structured sentence-level three-way merge for markdown instructions.
//
// A whole-line merge treats a prose paragraph as one line, so two edits in it
// always conflict. This module instead segments each side into
// small units (sentences of a prose paragraph, headings, list items, table
// rows, fenced blocks, blank runs), diffs base→yours and base→upstream on
// those units, aligns the two diffs into entries, and renders the merged text
// from an inclusion set that defaults to showing both sides without markers.
export function segmentUnits(text: string): string[] {
  if (text === "") return []
  const lines = text.split("\n")
  const trailing = lines[lines.length - 1] === ""
  if (trailing) lines.pop()
  const units: string[] = []
  let at = 0
  while (at < lines.length) {
    const line = lines[at] ?? ""
    if (isBlank(line)) {
      const start = at
      while (at < lines.length && isBlank(lines[at] ?? "")) at += 1
      units.push(joinLines(lines, start, at, trailing))
      continue
    }
    if (isFence(line)) {
      const start = at
      at += 1
      while (at < lines.length && !isFence(lines[at] ?? "")) at += 1
      if (at < lines.length) at += 1
      units.push(joinLines(lines, start, at, trailing))
      continue
    }
    if (isHeading(line) || isTableRow(line)) {
      units.push(joinLines(lines, at, at + 1, trailing))
      at += 1
      continue
    }
    if (isListItem(line)) {
      const start = at
      at += 1
      while (at < lines.length && isContinuation(lines[at] ?? "")) at += 1
      units.push(joinLines(lines, start, at, trailing))
      continue
    }
    const start = at
    while (at < lines.length && isProse(lines[at] ?? "")) at += 1
    const paragraph = joinLines(lines, start, at, trailing)
    units.push(...splitSentences(paragraph))
  }
  return units
}

export type MergeKind = "yours" | "upstream" | "both" | "same"

export interface UnchangedUnit {
  readonly type: "unchanged"
  readonly text: string
}

export interface MergeChange {
  readonly type: "change"
  /** Stable toggle id ("m0", "m1", …) in entry order. */
  readonly id: string
  readonly kind: MergeKind
  /** Base span units this entry replaces. */
  readonly base: readonly string[]
  /** Yours replacement units (base when kind is "upstream"). */
  readonly yours: readonly string[]
  /** Upstream replacement units (base when kind is "yours"). */
  readonly upstream: readonly string[]
  /**
   * Second toggle id for kind "both" (the upstream side). Defaults to
   * excluded while `id` (the yours side) defaults to included.
   */
  readonly upstreamId?: string
  /** Default inclusion of `id`. Always true; the "both" upstream side defaults off. */
  readonly included: boolean
}

export type MergeEntry = UnchangedUnit | MergeChange

/**
 * Three-way merge on units: diffs base→yours and base→upstream, then aligns
 * overlapping (or edge-touching insertion) regions into one entry per group,
 * the way a line merge groups line regions. Unchanged gaps stay per-unit
 * entries so the order is explicit.
 */
export function mergeUnits(base: string, yours: string, upstream: string): MergeEntry[] {
  const baseUnits = segmentUnits(base)
  const ours = regionsOf(baseUnits, segmentUnits(yours)).map((region) => ({ ...region, side: "mine" as const }))
  const theirs = regionsOf(baseUnits, segmentUnits(upstream)).map((region) => ({ ...region, side: "upstream" as const }))
  const all = [...ours, ...theirs].sort((left, right) => left.start - right.start || left.end - right.end)
  const entries: MergeEntry[] = []
  let cursor = 0
  let changes = 0
  let index = 0
  while (index < all.length) {
    const group = [all[index]!]
    let end = all[index]!.end
    index += 1
    while (index < all.length && touches(all[index]!, end, group)) {
      group.push(all[index]!)
      end = Math.max(end, all[index]!.end)
      index += 1
    }
    const start = group[0]!.start
    for (const unit of baseUnits.slice(cursor, start)) entries.push({ type: "unchanged", text: unit })
    cursor = end
    const mineRegions = group.filter((region) => region.side === "mine")
    const upstreamRegions = group.filter((region) => region.side === "upstream")
    const span = baseUnits.slice(start, end)
    const left = applyRegions(baseUnits, mineRegions, start, end)
    const right = applyRegions(baseUnits, upstreamRegions, start, end)
    const id = `m${changes}`
    changes += 1
    if (mineRegions.length === 0) {
      entries.push({ type: "change", id, kind: "upstream", base: span, yours: span, upstream: right, included: true })
      continue
    }
    if (upstreamRegions.length === 0) {
      entries.push({ type: "change", id, kind: "yours", base: span, yours: left, upstream: span, included: true })
      continue
    }
    if (left.join("") === right.join("")) {
      entries.push({ type: "change", id, kind: "same", base: span, yours: left, upstream: right, included: true })
      continue
    }
    entries.push({ type: "change", id, kind: "both", base: span, yours: left, upstream: right, upstreamId: `${id}:upstream`, included: true })
  }
  for (const unit of baseUnits.slice(cursor)) entries.push({ type: "unchanged", text: unit })
  return entries
}

/** Default inclusion: every change entry's `id`; a "both" upstream side stays off. */
export function defaultInclude(entries: readonly MergeEntry[]): Set<string> {
  const include = new Set<string>()
  for (const entry of entries) {
    if (entry.type === "change" && entry.included) include.add(entry.id)
  }
  return include
}

/**
 * Merged text: unchanged units always; a change entry shows its replacement
 * when included, else its base span. A "both" entry shows yours then upstream
 * when both sides are included, so even that never emits conflict markers.
 */
export function renderMerge(entries: readonly MergeEntry[], include: ReadonlySet<string>): string {
  const out: string[] = []
  for (const entry of entries) {
    if (entry.type === "unchanged") {
      out.push(entry.text)
      continue
    }
    if (entry.kind === "both") {
      const yoursOn = include.has(entry.id)
      const upstreamOn = entry.upstreamId !== undefined && include.has(entry.upstreamId)
      if (yoursOn) out.push(...entry.yours)
      // Yours is the last unit of its text when it lacks a final newline: keep upstream on its own line.
      if (yoursOn && upstreamOn && !endsLine(entry.yours)) out.push("\n")
      if (upstreamOn) out.push(...entry.upstream)
      if (!yoursOn && !upstreamOn) out.push(...entry.base)
      continue
    }
    out.push(...(include.has(entry.id) ? entryYours(entry) : entry.base))
  }
  return out.join("")
}

function entryYours(entry: MergeChange): readonly string[] {
  return entry.kind === "upstream" ? entry.upstream : entry.yours
}

function endsLine(units: readonly string[]): boolean {
  const last = units[units.length - 1]
  return last === undefined || last === "" || last.endsWith("\n")
}

function joinLines(lines: readonly string[], start: number, end: number, trailing: boolean): string {
  const slice = lines.slice(start, end)
  const text = slice.join("\n")
  return end < lines.length || trailing ? `${text}\n` : text
}

function isBlank(line: string): boolean {
  return /^\s*$/.test(line)
}

function isFence(line: string): boolean {
  return /^\s*(`{3,}|~{3,})/.test(line)
}

function isHeading(line: string): boolean {
  return /^\s*#{1,6}(?=\s|$)/.test(line)
}

function isTableRow(line: string): boolean {
  return /^\s*\|/.test(line)
}

function isListItem(line: string): boolean {
  return /^\s*(?:[-+*]|\d+[.)])\s+/.test(line)
}

function isContinuation(line: string): boolean {
  if (!/^\s+\S/.test(line)) return false
  return !isFence(line) && !isHeading(line) && !isTableRow(line) && !isListItem(line)
}

function isProse(line: string): boolean {
  return !isBlank(line) && !isFence(line) && !isHeading(line) && !isTableRow(line) && !isListItem(line)
}

/**
 * Split after `.`, `!`, `?` followed by whitespace, keeping the whitespace
 * with the preceding sentence. A lowercase letter after the whitespace
 * (as in "e.g. this") keeps the sentences together.
 */
function splitSentences(paragraph: string): string[] {
  const parts: string[] = []
  let start = 0
  for (let at = 0; at < paragraph.length; at += 1) {
    const mark = paragraph[at]
    if (mark !== "." && mark !== "!" && mark !== "?") continue
    let end = at + 1
    while (end < paragraph.length && isSpace(paragraph[end] ?? "")) end += 1
    if (end === at + 1 || end >= paragraph.length) continue
    const next = paragraph[end] ?? ""
    if (next >= "a" && next <= "z") continue
    parts.push(paragraph.slice(start, end))
    start = end
    at = end - 1
  }
  const rest = paragraph.slice(start)
  if (rest !== "") parts.push(rest)
  return parts
}

function isSpace(char: string): boolean {
  return char === " " || char === "\t" || char === "\n" || char === "\r" || char === "\f" || char === "\v"
}

function touches(region: UnitRegion, end: number, group: readonly UnitRegion[]): boolean {
  if (region.start < end) return true
  if (region.start > end) return false
  return region.start === region.end || group.some((other) => other.start === other.end && other.start === end)
}

interface UnitRegion {
  /** Replaced base units [start, end); start === end is a pure insertion. */
  readonly start: number
  readonly end: number
  readonly units: readonly string[]
}

function regionsOf(base: readonly string[], changed: readonly string[]): UnitRegion[] {
  const regions: { start: number; end: number; units: string[] }[] = []
  let open: { start: number; end: number; units: string[] } | undefined
  for (const edit of unitScript(base, changed)) {
    if (edit.op === "keep") {
      if (open !== undefined) regions.push(open)
      open = undefined
      continue
    }
    open ??= { start: edit.left, end: edit.left, units: [] }
    if (edit.op === "del") open.end = edit.left + 1
    if (edit.op === "ins") open.units.push(changed[edit.right] ?? "")
  }
  if (open !== undefined) regions.push(open)
  return regions
}

function applyRegions(base: readonly string[], regions: readonly UnitRegion[], start: number, end: number): string[] {
  const out: string[] = []
  let cursor = start
  for (const region of regions) {
    out.push(...base.slice(cursor, region.start), ...region.units)
    cursor = region.end
  }
  out.push(...base.slice(cursor, end))
  return out
}

type UnitOp = "keep" | "del" | "ins"

interface UnitEdit {
  readonly op: UnitOp
  readonly left: number
  readonly right: number
}

function unitScript(left: readonly string[], right: readonly string[]): UnitEdit[] {
  const rows = left.length + 1
  const cols = right.length + 1
  const table: number[][] = Array.from({ length: rows }, () => new Array<number>(cols).fill(0))
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      const row = table[i + 1]
      const next = table[i]
      if (next === undefined || row === undefined) continue
      next[j] = left[i] === right[j] ? (row[j + 1] ?? 0) + 1 : Math.max(row[j] ?? 0, next[j + 1] ?? 0)
    }
  }
  const ops: UnitEdit[] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      ops.push({ op: "keep", left: i, right: j })
      i += 1
      j += 1
      continue
    }
    const row = table[i + 1]
    const next = table[i]
    if ((row?.[j] ?? 0) >= (next?.[j + 1] ?? 0)) {
      ops.push({ op: "del", left: i, right: j })
      i += 1
    } else {
      ops.push({ op: "ins", left: i, right: j })
      j += 1
    }
  }
  while (i < left.length) {
    ops.push({ op: "del", left: i, right: j })
    i += 1
  }
  while (j < right.length) {
    ops.push({ op: "ins", left: i, right: j })
    j += 1
  }
  return ops
}
