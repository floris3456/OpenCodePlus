import { ToolDefinition } from "@opencode/ai"
import { Browser } from "@opencode/plugin-browser/rpc"
import { Tool } from "@opencode/schema/tool"
import { Effect, Scope } from "effect"
import { effectiveName, definition } from "../src/tool/runtime"
import { State } from "../src/state"

// Create tool list from Browser.Operations (45 tools)
const tools: Tool.Info[] = Browser.Operations.map((operation) => {
  const separator = operation.name.lastIndexOf(".")
  return {
    name: operation.name.slice(separator + 1),
    description: operation.description,
    input: operation.input,
    output: operation.output,
    options: {
      namespace: separator < 0 ? "browser" : `browser.${operation.name.slice(0, separator)}`,
      permission: "browser",
      codemode: true,
    },
    execute: () => Effect.succeed({ content: [] }),
  }
})

console.log(`Loaded ${tools.length} browser tools`)

// Build a real Tool state editor that runs ToolDefinition.make(definition(tool)) on add
type Data = {
  tools: Map<string, Tool.Info & { readonly id: string }>
  namespaces: Map<string, Tool.Namespace>
}

const state = State.create<Data, any>({
  name: "Tool",
  initial: () => ({
    tools: new Map(),
    namespaces: new Map(),
  }),
  editor: (data) => ({
    namespace: (ns: any) => data.namespaces.set(ns.name, ns),
    add: (tool: any) => {
      // Real core registration: validates definition
      ToolDefinition.make(definition(tool))
      const id = effectiveName(tool)
      data.tools.set(id, { ...tool, id })
    },
  }),
})

// Keep scope open during benchmark
const scope = Effect.runSync(Scope.make())
Effect.runSync(
  state
    .transform((editor) => {
      for (const tool of tools) {
        editor.add(tool)
      }
    })
    .pipe(Scope.provide(scope)),
)

// Measure replaying the 45-tool transform 200 times
const iterations = 200
console.log(`Starting benchmark: replaying ${tools.length} tools ${iterations} times...`)

const start = performance.now()
for (let i = 0; i < iterations; i++) {
  state.invalidate()
  state.get()
}
const elapsed = performance.now() - start

console.log(`Benchmark completed in ${elapsed.toFixed(2)} ms`)
console.log(`Replayed ${state.get().tools.size} tools per iteration (${iterations * state.get().tools.size} tool transforms total)`)
