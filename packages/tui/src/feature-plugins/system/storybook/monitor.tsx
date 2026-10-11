import type { Plugin } from "@opencode/plugin/tui"
import { MonitorView } from "@opencode/plus/tui"
import { Definition, type Plus } from "@opencode/plus/rpc"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal } from "solid-js"
import { StoryFooter } from "./footer"
import type { Story } from "./index"
import { reportPage } from "../../../../../plus/src/monitor/report-page"

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
  // Only the miss request has a prefix divergence; other requests keep an
  // honest empty detail rather than borrowing the miss's segments.
  const prefix = variant === "prefix" && request.id === "req_miss"
  const isMiss = request.id === "req_miss"
  return {
    request,
    ...(request.id === "req_miss" ? { previous: { id: "req_prev", at: now - 420_000 } } : {}),
    lines: isMiss
      ? prefix
        ? [
            "system part AGENTS.md changed: chars 3200 → 3800",
            "expected prefix: 18.5k tokens, cache read: 500 tokens",
            "warming was inactive for this session",
          ]
        : [
            "gap 420s exceeds provider cache lifetime (300s)",
            "expected prefix: 18.5k tokens, cache read: 0 tokens",
            "prefix identical to the previous request; warming was inactive",
          ]
      : [
          `Session ${request.sessionID}; request ${request.id}`,
          request.cause === undefined ? "No cache cause recorded for this request" : `Cause: ${request.cause}`,
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
      : [],
    // Expiry is a gap, not a divergence: no firstDivergence, no segment change.
    ...(prefix ? { firstDivergence: "system: AGENTS.md" } : {}),
    timing: isMiss ? { gapMs: 420_000, lifetimeMs: 300_000, warming: "off" } : { warming: "off" },
    pings: [],
    accounts: [],
    instructions: [],
    reverts: [],
    actualCacheRead: request.cacheRead,
    ...(request.expected === undefined ? {} : { expectedTokens: request.expected }),
    calls: isMiss
      ? [
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
        ]
      : [],
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
  if (input.scope === "session" || input.scope === "tree") {
    const ids = new Set(scopedSessions(input, now).map((s) => s.sessionID))
    return all.filter((r) => ids.has(r.sessionID))
  }
  if (input.scope === "team") return all.filter((r) => r.sessionID === "ses_lead" || r.sessionID === "ses_worker")
  return all
}

function scopedSessions(input: Plus.MonitorQueryInput, now: number): FixtureSession[] {
  const all = allSessions(now)
  const ids = input.sessionIDs ?? (input.sessionID === undefined ? [] : [input.sessionID])
  if (input.scope === "session") return all.filter((s) => ids.includes(s.sessionID))
  if (input.scope === "tree") {
    const roots = new Set(all.filter((s) => ids.includes(s.sessionID)).map((s) => s.rootID))
    return all.filter((s) => roots.has(s.rootID))
  }
  if (input.scope === "team") return all.filter((s) => s.sessionID === "ses_lead" || s.sessionID === "ses_worker")
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
  const specs: {
    key: string
    calls: number
    errors: number
    callTokens: number
    resultTokens: number
    carried: number
    avgMs: number
  }[] = [
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
    {
      agent: "build",
      model: "claude-3-7-sonnet",
      steps: 8,
      hitRate: 0.94,
      misses: 1,
      tokens: 48000,
      cost: 0.11,
      lastActive: now - 120_000,
    },
    {
      agent: "explore",
      model: "gpt-5",
      steps: 4,
      hitRate: 0.91,
      misses: 0,
      tokens: 28000,
      cost: 0.07,
      lastActive: now - 45_000,
    },
    {
      agent: "designer",
      model: "claude-3-7-sonnet",
      steps: 2,
      hitRate: 0,
      misses: 0,
      tokens: 1020,
      cost: 0.008,
      lastActive: now - 20_000,
    },
  ]
  const seen = new Set(requests.map((request) => request.agent))
  return all.filter((row) => seen.has(row.agent)).sort((a, b) => b.lastActive - a.lastActive)
}

function createFixtureReport(
  input: Plus.MonitorQueryInput,
  variant: MissVariant,
  now: number,
  paged = false,
  payloads = false,
): Plus.MonitorReport {
  const scoped = scopedRequests(input, variant, now)
  const requests =
    paged && scoped.length
      ? Array.from({ length: 205 }, (_, i) => ({
          ...scoped[i % scoped.length]!,
          id: `fixture-${String(i).padStart(3, "0")}`,
          at: now - 205000 + i * 1000,
        }))
      : scoped
  // Contract response fixture for exercising the real consumer; server keyset
  // correctness is tested separately against the production ledger/report.
  const eligible = requests.filter(
    (request) => !input.missesOnly || request.verdict === "miss" || request.verdict === "partial",
  )
  const cursor = input.requestPage?.cursor
  const candidates = eligible.filter(
    (r) => !cursor || (input.requestPage?.direction === "newer" ? r.at > cursor.at : r.at < cursor.at),
  )
  const page = input.requestPage?.direction === "newer" ? candidates.slice(0, 100) : candidates.slice(-100)
  const sessions = scopedSessions(input, now)
  const view = input.view ?? "overview"
  const miss = requests.find((request) => request.id === "req_miss") ?? requests.at(-1)!
  const detailID = input.id ?? (view === "cache" || view === "steps" ? miss.id : undefined)
  const detailRequest = requests.find((request) => request.id === detailID)
  const pings = requests.filter((request) => request.kind === "ping")
  const report: Plus.MonitorReport = {
    now,
    totals: totalsFor(requests),
    groups: groupsFor(requests),
    feed: requests
      .slice(-3)
      .reverse()
      .map((request) => ({
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
      agents: [
        ...new Set(requests.map((request) => request.agent).filter((agent): agent is string => agent !== undefined)),
      ].sort(),
      tools: [...new Set(requests.flatMap((request) => request.tools ?? []))].sort(),
      models: [
        ...new Set(requests.map((request) => request.model).filter((model): model is string => model !== undefined)),
      ].sort(),
    },
    marks: [{ id: 1, at: now - 300_000, label: "before prompt change" }],
    ...(view === "overview" || view === "cache" || view === "steps"
      ? {
          requests: paged ? page : eligible,
          ...(paged
            ? {
                requestPage: {
                  total: eligible.length,
                  returned: page.length,
                  limit: 100,
                  complete: page.length === eligible.length,
                  ...(page[0] && eligible[0]?.id !== page[0].id ? { older: { at: page[0].at, id: page[0].id } } : {}),
                  ...(page.at(-1) && eligible.at(-1)?.id !== page.at(-1)!.id
                    ? { newer: { at: page.at(-1)!.at, id: page.at(-1)!.id } }
                    : {}),
                },
              }
            : {}),
        }
      : {}),
    ...(detailRequest === undefined ? {} : { detail: detailFor(variant, detailRequest, now) }),
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
  if (!payloads) return report
  const pages: Record<string, Plus.MonitorPage> = {}
  const collection = <T,>(name: Plus.MonitorPageSection, rows: readonly T[], limit = 100) => {
    const page = reportPage(rows, input.pages?.[name], limit)
    pages[name] = page.metadata
    return page.rows
  }
  const count = 205
  const many = <T,>(make: (i: number) => T) => Array.from({ length: count }, (_, i) => make(i))
  const sessionTemplate = report.sessions?.[0] ?? {
    ...allSessions(now)[0]!,
    requests: 0,
    steps: 0,
    input: 0,
    cacheRead: 0,
    cacheWrite: 0,
    output: 0,
    reasoning: 0,
    cost: 0,
    misses: 0,
  }
  const agentTemplate = report.agents?.[0] ?? {
    agent: "fixture",
    steps: 0,
    misses: 0,
    tokens: 0,
    cost: 0,
    lastActive: now,
  }
  const detail = report.detail
  const facetAgents = reportPage(
    many((i) => `fixture-agent-${i}`),
    input.pages?.["facets.agents"],
  )
  const facetTools = reportPage(
    many((i) => `fixture-tool-${i}`),
    input.pages?.["facets.tools"],
  )
  const facetModels = reportPage(
    many((i) => `fixture-model-${i}`),
    input.pages?.["facets.models"],
  )
  const preview = "Fixture-only long evidence α ".repeat(80)
  return {
    ...report,
    teams: collection(
      "teams",
      many((i) => `fixture-team-${i}`),
    ),
    facets: {
      agents: facetAgents.rows,
      tools: facetTools.rows,
      models: facetModels.rows,
      pages: {
        "facets.agents": facetAgents.metadata,
        "facets.tools": facetTools.metadata,
        "facets.models": facetModels.metadata,
      },
    },
    ...(view === "sessions"
      ? {
          sessions: collection(
            "sessions",
            many((i) => ({
              ...sessionTemplate,
              sessionID: `fixture-session-${i}`,
              rootID: `fixture-session-${i}`,
              title: `Fixture Session ${i}`,
            })),
          ),
        }
      : {}),
    ...(view === "overview"
      ? {
          agents: collection(
            "agents",
            many((i) => ({ ...agentTemplate, agent: `fixture-agent-${i}` })),
          ),
          context: collection(
            "context",
            many((i) => ({ sessionID: `fixture-session-${i}`, now: i * 100 })),
          ),
          unstable: collection(
            "unstable",
            many((i) => ({ sessionID: `fixture-session-${i}`, segment: `fixture-segment-${i}`, streak: 3 })),
          ),
        }
      : {}),
    ...(detail
      ? {
          detail: {
            ...detail,
            request: {
              ...detail.request,
              measurement: { state: "reported", write: 700, writeByTTL: { "5m": 700, "1h": 0 } },
              evidence: input.fullText ? preview : `${preview.slice(0, 512)}…`,
            },
            lines: collection(
              "detail.lines",
              many((i) => `fixture-line-${i}`),
              50,
            ),
            segments: collection(
              "detail.segments",
              many((i) => ({ name: `fixture-segment-${i}`, kind: "tool" as const, change: "changed" as const })),
              50,
            ),
            calls: collection(
              "detail.calls",
              many((i) => ({
                sessionID: "ses_lead",
                callID: `fixture-call-${i}`,
                tool: `fixture-tool-${i}`,
                status: "ok",
                started: now - i,
                callTokens: i,
                resultTokens: i * 10,
                measured: true,
                carried: i * 20,
              })),
              50,
            ),
            pings: collection(
              "detail.pings",
              many((i) => ({ at: now - i, cacheRead: i, cost: 0 })),
              50,
            ),
            accounts: collection(
              "detail.accounts",
              many((i) => ({
                at: now - i,
                kind: "account_switch",
                from: `fixture-account-${i}`,
                to: `fixture-account-${i + 1}`,
              })),
              50,
            ),
            instructions: collection(
              "detail.instructions",
              many((i) => ({ at: now - i, keys: [`fixture-key-${i}`] })),
              50,
            ),
            reverts: collection(
              "detail.reverts",
              many((i) => ({ at: now - i })),
              50,
            ),
          },
        }
      : {}),
    pages,
    presentation: {
      textLimit: 512,
      truncated:
        detail && !input.fullText
          ? [{ section: "detail.request", row: 0, field: "evidence", chars: preview.length }]
          : [],
    },
  }
}

export function MonitorStory(props: { context: Plugin.Context; paged?: boolean; payloads?: boolean }) {
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
          "monitor.query": async (input: Plus.MonitorQueryInput) =>
            createFixtureReport(input, missVariant(), now, props.paged, props.payloads),
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
          initialSession
          onClose={() => props.context.ui.router.navigate({ type: "plugin", name: "storybook" })}
        />
      </box>
      <StoryFooter
        context={props.context}
        title="storybook / monitor"
        details={[`miss: ${missVariant() === "prefix" ? "prefix-changed" : "cache-expired"}`]}
        controls={[
          ...(props.paged
            ? [
                { shortcut: "[/]", label: "older/newer page" },
                { shortcut: "l", label: "reset latest" },
              ]
            : []),
          ...(props.payloads
            ? [
                { shortcut: "p", label: "collection" },
                { shortcut: "v", label: "full text" },
              ]
            : []),
          { shortcut: "ctrl+m", label: "toggle miss cause" },
          { shortcut: "S", label: "add session filter" },
          { shortcut: "⌫", label: "undo filter" },
          { shortcut: "esc", label: "close monitor" },
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

export const monitorPagesStory: Story = {
  id: "monitor-pages",
  title: "Monitor: request pages (205-row fixture)",
  render: (context) => <MonitorStory context={context} paged />,
}

export const monitorPayloadsStory: Story = {
  id: "monitor-payloads",
  title: "Monitor: bounded collections and detail (205-row fixture)",
  render: (context) => <MonitorStory context={context} paged payloads />,
}
