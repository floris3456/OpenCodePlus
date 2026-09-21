#!/usr/bin/env bun
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js"
import { createSearchServer } from "./mcp.js"

const server = createSearchServer()
await server.connect(new StdioServerTransport())

const shutdown = () => {
  void server.close().then(() => process.exit(0))
}

process.on("SIGTERM", shutdown)
process.on("SIGINT", shutdown)
process.stdin.on("end", shutdown)
