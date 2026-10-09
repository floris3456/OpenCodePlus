import { OpenCode } from "@opencode/client"
import { describe, expect, test } from "bun:test"
import { Definition } from "../../plus/src/rpc.js"
import {
  formatOpHelp,
  formatOpsHelp,
  instructionsInvocation,
  parseInstructionsArgs,
  runInstructionsCommand,
  type InstructionDeps,
  type OpDescriptor,
} from "../src/commands/handlers/instructions"

const ops: OpDescriptor[] = [
  {
    op: "show",
    description: "Read one row.",
    input: {
      type: "object",
      properties: {
        id: { type: "string", description: "Row id" },
        view: { type: "string", description: "Which view" },
      },
      required: ["id"],
    },
  },
  {
    op: "set",
    description: "Save an override.",
    input: {
      type: "object",
      properties: {
        id: { type: "string" },
        text: { type: "string" },
        limit: { type: "number" },
        count: { type: "integer" },
        state: { type: "string" },
        active: { type: "boolean" },
        tags: { type: "array", items: { type: "string" } },
        levels: { type: "array", items: { type: "integer" } },
        preset: { type: ["string", "null"] },
        config: { type: "object" },
      },
      required: ["id"],
    },
  },
  {
    op: "list",
    description: "Filter rows.",
    input: { type: "object", properties: { limit: { type: "number" } } },
  },
]

const io = {
  readFile: async (path: string) => `file:${path}`,
  readStdin: async () => "from-stdin",
}

function depsFor(server: string, overrides?: Partial<InstructionDeps>): InstructionDeps {
  const client = OpenCode.make({ baseUrl: server, headers: {} })
  const plus = client.rpc(Definition)
  return {
    productNamespace: "opencodeplus",
    binaryName: "opencodeplus",
    readFile: io.readFile,
    readStdin: io.readStdin,
    ops: () => plus["instructions.ops"](undefined).then((output) => output.ops),
    run: (op, input) => plus["instructions.run"]({ op, input }) as Promise<unknown>,
    serverVersion: async () => "9.9.9-test",
    ...overrides,
  }
}

interface StubSeen {
  runs: Array<{ op: string; input: unknown }>
}

function serve(handler: (request: Request) => Response | Promise<Response>) {
  return Bun.serve({ port: 0, fetch: handler })
}

function opsStub(seen: StubSeen, result?: (op: string, input: unknown) => unknown) {
  return serve(async (request: Request) => {
    const url = new URL(request.url)
    if (request.method === "POST" && url.pathname === "/api/rpc/opencode.plus/instructions.ops")
      return Response.json({ output: { ops } })
    if (request.method === "POST" && url.pathname === "/api/rpc/opencode.plus/instructions.run") {
      const body = (await request.json()) as { input: { op: string; input: unknown } }
      seen.runs.push({ op: body.input.op, input: body.input.input })
      return Response.json({ output: result?.(body.input.op, body.input.input) ?? { ok: true } })
    }
    return new Response(null, { status: 404 })
  })
}

describe("instructions flag mapping", () => {
  test("maps string, number, integer and boolean flags by schema type", async () => {
    const seen: StubSeen = { runs: [] }
    const server = opsStub(seen)
    try {
      const result = await runInstructionsCommand(
        ["set", "abc", "--text", "hi", "--limit", "2.5", "--count", "3", "--active"],
        depsFor(server.url.toString()),
      )
      expect(result.exitCode).toBe(0)
      expect(seen.runs).toEqual([
        { op: "set", input: { id: "abc", text: "hi", limit: 2.5, count: 3, active: true } },
      ])
    } finally {
      server.stop(true)
    }
  })

  test("supports --flag value, --flag=value and repeated comma-list arrays", async () => {
    const seen: StubSeen = { runs: [] }
    const server = opsStub(seen)
    try {
      const result = await runInstructionsCommand(
        ["set", "--id", "abc", "--tags", "a,b", "--tags", "c", "--levels=1,2", "--active", "false"],
        depsFor(server.url.toString()),
      )
      expect(result.exitCode).toBe(0)
      expect(seen.runs).toEqual([
        { op: "set", input: { id: "abc", tags: ["a", "b", "c"], levels: [1, 2], active: false } },
      ])
    } finally {
      server.stop(true)
    }
  })

  test("merges --json under explicit flags and fills text from file or stdin", async () => {
    const seen: StubSeen = { runs: [] }
    const server = opsStub(seen)
    try {
      const merged = await runInstructionsCommand(
        ["set", "abc", "--json", '{"text":"json","limit":1}', "--limit", "9"],
        depsFor(server.url.toString()),
      )
      expect(merged.exitCode).toBe(0)
      expect(seen.runs[0]).toEqual({ op: "set", input: { id: "abc", text: "json", limit: 9 } })
      const stdin = await runInstructionsCommand(
        ["set", "abc", "--text", "-"],
        depsFor(server.url.toString()),
      )
      expect(stdin.exitCode).toBe(0)
      expect(seen.runs[1]).toEqual({ op: "set", input: { id: "abc", text: "from-stdin" } })
      const file = await runInstructionsCommand(
        ["set", "abc", "--text-file", "note.md"],
        depsFor(server.url.toString()),
      )
      expect(file.exitCode).toBe(0)
      expect(seen.runs[2]).toEqual({ op: "set", input: { id: "abc", text: "file:note.md" } })
    } finally {
      server.stop(true)
    }
  })

  test("passes literal null for nullable params and refuses objects outside --json", async () => {
    const nulled = await parseInstructionsArgs(["set", "abc", "--preset", "null"], ops, io)
    expect(nulled).toEqual({ kind: "run", op: "set", input: { id: "abc", preset: null } })
    const object = await parseInstructionsArgs(["set", "abc", "--config", "x"], ops, io)
    expect(object.kind).toBe("usage-error")
    expect(object.kind === "usage-error" ? object.message : "").toContain("--json")
  })
})

describe("instructions help and exit codes", () => {
  test("bare run lists ops and <op> --help lists its params from the schema", async () => {
    const seen: StubSeen = { runs: [] }
    const server = opsStub(seen)
    try {
      const deps = depsFor(server.url.toString())
      const listed = await runInstructionsCommand([], deps)
      expect(listed.exitCode).toBe(0)
      expect(listed.stdout).toContain("show")
      expect(listed.stdout).toContain("Read one row.")
      const helped = await runInstructionsCommand(["show", "--help"], deps)
      expect(helped.exitCode).toBe(0)
      expect(helped.stdout).toContain("--id string (required)")
      expect(helped.stdout).toContain("Row id")
      expect(helped.stdout).toContain("--view string")
      expect(seen.runs).toEqual([])
    } finally {
      server.stop(true)
    }
  })

  test("prints the op result as pretty JSON on success", async () => {
    const seen: StubSeen = { runs: [] }
    const server = opsStub(seen, (op, input) => ({ op, input }))
    try {
      const result = await runInstructionsCommand(["show", "abc"], depsFor(server.url.toString()))
      expect(result.exitCode).toBe(0)
      expect(result.stderr).toBe("")
      expect(JSON.parse(result.stdout)).toEqual({ op: "show", input: { id: "abc" } })
      expect(result.stdout).toContain("\n")
    } finally {
      server.stop(true)
    }
  })

  test("exit 1 on an op refusal with the message on stderr", async () => {
    const seen: StubSeen = { runs: [] }
    const server = opsStub(seen, () => ({ error: { message: "row.unknown: no such row" } }))
    try {
      const result = await runInstructionsCommand(["show", "nope"], depsFor(server.url.toString()))
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr).toBe("row.unknown: no such row\n")
    } finally {
      server.stop(true)
    }
  })

  test("exit 2 on a usage refusal from the service", async () => {
    const seen: StubSeen = { runs: [] }
    const server = opsStub(seen, () => ({ error: { message: "Invalid arguments for show", usage: true } }))
    try {
      const result = await runInstructionsCommand(["show", "abc"], depsFor(server.url.toString()))
      expect(result.exitCode).toBe(2)
      expect(result.stdout).toBe("")
      expect(result.stderr).toBe("Invalid arguments for show\n")
    } finally {
      server.stop(true)
    }
  })

  test("exit 2 on usage errors", async () => {
    const parsed = await parseInstructionsArgs(["show"], ops, io)
    expect(parsed.kind).toBe("usage-error")
    const cases: string[][] = [
      ["show"],
      ["show", "a", "b"],
      ["nope"],
      ["show", "abc", "--bogus", "1"],
      ["show", "abc", "--view"],
      ["list", "abc"],
      ["set", "abc", "--limit", "many"],
      ["set", "abc", "--active", "maybe"],
      ["set", "abc", "--json", "[1]"],
      ["set", "--id", "abc", "--json", "{oops"],
    ]
    for (const argv of cases) {
      const outcome = await parseInstructionsArgs(argv, ops, io)
      expect(outcome.kind).toBe("usage-error")
    }
    const seen: StubSeen = { runs: [] }
    const server = opsStub(seen)
    try {
      const result = await runInstructionsCommand(["nope"], depsFor(server.url.toString()))
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain('Unknown op "nope" (known: list, set, show)')
      expect(seen.runs).toEqual([])
    } finally {
      server.stop(true)
    }
  })

  test("old service names its version and suggests a replacement", async () => {
    const server = serve((request: Request) => {
      if (new URL(request.url).pathname === "/api/rpc/opencode.plus/instructions.ops")
        return Response.json(
          { _tag: "RpcError", type: "rpc.method_not_found", message: "Unknown RPC method" },
          { status: 400 },
        )
      return new Response(null, { status: 404 })
    })
    try {
      const result = await runInstructionsCommand(["show", "abc"], depsFor(server.url.toString()))
      expect(result.exitCode).toBe(1)
      expect(result.stdout).toBe("")
      expect(result.stderr).toBe(
        "The running service (9.9.9-test) predates this command; start opencodeplus to replace it.\n",
      )
    } finally {
      server.stop(true)
    }
  })

  test("refuses outside the Plus product", async () => {
    const seen: StubSeen = { runs: [] }
    const server = opsStub(seen)
    try {
      const result = await runInstructionsCommand(
        ["show", "abc"],
        depsFor(server.url.toString(), { productNamespace: "opencode", binaryName: "opencode2" }),
      )
      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain("OpenCodePlus only")
      expect(seen.runs).toEqual([])
    } finally {
      server.stop(true)
    }
  })

  test("help builders render every op without service descriptions leaking structure", () => {
    const listed = formatOpsHelp(ops, "opencodeplus")
    expect(listed).toContain("Usage: opencodeplus instructions")
    for (const op of ops) expect(listed).toContain(op.op)
    const helped = formatOpHelp(ops[1]!, "opencodeplus")
    expect(helped).toContain("--tags string[]")
    expect(helped).toContain("--levels integer[]")
    expect(helped).toContain("--active boolean")
    expect(helped).toContain("A positional id fills --id.")
  })
})

describe("pre-Effect argv dispatch", () => {
  test("recognises an instructions invocation and keeps its op argv", () => {
    expect(instructionsInvocation(["bun", "plus.ts", "instructions", "list", "--where", "agent:alpha"])).toEqual({
      standalone: false,
      args: ["list", "--where", "agent:alpha"],
    })
    expect(instructionsInvocation(["bun", "plus.ts", "instructions", "show", "abc", "--view", "resolved"])).toEqual({
      standalone: false,
      args: ["show", "abc", "--view", "resolved"],
    })
  })

  test("extracts the subcommand's --server/--standalone and skips --print-logs", () => {
    expect(
      instructionsInvocation(["bun", "plus.ts", "--print-logs", "instructions", "show", "abc", "--server", "http://x"]),
    ).toEqual({ server: "http://x", standalone: false, args: ["show", "abc"] })
    expect(instructionsInvocation(["bun", "plus.ts", "instructions", "--standalone", "list"])).toEqual({
      standalone: true,
      args: ["list"],
    })
    expect(instructionsInvocation(["bun", "plus.ts", "instructions", "--server=http://y", "list"])).toEqual({
      server: "http://y",
      standalone: false,
      args: ["list"],
    })
  })

  test("leaves other commands and global help to Effect", () => {
    expect(instructionsInvocation(["bun", "plus.ts", "run", "instructions"])).toBeUndefined()
    expect(instructionsInvocation(["bun", "plus.ts", "--help"])).toBeUndefined()
    expect(instructionsInvocation(["bun", "plus.ts"])).toBeUndefined()
  })

  test("reports a missing --server value instead of swallowing it", () => {
    // A missing explicit endpoint must refuse as a usage error, never fall
    // through to managed-service discovery.
    expect(instructionsInvocation(["bun", "plus.ts", "instructions", "list", "--server"])).toEqual({
      error: "Option --server expects a value.",
      standalone: false,
      args: ["list"],
    })
    expect(instructionsInvocation(["bun", "plus.ts", "instructions", "--server=", "list"])).toEqual({
      error: "Option --server expects a value.",
      standalone: false,
      args: ["list"],
    })
    expect(instructionsInvocation(["bun", "plus.ts", "instructions", "show", "abc", "--server"])?.server).toBeUndefined()
  })

  test("keeps a flag-looking payload for the value-taking op flags", async () => {
    // `set row --text --server`: --server is the text value, not a transport
    // flag, so it must survive the pre-parser and reach the op grammar intact.
    const invocation = instructionsInvocation(["bun", "plus.ts", "instructions", "set", "row", "--text", "--server"])
    expect(invocation).toEqual({ standalone: false, args: ["set", "row", "--text", "--server"] })
    const parsed = await parseInstructionsArgs(invocation!.args, ops, io)
    expect(parsed).toEqual({ kind: "run", op: "set", input: { id: "row", text: "--server" } })

    // The same holds for --json and --text-file payloads.
    expect(instructionsInvocation(["bun", "plus.ts", "instructions", "set", "row", "--json", "--standalone"])).toEqual({
      standalone: false,
      args: ["set", "row", "--json", "--standalone"],
    })
    expect(instructionsInvocation(["bun", "plus.ts", "instructions", "set", "row", "--text-file", "--server"])).toEqual({
      standalone: false,
      args: ["set", "row", "--text-file", "--server"],
    })
  })

  test("still extracts a real --server value that follows an op flag", () => {
    // Only the bare transport flag is consumed after a value-taking op flag has
    // taken its own value: `--text hi --server http://x` keeps both.
    expect(
      instructionsInvocation(["bun", "plus.ts", "instructions", "set", "row", "--text", "hi", "--server", "http://x"]),
    ).toEqual({ server: "http://x", standalone: false, args: ["set", "row", "--text", "hi"] })
  })
})
