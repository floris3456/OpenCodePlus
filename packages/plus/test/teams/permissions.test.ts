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
  message?: string,
): PermissionEvaluation {
  return message === undefined
    ? { sessionID, action: "edit", resources, effect }
    : { sessionID, action: "edit", resources, effect, message }
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

  test("out-of-scope denial names the path and every scope entry", async () => {
    const sessionID = Session.ID.make("ses_teampolicy001")
    const run = makeRun({ sessionID, paths: ["packages/plus/src/*", "packages/cli/src/*"] })
    await saveRun(dir, run)
    const harness = permissionHarness()
    const ctx = context({ permission: harness.domain as unknown as PermissionDomain })
    const registration = await registerTeamPermissions(ctx, dir)
    const callback = harness.state.callback
    expect(callback).toBeDefined()
    if (callback === undefined) return

    const event = evaluation(sessionID, ["packages/core/x.ts"], "ask")
    await Effect.runPromise(callback(event))
    expect(event.effect).toBe("deny")
    expect(event.message).toBe(
      `"packages/core/x.ts" is outside your scope.paths [packages/plus/src/*, packages/cli/src/*]. Report it in needs=[{kind:"path"...}].`,
    )

    await Effect.runPromise(registration.dispose)
  })

  test("forbidden denial uses version-control wording", async () => {
    const sessionID = Session.ID.make("ses_teampolicy001")
    const run = makeRun({ sessionID })
    await saveRun(dir, run)
    const harness = permissionHarness()
    const ctx = context({ permission: harness.domain as unknown as PermissionDomain })
    const registration = await registerTeamPermissions(ctx, dir)
    const callback = harness.state.callback
    expect(callback).toBeDefined()
    if (callback === undefined) return

    const event = evaluation(sessionID, [".git/HEAD"], "ask")
    await Effect.runPromise(callback(event))
    expect(event.effect).toBe("deny")
    expect(event.message).toBe(
      `".git/HEAD" is version-control or paused-tool state and is never editable, even inside scope.paths [packages/plus/src/*]. Report it in needs=[{kind:"path"...}].`,
    )

    await Effect.runPromise(registration.dispose)
  })

  test("in-scope allow sets no message", async () => {
    const sessionID = Session.ID.make("ses_teampolicy001")
    const run = makeRun({ sessionID })
    await saveRun(dir, run)
    const harness = permissionHarness()
    const ctx = context({ permission: harness.domain as unknown as PermissionDomain })
    const registration = await registerTeamPermissions(ctx, dir)
    const callback = harness.state.callback
    expect(callback).toBeDefined()
    if (callback === undefined) return

    const event = evaluation(sessionID, ["packages/plus/src/x.ts"], "ask")
    await Effect.runPromise(callback(event))
    expect(event.effect).toBe("allow")
    expect(event.message).toBeUndefined()

    await Effect.runPromise(registration.dispose)
  })

  test("session with no run leaves effect and message untouched", async () => {
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
    const keepAllow = evaluation(missing, ["packages/core/x.ts"], "allow")
    await Effect.runPromise(callback(keepAllow))
    expect(keepAllow.effect).toBe("allow")
    expect(keepAllow.message).toBeUndefined()

    const keepDeny = evaluation(missing, ["packages/core/x.ts"], "deny", "original")
    await Effect.runPromise(callback(keepDeny))
    expect(keepDeny.effect).toBe("deny")
    expect(keepDeny.message).toBe("original")

    await Effect.runPromise(registration.dispose)
  })

  test("empty resources denies with nothing-to-check message", async () => {
    const sessionID = Session.ID.make("ses_teampolicy001")
    const run = makeRun({ sessionID })
    await saveRun(dir, run)
    const harness = permissionHarness()
    const ctx = context({ permission: harness.domain as unknown as PermissionDomain })
    const registration = await registerTeamPermissions(ctx, dir)
    const callback = harness.state.callback
    expect(callback).toBeDefined()
    if (callback === undefined) return

    const event = evaluation(sessionID, [], "ask")
    await Effect.runPromise(callback(event))
    expect(event.effect).toBe("deny")
    expect(event.message).toBe(
      `Edit request named no file; nothing to check against scope.paths [packages/plus/src/*].`,
    )

    await Effect.runPromise(registration.dispose)
  })

  test("first offending resource wins with forbidden checked first", async () => {
    const sessionID = Session.ID.make("ses_teampolicy001")
    const run = makeRun({ sessionID })
    await saveRun(dir, run)
    const harness = permissionHarness()
    const ctx = context({ permission: harness.domain as unknown as PermissionDomain })
    const registration = await registerTeamPermissions(ctx, dir)
    const callback = harness.state.callback
    expect(callback).toBeDefined()
    if (callback === undefined) return

    const forbiddenSecond = evaluation(sessionID, ["packages/core/a.ts", ".git/HEAD"], "ask")
    await Effect.runPromise(callback(forbiddenSecond))
    expect(forbiddenSecond.effect).toBe("deny")
    expect(forbiddenSecond.message).toBe(
      `".git/HEAD" is version-control or paused-tool state and is never editable, even inside scope.paths [packages/plus/src/*]. Report it in needs=[{kind:"path"...}].`,
    )

    const firstOutOfScope = evaluation(sessionID, ["packages/core/a.ts", "packages/other/b.ts"], "ask")
    await Effect.runPromise(callback(firstOutOfScope))
    expect(firstOutOfScope.effect).toBe("deny")
    expect(firstOutOfScope.message).toBe(
      `"packages/core/a.ts" is outside your scope.paths [packages/plus/src/*]. Report it in needs=[{kind:"path"...}].`,
    )

    await Effect.runPromise(registration.dispose)
  })
})
