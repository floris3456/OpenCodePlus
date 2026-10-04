import type { Plugin } from "@opencode/plugin/tui"
import { MonitorView } from "@opencode/plus/tui"
import { Definition, type Plus } from "@opencode/plus/rpc"
import { useTerminalDimensions } from "@opentui/solid"
import { createSignal } from "solid-js"
import { StoryFooter } from "./footer"
import type { Story } from "./index"

function createFixtureReport(now: number, missVariant: "prefix" | "expired"): Plus.MonitorReport {
  const missReq: Plus.MonitorRequest =
    missVariant === "prefix"
      ? {
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
      : {
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

  const detail: Plus.MonitorRequestDetail = {
    request: missReq,
    previous: { id: "req_prev", at: now - 420_000 },
    lines: [
      missVariant === "prefix"
        ? "system part AGENTS.md changed at line 42"
        : "gap 420s exceeds provider cache lifetime (300s)",
      "expected prefix: 18.5k tokens, cache read: 500 tokens",
      "warming was inactive for this session",
    ],
    segments: [
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
    ],
    firstDivergence: "system: AGENTS.md",
    timing: {
      gapMs: 420_000,
      lifetimeMs: 300_000,
      lastPingAt: undefined,
      warming: "off",
    },
    pings: [],
    accounts: [],
    instructions: [{ at: now - 130_000, keys: ["AGENTS.md"] }],
    reverts: [],
    actualCacheRead: 500,
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

  const requests: Plus.MonitorRequest[] = [
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
    missReq,
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
  ]

  const totals: Plus.MonitorTotals = {
    steps: 12,
    calls: 28,
    errors: 1,
    running: 0,
    input: 6420,
    output: 2150,
    reasoning: 890,
    cacheRead: 82500,
    cacheWrite: 15800,
    cost: 0.18,
    callTokens: 980,
    resultTokens: 6400,
    carried: 28400,
    requests: 15,
    pings: 3,
    pingCost: 0.006,
    misses: 1,
    missTokens: 18000,
    missCost: 0.027,
    hitRate: 0.93,
  }

  const groups: Plus.MonitorGroup[] = [
    {
      key: "read",
      label: "read",
      calls: 12,
      inner: 0,
      errors: 0,
      running: 0,
      callTokens: 420,
      resultTokens: 3800,
      carried: 18200,
      estimated: 0,
      avgMs: 340,
    },
    {
      key: "edit",
      label: "edit",
      calls: 7,
      inner: 0,
      errors: 1,
      running: 0,
      callTokens: 260,
      resultTokens: 1400,
      carried: 6200,
      estimated: 0,
      avgMs: 820,
    },
    {
      key: "shell",
      label: "shell",
      calls: 5,
      inner: 2,
      errors: 0,
      running: 0,
      callTokens: 180,
      resultTokens: 850,
      carried: 2900,
      estimated: 0,
      avgMs: 1450,
    },
    {
      key: "grep",
      label: "grep",
      calls: 4,
      inner: 0,
      errors: 0,
      running: 0,
      callTokens: 120,
      resultTokens: 350,
      carried: 1100,
      estimated: 0,
      avgMs: 210,
    },
  ]

  const feed: Plus.MonitorCall[] = [
    {
      sessionID: "ses_worker",
      callID: "c_last",
      agent: "explore",
      tool: "edit",
      target: "packages/plus/src/tui/monitor/view.tsx",
      status: "ok",
      started: now - 44_000,
      ended: now - 42_800,
      callTokens: 75,
      resultTokens: 420,
      measured: true,
      carried: 1260,
    },
    {
      sessionID: "ses_lead",
      callID: "c_grep",
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
    {
      sessionID: "ses_lead",
      callID: "c_read",
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
  ]

  const agents: Plus.MonitorAgentRow[] = [
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
  ]

  const sessions: Plus.MonitorSessionRow[] = [
    {
      sessionID: "ses_lead",
      rootID: "ses_lead",
      depth: 0,
      title: "Deliver Monitor page (T3)",
      agent: "build",
      role: "Lead Implementer",
      lastActive: now - 120_000,
      state: "active",
      requests: 11,
      steps: 8,
      input: 5800,
      cacheRead: 58000,
      cacheWrite: 15800,
      output: 1810,
      reasoning: 440,
      cost: 0.12,
      hitRate: 0.94,
      misses: 1,
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
      requests: 4,
      steps: 4,
      input: 620,
      cacheRead: 24500,
      cacheWrite: 0,
      output: 340,
      reasoning: 450,
      cost: 0.06,
      hitRate: 0.91,
      misses: 0,
    },
  ]

  return {
    now,
    totals,
    groups,
    feed,
    facets: {
      agents: ["build", "explore"],
      tools: ["read", "edit", "shell", "grep"],
      models: ["claude-3-7-sonnet", "gpt-5"],
    },
    marks: [
      { id: 1, at: now - 300_000, label: "before prompt change" },
    ],
    requests,
    detail,
    topMisses: [missReq],
    unstable: [
      { sessionID: "ses_lead", segment: "system part instructions-hash", streak: 3 },
    ],
    context: [
      { sessionID: "ses_lead", now: 38400, atCompaction: 14200 },
    ],
    agents,
    sessions,
    pings: {
      sent: 3,
      cost: 0.006,
      followedByHit: 2,
      followedByMiss: 1,
    },
    teams: ["Flash", "Core", "App"],
  }
}

export function MonitorStory(props: { context: Plugin.Context }) {
  const [missVariant, setMissVariant] = createSignal<"prefix" | "expired">("prefix")
  const dimensions = useTerminalDimensions()
  const now = Date.now()

  // Intercept monitor RPC calls to return our contract-shaped fixture report
  const originalRpc = props.context.client.rpc.bind(props.context.client)
  const clientProxy = new Proxy(props.context.client, {
    get(target, prop, receiver) {
      if (prop === "rpc") {
        return (definition: unknown) => {
          if (definition === Definition) {
            return {
              "monitor.query": async () => createFixtureReport(now, missVariant()),
              "monitor.mark": async (input: Plus.MonitorMarkInput) => ({
                id: 99,
                at: Date.now(),
                label: input.label,
              }),
            }
          }
          return originalRpc(definition as never)
        }
      }
      return Reflect.get(target, prop, receiver)
    },
  })

  const contextProxy = new Proxy(props.context, {
    get(target, prop, receiver) {
      if (prop === "client") return clientProxy
      return Reflect.get(target, prop, receiver)
    },
  })

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
          context={contextProxy}
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
