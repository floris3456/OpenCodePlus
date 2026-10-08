// Handlers for the `instructions.ops` / `instructions.run` Plus RPC entries:
// the bash mirror of `tools.instructions.*` for `opencodeplus instructions …`.
//
// The op registry is injected (Part 2 exports it from tools.ts and wires it
// in index.ts), so this module never imports tools.ts. Each op runs with the
// actor recorded as `{ type: "cli" }`, and an unknown op is refused by value,
// naming the known ops.

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
  }
}

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
    return refusal(error instanceof Error ? error.message : String(error))
  }
}
