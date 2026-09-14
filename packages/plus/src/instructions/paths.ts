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
