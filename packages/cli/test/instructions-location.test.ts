// Real-boundary tests for the `opencodeplus instructions …` CLI lane: the
// production request must carry the caller's working directory as its
// `location`, proven by running the real launcher as a subprocess against an
// owned HTTP capture fixture (no provider, no live service). This is not a
// duplicate of the transport code: the assertion is on the bytes emitted by the
// real `plus.ts` process after the launcher's restore-cwd preload.

import { describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { OPENCODE_VERSION } from "../src/version"

const repoRoot = path.resolve(import.meta.dirname, "../../..")
const launcher = path.join(repoRoot, "packages/plus/bin/opencodeplus")

interface SeenRequest {
  readonly method: string
  readonly pathname: string
  readonly location: string | null
}

interface Capture {
  readonly requests: SeenRequest[]
  readonly url: string
  readonly stop: () => void
}

// Serves the V2 health probe plus the two instructions RPC methods, recording
// the `location[directory]` query of every request. The response version matches
// the source run so the explicit-server health check does not warn. `runResult`
// overrides the `instructions.run` output so refusal/usage exits can be driven
// through the real subprocess.
function capture(runResult: (input: { op: string; input: Record<string, unknown> }) => unknown = () => ({ ok: true })): Capture {
  const requests: SeenRequest[] = []
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      requests.push({
        method: request.method,
        pathname: url.pathname,
        location: url.searchParams.get("location[directory]"),
      })
      if (url.pathname === "/api/info")
        return Response.json({ version: OPENCODE_VERSION, pid: process.pid, urls: [], paths: { tmp: os.tmpdir() } })
      if (url.pathname === "/api/rpc/opencode.plus/instructions.ops")
        return Response.json({
          output: {
            ops: [
              { op: "show", description: "Read one row.", input: { type: "object", properties: { id: { type: "string" } }, required: ["id"] } },
            ],
          },
        })
      if (url.pathname === "/api/rpc/opencode.plus/instructions.run") {
        const body = (await request.json()) as { input: { op: string; input: Record<string, unknown> } }
        return Response.json({ output: runResult(body.input) })
      }
      return new Response(null, { status: 404 })
    },
  })
  return { requests, url: server.url.toString(), stop: () => server.stop(true) }
}

async function tempRoot(): Promise<string> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  await fs.mkdir(parent, { recursive: true })
  return fs.mkdtemp(path.join(parent, "plus-cli-loc-"))
}

async function cli(caller: string, args: string[], env: Record<string, string> = {}) {
  const home = await tempRoot()
  const child = Bun.spawn([launcher, ...args], {
    cwd: caller,
    env: {
      ...process.env,
      PWD: caller,
      PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}`,
      OPENCODE_PRODUCT: "opencodeplus",
      XDG_DATA_HOME: path.join(home, "data"),
      XDG_CONFIG_HOME: path.join(home, "config"),
      XDG_CACHE_HOME: path.join(home, "cache"),
      XDG_STATE_HOME: path.join(home, "state"),
      ...env,
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { stdout, stderr, exitCode, home }
}

describe("instructions CLI emits the caller location", () => {
  test("two caller directories each get their own request location", async () => {
    const fixture = capture()
    try {
      const first = await fs.mkdtemp(path.join(await tempRoot(), "one-"))
      const second = await fs.mkdtemp(path.join(await tempRoot(), "two-"))

      const a = await cli(first, ["instructions", "--server", fixture.url, "show", "abc"])
      const b = await cli(second, ["instructions", "--server", fixture.url, "show", "abc"])

      expect({ a: a.exitCode, b: b.exitCode }).toEqual({ a: 0, b: 0 })
      expect(JSON.parse(a.stdout)).toEqual({ ok: true })

      const ops = fixture.requests.filter((request) => request.pathname.endsWith("/instructions.ops"))
      const runs = fixture.requests.filter((request) => request.pathname.endsWith("/instructions.run"))
      // Both methods carry the location, and each caller's own directory.
      expect(ops.map((request) => request.location)).toEqual([first, second])
      expect(runs.map((request) => request.location)).toEqual([first, second])
      expect(first).not.toBe(second)
    } finally {
      fixture.stop()
    }
  })

  test("a missing --server refuses with no discovery and zero network", async () => {
    const fixture = capture()
    try {
      const caller = await fs.mkdtemp(path.join(await tempRoot(), "caller-"))
      const home = await tempRoot()
      // A healthy registration for the capture fixture, so a swallowed
      // missing-endpoint bug would discover it and contact the fixture.
      const state = path.join(home, "state", "opencodeplus")
      await fs.mkdir(state, { recursive: true })
      await fs.writeFile(
        path.join(state, "service.json"),
        JSON.stringify({ version: OPENCODE_VERSION, url: fixture.url, pid: process.pid }),
      )

      const result = await cli(caller, ["instructions", "list", "--server"], {
        XDG_STATE_HOME: path.join(home, "state"),
      })

      expect(result.exitCode).toBe(2)
      expect(result.stderr).toContain("Option --server expects a value.")
      // Refusal happens before any discovery: the poisoned registration is
      // never probed and the fixture is never contacted.
      expect(fixture.requests).toEqual([])
    } finally {
      fixture.stop()
    }
  })

  test("success, refusal and usage exits are unchanged through the real CLI", async () => {
    const success = capture()
    const refused = capture(() => ({ error: { message: "row.unknown: no such row" } }))
    const usage = capture(() => ({ error: { message: "Invalid arguments for show", usage: true } }))
    try {
      const caller = await fs.mkdtemp(path.join(await tempRoot(), "caller-"))
      const ok = await cli(caller, ["instructions", "--server", success.url, "show", "abc"])
      const opRefusal = await cli(caller, ["instructions", "--server", refused.url, "show", "nope"])
      const usageRefusal = await cli(caller, ["instructions", "--server", usage.url, "show", "abc"])
      // A parser usage error never reaches the service.
      const parseError = await cli(caller, ["instructions", "--server", success.url, "bogus"])

      expect({ ok: ok.exitCode, refusal: opRefusal.exitCode, usage: usageRefusal.exitCode, parse: parseError.exitCode }).toEqual({
        ok: 0,
        refusal: 1,
        usage: 2,
        parse: 2,
      })
      expect(opRefusal.stderr).toContain("row.unknown: no such row")
      expect(usageRefusal.stderr).toContain("Invalid arguments for show")
      expect(parseError.stderr).toContain('Unknown op "bogus"')
      expect(success.requests.some((request) => request.pathname.endsWith("/instructions.run"))).toBe(true)
    } finally {
      success.stop()
      refused.stop()
      usage.stop()
    }
  })
})
