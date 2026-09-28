// Minimal line diff over LCS: no dependencies, small enough to own. A
// trailing newline never adds a line, so "a\n" and "a" compare identical.
export function changedLines(original: string, modified: string): number {
  const left = linesOf(original)
  const right = linesOf(modified)
  const kept = lcsLength(left, right)
  return left.length - kept + (right.length - kept)
}

export interface DiffRange {
  readonly from: string
  readonly to: string
}

export interface UnifiedDiffOptions {
  /**
   * Context lines kept around each change. `Number.POSITIVE_INFINITY` keeps
   * every line in one hunk; the default is the compact 3 used by patches.
   */
  readonly context?: number
}

export function unifiedDiff(original: string, modified: string, range: DiffRange, options?: UnifiedDiffOptions): string {
  const left = linesOf(original)
  const right = linesOf(modified)
  const ops = script(left, right)
  const hunks = hunksOf(ops, options?.context ?? 3)
  if (hunks.length === 0) return ""
  const out = [`--- ${range.from}`, `+++ ${range.to}`]
  for (const hunk of hunks) out.push(...renderHunk(left, right, ops, hunk))
  return out.join("\n") + "\n"
}

export interface Merged {
  readonly text: string
  /** Regions both sides changed differently; each is fenced with conflict markers in `text`. */
  readonly conflicts: number
}

/**
 * Line three-way merge (diff3 style): the changes `original → upstream` are
 * applied onto `mine`. Regions both sides touched (overlapping, or an
 * insertion at the edge of the other side's change) merge cleanly when both
 * made the same change; otherwise they are fenced as
 *
 *   <<<<<<< yours / ======= / >>>>>>> upstream
 */
export function merge3(original: string, mine: string, upstream: string): Merged {
  const base = linesOf(original)
  const ours = regionsOf(base, linesOf(mine)).map((region) => ({ ...region, side: "mine" as const }))
  const theirs = regionsOf(base, linesOf(upstream)).map((region) => ({ ...region, side: "upstream" as const }))
  const all = [...ours, ...theirs].sort((left, right) => left.start - right.start || left.end - right.end)
  const out: string[] = []
  let cursor = 0
  let conflicts = 0
  let index = 0
  while (index < all.length) {
    const group = [all[index]!]
    let end = all[index]!.end
    index += 1
    // Overlapping regions conflict; so does an insertion at the edge of
    // another change (the order would be a guess). Two replacements of
    // neighbouring lines do not: each side changed its own lines.
    while (index < all.length && touches(all[index]!, end, group)) {
      group.push(all[index]!)
      end = Math.max(end, all[index]!.end)
      index += 1
    }
    const start = group[0]!.start
    out.push(...base.slice(cursor, start))
    cursor = end
    const mineRegions = group.filter((region) => region.side === "mine")
    const upstreamRegions = group.filter((region) => region.side === "upstream")
    const left = applyRegions(base, mineRegions, start, end)
    const right = applyRegions(base, upstreamRegions, start, end)
    if (mineRegions.length === 0) {
      out.push(...right)
      continue
    }
    if (upstreamRegions.length === 0 || left.join("\n") === right.join("\n")) {
      out.push(...left)
      continue
    }
    conflicts += 1
    out.push("<<<<<<< yours", ...left, "=======", ...right, ">>>>>>> upstream")
  }
  out.push(...base.slice(cursor))
  const trailing = mine.endsWith("\n") || (mine === "" && upstream.endsWith("\n"))
  return { text: out.join("\n") + (trailing && out.length > 0 ? "\n" : ""), conflicts }
}

function touches(region: Region, end: number, group: readonly Region[]): boolean {
  if (region.start < end) return true
  if (region.start > end) return false
  return region.start === region.end || group.some((other) => other.start === other.end && other.start === end)
}

interface Region {
  /** Replaced base lines [start, end); start === end is a pure insertion. */
  readonly start: number
  readonly end: number
  readonly lines: readonly string[]
}

function regionsOf(base: readonly string[], changed: readonly string[]): Region[] {
  const regions: Region[] = []
  let open: { start: number; end: number; lines: string[] } | undefined
  for (const edit of script(base, changed)) {
    if (edit.op === "keep") {
      if (open !== undefined) regions.push(open)
      open = undefined
      continue
    }
    open ??= { start: edit.left, end: edit.left, lines: [] }
    if (edit.op === "del") open.end = edit.left + 1
    if (edit.op === "ins") open.lines.push(changed[edit.right] ?? "")
  }
  if (open !== undefined) regions.push(open)
  return regions
}

function applyRegions(base: readonly string[], regions: readonly Region[], start: number, end: number): string[] {
  const out: string[] = []
  let cursor = start
  for (const region of regions) {
    out.push(...base.slice(cursor, region.start), ...region.lines)
    cursor = region.end
  }
  out.push(...base.slice(cursor, end))
  return out
}

function linesOf(text: string): string[] {
  if (text === "") return []
  const parts = text.split("\n")
  if (parts[parts.length - 1] === "") parts.pop()
  return parts
}

function lcsLength(left: readonly string[], right: readonly string[]): number {
  const widths = new Array<number>(right.length + 1).fill(0)
  const current = new Array<number>(right.length + 1).fill(0)
  for (let i = 1; i <= left.length; i++) {
    for (let j = 1; j <= right.length; j++) {
      current[j] = left[i - 1] === right[j - 1] ? (widths[j - 1] ?? 0) + 1 : Math.max(widths[j] ?? 0, current[j - 1] ?? 0)
    }
    for (let j = 0; j <= right.length; j++) widths[j] = current[j] ?? 0
  }
  return widths[right.length] ?? 0
}

type Op = "keep" | "del" | "ins"

interface Edit {
  readonly op: Op
  readonly left: number
  readonly right: number
}

function script(left: readonly string[], right: readonly string[]): Edit[] {
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
  const ops: Edit[] = []
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

interface Hunk {
  readonly start: number
  readonly end: number
}

function hunksOf(ops: readonly Edit[], context: number): Hunk[] {
  const changed = ops.map((op, index) => (op.op === "keep" ? -1 : index)).filter((index) => index >= 0)
  if (changed.length === 0) return []
  const hunks: Hunk[] = []
  let start = Math.max(0, (changed[0] ?? 0) - context)
  let prev = changed[0] ?? 0
  for (const index of changed.slice(1)) {
    if (index - prev > context * 2) {
      hunks.push({ start, end: Math.min(ops.length, prev + context + 1) })
      start = Math.max(0, index - context)
    }
    prev = index
  }
  hunks.push({ start, end: Math.min(ops.length, prev + context + 1) })
  return hunks
}

function renderHunk(left: readonly string[], right: readonly string[], ops: readonly Edit[], hunk: Hunk): string[] {
  let dels = 0
  let inss = 0
  for (let at = hunk.start; at < hunk.end; at++) {
    if (ops[at]?.op === "del") dels += 1
    if (ops[at]?.op === "ins") inss += 1
  }
  const first = ops[hunk.start]
  if (first === undefined) return []
  const leftCount = hunk.end - hunk.start - inss
  const rightCount = hunk.end - hunk.start - dels
  const leftStart = leftCount === 0 ? first.left : first.left + 1
  const rightStart = rightCount === 0 ? first.right : first.right + 1
  const lines = [`@@ -${leftStart},${leftCount} +${rightStart},${rightCount} @@`]
  for (let at = hunk.start; at < hunk.end; at++) {
    const op = ops[at]
    if (op === undefined) continue
    if (op.op === "keep") lines.push(` ${left[op.left] ?? ""}`)
    if (op.op === "del") lines.push(`-${left[op.left] ?? ""}`)
    if (op.op === "ins") lines.push(`+${right[op.right] ?? ""}`)
  }
  return lines
}
