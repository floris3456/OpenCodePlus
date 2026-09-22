// Lab-only post-run evidence: GC sweep, audit-chain verification and the run
// inventory for the re-soak. Separate from the pinned D5 driver, which is
// never modified. Reads the lab teams root directly; prints JSON only.
import { Schema } from "effect"
import { verify } from "../../src/teams/audit.js"
import { gc } from "../../src/teams/lifecycle.js"
import { Policy } from "../../src/teams/schema.js"
import fs from "node:fs/promises"
import path from "node:path"

const root = process.argv[2]
if (!root || !root.includes("tui-lab-")) throw new Error("pass the lab teams root under a tui-lab home")

async function inventory() {
  const dir = path.join(root, "runs")
  const names = await fs.readdir(dir).catch(() => [] as string[])
  const rows = []
  for (const name of names) {
    if (name.startsWith(".")) continue
    const file = path.join(dir, name, "run.json")
    const raw = await fs.readFile(file, "utf8").catch(() => undefined)
    if (raw === undefined) continue
    const r = JSON.parse(raw)
    rows.push({ id: r.id, role: r.role, kind: r.kind, state: r.state, worktree: r.worktree ?? "present", parent: r.parent, head: r.head, sessionID: r.sessionID })
  }
  return rows.sort((a, b) => String(a.id).localeCompare(String(b.id)))
}

const policy = Schema.decodeUnknownSync(Policy)({ gc: { reapAfter: "0ms", keepPromotedFrom: true } })
const before = await inventory()
const swept = await gc(root, policy)
const after = await inventory()
const audit = await verify(root)
const worktreeRoot = path.join(root, "worktrees")
async function walk(dir: string): Promise<string[]> {
  const out: string[] = []
  const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const full = path.join(dir, e.name)
    const isWorktree = await fs.stat(path.join(full, ".git")).then(() => true).catch(() => false)
    if (isWorktree) out.push(full)
    else out.push(...(await walk(full)))
  }
  return out
}
console.log(JSON.stringify({
  gcPolicy: { reapAfter: "0ms", keepPromotedFrom: true },
  before: { total: before.length, byState: before.reduce<Record<string, number>>((a, r) => ({ ...a, [r.state]: (a[r.state] ?? 0) + 1 }), {}) },
  sweep: swept,
  after: { total: after.length, byState: after.reduce<Record<string, number>>((a, r) => ({ ...a, [r.state]: (a[r.state] ?? 0) + 1 }), {}) },
  rootRuns: after.filter((r) => r.kind === "main"),
  worktreeDirsRemaining: await walk(worktreeRoot),
  audit,
  inventory: after,
}, null, 2))
