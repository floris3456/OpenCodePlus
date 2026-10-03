// Instructions that follow capabilities.
//
// A markdown section of an instruction text (a role, an instruction file, the
// Tools and rules row) may say which rows it depends on, on the first line
// under its heading:
//
//   ## Integration checks
//   <!-- requires: tool:team_set_checks -->
//
// Each id is a row's item id (`tool:<id>`, `skill:<id>`, `mcp:<server>`,
// `perm:<tool>:<rule>`); `!<id>` means the row must be off (guidance that
// belongs to a restriction). For each agent, a section whose rows do not
// resolve that way is left out with its subsections, and every marker is
// removed before the model reads the text. A row the agent does not have
// meets neither form: its tool's instructions are not for it, and neither is
// a restriction on a tool it never had. So turning a tool, skill or rule on or off for an agent also
// adds or removes the instructions that belong to it, at every level the
// row resolves through, without anyone editing the text.
//
// The dependency is explicit, never inferred from a mention: one mention of a
// tool that is off would otherwise drop a section full of unrelated rules,
// and "you cannot run checks" mentions what it denies. `mentionWarnings` finds
// the mentions a marker does not cover, so the Instructions tree can flag them.

export interface Requirement {
  /** The row's item id. */
  readonly id: string
  /** True: the row must be on. False (`!id`): it must be off. */
  readonly on: boolean
}

export interface GatedSection {
  /** Offset of the heading line. */
  readonly start: number
  /** Offset where the section ends (the next heading at its depth or above, or the end). */
  readonly end: number
  readonly depth: number
  readonly name: string
  readonly requires: readonly Requirement[]
}

const MARKER = /^[ \t]*<!--\s*requires:\s*(.*?)\s*-->[ \t]*$/

export function parseRequirements(list: string): Requirement[] {
  return list
    .split(/[,\s]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0)
    .map((token) => (token.startsWith("!") ? { id: token.slice(1), on: false } : { id: token, on: true }))
}

interface Line {
  readonly start: number
  readonly text: string
}

function lines(text: string): Line[] {
  const out: Line[] = []
  let start = 0
  for (;;) {
    const end = text.indexOf("\n", start)
    out.push({ start, text: end === -1 ? text.slice(start) : text.slice(start, end) })
    if (end === -1) return out
    start = end + 1
  }
}

function heading(line: string): { depth: number; name: string } | undefined {
  const match = line.match(/^(#{1,6})\s+(.*?)\s*$/)
  if (match === null || match[2] === undefined || match[2].length === 0) return undefined
  return { depth: match[1]!.length, name: match[2] }
}

/** Every heading section of `text` with the requirements its marker names (empty when it has none). */
export function gatedSections(text: string): GatedSection[] {
  const all = lines(text)
  let fence = false
  const headings: { index: number; depth: number; name: string }[] = []
  all.forEach((line, index) => {
    if (/^\s*(```|~~~)/.test(line.text)) fence = !fence
    if (fence) return
    const found = heading(line.text)
    if (found !== undefined) headings.push({ index, ...found })
  })
  return headings.map((entry, at) => {
    const next = headings.slice(at + 1).find((other) => other.depth <= entry.depth)
    const end = next === undefined ? text.length : all[next.index]!.start
    const first = all.slice(entry.index + 1).find((line) => line.text.trim().length > 0)
    const marker = first === undefined ? null : first.text.match(MARKER)
    return {
      start: all[entry.index]!.start,
      end,
      depth: entry.depth,
      name: entry.name,
      requires: marker === null ? [] : parseRequirements(marker[1] ?? ""),
    }
  })
}

/** Whether a text carries any marker (a text without one passes through untouched). */
export function hasRequirements(text: string): boolean {
  return lines(text).some((line) => MARKER.test(line.text))
}

/** A requirement holds when the agent has the row and it is on (or, for `!id`, off). */
export function met(requirement: Requirement, isOn: (id: string) => boolean | undefined): boolean {
  const state = isOn(requirement.id)
  return state !== undefined && state === requirement.on
}

/**
 * The text an agent receives: sections whose requirements fail are left out
 * (with their subsections), and every marker line is removed. `isOn` answers
 * for a row id as the agent resolves it, undefined for a row it does not have.
 */
export function applyRequires(text: string, isOn: (id: string) => boolean | undefined): string {
  if (!hasRequirements(text)) return text
  const drop = gatedSections(text).filter((section) => section.requires.some((requirement) => !met(requirement, isOn)))
  let out = ""
  let at = 0
  for (const section of drop.toSorted((left, right) => left.start - right.start)) {
    if (section.start < at) continue
    out += text.slice(at, section.start)
    at = section.end
  }
  out += text.slice(at)
  return stripMarkers(out)
}

/**
 * What the model reads of a gated text: no marker lines, and no heading left
 * standing with nothing under it (every section it had was left out).
 */
export function stripMarkers(text: string): string {
  const kept = lines(text)
    .filter((line) => !MARKER.test(line.text))
    .map((line) => line.text)
    .join("\n")
  return dropEmptyHeadings(kept).replace(/\n{3,}/g, "\n\n").trim()
}

/**
 * The condition a section's own text states: the marker on its first line,
 * or on the first line under its heading. Undefined when there is none.
 */
export function markerIn(text: string): string[] | undefined {
  const filled = lines(text).filter((line) => line.text.trim().length > 0)
  const first = filled[0]
  if (first === undefined) return undefined
  const candidate = heading(first.text) !== undefined ? filled[1] : first
  const match = candidate?.text.match(MARKER)
  if (match === null || match === undefined) return undefined
  return parseRequirements(match[1] ?? "").map((requirement) => (requirement.on ? requirement.id : `!${requirement.id}`))
}

/** A condition as stored: `tool:x`, `!perm:shell:git-push`. */
export function requirementOf(id: string): Requirement {
  return id.startsWith("!") ? { id: id.slice(1), on: false } : { id, on: true }
}

/** The gate for one agent: every id in a condition must be met (requires.ts `met`). */
export function gateOf(isOn: (id: string) => boolean | undefined): (ids: readonly string[]) => boolean {
  return (ids) => ids.every((id) => met(requirementOf(id), isOn))
}

/** The marker line a condition reads as in text. */
export function markerLine(ids: readonly string[]): string {
  return `<!-- requires: ${ids.join(", ")} -->`
}

function dropEmptyHeadings(text: string): string {
  const all = lines(text)
  const keep = all.map(() => true)
  for (let index = all.length - 1; index >= 0; index--) {
    const found = heading(all[index]!.text)
    if (found === undefined) continue
    let empty = true
    for (let next = index + 1; next < all.length; next++) {
      if (!keep[next]) continue
      const other = heading(all[next]!.text)
      if (other !== undefined) {
        if (other.depth <= found.depth) break
        empty = false
        break
      }
      if (all[next]!.text.trim().length > 0) {
        empty = false
        break
      }
    }
    if (empty) keep[index] = false
  }
  return all
    .filter((_, index) => keep[index])
    .map((line) => line.text)
    .join("\n")
}

/** Every row id any marker in the text names. */
export function requiredIds(text: string): string[] {
  return [...new Set(gatedSections(text).flatMap((section) => section.requires.map((requirement) => requirement.id)))]
}

/**
 * Mentions a marker does not cover: a section that names a tool or skill the
 * agent does not have (or has off), with no requirement on that row, still
 * reaches the model and contradicts what the agent can do. `names` maps the
 * word as it appears in text (e.g. "team_status", "pilotty") to its row id.
 */
export function mentionWarnings(
  text: string,
  names: ReadonlyMap<string, string>,
  isOn: (id: string) => boolean | undefined,
): { readonly section: string; readonly word: string; readonly id: string }[] {
  const out: { section: string; word: string; id: string }[] = []
  const sections = gatedSections(text)
  for (const section of sections) {
    // Only the section's own body: its subsections answer for themselves.
    const child = sections.find((other) => other.start > section.start && other.start < section.end)
    const body = text.slice(section.start, child === undefined ? section.end : child.start)
    const covered = new Set(
      sections
        .filter((outer) => outer.start <= section.start && outer.end >= section.end)
        .flatMap((outer) => outer.requires.map((requirement) => requirement.id)),
    )
    for (const [word, id] of names) {
      if (covered.has(id) || isOn(id) === true) continue
      if (!mentions(body, word)) continue
      out.push({ section: section.name, word, id })
    }
  }
  return out
}

// Whether a text refers to a tool or skill by name. An identifier-like name
// (team_status, search_exa_code_search, opencodeplus-release) counts anywhere
// as a whole word. A plain word that is also English (edit, shell, report,
// question) counts only where it reads as the tool: in backticks, or as "edit
// tool" / "pilotty skill". "You have no shell" says what is missing; it is not
// a mention to cover.
export function mentions(text: string, word: string): boolean {
  const escaped = word.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  if (/[_-]/.test(word)) return new RegExp(`(^|[^A-Za-z0-9_-])${escaped}($|[^A-Za-z0-9_-])`).test(text)
  return new RegExp(`\`${escaped}\`|(^|[^A-Za-z0-9_-])${escaped}\\s+(tool|skill)\\b`, "i").test(text)
}
