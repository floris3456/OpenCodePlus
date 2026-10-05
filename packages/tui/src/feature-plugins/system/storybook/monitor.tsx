import type { Plugin } from "@opencode/plugin/tui"
import { MonitorView } from "@opencode/plus/tui"
import { Definition, type Plus } from "@opencode/plus/rpc"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal } from "solid-js"
import { StoryFooter } from "./footer"
import type { Story } from "./index"

type MissVariant = "prefix" | "expired"

interface FixtureSession {
  readonly sessionID: string
  readonly parentID?: string
  readonly rootID: string
  readonly depth: number
  readonly title: string
  readonly agent: string
  readonly role: string
  readonly lastActive: number
  readonly state: string
}

function requestFor(variant: MissVariant, now: number): Plus.MonitorRequest {
  if (variant === "prefix")
    return {
      id: "req_miss",
      sessionID: "ses_lead",
      kind: "step",
      at: now - 120_000,
      durationMs: 2400,
      finish: "tool-calls",
      agent: "build",
      provider: "anthropic",
      model: "claude-3-7-sonnet",
      input: 4200,
      output: 280,
      reasoning: 0,
      cacheRead: 500,
      cacheWrite: 3800,
      cost: 0.035,
      verdict: "miss",
      cause: "prefix-changed",
      confidence: "certain",
      evidence: "system part AGENTS.md changed",
      expected: 18500,
      missTokens: 18000,
      missCost: 0.027,
      tools: ["read", "grep"],
    }
  return {
    id: "req_miss",
    sessionID: "ses_lead",
    kind: "step",
    at: now - 120_000,
    durationMs: 3100,
    finish: "tool-calls",
    agent: "build",
    provider: "anthropic",
    model: "claude-3-7-sonnet",
    input: 18500,
    output: 280,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 18500,
    cost: 0.055,
    verdict: "miss",
    cause: "cache-expired",
    confidence: "likely",
    evidence: "gap 7m exceeds 5m lifetime · warming off",
    expected: 18500,
    missTokens: 18500,
    missCost: 0.045,
    tools: ["read"],
  }
}

// Contract fixtures for the real page. Every value is drawn from the request
// details the production ledger can report: hashes, sizes, names and timings,
// never invented line or character positions, and optional keys are omitted
// rather than set to undefined.
function detailFor(variant: MissVariant, request: Plus.MonitorRequest, now: number): Plus.MonitorRequestDetail {
  const prefix = variant === "prefix"
  const previousHash = prefix ? "h_old" : request.id
  const before = { hash: previousHash, chars: prefix ? 3200 : 0, tokens: prefix ? 800 : 0 }
  const after = { hash: prefix ? "h_new" : "h_same", chars: request.cacheWrite, tokens: request.expected ?? 0 }
  return {
    request,
    previous: { id: "req_prev", at: now - 420_000 },
    lines: prefix
      ? [
          "system part AGENTS.md changed: chars 3200 → 3800",
          "expected prefix: 18.5k tokens, cache read: 500 tokens",
          "warming was inactive for this session",
        ]
      : [
          "gap 420s exceeds provider cache lifetime (300s)",
          "expected prefix: 18.5k tokens, cache read: 0 tokens",
          "warming was inactive for this session",
        ],
    segments: prefix
      ? [
          {
            name: "system: AGENTS.md",
            kind: "system",
            change: "changed",
            before: { hash: "h_old", chars: 3200, tokens: 800 },
            after: { hash: "h_new", chars: 3800, tokens: 950 },
          },
          {
            name: "tool: read",
            kind: "tool",
            change: "changed",
            before: { hash: "t_read1", chars: 600, tokens: 150 },
            after: { hash: "t_read2", chars: 600, tokens: 150 },
          },
          {
            name: "tool: grep",
            kind: "tool",
            change: "added",
            after: { hash: "t_grep", chars: 450, tokens: 110 },
          },
        ]
      : [
          {
            name: "message 14 (tool result)",
            kind: "message",
            change: "changed",
            before: { hash: "m_14a", chars: 900, tokens: 225 },
            after: { hash: "m_14b", chars: 900, tokens: 225 },
          },
        ],
    firstDivergence: prefix ? "system: AGENTS.md" : "message 14 (tool result)",
    timing: {
      gapMs: 420_000,
      lifetimeMs: 300_000,
      warming: "off",
    },
    pings: [],
    accounts: [],
    instructions: [{ at: now - 130_000, keys: ["AGENTS.md"] }],
    reverts: [],
    actualCacheRead: prefix ? 500 : 0,
    expectedTokens: 18500,
    calls: [
      {
        sessionID: "ses_lead",
        callID: "call_1",
        agent: "build",
        tool: "read",
        target: "packages/plus/src/rpc.ts",
        status: "ok",
        started: now - 118_000,
        ended: now - 117_500,
        callTokens: 45,
        resultTokens: 2400,
        measured: true,
        carried: 9600,
      },
      {
        sessionID: "ses_lead",
        callID: "call_2",
        agent: "build",
        tool: "grep",
        target: "MonitorReport",
        status: "ok",
        started: now - 117_400,
        ended: now - 117_100,
        callTokens: 35,
        resultTokens: 850,
        measured: true,
        carried: 3400,
      },
    ],
  }
}

function allRequests(variant: MissVariant, now: number): Plus.MonitorRequest[] {
  return [
    {
      id: "req_0",
      sessionID: "ses_lead",
      kind: "compaction",
      at: now - 600_000,
      durationMs: 1200,
      agent: "build",
      provider: "anthropic",
      model: "claude-3-7-sonnet",
      input: 12000,
      output: 450,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 12000,
      cost: 0.04,
      verdict: "cold",
      cause: "compacted",
      confidence: "certain",
    },
    {
      id: "req_1",
      sessionID: "ses_lead",
      kind: "step",
      at: now - 450_000,
      durationMs: 1800,
      finish: "tool-calls",
      agent: "build",
      provider: "anthropic",
      model: "claude-3-7-sonnet",
      input: 850,
      output: 190,
      reasoning: 120,
      cacheRead: 18500,
      cacheWrite: 0,
      cost: 0.015,
      verdict: "hit",
      tools: ["read"],
    },
    {
      id: "req_2",
      sessionID: "ses_lead",
      kind: "ping",
      at: now - 200_000,
      durationMs: 650,
      agent: "build",
      provider: "anthropic",
      model: "claude-3-7-sonnet",
      input: 0,
      output: 5,
      reasoning: 0,
      cacheRead: 18500,
      cacheWrite: 0,
      cost: 0.002,
      verdict: "hit",
    },
    requestFor(variant, now),
    {
      id: "req_4",
      sessionID: "ses_worker",
      kind: "step",
      at: now - 45_000,
      durationMs: 2200,
      finish: "stop",
      agent: "explore",
      provider: "openai",
      model: "gpt-5",
      input: 620,
      output: 340,
      reasoning: 450,
      cacheRead: 24500,
      cacheWrite: 0,
      cost: 0.022,
      verdict: "hit",
      tools: ["edit"],
    },
    {
      id: "req_5",
      sessionID: "ses_other",
      kind: "step",
      at: now - 20_000,
      durationMs: 1500,
      finish: "stop",
      agent: "designer",
      provider: "anthropic",
      model: "claude-3-7-sonnet",
      input: 900,
      output: 120,
      reasoning: 0,
      cacheRead: 0,
      cacheWrite: 900,
      cost: 0.008,
      verdict: "cold",
      cause: "compacted",
      confidence: "certain",
      tools: ["write"],
    },
  ]
}

function allSessions(now: number): FixtureSession[] {
  return [
    {
      sessionID: "ses_lead",
      rootID: "ses_lead",
      depth: 0,
      title: "Deliver Monitor page (T3)",
      agent: "build",
      role: "Lead Implementer",
      lastActive: now - 120_000,
      state: "active",
    },
    {
      sessionID: "ses_worker",
      parentID: "ses_lead",
      rootID: "ses_lead",
      depth: 1,
      title: "Explore Storybook integration",
      agent: "explore",
      role: "Worker",
      lastActive: now - 45_000,
      state: "completed",
    },
    {
      sessionID: "ses_other",
      rootID: "ses_other",
      depth: 0,
      title: "Stand-alone chat",
      agent: "designer",
      role: "Designer",
      lastActive: now - 20_000,
      state: "idle",
    },
  ]
}

function scopedRequests(input: Plus.MonitorQueryInput, variant: MissVariant, now: number): Plus.MonitorRequest[] {
  const all = allRequests(variant, now)
  if (input.scope === "session" && input.sessionID !== undefined)
    return all.filter((r) => r.sessionID === input.sessionID)
  if (input.scope === "tree") return all.filter((r) => r.sessionID === "ses_lead" || r.sessionID === "ses_worker")
  if (input.scope === "team") return all.filter((r) => r.sessionID === "ses_lead" || r.sessionID === "ses_worker")
  return all
}

function scopedSessions(input: Plus.MonitorQueryInput, now: number): FixtureSession[] {
  const all = allSessions(now)
  if (input.scope === "session" && input.sessionID !== undefined)
    return all.filter((s) => s.sessionID === input.sessionID)
  if (input.scope === "tree") return all.filter((s) => s.rootID === "ses_lead")
  if (input.scope === "team")
    return all.filter((s) => s.sessionID === "ses_lead" || s.sessionID === "ses_worker")
  return all
}

function totalsFor(requests: readonly Plus.MonitorRequest[]): Plus.MonitorTotals {
  const sum = (key: "input" | "output" | "reasoning" | "cacheRead" | "cacheWrite" | "cost") =>
    requests.reduce((total, request) => total + request[key], 0)
  const steps = requests.filter((request) => request.kind === "step" || request.kind === "compaction").length
  const pings = requests.filter((request) => request.kind === "ping")
  const misses = requests.filter((request) => request.verdict === "miss" || request.verdict === "partial")
  const cacheRead = sum("cacheRead")
  return {
    steps,
    calls: 28,
    errors: 1,
    running: 0,
    input: sum("input"),
    output: sum("output"),
    reasoning: sum("reasoning"),
    cacheRead,
    cacheWrite: sum("cacheWrite"),
    cost: sum("cost"),
    callTokens: 980,
    resultTokens: 6400,
    carried: 28400,
    requests: requests.length,
    pings: pings.length,
    pingCost: pings.reduce((total, ping) => total + ping.cost, 0),
    misses: misses.length,
    missTokens: misses.reduce((total, miss) => total + (miss.missTokens ?? 0), 0),
    missCost: misses.reduce((total, miss) => total + (miss.missCost ?? 0), 0),
    hitRate: cacheRead / Math.max(1, cacheRead + sum("input")),
  }
}

function groupsFor(requests: readonly Plus.MonitorRequest[]): Plus.MonitorGroup[] {
  const specs: { key: string; calls: number; errors: number; callTokens: number; resultTokens: number; carried: number; avgMs: number }[] = [
    { key: "read", calls: 12, errors: 0, callTokens: 420, resultTokens: 3800, carried: 18200, avgMs: 340 },
    { key: "edit", calls: 7, errors: 1, callTokens: 260, resultTokens: 1400, carried: 6200, avgMs: 820 },
    { key: "shell", calls: 5, errors: 0, callTokens: 180, resultTokens: 850, carried: 2900, avgMs: 1450 },
    { key: "grep", calls: 4, errors: 0, callTokens: 120, resultTokens: 350, carried: 1100, avgMs: 210 },
  ]
  const tools = new Set(requests.flatMap((request) => request.tools ?? []))
  return specs
    .filter((spec) => tools.has(spec.key))
    .map((spec) => ({ ...spec, label: spec.key, inner: spec.key === "shell" ? 2 : 0, running: 0, estimated: 0 }))
}

function agentsFor(requests: readonly Plus.MonitorRequest[], now: number): Plus.MonitorAgentRow[] {
  const all: Plus.MonitorAgentRow[] = [
    { agent: "build", model: "claude-3-7-sonnet", steps: 8, hitRate: 0.94, misses: 1, tokens: 48000, cost: 0.11, lastActive: now - 120_000 },
    { agent: "explore", model: "gpt-5", steps: 4, hitRate: 0.91, misses: 0, tokens: 28000, cost: 0.07, lastActive: now - 45_000 },
    { agent: "designer", model: "claude-3-7-sonnet", steps: 2, hitRate: 0, misses: 0, tokens: 1020, cost: 0.008, lastActive: now - 20_000 },
  ]
  const seen = new Set(requests.map((request) => request.agent))
  return all.filter((row) => seen.has(row.agent)).sort((a, b) => b.lastActive - a.lastActive)
}

function createFixtureReport(input: Plus.MonitorQueryInput, variant: MissVariant, now: number): Plus.MonitorReport {
  const requests = scopedRequests(input, variant, now)
  const sessions = scopedSessions(input, now)
  const view = input.view ?? "overview"
  const miss = requests.find((request) => request.id === "req_miss") ?? requests.at(-1)!
  const detailID = input.id ?? (view === "cache" || view === "steps" ? miss.id : undefined)
  const detailRequest = requests.find((request) => request.id === detailID)
  const pings = requests.filter((request) => request.kind === "ping")
  return {
    now,
    totals: totalsFor(requests),
    groups: groupsFor(requests),
    feed: requests.slice(-3).reverse().map((request) => ({
      sessionID: request.sessionID,
      callID: `call_${request.id}`,
      ...(request.agent === undefined ? {} : { agent: request.agent }),
      ...(request.model === undefined ? {} : { model: request.model }),
      tool: request.tools?.[0] ?? "read",
      status: "ok",
      started: request.at,
      ...(request.durationMs === undefined ? {} : { ended: request.at + request.durationMs }),
      callTokens: 40,
      resultTokens: 2000,
      measured: true,
      carried: 6000,
    })),
    facets: {
      agents: [...new Set(requests.map((request) => request.agent).filter((agent): agent is string => agent !== undefined))].sort(),
      tools: [...new Set(requests.flatMap((request) => request.tools ?? []))].sort(),
      models: [...new Set(requests.map((request) => request.model).filter((model): model is string => model !== undefined))].sort(),
    },
    marks: [{ id: 1, at: now - 300_000, label: "before prompt change" }],
    ...(view === "overview" || view === "cache" || view === "steps"
      ? {
          requests: requests.filter((request) => !input.missesOnly || request.verdict === "miss" || request.verdict === "partial"),
        }
      : {}),
    ...(detailRequest === undefined
      ? {}
      : { detail: detailFor(variant, detailRequest, now) }),
    ...(view === "overview"
      ? {
          agents: agentsFor(requests, now),
          topMisses: requests.filter((request) => request.verdict === "miss").slice(0, 3),
          topTools: groupsFor(requests)
            .sort((a, b) => b.carried - a.carried)
            .slice(0, 3),
          unstable: [{ sessionID: "ses_lead", segment: "system part instructions-hash", streak: 3 }],
          context: [{ sessionID: "ses_lead", now: 38400, atCompaction: 14200 }],
          pings: {
            sent: pings.length,
            cost: pings.reduce((total, ping) => total + ping.cost, 0),
            followedByHit: pings.length,
            followedByMiss: 0,
          },
        }
      : {}),
    ...(view === "sessions"
      ? {
          sessions: sessions.map((session) => {
            const rows = requests.filter((request) => request.sessionID === session.sessionID)
            const totals = totalsFor(rows)
            return {
              ...session,
              requests: totals.requests ?? rows.length,
              steps: totals.steps,
              input: totals.input,
              cacheRead: totals.cacheRead,
              cacheWrite: totals.cacheWrite,
              output: totals.output,
              reasoning: totals.reasoning,
              cost: totals.cost,
              hitRate: totals.hitRate ?? 0,
              misses: totals.misses ?? 0,
            }
          }),
        }
      : {}),
    teams: ["Flash", "Core", "App"],
  }
}

export function MonitorStory(props: { context: Plugin.Context }) {
  const [missVariant, setMissVariant] = createSignal<MissVariant>("prefix")
  const dimensions = useTerminalDimensions()
  const now = Date.now()

  // Keep the real context and replace only the RPC boundary, so the actual
  // page component renders and its calls are answered by contract-shaped
  // fixtures that honor the scope, view and id it asked for.
  const originalRpc = props.context.client.rpc.bind(props.context.client)
  const rpc: typeof props.context.client.rpc = ((definition: unknown) =>
    definition === Definition
      ? {
          "monitor.query": async (input: Plus.MonitorQueryInput) => createFixtureReport(input, missVariant(), now),
          "monitor.mark": async (input: Plus.MonitorMarkInput) => ({
            id: 99,
            at: Date.now(),
            label: input.label,
          }),
        }
      : originalRpc(definition as never)) as unknown as typeof props.context.client.rpc
  const context: Plugin.Context = {
    ...props.context,
    client: { ...props.context.client, rpc },
  }

  // Extra story keyboard controls
  props.context.keymap.layer(() => ({
    priority: 10,
    commands: [
      {
        bind: "ctrl+m",
        title: "Toggle miss scenario",
        group: "Story",
        run: () => {
          setMissVariant((prev) => (prev === "prefix" ? "expired" : "prefix"))
          props.context.ui.toast.show({
            variant: "info",
            message: `Switched fixture miss cause to: ${missVariant() === "prefix" ? "prefix-changed" : "cache-expired"}`,
          })
        },
      },
    ],
  }))

  return (
    <box
      width={dimensions().width}
      height={dimensions().height}
      flexDirection="column"
      backgroundColor={props.context.theme.background.base}
    >
      <box flexGrow={1} minHeight={0}>
        <MonitorView
          context={context}
          sessionID={() => "ses_lead"}
          active={() => true}
          full={true}
          onClose={() => props.context.ui.router.navigate({ type: "plugin", name: "storybook" })}
        />
      </box>
      <StoryFooter
        context={props.context}
        title="storybook / monitor"
        details={[`miss: ${missVariant() === "prefix" ? "prefix-changed" : "cache-expired"}`]}
        controls={[
          { shortcut: "ctrl+m", label: "toggle miss cause" },
          { shortcut: "esc", label: "back" },
        ]}
      />
    </box>
  )
}

export const monitorStory: Story = {
  id: "monitor",
  title: "Monitor: tokens, cache and tools",
  render: (context) => <MonitorStory context={context} />,
}
