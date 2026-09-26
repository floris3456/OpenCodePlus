import { readFile, readdir, readlink, realpath, stat } from "node:fs/promises"
import { isAbsolute, join, resolve, sep } from "node:path"
import { errCode } from "./io.js"

export interface DirectoryUse {
  code: "E_WT_IN_USE" | "E_WT_INSPECTION"
  reason: string
}

// This is a removal guard, not a resource owner. Inspect same-user processes
// (including non-dumpable ones, whose /proc directory may be owned by root).
// Also honor readable foreign references, but never claim ownership of them.
// No environment contents or mapped filenames leave this boundary.
export async function directoryUse(dir: string, proc = "/proc"): Promise<DirectoryUse | undefined> {
  if (process.platform !== "linux" || process.geteuid === undefined)
    return { code: "E_WT_INSPECTION", reason: "Worktree retained: directory-use inspection requires Linux /proc." }
  const uid = process.geteuid()
  const canonical = await realpath(dir)
  if ((await stat(canonical)).uid !== uid)
    return { code: "E_WT_INSPECTION", reason: `Worktree retained: directory is not owned by uid ${uid}.` }
  const entries = await readdir(proc).catch(() => undefined)
  if (entries === undefined)
    return { code: "E_WT_INSPECTION", reason: "Worktree retained: cannot enumerate /proc processes." }
  for (const pid of entries.filter((name) => /^\d+$/.test(name))) {
    const base = join(proc, pid)
    const status = await readFile(join(base, "status"), "utf8").catch((error: unknown) => {
      if (errCode(error) === "ENOENT" || errCode(error) === "ESRCH") return ""
      return undefined
    })
    if (status === "" || (status !== undefined && /^State:\s+[ZX]\b/m.test(status))) continue
    const owners = status?.match(/^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m)?.slice(1).map(Number)
    if (owners === undefined)
      return { code: "E_WT_INSPECTION", reason: `Worktree retained: cannot establish ownership of PID ${pid}.` }
    const sameUser = owners.includes(uid)
    const failures: string[] = []
    const referenced = (source: string): DirectoryUse => ({
      code: "E_WT_IN_USE",
      reason: `Worktree retained: PID ${pid} (${sameUser ? "same-user" : "foreign"}, uid ${owners[1]}) references it via ${source}.`,
    })
    const cwd = await readlink(join(base, "cwd")).catch(() => {
      failures.push("cwd")
      return ""
    })
    if (within(canonical, cwd)) return referenced("cwd")
    const fds = await readdir(join(base, "fd")).catch(() => {
      failures.push("fd")
      return [] as string[]
    })
    for (const fd of fds) {
      const target = await readlink(join(base, "fd", fd)).catch((error: unknown) => {
        // A descriptor may close between readdir and readlink.
        if (errCode(error) !== "ENOENT") failures.push("fd")
        return ""
      })
      if (within(canonical, target)) return referenced("fd")
    }
    const maps = await readFile(join(base, "maps"), "utf8").catch(() => {
      failures.push("maps")
      return ""
    })
    if (maps.split("\n").some((line) => {
      const file = line.match(/^(?:\S+\s+){5}(\/.*)$/)?.[1]
      if (file === undefined) return false
      return within(canonical, file.replace(/\\([0-7]{3})/g, (_, octal: string) => String.fromCharCode(parseInt(octal, 8))))
    })) return referenced("maps")
    const environ = await readFile(join(base, "environ"), "utf8").catch(() => {
      failures.push("environ")
      return ""
    })
    for (const entry of environ.split("\0")) {
      const value = entry.slice(entry.indexOf("=") + 1)
      // Whole values preserve paths with spaces; lists and option values cover
      // PATH, NODE_OPTIONS, config/cache directories and other absolute refs.
      const paths = new Set([value, ...value.split(":"), ...value.split(/[\s"'=:\t]+/)].filter(isAbsolute))
      for (const candidate of paths) {
        if (within(canonical, resolve(candidate))) return referenced("environ")
        const target = await realpath(candidate).catch(() => "")
        if (within(canonical, target)) return referenced("environ")
      }
    }
    if (!sameUser || failures.length === 0) continue
    // Exit races and zombies have no resources to retain. A living same-user
    // process with even one unreadable surface is explicitly inconclusive.
    const fresh = await readFile(join(base, "status"), "utf8").catch((error: unknown) =>
      errCode(error) === "ENOENT" || errCode(error) === "ESRCH" ? "" : undefined,
    )
    if (fresh === "" || (fresh !== undefined && /^State:\s+[ZX]\b/m.test(fresh))) continue
    return {
      code: "E_WT_INSPECTION",
      reason: `Worktree retained: incomplete same-user inspection of PID ${pid} (uid ${uid}): ${[...new Set(failures)].join(", ")}.`,
    }
  }
  return undefined
}

function within(dir: string, reference: string): boolean {
  const target = reference.replace(/ \(deleted\)$/, "")
  return target === dir || target.startsWith(dir + sep)
}
