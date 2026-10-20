// Live team lab: drive one task through a team on a lab server and measure it.
//
//   bun script/team-lab.ts run --url U --password-file F --dir D --agent A --model P/M --prompt-file P --out O
//                              [--timeout-min 90] [--settle-sec 45]
//   bun script/team-lab.ts report --url U --password-file F --session S --out O
//   bun script/team-lab.ts watch --url U --password-file F --session S --dir D --out O
//   bun script/team-lab.ts prompt --url U --password-file F --session S [--first | --at N] [--row N]
//
// `run` creates a chat as agent A in project D, sends the task, and waits until the whole team tree
// is quiet: no chat in it active and no run busy, for --settle-sec. Meanwhile it answers the top
// chat's permission asks once and cancels question forms (both logged): nobody watches a lab run.
// Then it writes the report. `report` writes it for an existing chat; `watch` follows one already
// running. `prompt` prints what one sent request of a chat was made of (the monitor's breakdown):
// the latest, the oldest (--first) or the one at position N (--at, 0 = oldest).
//
// The report (O/summary.json, O/summary.md, O/sessions/*.json): per chat its steps, tokens (input,
// cache read/write, output), cache hit rate, context per step, tool calls and errors, and the
// tree's runs with their attempts and reports, the monitor's own view of the tree, and the
// project's git log and `bun test` result. Lab tooling: it reads the lab's team data directly.
import { appendFile, mkdir, readdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { OpenCode } from "@opencode/client/promise"
import { Definition } from "../src/rpc.js"

const args = parseArgs(process.argv.slice(2))
const command = args._[0]
const url = required("url")
const password = (await Bun.file(required("password-file")).json()).password as string
const headers = { authorization: `Basic ${btoa(`opencode:${password}`)}` }
const teamsDir = args["teams-dir"] ?? path.join(process.env.XDG_DATA_HOME ?? "", "opencode", "opencodeplus", "teams")
const BUSY = new Set(["created", "preparing", "ready", "starting", "working", "stopping"])

if (command === "run") await runTask()
else if (command === "watch") {
  const info = await api("GET", `/api/session/${required("session")}`)
  await watch(required("session"), required("out"), required("dir"), Number(info.data?.time?.created ?? Date.now()), [])
}
else if (command === "report") await report(required("session"), required("out"), args.dir)
else if (command === "prompt") await promptRows(required("session"), args.first !== undefined, args.row === undefined ? undefined : Number(args.row))
else {
  console.error("usage: team-lab.ts run|report|watch|prompt …")
  process.exit(2)
}

async function runTask() {
  const dir = required("dir")
  const out = required("out")
  const prompt = await Bun.file(required("prompt-file")).text()
  await mkdir(out, { recursive: true })
  // A chat takes its agent's model only when the client sets it (the TUI does on agent choice).
  const [providerID, ...modelParts] = required("model").split("/")
  const created = await api("POST", "/api/session", {
    agent: required("agent"),
    model: { providerID, id: modelParts.join("/") },
    location: { directory: dir },
    title: path.basename(out),
  })
  const top = created.data.id as string
  const started = Date.now()
  log(out, `session ${top} agent ${required("agent")} dir ${dir}`)
  await api("POST", `/api/session/${top}/prompt`, { text: prompt, delivery: "steer" })
  // --then-file: the user's next messages ("---" lines between them), each sent once the tree is quiet.
  const followups = args["then-file"] === undefined ? [] : (await Bun.file(args["then-file"]).text()).split(/\n---\n/).map((text) => text.trim()).filter((text) => text.length > 0)
  await watch(top, out, dir, started, followups)
}

// Wait until the chat's team tree is quiet (sending the follow-ups as it goes), then report.
async function watch(top: string, out: string, dir: string, started: number, followups: string[]) {
  const timeoutMs = Number(args["timeout-min"] ?? "90") * 60_000
  const settleMs = Number(args["settle-sec"] ?? "45") * 1000
  let quietSince: number | undefined
  for (;;) {
    await Bun.sleep(5000)
    const tree = await treeOf(top)
    await answerAsks(top, out)
    const active = Object.keys((await api("GET", "/api/session/active")).data ?? {})
    const busy = tree.runs.filter((run) => BUSY.has(run.state))
    const running = tree.sessions.filter((id) => active.includes(id))
    if (running.length === 0 && busy.length === 0) quietSince ??= Date.now()
    else quietSince = undefined
    if (quietSince !== undefined && Date.now() - quietSince >= settleMs) {
      const next = followups.shift()
      if (next === undefined) break
      log(out, `followup: ${next.slice(0, 120)}`)
      await api("POST", `/api/session/${top}/prompt`, { text: next, delivery: "steer" })
      quietSince = undefined
      continue
    }
    if (Date.now() - started > timeoutMs) {
      log(out, `timeout after ${Math.round((Date.now() - started) / 60000)} min; running ${running.join(",")} busy ${busy.map((run) => run.id).join(",")}`)
      break
    }
  }
  log(out, `quiet after ${Math.round((Date.now() - started) / 1000)} s`)
  await report(top, out, dir, Date.now() - started - settleMs)
}

interface Run {
  id: string
  role: string
  kind: string
  state: string
  parent: string | null
  children: string[]
  sessionID: string | null
  directory: string
  branch: string
  createdAt: string
  attempts: { n: number; state: string; trigger: string; startedAt: string; endedAt?: string; error?: { type: string; message: string } }[]
  worktree?: string
  budget?: unknown
}

// The chat's main run and everything under it, from the lab's run records.
async function treeOf(top: string): Promise<{ runs: Run[]; sessions: string[] }> {
  const all: Run[] = []
  for (const id of await readdir(path.join(teamsDir, "runs")).catch(() => [] as string[])) {
    const run = await Bun.file(path.join(teamsDir, "runs", id, "run.json")).json().catch(() => undefined)
    if (run !== undefined) all.push(run)
  }
  const byId = new Map(all.map((run) => [run.id, run]))
  const roots = all.filter((run) => run.sessionID === top)
  const runs: Run[] = []
  const visit = (run: Run) => {
    if (runs.includes(run)) return
    runs.push(run)
    for (const child of run.children) {
      const next = byId.get(child)
      if (next !== undefined) visit(next)
    }
  }
  roots.forEach(visit)
  const sessions = [top, ...runs.flatMap((run) => (run.sessionID === null || run.sessionID === top ? [] : [run.sessionID]))]
  return { runs, sessions }
}

async function answerAsks(top: string, out: string) {
  const permissions = (await api("GET", `/api/session/${top}/permission`).catch(() => ({ data: [] }))).data ?? []
  for (const request of permissions) {
    log(out, `permission ${JSON.stringify(request).slice(0, 300)} -> once`)
    await api("POST", `/api/session/${top}/permission/${request.id}/reply`, { decision: "once" }).catch((error) => log(out, `reply failed: ${error}`))
  }
  const forms = (await api("GET", `/api/session/${top}/form`).catch(() => ({ data: [] }))).data ?? []
  for (const form of forms) {
    log(out, `form ${JSON.stringify(form).slice(0, 400)} -> cancel`)
    await api("DELETE", `/api/session/${top}/form/${form.id}`).catch((error) => log(out, `cancel failed: ${error}`))
  }
}

async function report(top: string, out: string, dir?: string, wallMs?: number) {
  await mkdir(path.join(out, "sessions"), { recursive: true })
  const tree = await treeOf(top)
  const roleOf = new Map(tree.runs.flatMap((run) => (run.sessionID === null ? [] : [[run.sessionID, `${run.role}${run.kind === "main" ? " (chat)" : ""}`] as const])))
  const sessions = []
  for (const id of tree.sessions) {
    const exported = await api("GET", `/api/experimental/session/${id}/export`).catch(() => undefined)
    if (exported === undefined) continue
    await writeFile(path.join(out, "sessions", `${id}.json`), JSON.stringify(exported, null, 1))
    sessions.push(sessionMetrics(id, roleOf.get(id) ?? "chat", exported.data ?? exported))
  }
  const runs = []
  for (const run of tree.runs) {
    const reports = []
    for (const name of (await readdir(path.join(teamsDir, "runs", run.id)).catch(() => [] as string[])).filter((entry) => /^report-\d+\.json$/.test(entry)).sort()) {
      const data = await Bun.file(path.join(teamsDir, "runs", run.id, name)).json().catch(() => ({}))
      reports.push({ file: name, status: data.status, summaryChars: String(data.summary ?? "").length, needs: data.needs?.length ?? 0, findings: data.findings?.length ?? 0, deferred: data.deferred?.length ?? 0 })
    }
    runs.push({
      id: run.id,
      role: run.role,
      kind: run.kind,
      state: run.state,
      parent: run.parent,
      children: run.children,
      worktree: run.worktree,
      attempts: run.attempts.map((attempt) => ({ n: attempt.n, state: attempt.state, trigger: attempt.trigger, ms: attempt.endedAt === undefined ? null : Date.parse(attempt.endedAt) - Date.parse(attempt.startedAt), ...(attempt.error === undefined ? {} : { error: attempt.error }) })),
      reports,
    })
  }
  const client = OpenCode.make({ baseUrl: url, headers })
  const plus = client.rpc(Definition)
  const location = dir === undefined ? undefined : { location: { directory: dir } }
  const monitor = {
    overview: await plus["monitor.query"]({ scope: "tree", sessionID: top, view: "overview" } as never, location as never).catch((error: unknown) => ({ error: String(error) })),
    cache: await plus["monitor.query"]({ scope: "tree", sessionID: top, view: "cache" } as never, location as never).catch((error: unknown) => ({ error: String(error) })),
  }
  const project = dir === undefined ? undefined : await projectState(dir)
  const totals = sumOf(sessions)
  const summary = { top, wallMs: wallMs ?? null, totals, sessions, runs, project, monitor }
  await writeFile(path.join(out, "summary.json"), JSON.stringify(summary, null, 1))
  await writeFile(path.join(out, "summary.md"), markdown(summary))
  console.log(markdown(summary))
}

// What one sent request of a chat is made of (the monitor's own breakdown): the latest, or the
// first with --first; --row N prints that row's text.
async function promptRows(sessionID: string, first: boolean, row?: number) {
  const plus = OpenCode.make({ baseUrl: url, headers }).rpc(Definition)
  const ask = (input: Record<string, unknown>) => plus["monitor.prompt"]({ sessionID, ...input } as never) as Promise<Record<string, any>>
  let current = await ask({})
  // --at N: the request at position N (0 = oldest), else the oldest with --first.
  const at = args.at === undefined ? undefined : Number(args.at)
  while ((first || (at !== undefined && current.position > at)) && typeof current.older === "string") current = await ask({ requestID: current.older })
  if (row !== undefined) current = await ask({ requestID: current.requestID, row })
  console.log(`request ${current.requestID} ${current.agent} ${current.model} ${current.verdict} bytes ${current.bytes} (${current.position}/${current.count})`)
  for (const [index, entry] of (current.rows ?? []).entries())
    console.log(`${String(index).padStart(3)} ${String(entry.chars).padStart(7)}  ${entry.change.padEnd(7)} ${entry.kind.padEnd(10)} ${entry.path}  ${entry.summary.slice(0, 80)}`)
  if (current.detail !== undefined) console.log(`\n--- row ${current.detail.row} ${current.detail.path}\n${current.detail.text}`)
}

type Metrics = ReturnType<typeof sessionMetrics>

function sessionMetrics(id: string, role: string, exported: { info: { agent?: string }; messages: Record<string, any>[] }) {
  const steps = exported.messages.filter((message) => message.type === "assistant")
  const types: Record<string, number> = {}
  for (const message of exported.messages) types[message.type] = (types[message.type] ?? 0) + 1
  const tools: Record<string, { calls: number; errors: number; outChars: number }> = {}
  for (const step of steps)
    for (const part of step.content ?? []) {
      if (part.type !== "tool") continue
      const entry = (tools[part.name] ??= { calls: 0, errors: 0, outChars: 0 })
      entry.calls += 1
      if (part.state?.status === "error") entry.errors += 1
      entry.outChars += JSON.stringify(part.state?.content ?? part.state?.error ?? "").length
    }
  const perStep = steps.map((step) => {
    const tokens = step.tokens ?? { input: 0, output: 0, cache: { read: 0, write: 0 } }
    const context = tokens.input + tokens.cache.read + tokens.cache.write
    return { input: tokens.input, read: tokens.cache.read, write: tokens.cache.write, output: tokens.output + (tokens.reasoning ?? 0), context, model: `${step.model?.providerID}/${step.model?.id}` }
  })
  const sum = (key: "input" | "read" | "write" | "output") => perStep.reduce((total, step) => total + step[key], 0)
  const later = perStep.slice(1)
  const laterContext = later.reduce((total, step) => total + step.context, 0)
  const first = steps[0]?.time?.created
  const last = steps.at(-1)?.time?.completed ?? steps.at(-1)?.time?.created
  return {
    id,
    role,
    agent: exported.info.agent ?? null,
    models: [...new Set(perStep.map((step) => step.model))],
    steps: steps.length,
    input: sum("input"),
    cacheRead: sum("read"),
    cacheWrite: sum("write"),
    output: sum("output"),
    contextFirst: perStep[0]?.context ?? 0,
    contextMax: Math.max(0, ...perStep.map((step) => step.context)),
    // Steps after the first: what share of their context came from the cache.
    cacheHitLater: laterContext === 0 ? null : later.reduce((total, step) => total + step.read, 0) / laterContext,
    // Steps after the first that read nothing from the cache although they carried context.
    coldLaterSteps: later.filter((step) => step.read === 0 && step.context > 0).length,
    messageTypes: types,
    tools,
    ms: first === undefined || last === undefined ? null : last - first,
    perStep,
  }
}

function sumOf(sessions: Metrics[]) {
  const total = (key: "steps" | "input" | "cacheRead" | "cacheWrite" | "output") => sessions.reduce((sum, session) => sum + session[key], 0)
  const tools: Record<string, { calls: number; errors: number }> = {}
  for (const session of sessions)
    for (const [name, entry] of Object.entries(session.tools)) {
      const into = (tools[name] ??= { calls: 0, errors: 0 })
      into.calls += entry.calls
      into.errors += entry.errors
    }
  const all = total("input") + total("cacheRead") + total("cacheWrite")
  return { chats: sessions.length, steps: total("steps"), input: total("input"), cacheRead: total("cacheRead"), cacheWrite: total("cacheWrite"), output: total("output"), cacheHit: all === 0 ? null : total("cacheRead") / all, tools }
}

async function projectState(dir: string) {
  const git = (...argv: string[]) => Bun.spawnSync(["git", "-C", dir, ...argv]).stdout.toString().trim()
  const test = Bun.spawnSync(["bun", "test"], { cwd: dir, stderr: "pipe", stdout: "pipe" })
  const lines = `${test.stdout.toString()}\n${test.stderr.toString()}`.split("\n")
  return {
    log: git("log", "--oneline", "-20"),
    status: git("status", "--short"),
    diffStat: git("diff", "--stat", "HEAD~0", git("rev-list", "--max-parents=0", "HEAD")),
    test: { exit: test.exitCode, tail: lines.filter((line) => /^\s*\d+ (pass|fail)|\(fail\)/.test(line)).join("\n") },
  }
}

function markdown(summary: { top: string; wallMs: number | null; totals: ReturnType<typeof sumOf>; sessions: Metrics[]; runs: any[]; project?: any }) {
  const pct = (value: number | null) => (value === null ? "-" : `${Math.round(value * 100)}%`)
  const k = (value: number) => `${Math.round(value / 100) / 10}k`
  const t = summary.totals
  return [
    `# ${summary.top}`,
    "",
    `wall ${summary.wallMs === null ? "-" : `${Math.round(summary.wallMs / 1000)} s`} · chats ${t.chats} · steps ${t.steps} · input ${k(t.input)} · cache read ${k(t.cacheRead)} · cache write ${k(t.cacheWrite)} · output ${k(t.output)} · cache hit ${pct(t.cacheHit)}`,
    "",
    "| chat | agent | steps | ctx first | ctx max | hit (later) | cold later | input | read | write | out | s | tools (calls/errors) |",
    "|---|---|---|---|---|---|---|---|---|---|---|---|---|",
    ...summary.sessions.map((session) =>
      `| ${session.role} | ${session.agent} | ${session.steps} | ${k(session.contextFirst)} | ${k(session.contextMax)} | ${pct(session.cacheHitLater)} | ${session.coldLaterSteps} | ${k(session.input)} | ${k(session.cacheRead)} | ${k(session.cacheWrite)} | ${k(session.output)} | ${session.ms === null ? "-" : Math.round(session.ms / 1000)} | ${Object.entries(session.tools).map(([name, entry]) => `${name} ${entry.calls}${entry.errors > 0 ? `/${entry.errors}` : ""}`).join(", ")} |`,
    ),
    "",
    "| run | role | state | attempts | reports |",
    "|---|---|---|---|---|",
    ...summary.runs.map((run) => `| ${run.id} | ${run.role} | ${run.state} | ${run.attempts.map((attempt: any) => `${attempt.n}:${attempt.state}${attempt.ms === null ? "" : ` ${Math.round(attempt.ms / 1000)}s`}`).join(" ")} | ${run.reports.map((entry: any) => entry.status).join(", ")} |`),
    "",
    ...(summary.project === undefined ? [] : ["```", summary.project.log, summary.project.status, summary.project.test.tail, "```"]),
  ].join("\n")
}

async function api(method: string, route: string, body?: unknown) {
  const response = await fetch(`${url}${route}`, {
    method,
    headers: { ...headers, ...(body === undefined ? {} : { "content-type": "application/json" }) },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (!response.ok) throw new Error(`${method} ${route}: ${response.status} ${(await response.text()).slice(0, 300)}`)
  const text = await response.text()
  return text === "" ? {} : JSON.parse(text)
}

function log(out: string, line: string) {
  const stamped = `${new Date().toISOString()} ${line}`
  console.error(stamped)
  return appendFile(path.join(out, "run.log"), `${stamped}\n`).catch(() => undefined)
}

function required(name: string): string {
  const value = args[name]
  if (value === undefined) {
    console.error(`missing --${name}`)
    process.exit(2)
  }
  return value
}

function parseArgs(argv: string[]) {
  const out: Record<string, string> & { _: string[] } = { _: [] } as never
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!
    if (arg.startsWith("--")) out[arg.slice(2)] = argv[++index] ?? ""
    else out._.push(arg)
  }
  return out
}
