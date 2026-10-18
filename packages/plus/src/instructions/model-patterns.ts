// Which models a model prompt is for. A pattern names a model the way it is
// written somewhere: `claude-opus-5-5`, `cliproxyapi/claude-opus-5-5`, or with
// `*` or `%` for any run of characters (`*opus-5-5*`, `%qwen3.6%`), so one
// prompt covers the same model under another provider or an alias. Matching
// ignores case and compares the whole text.

/** The request model a pattern is checked against: its provider, its id and, when the catalogue knows it, its name. */
export interface ModelTarget {
  readonly providerID: string
  readonly id: string
  readonly name?: string
}

/** The patterns in what a person typed: separated by commas or new lines (a name may hold spaces), each once. */
export function parseModelPatterns(text: string): string[] {
  return [...new Set(text.split(/[,\n]/).map((pattern) => pattern.trim()).filter((pattern) => pattern.length > 0))]
}

/** True when any pattern matches the model's `provider/id`, its id alone, or its name. */
export function matchesModel(patterns: readonly string[], model: ModelTarget): boolean {
  const names = [`${model.providerID}/${model.id}`, model.id, ...(model.name === undefined ? [] : [model.name])].map((name) => name.toLowerCase())
  return patterns.some((pattern) => {
    const expression = patternExpression(pattern)
    return names.some((name) => expression.test(name))
  })
}

function patternExpression(pattern: string): RegExp {
  const body = pattern
    .toLowerCase()
    .split(/[*%]+/)
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*")
  return new RegExp(`^${body}$`)
}
