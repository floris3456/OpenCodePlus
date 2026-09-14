import os from "node:os"
import path from "node:path"

// Mirrors the global config resolution in @opencode/util without importing it:
// an explicit OPENCODE_CONFIG_DIR override, else <XDG_CONFIG_HOME>/opencode,
// else ~/.config/opencode.
export function globalConfigDir(): string {
  const override = process.env.OPENCODE_CONFIG_DIR
  if (override) return override
  const base = process.env.XDG_CONFIG_HOME || path.join(os.homedir(), ".config")
  return path.join(base, "opencode")
}

export function projectRecordsPath(directory: string): string {
  return path.join(directory, ".opencodeplus", "instructions", "records.jsonl")
}

export function globalRecordsPath(configDir: string = globalConfigDir()): string {
  return path.join(configDir, "opencodeplus", "instructions", "records.jsonl")
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
