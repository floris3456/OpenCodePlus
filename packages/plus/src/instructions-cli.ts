// Handlers for the `instructions.ops` / `instructions.run` Plus RPC entries:
// the bash mirror of `tools.instructions.*` for `opencodeplus instructions …`.
//
// The op registry is enumerated from the live `tools.instructions.*`
// registrations (`ctx.tool.list()`), so a new ordinary tool registration (for
// example `link`, S2a) becomes a CLI op with no code change here. Each op runs
// the same tool implementation the model calls, with the durable log actor
// recorded as `{ type: "cli" }`: `withCliActor` wraps the Plus API handed to
// the tool registration and swaps the actor carried by each write while a CLI
// run is in flight; the tool's own protection checks still see a tool actor,
// so refusals match the model path. An unknown op is refused by value, naming
// the known ops.

import { AsyncLocalStorage } from "node:async_hooks"
import type { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"

export interface CliActor {
  readonly type: "cli"
}

export const cliActor: CliActor = { type: "cli" }

export interface InstructionCliOp {
  readonly description: string
  /** The op input as a JSON Schema object. */
  readonly inputSchema: Record<string, unknown>
  readonly run: (input: unknown, actor: CliActor) => Promise<unknown>
}

export type InstructionCliRegistry = Record<string, InstructionCliOp>

export interface OpDescriptor {
  readonly op: string
  readonly description: string
  readonly input: Record<string, unknown>
}

export interface OpRefusal {
  readonly error: {
    readonly message: string
    /** A schema/argument validation failure: the CLI reports it as a usage error (exit 2). */
    readonly usage?: boolean
  }
}

// The CLI namespace the instruction tools register under (tools.ts `namespace`).
const CLI_NAMESPACE = "instructions"

// Carries the actor a CLI run must record; only set while a run is in flight.
const cliActorContext = new AsyncLocalStorage<CliActor>()

// A tool input that fails its own schema when a CLI op runs: a usage error,
// not a refusal of the operation.
export class CliUsageError extends Error {}

export function listOps(registry: InstructionCliRegistry): OpDescriptor[] {
  return Object.entries(registry)
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([op, entry]) => ({ op, description: entry.description, input: entry.inputSchema }))
}

export function unknownOpMessage(op: string, registry: InstructionCliRegistry): string {
  const known = Object.keys(registry).toSorted((a, b) => a.localeCompare(b))
  return `op.unknown: unknown op "${op}" (known: ${known.join(", ")})`
}

export function isRefusal(value: unknown): value is OpRefusal {
  if (typeof value !== "object" || value === null) return false
  const error = (value as { error?: unknown }).error
  if (typeof error !== "object" || error === null) return false
  return typeof (error as { message?: unknown }).message === "string"
}

export function isUsageRefusal(value: unknown): value is OpRefusal {
  return isRefusal(value) && (value as { error: { usage?: unknown } }).error.usage === true
}

export function refusal(message: string): OpRefusal {
  return { error: { message } }
}

export async function runOp(
  registry: InstructionCliRegistry,
  op: string,
  input: unknown,
): Promise<unknown> {
  const entry = registry[op]
  if (entry === undefined) return refusal(unknownOpMessage(op, registry))
  try {
    return await entry.run(input, cliActor)
  } catch (error) {
    if (error instanceof CliUsageError) return { error: { message: error.message, usage: true } }
    return refusal(error instanceof Error ? error.message : String(error))
  }
}

// Enumerate the live `tools.instructions.*` registrations into CLI ops. The op
// name is the tool's own name (list, show, set, move, reset, split, create,
// delete, log, and any later registration such as link).
export function toolRegistry(tools: readonly (Tool.Info & { readonly id: string })[]): InstructionCliRegistry {
  return Object.fromEntries(
    tools
      .filter((tool) => tool.options?.namespace === CLI_NAMESPACE)
      .map((tool) => [
        tool.name,
        {
          description: tool.description,
          inputSchema: inputSchema(tool.input),
          run: (input: unknown, actor: CliActor) => runTool(tool, input, actor),
        },
      ]),
  )
}

// Run one registered instruction tool exactly as the model would, but with the
// CLI actor in scope so the API records it. Input decodes through the tool's
// own schema; a failure is a usage error rather than an operation refusal.
async function runTool(
  tool: Tool.Info & { readonly id: string },
  input: unknown,
  actor: CliActor,
): Promise<unknown> {
  const schema = tool.input
  const value = Schema.isSchema(schema)
    ? decodeOrUsage(tool.name, () => Schema.decodeUnknownSync(schema)(input))
    : input
  const result = await cliActorContext.run(actor, () => Effect.runPromise(tool.execute(value, cliContext())))
  return (result as { readonly output?: unknown }).output
}

function decodeOrUsage(tool: string, decode: () => unknown): unknown {
  try {
    return decode()
  } catch (error) {
    throw new CliUsageError(`Invalid arguments for "${tool}": ${error instanceof Error ? error.message : String(error)}`)
  }
}

// The synthetic context a CLI op runs with. The tool derives a tool actor from
// it, so protected-row checks and refusals are identical to the model path;
// `withCliActor` only replaces the actor the API logs.
function cliContext(): Tool.Context {
  return {
    sessionID: "cli" as Tool.Context["sessionID"],
    agent: "cli" as Tool.Context["agent"],
    messageID: "cli" as Tool.Context["messageID"],
    id: "cli" as Tool.Context["id"],
    progress: () => Effect.void,
  }
}

// Wrap the Plus API handed to `registerInstructionTools` so that, while a CLI
// op runs, the actor on a write input is the CLI actor. Every other call and
// every model tool run passes through untouched (no actor in scope). The API is
// a plain object of async functions, so a shallow copy avoids reflection.
export function withCliActor<T extends object>(api: T): T {
  const wrapped: Record<string, unknown> = {}
  for (const key of Object.keys(api)) {
    const value = (api as Record<string, unknown>)[key]
    wrapped[key] = typeof value === "function" ? wrapCliActor(value as (...args: unknown[]) => unknown) : value
  }
  return wrapped as T
}

function wrapCliActor(fn: (...args: unknown[]) => unknown): (input?: unknown, ...rest: unknown[]) => unknown {
  return (input?: unknown, ...rest: unknown[]) => {
    const actor = cliActorContext.getStore()
    const patched =
      actor !== undefined && typeof input === "object" && input !== null && "actor" in input
        ? { ...input, actor }
        : input
    return fn(patched, ...rest)
  }
}

function inputSchema(schema: Tool.ValueSchema<unknown>): Record<string, unknown> {
  if (Schema.isSchema(schema)) return Schema.toJsonSchemaDocument(schema).schema as Record<string, unknown>
  if (typeof schema === "object" && schema !== null && "~standard" in schema) {
    const standard = schema["~standard"] as { jsonSchema?: { input(options: { target: string }): unknown } }
    const generated = standard.jsonSchema?.input({ target: "draft-2020-12" })
    if (typeof generated === "object" && generated !== null) return generated as Record<string, unknown>
  }
  return (schema ?? {}) as Record<string, unknown>
}