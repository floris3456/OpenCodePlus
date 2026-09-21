import { afterEach, beforeEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { defaultSearchKeysDir, readKey, searchKeysDir } from "../../src/search/keys.js"

const tempDirs: string[] = []
let origKeysDir: string | undefined
let origExaKey: string | undefined
let origTavilyKey: string | undefined
let origDataHome: string | undefined

beforeEach(() => {
  origKeysDir = process.env.OPENCODEPLUS_SEARCH_KEYS_DIR
  origExaKey = process.env.EXA_API_KEY
  origTavilyKey = process.env.TAVILY_API_KEY
  origDataHome = process.env.XDG_DATA_HOME
})

afterEach(async () => {
  if (origKeysDir !== undefined) process.env.OPENCODEPLUS_SEARCH_KEYS_DIR = origKeysDir
  else delete process.env.OPENCODEPLUS_SEARCH_KEYS_DIR

  if (origExaKey !== undefined) process.env.EXA_API_KEY = origExaKey
  else delete process.env.EXA_API_KEY

  if (origTavilyKey !== undefined) process.env.TAVILY_API_KEY = origTavilyKey
  else delete process.env.TAVILY_API_KEY

  if (origDataHome !== undefined) process.env.XDG_DATA_HOME = origDataHome
  else delete process.env.XDG_DATA_HOME

  await Promise.all(tempDirs.splice(0).map((d) => fs.rm(d, { recursive: true, force: true })))
})

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "plus-keys-test-"))
  tempDirs.push(dir)
  return dir
}

test("searchKeysDir resolves from OPENCODEPLUS_SEARCH_KEYS_DIR or XDG_DATA_HOME", async () => {
  const dir = await makeTempDir()
  process.env.OPENCODEPLUS_SEARCH_KEYS_DIR = dir
  expect(searchKeysDir()).toBe(dir)

  delete process.env.OPENCODEPLUS_SEARCH_KEYS_DIR
  process.env.XDG_DATA_HOME = dir
  expect(defaultSearchKeysDir()).toBe(path.join(dir, "opencode", "opencodeplus", "search"))
  expect(searchKeysDir()).toBe(path.join(dir, "opencode", "opencodeplus", "search"))
})

test("key file wins over env for exa", async () => {
  const dir = await makeTempDir()
  process.env.OPENCODEPLUS_SEARCH_KEYS_DIR = dir
  process.env.EXA_API_KEY = "env-exa-key"

  const keyPath = path.join(dir, "exa.key")
  await fs.writeFile(keyPath, "file-exa-key\n", { mode: 0o600 })
  await fs.chmod(keyPath, 0o600)

  const key = await readKey("exa")
  expect(key).toBe("file-exa-key")
})

test("key file wins over env for tavily", async () => {
  const dir = await makeTempDir()
  process.env.OPENCODEPLUS_SEARCH_KEYS_DIR = dir
  process.env.TAVILY_API_KEY = "env-tavily-key"

  const keyPath = path.join(dir, "tavily.key")
  await fs.writeFile(keyPath, "  file-tavily-key  \n", { mode: 0o600 })
  await fs.chmod(keyPath, 0o600)

  const key = await readKey("tavily")
  expect(key).toBe("file-tavily-key")
})

test("env fallback when key file is absent", async () => {
  const dir = await makeTempDir()
  process.env.OPENCODEPLUS_SEARCH_KEYS_DIR = dir
  process.env.EXA_API_KEY = "fallback-exa-key"
  process.env.TAVILY_API_KEY = "fallback-tavily-key"

  expect(await readKey("exa")).toBe("fallback-exa-key")
  expect(await readKey("tavily")).toBe("fallback-tavily-key")
})

test("returns undefined when key is missing in both file and env", async () => {
  const dir = await makeTempDir()
  process.env.OPENCODEPLUS_SEARCH_KEYS_DIR = dir
  delete process.env.EXA_API_KEY
  delete process.env.TAVILY_API_KEY

  expect(await readKey("exa")).toBeUndefined()
  expect(await readKey("tavily")).toBeUndefined()
})

test("mode 0600 is enforced on key files", async () => {
  const dir = await makeTempDir()
  process.env.OPENCODEPLUS_SEARCH_KEYS_DIR = dir

  const keyPath = path.join(dir, "exa.key")
  await fs.writeFile(keyPath, "insecure-key\n", { mode: 0o644 })
  await fs.chmod(keyPath, 0o644)

  await expect(readKey("exa")).rejects.toThrow("0600")
})

test("key value is trimmed of leading and trailing whitespace", async () => {
  const dir = await makeTempDir()
  process.env.OPENCODEPLUS_SEARCH_KEYS_DIR = dir

  const keyPath = path.join(dir, "exa.key")
  await fs.writeFile(keyPath, "\n\t  trimmed-key  \r\n", { mode: 0o600 })
  await fs.chmod(keyPath, 0o600)

  expect(await readKey("exa")).toBe("trimmed-key")
})
