import { expect, test } from "bun:test"
import { Agent } from "@opencode/schema/agent"
import { Location } from "@opencode/schema/location"
import { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import { AbsolutePath } from "@opencode/schema/schema"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  DEFAULT_PASSWORD_ENV,
  delegateThroughHost,
  defaultParentRunID,
  fetchParentSession,
  hostBridge,
  labToolContext,
  parseArgs,
  resolveLabTargets,
  seedParentRun,
  usage,
  validateLabTarget,
  type LabToolContext,
} from "../docs/round3-delegate.js"
import { git } from "../src/teams/git.js"
import { loadRun } from "../src/teams/run.js"
import { Brief } from "../src/teams/schema.js"

const FIXTURE_PASSWORD = "fixture-password-not-a-secret"

interface FixtureRequest {
  readonly method: string
  readonly path: string
  readonly auth: string | null
  readonly body: unknown
}

interface FixtureHost {
  readonly port: number
  readonly requests: FixtureRequest[]
  stop(): void
}

// A loopback HTTP fixture for the documented session routes. It is a fixture,
// not a lab host and not a model transport: it records exactly what the bridge
// sent, so the transport can be inspected without the lab.
function fixtureHost(directories: Record<string, string> = {}): FixtureHost {
  const requests: FixtureRequest[] = []
  const sessions = new Map<string, string>(Object.entries(directories))
  let created = 0
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    async fetch(request) {
      const url = new URL(request.url)
      const requestPath = `${url.pathname}${url.search}`
      const text = await request.text()
      const body = text === "" ? undefined : JSON.parse(text)
      requests.push({ method: request.method, path: requestPath, auth: request.headers.get("authorization"), body })
      const sessionID = url.pathname.startsWith("/api/session/")
        ? decodeURIComponent(url.pathname.slice("/api/session/".length).split("/")[0] ?? "")
        : ""
      if (request.method === "POST" && url.pathname === "/api/session") {
        created += 1
        const id = `ses_fixture_${created}`
        const location = (body as { location?: { directory?: string } } | undefined)?.location
        sessions.set(id, location?.directory ?? "/fixture")
        return Response.json({ data: { id, location: { directory: sessions.get(id) } } })
      }
      if (request.method === "GET" && url.pathname === `/api/session/${sessionID}`) {
        const directory = sessions.get(sessionID)
        if (directory === undefined) return new Response("unknown session", { status: 404 })
        return Response.json({ data: { id: sessionID, location: { directory } } })
      }
      if (request.method === "POST" && url.pathname === `/api/session/${sessionID}/interrupt`) {
        return Response.json({ interrupted: true })
      }
      if (request.method === "POST" && url.pathname === `/api/session/${sessionID}/generate`) {
        return Response.json({ data: { text: "fixture" } })
      }
      if (request.method === "GET" && url.pathname === `/api/session/${sessionID}/context`) {
        return Response.json({ data: [] })
      }
      if (request.method === "POST" && url.pathname === `/api/session/${sessionID}/prompt`) {
        return Response.json({ data: { id: "msg_fixture", sessionID, type: "user", timeCreated: Date.now() } })
      }
      if (request.method === "POST" && url.pathname.startsWith(`/api/session/${sessionID}/`)) {
        return new Response(null, { status: 204 })
      }
      return new Response("not found", { status: 404 })
    },
  })
  const port = server.port
  if (port === undefined) throw new Error("fixture server did not bind a port")
  return {
    port,
    requests,
    stop: () => {
      server.stop(true)
    },
  }
}

async function makeRepo(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "round3-delegate-repo-"))
  await git(dir, ["init"])
  await git(dir, ["config", "user.name", "round3-driver-test"])
  await git(dir, ["config", "user.email", "round3-driver-test@local"])
  await fs.writeFile(path.join(dir, "README.md"), "# round3 delegate driver test\n")
  await git(dir, ["add", "README.md"])
  await git(dir, ["commit", "-m", "feat: initial commit"])
  return dir
}

test("lab target validation refuses the human server, non-loopback hosts and non-lab homes", async () => {
  const labHome = "/home/bliss/OpenCodePlus/run/tmp-build/tui-lab-selfcheck"
  expect(() => validateLabTarget({ labHome, baseUrl: "http://127.0.0.1:40374" })).toThrow("40374")
  expect(() => validateLabTarget({ labHome: "/home/bliss/OpenCodePlus/run/plus", baseUrl: "http://127.0.0.1:51000" })).toThrow(
    "tmp-build",
  )
  expect(() => validateLabTarget({ labHome, baseUrl: "http://192.168.1.9:51000" })).toThrow("loopback")
  expect(() => validateLabTarget({ labHome, baseUrl: "http://127.0.0.1" })).toThrow("port")
  expect(() => validateLabTarget({ labHome, baseUrl: "http://user:secret@127.0.0.1:51000" })).toThrow("credentials")
  const targets = validateLabTarget({ labHome, baseUrl: "http://127.0.0.1:51000/" })
  expect(targets.baseUrl).toBe("http://127.0.0.1:51000")
  expect(targets.teamsRoot).toBe(path.join(labHome, "data", "opencode", "opencodeplus", "teams"))
  await expect(resolveLabTargets({ labHome, baseUrl: "http://127.0.0.1:51000" })).rejects.toThrow("does not exist")
})

test("the CLI documents the exact command and keeps the password out of arguments", () => {
  const text = usage()
  expect(text).toContain("--lab-home")
  expect(text).toContain("--base-url")
  expect(text).toContain("--parent-session")
  expect(text).toContain("--brief")
  expect(text).toContain("40374")
  expect(text).toContain(DEFAULT_PASSWORD_ENV)
  const args = parseArgs(["--lab-home", "/lab", "--brief", "-", "--model", "lab/fixture", "--seed-only"])
  expect(args.labHome).toBe("/lab")
  expect(args.brief).toBe("-")
  expect(args.model).toBe("lab/fixture")
  expect(args.seedOnly).toBe(true)
  expect(args.password).toBeUndefined()
  expect(args.passwordEnv).toBe(DEFAULT_PASSWORD_ENV)
  expect(() => parseArgs(["--nope"])).toThrow("unknown flag")
})

test("hostBridge speaks the documented session routes with basic auth", async () => {
  const host = fixtureHost()
  try {
    const bridge = hostBridge({ baseUrl: `http://127.0.0.1:${host.port}`, password: FIXTURE_PASSWORD })
    const created = await Effect.runPromise(
      bridge.domain.create({
        agent: Agent.ID.make("muse-implementer"),
        location: Location.Ref.make({ directory: AbsolutePath.make("/fixture/child") }),
      }),
    )
    expect(String(created.id)).toBe("ses_fixture_1")
    await Effect.runPromise(bridge.domain.prompt({ sessionID: created.id, text: "do the thing" }))
    await Effect.runPromise(
      bridge.domain.switchModel({
        sessionID: created.id,
        model: Model.Ref.make({ providerID: Provider.ID.make("lab"), id: Model.ID.make("fixture") }),
      }),
    )
    await Effect.runPromise(bridge.domain.wait({ sessionID: created.id }))
    const interrupted = await Effect.runPromise(bridge.domain.interrupt({ sessionID: created.id, continue: true }))
    expect(interrupted.interrupted).toBe(true)
    const got = await Effect.runPromise(bridge.domain.get({ sessionID: Session.ID.make("ses_fixture_1") }))
    expect(String(got.id)).toBe("ses_fixture_1")

    expect(host.requests.map((entry) => `${entry.method} ${entry.path}`)).toEqual([
      "POST /api/session",
      "POST /api/session/ses_fixture_1/prompt",
      "POST /api/session/ses_fixture_1/model",
      "POST /api/session/ses_fixture_1/wait",
      "POST /api/session/ses_fixture_1/interrupt?continue=true",
      "GET /api/session/ses_fixture_1",
    ])
    const expectedAuth = `Basic ${Buffer.from(`opencode:${FIXTURE_PASSWORD}`, "utf8").toString("base64")}`
    expect(host.requests.every((entry) => entry.auth === expectedAuth)).toBe(true)
    const create = host.requests[0]?.body as { agent?: string; location?: { directory?: string } }
    expect(create.agent).toBe("muse-implementer")
    expect(create.location?.directory).toBe("/fixture/child")
  } finally {
    host.stop()
  }
})

test("delegateThroughHost creates the child through the real handler over the host bridge", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "round3-delegate-"))
  const repoDir = await makeRepo()
  const prior = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = tmp
  const host = fixtureHost({ ses_parent_fixture: repoDir })
  let lab: LabToolContext | undefined
  try {
    const root = path.join(tmp, "opencode", "opencodeplus", "teams")
    const bridge = hostBridge({ baseUrl: `http://127.0.0.1:${host.port}`, password: FIXTURE_PASSWORD })
    const parentSession = await fetchParentSession(bridge, "ses_parent_fixture")
    expect(String(parentSession.location.directory)).toBe(repoDir)

    const parentRunID = defaultParentRunID("ses_parent_fixture")
    const seeded = await seedParentRun({
      root,
      id: parentRunID,
      role: "opus-orchestrator",
      sessionID: "ses_parent_fixture",
      directory: repoDir,
    })
    expect(seeded.state).toBe("working")
    expect((await loadRun(root, parentRunID))?.sessionID).toBe("ses_parent_fixture")

    lab = await labToolContext({ directory: repoDir, session: bridge.domain })
    expect(lab.tools.has("team_delegate")).toBe(true)
    lab.state.activeModels.set("muse-implementer", { providerID: "lab", modelID: "fixture" })

    const brief = Schema.decodeUnknownSync(Brief)({
      requestID: "round3-delegate-selfcheck",
      role: "muse-implementer",
      objective: "Create the lab child through the real delegate handler and host bridge.",
      deliverable: { kind: "commit" },
      scope: { paths: ["packages/plus/docs/*"] },
      checks: [],
    })
    const outcome = await delegateThroughHost({
      lab,
      brief,
      parent: { sessionID: "ses_parent_fixture", role: "opus-orchestrator", callID: "call_round3_selfcheck" },
    })
    expect(outcome.via).toBe("team.delegate")

    const output = outcome.output as { run: string; session: string; directory: string; briefPath: string }
    const child = await loadRun(root, output.run)
    expect(child?.parent).toBe(parentRunID)
    expect(child?.sessionID).toBe(output.session)
    expect(child?.role).toBe("muse-implementer")
    expect(child?.directory).toBe(output.directory)
    expect(child?.directory.startsWith(path.join(root, "worktrees"))).toBe(true)
    expect((await fs.stat(output.directory)).isDirectory()).toBe(true)
    expect(await Bun.file(output.briefPath).exists()).toBe(true)
    expect(output.briefPath).toBe(path.join(root, "runs", output.run, "brief.md"))
    expect(await Bun.file(path.join(output.directory, ".git")).exists()).toBe(true)
    expect((await loadRun(root, parentRunID))?.children).toContain(output.run)

    // The host bridge carried the Location the real handler made for the child,
    // and delivered the rendered brief to the child session.
    const createCall = host.requests.find((entry) => entry.method === "POST" && entry.path === "/api/session")
    expect((createCall?.body as { agent?: string }).agent).toBe("muse-implementer")
    expect((createCall?.body as { location?: { directory?: string } }).location?.directory).toBe(output.directory)
    const promptCall = host.requests.find((entry) => entry.path === `/api/session/${output.session}/prompt`)
    expect((promptCall?.body as { text?: string }).text).toContain("Create the lab child through the real delegate handler")
    // The pinned role model reaches the child through the bridge's switchModel seam.
    const modelCall = host.requests.find((entry) => entry.path === `/api/session/${output.session}/model`)
    expect(modelCall?.body).toMatchObject({ model: { providerID: "lab", id: "fixture" } })
    expect(host.requests.some((entry) => entry.method === "GET" && entry.path === "/api/session/ses_parent_fixture")).toBe(
      true,
    )
  } finally {
    await lab?.dispose()
    host.stop()
    if (prior === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prior
    await fs.rm(tmp, { recursive: true, force: true })
    await fs.rm(repoDir, { recursive: true, force: true })
  }
}, 30000)