export * as PlusVersion from "./plus-version.js"

// An OpenCodePlus release version: the opencode release it contains, then its own
// release number, `2.0.18-plus-1.0.0`. Tags add a leading "v". Both parts are
// exactly three numbers without leading zeros. Each number is capped at nine
// digits so every consumer, including the publication workflow's bash, compares
// them as plain integers.
//
// Semver would treat everything after the first "-" as a prerelease and compare
// `plus-1.0.10` as text, before `plus-1.0.9`; `compare` orders numerically instead.

const part = "(0|[1-9][0-9]{0,8})"
const pattern = new RegExp(`^${part}\\.${part}\\.${part}-plus-${part}\\.${part}\\.${part}$`)

export type Triple = readonly [number, number, number]

export interface Info {
  readonly opencode: Triple
  readonly plus: Triple
}

export function parse(version: string): Info | undefined {
  const match = pattern.exec(version)
  if (!match) return
  const numbers = match.slice(1).map(Number)
  return {
    opencode: [numbers[0], numbers[1], numbers[2]],
    plus: [numbers[3], numbers[4], numbers[5]],
  }
}

export function fromTag(tag: string) {
  if (!tag.startsWith("v")) return
  return parse(tag.slice(1))
}

export function format(info: Info) {
  return `${info.opencode.join(".")}-plus-${info.plus.join(".")}`
}

export function tag(info: Info) {
  return `v${format(info)}`
}

/** "OpenCodePlus 1.0.0 (opencode 2.0.18)" */
export function display(info: Info) {
  return `OpenCodePlus ${info.plus.join(".")} (opencode ${info.opencode.join(".")})`
}

/** Negative when `a` is older than `b`: the Plus part decides, then the opencode part. */
export function compare(a: Info, b: Info) {
  return compareTriple(a.plus, b.plus) || compareTriple(a.opencode, b.opencode)
}

export function compareTriple(a: Triple, b: Triple) {
  return a[0] - b[0] || a[1] - b[1] || a[2] - b[2]
}

/**
 * Why `next` may not follow `previous` as a release, or undefined when it may.
 * A release is newer than the one before it, and its opencode part does not go
 * down unless `allowOlderOpencode` says the owner asked for exactly that.
 */
export function refuseNext(previous: Info, next: Info, options: { readonly allowOlderOpencode?: boolean } = {}) {
  if (compare(next, previous) <= 0) return `${format(next)} is not newer than ${format(previous)}`
  if (compareTriple(next.opencode, previous.opencode) < 0 && !options.allowOlderOpencode)
    return `${format(next)} contains an older opencode (${next.opencode.join(".")}) than ${format(previous)} (${previous.opencode.join(".")})`
}
