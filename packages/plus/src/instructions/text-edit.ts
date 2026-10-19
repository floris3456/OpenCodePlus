// `instructions_edit`: the built-in edit tool's find-and-replace, applied to a
// row's text instead of a file. Matching mirrors core `tool/plugin/edit.ts`:
// an exact match first, then one that ignores typographic quotes, dashes and
// spaces, then one that ignores trailing whitespace on each line. Each pass
// keeps offsets into the original text, so only the matched span changes.

export interface TextEdit {
  readonly oldString: string
  readonly newString: string
  readonly replaceAll?: boolean
}

interface Match {
  readonly start: number
  readonly end: number
}

const crlf = "\r\n"

export function replaceText(source: string, edit: TextEdit, label: string): { text: string; replacements: number } | { refusal: string } {
  if (edit.oldString === edit.newString) return { refusal: "No changes to apply: oldString and newString are identical." }
  if (edit.oldString === "") return { refusal: `oldString must not be empty. Use set({ id, text }) to replace all of "${label}".` }
  const ending = source.includes(crlf) ? crlf : "\n"
  const oldString = edit.oldString.replaceAll(crlf, "\n").replaceAll("\n", ending)
  const newString = edit.newString.replaceAll(crlf, "\n").replaceAll("\n", ending)
  const exact = findOccurrences(source, oldString)
  const unicode = exact.length > 0 ? [] : findOccurrences(normalizeForMatch(source), normalizeForMatch(oldString))
  const trailing = exact.length > 0 || unicode.length > 0 ? [] : findLineOccurrences(source, oldString)
  const matches = exact.length > 0 ? exact : unicode.length > 0 ? unicode : trailing
  if (matches.length === 0)
    return { refusal: `Could not find oldString in "${label}". It must match the row's current text (show's text) exactly, including whitespace and line breaks.` }
  if (matches.length > 1 && edit.replaceAll !== true)
    return {
      refusal: `Found ${matches.length} matches for oldString in "${label}", but expected exactly one. Add more surrounding context to make oldString unique, or set replaceAll to true to replace every occurrence.`,
    }
  const text = (edit.replaceAll === true ? matches : matches.slice(0, 1))
    .toReversed()
    .reduce((content, match) => `${content.slice(0, match.start)}${newString}${content.slice(match.end)}`, source)
  return { text, replacements: matches.length }
}

function normalizeForMatch(value: string): string {
  return value
    .replace(/[‘’‚‛]/g, "'")
    .replace(/[“”„‟]/g, '"')
    .replace(/[‐‑‒–—―−]/g, "-")
    .replace(/[\u00A0\u2002-\u200A\u202F\u205F\u3000]/g, " ")
}

function findOccurrences(content: string, search: string): Match[] {
  const result: Match[] = []
  let offset = 0
  while ((offset = content.indexOf(search, offset)) !== -1) {
    result.push({ start: offset, end: offset + search.length })
    offset += search.length
  }
  return result
}

function findLineOccurrences(content: string, search: string): Match[] {
  const trailingNewline = search.endsWith("\n")
  const expected = search.split("\n")
  if (trailingNewline) expected.pop()
  const lines = [...content.matchAll(/[^\n]*(?:\n|$)/g)]
    .filter((match) => match[0] !== "")
    .map((match) => {
      const newline = match[0].endsWith("\n")
      const text = newline ? match[0].slice(0, -1) : match[0]
      return {
        start: match.index,
        end: match.index + match[0].length,
        text,
        contentEnd: match.index + text.length - (text.endsWith("\r") ? 1 : 0),
        newline,
      }
    })
  const candidates = lines.flatMap((line, index) => {
    const actual = lines.slice(index, index + expected.length)
    if (actual.length !== expected.length) return []
    if (!actual.every((item, lineIndex) => normalizeForMatch(item.text.trimEnd()) === normalizeForMatch((expected[lineIndex] ?? "").trimEnd())))
      return []
    const last = actual.at(-1)!
    if (trailingNewline && !last.newline) return []
    return [{ start: line.start, end: trailingNewline ? last.end : last.contentEnd }]
  })
  return candidates.reduce<Match[]>((result, candidate) => {
    if (result.some((match) => match.end > candidate.start && match.start < candidate.end)) return result
    result.push(candidate)
    return result
  }, [])
}
