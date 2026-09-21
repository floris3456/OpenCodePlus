// Round 3 live delegation lab driver.
//
// Evidence tooling, not a product change. It drives the REAL Plus delegate
// handler — the registered `team.delegate` tool by default, or the exported
// `createTeamApi` delegate with --direct-api — against a real isolated
// tui-lab host session. Only the session seams travel over the bridge: every
// host call is one of the documented `/api/session` routes
// (packages/protocol/src/groups/session.ts), over loopback, with Basic auth.
//
// A separate helper owns deterministic loopback model transport; this file
// never constructs, substitutes or fakes one. The parent run is only ever a
// seed for an existing genuine lab chat; the child run record and the child
// Location are made by the real delegate handler.
//
// Safety rules, enforced below and not configurable:
//   - the lab home must be an explicit directory under
//     /home/bliss/OpenCodePlus/run/tmp-build/tui-lab-*;
//   - the host URL must be loopback and must not be port 40374;
//   - the password comes from the environment and is never printed,
//     persisted, or included in any call record.
import { createHash } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import { Agent } from "@opencode/schema/agent"
import { Location } from "@opencode/schema/location"
import { Project } from "@opencode/schema/project"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { SessionInbox } from "@opencode/schema/session-inbox"
import { SessionMessage } from "@opencode/schema/session-message"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { createState, type PlusState } from "../src/index.js"
import { teamsDataDir } from "../src/instructions/paths.js"
import { createTeamApi, type TeamCaller } from "../src/teams/api.js"
import { gitRaw } from "../src/teams/git.js"
import { attemptTransition, bySession, loadRun, saveRun, startAttempt, type RunRecord } from "../src/teams/run.js"
import { Brief, RunID } from "../src/teams/schema.js"
import { registerTeamTools } from "../src/teams/tools.js"
import { context, toolHarness } from "../test/harness.js"

export const LAB_HOME_PREFIX = "/home/bliss/OpenCodePlus/run/tmp-build/tui-lab-"
export const HUMAN_SERVER_PORT = "40374"
export const DEFAULT_PASSWORD_ENV = "OPENCODEPLUS_LAB_PASSWORD"

export interface LabTargetInput {
  readonly labHome: string
  readonly baseUrl: string
}

export interface LabTargets {
  readonly labHome: string
  readonly baseUrl: string
  readonly dataHome: string
  readonly teamsRoot: string
}

// Pure string/path validation, so tests can check the refusals without a lab.
export function validateLabTarget(input: LabTargetInput): LabTargets {
  const labHome = path.resolve(input.labHome)
  if (!labHome.startsWith(LAB_HOME_PREFIX) || labHome === LAB_HOME_PREFIX)
    throw new Error(
      `--lab-home must be an explicit lab under ${LAB_HOME_PREFIX}<name>; refusing "${input.labHome}"`,
    )
  const name = labHome.slice(LAB_HOME_PREFIX.length)
  if (!/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..")
    throw new Error(`--lab-home must be ${LAB_HOME_PREFIX}<name> with a single directory name; refusing "${input.labHome}"`)

  let url: URL
  try {
    url = new URL(input.baseUrl)
  } catch {
    throw new Error(`--base-url is not a URL: "${input.baseUrl}"`)
  }
  if (url.protocol !== "http:" && url.protocol !== "https:")
    throw new Error(`--base-url must be http(s); refusing "${input.baseUrl}"`)
  if (url.username !== "" || url.password !== "")
    throw new Error("--base-url must not embed credentials; pass the password separately")
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "::1" || url.hostname === "[::1]"
  if (!loopback) throw new Error(`--base-url must be a loopback address (127.0.0.1, localhost or [::1]); refusing "${url.host}"`)
  if (url.port === "") throw new Error(`--base-url needs an explicit port; refusing "${input.baseUrl}"`)
  if (url.port === HUMAN_SERVER_PORT)
    throw new Error(`--base-url port ${HUMAN_SERVER_PORT} is the human's server; the driver refuses it`)
  if (url.pathname !== "/" || url.search !== "" || url.hash !== "")
    throw new Error(`--base-url must be the host origin with no path, query or fragment; refusing "${input.baseUrl}"`)

  return {
    labHome,
    baseUrl: url.origin,
    dataHome: path.join(labHome, "data"),
    teamsRoot: path.join(labHome, "data", "opencode", "opencodeplus", "teams"),
  }
}

// Same checks plus a real path check: the lab home must exist, and its
// resolved path must still be a tmp-build tui-lab directory, so a symlinked
// lab home cannot point into the human data root.
export async function resolveLabTargets(input: LabTargetInput): Promise<LabTargets> {
  const targets = validateLabTarget(input)
  const real = await fs.realpath(targets.labHome).catch(() => undefined)
  if (real === undefined) throw new Error(`lab home does not exist: ${targets.labHome}`)
  if (!real.includes("/run/tmp-build/tui-lab-"))
    throw new Error(`lab home resolves outside the tmp-build lab area: ${real}`)
  return {
    labHome: real,
    baseUrl: targets.baseUrl,
    dataHome: path.join(real, "data"),
    teamsRoot: path.join(real, "data", "opencode", "opencodeplus", "teams"),
  }
}

export interface HostCall {
  readonly method: "GET" | "POST"
  readonly path: string
  readonly status: number
}

export interface HostBridgeOptions {
  readonly baseUrl: string
  readonly password: string
  readonly fetchImpl?: typeof fetch
}

export interface HostBridge {
  /** Real host session seams over the documented HTTP routes. */
  readonly domain: SessionDomain
  /** Method, path and status only. Never the password or auth headers. */
  readonly calls: HostCall[]
}

export function hostBridge(options: HostBridgeOptions): HostBridge {
  const baseUrl = options.baseUrl.replace(/\/+$/, "")
  const fetchImpl = options.fetchImpl ?? fetch
  const calls: HostCall[] = []
  const authorization = `Basic ${Buffer.from(`opencode:${options.password}`, "utf8").toString("base64")}`

  async function request(method: "GET" | "POST", requestPath: string, body?: unknown): Promise<unknown> {
    const response = await fetchImpl(`${baseUrl}${requestPath}`, {
      method,
      headers: {
        authorization,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    calls.push({ method, path: requestPath, status: response.status })
    const text = await response.text()
    if (!response.ok)
      throw new Error(`host ${method} ${requestPath} -> ${response.status}: ${text.trim().slice(0, 200) || "no body"}`)
    if (text.trim() === "") return undefined
    return JSON.parse(text)
  }

  function dataOf(body: unknown, method: string, requestPath: string): unknown {
    if (typeof body === "object" && body !== null && "data" in body) return (body as { data: unknown }).data
    throw new Error(`host ${method} ${requestPath} returned no data`)
  }

  function segment(value: unknown): string {
    return encodeURIComponent(String(value))
  }

  // Every method maps one documented route to one client-API-shaped result;
  // the casts are the single bridge boundary between JSON and the host types.
  const domain: SessionDomain = {
    create: (input) =>
      Effect.promise(async () => {
        const body = await request("POST", "/api/session", input ?? {})
        return dataOf(body, "POST", "/api/session") as Session.Info
      }),
    get: (input) =>
      Effect.promise(async () => {
        const requestPath = `/api/session/${segment(input.sessionID)}`
        return dataOf(await request("GET", requestPath), "GET", requestPath) as Session.Info
      }),
    switchAgent: (input) =>
      Effect.promise(async () => {
        await request("POST", `/api/session/${segment(input.sessionID)}/agent`, { agent: input.agent })
      }),
    switchModel: (input) =>
      Effect.promise(async () => {
        await request("POST", `/api/session/${segment(input.sessionID)}/model`, { model: input.model })
      }),
    prompt: (input) =>
      Effect.promise(async () => {
        const requestPath = `/api/session/${segment(input.sessionID)}/prompt`
        const body = {
          text: input.text,
          ...(input.id === undefined ? {} : { id: input.id }),
          ...(input.delivery === undefined ? {} : { delivery: input.delivery }),
        }
        return dataOf(await request("POST", requestPath, body), "POST", requestPath) as SessionInbox.User
      }),
    generate: (input) =>
      Effect.promise(async () => {
        const requestPath = `/api/session/${segment(input.sessionID)}/generate`
        return dataOf(await request("POST", requestPath, { prompt: input.prompt }), "POST", requestPath) as {
          text: string
        }
      }),
    command: (input) =>
      Effect.promise(async () => {
        await request("POST", `/api/session/${segment(input.sessionID)}/command`, {
          command: input.command,
          text: input.text,
        })
      }),
    synthetic: (input) =>
      Effect.promise(async () => {
        const requestPath = `/api/session/${segment(input.sessionID)}/synthetic`
        return dataOf(
          await request("POST", requestPath, {
            text: input.text,
            ...(input.description === undefined ? {} : { description: input.description }),
            ...(input.resume === undefined ? {} : { resume: input.resume }),
          }),
          "POST",
          requestPath,
        ) as SessionInbox.Synthetic
      }),
    interrupt: (input) =>
      Effect.promise(async () => {
        const query = input.continue === undefined ? "" : `?continue=${input.continue ? "true" : "false"}`
        const requestPath = `/api/session/${segment(input.sessionID)}/interrupt${query}`
        const body = (await request("POST", requestPath)) as { interrupted?: unknown } | undefined
        return { interrupted: body?.interrupted === true }
      }),
    rename: (input) =>
      Effect.promise(async () => {
        await request("POST", `/api/session/${segment(input.sessionID)}/rename`, { title: input.title })
      }),
    move: (input) =>
      Effect.promise(async () => {
        await request("POST", `/api/session/${segment(input.sessionID)}/move`, {
          directory: input.directory,
          ...(input.workspaceID === undefined ? {} : { workspaceID: input.workspaceID }),
        })
      }),
    wait: (input) =>
      Effect.promise(async () => {
        await request("POST", `/api/session/${segment(input.sessionID)}/wait`)
      }),
    context: (input) =>
      Effect.promise(async () => {
        const requestPath = `/api/session/${segment(input.sessionID)}/context`
        return dataOf(await request("GET", requestPath), "GET", requestPath) as ReadonlyArray<SessionMessage.Info>
      }),
    // Model hooks stay in the host process; the bridge carries session calls only.
    hook: () => Effect.succeed({ dispose: Effect.void }),
  }

  return { domain, calls }
}

export interface LabToolContext {
  readonly ctx: Context
  readonly state: PlusState
  readonly tools: Map<string, Tool.Info & { readonly id: string }>
  readonly dispose: () => Promise<void>
}

// The session domain is the caller's bridge; the shared test harness supplies
// the non-session domains a full Context needs, and its tool harness lets the
// caller read the tools the real registration published.
export async function labToolContext(options: { directory: string; session: SessionDomain }): Promise<LabToolContext> {
  const tools = toolHarness()
  const root = AbsolutePath.make(options.directory)
  const location = new Location.Info({
    directory: root,
    project: { id: Project.ID.global, directory: root, canonical: root },
  })
  const ctx = context({ location, tool: tools.domain, session: options.session })
  const state = createState()
  const registration = await registerTeamTools(ctx, createTeamApi(ctx, state))
  return {
    ctx,
    state,
    tools: tools.tools,
    dispose: () => Effect.runPromise(registration.dispose),
  }
}

export interface ParentSeed {
  readonly root: string
  readonly id: string
  readonly role: string
  readonly sessionID: string
  readonly directory: string
  readonly bundle?: string
}

// Seed (or re-find) the parent run for an existing genuine lab chat. This is
// the only run record the driver writes by hand; the child is always created
// by the delegate handler.
export async function seedParentRun(seed: ParentSeed): Promise<RunRecord> {
  Schema.decodeUnknownSync(RunID)(seed.id)
  const existing = await loadRun(seed.root, seed.id)
  if (existing !== undefined) {
    if (existing.sessionID !== seed.sessionID || existing.directory !== seed.directory)
      throw new Error(
        `run ${seed.id} already exists for session ${existing.sessionID} at ${existing.directory}; ` +
          `pick another --parent-run or remove the stale seed`,
      )
    return existing
  }
  const top = await gitRaw(seed.directory, ["rev-parse", "--show-toplevel"])
  if (top.code !== 0) throw new Error(`parent directory is not a git worktree: ${seed.directory}: ${top.err || top.out}`)
  const head = await gitRaw(seed.directory, ["rev-parse", "HEAD"])
  if (head.code !== 0) throw new Error(`cannot read HEAD in ${seed.directory}: ${head.err || head.out}`)
  const branch = await gitRaw(seed.directory, ["rev-parse", "--abbrev-ref", "HEAD"])
  const repoKey = path.basename(top.out) || top.out
  const now = new Date().toISOString()
  const base: RunRecord = {
    id: seed.id,
    role: seed.role,
    kind: "main",
    repo: repoKey,
    repoKey,
    directory: seed.directory,
    paths: [],
    branch: branch.code === 0 && branch.out.length > 0 ? branch.out : "HEAD",
    base: head.out,
    head: head.out,
    state: "working",
    attempts: [],
    task: null,
    parent: null,
    children: [],
    briefSha: "",
    bundle: seed.bundle ?? "round3-delegate-lab",
    budget: {},
    createdAt: now,
    lastUsed: now,
    sessionID: seed.sessionID,
    configDigest: null,
    history: [],
  }
  const admitted = attemptTransition(startAttempt(base, { trigger: "prepare" }), "admitted", "admit")
  const streaming = attemptTransition(admitted, "streaming", "first_event")
  await saveRun(seed.root, streaming)
  return streaming
}

export function defaultParentRunID(sessionID: string): string {
  const hex = createHash("sha256").update(sessionID, "utf8").digest("hex").slice(0, 16)
  return `main-${hex}`
}

export async function fetchParentSession(bridge: HostBridge, sessionID: string): Promise<Session.Info> {
  const id = Schema.decodeUnknownSync(Session.ID)(sessionID)
  return Effect.runPromise(bridge.domain.get({ sessionID: id }))
}

export interface DelegateRequest {
  readonly lab: LabToolContext
  readonly brief: Brief
  readonly parent: { readonly sessionID: string; readonly role: string; readonly callID?: string }
  readonly via?: "tool" | "api"
}

export interface DelegateOutcome {
  readonly via: "team.delegate" | "TeamApi.delegate"
  readonly output: Record<string, unknown>
}

// Drive the real handler: the registered `team.delegate` tool by default, the
// exported `TeamApi.delegate` with via:"api". Either way the session seams are
// whatever `lab.ctx.session` is — in the lab, the host bridge.
export async function delegateThroughHost(request: DelegateRequest): Promise<DelegateOutcome> {
  const sessionID = Schema.decodeUnknownSync(Session.ID)(request.parent.sessionID)
  const run = await bySession(teamsDataDir(), String(sessionID))
  if (run === undefined)
    throw new Error(
      `no run owns session ${sessionID} under ${teamsDataDir()}; seed the parent run for this genuine chat first`,
    )
  const caller: TeamCaller = { sessionID: String(sessionID), agent: request.parent.role, run }

  if (request.via === "api") {
    const api = createTeamApi(request.lab.ctx, request.lab.state)
    const result = await api.delegate(request.brief, caller)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return { via: "TeamApi.delegate", output: result.value as Record<string, unknown> }
  }

  const tool = request.lab.tools.get("team_delegate")
  if (tool === undefined)
    throw new Error("team_delegate is not registered; the tool harness did not publish it")
  const toolCtx: Tool.Context = {
    sessionID,
    agent: Agent.ID.make(request.parent.role),
    messageID: SessionMessage.ID.make("msg_round3_delegate"),
    id: Tool.CallID.make(request.parent.callID ?? "round3-delegate-call"),
    progress: () => Effect.void,
  }
  const result = await Effect.runPromise(tool.execute(request.brief, toolCtx)).catch((error: unknown) => {
    throw new Error(error instanceof Error ? error.message : String(error))
  })
  return { via: "team.delegate", output: result.output as Record<string, unknown> }
}

export interface DriverArgs {
  readonly help: boolean
  readonly seedOnly: boolean
  readonly directApi: boolean
  readonly labHome: string | undefined
  readonly baseUrl: string | undefined
  readonly passwordEnv: string
  readonly password: string | undefined
  readonly parentSession: string | undefined
  readonly parentRun: string | undefined
  readonly parentRole: string
  readonly callID: string
  readonly model: string | undefined
  readonly brief: string | undefined
}

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (value === undefined || value === "") throw new Error(`${flag} needs a value`)
  return value
}

export function parseArgs(argv: readonly string[]): DriverArgs {
  const args: {
    help: boolean
    seedOnly: boolean
    directApi: boolean
    labHome?: string
    baseUrl?: string
    passwordEnv: string
    password?: string
    parentSession?: string
    parentRun?: string
    parentRole: string
    callID: string
    model?: string
    brief?: string
  } = {
    help: false,
    seedOnly: false,
    directApi: false,
    passwordEnv: DEFAULT_PASSWORD_ENV,
    parentRole: "opus-orchestrator",
    callID: "round3-delegate-call",
  }
  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === "--help" || flag === "-h") {
      args.help = true
      continue
    }
    if (flag === "--seed-only") {
      args.seedOnly = true
      continue
    }
    if (flag === "--direct-api") {
      args.directApi = true
      continue
    }
    if (flag === "--lab-home") {
      args.labHome = takeValue(argv, index, flag)
      index++
      continue
    }
    if (flag === "--base-url") {
      args.baseUrl = takeValue(argv, index, flag)
      index++
      continue
    }
    if (flag === "--password-env") {
      const name = takeValue(argv, index, flag)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`--password-env is not an environment variable name: "${name}"`)
      args.passwordEnv = name
      index++
      continue
    }
    if (flag === "--password") {
      args.password = takeValue(argv, index, flag)
      index++
      continue
    }
    if (flag === "--parent-session") {
      args.parentSession = takeValue(argv, index, flag)
      index++
      continue
    }
    if (flag === "--parent-run") {
      args.parentRun = takeValue(argv, index, flag)
      index++
      continue
    }
    if (flag === "--parent-role") {
      args.parentRole = takeValue(argv, index, flag)
      index++
      continue
    }
    if (flag === "--call-id") {
      args.callID = takeValue(argv, index, flag)
      index++
      continue
    }
    if (flag === "--model") {
      args.model = takeValue(argv, index, flag)
      index++
      continue
    }
    if (flag === "--brief") {
      args.brief = takeValue(argv, index, flag)
      index++
      continue
    }
    throw new Error(`unknown flag "${flag}"; run with --help`)
  }
  return {
    help: args.help,
    seedOnly: args.seedOnly,
    directApi: args.directApi,
    labHome: args.labHome,
    baseUrl: args.baseUrl,
    passwordEnv: args.passwordEnv,
    password: args.password,
    parentSession: args.parentSession,
    parentRun: args.parentRun,
    parentRole: args.parentRole,
    callID: args.callID,
    model: args.model,
    brief: args.brief,
  }
}

export function usage(): string {
  return `round3-delegate — lab-only driver for the real Plus team delegate handler

Usage:
  bun docs/round3-delegate.ts --lab-home <lab> --base-url <url> \\
      --parent-session <ses_...> --brief <file|json|-> [options]

Required:
  --lab-home <path>      explicit lab home under ${LAB_HOME_PREFIX}<name>
  --base-url <url>       loopback lab host origin, e.g. http://127.0.0.1:51789
                         (port ${HUMAN_SERVER_PORT}, the human's server, is refused)
  --parent-session <id>  session id of an existing genuine lab chat
  --brief <file|json|->  delegate Brief as a JSON file, inline JSON, or - for stdin

Auth:
  ${DEFAULT_PASSWORD_ENV} (default), or --password-env <NAME>, or --password <value>.
  The value is never printed, persisted, or recorded; only the host's
  Authorization header ever sees it.

Options:
  --parent-run <id>      seed id for the parent run
                         (default: main-<16 hex of sha256(session)>)
  --parent-role <role>   role recorded on the seeded parent run
                         (default: opus-orchestrator)
  --call-id <id>         Tool.Context call id for the registered handler
                         (default: round3-delegate-call)
  --model <providerID/modelID>
                         pin the model the child session switches to, through
                         the bridge's switchModel seam; omit to leave the lab
                         host's model choice alone
  --seed-only            write/verify the parent seed and stop
  --direct-api           call TeamApi.delegate instead of the team.delegate tool
  --help                 this text

Environment fallbacks: OPENCODEPLUS_LAB_HOME, OPENCODEPLUS_LAB_BASE_URL,
OPENCODEPLUS_LAB_PARENT_SESSION.

The child run, its worktree and its session are created by the real delegate
handler. The parent run is a seed for a chat that already exists; the driver
never fabricates the child. Deterministic loopback model transport is a
separate helper and is not part of this driver.`
}

export async function readBrief(raw: string): Promise<Brief> {
  const text =
    raw.trimStart().startsWith("{") ? raw : raw === "-" ? await Bun.stdin.text() : await Bun.file(raw).text()
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch (error) {
    throw new Error(`--brief is not valid JSON: ${error instanceof Error ? error.message : String(error)}`)
  }
  try {
    return Schema.decodeUnknownSync(Brief)(parsed)
  } catch (error) {
    throw new Error(`--brief is not a valid delegate Brief: ${error instanceof Error ? error.message : String(error)}`)
  }
}

function required(value: string | undefined, flag: string, env: string): string {
  if (value !== undefined && value !== "") return value
  throw new Error(`${flag} is required (or set ${env})`)
}

export async function main(argv: readonly string[] = Bun.argv.slice(2)): Promise<number> {
  const args = parseArgs(argv)
  if (args.help) {
    console.log(usage())
    return 0
  }

  const targets = await resolveLabTargets({
    labHome: required(args.labHome ?? process.env.OPENCODEPLUS_LAB_HOME, "--lab-home", "OPENCODEPLUS_LAB_HOME"),
    baseUrl: required(args.baseUrl ?? process.env.OPENCODEPLUS_LAB_BASE_URL, "--base-url", "OPENCODEPLUS_LAB_BASE_URL"),
  })
  const parentSessionID = required(
    args.parentSession ?? process.env.OPENCODEPLUS_LAB_PARENT_SESSION,
    "--parent-session",
    "OPENCODEPLUS_LAB_PARENT_SESSION",
  )
  const password = args.password ?? process.env[args.passwordEnv]
  if (password === undefined || password === "")
    throw new Error(`lab password missing; set ${args.passwordEnv} (or use --password-env/--password)`)

  process.env.XDG_DATA_HOME = targets.dataHome
  if (teamsDataDir() !== targets.teamsRoot)
    throw new Error(`internal: teams data root ${teamsDataDir()} does not match the lab home ${targets.teamsRoot}`)

  const bridge = hostBridge({ baseUrl: targets.baseUrl, password })
  const parent = await fetchParentSession(bridge, parentSessionID)
  const directory = String(parent.location.directory)
  const parentRunID = args.parentRun ?? defaultParentRunID(String(parent.id))
  const seeded = await seedParentRun({
    root: targets.teamsRoot,
    id: parentRunID,
    role: args.parentRole,
    sessionID: String(parent.id),
    directory,
  })

  const report = {
    lab: { baseUrl: targets.baseUrl, labHome: targets.labHome, teamsRoot: targets.teamsRoot },
    parent: {
      run: seeded.id,
      session: seeded.sessionID,
      role: seeded.role,
      directory: seeded.directory,
      state: seeded.state,
    },
    hostCalls: bridge.calls,
  }
  if (args.seedOnly) {
    console.log(JSON.stringify({ ok: true, seededOnly: true, ...report }, null, 2))
    return 0
  }

  if (args.brief === undefined) throw new Error("--brief is required unless --seed-only")
  const brief = await readBrief(args.brief)
  const lab = await labToolContext({ directory, session: bridge.domain })
  if (args.model !== undefined) {
    const [providerID, modelID, ...rest] = args.model.split("/")
    if (providerID === undefined || providerID === "" || modelID === undefined || modelID === "" || rest.length > 0)
      throw new Error(`--model must be <providerID>/<modelID>; got "${args.model}"`)
    lab.state.activeModels.set(brief.role, { providerID, modelID })
  }
  try {
    const outcome = await delegateThroughHost({
      lab,
      brief,
      parent: { sessionID: String(parent.id), role: args.parentRole, callID: args.callID },
      ...(args.directApi ? { via: "api" as const } : {}),
    })
    const child = await loadRun(targets.teamsRoot, String(outcome.output.run))
    console.log(
      JSON.stringify(
        {
          ok: true,
          via: outcome.via,
          ...report,
          child: child === undefined
            ? outcome.output
            : {
                run: child.id,
                session: child.sessionID,
                role: child.role,
                state: child.state,
                directory: child.directory,
                branch: child.branch,
                parent: child.parent,
              },
          output: outcome.output,
        },
        null,
        2,
      ),
    )
    return 0
  } finally {
    await lab.dispose()
  }
}

if (import.meta.main) {
  try {
    process.exitCode = await main()
  } catch (error) {
    console.error(`round3-delegate: ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}