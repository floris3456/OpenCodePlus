// A tool reaches the model as its description and its parameters: the
// top-level properties of its input JSON Schema. Discovery lists them as
// Parameters rows under each tool row; apply shows a session the edited
// parameters (description replaced, an optional parameter switched off)
// through the same per-request plan as the tool's description. The tool still
// decodes a call with its own schema, so a hidden parameter passed anyway
// reaches it unchanged.
import { Schema } from "effect"
import { $ZodType, toJSONSchema } from "zod/v4/core"

type Json = Record<string, unknown>

export interface ToolParameter {
  readonly name: string
  /** A short TypeScript-like summary of the parameter's type. */
  readonly type: string
  readonly required: boolean
  /** The parameter's own description; empty when it has none. */
  readonly description: string
}

/** One parameter as a session sees it: its description, or switched off. */
export interface ParamPlan {
  readonly name: string
  readonly enabled: boolean
  readonly text: string
}

const byInput = new WeakMap<object, readonly ToolParameter[]>()

/** The tool's parameters, in schema order. Computed once per input schema object. */
export function toolParameters(input: unknown): readonly ToolParameter[] {
  // An Effect Schema can be a function object.
  if (input === null || (typeof input !== "object" && typeof input !== "function")) return []
  const cached = byInput.get(input)
  if (cached !== undefined) return cached
  const root = jsonSchemaOf(input)
  const holder = root === undefined ? undefined : deref(root, root)
  const properties = (holder?.properties ?? {}) as Json
  const required = new Set(Array.isArray(holder?.required) ? holder.required.filter((key) => typeof key === "string") : [])
  const parameters = Object.entries(properties).map(([name, node]): ToolParameter => {
    const own = node !== null && typeof node === "object" ? (node as Json) : {}
    const target = root === undefined ? undefined : deref(root, own)
    const description = typeof own.description === "string" ? own.description : typeof target?.description === "string" ? target.description : ""
    return { name, type: root === undefined ? "any" : typeOf(root, own), required: required.has(name), description }
  })
  byInput.set(input, parameters)
  return parameters
}

/**
 * The schema with the session's parameter edits, as a new object (the
 * original is shared and never mutated); the same object when nothing applies.
 */
export function editInputSchema<T>(schema: T, plans: readonly ParamPlan[]): T {
  if (schema === null || typeof schema !== "object") return schema
  const properties = (schema as Json).properties
  if (properties === null || typeof properties !== "object") return schema
  const applicable = plans.filter((plan) => Object.hasOwn(properties, plan.name))
  if (applicable.length === 0) return schema
  const next: Json = { ...(schema as Json), properties: { ...(properties as Json) } }
  const nextProperties = next.properties as Json
  for (const plan of applicable) {
    if (!plan.enabled) {
      delete nextProperties[plan.name]
      if (Array.isArray(next.required)) next.required = next.required.filter((key) => key !== plan.name)
      continue
    }
    const current = nextProperties[plan.name]
    const node: Json = current !== null && typeof current === "object" ? { ...(current as Json) } : {}
    if (plan.text === "") delete node.description
    else node.description = plan.text
    nextProperties[plan.name] = node
  }
  return next as T
}

// The JSON Schema of a tool input: an Effect Schema, a Standard Schema with a
// JSON Schema (zod), or JSON Schema already (MCP tools).
function jsonSchemaOf(input: object): Json | undefined {
  if (Schema.isSchema(input)) {
    const document = Schema.toJsonSchemaDocument(input as Schema.Top)
    return Object.keys(document.definitions).length === 0
      ? (document.schema as Json)
      : { ...(document.schema as Json), $defs: document.definitions }
  }
  const standard = (input as { readonly "~standard"?: { readonly jsonSchema?: { readonly input?: (options: object) => unknown } } })["~standard"]
  if (standard !== undefined) {
    if (standard.jsonSchema?.input !== undefined) return standard.jsonSchema.input({ target: "draft-2020-12" }) as Json
    if (input instanceof $ZodType) return toJSONSchema(input, { target: "draft-2020-12", io: "input" }) as Json
    return undefined
  }
  return input as Json
}

function deref(root: Json, node: unknown, depth = 0): Json | undefined {
  if (node === null || typeof node !== "object") return undefined
  const ref = (node as Json).$ref
  if (typeof ref !== "string" || depth > 16) return node as Json
  const match = /^#\/(\$defs|definitions)\/(.+)$/.exec(ref)
  const defs = match === null ? undefined : (root[match[1] ?? ""] as Json | undefined)
  return deref(root, defs?.[match?.[2] ?? ""], depth + 1)
}

function typeOf(root: Json, node: unknown, depth = 0): string {
  const target = deref(root, node)
  if (target === undefined || depth > 4) return "any"
  if (target.const !== undefined) return JSON.stringify(target.const)
  if (Array.isArray(target.enum)) {
    const shown = target.enum.slice(0, 4).map((value) => JSON.stringify(value))
    return target.enum.length > 4 ? `${shown.join(" | ")} | …` : shown.join(" | ")
  }
  const branches = [target.anyOf, target.oneOf].find(Array.isArray) as unknown[] | undefined
  if (branches !== undefined) {
    const parts = [...new Set(branches.flatMap((branch) => typeOf(root, branch, depth + 1).split(" | ")))]
    // Effect encodes a number as number or the strings "Infinity", "-Infinity", "NaN": say number.
    const numeric = parts.includes("number") || parts.includes("integer")
    return parts.filter((part) => !numeric || !nonFinite.has(part)).join(" | ")
  }
  const types = Array.isArray(target.type) ? target.type.filter((entry) => typeof entry === "string") : typeof target.type === "string" ? [target.type] : []
  return types.length === 0 ? "any" : types.map((type) => (type === "array" ? arrayOf(root, target, depth) : type)).join(" | ")
}

const nonFinite = new Set([`"Infinity"`, `"-Infinity"`, `"NaN"`])

function arrayOf(root: Json, node: Json, depth: number) {
  if (node.items === undefined) return "array"
  const item = typeOf(root, node.items, depth + 1)
  return item.includes(" | ") ? `(${item})[]` : `${item}[]`
}
