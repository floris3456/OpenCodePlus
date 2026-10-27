// Always include the standard system bin dirs so a spawned `git` resolves
// regardless of the caller's ambient PATH (stripped PATHs caused
// `posix_spawn 'git'` failures). Nothing machine-specific is assumed, so an
// installed release carries no workspace directory.
export function systemPath(): string {
  return [process.env.PATH, "/usr/bin", "/bin"].filter(Boolean).join(":")
}

export interface GitResult {
  code: number
  out: string
  err: string
}

// Non-throwing variant: captures exit code, trimmed stdout and trimmed stderr.
export async function gitRaw(dir: string, args: string[], env: Record<string, string> = {}): Promise<GitResult> {
  const r = await spawnGit(dir, args, env)
  return { code: r.code, out: r.out.trim(), err: r.err.trim() }
}

// Throwing variant with stdout untrimmed: a -z list is NUL-terminated, and
// trimming would eat the first record's status space and a path's own
// leading or trailing spaces.
export async function gitPlain(dir: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const r = await spawnGit(dir, args, env)
  if (r.code !== 0) throw new Error(r.err.trim() || r.out.trim() || `git ${args.join(" ")} exited ${r.code}`)
  return r.out
}

async function spawnGit(dir: string, args: string[], env: Record<string, string>): Promise<GitResult> {
  const p = Bun.spawn(["git", ...args], {
    cwd: dir,
    env: { ...process.env, PATH: systemPath(), ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [out, err, code] = await Promise.all([
    new Response(p.stdout).text(),
    new Response(p.stderr).text(),
    p.exited,
  ])
  return { code, out, err }
}

// Throwing variant: rejects with the stderr text on non-zero exit,
// resolves with trimmed stdout otherwise.
export async function git(dir: string, args: string[], env: Record<string, string> = {}): Promise<string> {
  const r = await gitRaw(dir, args, env)
  if (r.code !== 0) throw new Error(r.err || r.out || `git ${args.join(" ")} exited ${r.code}`)
  return r.out
}

export const PLUS_PROJECT_FILE = ".opencodeplus/project.json"

export function parsePorcelain(out: string): string[] {
  const trimmed = out.trim()
  if (trimmed === "") return []
  const files: string[] = []
  for (const line of trimmed.split("\n")) {
    if (line.trim() === "") continue
    const match = /^(.{1,2}) (.+)$/.exec(line)
    if (match === null) continue
    const raw = match[2]?.trim() ?? ""
    if (raw === "") continue
    const arrow = raw.indexOf(" -> ")
    const picked = arrow < 0 ? raw : raw.slice(arrow + 4).trim()
    if (picked === "") continue
    const file = picked.length >= 2 && picked.startsWith('"') && picked.endsWith('"') ? picked.slice(1, -1) : picked
    if (match[1]?.trim() === "??" && file === PLUS_PROJECT_FILE) continue
    files.push(file)
  }
  files.sort()
  return files
}
