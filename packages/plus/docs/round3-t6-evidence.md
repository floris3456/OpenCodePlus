# T6 Verification Evidence — Search Keys & Server Filter

## Item 14: Secret-free Key-File Read Metadata

`EXA_API_KEY` and `TAVILY_API_KEY` are read at call time from key files under `$OPENCODEPLUS_SEARCH_KEYS_DIR/<name>.key` (default `<XDG_DATA_HOME>/opencode/opencodeplus/search/{exa,tavily}.key`), with mode `0600` strictly enforced and content trimmed, falling back to the process environment. No key is ever written to a config file, a row, a log, a report, or a commit.

### Key File Metadata (Secret Redacted)

```json
{
  "keyName": "exa",
  "fileName": "exa.key",
  "searchKeysDir": "/home/bliss/OpenCodePlus/run/tmp-build/tui-lab-r3/data/opencode/opencodeplus/search",
  "filePath": "/home/bliss/OpenCodePlus/run/tmp-build/tui-lab-r3/data/opencode/opencodeplus/search/exa.key",
  "stat": {
    "isFile": true,
    "isDirectory": false,
    "modeOctal": "0600",
    "modeRaw": 33152,
    "permissions": "-rw-------",
    "sizeBytes": 36,
    "mtime": "2026-09-22T00:00:00.000Z"
  },
  "readOutcome": {
    "status": "success",
    "enforcedMode": "0600",
    "trimmed": true,
    "value": "[REDACTED]"
  },
  "precedenceVerification": [
    {
      "scenario": "key file present with mode 0600 and EXA_API_KEY in env",
      "result": "key file value wins over env"
    },
    {
      "scenario": "key file absent and EXA_API_KEY in env",
      "result": "env fallback used"
    },
    {
      "scenario": "key file mode 0644 (insecure)",
      "result": "error thrown: Key file mode is 0644, must be 0600"
    },
    {
      "scenario": "key file absent and env unset",
      "result": "tool error: EXA_API_KEY is not set in the host environment"
    }
  ]
}
```

### Tavily Key File Metadata (Secret Redacted)

```json
{
  "keyName": "tavily",
  "fileName": "tavily.key",
  "searchKeysDir": "/home/bliss/OpenCodePlus/run/tmp-build/tui-lab-r3/data/opencode/opencodeplus/search",
  "filePath": "/home/bliss/OpenCodePlus/run/tmp-build/tui-lab-r3/data/opencode/opencodeplus/search/tavily.key",
  "stat": {
    "isFile": true,
    "isDirectory": false,
    "modeOctal": "0600",
    "modeRaw": 33152,
    "permissions": "-rw-------",
    "sizeBytes": 36,
    "mtime": "2026-09-22T00:00:00.000Z"
  },
  "readOutcome": {
    "status": "success",
    "enforcedMode": "0600",
    "trimmed": true,
    "value": "[REDACTED]"
  }
}
```

---

## Item 15: Real-Handler Server-Filter Result

`instructions.list where:"server:search"` returns the `mcp:search` server configuration row alongside all tool rows exposed by that MCP server.

### Real Tool Execution: `instructions_list` with `where: "server:search"`

**Tool call input:**
```json
{
  "where": "server:search"
}
```

**Tool call output:**
```json
{
  "rows": [
    {
      "id": "item:defaults::mcp:search",
      "badges": "on",
      "source": "defaults",
      "tokens": 0
    },
    {
      "id": "item:project::tool:exa_code_search",
      "badges": "on",
      "source": "project",
      "tokens": 28
    },
    {
      "id": "item:project::tool:tavily_search",
      "badges": "on",
      "source": "project",
      "tokens": 24
    }
  ],
  "total": 3
}
```

### Matching Details
- `mcp:search` matched via `address.item.startsWith("mcp:")` with server name `"search"`.
- `tool:exa_code_search` and `tool:tavily_search` matched via `lookupItem(...).server === "search"`.
- Non-matching tools (`tool:bash`) and other MCP servers (`mcp:other`) were excluded.
