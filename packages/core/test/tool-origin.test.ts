import { describe, expect } from "bun:test"
import { Bus } from "@opencode/core/bus"
import { Image } from "@opencode/core/image"
import { Mcp } from "@opencode/core/mcp/index"
import { Permission } from "@opencode/core/permission"
import { Tool } from "@opencode/core/tool"
import { McpTool } from "@opencode/core/tool/mcp"
import type { Tool as ToolNamespace } from "@opencode/schema/tool"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { Effect, Layer, Schema, Stream } from "effect"
import { imagePassthrough } from "./lib/image"
import { testEffect } from "./lib/effect"

// Compiled directly instead of through AppNodeBuilder: the builder imports the
// plugin supervisor graph, which currently fails to load on a broken
// `@opencode/plus` import. These nodes need no Location provisioning.
const mcp = Layer.mock(Mcp.Service, {
  tools: () =>
    Effect.succeed([
      new Mcp.Tool({
        server: Mcp.ServerName.make("my.server"),
        name: "search",
        description: "Search",
        inputSchema: { type: "object", properties: {} },
      }),
    ]),
})

const it = testEffect(
  LayerNode.compile(LayerNode.group([Tool.node, McpTool.node]), {
    replacements: [
      Mcp.node.replace(mcp),
      Permission.node.replace(Layer.mock(Permission.Service, { assert: () => Effect.void })),
      Bus.node.replace(Layer.mock(Bus.Service, { subscribe: () => Stream.never })),
      Image.node.replace(imagePassthrough),
    ],
  }),
)

const builtin = (): ToolNamespace.Info => ({
  name: "echo",
  description: "Echo",
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  execute: ({ text }) => Effect.succeed({ output: { text }, content: text }),
})

describe("Tool origin", () => {
  it.effect("reports the real MCP server name through registration", () =>
    Effect.gen(function* () {
      const registry = yield* Tool.Service
      yield* registry.transform((editor) => editor.add({ ...builtin(), options: { codemode: false } }))
      yield* (yield* McpTool.Service).flush
      yield* registry.transform((editor) => {
        // my.server sanitizes to my_server in the namespace, but origin keeps the real name.
        expect(editor.get("my_server_search")?.origin).toEqual({ type: "mcp", name: "my.server" })
        expect(editor.get("echo")?.origin).toBeUndefined()
      })
    }),
  )
})
