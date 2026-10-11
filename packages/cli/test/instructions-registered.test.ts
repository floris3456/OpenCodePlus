import { expect, test } from "bun:test"
import { Effect } from "effect"
import path from "node:path"
import fs from "node:fs/promises"
import os from "node:os"
import { activate, createHandlers, createState, deactivate } from "../../plus/src/index.js"
import { agentInfo, fullContext } from "../../plus/test/harness.js"
import { parseInstructionsArgs, runInstructionsCommand, type OpDescriptor } from "../src/commands/handlers/instructions"

test("serialized registered instruction schemas drive CLI coercion and real dispatch", async () => {
  const directory = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "cli-registered-"))
  const prior = process.env.OPENCODE_CONFIG_DIR
  process.env.OPENCODE_CONFIG_DIR = path.join(directory, "config")
  const protectedFile = path.join(directory, "project", ".opencodeplus", "project.json")
  await Bun.write(protectedFile, JSON.stringify({ version: 1, protectedAgents: ["alpha"] }))
  const before = await Bun.file(protectedFile).text()
  const ctx = fullContext({
    directory: path.join(directory, "project"),
    agents: [agentInfo("alpha", "upstream role")],
    tools: [{ id: "reader", description: "read things", options: { codemode: false } }],
    session: { hook: () => Effect.succeed({ dispose: Effect.void }) },
  })
  const state = createState()
  await Effect.runPromise(activate(ctx, state))
  const handlers = createHandlers(ctx, state)
  const rpcContext = {
    error: (...args: unknown[]): never => {
      throw new Error(args.join(": "))
    },
  }
  const io = { readFile: async () => "file body", readStdin: async () => "stdin body" }
  try {
    // JSON round-trip is the wire boundary, not a hand-authored approximation.
    const ops: OpDescriptor[] = JSON.parse(
      JSON.stringify(await Effect.runPromise(handlers["instructions.ops"](undefined, rpcContext))),
    ).ops
    const parse = (args: string[]) => parseInstructionsArgs(args, ops, io)
    const fields = [
      "compactWarm",
      "coldCompact",
      "coldModels",
      "compactionStrategy",
      "compactionModel",
      "compactionInstructions",
    ]
    expect(await parse(["set", "row", ...fields.flatMap((field) => [`--${field}`, "null"])])).toEqual({
      kind: "run",
      op: "set",
      input: { id: "row", ...Object.fromEntries(fields.map((field) => [field, null])) },
    })
    expect(
      await parse(["set", "row", "--coldModels", "one,two", "--coldModels=three", "--requires", "", "--pin=false"]),
    ).toEqual({
      kind: "run",
      op: "set",
      input: { id: "row", coldModels: ["one", "two", "three"], requires: [], pin: false },
    })
    expect(
      await parse([
        "set",
        "row",
        "--requires=null",
        "--compactWarm=off",
        "--coldCompact=on",
        "--compactionStrategy=summary",
        "--compactionModel=provider/model",
        "--compactionInstructions=keep facts",
      ]),
    ).toEqual({
      kind: "run",
      op: "set",
      input: {
        id: "row",
        requires: null,
        compactWarm: "off",
        coldCompact: "on",
        compactionStrategy: "summary",
        compactionModel: "provider/model",
        compactionInstructions: "keep facts",
      },
    })
    expect(await parse(["list", "--limit", "2.5", "--offset=1"])).toEqual({
      kind: "run",
      op: "list",
      input: { limit: 2.5, offset: 1 },
    })
    expect(await parse(["move", "row", "--into", "folder", "--before", "first", "--after=last"])).toEqual({
      kind: "run",
      op: "move",
      input: { id: "row", into: "folder", before: "first", after: "last" },
    })
    expect(await parse(["link", "row", "--target", "other", "--enabled=false", "--type", "shownWhenOff"])).toEqual({
      kind: "run",
      op: "link",
      input: { id: "row", target: "other", enabled: false, type: "shownWhenOff" },
    })
    for (const [args, text] of [
      [["--json", '{"text":"json"}', "--text", "literal"], "literal"],
      [["--text-file", "note.md"], "file body"],
      [["--text", "-"], "stdin body"],
    ] as const)
      expect(await parse(["set", "row", ...args])).toEqual({ kind: "run", op: "set", input: { id: "row", text } })
    const runs: unknown[] = []
    const deps = {
      ...io,
      productNamespace: "opencodeplus",
      binaryName: "opencodeplus",
      ops: async () => ops,
      serverVersion: async () => "fixture",
      run: async (op: string, input: Record<string, unknown>) => {
        runs.push({ op, input })
        return Effect.runPromise(handlers["instructions.run"]({ op, input }, rpcContext))
      },
    }
    for (const args of [
      ["set", "row", "--bogus", "x"],
      ["set", "row", "--pin=maybe"],
      ["list", "--limit=many"],
    ]) {
      expect((await runInstructionsCommand(args, deps)).exitCode).toBe(2)
    }
    expect(runs).toEqual([])
    // Enum validation belongs to the registered server schema.
    expect((await runInstructionsCommand(["link", "row", "--target", "other", "--type", "oneway"], deps)).exitCode).toBe(2)
    expect((await runInstructionsCommand(["set", "row", "--state=invalid"], deps)).exitCode).toBe(2)
    expect((await runInstructionsCommand(["list", "--limit=5"], deps)).exitCode).toBe(0)
    const listed = JSON.parse((await runInstructionsCommand(["list", "--limit=6082"], deps)).stdout) as {
      rows: Array<{ id: string }>
    }
    const id = listed.rows.find((row) => row.id.includes("tool:reader"))?.id
    if (id === undefined) throw new Error("fixture has no reader row")
    const refused = await runInstructionsCommand(["set", id, "--text", "blocked"], deps)
    expect(refused.exitCode).toBe(1)
    expect(refused.stderr).toContain("agent.protected")
    expect(await Bun.file(protectedFile).text()).toBe(before)
    expect(JSON.parse((await runInstructionsCommand(["log"], deps)).stdout).entries).toEqual([])
  } finally {
    await Effect.runPromise(deactivate(state))
    if (prior === undefined) delete process.env.OPENCODE_CONFIG_DIR
    else process.env.OPENCODE_CONFIG_DIR = prior
    await fs.rm(directory, { recursive: true, force: true })
  }
})
