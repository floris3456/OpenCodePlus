# plus-1.1.12 monitor — T2/T3 query contract

The shape T2 (analysis, `src/monitor/query.ts` or `cache.ts`) answers and T3
(the page, `src/tui/monitor/*`) reads, so both can work at once. Guidance, not
law: either side may add a field; renaming or removing one needs the other
side updated in the same landing. Every new key is `Schema.optionalKey`
(omitted, never `undefined`), in `src/rpc.ts`.

## Input (`MonitorQueryInput`)

- `scope`: `"session" | "tree" | "team" | "project" | "all"`.
  `session` is now **only** that session; `tree` is the root of its delegation
  tree (team run parents and host subagent parents, up to the topmost) and every
  descendant at any depth. `team` needs `team` (a Plus team name).
- `sessionID?`, `team?`.
- `sinceCompaction?: true` — per session, only requests after that session's
  latest compaction (the tool exposes it as `since: "compaction"`).
- `view?: "overview" | "cache" | "tools" | "sessions" | "steps"` — what extra
  sections to compute. Today's fields (totals, groups, feed, facets, marks,
  compare) are always answered as now; `tools` adds nothing new.
- `id?: string` — one request id: adds `detail` (cache or steps view).
- `missesOnly?: true` — `requests` keeps misses and partial misses only.
- `titles?: true` — include title requests in totals (default excluded).

## Output additions (`MonitorReport`)

- `totals` gains: `requests`, `pings`, `pingCost`, `misses` (miss + partial),
  `missTokens` (tokens re-written or re-read uncached because of misses),
  `missCost`, `hitRate` (cache read ÷ (uncached input + cache read), 0..1).
- `requests?: MonitorRequest[]` (cache, steps): time order, oldest first.
- `detail?: MonitorRequestDetail` (when `id`).
- `agents?: MonitorAgentRow[]` (overview): last active first.
- `topMisses?: MonitorRequest[]` (overview): top 3 by miss cost/tokens.
- `unstable?: { sessionID, segment, streak }[]` (overview, cache).
- `context?: { sessionID, now, atCompaction? }[]` (overview): prompt tokens of
  the latest request versus the first request after the latest compaction.
- `sessions?: MonitorSessionRow[]` (sessions): tree order, last active first.
- `pings?: { sent, cost, followedByHit, followedByMiss }` (overview, cache).
- `unread?: number` — cache writes never read before expiry (tokens).
- `teams?: string[]` — teams known in the ledger, for the `T` picker.

```ts
MonitorRequest = {
  id: string               // stable: session id + message id or request key
  sessionID: string
  messageID?: string
  kind: "step" | "compaction" | "ping" | "generate" | "title"
  at: number; durationMs?: number; finish?: string; error?: string
  agent?: string; provider?: string; model?: string; variant?: string
  input: number; output: number; reasoning: number
  cacheRead: number; cacheWrite: number; cost: number
  verdict: "hit" | "partial" | "miss" | "cold" | "none"
  cause?: "compacted" | "model-switch" | "agent-switch" | "prefix-changed"
        | "cache-expired" | "account-changed" | "unknown"
  confidence?: "certain" | "likely" | "unknown"
  evidence?: string        // one line, e.g. "system part AGENTS.md changed"
  expected?: number        // expected reusable prefix tokens
  missTokens?: number; missCost?: number
  tools?: string[]         // tools the step called
}

MonitorRequestDetail = {
  request: MonitorRequest
  previous?: { id: string; at: number; messageID?: string }
  lines: string[]          // evidence lines, most telling first
  segments: { name: string; kind: "system" | "tool" | "option" | "message" | "marker"
              change: "changed" | "added" | "removed"
              before?: { hash: string; chars: number; tokens: number }
              after?: { hash: string; chars: number; tokens: number } }[]
  firstDivergence?: string // named segment, e.g. "message 14 (tool result)"
  timing: { gapMs?: number; lifetimeMs?: number; lastPingAt?: number
            warming?: "on" | "off" | "ended" | "failed" }
  pings: { at: number; cacheRead: number; cost: number; error?: string }[]
  accounts: { at: number; kind: string; from?: string; to?: string }[]
  instructions: { at: number; keys: string[] }[]
  reverts: { at: number }[]
  expectedTokens?: number; actualCacheRead: number
  calls?: MonitorCall[]    // the step's calls with attributed tokens
}

MonitorAgentRow = { agent: string; model?: string; steps: number; hitRate: number
  misses: number; tokens: number; cost: number; lastActive: number }

MonitorSessionRow = { sessionID: string; parentID?: string; rootID: string
  depth: number; title?: string; agent?: string; runID?: string; role?: string
  team?: string; lastActive: number; state?: string; requests: number
  steps: number; input: number; cacheRead: number; cacheWrite: number
  output: number; reasoning: number; cost: number; hitRate: number; misses: number }
```

The `S` session picker reads `view: "sessions"` with `scope: "all"` (or
`project`): rows carry `rootID` and `depth`, so trees group under their root
and stand-alone chats (depth 0, no children) list separately.
