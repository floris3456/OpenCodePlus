// Monitor test fixtures: a temporary ledger and scripts of host session
// events shaped exactly as core publishes them (type, data, created).
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createCollector } from "../src/monitor/collector.js"
import { createLedger, type Ledger, type SessionFacts } from "../src/monitor/ledger.js"

const dirs: string[] = []
const ledgers: Ledger[] = []

export async function cleanupLedgers(): Promise<void> {
  ledgers.splice(0).forEach((ledger) => ledger.close())
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
}

export async function ledger(): Promise<Ledger> {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-monitor-"))
  dirs.push(dir)
  const created = createLedger(path.join(dir, "monitor.db"))
  ledgers.push(created)
  return created
}

// The host's session events, shaped as core publishes them (type + data).
export type Event = { type: string; data: Record<string, unknown>; created: number }
export const usage = (input: number, output: number, read = 0, write = 0, reasoning = 0) => ({
  input,
  output,
  reasoning,
  cache: { read, write },
})

export function script(sessionID: string, clock: { now: number }) {
  const events: Event[] = []
  const at = (ms: number) => {
    clock.now += ms
  }
  const push = (type: string, data: Record<string, unknown>) =>
    events.push({ type, data: { sessionID, ...data }, created: clock.now })
  return {
    events,
    at,
    step(message: string, agent = "build", model = { id: "m1", providerID: "p" }) {
      push("session.step.started", { assistantMessageID: message, agent, model, started: clock.now })
    },
    text(message: string, text: string) {
      push("session.text.ended", { assistantMessageID: message, ordinal: 0, text })
    },
    call(message: string, id: string, name: string, input: Record<string, unknown>) {
      push("session.tool.input.started", { assistantMessageID: message, id, name })
      push("session.tool.called", { assistantMessageID: message, id, input, executed: false })
    },
    ok(message: string, id: string, text: string, metadata?: Record<string, unknown>) {
      push("session.tool.success", {
        assistantMessageID: message,
        id,
        content: [{ type: "text", text }],
        executed: false,
        ...(metadata === undefined ? {} : { metadata }),
      })
    },
    fail(message: string, id: string, message2: string) {
      push("session.tool.failed", {
        assistantMessageID: message,
        id,
        error: { type: "tool", message: message2 },
        executed: false,
      })
    },
    end(message: string, finish: string, tokens: ReturnType<typeof usage>, cost = 0) {
      push("session.step.ended", { assistantMessageID: message, finish, cost, tokens })
    },
    user() {
      push("session.inbox.delivered", { inboxID: "msg_user" })
    },
    compact(tokens: ReturnType<typeof usage>) {
      push("session.compaction.ended", {
        reason: "auto",
        model: { id: "m1", providerID: "p" },
        text: "summary",
        recent: "",
        cost: 0,
        tokens,
      })
    },
    created(extra: Record<string, unknown>) {
      push("session.created", {
        projectID: "prj",
        slug: "s",
        version: "v",
        location: { directory: "/work/project" },
        ...extra,
      })
    },
  }
}

export function collect(
  target: Ledger,
  clock: { now: number },
  options: { resolve?: (id: string) => Promise<SessionFacts | undefined>; config?: string } = {},
) {
  return createCollector({
    ledger: target,
    directory: "/work/project",
    now: () => clock.now,
    ...(options.config === undefined ? {} : { config: () => options.config }),
    ...(options.resolve === undefined ? {} : { resolve: options.resolve }),
  })
}

export function contractFixtureReport(now = 1_800_000_000_000): import("../src/rpc.js").Plus.MonitorReport {
  const missReq: import("../src/rpc.js").Plus.MonitorRequest = {
    id: "req_miss_1",
    sessionID: "ses_chat",
    kind: "step",
    at: now - 30_000,
    durationMs: 2500,
    finish: "tool-calls",
    agent: "build",
    provider: "anthropic",
    model: "claude-3-7-sonnet",
    input: 3200,
    output: 220,
    reasoning: 0,
    cacheRead: 400,
    cacheWrite: 2800,
    cost: 0.025,
    verdict: "miss",
    cause: "prefix-changed",
    confidence: "certain",
    evidence: "system part AGENTS.md changed",
    expected: 15000,
    missTokens: 14600,
    missCost: 0.022,
    tools: ["read", "shell"],
  }

  const hitReq: import("../src/rpc.js").Plus.MonitorRequest = {
    id: "req_hit_1",
    sessionID: "ses_chat",
    kind: "step",
    at: now - 50_000,
    durationMs: 1800,
    finish: "tool-calls",
    agent: "build",
    provider: "anthropic",
    model: "claude-3-7-sonnet",
    input: 600,
    output: 150,
    reasoning: 0,
    cacheRead: 15000,
    cacheWrite: 0,
    cost: 0.012,
    verdict: "hit",
    tools: ["read"],
  }

  const pingReq: import("../src/rpc.js").Plus.MonitorRequest = {
    id: "req_ping_1",
    sessionID: "ses_chat",
    kind: "ping",
    at: now - 70_000,
    durationMs: 400,
    agent: "build",
    provider: "anthropic",
    model: "claude-3-7-sonnet",
    input: 0,
    output: 5,
    reasoning: 0,
    cacheRead: 15000,
    cacheWrite: 0,
    cost: 0.001,
    verdict: "hit",
  }

  const coldReq: import("../src/rpc.js").Plus.MonitorRequest = {
    id: "req_cold_1",
    sessionID: "ses_chat",
    kind: "compaction",
    at: now - 100_000,
    durationMs: 1200,
    agent: "build",
    provider: "anthropic",
    model: "claude-3-7-sonnet",
    input: 12000,
    output: 300,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 12000,
    cost: 0.035,
    verdict: "cold",
    cause: "compacted",
    confidence: "certain",
  }

  const detail: import("../src/rpc.js").Plus.MonitorRequestDetail = {
    request: missReq,
    previous: { id: "req_hit_1", at: now - 50_000 },
    lines: [
      "system part AGENTS.md changed: chars 2500 → 2900",
      "expected prefix: 15.0k tokens, actual cache read: 400 tokens",
      "system part hash h1 → h2",
    ],
    segments: [
      {
        name: "system: AGENTS.md",
        kind: "system",
        change: "changed",
        before: { hash: "h1", chars: 2500, tokens: 625 },
        after: { hash: "h2", chars: 2900, tokens: 725 },
      },
      {
        name: "tool: read",
        kind: "tool",
        change: "changed",
        before: { hash: "r1", chars: 400, tokens: 100 },
        after: { hash: "r2", chars: 400, tokens: 100 },
      },
    ],
    firstDivergence: "system: AGENTS.md",
    timing: {
      gapMs: 20_000,
      lifetimeMs: 300_000,
      lastPingAt: undefined,
      warming: "off",
    },
    pings: [],
    accounts: [],
    instructions: [{ at: now - 35_000, keys: ["AGENTS.md"] }],
    reverts: [],
    actualCacheRead: 400,
    expectedTokens: 15000,
    calls: [
      {
        sessionID: "ses_chat",
        callID: "c1",
        tool: "read",
        target: "packages/plus/src/rpc.ts",
        status: "ok",
        started: now - 28_000,
        ended: now - 27_500,
        callTokens: 40,
        resultTokens: 2000,
        measured: true,
        carried: 6000,
      },
    ],
  }

  return {
    now,
    totals: {
      steps: 2,
      calls: 3,
      errors: 0,
      running: 0,
      input: 3800,
      output: 370,
      reasoning: 0,
      cacheRead: 15400,
      cacheWrite: 2800,
      cost: 0.037,
      callTokens: 120,
      resultTokens: 2500,
      carried: 7500,
      requests: 3,
      pings: 0,
      pingCost: 0,
      misses: 1,
      missTokens: 14600,
      missCost: 0.022,
      hitRate: 0.8,
    },
    groups: [
      {
        key: "read",
        label: "read",
        calls: 2,
        inner: 0,
        errors: 0,
        running: 0,
        callTokens: 80,
        resultTokens: 2000,
        carried: 6000,
        estimated: 0,
        avgMs: 250,
      },
      {
        key: "shell",
        label: "shell",
        calls: 1,
        inner: 0,
        errors: 0,
        running: 0,
        callTokens: 40,
        resultTokens: 500,
        carried: 1500,
        estimated: 0,
        avgMs: 800,
      },
    ],
    feed: [
      {
        sessionID: "ses_chat",
        callID: "c1",
        agent: "build",
        tool: "read",
        target: "packages/plus/src/rpc.ts",
        status: "ok",
        started: now - 28_000,
        ended: now - 27_500,
        callTokens: 40,
        resultTokens: 2000,
        measured: true,
        carried: 6000,
      },
    ],
    facets: {
      agents: ["build"],
      tools: ["read", "shell"],
      models: ["claude-3-7-sonnet"],
    },
    marks: [],
    requests: [coldReq, pingReq, hitReq, missReq],
    detail,
    topMisses: [missReq],
    topTools: [
      {
        key: "read",
        label: "read",
        calls: 2,
        inner: 0,
        errors: 0,
        running: 0,
        callTokens: 80,
        resultTokens: 2000,
        carried: 6000,
        estimated: 0,
        avgMs: 250,
      },
      {
        key: "shell",
        label: "shell",
        calls: 1,
        inner: 0,
        errors: 0,
        running: 0,
        callTokens: 40,
        resultTokens: 500,
        carried: 1500,
        estimated: 0,
        avgMs: 800,
      },
    ],
    unstable: [],
    context: [{ sessionID: "ses_chat", now: 18200, atCompaction: 12300 }],
    agents: [
      {
        agent: "build",
        model: "claude-3-7-sonnet",
        steps: 2,
        hitRate: 0.8,
        misses: 1,
        tokens: 19570,
        cost: 0.037,
        lastActive: now - 30_000,
      },
    ],
    sessions: [
      {
        sessionID: "ses_chat",
        rootID: "ses_chat",
        depth: 0,
        title: "Test Chat",
        agent: "build",
        role: "Implementer",
        lastActive: now - 30_000,
        state: "active",
        requests: 3,
        steps: 2,
        input: 3800,
        cacheRead: 15400,
        cacheWrite: 2800,
        output: 370,
        reasoning: 0,
        cost: 0.037,
        hitRate: 0.8,
        misses: 1,
      },
    ],
    pings: { sent: 0, cost: 0, followedByHit: 0, followedByMiss: 0 },
    teams: ["Flash", "Core"],
  }
}
