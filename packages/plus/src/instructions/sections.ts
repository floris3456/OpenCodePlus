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
}

export function derive(text: string, title: string): Split {
  const headings = findHeadings(text)
  if (headings.length > 0) return headingSplit(text, headings)
  const blocks = findBlocks(text)
  if (blocks.length > 0) return blockSplit(text, blocks)
  return { kind: "whole", sections: [{ id: "whole", name: title, depth: 0, start: 0, end: text.length }] }
}

export function manual(text: string, boundaries: readonly Boundary[]): Split {
  const sorted = [...boundaries].sort((left, right) => left.start - right.start)
  const sections: Section[] = []
  if (sorted.length > 0 && hasContent(text.slice(0, sorted[0].start)))
    sections.push({ id: "preamble", name: "Preamble", depth: 0, start: 0, end: sorted[0].start })
  sorted.forEach((boundary, index) => {
    sections.push({
      id: boundary.id,
      name: boundary.name,
      depth: 0,
      start: boundary.start,
      end: index + 1 < sorted.length ? sorted[index + 1].start : text.length,
    })
  })
  return { kind: "manual", sections }
}

export function assemble(text: string, split: Split, excluded: ReadonlySet<string>): string {
  const ordered = [...split.sections].sort((left, right) => left.start - right.start || left.depth - right.depth)
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

export function slice(text: string, section: Section): string {
  return text.slice(section.start, section.end)
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

function parentIndexes(sections: readonly Section[]): (number | undefined)[] {
  const parents: (number | undefined)[] = sections.map(() => undefined)
  const stack: number[] = []
  sections.forEach((section, index) => {
    while (stack.length > 0) {
      const top = sections[stack[stack.length - 1]]
      if (top.depth < section.depth && top.end > section.start) break
      stack.pop()
    }
    parents[index] = stack.length > 0 ? stack[stack.length - 1] : undefined
    stack.push(index)
  })
  return parents
}
