import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

export type SearchKeyName = "exa" | "tavily"

const ENV_VARS: Record<SearchKeyName, string> = {
  exa: "EXA_API_KEY",
  tavily: "TAVILY_API_KEY",
}

export function defaultSearchKeysDir(): string {
  const base = process.env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share")
  return path.join(base, "opencode", "opencodeplus", "search")
}

export function searchKeysDir(): string {
  const envDir = process.env.OPENCODEPLUS_SEARCH_KEYS_DIR?.trim()
  return envDir && envDir.length > 0 ? envDir : defaultSearchKeysDir()
}

export async function readKey(name: SearchKeyName): Promise<string | undefined> {
  const keyFile = path.join(searchKeysDir(), `${name}.key`)

  const stat = await fs.stat(keyFile).catch((error: NodeJS.ErrnoException) => {
    if (error.code === "ENOENT" || error.code === "ENOTDIR") return undefined
    throw error
  })

  if (stat !== undefined) {
    if (stat.isDirectory()) {
      throw new Error(`Key file ${keyFile} is a directory`)
    }
    const mode = stat.mode & 0o777
    if (mode !== 0o600) {
      throw new Error(`Key file ${keyFile} mode is 0${mode.toString(8)}, must be 0600`)
    }
    const content = (await fs.readFile(keyFile, "utf8")).trim()
    if (content.length > 0) return content
  }

  const envVar = ENV_VARS[name]
  const envVal = process.env[envVar]?.trim()
  return envVal && envVal.length > 0 ? envVal : undefined
}
