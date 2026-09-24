import { mkdir, readdir, realpath, writeFile } from "node:fs/promises"
import { spawn } from "node:child_process"
import type { ChildProcess } from "node:child_process"
import { join } from "node:path"
import { Effect } from "effect"
import { append } from "./audit.js"
import { atomicJson, lock, readJson } from "./store.js"
import { toolError } from "./schema.js"
import type { Check } from "./schema.js"
import { git, parsePorcelain, PLUS_PROJECT_FILE, systemPath } from "./git.js"
import { NO_REPOSITORY_PROGRAMS } from "./worktree.js"
import { errCode, io } from "./io.js"
import { Release } from "../release/identity.js"

// Check executor (docs/team-v2/07-code-mode.md §check serialization,
// docs/team-v2/03-tools.md §check, docs/team-v2/05-runtime-and-storage.md
// §Receipts). Checks hold ONLY the per-worktree `wt:` lock for their whole
// duration — never a `repo:` lock — so checks in the same worktree queue
// FIFO while checks in different worktrees run in parallel.

export const DEFAULT_CHECK_TIMEOUT_MS = 900_000
export const MAX_LOG_BYTES = 2 * 1024 * 1024
export const MAX_OUTPUT_BYTES = 8192

export interface Receipt {
  id: string
  argv: string[]
  cwd: string
  head: string
  exitCode: number | null
  passed: boolean
  at: number
  durationMs: number
  outputPath: string
  code?: string
  message?: string
  // Tree measured at check time plus whether the tree was dirty. A receipt
  // proves the committed HEAD only when dirty === false with a recorded
  // tree; dirty-tree (or pre-flag) receipts never satisfy "green at HEAD".
  tree?: string
  dirty?: boolean
  porcelain?: string[]
  policyDigest?: string
}

export function computePolicyDigest(check: {
  readonly id: string
  readonly argv: readonly string[]
  readonly cwd?: string | undefined
}): string {
  return Release.digest({
    id: check.id,
    argv: [...check.argv],
    cwd: check.cwd ?? "",
  })
}

export interface ExecuteOptions {
  runID: string
  check: Check
  worktree: string
  timeoutMs?: number
}

export type ExecuteResult = Receipt & { output: string }

export interface CheckResult {
  id: string
  passed: boolean
  exitCode: number | null
  head: string
  durationMs: number
  output: string
  receipt: string
  code?: string
  message?: string
}

/** Keep the last `maxBytes` bytes of a UTF-8 string. */
export function tailBytes(s: string, maxBytes: number): string {
  const buf = Buffer.from(s, "utf8")
  if (buf.length <= maxBytes) return s
  return buf.subarray(buf.length - maxBytes).toString("utf8")
}

function receiptPaths(root: string, runID: string, id: string, head: string): { json: string; log: string } {
  const dir = join(root, "runs", runID, "receipts")
  const stem = `${id}-${head.slice(0, 7)}`
  return { json: join(dir, `${stem}.json`), log: join(dir, `${stem}.log`) }
}

interface SpawnResult {
  exitCode: number | null
  stdout: string
  stderr: string
  timedOut: boolean
  durationMs: number
}

function killGroup(child: ChildProcess): void {
  if (child.pid === undefined) {
    Effect.runSync(Effect.ignore(Effect.try({ try: () => child.kill("SIGKILL"), catch: () => undefined })))
    return
  }
  const pid = child.pid
  const killed = Effect.runSync(
    Effect.ignore(Effect.try({ try: () => process.kill(-pid, "SIGKILL"), catch: () => undefined })).pipe(
      Effect.as(true),
    ),
  )
  if (killed) return
  Effect.runSync(Effect.ignore(Effect.try({ try: () => child.kill("SIGKILL"), catch: () => undefined })))
}

// Spawn argv detached (its own process group) so a timeout can kill the
// whole group, and capture stdout/stderr until exit.
function spawnAndWait(
  argv: readonly string[],
  cwd: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<SpawnResult> {
  return new Promise((resolve, reject) => {
    if (argv.length === 0) {
      reject(new Error("Cannot run a check with an empty argv."))
      return
    }
    const started = Date.now()
    // A synchronous spawn throw rejects this promise via the executor,
    // so no try/catch is needed here; async failures arrive on 'error'.
    const bin = argv[0] as string
    const child = spawn(bin, argv.slice(1), {
      cwd,
      env,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
    })
    const out: Buffer[] = []
    const err: Buffer[] = []
    let settled = false
    let timedOut = false
    const finish = (r: SpawnResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(r)
    }
    const timer = setTimeout(() => {
      if (settled) return
      timedOut = true
      killGroup(child)
    }, timeoutMs)
    child.stdout?.on("data", (d: Buffer) => out.push(Buffer.isBuffer(d) ? d : Buffer.from(d)))
    child.stderr?.on("data", (d: Buffer) => err.push(Buffer.isBuffer(d) ? d : Buffer.from(d)))
    child.on("error", (e) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      reject(e)
    })
    child.on("close", (code) => {
      finish({
        exitCode: timedOut ? null : (code ?? null),
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        timedOut,
        durationMs: Date.now() - started,
      })
    })
  })
}

function combineOutput(stdout: string, stderr: string): string {
  if (!stderr) return stdout
  if (!stdout) return stderr
  return stdout + (stdout.endsWith("\n") ? "" : "\n") + stderr
}

function mutationMessage(
  id: string,
  headBefore: string,
  headAfter: string,
  statusBefore: string,
  statusAfter: string,
): string {
  const parts: string[] = []
  if (headBefore !== headAfter) parts.push(`HEAD ${headBefore.slice(0, 7)} → ${headAfter.slice(0, 7)}`)
  if (statusBefore !== statusAfter) {
    const before = statusBefore.split("\n").filter((l) => l.length > 0)
    const after = statusAfter.split("\n").filter((l) => l.length > 0)
    const sample = after.slice(0, 5).join(", ")
    parts.push(
      `git status changed (was ${before.length} entries, now ${after.length} entries` +
        (sample ? `: ${sample}` : "") +
        ")",
    )
  }
  if (parts.length === 0) parts.push("no visible change (race?)")
  return `Check "${id}" mutated the worktree: ${parts.join("; ")}.`
}

const INSTALL_ARGV = ["bun", "install", "--frozen-lockfile", "--ignore-scripts"] as const

interface Provisioned {
  /** What the install printed, prefixed to the check's own log. */
  readonly log: string
  /** Set when the install failed; the check does not run. */
  readonly failure?: SpawnResult
  /** Set when the install changed the tree git tracks; the receipt fails closed. */
  readonly mutated?: string
}

// A team worktree is a fresh `git worktree add`, so a repository whose checks need
// installed packages (a Bun lockfile at the worktree root and no node_modules yet)
// gets them before its first check: a frozen install, lifecycle scripts off, the same
// preparation the workspace's frozen team ran. Later checks find node_modules and
// skip this. node_modules is ignored by git, so a clean tree stays clean; an install
// that nevertheless changes the tracked tree is reported, never hidden.
async function provisionDependencies(
  worktree: string,
  env: Record<string, string>,
  timeoutMs: number,
): Promise<Provisioned> {
  if (!(await Bun.file(join(worktree, "bun.lock")).exists())) return { log: "" }
  const present = await Effect.runPromise(
    io(() => readdir(join(worktree, "node_modules"))).pipe(
      Effect.as(true),
      Effect.catchIf(() => true, () => Effect.succeed(false)),
    ),
  )
  if (present) return { log: "" }
  const before = await git(worktree, [...NO_REPOSITORY_PROGRAMS, "status", "--porcelain", "-uall"])
  const result = await spawnAndWait(INSTALL_ARGV, worktree, env, timeoutMs)
  const log = `$ ${INSTALL_ARGV.join(" ")}\n${combineOutput(result.stdout, result.stderr)}`
  const header = log.endsWith("\n") ? log : `${log}\n`
  if (result.exitCode !== 0 || result.timedOut) return { log: header, failure: result }
  const after = await git(worktree, [...NO_REPOSITORY_PROGRAMS, "status", "--porcelain", "-uall"])
  if (after !== before) return { log: header, mutated: `git status was "${before}", now "${after}"` }
  return { log: header }
}

function resolveWorktreeKey(worktree: string): Promise<string> {
  return Effect.runPromise(
    io(() => realpath(worktree)).pipe(Effect.catchIf((error) => errCode(error) === "ENOENT", () => Effect.succeed(worktree))),
  )
}

export async function execute(root: string, opts: ExecuteOptions): Promise<ExecuteResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_CHECK_TIMEOUT_MS
  const key = await resolveWorktreeKey(opts.worktree)
  // wt: lock only — never repo:. Held for the whole duration. The acquire
  // timeout is generous so queued checks survive behind a long-running one.
  return lock(
    root,
    "wt",
    key,
    async () => {
      const started = Date.now()
      const env: Record<string, string> = { PATH: systemPath() }
      if (process.env.HOME !== undefined) env.HOME = process.env.HOME
      if (process.env.BUN_INSTALL_CACHE_DIR !== undefined) env.BUN_INSTALL_CACHE_DIR = process.env.BUN_INSTALL_CACHE_DIR
      const provisioned = await provisionDependencies(opts.worktree, env, timeoutMs)
      const headBefore = await git(opts.worktree, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD"])
      const statusBefore = await git(opts.worktree, [...NO_REPOSITORY_PROGRAMS, "status", "--porcelain", "-uall"])
      // Provenance for the measured tree: the committed HEAD tree plus
      // whether the tree was dirty. Dirty status is captured up front (the
      // tree the check actually measured); the mutation gate below still
      // fails checks that dirty the tree themselves. Recording porcelain is
      // cheaper than a temporary-index write-tree and sufficient to refuse
      // the receipt as HEAD proof later.
      const tree = await git(opts.worktree, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD^{tree}"])
      const dirty = parsePorcelain(statusBefore).length > 0
      const cwd = opts.check.cwd ? join(opts.worktree, opts.check.cwd) : opts.worktree
      // A worktree whose dependencies could not be installed never runs the check:
      // the failed install is this check's outcome, recorded like any other failure.
      const proc = provisioned.failure ?? (await spawnAndWait(opts.check.argv, cwd, env, timeoutMs))

      let full = provisioned.log + combineOutput(proc.stdout, proc.stderr)
      const exitCode: number | null = proc.exitCode
      let code: string | undefined
      let message: string | undefined
      if (provisioned.failure !== undefined) {
        code = "E_CHECK_DEPENDENCIES"
        message = `Check "${opts.check.id}" did not run: installing the worktree's dependencies failed.`
        full += (full === "" || full.endsWith("\n") ? "" : "\n") + message + "\n"
      } else if (proc.timedOut) {
        code = "E_CHECK_TIMEOUT"
        message = `Check "${opts.check.id}" timed out after ${timeoutMs}ms; the process group was killed.`
        full += (full === "" || full.endsWith("\n") ? "" : "\n") + message + "\n"
      }

      const headAfter = await git(opts.worktree, [...NO_REPOSITORY_PROGRAMS, "rev-parse", "HEAD"])
      const statusAfter = await git(opts.worktree, [...NO_REPOSITORY_PROGRAMS, "status", "--porcelain", "-uall"])
      if (headAfter !== headBefore || statusAfter !== statusBefore) {
        // Post-condition failure overrides even a zero exit code.
        code = "E_CHECK_MUTATED"
        message = mutationMessage(opts.check.id, headBefore, headAfter, statusBefore, statusAfter)
      } else if (provisioned.mutated !== undefined) {
        // Installing changed the committed tree (for example a rewritten manifest): the
        // check then measured a tree the commit does not hold.
        code = "E_CHECK_MUTATED"
        message = `Check "${opts.check.id}": installing dependencies changed the worktree: ${provisioned.mutated}.`
      }

      const passed = exitCode === 0 && !proc.timedOut && code === undefined
      const durationMs = Date.now() - started
      const at = Date.now()
      const head = headBefore
      const paths = receiptPaths(root, opts.runID, opts.check.id, head)
      await Effect.runPromise(io(() => mkdir(join(root, "runs", opts.runID, "receipts"), { recursive: true })))
      const capped = tailBytes(full, MAX_LOG_BYTES)
      await Effect.runPromise(io(() => writeFile(paths.log, capped, "utf8")))
      const policyDigest = computePolicyDigest(opts.check)
      const receipt: Receipt = {
        id: opts.check.id,
        argv: [...opts.check.argv],
        cwd: opts.check.cwd ?? "",
        head,
        exitCode,
        passed,
        at,
        durationMs,
        outputPath: paths.log,
        tree,
        dirty,
        policyDigest,
      }
      if (dirty) {
        receipt.porcelain = statusBefore
          .split("\n")
          .map((line) => line.trim())
          .filter((line) => line.length > 0 && line !== `?? ${PLUS_PROJECT_FILE}`)
      }
      if (code !== undefined) {
        receipt.code = code
        receipt.message = message ?? ""
      }
      await atomicJson(paths.json, receipt)
      await Effect.runPromise(
        Effect.ignore(
          Effect.tryPromise({
            try: () => append(root, "receipt.written", { run: opts.runID, check: opts.check.id, head, dirty, passed }),
            catch: () => undefined,
          }),
        ),
      )
      return { ...receipt, output: tailBytes(capped, MAX_OUTPUT_BYTES) }
    },
    { timeoutMs: Math.max(3_600_000, timeoutMs + 60_000), op: `check:${opts.check.id}` },
  )
}

function listReceiptFiles(root: string, runID: string): Promise<string[] | undefined> {
  const dir = join(root, "runs", runID, "receipts")
  return Effect.runPromise(
    io(() => readdir(dir)).pipe(Effect.catchIf((error) => errCode(error) === "ENOENT", () => Effect.succeed(undefined))),
  )
}

/** Latest receipt for `id`, or the one at `head` when given. */
export async function lastReceipt(root: string, runID: string, id: string, head?: string): Promise<Receipt | undefined> {
  if (head) return readJson<Receipt>(receiptPaths(root, runID, id, head).json)
  const entries = await listReceiptFiles(root, runID)
  if (entries === undefined) return undefined
  const prefix = `${id}-`
  let best: Receipt | undefined
  for (const e of entries) {
    if (!e.startsWith(prefix) || !e.endsWith(".json")) continue
    const r = await readJson<Receipt>(join(root, "runs", runID, "receipts", e))
    if (!r || r.id !== id) continue
    if (!best || r.at > best.at) best = r
  }
  return best
}

// A receipt counts as proof for its HEAD only when it was recorded with a
// clean tree at that HEAD. Dirty-tree receipts are never "present at HEAD",
// and old receipts without the flag fail closed (treated as not clean) so
// they can never satisfy finish's "checks green at HEAD" gate.
export function isCleanReceipt(receipt: Receipt): boolean {
  if (receipt.dirty !== false) return false
  if (typeof receipt.tree !== "string" || receipt.tree.length === 0) return false
  if (receipt.code === "E_CHECK_MUTATED") return false
  return true
}

export type CheckBindingRejectionReason =
  | "changed_definition"
  | "different_head"
  | "different_tree"
  | "dirty_tree"
  | "missing_dirty_flag"
  | "mutated_source"

export interface SourceFacts {
  readonly head: string
  readonly tree: string
}

export type VerifyReceiptResult =
  | {
      readonly ok: true
      readonly accepted: true
      readonly reason?: undefined
      readonly message?: undefined
    }
  | {
      readonly ok: false
      readonly accepted: false
      readonly reason: CheckBindingRejectionReason
      readonly message: string
    }

export function verifyReceipt(
  receipt: Receipt,
  check: Check | { readonly id: string; readonly argv: readonly string[]; readonly cwd?: string | undefined },
  facts: SourceFacts,
): VerifyReceiptResult {
  if (receipt.dirty === undefined || typeof receipt.dirty !== "boolean") {
    return {
      ok: false,
      accepted: false,
      reason: "missing_dirty_flag",
      message: `Receipt for check "${receipt.id}" is missing the dirty flag (unusable legacy receipt).`,
    }
  }

  if (receipt.dirty !== false) {
    return {
      ok: false,
      accepted: false,
      reason: "dirty_tree",
      message: `Receipt for check "${receipt.id}" was recorded on a dirty tree.`,
    }
  }

  if (receipt.code === "E_CHECK_MUTATED") {
    return {
      ok: false,
      accepted: false,
      reason: "mutated_source",
      message: `Receipt for check "${receipt.id}" failed due to mutating the worktree.`,
    }
  }

  const expectedPolicyDigest = computePolicyDigest(check)
  const receiptDefinitionMatches =
    receipt.id === check.id &&
    receipt.cwd === (check.cwd ?? "") &&
    receipt.argv.length === check.argv.length &&
    receipt.argv.every((arg, i) => arg === check.argv[i])

  if (!receiptDefinitionMatches || (receipt.policyDigest !== undefined && receipt.policyDigest !== expectedPolicyDigest)) {
    return {
      ok: false,
      accepted: false,
      reason: "changed_definition",
      message: `Check definition changed for "${check.id}": id, argv or cwd does not match receipt.`,
    }
  }

  if (receipt.head !== facts.head) {
    return {
      ok: false,
      accepted: false,
      reason: "different_head",
      message: `Receipt HEAD ${receipt.head} does not match current HEAD ${facts.head}.`,
    }
  }

  if (!receipt.tree || receipt.tree !== facts.tree) {
    return {
      ok: false,
      accepted: false,
      reason: "different_tree",
      message: `Receipt tree ${receipt.tree ?? "none"} does not match current tree ${facts.tree}.`,
    }
  }

  return { ok: true, accepted: true }
}

/** All receipts recorded at exactly `head`. */
export async function receiptsAt(root: string, runID: string, head: string): Promise<Receipt[]> {
  const entries = await listReceiptFiles(root, runID)
  if (entries === undefined) return []
  const suffix = `-${head.slice(0, 7)}.json`
  const out: Receipt[] = []
  for (const e of entries) {
    if (!e.endsWith(suffix)) continue
    const r = await readJson<Receipt>(join(root, "runs", runID, "receipts", e))
    if (r && r.head === head && isCleanReceipt(r)) out.push(r)
  }
  return out
}

/** Assigned checks with no passing receipt at `head`. */
export async function stale(root: string, assigned: Check[], runID: string, head: string): Promise<Check[]> {
  const out: Check[] = []
  for (const c of assigned) {
    const r = await readJson<Receipt>(receiptPaths(root, runID, c.id, head).json)
    if (!r || r.head !== head || !isCleanReceipt(r) || r.passed !== true) {
      out.push(c)
      continue
    }
    const digest = computePolicyDigest(c)
    if (computePolicyDigest(r) !== digest || (r.policyDigest !== undefined && r.policyDigest !== digest)) {
      out.push(c)
      continue
    }
  }
  return out
}

/** Tool entry point for `check`: runs assigned check `id` in `worktree`. */
export async function run(
  root: string,
  runID: string,
  id: string,
  assigned: Check[],
  worktree: string,
): Promise<CheckResult> {
  const check = assigned.find((c) => c.id === id)
  if (!check) {
    const names = assigned.map((c) => c.id)
    throw toolError("E_UNKNOWN_CHECK", `Check "${id}" is not assigned. Assigned: [${names.join(", ")}].`, {
      id: names[0] ?? "example",
    })
  }
  const res = await execute(root, { runID, check, worktree })
  const out: CheckResult = {
    id: res.id,
    passed: res.passed,
    exitCode: res.exitCode,
    head: res.head,
    durationMs: res.durationMs,
    output: res.output,
    receipt: res.outputPath,
  }
  if (res.code !== undefined) {
    out.code = res.code
    out.message = res.message
  }
  return out
}
