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
  const target = skillFile(input, validated.id)
  if (await Bun.file(target).exists()) return { ok: false, reason: "exists", id: validated.id, path: target }
  await fs.mkdir(path.dirname(target), { recursive: true })
  await Bun.write(target, formatSkill(validated.id, input.body))
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

function formatSkill(name: string, body: string): string {
  const description = describeBody(body, name)
  const normalized = body.endsWith("\n") || body.length === 0 ? body : `${body}\n`
  return `---\nname: ${yamlString(name)}\ndescription: ${yamlString(description)}\n---\n${normalized}`
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
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/)
  if (!match) return undefined
  const raw = match[1] ?? ""
  try {
    const data = Bun.YAML.parse(raw)
    if (typeof data !== "object" || data === null || Array.isArray(data)) return undefined
    const fields = data as { name?: unknown; description?: unknown }
    return {
      ...(typeof fields.name === "string" ? { name: fields.name } : {}),
      ...(typeof fields.description === "string" ? { description: fields.description } : {}),
    }
  } catch {
    return undefined
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
