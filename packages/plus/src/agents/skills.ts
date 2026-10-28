import fs from "node:fs/promises"
import path from "node:path"
import { defaultsSkillsDir, globalSkillsDir, presetSkillsDir } from "../instructions/paths.js"

// Where a skill is authored. `project` is the checkout's own directory; the
// other three live under the global skills directory core scans
// (instructions/paths.ts). A preset-scoped skill names the preset it belongs to.
export type SkillScope = "project" | "global" | "defaults" | "preset"

export interface SkillTarget {
  readonly scope: SkillScope
  readonly projectDirectory: string
  /** Required for `preset`, ignored otherwise. */
  readonly preset?: string
}

export interface SkillSuccess {
  readonly ok: true
  readonly id: string
  readonly path: string
}

export interface SkillExists {
  readonly ok: false
  readonly reason: "exists"
  readonly id: string
  readonly path: string
}

export interface SkillInvalid {
  readonly ok: false
  readonly reason: "invalid"
  readonly id: string
  readonly message: string
}

export type SkillResult = SkillSuccess | SkillExists | SkillInvalid

export interface SkillMissing {
  readonly ok: false
  readonly reason: "missing"
  readonly id: string
  readonly path: string
}

export type SkillDeleteResult = SkillSuccess | SkillMissing | SkillInvalid

export function validateSkillName(raw: string): { ok: true; id: string } | { ok: false; reason: string } {
  const id = raw.trim()
  if (id.length === 0) return { ok: false, reason: "Skill name cannot be empty" }
  if (id.includes("\\")) return { ok: false, reason: `Invalid skill name "${id}": backslashes are not allowed` }
  if (id.includes("\0")) return { ok: false, reason: `Invalid skill name "${id}": null bytes are not allowed` }
  const segments = id.split("/")
  if (segments.some((segment) => segment.length === 0))
    return { ok: false, reason: `Invalid skill name "${id}": empty path segment` }
  if (segments.some((segment) => segment === "." || segment === ".."))
    return { ok: false, reason: `Invalid skill name "${id}": "." and ".." segments are not allowed` }
  return { ok: true, id }
}

export function skillDirectory(target: SkillTarget): string {
  if (target.scope === "project") return path.join(target.projectDirectory, ".opencode", "skill")
  if (target.scope === "global") return globalSkillsDir()
  if (target.scope === "defaults") return defaultsSkillsDir()
  if (target.preset === undefined || target.preset.length === 0)
    throw new Error("preset scope requires a preset id")
  return presetSkillsDir(target.preset)
}

export function skillFile(target: SkillTarget, id: string): string {
  const root = path.resolve(skillDirectory(target))
  const dir = path.resolve(root, id)
  if (dir === root || !dir.startsWith(`${root}${path.sep}`)) throw new Error(`Invalid skill name "${id}"`)
  return path.join(dir, "SKILL.md")
}

export async function createSkill(input: SkillTarget & { name: string; body: string }): Promise<SkillResult> {
  const validated = validateSkillName(input.name)
  if (!validated.ok) return { ok: false, reason: "invalid", id: input.name, message: validated.reason }
  // A body may carry a skill file's own frontmatter. It is merged into the one
  // block the file needs, and a block we cannot merge refuses before any write.
  const formatted = formatSkill(validated.id, input.body)
  if (formatted.ok === false) return { ok: false, reason: "invalid", id: validated.id, message: formatted.message }
  const target = skillFile(input, validated.id)
  if (await Bun.file(target).exists()) return { ok: false, reason: "exists", id: validated.id, path: target }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, formatted.text)
  return { ok: true, id: validated.id, path: target }
}

export async function importSkill(input: SkillTarget & { path: string }): Promise<SkillResult> {
  const source = Bun.file(input.path)
  if (!(await source.exists())) return { ok: false, reason: "invalid", id: input.path, message: `Skill file not found at ${input.path}` }
  const text = await source.text()
  const parsed = parseSkillFile(text)
  if (parsed === undefined) return { ok: false, reason: "invalid", id: input.path, message: `Skill file at ${input.path} has no valid frontmatter` }
  if (parsed.name === undefined || parsed.name.trim().length === 0)
    return { ok: false, reason: "invalid", id: input.path, message: `Skill file at ${input.path} has no name` }
  const validated = validateSkillName(parsed.name)
  if (!validated.ok) return { ok: false, reason: "invalid", id: parsed.name, message: validated.reason }
  const target = skillFile(input, validated.id)
  if (await Bun.file(target).exists()) return { ok: false, reason: "exists", id: validated.id, path: target }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, text.endsWith("\n") ? text : `${text}\n`)
  return { ok: true, id: validated.id, path: target }
}

export async function deleteSkill(input: SkillTarget & { id: string }): Promise<SkillDeleteResult> {
  const validated = validateSkillName(input.id)
  if (!validated.ok) return { ok: false, reason: "invalid", id: input.id, message: validated.reason }
  const target = skillFile(input, validated.id)
  if (!(await Bun.file(target).exists())) return { ok: false, reason: "missing", id: validated.id, path: target }
  await fs.rm(path.dirname(target), { recursive: true, force: true })
  return { ok: true, id: validated.id, path: target }
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/
// An opening `---` immediately followed by the closing one: a block with no
// keys, which is not a mapping (and would otherwise be read as body text).
const EMPTY_FRONTMATTER = /^---\r?\n---(?:\r?\n|$)/

type FormattedSkill = { readonly ok: true; readonly text: string } | { readonly ok: false; readonly message: string }

// A skill file carries exactly one frontmatter block. A body that already
// begins with one keeps its own lines (extra keys such as `type` and any
// description survive); only a missing `name` or description is added, since
// core reads the id from the folder and the row's label from `name`.
function formatSkill(id: string, body: string): FormattedSkill {
  const match = body.match(FRONTMATTER) ?? body.match(EMPTY_FRONTMATTER)
  if (match === null) {
    const description = describeBody(body, id)
    const normalized = body.endsWith("\n") || body.length === 0 ? body : `${body}\n`
    return { ok: true, text: `---\nname: ${yamlString(id)}\ndescription: ${yamlString(description)}\n---\n${normalized}` }
  }
  const fields = frontmatterFields(match[1] ?? "")
  if (fields === undefined)
    return {
      ok: false,
      message: "The body begins with a frontmatter block that is not valid YAML; fix it or leave it out.",
    }
  if (fields.name !== undefined && fields.name !== id)
    return {
      ok: false,
      message: `The body's frontmatter names "${String(fields.name)}" but the skill is "${id}"; make them equal or leave name out.`,
    }
  // Core decodes `description` as a string, so a non-string or empty one would
  // make it skip the file: such a line is replaced rather than kept.
  const described = typeof fields.description === "string" && fields.description.trim().length > 0
  const rest = body.slice(match[0].length)
  const normalized = rest.endsWith("\n") || rest.length === 0 ? rest : `${rest}\n`
  const own = described ? (match[1] ?? "") : withoutDescription(match[1] ?? "")
  const lines = own.trim().length === 0 ? [] : own.split("\n")
  if (fields.name === undefined) {
    lines.unshift(`name: ${yamlString(id)}`)
    if (!described) lines.splice(1, 0, `description: ${yamlString(describeBody(rest, id))}`)
  }
  if (fields.name !== undefined && !described) {
    // Keep the body's key order: the description follows its `name` line.
    const at = lines.findIndex((line) => /^name\s*:/.test(line))
    lines.splice(at + 1, 0, `description: ${yamlString(describeBody(rest, id))}`)
  }
  return { ok: true, text: `---\n${lines.join("\n")}\n---\n${normalized}` }
}

function withoutDescription(raw: string): string {
  const kept: string[] = []
  let dropping = false
  for (const line of raw.split(/\r?\n/)) {
    // A block scalar's indented lines belong to the key above them.
    if (dropping && /^\s+\S/.test(line)) continue
    if (/^description\s*:/.test(line)) {
      dropping = true
      continue
    }
    dropping = false
    kept.push(line)
  }
  return kept.join("\n")
}

function frontmatterFields(raw: string): { name?: unknown; description?: unknown } | undefined {
  try {
    const data: unknown = Bun.YAML.parse(raw)
    if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined
    return data as { name?: unknown; description?: unknown }
  } catch {
    return undefined
  }
}

function describeBody(body: string, fallback: string): string {
  const first = body
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.length > 0)
  if (first === undefined) return fallback
  return first.slice(0, 120)
}

function parseSkillFile(text: string): { name?: string; description?: string } | undefined {
  const match = text.match(FRONTMATTER)
  if (!match) return undefined
  const fields = frontmatterFields(match[1] ?? "")
  if (fields === undefined) return undefined
  return {
    ...(typeof fields.name === "string" ? { name: fields.name } : {}),
    ...(typeof fields.description === "string" ? { description: fields.description } : {}),
  }
}

function yamlString(value: string): string {
  if (value === "") return '""'
  const reserved = /^(true|false|yes|no|on|off|null|~)$/i.test(value)
  const numeric = /^[+-]?(0|[1-9]\d*)(\.\d+)?([eE][+-]?\d+)?$/.test(value)
  const safe = /^[a-zA-Z0-9_\-\./]+$/.test(value) && !value.startsWith("-") && !reserved && !numeric
  if (safe) return value
  return JSON.stringify(value)
}
