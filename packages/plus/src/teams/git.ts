import { join } from "node:path"

// Always include the standard system bin dirs so a spawned `git` resolves
// regardless of the caller's ambient PATH (stripped PATHs caused
// `posix_spawn 'git'` failures).
const ocpRoot = process.env.OCP_ROOT?.trim() || "/home/bliss/OpenCodePlus"

export function systemPath(): string {
  return [join(ocpRoot, "bin"), process.env.PATH, "/usr/bin", "/bin"].filter(Boolean).join(":")
}

export interface GitResult {
  code: number
  out: string
  err: string
}

// Non-throwing variant: captures exit code, trimmed stdout and trimmed stderr.
export async function gitRaw(dir: string, args: string[]): Promise<GitResult> {
  const p = Bun.spawn(["git", ...args], {
    cwd: dir,
    env: { ...process.env, PATH: systemPath() },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { code, out: out.trim(), err: err.trim() }
}

// Throwing variant: rejects with the stderr text on non-zero exit,
// resolves with trimmed stdout otherwise.
export async function git(dir: string, args: string[]): Promise<string> {
  const r = await gitRaw(dir, args)
  if (r.code !== 0) throw new Error(r.err || r.out || `git ${args.join(" ")} exited ${r.code}`)
  return r.out
}
