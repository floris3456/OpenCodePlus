export type SplitKind = "heading" | "block" | "manual" | "whole"

export interface Section {
  readonly id: string
  readonly name: string
  readonly depth: number
  readonly start: number
  readonly end: number
}

export interface Split {
  readonly kind: SplitKind
  readonly sections: readonly Section[]
}

export interface Boundary {
  readonly id: string
  readonly name: string
  readonly start: number
  readonly depth?: number
}

export function derive(text: string, title: string): Split {
  const headings = findHeadings(text)
  if (headings.length > 0) return headingSplit(text, headings)
  const blocks = findBlocks(text)
  if (blocks.length > 0) return blockSplit(text, blocks)
  return { kind: "whole", sections: [{ id: "whole", name: "Full text", depth: 0, start: 0, end: text.length }] }
}

export function manual(text: string, boundaries: readonly Boundary[]): Split {
  const indexMap = new Map(boundaries.map((b, i) => [b, i]))
  const sorted = [...boundaries].sort(
    (left, right) => left.start - right.start || (indexMap.get(left)! - indexMap.get(right)!),
  )
  const sections: Section[] = []
  if (sorted.length > 0 && hasContent(text.slice(0, sorted[0].start)))
    sections.push({ id: "preamble", name: "Preamble", depth: 0, start: 0, end: sorted[0].start })
  sorted.forEach((boundary, index) => {
    const depth = boundary.depth ?? 0
    const end = sorted.slice(index + 1).find((next) => (next.depth ?? 0) <= depth)?.start ?? text.length
    sections.push({
      id: boundary.id,
      name: boundary.name,
      depth,
      start: boundary.start,
      end,
    })
  })
  return { kind: "manual", sections }
}

export function assemble(text: string, split: Split, excluded: ReadonlySet<string>): string {
  const indexMap = new Map(split.sections.map((s, i) => [s, i]))
  const ordered = [...split.sections].sort(
    (left, right) => left.start - right.start || (indexMap.get(left)! - indexMap.get(right)!),
  )
  const kept = ordered.filter((section) => !isDropped(section.id, excluded))
  const parents = parentIndexes(ordered)
  const indexBySection = new Map(ordered.map((section, index) => [section, index]))
  const children = new Map<number, number[]>()
  parents.forEach((parent, index) => {
    if (parent === undefined) return
    const list = children.get(parent) ?? []
    list.push(index)
    children.set(parent, list)
  })
  const parts = kept.map((section) => {
    const index = indexBySection.get(section) ?? -1
    const starts = (children.get(index) ?? []).map((child) => ordered[child].start)
    const ownEnd = starts.length > 0 ? Math.min(...starts) : section.end
    return text.slice(section.start, ownEnd)
  })
  return parts.join("").replace(/\n(?:[ \t]*\n)+/g, "\n\n").trim()
}

export interface SectionSpan {
  readonly start: number
  readonly end: number
}

export interface AssembledWithSpans {
  readonly text: string
  readonly spans: ReadonlyMap<string, SectionSpan>
}

/**
 * An override text for a section, and the rank of the level that wrote it
 * (its position in the resolution chain: smaller is more specific).
 */
export interface Override {
  readonly text: string
  readonly rank: number
}

/**
 * A section override the assembly does not send: the section whose text
 * replaced it (`by`, null for the whole item's text) and that text's rank.
 */
export interface Shadow {
  readonly by: string | null
  readonly name: string
  readonly rank: number
}

export interface Rendered {
  readonly text: string
  readonly spans: ReadonlyMap<string, SectionSpan>
  readonly shadows: ReadonlyMap<string, Shadow>
}

interface Piece {
  readonly id: string
  readonly name: string
  readonly depth: number
  readonly text: string
  readonly rank: number
  readonly applied: boolean
  readonly index?: number
}

/**
 * The one assembly every section path uses. `wholeRank` is the rank of the
 * item's own text (Infinity when upstream). A section override is used when
 * its rank is at least as specific as the text it sits in, so a parent's copy
 * wins over a child written at a less specific level. An overridden
 * heading-derived section's text is its full span: its children are derived
 * from that text, so no heading is sent twice. An overridden manual section's
 * text replaces its span.
 */
export function renderSections(
  text: string,
  split: Split,
  excluded: ReadonlySet<string>,
  overrides: ReadonlyMap<string, Override>,
  wholeRank: number,
): Rendered {
  const indexMap = new Map(split.sections.map((s, i) => [s, i]))
  const ordered = [...split.sections].sort(
    (left, right) => left.start - right.start || (indexMap.get(left)! - indexMap.get(right)!),
  )
  const parents = parentIndexes(ordered)
  const children = new Map<number, number[]>()
  parents.forEach((parent, index) => {
    if (parent === undefined) return
    const list = children.get(parent) ?? []
    list.push(index)
    children.set(parent, list)
  })

  const separate = (str: string): string => {
    if (str.trim().length === 0) return ""
    return str.trimEnd() + "\n\n"
  }

  const applied = new Map<string, { readonly rank: number; readonly name: string }>()
  const pick = (id: string, name: string, depth: number, slice: string, rank: number, index?: number): Piece => {
    const override = overrides.get(id)
    if (override === undefined || override.rank > rank) return { id, name, depth, text: slice, rank, applied: false, index }
    applied.set(id, { rank: override.rank, name })
    return { id, name, depth, text: override.text, rank: override.rank, applied: true, index }
  }

  const kidOf = (index: number, rank: number): Piece => {
    const child = ordered[index]
    return pick(child.id, child.name, child.depth, slice(text, child), rank, index)
  }
  // A section of the item's own split: its children are the split's, offsets
  // from its start. Used for every section whose text is a slice of the item.
  const bySplit = (piece: Piece, index: number): { readonly own: string; readonly kids: readonly Piece[]; readonly tail: string } => {
    const section = ordered[index]
    const childIndexes = children.get(index) ?? []
    const first = childIndexes[0]
    return {
      own: piece.text.slice(0, first === undefined ? piece.text.length : ordered[first].start - section.start),
      kids: childIndexes.map((child) => kidOf(child, piece.rank)),
      tail: "",
    }
  }
  const derived = (piece: Piece): { readonly own: string; readonly kids: readonly Piece[]; readonly tail: string } => {
    const span = headingSpan(piece.text, piece.depth)
    const kids = span.kids.map((kid) => pick(`${piece.id}/${kid.rel}`, kid.name, kid.depth, piece.text.slice(kid.start, kid.end), piece.rank))
    return {
      own: piece.text.slice(0, span.kids[0]?.start ?? piece.text.length),
      kids,
      tail: piece.applied && kids.length > 0 ? piece.text.slice(span.end) : "",
    }
  }
  // A piece's own text, the children to emit after it, and the text after its
  // span. An applied heading text can end with a same-or-shallower heading: that
  // text belongs to the piece but not to its span, so it follows the children.
  // An overridden manual piece replaces the children inside its span; a child
  // starting at its end (a new section's empty upstream span) is not inside it.
  const structure = (piece: Piece): { readonly own: string; readonly kids: readonly Piece[]; readonly tail: string } => {
    if (split.kind === "manual" && piece.applied && piece.index !== undefined) {
      const section = ordered[piece.index]
      const outside = (children.get(piece.index) ?? []).filter((index) => ordered[index].start >= section.end)
      return { own: piece.text, kids: outside.map((index) => kidOf(index, piece.rank)), tail: "" }
    }
    if (split.kind === "manual" && piece.index !== undefined) return bySplit(piece, piece.index)
    if (split.kind !== "heading") return { own: piece.text, kids: [], tail: "" }
    if (!piece.applied && piece.index !== undefined) return bySplit(piece, piece.index)
    return derived(piece)
  }

  let out = ""
  const spans = new Map<string, SectionSpan>()
  const emit = (piece: Piece): void => {
    if (isDropped(piece.id, excluded)) return
    const start = out.length
    const { own, kids, tail } = structure(piece)
    if (kids.length === 0) {
      out += piece.applied ? separate(piece.text) : piece.text
    } else {
      out += separate(own)
      for (const kid of kids) emit(kid)
      out += separate(tail)
    }
    spans.set(piece.id, { start, end: out.length })
  }

  const tops = ordered.map((_, index) => index).filter((index) => parents[index] === undefined)
  for (const index of tops) {
    const section = ordered[index]
    emit(pick(section.id, section.name, section.depth, slice(text, section), wholeRank, index))
  }

  const parentOf = new Map<string, string>()
  parents.forEach((parent, index) => {
    if (parent !== undefined) parentOf.set(ordered[index].id, ordered[parent].id)
  })
  const nearestApplied = (id: string): string | undefined => {
    if (split.kind === "manual") {
      const ancestor = parentOf.get(id)
      return ancestor === undefined || applied.has(ancestor) ? ancestor : nearestApplied(ancestor)
    }
    const parts = id.split("/")
    const prefixes = parts.slice(1).map((_, index) => parts.slice(0, index + 1).join("/"))
    return prefixes.findLast((prefix) => applied.has(prefix))
  }
  const shadows = new Map<string, Shadow>()
  for (const id of overrides.keys()) {
    if (applied.has(id) || isDropped(id, excluded)) continue
    const by = nearestApplied(id)
    if (by !== undefined) shadows.set(id, { by, name: applied.get(by)?.name ?? by, rank: applied.get(by)?.rank ?? wholeRank })
    else if (wholeRank !== Infinity) shadows.set(id, { by: null, name: "", rank: wholeRank })
  }

  const normalized = collapseBlankLines(out)
  return {
    text: normalized.text,
    spans: new Map([...spans].map(([id, span]) => [id, { start: normalized.at(span.start), end: normalized.at(span.end) }])),
    shadows,
  }
}

export function assembleWithSpans(
  text: string,
  split: Split,
  overrides: ReadonlyMap<string, string>,
): AssembledWithSpans {
  const rendered = renderSections(text, split, new Set(), rankAll(overrides), Infinity)
  return { text: rendered.text, spans: rendered.spans }
}

function rankAll(overrides: ReadonlyMap<string, string>): ReadonlyMap<string, Override> {
  return new Map([...overrides].map(([id, text]) => [id, { text, rank: 0 }]))
}

export interface HeadingSection {
  /** Id relative to the span's own heading (the heading's id is dropped). */
  readonly rel: string
  readonly name: string
  readonly depth: number
  readonly start: number
  readonly end: number
}

/**
 * The span of a heading-derived section's text: what its heading holds below
 * it. `kids` are its direct children, `inner` every section below it; offsets
 * are into `text`. This is the one derivation of "an override is a full span":
 * assembly takes the children from it, and a save drops the child records it
 * covers. `end` is where the span stops: a same-or-shallower heading after it
 * is not part of the span.
 */
export function headingSpan(text: string, depth: number): {
  readonly end: number
  readonly kids: readonly HeadingSection[]
  readonly inner: readonly HeadingSection[]
} {
  const split = derive(text, "")
  if (split.kind !== "heading") return { end: text.length, kids: [], inner: [] }
  const rooted = split.sections[0].start === 0 && split.sections[0].id !== "preamble"
  const list = rooted ? split.sections : split.sections.slice(1)
  const parents = parentIndexes(list)
  const root = rooted ? list[0] : undefined
  const isKid = (index: number): boolean =>
    rooted ? parents[index] === 0 : parents[index] === undefined && list[index].depth > depth
  const tailIndex = list.findIndex((_, index) => !(rooted && index === 0) && parents[index] === undefined && !isKid(index))
  const end = tailIndex === -1 ? text.length : list[tailIndex].start
  const within = list
    .map((section, index) => ({ section, index }))
    .filter(({ index }) => !(rooted && index === 0) && (tailIndex === -1 || index < tailIndex))
  const relOf = (id: string): string => (root === undefined ? id : id.slice(root.id.length + 1))
  const toHeading = ({ section }: { readonly section: Section }): HeadingSection => ({
    rel: relOf(section.id),
    name: section.name,
    depth: section.depth,
    start: section.start,
    end: section.end,
  })
  return {
    end,
    kids: within.filter(({ index }) => isKid(index)).map(toHeading),
    inner: within.map(toHeading),
  }
}

// The assembled text collapses blank-line runs and trims its ends (as
// assembleWithOverrides does), so a span measured on the raw concatenation
// moves left by every collapse before it. `at` maps a raw offset onto the
// collapsed text.
function collapseBlankLines(raw: string): { readonly text: string; readonly at: (offset: number) => number } {
  const cuts: { readonly start: number; readonly length: number }[] = []
  const collapsed = raw.replace(/\n(?:[ \t]*\n)+/g, (match: string, start: number) => {
    cuts.push({ start, length: match.length })
    return "\n\n"
  })
  const lead = collapsed.length - collapsed.trimStart().length
  const text = collapsed.trim()
  return {
    text,
    at: (offset) => {
      const shift = cuts.filter((cut) => cut.start + cut.length <= offset).reduce((sum, cut) => sum + cut.length - 2, 0)
      const inside = cuts.find((cut) => offset > cut.start && offset < cut.start + cut.length)
      const mapped = inside === undefined ? offset - shift : inside.start - shift + Math.min(offset - inside.start, 2)
      return Math.max(0, Math.min(text.length, mapped - lead))
    },
  }
}

export function assembleWithOverrides(
  text: string,
  split: Split,
  excluded: ReadonlySet<string>,
  overrides: ReadonlyMap<string, string>,
): string {
  return renderSections(text, split, excluded, rankAll(overrides), Infinity).text
}

export function slice(text: string, section: Section): string {
  return text.slice(section.start, section.end)
}

/**
 * The lone top-level section that wraps the whole document — the usual `# Title`
 * of a split instruction or skill. Its children are the document's real
 * sections, so the tree presents it as its own body row instead of an extra
 * level. Undefined when the split has several (or no) top-level sections, or
 * its one top-level section has no children.
 */
export function wrappingSection(split: Split): Section | undefined {
  const tops = split.sections.filter((section) => section.depth === 0)
  const wrapper = tops.length === 1 ? tops[0] : undefined
  if (wrapper === undefined) return undefined
  return split.sections.some((section) => section.id.startsWith(`${wrapper.id}/`)) ? wrapper : undefined
}

/**
 * A wrapper's own body: what follows its heading line and precedes its first
 * child section, trimmed. Empty when the wrapper carries nothing but its
 * heading. Section ids and ranges do not change: the body is the wrapper
 * section's preamble, read for the "Introduction" row.
 */
export function ownBody(text: string, split: Split, wrapper: Section): string {
  const first = split.sections
    .filter((section) => section.id.startsWith(`${wrapper.id}/`))
    .reduce<number | undefined>((min, section) => (min === undefined || section.start < min ? section.start : min), undefined)
  if (first === undefined) return ""
  const line = text.indexOf("\n", wrapper.start)
  return (line === -1 || line >= first ? "" : text.slice(line + 1, first)).trim()
}

interface Heading {
  readonly start: number
  readonly depth: number
  readonly name: string
}

function headingSplit(text: string, headings: readonly Heading[]): Split {
  const used = new Set<string>()
  const stack: { depth: number; path: string }[] = []
  const sections: Section[] = []
  if (hasContent(text.slice(0, headings[0].start))) {
    sections.push({ id: claim("preamble", used), name: "Preamble", depth: 0, start: 0, end: headings[0].start })
  }
  headings.forEach((heading, index) => {
    while (stack.length > 0 && stack[stack.length - 1].depth >= heading.depth) stack.pop()
    const parent = stack.length > 0 ? stack[stack.length - 1].path : undefined
    const base = parent === undefined ? slugify(heading.name) : `${parent}/${slugify(heading.name)}`
    const id = claim(base, used)
    stack.push({ depth: heading.depth, path: id })
    const end = headings.slice(index + 1).find((next) => next.depth <= heading.depth)?.start ?? text.length
    sections.push({ id, name: heading.name, depth: heading.depth, start: heading.start, end })
  })
  return { kind: "heading", sections }
}

interface Block {
  readonly tag: string
  readonly start: number
}

function blockSplit(text: string, blocks: readonly Block[]): Split {
  const used = new Set<string>()
  const sections: Section[] = []
  if (hasContent(text.slice(0, blocks[0].start))) {
    sections.push({ id: claim("preamble", used), name: "Preamble", depth: 0, start: 0, end: blocks[0].start })
  }
  blocks.forEach((block, index) => {
    sections.push({
      id: claim(block.tag, used),
      name: block.tag,
      depth: 0,
      start: block.start,
      end: index + 1 < blocks.length ? blocks[index + 1].start : text.length,
    })
  })
  return { kind: "block", sections }
}

function findHeadings(text: string): Heading[] {
  return lineStarts(text)
    .map((start) => ({ start, line: lineAt(text, start) }))
    .flatMap(({ start, line }): Heading[] => {
      const match = line.match(/^(#{1,6})(?:\s+(.*?))?\s*$/)
      if (!match) return []
      // A bare run of hashes with no trailing text is not a heading.
      if (match[2] === undefined && line.trim().length > match[1].length) return []
      if (match[2] === undefined) return []
      return [{ start, depth: match[1].length - 1, name: match[2].trim() }]
    })
}

function findBlocks(text: string): Block[] {
  const starts = lineStarts(text)
  const blocks: Block[] = []
  let index = 0
  while (index < starts.length) {
    const open = lineAt(text, starts[index]).match(/^<([A-Za-z][A-Za-z0-9:._-]*)[^>]*>\s*$/)
    if (!open) {
      index += 1
      continue
    }
    const tag = open[1]
    const closeIndex = starts.slice(index + 1).findIndex((start) => lineAt(text, start).match(new RegExp(`^</${escapeRegExp(tag)}\\s*>\\s*$`)))
    blocks.push({ tag, start: starts[index] })
    // An unclosed opening still forms a section running to the end of the text.
    if (closeIndex === -1) return blocks
    index += closeIndex + 2
  }
  return blocks
}

// Dynamic tag names come from upstream text, so they must be regex-escaped.
function escapeRegExp(tag: string): string {
  return tag.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

function lineStarts(text: string): number[] {
  const starts = [0]
  let at = text.indexOf("\n")
  while (at !== -1) {
    starts.push(at + 1)
    at = text.indexOf("\n", at + 1)
  }
  return starts
}

function lineAt(text: string, start: number): string {
  const end = text.indexOf("\n", start)
  const raw = end === -1 ? text.slice(start) : text.slice(start, end)
  return raw.endsWith("\r") ? raw.slice(0, -1) : raw
}

function hasContent(text: string): boolean {
  return /\S/.test(text)
}

function slugify(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug.length > 0 ? slug : "section"
}

function claim(base: string, used: Set<string>): string {
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  let n = 2
  while (used.has(`${base}-${n}`)) n += 1
  used.add(`${base}-${n}`)
  return `${base}-${n}`
}

function isDropped(id: string, excluded: ReadonlySet<string>): boolean {
  const parts = id.split("/")
  return parts.some((_, index) => excluded.has(parts.slice(0, index + 1).join("/")))
}

export function parentIndexes(sections: readonly Section[]): (number | undefined)[] {
  const parents: (number | undefined)[] = sections.map(() => undefined)
  const stack: number[] = []
  sections.forEach((section, index) => {
    while (stack.length > 0) {
      const top = sections[stack[stack.length - 1]]
      if (top.depth < section.depth && top.end >= section.start) break
      stack.pop()
    }
    parents[index] = stack.length > 0 ? stack[stack.length - 1] : undefined
    stack.push(index)
  })
  return parents
}
