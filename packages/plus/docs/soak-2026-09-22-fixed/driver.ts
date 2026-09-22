// Soak lifecycle lab driver.
//
// Lab-only evidence tooling extending round3-delegate into a complete lifecycle
// driver that can invoke the real registered team tools against a genuine lab
// parent/child session: delegate, status, wait, integrate, stop, supersede,
// list, get_context, checkpoint, check, finish.
//
// Safety rules (enforced and not configurable):
//   - lab home must be an explicit directory under /home/bliss/OpenCodePlus/run/tmp-build/tui-lab-*;
//   - host URL must be loopback and must not be port 40374;
//   - password comes from environment/flag and is never printed, persisted,
//     or included in any call record or output JSON.
//
// Emits pure JSON only to stdout. Hard configurable timeout (default 10 min)
// bounds waits/polling.
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
import { createState, type PlusState } from "../../src/index.js"
import { teamsDataDir } from "../../src/instructions/paths.js"
import { createTeamApi, type TeamApi, type TeamApiResult, type TeamCaller } from "../../src/teams/api.js"
import { git, gitRaw } from "../../src/teams/git.js"
import { attemptTransition, bySession, loadRun, saveRun, startAttempt, type RunRecord } from "../../src/teams/run.js"
import {
  Brief,
  CheckInput,
  CheckpointInput,
  DiffInput,
  GetContextInput,
  IntegrateInput,
  ListInput,
  Report,
  RunID,
  StatusInput,
  StopInput,
  SupersedeInput,
  WaitInput,
  parseDuration,
} from "../../src/teams/schema.js"
import { registerTeamTools } from "../../src/teams/tools.js"
import { context, toolHarness } from "../../test/harness.js"

export const LAB_HOME_PREFIX = "/home/bliss/OpenCodePlus/run/tmp-build/tui-lab-"
export const HUMAN_SERVER_PORT = "40374"
export const DEFAULT_PASSWORD_ENV = "OPENCODEPLUS_LAB_PASSWORD"
export const DEFAULT_TIMEOUT_MS = 600_000 // 10 minutes

export const SUPPORTED_TOOLS = [
  "delegate",
  "status",
  "wait",
  "integrate",
  "stop",
  "supersede",
  "list",
  "get_context",
  "checkpoint",
  "check",
  "finish",
  "diff",
] as const

export type SupportedTool = (typeof SUPPORTED_TOOLS)[number]

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
  readonly domain: SessionDomain
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
    bundle: seed.bundle ?? "soak-lab",
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

export interface ChildInfo {
  run: string
  session: string
  role: string
  directory: string
  state?: string
  branch?: string
  parent?: string | null
}

export function parseTimeout(val: unknown, fallbackMs = DEFAULT_TIMEOUT_MS): number {
  if (typeof val === "number" && Number.isFinite(val) && val >= 0) return Math.trunc(val)
  if (typeof val === "string") {
    const trimmed = val.trim()
    const numeric = Number(trimmed)
    if (!isNaN(numeric) && Number.isFinite(numeric) && numeric >= 0) return Math.trunc(numeric)
    return parseDuration(trimmed)
  }
  return fallbackMs
}

export async function executeWithTimeout<T>(
  action: () => Promise<T>,
  timeoutMs: number,
  label: string,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      reject(new Error(`hard timeout of ${timeoutMs}ms exceeded while waiting for ${label}`))
    }, timeoutMs)
  })
  return Promise.race([action(), timeoutPromise]).finally(() => {
    if (timer !== undefined) clearTimeout(timer)
  })
}

export function normalizeToolName(raw: string): SupportedTool {
  let name = raw.trim()
  if (name.startsWith("team.")) name = name.slice("team.".length)
  if (name.startsWith("team_")) name = name.slice("team_".length)
  if (name === "getContext") name = "get_context"
  if (!SUPPORTED_TOOLS.includes(name as SupportedTool)) {
    throw new Error(`unsupported team tool "${raw}"; supported tools: ${SUPPORTED_TOOLS.join(", ")}`)
  }
  return name as SupportedTool
}

export async function loadJsonInput(raw: string): Promise<unknown> {
  const trimmed = raw.trim()
  const text =
    trimmed === "-"
      ? await Bun.stdin.text()
      : trimmed.startsWith("{") || trimmed.startsWith("[")
        ? trimmed
        : await Bun.file(trimmed).text()
  try {
    return JSON.parse(text)
  } catch (error) {
    throw new Error(`invalid JSON command input: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function readBrief(raw: string): Promise<Brief> {
  const parsed = await loadJsonInput(raw)
  try {
    return Schema.decodeUnknownSync(Brief)(parsed)
  } catch (error) {
    throw new Error(`not a valid delegate Brief: ${error instanceof Error ? error.message : String(error)}`)
  }
}

export async function prepareToolInput(
  toolName: SupportedTool,
  raw: unknown,
  contextState: {
    parentDirectory: string
    callerDirectory: string
    child?: ChildInfo
    timeoutMs: number
  },
): Promise<unknown> {
  const isObject = typeof raw === "object" && raw !== null
  const inputObj = isObject ? { ...(raw as Record<string, unknown>) } : {}

  if (toolName === "delegate") {
    if (typeof raw === "string") return readBrief(raw)
    return Schema.decodeUnknownSync(Brief)(raw)
  }
  if (toolName === "status") {
    return Schema.decodeUnknownSync(StatusInput)(raw ?? {})
  }
  if (toolName === "wait") {
    if (inputObj.runs === undefined && contextState.child?.run !== undefined) {
      inputObj.runs = [contextState.child.run]
    }
    if (inputObj.timeoutMs === undefined) {
      inputObj.timeoutMs = contextState.timeoutMs
    }
    return Schema.decodeUnknownSync(WaitInput)(inputObj)
  }
  if (toolName === "integrate") {
    if (inputObj.run === undefined && contextState.child?.run !== undefined) {
      inputObj.run = contextState.child.run
    }
    if (inputObj.expectedParentHead === undefined) {
      const head = await git(contextState.parentDirectory, ["rev-parse", "HEAD"])
      inputObj.expectedParentHead = head.trim()
    }
    return Schema.decodeUnknownSync(IntegrateInput)(inputObj)
  }
  if (toolName === "stop") {
    if (inputObj.run === undefined && contextState.child?.run !== undefined) {
      inputObj.run = contextState.child.run
    }
    return Schema.decodeUnknownSync(StopInput)(inputObj)
  }
  if (toolName === "supersede") {
    if (inputObj.run === undefined && contextState.child?.run !== undefined) {
      inputObj.run = contextState.child.run
    }
    return Schema.decodeUnknownSync(SupersedeInput)(inputObj)
  }
  if (toolName === "list") {
    return Schema.decodeUnknownSync(ListInput)(raw ?? {})
  }
  if (toolName === "get_context") {
    return Schema.decodeUnknownSync(GetContextInput)(raw ?? {})
  }
  if (toolName === "checkpoint") {
    if (inputObj.expectedHead === undefined) {
      const head = await git(contextState.callerDirectory, ["rev-parse", "HEAD"])
      inputObj.expectedHead = head.trim()
    }
    return Schema.decodeUnknownSync(CheckpointInput)(inputObj)
  }
  if (toolName === "check") {
    return Schema.decodeUnknownSync(CheckInput)(raw)
  }
  if (toolName === "finish") {
    return Schema.decodeUnknownSync(Report)(raw)
  }
  if (toolName === "diff") {
    if (inputObj.run === undefined && contextState.child?.run !== undefined) {
      inputObj.run = contextState.child.run
    }
    return Schema.decodeUnknownSync(DiffInput)(inputObj)
  }
  throw new Error(`unsupported tool: ${toolName}`)
}

export async function resolveChild(
  teamsRoot: string,
  options: { childSession?: string; childRun?: string; childRole?: string; parentRun?: RunRecord },
): Promise<ChildInfo | undefined> {
  if (options.childSession !== undefined && options.childSession !== "") {
    const run = await bySession(teamsRoot, options.childSession)
    if (run !== undefined) {
      return {
        run: run.id,
        session: run.sessionID ?? options.childSession,
        role: options.childRole ?? run.role,
        directory: run.directory,
        state: run.state,
        branch: run.branch,
        parent: run.parent,
      }
    }
  }
  if (options.childRun !== undefined && options.childRun !== "") {
    const run = await loadRun(teamsRoot, options.childRun)
    if (run !== undefined && run.sessionID !== null) {
      return {
        run: run.id,
        session: run.sessionID,
        role: options.childRole ?? run.role,
        directory: run.directory,
        state: run.state,
        branch: run.branch,
        parent: run.parent,
      }
    }
  }
  if (options.parentRun !== undefined && options.parentRun.children.length > 0) {
    const latestChildID = options.parentRun.children.at(-1)
    if (latestChildID !== undefined) {
      const run = await loadRun(teamsRoot, latestChildID)
      if (run !== undefined && run.sessionID !== null) {
        return {
          run: run.id,
          session: run.sessionID,
          role: options.childRole ?? run.role,
          directory: run.directory,
          state: run.state,
          branch: run.branch,
          parent: run.parent,
        }
      }
    }
  }
  return undefined
}

export async function determineCaller(
  teamsRoot: string,
  toolName: SupportedTool,
  callerChoice: "parent" | "child" | undefined,
  explicitSessionID: string | undefined,
  explicitRole: string | undefined,
  parent: { sessionID: string; role: string; directory: string },
  child: ChildInfo | undefined,
): Promise<{ sessionID: string; role: string; directory: string }> {
  if (explicitSessionID !== undefined) {
    if (child?.sessionID === explicitSessionID) {
      return {
        sessionID: explicitSessionID,
        role: explicitRole ?? child.role,
        directory: child.directory,
      }
    }
    if (parent.sessionID === explicitSessionID) {
      return {
        sessionID: explicitSessionID,
        role: explicitRole ?? parent.role,
        directory: parent.directory,
      }
    }
    const run = await bySession(teamsRoot, explicitSessionID)
    if (run !== undefined) {
      return {
        sessionID: explicitSessionID,
        role: explicitRole ?? run.role,
        directory: run.directory,
      }
    }
    return {
      sessionID: explicitSessionID,
      role: explicitRole ?? parent.role,
      directory: parent.directory,
    }
  }

  const childTools: readonly SupportedTool[] = ["get_context", "checkpoint", "check", "finish"]
  const wantChild = callerChoice === "child" || (callerChoice === undefined && childTools.includes(toolName))

  if (wantChild) {
    if (child === undefined)
      throw new Error(`cannot invoke ${toolName} as child: no child session known; delegate first or specify --child-session`)
    return {
      sessionID: child.sessionID,
      role: explicitRole ?? child.role,
      directory: child.directory,
    }
  }

  return {
    sessionID: parent.sessionID,
    role: explicitRole ?? parent.role,
    directory: parent.directory,
  }
}

export interface InvokeToolRequest {
  readonly lab: LabToolContext
  readonly toolName: string
  readonly input: unknown
  readonly caller: {
    readonly sessionID: string
    readonly role: string
    readonly callID?: string
  }
  readonly via?: "tool" | "api"
  readonly timeoutMs?: number
  readonly model?: string
}

export interface InvokeToolOutcome {
  readonly tool: SupportedTool
  readonly via: string
  readonly output: unknown
}

export async function invokeToolThroughHost(request: InvokeToolRequest): Promise<InvokeToolOutcome> {
  const toolName = normalizeToolName(request.toolName)
  const sessionID = Schema.decodeUnknownSync(Session.ID)(request.caller.sessionID)
  const run = await bySession(teamsDataDir(), String(sessionID))
  if (run === undefined)
    throw new Error(
      `no run owns session ${sessionID} under ${teamsDataDir()}; seed the parent run or ensure the run exists for this session`,
    )
  const caller: TeamCaller = { sessionID: String(sessionID), agent: request.caller.role, run }

  if (toolName === "delegate" && request.model !== undefined) {
    const [providerID, modelID, ...rest] = request.model.split("/")
    if (providerID === undefined || providerID === "" || modelID === undefined || modelID === "" || rest.length > 0)
      throw new Error(`--model must be <providerID>/<modelID>; got "${request.model}"`)
    const briefRole = (request.input as { role?: string })?.role ?? request.caller.role
    request.lab.state.activeModels.set(briefRole, { providerID, modelID })
  }

  const timeoutMs = request.timeoutMs ?? DEFAULT_TIMEOUT_MS

  if (request.via === "api") {
    const api = createTeamApi(request.lab.ctx, request.lab.state)
    const apiFn = (api as unknown as Record<string, (input: unknown, caller: TeamCaller) => Promise<TeamApiResult>>)[toolName]
    if (typeof apiFn !== "function")
      throw new Error(`TeamApi.${toolName} is not a function`)
    const result = await executeWithTimeout(() => apiFn(request.input, caller), timeoutMs, `TeamApi.${toolName}`)
    if (!result.ok) throw new Error(`${result.error.code}: ${result.error.message}`)
    return { tool: toolName, via: `TeamApi.${toolName}`, output: result.value }
  }

  const tool = request.lab.tools.get(`team_${toolName}`)
  if (tool === undefined)
    throw new Error(`team_${toolName} is not registered; the tool harness did not publish it`)

  const toolCtx: Tool.Context = {
    sessionID,
    agent: Agent.ID.make(request.caller.role),
    messageID: SessionMessage.ID.make(`msg_soak_${Date.now()}`),
    id: Tool.CallID.make(request.caller.callID ?? `soak-${toolName}-call`),
    progress: () => Effect.void,
  }

  const result = await executeWithTimeout(
    () =>
      Effect.runPromise(tool.execute(request.input, toolCtx)).catch((error: unknown) => {
        throw new Error(error instanceof Error ? error.message : String(error))
      }),
    timeoutMs,
    `team.${toolName}`,
  )
  return { tool: toolName, via: `team.${toolName}`, output: result.output }
}

export interface RawCommandItem {
  readonly tool?: string
  readonly command?: string
  readonly action?: string
  readonly name?: string
  readonly input?: unknown
  readonly args?: unknown
  readonly arguments?: unknown
  readonly as?: "parent" | "child"
  readonly caller?: "parent" | "child"
  readonly sessionID?: string
  readonly role?: string
  readonly callID?: string
  readonly via?: "tool" | "api"
  readonly timeoutMs?: number
  readonly timeout?: string | number
  readonly [key: string]: unknown
}

export function extractCommand(item: RawCommandItem): {
  readonly toolName: string
  readonly rawInput: unknown
  readonly callerChoice?: "parent" | "child"
  readonly sessionID?: string
  readonly role?: string
  readonly callID?: string
  readonly via?: "tool" | "api"
  readonly timeoutMs?: number
} {
  const toolName = String(item.tool ?? item.command ?? item.action ?? item.name ?? "")
  if (toolName === "") throw new Error("command item missing tool or command name")
  const callerChoice = item.as ?? item.caller
  const sessionID = item.sessionID
  const role = item.role
  const callID = item.callID
  const via = item.via
  const timeoutMs =
    item.timeoutMs !== undefined
      ? parseTimeout(item.timeoutMs)
      : item.timeout !== undefined
        ? parseTimeout(item.timeout)
        : undefined

  let rawInput = item.input ?? item.args ?? item.arguments
  if (rawInput === undefined) {
    const copy = { ...item }
    delete copy.tool
    delete copy.command
    delete copy.action
    delete copy.name
    delete copy.input
    delete copy.args
    delete copy.arguments
    delete copy.as
    delete copy.caller
    delete copy.sessionID
    delete copy.role
    delete copy.callID
    delete copy.via
    delete copy.timeoutMs
    delete copy.timeout
    rawInput = Object.keys(copy).length > 0 ? copy : undefined
  }

  return { toolName, rawInput, callerChoice, sessionID, role, callID, via, timeoutMs }
}

export interface DriverPlan {
  readonly labHome?: string
  readonly baseUrl?: string
  readonly password?: string
  readonly passwordEnv?: string
  readonly parentSession?: string
  readonly parentRun?: string
  readonly parentRole?: string
  readonly childSession?: string
  readonly childRun?: string
  readonly childRole?: string
  readonly timeoutMs?: number
  readonly model?: string
  readonly callID?: string
  readonly directApi?: boolean
  readonly seedOnly?: boolean
  readonly commands: readonly RawCommandItem[]
}

export function parseExecutionPlan(raw: unknown): DriverPlan {
  if (Array.isArray(raw)) {
    return {
      commands: raw as readonly RawCommandItem[],
    }
  }

  if (typeof raw !== "object" || raw === null) {
    throw new Error("command input must be a JSON object or array")
  }

  const obj = raw as Record<string, unknown>

  if (
    typeof obj.requestID === "string" &&
    typeof obj.role === "string" &&
    typeof obj.objective === "string" &&
    typeof obj.deliverable === "object" &&
    obj.deliverable !== null
  ) {
    return {
      commands: [{ tool: "delegate", input: obj }],
    }
  }

  if (Array.isArray(obj.commands)) {
    return {
      labHome: typeof obj.labHome === "string" ? obj.labHome : undefined,
      baseUrl: typeof obj.baseUrl === "string" ? obj.baseUrl : undefined,
      password: typeof obj.password === "string" ? obj.password : undefined,
      passwordEnv: typeof obj.passwordEnv === "string" ? obj.passwordEnv : undefined,
      parentSession: typeof obj.parentSession === "string" ? obj.parentSession : undefined,
      parentRun: typeof obj.parentRun === "string" ? obj.parentRun : undefined,
      parentRole: typeof obj.parentRole === "string" ? obj.parentRole : undefined,
      childSession: typeof obj.childSession === "string" ? obj.childSession : undefined,
      childRun: typeof obj.childRun === "string" ? obj.childRun : undefined,
      childRole: typeof obj.childRole === "string" ? obj.childRole : undefined,
      timeoutMs:
        obj.timeoutMs !== undefined
          ? parseTimeout(obj.timeoutMs)
          : obj.timeout !== undefined
            ? parseTimeout(obj.timeout)
            : undefined,
      model: typeof obj.model === "string" ? obj.model : undefined,
      callID: typeof obj.callID === "string" ? obj.callID : undefined,
      directApi: obj.directApi === true,
      seedOnly: obj.seedOnly === true,
      commands: obj.commands as readonly RawCommandItem[],
    }
  }

  if (Array.isArray(obj.steps)) {
    return {
      labHome: typeof obj.labHome === "string" ? obj.labHome : undefined,
      baseUrl: typeof obj.baseUrl === "string" ? obj.baseUrl : undefined,
      password: typeof obj.password === "string" ? obj.password : undefined,
      passwordEnv: typeof obj.passwordEnv === "string" ? obj.passwordEnv : undefined,
      parentSession: typeof obj.parentSession === "string" ? obj.parentSession : undefined,
      parentRun: typeof obj.parentRun === "string" ? obj.parentRun : undefined,
      parentRole: typeof obj.parentRole === "string" ? obj.parentRole : undefined,
      childSession: typeof obj.childSession === "string" ? obj.childSession : undefined,
      childRun: typeof obj.childRun === "string" ? obj.childRun : undefined,
      childRole: typeof obj.childRole === "string" ? obj.childRole : undefined,
      timeoutMs:
        obj.timeoutMs !== undefined
          ? parseTimeout(obj.timeoutMs)
          : obj.timeout !== undefined
            ? parseTimeout(obj.timeout)
            : undefined,
      model: typeof obj.model === "string" ? obj.model : undefined,
      callID: typeof obj.callID === "string" ? obj.callID : undefined,
      directApi: obj.directApi === true,
      seedOnly: obj.seedOnly === true,
      commands: obj.steps as readonly RawCommandItem[],
    }
  }

  if (obj.tool !== undefined || obj.command !== undefined || obj.action !== undefined || obj.name !== undefined) {
    return {
      labHome: typeof obj.labHome === "string" ? obj.labHome : undefined,
      baseUrl: typeof obj.baseUrl === "string" ? obj.baseUrl : undefined,
      password: typeof obj.password === "string" ? obj.password : undefined,
      passwordEnv: typeof obj.passwordEnv === "string" ? obj.passwordEnv : undefined,
      parentSession: typeof obj.parentSession === "string" ? obj.parentSession : undefined,
      parentRun: typeof obj.parentRun === "string" ? obj.parentRun : undefined,
      parentRole: typeof obj.parentRole === "string" ? obj.parentRole : undefined,
      childSession: typeof obj.childSession === "string" ? obj.childSession : undefined,
      childRun: typeof obj.childRun === "string" ? obj.childRun : undefined,
      childRole: typeof obj.childRole === "string" ? obj.childRole : undefined,
      timeoutMs:
        obj.timeoutMs !== undefined
          ? parseTimeout(obj.timeoutMs)
          : obj.timeout !== undefined
            ? parseTimeout(obj.timeout)
            : undefined,
      model: typeof obj.model === "string" ? obj.model : undefined,
      callID: typeof obj.callID === "string" ? obj.callID : undefined,
      directApi: obj.directApi === true,
      seedOnly: obj.seedOnly === true,
      commands: [obj as RawCommandItem],
    }
  }

  return {
    labHome: typeof obj.labHome === "string" ? obj.labHome : undefined,
    baseUrl: typeof obj.baseUrl === "string" ? obj.baseUrl : undefined,
    password: typeof obj.password === "string" ? obj.password : undefined,
    passwordEnv: typeof obj.passwordEnv === "string" ? obj.passwordEnv : undefined,
    parentSession: typeof obj.parentSession === "string" ? obj.parentSession : undefined,
    parentRun: typeof obj.parentRun === "string" ? obj.parentRun : undefined,
    parentRole: typeof obj.parentRole === "string" ? obj.parentRole : undefined,
    childSession: typeof obj.childSession === "string" ? obj.childSession : undefined,
    childRun: typeof obj.childRun === "string" ? obj.childRun : undefined,
    childRole: typeof obj.childRole === "string" ? obj.childRole : undefined,
    timeoutMs:
      obj.timeoutMs !== undefined
        ? parseTimeout(obj.timeoutMs)
        : obj.timeout !== undefined
          ? parseTimeout(obj.timeout)
          : undefined,
    model: typeof obj.model === "string" ? obj.model : undefined,
    callID: typeof obj.callID === "string" ? obj.callID : undefined,
    directApi: obj.directApi === true,
    seedOnly: obj.seedOnly === true,
    commands: [],
  }
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
  readonly childSession: string | undefined
  readonly childRun: string | undefined
  readonly childRole: string | undefined
  readonly callID: string
  readonly model: string | undefined
  readonly brief: string | undefined
  readonly commandSource: string | undefined
  readonly timeoutMs: number | undefined
}

function takeValue(argv: readonly string[], index: number, flag: string): string {
  const value = argv[index + 1]
  if (value === undefined || value === "") throw new Error(`${flag} needs a value`)
  return value
}

export function parseArgs(argv: readonly string[]): DriverArgs {
  let help = false
  let seedOnly = false
  let directApi = false
  let labHome: string | undefined
  let baseUrl: string | undefined
  let passwordEnv = DEFAULT_PASSWORD_ENV
  let password: string | undefined
  let parentSession: string | undefined
  let parentRun: string | undefined
  let parentRole = "opus-orchestrator"
  let childSession: string | undefined
  let childRun: string | undefined
  let childRole: string | undefined
  let callID = "soak-driver-call"
  let model: string | undefined
  let brief: string | undefined
  let commandSource: string | undefined
  let timeoutMs: number | undefined

  for (let index = 0; index < argv.length; index++) {
    const flag = argv[index]
    if (flag === "--help" || flag === "-h") {
      help = true
      continue
    }
    if (flag === "--seed-only") {
      seedOnly = true
      continue
    }
    if (flag === "--direct-api") {
      directApi = true
      continue
    }
    if (flag === "--lab-home") {
      labHome = takeValue(argv, index, flag)
      index++
      continue
    }
    if (flag === "--base-url") {
      baseUrl = takeValue(argv, index, flag)
      index++
      continue
    }
    if (flag === "--password-env") {
      const name = takeValue(argv, index, flag)
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name))
        throw new Error(`--password-env is not an environment variable name: "${name}"`)
      passwordEnv = name
      index++
      continue
    }
    if (flag === "--password") {
      password = takeValue(argv, index, flag)
      index++
      continue
    }
    if (flag === "--parent-session") {
      parentSession = takeValue(argv, index, flag)
      index++
      continue
    }
    if (flag === "--parent-run") {
      parentRun = takeValue(argv, index, flag)
      index++
      continue
    }
    if (flag === "--parent-role") {
      parentRole = takeValue(argv, index, flag)
      index++
      continue
    }
    if (flag === "--child-session") {
      childSession = takeValue(argv, index, flag)
      index++
      continue
    }
    if (flag === "--child-run") {
      childRun = takeValue(argv, index, flag)
      index++
      continue
    }
    if (flag === "--child-role") {
      childRole = takeValue(argv, index, flag)
      index++
      continue
    }
    if (flag === "--call-id") {
      callID = takeValue(argv, index, flag)
      index++
      continue
    }
    if (flag === "--model") {
      model = takeValue(argv, index, flag)
      index++
      continue
    }
    if (flag === "--brief") {
      brief = takeValue(argv, index, flag)
      index++
      continue
    }
    if (flag === "--command" || flag === "--commands" || flag === "--input" || flag === "--file") {
      commandSource = takeValue(argv, index, flag)
      index++
      continue
    }
    if (flag === "--timeout" || flag === "--timeout-ms") {
      const val = takeValue(argv, index, flag)
      timeoutMs = parseTimeout(val)
      index++
      continue
    }
    if (!flag.startsWith("-") && commandSource === undefined) {
      commandSource = flag
      continue
    }
    throw new Error(`unknown flag "${flag}"; run with --help`)
  }

  return {
    help,
    seedOnly,
    directApi,
    labHome,
    baseUrl,
    passwordEnv,
    password,
    parentSession,
    parentRun,
    parentRole,
    childSession,
    childRun,
    childRole,
    callID,
    model,
    brief,
    commandSource,
    timeoutMs,
  }
}

export function usage(): string {
  return JSON.stringify(
    {
      ok: true,
      help: {
        name: "soak-driver",
        description: "Lab-only lifecycle driver for real team tools",
        usage: "bun docs/soak-2026-09-22/driver.ts [options] [command.json]",
        tools: SUPPORTED_TOOLS,
        safety: [
          `lab home must be an explicit directory under ${LAB_HOME_PREFIX}<name>`,
          `base URL must be loopback and port ${HUMAN_SERVER_PORT} is refused`,
          "password is read from environment and never printed, persisted, or logged",
        ],
        timeout: `Hard configurable timeout bounds waits and polling (default ${DEFAULT_TIMEOUT_MS}ms / 10 minutes)`,
        flags: {
          "--lab-home <path>": "explicit lab home under /home/bliss/OpenCodePlus/run/tmp-build/tui-lab-*",
          "--base-url <url>": "loopback lab host origin (port 40374 refused)",
          "--parent-session <id>": "session id of existing genuine lab parent chat",
          "--parent-run <id>": "seed id for parent run (default: main-<16 hex sha256>)",
          "--parent-role <role>": "role for parent run (default: opus-orchestrator)",
          "--child-session <id>": "session id of existing child chat (optional)",
          "--child-run <id>": "run id of existing child run (optional)",
          "--child-role <role>": "role of child (optional)",
          "--command <file|json|->": "JSON command input via file, inline JSON, or stdin",
          "--input <file|json|->": "alias for --command",
          "--brief <file|json|->": "delegate Brief (backwards-compatible with round3-delegate)",
          "--timeout <duration|ms>": "hard timeout for waits/polling (default: 10m / 600000ms)",
          "--timeout-ms <ms>": "hard timeout in milliseconds",
          "--direct-api": "call TeamApi directly instead of registered tools",
          "--seed-only": "seed the parent run and stop",
          "--help": "print this JSON help",
        },
      },
    },
    null,
    2,
  )
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

  let plan: DriverPlan = { commands: [] }
  if (args.commandSource !== undefined) {
    const raw = await loadJsonInput(args.commandSource)
    plan = parseExecutionPlan(raw)
  } else if (args.brief !== undefined) {
    const brief = await readBrief(args.brief)
    plan = { commands: [{ tool: "delegate", input: brief }] }
  } else if (!process.stdin.isTTY) {
    const text = await Bun.stdin.text()
    if (text.trim() !== "") {
      const raw = JSON.parse(text)
      plan = parseExecutionPlan(raw)
    }
  }

  const labHome = required(
    args.labHome ?? plan.labHome ?? process.env.OPENCODEPLUS_LAB_HOME,
    "--lab-home",
    "OPENCODEPLUS_LAB_HOME",
  )
  const baseUrl = required(
    args.baseUrl ?? plan.baseUrl ?? process.env.OPENCODEPLUS_LAB_BASE_URL,
    "--base-url",
    "OPENCODEPLUS_LAB_BASE_URL",
  )
  const parentSessionID = required(
    args.parentSession ?? plan.parentSession ?? process.env.OPENCODEPLUS_LAB_PARENT_SESSION,
    "--parent-session",
    "OPENCODEPLUS_LAB_PARENT_SESSION",
  )
  const passwordEnv = args.passwordEnv ?? plan.passwordEnv ?? DEFAULT_PASSWORD_ENV
  const password = args.password ?? plan.password ?? process.env[passwordEnv]
  if (password === undefined || password === "")
    throw new Error(`lab password missing; set ${passwordEnv} (or use --password-env/--password)`)

  const parentRole = args.parentRole ?? plan.parentRole ?? "opus-orchestrator"
  const parentRunID = args.parentRun ?? plan.parentRun ?? defaultParentRunID(parentSessionID)
  const childSession = args.childSession ?? plan.childSession
  const childRun = args.childRun ?? plan.childRun
  const childRole = args.childRole ?? plan.childRole
  const timeoutMs = args.timeoutMs ?? plan.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const model = args.model ?? plan.model
  const callID = args.callID ?? plan.callID ?? "soak-driver-call"
  const directApi = args.directApi || plan.directApi || false
  const seedOnly = args.seedOnly || plan.seedOnly || false

  const targets = await resolveLabTargets({ labHome, baseUrl })
  process.env.XDG_DATA_HOME = targets.dataHome
  if (teamsDataDir() !== targets.teamsRoot)
    throw new Error(`internal: teams data root ${teamsDataDir()} does not match the lab home ${targets.teamsRoot}`)

  const bridge = hostBridge({ baseUrl: targets.baseUrl, password })
  const parent = await fetchParentSession(bridge, parentSessionID)
  const directory = String(parent.location.directory)
  const seeded = await seedParentRun({
    root: targets.teamsRoot,
    id: parentRunID,
    role: parentRole,
    sessionID: String(parent.id),
    directory,
  })

  const parentInfo = {
    run: seeded.id,
    session: seeded.sessionID,
    role: seeded.role,
    directory: seeded.directory,
    state: seeded.state,
  }

  const labReport = {
    baseUrl: targets.baseUrl,
    labHome: targets.labHome,
    teamsRoot: targets.teamsRoot,
  }

  if (seedOnly) {
    console.log(
      JSON.stringify(
        {
          ok: true,
          seededOnly: true,
          lab: labReport,
          parent: parentInfo,
          hostCalls: bridge.calls,
        },
        null,
        2,
      ),
    )
    return 0
  }

  let child = await resolveChild(targets.teamsRoot, {
    childSession,
    childRun,
    childRole,
    parentRun: seeded,
  })

  if (plan.commands.length === 0)
    throw new Error("no commands specified; provide commands via --command, stdin, or --brief")

  const lab = await labToolContext({ directory, session: bridge.domain })
  try {
    const isSingleCommand = plan.commands.length === 1
    const results: Array<{ step: number; ok: boolean; tool: string; via: string; output: unknown }> = []
    let singleOutcome: InvokeToolOutcome | undefined

    for (let i = 0; i < plan.commands.length; i++) {
      const item = plan.commands[i]
      if (item === undefined) continue
      const extracted = extractCommand(item)
      const toolName = normalizeToolName(extracted.toolName)

      const caller = await determineCaller(
        targets.teamsRoot,
        toolName,
        extracted.callerChoice,
        extracted.sessionID,
        extracted.role,
        { sessionID: String(parent.id), role: parentRole, directory },
        child,
      )

      const toolTimeout = extracted.timeoutMs ?? timeoutMs
      const preparedInput = await prepareToolInput(toolName, extracted.rawInput, {
        parentDirectory: directory,
        callerDirectory: caller.directory,
        child,
        timeoutMs: toolTimeout,
      })

      const outcome = await invokeToolThroughHost({
        lab,
        toolName,
        input: preparedInput,
        caller: { sessionID: caller.sessionID, role: caller.role, callID: extracted.callID ?? callID },
        via: extracted.via ?? (directApi ? "api" : "tool"),
        timeoutMs: toolTimeout,
        model,
      })

      if (toolName === "delegate") {
        const outObj = outcome.output as { run?: string; session?: string; directory?: string }
        if (outObj?.run !== undefined) {
          const freshChild = await loadRun(targets.teamsRoot, outObj.run)
          child = {
            run: outObj.run,
            session: outObj.session ?? "",
            directory: outObj.directory ?? "",
            role: (preparedInput as { role?: string })?.role ?? childRole ?? "gemini-implementer",
            state: freshChild?.state,
            branch: freshChild?.branch,
            parent: freshChild?.parent,
          }
        }
      }

      if (isSingleCommand) {
        singleOutcome = outcome
      } else {
        results.push({
          step: i + 1,
          ok: true,
          tool: outcome.tool,
          via: outcome.via,
          output: outcome.output,
        })
      }
    }

    if (isSingleCommand && singleOutcome !== undefined) {
      console.log(
        JSON.stringify(
          {
            ok: true,
            tool: singleOutcome.tool,
            via: singleOutcome.via,
            lab: labReport,
            parent: parentInfo,
            child,
            output: singleOutcome.output,
            hostCalls: bridge.calls,
          },
          null,
          2,
        ),
      )
      return 0
    }

    console.log(
      JSON.stringify(
        {
          ok: true,
          lab: labReport,
          parent: parentInfo,
          child,
          results,
          hostCalls: bridge.calls,
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
    console.log(
      JSON.stringify(
        {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        },
        null,
        2,
      ),
    )
    process.exitCode = 1
  }
}
