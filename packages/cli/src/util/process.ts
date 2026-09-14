import fs from "node:fs"
import path from "node:path"

const entrypoint = process.argv[1] ? path.resolve(process.argv[1]) : undefined

function runtime() {
  const name = path.basename(process.execPath, path.extname(process.execPath)).toLowerCase()
  return {
    name,
    script: name === "bun" || name === "node" || name === "nodejs",
  }
}

export function selfCommand() {
  const current = runtime()
  if (!current.script) return [process.execPath]
  if (!entrypoint) throw new Error("Failed to resolve CLI entrypoint")
  if (current.name === "node" || current.name === "nodejs") return [process.execPath, ...nodeFlags(), entrypoint]
  return [process.execPath, entrypoint]
}

// Bun reads JSX configuration from $cwd/tsconfig.json without walking up,
// so a daemon started elsewhere transpiles this repo's .tsx with the wrong or no JSX runtime.
export function serviceDirectory() {
  const current = runtime()
  if (!current.script) return path.dirname(process.execPath)
  if (!entrypoint) throw new Error("Failed to resolve CLI entrypoint")
  const fallback = path.dirname(entrypoint)
  return findPackageRoot(fallback, fallback)
}

function findPackageRoot(dir: string, fallback: string): string {
  if (fs.existsSync(path.join(dir, "package.json"))) return dir
  const parent = path.dirname(dir)
  if (parent === dir) return fallback
  return findPackageRoot(parent, fallback)
}

function nodeFlags() {
  return process.execArgv.flatMap((arg, index, args) => {
    if (index > 0 && args[index - 1] === "--conditions") return []
    if (arg === "--conditions") return args[index + 1] ? [arg, args[index + 1]] : []
    if (arg.startsWith("--conditions=")) return [arg]
    if (
      arg === "--experimental-ffi" ||
      arg === "--use-system-ca" ||
      arg === "--enable-source-maps" ||
      arg === "--no-addons"
    )
      return [arg]
    if (arg === "--no-warnings" || arg.startsWith("--disable-warning=")) return [arg]
    return []
  })
}
