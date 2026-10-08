// `opencodeplus instructions <op> [<id>] [--<param> value …] [--json '<obj>']`:
// the bash mirror of `tools.instructions.*`, Plus product only.
//
// The per-op flags are dynamic (each op's JSON Schema from
// `instructions.ops`), so the full grammar is parsed from the raw argv tail
// (see parseInstructionsArgs): the static Spec (InstructionsCommand in
// ../commands) only declares the stable surface (`--json`, `--text`,
// `--text-file`) plus a variadic tail, and the handler re-parses
// `process.argv`. Bare dynamic flags therefore need pre-dispatch interception
// to work end to end (reported as a wiring need); through Effect dispatch they
// arrive after `--`, which Effect strips into the tail. Exit 1 on a refusal
// (message on stderr), 2 on a usage error.

import { EOL } from "node:os"
import { OpenCode } from "@opencode/client"
import { Service } from "@opencode/client/effect/service"
import { Product } from "@opencode/util/product"
import { Effect, Option } from "effect"
import { isRefusal } from "../../../../plus/src/instructions-cli.js"
import { Definition } from "../../../../plus/src/rpc.js"
import { InstructionsCommand } from "../commands"
import { Runtime } from "../../framework/runtime"
import { ServerConnection } from "../../services/server-connection"
import { ServiceHandover } from "../../services/service-handover"
import { errorMessage } from "../../util/error"

export interface JsonProperty {
  readonly type?: string | ReadonlyArray<string>
  readonly description?: string
  readonly items?: {
    readonly type?: string | ReadonlyArray<string>
  }
}

export interface OpSchema {
  readonly type?: string
  readonly properties?: Record<string, JsonProperty>
  readonly required?: ReadonlyArray<string>
}

export interface OpDescriptor {
  readonly op: string
  readonly description: string
  readonly input: OpSchema
}

export type ParseOutcome =
  | { readonly kind: "run"; readonly op: string; readonly input: Record<string, unknown> }
  | { readonly kind: "ops-help" }
  | { readonly kind: "op-help"; readonly op: string }
  | { readonly kind: "usage-error"; readonly message: string }

export interface ParseIO {
  readonly readFile: (path: string) => Promise<string>
  readonly readStdin: () => Promise<string>
}

export interface InstructionDeps extends ParseIO {
  readonly productNamespace: string
  readonly binaryName: string
  readonly ops: () => Promise<readonly OpDescriptor[]>
  readonly run: (op: string, input: Record<string, unknown>) => Promise<unknown>
  readonly serverVersion: () => Promise<string>
}

export interface InstructionResult {
  readonly exitCode: 0 | 1 | 2
  readonly stdout: string
  readonly stderr: string
}

export function usageLine(binary: string): string {
  return `Usage: ${binary} instructions <op> [<id>] [--<param> value …] [--json '<obj>']`
}

export function formatOpsHelp(ops: readonly OpDescriptor[], binary: string): string {
  const width = ops.reduce((max, op) => Math.max(max, op.op.length), 0)
  const rows = ops.map((op) => `  ${op.op.padEnd(width)}  ${firstLine(op.description)}`)
  return [`Ops (from the running service):`, ...rows, "", usageLine(binary), ""].join(EOL)
}

export function formatOpHelp(op: OpDescriptor, binary: string): string {
  const properties = op.input.properties ?? {}
  const required = new Set(op.input.required ?? [])
  const names = Object.keys(properties).toSorted((a, b) => a.localeCompare(b))
  const params = names.map((name) => {
    const property = properties[name]!
    const type = renderType(property)
    const req = required.has(name) ? " (required)" : ""
    const doc = property.description ? ` — ${property.description}` : ""
    return `  --${name} ${type}${req}${doc}`
  })
  return [
    usageLine(binary),
    "",
    op.description,
    "",
    "Params:",
    ...params,
    `  --json '<obj>' — object params as JSON (merged under explicit flags)`,
    `  --text-file F, --text - — fill text (from a file, or stdin with -)`,
    ...(properties.id !== undefined ? ["", "A positional id fills --id."] : []),
    "",
  ].join(EOL)
}

export async function parseInstructionsArgs(
  args: readonly string[],
  ops: readonly OpDescriptor[],
  io: ParseIO,
): Promise<ParseOutcome> {
  const byOp = new Map(ops.map((op) => [op.op, op]))
  let op: string | undefined
  const positionals: string[] = []
  const flags: Array<{ name: string; value: string | undefined }> = []
  const jsonBlobs: string[] = []
  const textSources: Array<{ kind: "literal" | "stdin" | "file"; value: string }> = []
  let help = false
  let endOfOptions = false
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (endOfOptions) {
      positionals.push(arg)
      continue
    }
    if (arg === "--") {
      endOfOptions = true
      continue
    }
    if (arg === "--help") {
      help = true
      continue
    }
    if (arg === "--json" || arg === "--text" || arg === "--text-file") {
      const value = args[i + 1]
      if (value === undefined) return usageError(`Option ${arg} expects a value.`)
      i++
      if (arg === "--json") jsonBlobs.push(value)
      else if (arg === "--text-file") textSources.push({ kind: "file", value })
      else textSources.push(value === "-" ? { kind: "stdin", value } : { kind: "literal", value })
      continue
    }
    if (arg.startsWith("--") && arg.length > 2) {
      const bare = arg.slice(2)
      const eq = bare.indexOf("=")
      if (eq === -1) {
        const name = bare
        const next = args[i + 1]
        if (next !== undefined && !next.startsWith("--") && next !== "--help") {
          flags.push({ name, value: next })
          i++
        } else flags.push({ name, value: undefined })
      } else flags.push({ name: bare.slice(0, eq), value: bare.slice(eq + 1) })
      continue
    }
    if (arg.startsWith("-") && arg.length > 1) return usageError(`Unknown option ${arg}: only --<param> options are supported.`)
    positionals.push(arg)
  }
  if (positionals.length > 0) op = positionals[0]
  if (positionals.length > 2) return usageError(`Too many positional arguments: expected [<id>] after <op>.`)
  if (op === undefined) return { kind: "ops-help" }
  const descriptor = byOp.get(op)
  if (descriptor === undefined) {
    const known = [...byOp.keys()].toSorted((a, b) => a.localeCompare(b)).join(", ")
    return usageError(`Unknown op "${op}" (known: ${known}).`)
  }
  if (help) return { kind: "op-help", op }
  const properties = descriptor.input.properties ?? {}
  const input: Record<string, unknown> = {}
  for (const blob of jsonBlobs) {
    const parsed: unknown = await parseJsonBlob(blob)
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
      return usageError(`Option --json expects a JSON object, got: ${blob}`)
    Object.assign(input, parsed)
  }
  const positionalId = positionals[1]
  if (positionalId !== undefined) {
    if (properties.id === undefined) return usageError(`Op "${op}" takes no positional id.`)
    if (input.id === undefined) input.id = positionalId
  }
  for (const flag of flags) {
    const property = properties[flag.name]
    if (property === undefined) return usageError(`Unknown parameter --${flag.name} for op "${op}".`)
    const coerced = coerceFlag(flag.name, flag.value, property)
    if (typeof coerced === "string") return usageError(coerced)
    appendFlag(input, flag.name, coerced.value, property)
  }
  for (const source of textSources) {
    if (source.kind === "literal") input.text = source.value
    else if (source.kind === "stdin") input.text = await io.readStdin()
    else input.text = await io.readFile(source.value)
  }
  const missing = (descriptor.input.required ?? []).filter((name) => input[name] === undefined)
  if (missing.length > 0)
    return usageError(`Op "${op}" is missing required ${missing.map((name) => `--${name}`).join(", ")}.`)
  return { kind: "run", op, input }
}

export async function runInstructionsCommand(argv: readonly string[], deps: InstructionDeps): Promise<InstructionResult> {
  if (deps.productNamespace !== "opencodeplus")
    return { exitCode: 2, stdout: "", stderr: `The instructions command is available in OpenCodePlus only.${EOL}` }
  let ops: readonly OpDescriptor[]
  try {
    ops = await deps.ops()
  } catch (error) {
    if (!isUnknownMethod(error)) return { exitCode: 1, stdout: "", stderr: `${errorMessage(error)}${EOL}` }
    const version = await safeVersion(deps)
    return {
      exitCode: 1,
      stdout: "",
      stderr: `The running service (${version}) predates this command; start opencodeplus to replace it.${EOL}`,
    }
  }
  const parsed = await parseInstructionsArgs(argv, ops, deps)
  if (parsed.kind === "ops-help") return { exitCode: 0, stdout: formatOpsHelp(ops, deps.binaryName), stderr: "" }
  if (parsed.kind === "op-help") {
    const descriptor = ops.find((op) => op.op === parsed.op)!
    return { exitCode: 0, stdout: formatOpHelp(descriptor, deps.binaryName), stderr: "" }
  }
  if (parsed.kind === "usage-error") return { exitCode: 2, stdout: "", stderr: `${parsed.message}${EOL}` }
  let result: unknown
  try {
    result = await deps.run(parsed.op, parsed.input)
  } catch (error) {
    return { exitCode: 1, stdout: "", stderr: `${errorMessage(error)}${EOL}` }
  }
  if (isRefusal(result)) return { exitCode: 1, stdout: "", stderr: `${result.error.message}${EOL}` }
  return { exitCode: 0, stdout: `${JSON.stringify(result, null, 2)}${EOL}`, stderr: "" }
}

export default Runtime.handler(
  InstructionsCommand,
  Effect.fn("cli.instructions")(function* (input) {
    const raw = tailAfterInstructions(process.argv)
    const server = yield* ServerConnection.resolve({
      server: Option.getOrUndefined(input.server),
      standalone: input.standalone,
      mismatch: "ignore",
    })
    const client = OpenCode.make({ baseUrl: server.endpoint.url, headers: Service.headers(server.endpoint) })
    const plus = client.rpc(Definition)
    const deps: InstructionDeps = {
      productNamespace: Product.namespace,
      binaryName: Product.binaryName,
      readFile: (path) => Bun.file(path).text(),
      readStdin: () => readAllStdin(),
      ops: () => plus["instructions.ops"](undefined).then((output) => output.ops),
      run: (op, input) => plus["instructions.run"]({ op, input }) as Promise<unknown>,
      serverVersion: () =>
        Effect.runPromise(ServiceHandover.serverVersion(server.endpoint)).catch(() => "unknown"),
    }
    const result = yield* Effect.promise(() => runInstructionsCommand(raw, deps))
    if (result.stdout) process.stdout.write(result.stdout)
    if (result.stderr) process.stderr.write(result.stderr)
    process.exitCode = result.exitCode
  }),
)

function tailAfterInstructions(argv: readonly string[]): string[] {
  const index = argv.indexOf("instructions")
  return index === -1 ? [] : argv.slice(index + 1)
}

function usageError(message: string): ParseOutcome {
  return { kind: "usage-error", message }
}

async function parseJsonBlob(blob: string): Promise<unknown> {
  try {
    return JSON.parse(blob) as unknown
  } catch {
    return undefined
  }
}

function firstLine(description: string): string {
  const line = description.split("\n", 1)[0] ?? description
  return line.trim()
}

function renderType(property: JsonProperty): string {
  const types = property.type === undefined ? ["string"] : Array.isArray(property.type) ? [...property.type] : [property.type]
  if (types.includes("array")) {
    const items = property.items?.type
    const item = items === undefined ? "string" : Array.isArray(items) ? items.join("|") : items
    return `${item}[]`
  }
  return types.join("|")
}

function coerceFlag(name: string, value: string | undefined, property: JsonProperty): { value: unknown } | string {
  const types = property.type === undefined ? ["string"] : Array.isArray(property.type) ? [...property.type] : [property.type]
  if (value === "null" && types.includes("null")) return { value: null }
  if (types.includes("array")) {
    if (value === undefined) return `Option --${name} expects a value.`
    const itemType = property.items?.type
    const pieces = value.split(",").filter((piece) => piece.length > 0)
    const coerced: unknown[] = []
    for (const piece of pieces) {
      const scalar = coerceScalar(name, piece, itemType)
      if (typeof scalar === "string") return scalar
      coerced.push(scalar.value)
    }
    return { value: coerced }
  }
  if (types.includes("object")) return `Parameter --${name} is an object: pass it with --json.`
  if (types.includes("boolean") && (value === undefined || value === "true" || value === "false" || value === "1" || value === "0")) {
    if (value === undefined) return { value: true }
    return { value: value === "true" || value === "1" }
  }
  if (types.includes("boolean")) return `Option --${name} expects true or false, got: ${value}.`
  if (value === undefined) return `Option --${name} expects a value.`
  return coerceScalar(name, value, property.type)
}

function coerceScalar(name: string, value: string, type: string | ReadonlyArray<string> | undefined): { value: unknown } | string {
  const types = type === undefined ? ["string"] : Array.isArray(type) ? [...type] : [type]
  if (types.includes("number") || types.includes("integer")) {
    const number = Number(value)
    if (!Number.isFinite(number)) return `Option --${name} expects a number, got: ${value}.`
    if (types.includes("integer") && !types.includes("number") && !Number.isInteger(number))
      return `Option --${name} expects an integer, got: ${value}.`
    return { value: number }
  }
  if (types.includes("boolean")) {
    if (value === "true" || value === "1") return { value: true }
    if (value === "false" || value === "0") return { value: false }
    return `Option --${name} expects true or false, got: ${value}.`
  }
  return { value }
}

function appendFlag(input: Record<string, unknown>, name: string, value: unknown, property: JsonProperty): void {
  const types = property.type === undefined ? [] : Array.isArray(property.type) ? property.type : [property.type]
  const current = input[name]
  if (types.includes("array") && Array.isArray(current) && Array.isArray(value)) {
    input[name] = [...current, ...(value as unknown[])]
    return
  }
  input[name] = value
}

function isUnknownMethod(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false
  const type = (error as { type?: unknown }).type
  return type === "rpc.method_not_found" || type === "rpc.unavailable"
}

async function safeVersion(deps: InstructionDeps): Promise<string> {
  try {
    return await deps.serverVersion()
  } catch {
    return "unknown"
  }
}

async function readAllStdin(): Promise<string> {
  const chunks: Uint8Array[] = []
  for await (const chunk of Bun.stdin.stream()) chunks.push(chunk as Uint8Array)
  return Buffer.concat(chunks).toString("utf8")
}
