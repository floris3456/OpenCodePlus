# T6 Evidence — Search Keys & Server Filter

This document captures actual output produced by reproducible in-process test runs using `test/harness.ts` without accessing real credentials.

---

## 1. Reproducible Command

Command run within `packages/plus`:
```sh
bun test test/search/register.test.ts
```

---

## 2. Item 14: Key File Read Metadata (Captured Output)

Disposable sentinel values (`sentinel-exa-<uuid>` and `sentinel-tavily-<uuid>`) were generated at test runtime, written to key files under `$OPENCODEPLUS_SEARCH_KEYS_DIR/<name>.key` with permissions `0600`, read via `readKey(name)`, and verified for sentinel equality. Real credentials are never accessed.

### Captured Stdout

```json
{
  "exa": {
    "path": "/home/bliss/OpenCodePlus/run/team/development-models/runs/w-7c7d22401bd4059c/tmp/plus-search-register-iBfHcU/project/search/exa.key",
    "mode": "0600",
    "size": 50,
    "mtime": "2026-09-21T17:09:19.264Z",
    "sentinelMatch": true,
    "value": "[REDACTED (sentinel matched)]"
  },
  "tavily": {
    "path": "/home/bliss/OpenCodePlus/run/team/development-models/runs/w-7c7d22401bd4059c/tmp/plus-search-register-iBfHcU/project/search/tavily.key",
    "mode": "0600",
    "size": 53,
    "mtime": "2026-09-21T17:09:19.264Z",
    "sentinelMatch": true,
    "value": "[REDACTED (sentinel matched)]"
  }
}
```

Verification notes:
- Mode `0600` strictly enforced: files with permissions other than `0600` (e.g. `0644`) throw an Error enforcing `0600`.
- Key values are trimmed of leading/trailing whitespace.
- Precedence: Key file value wins over process environment (`EXA_API_KEY`/`TAVILY_API_KEY`).
- Fallback: When key file is absent, values fall back to `EXA_API_KEY`/`TAVILY_API_KEY`.
- Missing keys: When absent from both file and environment, `readKey` returns `undefined` and tools report existing missing key errors.

---

## 3. Item 15: Real-Handler Server-Filter Result (Captured Output)

The registered `instructions_list` tool handler was executed with `{ where: "server:search" }` against the real instructions tree created via `test/harness.ts` with MCP server `search` registered via `registerSearchMcp` and tools (`exa_code_search`, `tavily_search`) carrying `origin: { type: "mcp", name: "search" }`.

### Invocation Input

```json
{
  "where": "server:search"
}
```

### Captured Stdout from Registered Handler

```json
{
  "rows": [
    {
      "id": "item:defaults:alpha:tool:exa_code_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "section:defaults:alpha:tool:exa_code_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "item:defaults:alpha:tool:tavily_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "section:defaults:alpha:tool:tavily_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "item:defaults::tool:exa_code_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "section:defaults::tool:exa_code_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "item:defaults::tool:tavily_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "section:defaults::tool:tavily_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "item:defaults::mcp:search",
      "badges": "on",
      "source": "upstream",
      "tokens": 97
    },
    {
      "id": "section:defaults::mcp:search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 97
    },
    {
      "id": "item:defaults:opencodeplus-team/:astra-planner:tool:exa_code_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "section:defaults:opencodeplus-team/:astra-planner:tool:exa_code_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "item:defaults:opencodeplus-team/:astra-planner:tool:tavily_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "section:defaults:opencodeplus-team/:astra-planner:tool:tavily_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "item:defaults:opencodeplus-team/:astra-reviewer:tool:exa_code_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "section:defaults:opencodeplus-team/:astra-reviewer:tool:exa_code_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "item:defaults:opencodeplus-team/:astra-reviewer:tool:tavily_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "section:defaults:opencodeplus-team/:astra-reviewer:tool:tavily_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "item:defaults:opencodeplus-team/:fable-planner:tool:exa_code_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "section:defaults:opencodeplus-team/:fable-planner:tool:exa_code_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "item:defaults:opencodeplus-team/:fable-planner:tool:tavily_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "section:defaults:opencodeplus-team/:fable-planner:tool:tavily_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "item:defaults:opencodeplus-team/:gemini-implementer:tool:exa_code_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "section:defaults:opencodeplus-team/:gemini-implementer:tool:exa_code_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "item:defaults:opencodeplus-team/:gemini-implementer:tool:tavily_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "section:defaults:opencodeplus-team/:gemini-implementer:tool:tavily_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "item:defaults:opencodeplus-team/:muse-implementer:tool:exa_code_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "section:defaults:opencodeplus-team/:muse-implementer:tool:exa_code_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "item:defaults:opencodeplus-team/:muse-implementer:tool:tavily_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "section:defaults:opencodeplus-team/:muse-implementer:tool:tavily_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "item:defaults:opencodeplus-team/:opus-implementer:tool:exa_code_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "section:defaults:opencodeplus-team/:opus-implementer:tool:exa_code_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "item:defaults:opencodeplus-team/:opus-implementer:tool:tavily_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "section:defaults:opencodeplus-team/:opus-implementer:tool:tavily_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "item:defaults:opencodeplus-team/:opus-orchestrator:tool:exa_code_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "section:defaults:opencodeplus-team/:opus-orchestrator:tool:exa_code_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "item:defaults:opencodeplus-team/:opus-orchestrator:tool:tavily_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "section:defaults:opencodeplus-team/:opus-orchestrator:tool:tavily_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 6
    },
    {
      "id": "item:defaults:opencodeplus-team/:scout:tool:exa_code_search",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    },
    {
      "id": "section:defaults:opencodeplus-team/:scout:tool:exa_code_search:whole",
      "badges": "on",
      "source": "upstream",
      "tokens": 5
    }
  ],
  "total": 72
}
```

Verification notes:
- Filter `server:search` matched the MCP server row `item:defaults::mcp:search` directly via `address.item.startsWith("mcp:")`.
- Filter `server:search` matched all tools registered for server `search` (`exa_code_search` and `tavily_search`) across all applicable scopes (shared defaults, active agents, and team member defaults).
- Unrelated tools (`tool:bash`) were correctly excluded.
