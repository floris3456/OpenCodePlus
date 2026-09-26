import os from "node:os"
import path from "node:path"
import { Product } from "@opencode/util/product"

// Resolves global config from the shared Product identity:
// an explicit OPENCODE_CONFIG_DIR override, else <XDG_CONFIG_HOME>/<Product.namespace>,
// else ~/.config/<Product.namespace>.
export function globalConfigDir(): string {
  const override = process.env.OPENCODE_CONFIG_DIR
  if (override) return override
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, Product.namespace)
}

export function projectRecordsPath(directory: string): string {
  return path.join(directory, ".opencodeplus", "instructions", "records.jsonl")
}

export function globalRecordsPath(configDir: string = globalConfigDir()): string {
  if (Product.namespace === "opencodeplus") {
    return path.join(configDir, "instructions", "records.jsonl")
  }
  return path.join(configDir, "opencodeplus", "instructions", "records.jsonl")
}

// The global index of projects whose store holds a preset link (store.ts
// linkedProjects): projects are not enumerable otherwise, and deleting a
// preset must see the links every project holds.
export function linkedProjectsPath(configDir: string = globalConfigDir()): string {
  return path.join(path.dirname(globalRecordsPath(configDir)), "linked-projects.json")
}

export function projectLogPath(directory: string): string {
  return path.join(directory, ".opencodeplus", "instructions", "log.jsonl")
}

export function globalLogPath(configDir: string = globalConfigDir()): string {
  if (Product.namespace === "opencodeplus") {
    return path.join(configDir, "instructions", "log.jsonl")
  }
  return path.join(configDir, "opencodeplus", "instructions", "log.jsonl")
}

export function projectTeamsPath(directory: string): string {
  return path.join(directory, ".opencodeplus", "teams")
}

export function globalTeamsPath(configDir: string = globalConfigDir()): string {
  if (Product.namespace === "opencodeplus") {
    return path.join(configDir, "teams")
  }
  return path.join(configDir, "opencodeplus", "teams")
}

// Team-run state lives under the XDG data dir, never inside a worktree's
// .opencodeplus/: runs hold locks, an audit key and live session bindings,
// while .opencodeplus/ holds project-scoped instruction records only.
export function teamsDataDir(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  if (Product.namespace === "opencodeplus") {
    return path.join(base, Product.namespace, "teams")
  }
  return path.join(base, Product.namespace, "opencodeplus", "teams")
}

// Only the path-confined delete types live here; creation result types stay
// local to index.ts where createInstruction owns them.
export interface InstructionSuccess {
  readonly ok: true
  readonly id: string
  readonly path: string
}

export interface InstructionMissing {
  readonly ok: false
  readonly reason: "missing"
  readonly id: string
  readonly path: string
  readonly name: string
}

export interface InstructionDeleteInvalid {
  readonly ok: false
  readonly reason: "invalid"
  readonly id: string
  readonly path: string
  readonly message: string
}

export type InstructionDeleteResult = InstructionSuccess | InstructionMissing | InstructionDeleteInvalid

// Resolve a user-supplied instruction name to the project file it names. The
// directory discover.ts scans for AGENTS.md-style files, so deletion refuses
// anything that escapes the project root.
export function resolveInstructionPath(
  projectDirectory: string,
  name: string,
): { ok: true; relative: string; path: string } | { ok: false; message: string } {
  const trimmed = name.trim()
  if (trimmed.length === 0) return { ok: false, message: "Instruction name cannot be empty" }
  if (trimmed.includes("\0") || trimmed.includes(".."))
    return { ok: false, message: `Invalid instruction name "${name}"` }
  const relative = trimmed.endsWith(".md") ? trimmed : `${trimmed}.md`
  const root = path.resolve(projectDirectory)
  const target = path.resolve(root, relative)
  if (target === root || !target.startsWith(`${root}${path.sep}`))
    return { ok: false, message: `Invalid instruction name "${name}"` }
  return { ok: true, relative: path.relative(root, target), path: target }
}

// The teaching layer (teaching.ts) lives here as path plus stable ids so
// discover.ts and apply.ts share them without a dependency cycle and without
// hardcoding the strings twice.
export function teachingFilePath(configDir: string = globalConfigDir()): string {
  if (Product.namespace === "opencodeplus") {
    return path.join(configDir, "instructions", "OPENCODEPLUS.md")
  }
  return path.join(configDir, "opencodeplus", "instructions", "OPENCODEPLUS.md")
}

export const teachingItemId = "system:opencodeplus"

export const teachingSkillId = "instructions-tools"
