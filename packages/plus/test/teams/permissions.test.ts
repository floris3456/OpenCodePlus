import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Session } from "@opencode/schema/session"
import type { PermissionDomain } from "@opencode/plugin/effect/permission"
import type { PermissionEvaluation } from "@opencode/plugin/effect/permission"
import { Effect } from "effect"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { context } from "../harness.js"
import { saveRun } from "../../src/teams/run.js"
import type { RunRecord } from "../../src/teams/run.js"
import { registerTeamPermissions } from "../../src/teams/permissions.js"

let dir = ""

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "teams-permissions-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

function makeRun(overrides?: Partial<RunRecord>): RunRecord {
  const now = new Date().toISOString()
  return {
    id: "w-0000000000000001",
    role: "muse-implementer",
    kind: "w",
    repo: "opencode",
    repoKey: "opencode",
    directory: join(dir, "wt"),
    paths: ["packages/plus/src/*"],
    branch: "team/implementer/t-1",
    base: "ocp-main",
    head: "0123456789abcdef0123456789abcdef01234567",
    state: "idle",
    attempts: [],
    task: null,
    parent: null,
    children: [],
    briefSha: "abc",
    bundle: "team2-test",
    budget: {},
    createdAt: now,
    lastUsed: now,
    sessionID: Session.ID.make("ses_teampolicy001"),
    configDigest: null,
    history: [],
    ...overrides,
  }
}

function permissionHarness() {
  const state = {
    calls: 0,
    disposes: 0,
    callback: undefined as ((event: PermissionEvaluation) => Effect.Effect<void>) | undefined,
  }
  const domain = {
    list: () => Effect.die("unused permission.list"),
    get: () => Effect.die("unused permission.get"),
    reply: () => Effect.die("unused permission.reply"),
    rules: () => Effect.die("unused permission.rules"),
    hook: (name: "evaluate", callback: (event: PermissionEvaluation) => Effect.Effect<void>) => {
      state.calls += 1
      state.callback = callback
      return Effect.succeed({ dispose: Effect.sync(() => { state.disposes += 1 }) })
    },
  }
  return { state, domain }
}

function evaluation(
  sessionID: Session.ID,
  resources: string[],
  effect: PermissionEvaluation["effect"],
): PermissionEvaluation {
  return { sessionID, action: "edit", resources, effect }
}

describe("team run edit scope", () => {
  test("implementer run allows scope, denies outside and .git", async () => {
    const sessionID = Session.ID.make("ses_teampolicy001")
    const run = makeRun({ sessionID })
    await saveRun(dir, run)
    const harness = permissionHarness()
    const ctx = context({ permission: harness.domain as unknown as PermissionDomain })
    const registration = await registerTeamPermissions(ctx, dir)
    const callback = harness.state.callback
    expect(callback).toBeDefined()
    if (callback === undefined) return
    expect(harness.state.calls).toBe(1)

    const allowed = evaluation(sessionID, ["packages/plus/src/x.ts"], "ask")
    await Effect.runPromise(callback(allowed))
    expect(allowed.effect).toBe("allow")

    const outside = evaluation(sessionID, ["packages/core/x.ts"], "allow")
    await Effect.runPromise(callback(outside))
    expect(outside.effect).toBe("deny")

    const git = evaluation(sessionID, [".git/HEAD"], "allow")
    await Effect.runPromise(callback(git))
    expect(git.effect).toBe("deny")

    await Effect.runPromise(registration.dispose)
    expect(harness.state.disposes).toBe(1)
  })

  test("session with no run is untouched for allow and deny", async () => {
    const sessionID = Session.ID.make("ses_teampolicy001")
    const run = makeRun({ sessionID })
    await saveRun(dir, run)
    const harness = permissionHarness()
    const ctx = context({ permission: harness.domain as unknown as PermissionDomain })
    const registration = await registerTeamPermissions(ctx, dir)
    const callback = harness.state.callback
    expect(callback).toBeDefined()
    if (callback === undefined) return

    const missing = Session.ID.make("ses_teampolicymiss")
    const keepAllow = evaluation(missing, ["packages/plus/src/x.ts"], "allow")
    await Effect.runPromise(callback(keepAllow))
    expect(keepAllow.effect).toBe("allow")

    const keepDeny = evaluation(missing, ["packages/plus/src/x.ts"], "deny")
    await Effect.runPromise(callback(keepDeny))
    expect(keepDeny.effect).toBe("deny")

    await Effect.runPromise(registration.dispose)
  })

  test("absolute resource under the run directory matches the relative scope", async () => {
    const sessionID = Session.ID.make("ses_teampolicy001")
    const run = makeRun({ sessionID })
    await saveRun(dir, run)
    const harness = permissionHarness()
    const ctx = context({ permission: harness.domain as unknown as PermissionDomain })
    const registration = await registerTeamPermissions(ctx, dir)
    const callback = harness.state.callback
    expect(callback).toBeDefined()
    if (callback === undefined) return

    const absolute = join(run.directory, "packages/plus/src/x.ts")
    const event = evaluation(sessionID, [absolute], "ask")
    await Effect.runPromise(callback(event))
    expect(event.effect).toBe("allow")

    await Effect.runPromise(registration.dispose)
  })
})
