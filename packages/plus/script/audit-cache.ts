// Run only on a build-seat-supplied OFFLINE database copy. Analysis migrates a
// second scratch copy, never the supplied evidence. No provider calls are made.
// bun script/audit-cache.ts --offline-copy <copy.db> [--baseline <old/cache.ts>]
import { mkdtemp } from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { createLedger } from "../src/monitor/ledger.js"
import { foldSession } from "../src/monitor/cache.js"
import { auditCacheMisses } from "../src/monitor/audit.js"
import { sha256 } from "../src/monitor/fingerprint.js"

const args = Bun.argv.slice(2)
const source = args[args.indexOf("--offline-copy") + 1]
if (!args.includes("--offline-copy") || !source) throw new Error("Supply --offline-copy <build-seat-supplied copy.db>")
const baseline = args.includes("--baseline") ? args[args.indexOf("--baseline") + 1] : undefined
const prior: { foldSession: typeof foldSession } | undefined = baseline
  ? await import(pathToFileURL(path.resolve(baseline)).href) : undefined
const scratch = await mkdtemp(path.join(process.env.TMPDIR ?? "/home/bliss/OpenCodePlus/run/plus/tmp/opencodeplus", "cache-audit-"))
await Bun.write(path.join(scratch, "monitor.db"), Bun.file(source))
const db = createLedger(path.join(scratch, "monitor.db"))
const distribution: { before: Record<string, number>; after: Record<string, number> } = { before: {}, after: {} }
const failures: { request: string; verdict: string; shortfall: number }[] = []
const changes: { request: string; before?: string; after: string }[] = []
for (const session of db.db.query<{ id: string }, []>("select id from session").all()) {
  const rows = db.getRequests(session.id)
  const facts = db.getContextFacts(session.id)
  const fingerprints = new Map(rows.map((r) => [r.id, db.getFingerprint(r.id)]))
  const current = foldSession(rows, facts, fingerprints).analysis.summaries
  const old = prior?.foldSession(rows, facts, fingerprints).analysis.summaries
  failures.push(...auditCacheMisses(rows, current).map((failure) => ({ request: sha256(failure.requestID).slice(0, 12), verdict: failure.verdict, shortfall: failure.shortfall })))
  for (const [index, summary] of current.entries()) {
    const request = summary.request
    const before = old?.[index]?.request.verdict
    distribution.after[request.verdict] = (distribution.after[request.verdict] ?? 0) + 1
    if (before) distribution.before[before] = (distribution.before[before] ?? 0) + 1
    if (before !== request.verdict) changes.push({ request: sha256(request.id).slice(0, 12), before, after: request.verdict })
  }
}
db.close()
console.log(JSON.stringify({ baseline: baseline ? "supplied" : "not supplied; before distribution unavailable", distribution, failures, changes }, null, 2))
if (failures.length) process.exitCode = 1
