import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export function defaultSearchKeysDir(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(base, "opencode", "opencodeplus", "search")
}

export function searchKeysDir(): string {
  const envDir = process.env.OPENCODEPLUS_SEARCH_KEYS_DIR
  if (envDir && envDir.trim().length > 0) return envDir.trim()
  return defaultSearchKeysDir()
}

function keyFileName(name: string): string {
  const lower = name.toLowerCase()
  if (lower.endsWith("_api_key")) return lower.slice(0, -"_api_key".length)
  if (lower.endsWith("-api-key")) return lower.slice(0, -"_api_key".length)
  return lower
}

function envVarNames(name: string): string[] {
  const upper = name.toUpperCase()
  const base = upper.replace(/[-_]API[-_]KEY$/, "")
  return [`${base}_API_KEY`, upper, name]
}

export async function readKey(name: string): Promise<string | undefined> {
  const dir = searchKeysDir()
  const fileName = `${keyFileName(name)}.key`
  const keyFile = path.join(dir, fileName)

  let stat
  try {
    stat = await fs.stat(keyFile)
  } catch (err: any) {
    if (err && (err.code === "ENOENT" || err.code === "ENOTDIR")) {
      stat = undefined
    } else {
      throw err
    }
  }

  if (stat !== undefined) {
    if (stat.isDirectory()) {
      throw new Error(`Key file ${keyFile} is a directory`)
    }
    const mode = stat.mode & 0o777
    if (mode !== 0o600) {
      throw new Error(`Key file ${keyFile} mode is 0${mode.toString(8)}, must be 0600`)
    }
    const content = (await fs.readFile(keyFile, "utf8")).trim()
    if (content.length > 0) {
      return content
    }
  }

  for (const envVar of envVarNames(name)) {
    const val = process.env[envVar]
    if (val !== undefined && val.trim().length > 0) {
      return val.trim()
    }
  }

  return undefined
}
