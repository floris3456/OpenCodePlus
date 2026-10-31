import { expect, test } from "bun:test"
import type { Context } from "@opencode/plugin/effect/plugin"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import { Session } from "@opencode/schema/session"
import { Effect, Exit, Schema, Scope } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { context, fullContext } from "../harness.js"
import { change, presetTable, shippedMembers, shippedTeam, teamState } from "./preset-table.js"
import plus, { activationDirectory, createHandlers, createPlusApi, createState } from "../../src/index.js"
import { formatMarkdown } from "../../src/agents/files.js"
import { load, save } from "../../src/instructions/store.js"
import { createTeamApi, type TeamCaller } from "../../src/teams/api.js"
import { lastReceipt } from "../../src/teams/checks.js"
import { git } from "../../src/teams/git.js"
import { gc, onSessionEvent } from "../../src/teams/lifecycle.js"
import { byDirectory, loadRun, saveRun, type RunRecord } from "../../src/teams/run.js"
import { Brief, CheckpointInput, IntegrateInput, Report } from "../../src/teams/schema.js"
import { atomicJson } from "../../src/teams/store.js"
import { writeProjectChecks } from "../../src/teams/project-checks.js"
import { read } from "../../src/project.js"

// Real temp git repositories plus a real temp state root (scoped
// XDG_DATA_HOME redirect, restored afterwards). The session domain is a
// recording fake supplied through the shared harness context: it records
// what the handlers asked for instead of spawning sessions. No mocks of our
// own code.
async function withIsolatedTeamsRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const tmp = await fs.mkdtemp(path.join(parent, "plus-team-api-"))
  const prior = process.env.XDG_DATA_HOME
  process.env.XDG_DATA_HOME = tmp
  try {
    return await fn(path.join(tmp, "opencode", "opencodeplus", "teams"))
  } finally {
    if (prior === undefined) delete process.env.XDG_DATA_HOME
    else process.env.XDG_DATA_HOME = prior
    await fs.rm(tmp, { recursive: true, force: true })
  }
}

async function makeRepo(): Promise<{ dir: string; head: string }> {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-team-api-repo-"))
  await git(dir, ["init"])
  await git(dir, ["config", "user.name", "team-test"])
  await git(dir, ["config", "user.email", "team-test@local"])
  await fs.writeFile(path.join(dir, "README.md"), "# team api test\n")
  // A brief's `bun test FILE` check must name a file the base holds; the
  // default brief below names this one, so it is part of the first commit.
  await fs.mkdir(path.join(dir, "packages", "plus", "test"), { recursive: true })
  await fs.writeFile(path.join(dir, "packages", "plus", "test", "unit.test.ts"), "// checked by the brief\n")
  await git(dir, ["add", "README.md", "packages/plus/test/unit.test.ts"])
  await git(dir, ["commit", "-m", "feat: initial commit"])
  const head = await git(dir, ["rev-parse", "HEAD"])
  return { dir, head }
}

async function removeRepo(dir: string): Promise<void> {
  await fs.rm(dir, { recursive: true, force: true })
}

function recordSession() {
  const created: unknown[] = []
  const prompted: Array<{ sessionID: unknown; text: unknown }> = []
  const switched: Array<{ sessionID: unknown; model: unknown }> = []
  const order: string[] = []
  const waited: unknown[] = []
  let seq = 0
  // Narrow host doubles: the handlers only read child.id and pass plain
  // inputs through, so minimal shapes behind one boundary cast are enough.
  const domain = {
    create: (input: unknown) => {
      created.push(input)
      seq += 1
      return Effect.succeed({ id: Session.ID.make(`ses_child_${seq}`) })
    },
    prompt: (input: { sessionID: unknown; text: unknown }) => {
      prompted.push({ sessionID: input.sessionID, text: input.text })
      order.push("prompt")
      return Effect.succeed(undefined as never)
    },
    switchModel: (input: { sessionID: unknown; model: unknown }) => {
      switched.push({ sessionID: input.sessionID, model: input.model })
      order.push("switchModel")
      return Effect.succeed(undefined as never)
    },
    wait: (input: unknown) => {
      waited.push(input)
      return Effect.succeed(undefined)
    },
  } as unknown as SessionDomain
  return { created, prompted, switched, order, waited, domain }
}

function baseRun(overrides: Partial<RunRecord> & { id: string }): RunRecord {
  const now = new Date().toISOString()
  return {
    role: "implementer",
    kind: "w",
    repo: "opencode",
    repoKey: "opencode",
    directory: "/tmp/wt-team-api",
    paths: [],
    branch: "team/implementer/test",
    base: "0123456789abcdef0123456789abcdef01234567",
    head: "0123456789abcdef0123456789abcdef01234567",
    state: "idle",
    attempts: [],
    task: null,
    parent: null,
    children: [],
    briefSha: "abc",
    bundle: "team-api-test",
    budget: {},
    createdAt: now,
    lastUsed: now,
    sessionID: null,
    configDigest: null,
    history: [],
    ...overrides,
  }
}

function callerFor(record: RunRecord): TeamCaller {
  return { sessionID: String(record.sessionID ?? "ses_unknown"), agent: record.role, run: record }
}

function delegateInput(overrides?: Record<string, unknown>): Brief {
  return Schema.decodeUnknownSync(Brief)({
    requestID: "req-1",
    role: "implementer",
    objective: "Fix the agent filter in the query module so scoped listing works as documented.",
    deliverable: { kind: "commit" },
    scope: { paths: ["packages/plus/src/*"] },
    checks: [{ id: "unit", argv: ["bun", "test", "packages/plus/test/unit.test.ts"] }],
    ...overrides,
  })
}

function finishInput(input: Partial<typeof Report.Encoded> & Pick<typeof Report.Encoded, "status" | "summary">): Report {
  return Schema.decodeUnknownSync(Report)(input)
}

function required<T>(result: { ok: true; value: T } | { ok: false; error: unknown }): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.value
}

function rejected(result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string; accepted?: unknown } }): {
  code: string
  message: string
  accepted?: unknown
} {
  if (result.ok) throw new Error(`expected failure, got ${JSON.stringify(result.value)}`)
  return result.error
}

test("delegate creates a worktree session, record, brief and prompt", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_001",
      })
      await saveRun(root, parent)
      const sessions = recordSession()
      const api = createTeamApi(context({ session: sessions.domain }), teamState())
      const value = required(await api.delegate(delegateInput(), callerFor(parent))) as {
        run: string
        requestID: string
        branch: string
        base: string
        task: string | null
        state: string
        warning: string
        next: string
      }
      const persisted = await loadRun(root, value.run)
      if (persisted === undefined || persisted.sessionID === null) throw new Error("missing child run or session")
      expect(value).toEqual({
        run: persisted.id,
        requestID: "req-1",
        task: persisted.task,
        state: "starting",
        branch: persisted.branch,
        base: repo.head,
        // The shipped implementer has no shell (its preset turns tool:shell
        // off), so the answer says so before the next step.
        warning: "implementer has no shell: never give it a Brief that needs it to run commands (team_finish still runs the checks a Brief names).",
        next: "If other work is ready, delegate it now; then end your turn: each settlement wakes you with its report.",
      })
      expect((await fs.stat(persisted.directory)).isDirectory()).toBe(true)
      expect(sessions.created).toHaveLength(1)
      const create = sessions.created[0] as { agent: string; location: { directory: string }; title: string }
      expect(create.agent).toBe("implementer")
      expect(create.location.directory).toBe(persisted.directory)
      // Titled from the Brief, so no model request goes to a title.
      expect(create.title).toStartWith("implementer: Fix the agent filter in the query module")
      expect(persisted.sessionID).toBe("ses_child_1")
      expect(persisted?.paths).toEqual(["packages/plus/src/*"])
      expect(persisted?.parent).toBe(parent.id)
      const brief = await Bun.file(path.join(root, "runs", value.run, "brief.md")).text()
      expect(brief).toContain("Fix the agent filter in the query module")
      expect(sessions.prompted).toHaveLength(1)
      expect(sessions.prompted[0]?.sessionID).toBe(persisted.sessionID)
      expect(sessions.prompted[0]?.text).toContain("Fix the agent filter in the query module")
      // The child worktree carries no copied project config: it is activated
      // through the parent directory recorded on its run (item 13).
      expect(await Bun.file(path.join(persisted.directory, ".opencodeplus", "project.json")).exists()).toBe(false)
      expect(await git(persisted.directory, ["status", "--porcelain"])).toBe("")
      expect(persisted?.projectDirectory).toBe(repo.dir)
      await saveRun(root, { ...persisted, attempts: persisted.attempts.map((attempt) => ({ ...attempt, finishNudged: true })) })
      await onSessionEvent(context({ session: sessions.domain }), root, { type: "session.execution.succeeded", data: { sessionID: persisted.sessionID } })
      const replay = required(await api.delegate(delegateInput(), callerFor(parent)))
      expect(replay).toEqual({ ...value, replayed: true, state: "idle" })
      expect(sessions.created).toHaveLength(1)
      expect(sessions.prompted.filter((prompt) => prompt.sessionID === persisted.sessionID)).toHaveLength(1)
      expect(rejected(await api.delegate(delegateInput({ objective: "A different objective must not replace the admitted payload." }), callerFor(parent))).code).toBe("E_REQUEST_ID")
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("delegate activates the child through the parent project, with no copy", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      // Parent runs in a Plus project; the child worktree is outside its tree.
      // The fixture writes the parent's own config; the child gets none.
      await fs.mkdir(path.join(repo.dir, ".opencodeplus"), { recursive: true })
      await fs.writeFile(
        path.join(repo.dir, ".opencodeplus", "project.json"),
        `${JSON.stringify({ version: 1, protectedAgents: ["implementer"] }, null, 2)}\n`,
      )
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_project",
      })
      await saveRun(root, parent)
      const sessions = recordSession()
      const api = createTeamApi(context({ session: sessions.domain }), teamState())
      const value = required(await api.delegate(delegateInput({ requestID: "project-1" }), callerFor(parent))) as {
        run: string
      }
      const child = await loadRun(root, value.run)
      if (child === undefined) throw new Error("missing child run")
      // The child carries no project config at all...
      expect(await Bun.file(path.join(child.directory, ".opencodeplus", "project.json")).exists()).toBe(false)
      // ...and the activation seam resolves the parent's project through the
      // run record the delegate wrote, so Plus activates in the child worktree
      // with the parent's protectedAgents, not a copy and not a stray ancestor.
      expect(child?.projectDirectory).toBe(repo.dir)
      const activation = await activationDirectory(child.directory)
      expect(activation).toBe(repo.dir)
      expect(await read(activation)).toEqual({ version: 1, protectedAgents: ["implementer"] })
      // Item 13 evidence: no copy in the child, activation through the record.
      console.log(
        `[T5 item 13] child ${child.directory}\n  child/.opencodeplus/project.json exists: false\n` +
          `  run.projectDirectory: ${String(child?.projectDirectory)}\n` +
          `  activationDirectory(child): ${activation}\n` +
          `  project.read(activation): ${JSON.stringify(await read(activation))}`,
      )
      // The recorded directory is the worktree the child's session opened in.
      expect((sessions.created[0] as { location: { directory: string } }).location.directory).toBe(child.directory)
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

// The host's session create runs inside `delegate`: it resolves the location
// directory (`FileSystem.realPath`), activation reads it, and the plugin's
// startup sweep runs against the same runs root. This test drives that exact
// window with the real `create`, the real `gc` and a real `realpath`.
test("the first delegate registers the child run before the host opens its session", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_gc_race",
      })
      await saveRun(root, parent)

      const during = {
        resolveError: undefined as string | undefined,
        activation: undefined as string | undefined,
        sessionID: undefined as string | null | undefined,
        orphansRemoved: undefined as string[] | undefined,
        afterSweepError: undefined as string | undefined,
      }
      const resolveCode = (error: { code?: string }) => error.code ?? String(error)
      const sessions = recordSession()
      const domain = {
        ...sessions.domain,
        create: (input: unknown) =>
          Effect.promise(async () => {
            const location = (input as { location: { directory: string } }).location.directory
            during.resolveError = await fs.realpath(location).then(
              () => undefined,
              resolveCode,
            )
            during.activation = await activationDirectory(location)
            during.sessionID = (await byDirectory(root, location))?.sessionID
            // The real sweep a plugin instance runs against this data root,
            // while the delegate is between `create` and its next write.
            during.orphansRemoved = (await gc(root)).orphansRemoved
            during.afterSweepError = await fs.realpath(location).then(
              () => undefined,
              resolveCode,
            )
            return { id: Session.ID.make("ses_child_gc_race") }
          }),
      } as unknown as SessionDomain

      const api = createTeamApi(context({ session: domain }), teamState())
      const value = required(await api.delegate(delegateInput({ requestID: "gc-race-1" }), callerFor(parent))) as {
        run: string
      }
      const child = await loadRun(root, value.run)
      if (child === undefined) throw new Error("missing child run")

      // The host's realPath boundary: the directory it resolves exists, and it
      // still exists after the sweep that ran during session creation.
      expect(await fs.realpath(child.directory)).toBe(child.directory)
      expect(during.resolveError).toBeUndefined()
      expect(during.afterSweepError).toBeUndefined()
      expect(during.orphansRemoved).toEqual([])
      expect(during.activation).toBe(repo.dir)
      expect(during.sessionID).toBeNull()
      expect((await loadRun(root, value.run))?.sessionID).toBe("ses_child_gc_race")
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

// The real plugin entrypoint, the shared harness host, and the real activation
// path: a Location whose directory is the child worktree must install the
// parent project's team agents and the team/instructions tools, and closing
// the plugin scope must dispose them.
test("activation in a child worktree installs the parent project's agents and tools", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      await fs.mkdir(path.join(repo.dir, ".opencodeplus", "teams", "crew"), { recursive: true })
      await fs.writeFile(
        path.join(repo.dir, ".opencodeplus", "project.json"),
        `${JSON.stringify({ version: 1, protectedAgents: ["implementer"] }, null, 2)}\n`,
      )
      await fs.writeFile(
        path.join(repo.dir, ".opencodeplus", "teams", "crew", "alpha.md"),
        formatMarkdown({ description: "crew/alpha" }, "crew alpha body"),
      )
      const loaded = await load(repo.dir)
      const enabled = await save(repo.dir, {
        expectedProjectRevision: loaded.projectRevision,
        expectedGlobalRevision: loaded.globalRevision,
        records: [
          ...loaded.records,
          { type: "team", level: "project", team: "crew", enabled: true, updated: new Date().toISOString() },
          // DESIGN §3.3: a member's shared rows fall back to off unless a
          // preset sets them; alpha stands for a member created from Native
          // `build`, so activation installs it without rows of its own.
          {
            type: "link",
            level: "project",
            agent: "alpha",
            team: { level: "project", team: "crew" },
            preset: { kind: "agent", id: "build" },
            updated: new Date().toISOString(),
          },
        ],
      })
      expect(enabled.ok).toBe(true)

      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_activation",
      })
      await saveRun(root, parent)
      const sessions = recordSession()
      const api = createTeamApi(context({ session: sessions.domain }), teamState())
      const value = required(await api.delegate(delegateInput({ requestID: "activation-1" }), callerFor(parent))) as {
        run: string
      }
      const child = await loadRun(root, value.run)
      if (child === undefined) throw new Error("missing child run")

      // A plugin instance whose Location is the child worktree: the harness
      // records the session-creation seam but nothing about activation.
      // The entrypoint registers the cache warming session hook.
      const ctx = fullContext({ directory: child.directory, hooks: { current: 0 } })
      const pluginCtx = {
        ...ctx,
        rpc: Object.assign(
          () => {
            throw new Error("unused rpc.client")
          },
          {
            register: () => Effect.succeed({ dispose: Effect.void, events: { emit: () => Effect.void } }),
          },
        ),
      } as Context
      const scope = await Effect.runPromise(Scope.make())
      try {
        await Effect.runPromise(plus.effect(pluginCtx).pipe(Effect.provideService(Scope.Scope, scope)))
        const toolIds = await installedToolIds(ctx)
        expect(toolIds).toContain("team_delegate")
        expect(toolIds).toContain("team_status")
        expect(toolIds.filter((id) => id.startsWith("instructions_")).toSorted()).toEqual([
          "instructions_batch",
          "instructions_clipboard",
          "instructions_create",
          "instructions_delete",
          "instructions_edit",
          "instructions_find",
          "instructions_link",
          "instructions_log",
          "instructions_move",
          "instructions_read",
          "instructions_reset",
          "instructions_set",
          "instructions_split",
          "instructions_undo",
        ])
        const listed = await Effect.runPromise(ctx.agent.list())
        expect(listed.data.map((agent) => String(agent.id))).toContain("alpha")
        console.log(
          `[T5 item 13] child plugin activation through the real entrypoint\n` +
            `  location: ${child.directory}\n` +
            `  team tools installed: ${toolIds.filter((id) => id.startsWith("team_")).length}\n` +
            `  instructions tools installed: ${toolIds.filter((id) => id.startsWith("instructions_")).length}\n` +
            `  team member agents installed: ${listed.data.map((agent) => String(agent.id)).filter((id) => id === "alpha").join(", ")}`,
        )
      } finally {
        await Effect.runPromise(Scope.close(scope, Exit.void))
      }
      // Activation is real and scoped: the child instance's registrations went
      // away with it.
      expect(await installedToolIds(ctx)).toEqual([])
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

// Guards, snapshot and mutate all resolve the same directory activation does:
// the run's recorded projectDirectory, never the copy-free child worktree.
test("project guards, snapshot and mutate resolve a child worktree through its run's projectDirectory", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      await fs.mkdir(path.join(repo.dir, ".opencodeplus"), { recursive: true })
      await fs.writeFile(
        path.join(repo.dir, ".opencodeplus", "project.json"),
        `${JSON.stringify({ version: 1, protectedAgents: ["implementer"] }, null, 2)}\n`,
      )
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_api_project",
      })
      await saveRun(root, parent)
      const sessions = recordSession()
      const api = createTeamApi(context({ session: sessions.domain }), teamState())
      const value = required(await api.delegate(delegateInput({ requestID: "api-inherit-1" }), callerFor(parent))) as {
        run: string
      }
      const child = await loadRun(root, value.run)
      if (child === undefined) throw new Error("missing child run")

      // The child worktree carries no config, and no ancestor of it is enabled.
      expect(await Bun.file(path.join(child.directory, ".opencodeplus", "project.json")).exists()).toBe(false)
      const ctx = fullContext({ directory: child.directory })
      const state = createState()
      const handlers = createHandlers(ctx, state, { builtins: [] })
      const snapshot = await Effect.runPromise(handlers["instructions.snapshot"](undefined, throwingContext({})))
      // The child resolves the parent's config through the run record: its
      // protectedAgents are the parent's, not empty defaults.
      expect(snapshot.protectedAgents).toEqual(["implementer"])
      const childApi = createPlusApi(ctx, state, { builtins: [] })
      const mutated = await childApi.mutate({
        expectedRevision: snapshot.revision,
        expectedGlobalRevision: snapshot.globalRevision,
        records: [],
      })
      expect(mutated.ok).toBe(true)
      console.log(
        `[T5 item 13] child API resolves the inherited project\n` +
          `  location: ${child.directory}\n` +
          `  protectedAgents: ${JSON.stringify(snapshot.protectedAgents)}\n` +
          `  snapshot revisions: project=${snapshot.revision} global=${snapshot.globalRevision}\n` +
          `  mutate ok: ${mutated.ok}`,
      )
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

// The session create is the one step that can fail after the run is on disk;
// the pre-registered record must not keep claiming a bounds slot forever.
test("a failed session create retires the pre-registered child run", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_create_fail",
      })
      await saveRun(root, parent)
      const sessions = recordSession()
      const domain = {
        ...sessions.domain,
        create: () => Effect.die(new Error("host session create failed")),
      } as unknown as SessionDomain

      const api = createTeamApi(context({ session: domain }), teamState())
      const error = rejected(await api.delegate(delegateInput({ requestID: "create-fail-1" }), callerFor(parent)))
      expect(error.code).toBe("E_INTERNAL")

      const entries = await fs.readdir(path.join(root, "runs"))
      const records = (await Promise.all(entries.map((entry) => loadRun(root, entry)))).filter(
        (record): record is RunRecord => record !== undefined && record.parent === parent.id,
      )
      expect(records).toHaveLength(1)
      expect(records[0]?.state).toBe("superseded")
      expect(records[0]?.sessionID).toBeNull()
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

// Declared-error side channel for handlers that fail: the harness context
// records which error type a handler selected.
interface CapturedError {
  type: string
  message: string
  data?: unknown
}

function throwingContext(captured: { current?: CapturedError }): {
  error: (type: string, message: string, data?: unknown) => never
} {
  return {
    error: (type, message, data) => {
      const failure: CapturedError = data === undefined ? { type, message } : { type, message, data }
      captured.current = failure
      throw failure
    },
  }
}

async function installedToolIds(ctx: Context): Promise<string[]> {
  const ids: string[] = []
  await Effect.runPromise(
    Effect.scoped(
      ctx.tool.transform((editor) => {
        for (const tool of editor.list()) ids.push(String((tool as { id?: unknown }).id ?? tool.name))
      }),
    ),
  )
  return ids
}

test("delegate rejects E_ROLE when an implementer delegates", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "implementer",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_002",
      })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(await api.delegate(delegateInput({ role: "scout" }), callerFor(parent)))
      expect(error.code).toBe("E_ROLE")
      // An implementer's preset opens no delegation (its "Delegate to" rows
      // ship off); the refusal says so instead of suggesting another role.
      expect(error.message).toBe(`implementer may not delegate. No member is open to you for delegation.`)
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("delegate's answer warns when the named member cannot run commands, and only then", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "build-seat",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_003",
      })
      await saveRun(root, parent)
      const sessions = recordSession()
      const members = shippedMembers()
      const implementer = members.find((member) => member.id === "implementer")
      if (implementer === undefined) throw new Error("no implementer")
      const answer = async (role: string, requestID: string, records: ReturnType<typeof change>[] = []) =>
        required(
          await createTeamApi(context({ session: sessions.domain }), teamState(presetTable({ members, records }))).delegate(
            delegateInput({ requestID, role, ...(role === "orchestrator" ? { reason: "It owns the integration." } : {}) }),
            callerFor(parent),
          ),
        ) as { warning?: string }

      // An orchestrator keeps its shell: nothing to say.
      expect((await answer("orchestrator", "warn-none")).warning).toBeUndefined()
      expect((await answer("implementer", "warn-shell")).warning).toBe(
        "implementer has no shell: never give it a Brief that needs it to run commands (team_finish still runs the checks a Brief names).",
      )
      // A shell that only drives terminals runs no command of its own.
      expect((await answer("implementer", "warn-pilotty", [change(implementer, "tool:shell", { state: "on" })])).warning).toBe(
        `implementer's shell runs only pilotty (driving terminal apps): its "Every other command" row is off.`,
      )
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("delegate rejects E_BASE for an unknown ref", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_003",
      })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(await api.delegate(delegateInput({ base: "no-such-ref" }), callerFor(parent)))
      expect(error.code).toBe("E_BASE")
      expect(error.message).toBe(
        `base "no-such-ref" is not a ref or commit in opencode. Omit base to use your HEAD (${repo.head}), or pass a branch/sha. accepted: "main"`,
      )
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

// The target's own "Scope paths for a commit" row (its Plus implementer
// preset turns it on), not its id, asks for scope.paths.
test("delegate rejects E_PATHS when a commit for an implementer-preset member has no paths", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_004",
      })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(await api.delegate(delegateInput({ scope: { paths: [] } }), callerFor(parent)))
      expect(error.code).toBe("E_PATHS")
      expect(error.message).toBe(
        "implementer needs scope.paths (files or dir/* it may edit) for a commit deliverable (Briefs it accepts → Scope paths for a commit).",
      )
      expect(error.accepted).toEqual(["src/*", "test/*"])
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("delegate attaches a relative briefFile from the caller's checkout", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      await fs.mkdir(path.join(repo.dir, "notes"), { recursive: true })
      await fs.writeFile(path.join(repo.dir, "notes", "brief.md"), "recognisable relative brief line\n")
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_brief_file",
      })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const value = required(await api.delegate(delegateInput({ requestID: "brief-rel-1", briefFile: "notes/brief.md" }), callerFor(parent))) as {
        run: string
      }
      const brief = await fs.readFile(path.join(root, "runs", value.run, "brief.md"), "utf8")
      expect(brief).toContain("recognisable relative brief line")
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("delegate rejects a briefFile outside the checkout and run directory with a briefFile message", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_brief_outside",
      })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(await api.delegate(delegateInput({ requestID: "brief-out-1", briefFile: "/etc/hostname" }), callerFor(parent)))
      expect(error.code).toBe("E_PATHS")
      expect(error.message).toContain("briefFile")
      expect(error.message).not.toContain("scope.paths")
      expect(error.accepted).toEqual([repo.dir, path.join(root, "runs", parent.id)])
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("delegate rejects E_REQUEST_ID when the id is reused with new arguments", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_005",
      })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const first = await api.delegate(
        delegateInput({ requestID: "dup-1", objective: "First objective text that is long enough to validate." }),
        callerFor(parent),
      )
      expect(first.ok).toBe(true)
      const error = rejected(
        await api.delegate(
          delegateInput({ requestID: "dup-1", objective: "Second objective text that differs from the first one." }),
          callerFor(parent),
        ),
      )
      expect(error.code).toBe("E_REQUEST_ID")
      expect(error.message).toBe(
        `requestID "dup-1" was used with different arguments; reuse only to retry the identical call, else pick a new requestID.`,
      )
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

// ── Item 1: Briefs stay short and correct ────────────────────────────────

// The brief limit counts the text the caller wrote; an attached file has its
// own limit, which decides whether it is pasted or named by path.
test("an attachment up to its limit is pasted without counting toward the brief limit; a larger one is named by path", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      await fs.mkdir(path.join(repo.dir, "notes"), { recursive: true })
      // s5-d: a 7,500-char plan is under the 8,000-char attachment limit but
      // over the 6,000-char brief limit; it is pasted whole and admitted.
      await fs.writeFile(path.join(repo.dir, "notes", "small.md"), "s".repeat(7_500))
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_attach_small",
      })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const pasted = required(
        await api.delegate(delegateInput({ requestID: "attach-small-1", briefFile: "notes/small.md" }), callerFor(parent)),
      ) as { run: string }
      expect(await fs.readFile(path.join(root, "runs", pasted.run, "brief.md"), "utf8")).toContain("s".repeat(7_500))

      // The caller's own text is what the brief limit refuses.
      const tooLong = rejected(
        await api.delegate(delegateInput({ requestID: "attach-small-2", briefFile: "notes/small.md", prompt: "p".repeat(4_000), decisions: ["d".repeat(900), "e".repeat(900), "f".repeat(900)] }), callerFor(parent)),
      )
      expect(tooLong.code).toBe("E_TOO_LONG")
      // The refusal says to shorten the Brief; an attached file does not count
      // toward the limit, so long detail goes there (the Delegating role text).
      expect(tooLong.message).toContain("Shorten it")
      expect(tooLong.message).toContain("put long detail in a file attached as briefFile")
      expect(tooLong.accepted).toBe("a shorter brief")

      // A file over the attachment limit is named by path only, so the child's
      // base must hold it: uncommitted, the delegation is refused.
      await fs.writeFile(path.join(repo.dir, "notes", "big.md"), "b".repeat(9_000))
      const uncommitted = rejected(await api.delegate(delegateInput({ requestID: "attach-big-0", briefFile: "notes/big.md" }), callerFor(parent)))
      expect(uncommitted.code).toBe("E_PATHS")
      expect(uncommitted.message).toContain("team_checkpoint it, then delegate")
      await git(repo.dir, ["add", "notes/big.md"])
      await git(repo.dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "notes"])
      const value = required(
        await api.delegate(delegateInput({ requestID: "attach-big-1", briefFile: "notes/big.md" }), callerFor(parent)),
      ) as { run: string }
      const brief = await fs.readFile(path.join(root, "runs", value.run, "brief.md"), "utf8")
      expect(brief).toContain("## Attached: notes/big.md")
      expect(brief).toContain("over the 8000-character attachment limit: read the file itself")
      expect(brief).not.toContain("b".repeat(100))
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

// The attachment limit is a member row: it sets the largest file pasted.
test("the Attached brief file row sets the paste limit", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      await fs.mkdir(path.join(repo.dir, "notes"), { recursive: true })
      await fs.writeFile(path.join(repo.dir, "notes", "mid.md"), "m".repeat(2_000))
      // Committed: a file named by path must be in the child's base.
      await git(repo.dir, ["add", "notes/mid.md"])
      await git(repo.dir, ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "notes"])
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_attach_row",
      })
      await saveRun(root, parent)
      const member = shippedMembers().find((entry) => entry.id === "orchestrator")
      if (member === undefined) throw new Error("missing orchestrator member")
      // Lower the row to 1,000: the 2,000-char file is now over it, so it is
      // named by path.
      const table = presetTable({
        records: [change(member, "perm:team_delegate:limits.attachment", { state: "on", text: "1000" })],
      })
      const api = createTeamApi(context({ session: recordSession().domain }), teamState(table))
      const value = required(
        await api.delegate(delegateInput({ requestID: "attach-row-1", briefFile: "notes/mid.md" }), callerFor(parent)),
      ) as { run: string }
      const brief = await fs.readFile(path.join(root, "runs", value.run, "brief.md"), "utf8")
      expect(brief).toContain("over the 1000-character attachment limit: read the file itself")
      expect(brief).not.toContain("m".repeat(100))
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

// Every `bun test FILE` a brief names is resolved against the child's base
// commit: a missing file outside scope refuses the delegation, names the file,
// and creates no run.
test("a check naming a file the base does not hold refuses the delegation and creates no run", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_missing_check",
      })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(
        await api.delegate(
          delegateInput({ requestID: "missing-1", checks: [{ id: "unit", argv: ["bun", "test", "packages/plus/test/nope.test.ts"] }] }),
          callerFor(parent),
        ),
      )
      expect(error.code).toBe("E_CHECKS")
      expect(error.message).toContain("packages/plus/test/nope.test.ts")
      expect(error.message).toContain("base")
      expect(error.accepted).toBe("an existing test file or a writable file in scope.paths")
      // No run record was created for the refused delegation.
      const entries = await fs.readdir(path.join(root, "runs")).catch(() => [] as string[])
      expect(entries.filter((entry) => entry.startsWith("w-"))).toEqual([])
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("a check naming a file the base holds is accepted", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_present_check",
      })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const value = required(
        await api.delegate(
          delegateInput({ requestID: "present-1", checks: [{ id: "unit", argv: ["bun", "test", "packages/plus/test/unit.test.ts"] }] }),
          callerFor(parent),
        ),
      ) as { run: string }
      expect((await loadRun(root, value.run))?.role).toBe("implementer")
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

function childInRepo(id: string, repo: { dir: string; head: string }): RunRecord {
  const now = new Date().toISOString()
  return baseRun({
    id,
    role: "implementer",
    directory: repo.dir,
    paths: ["docs/*"],
    base: repo.head,
    head: repo.head,
    state: "working",
    attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
    parent: "main-0123456789abcdef",
    sessionID: "ses_child_001",
  })
}

test("checkpoint commits an in-scope file and moves HEAD", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = childInRepo("w-aaaaaaaaaaaaaaaa", repo)
      await saveRun(root, child)
      await fs.mkdir(path.join(repo.dir, "docs"), { recursive: true })
      await fs.writeFile(path.join(repo.dir, "docs", "notes.md"), "# notes\n")
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const value = required(
        await api.checkpoint({ expectedHead: repo.head, files: ["docs/notes.md"], message: "fix: update notes" }, callerFor(child)),
      ) as { head: string; committed: boolean; sha?: string; subject?: string }
      expect(value.committed).toBe(true)
      expect(value.sha).toBe(value.head)
      expect(value.head).not.toBe(repo.head)
      expect(value.subject).toBe("fix: update notes")
      expect((await loadRun(root, child.id))?.head).toBe(value.head)
      expect(await git(repo.dir, ["rev-parse", "HEAD"])).toBe(value.head)
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("checkpoint takes its HEAD as a short commit, HEAD or nothing, and refuses one it moved past", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = childInRepo("w-abababababababab", repo)
      await saveRun(root, child)
      await fs.mkdir(path.join(repo.dir, "docs"), { recursive: true })
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const heads = [repo.head]
      for (const expected of ["short", "HEAD", undefined] as const) {
        await fs.writeFile(path.join(repo.dir, "docs", "notes.md"), `# notes ${heads.length}\n`)
        const value = required(
          await api.checkpoint(
            {
              ...(expected === undefined ? {} : { expectedHead: expected === "short" ? heads.at(-1)!.slice(0, 7) : expected }),
              files: ["docs/notes.md"],
              message: "fix: update notes",
            },
            callerFor(child),
          ),
        ) as { head: string; committed: boolean }
        expect(value.committed).toBe(true)
        heads.push(value.head)
      }
      await fs.writeFile(path.join(repo.dir, "docs", "notes.md"), "# moved past\n")
      const error = rejected(
        await api.checkpoint({ expectedHead: repo.head.slice(0, 7), files: ["docs/notes.md"], message: "fix: update notes" }, callerFor(child)),
      )
      expect(error.code).toBe("E_STALE_HEAD")
      // The tool schemas take the same forms, and nothing git would have to resolve.
      for (const schema of [CheckpointInput, IntegrateInput]) {
        const key = schema === CheckpointInput ? "expectedHead" : "expectedParentHead"
        const base = schema === CheckpointInput ? { files: ["a.md"], message: "fix: a" } : { run: child.id }
        for (const ok of [undefined, "HEAD", repo.head, repo.head.slice(0, 7)])
          expect(() => Schema.decodeUnknownSync(schema)({ ...base, ...(ok === undefined ? {} : { [key]: ok }) })).not.toThrow()
        for (const bad of ["HEAD~1", "main", repo.head.slice(0, 6)]) expect(() => Schema.decodeUnknownSync(schema)({ ...base, [key]: bad })).toThrow()
      }
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("checkpoint rejects an out-of-scope file with E_SCOPE", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = childInRepo("w-aaaaaaaaaaaaaaaa", repo)
      await saveRun(root, child)
      await fs.mkdir(path.join(repo.dir, "outside"), { recursive: true })
      await fs.writeFile(path.join(repo.dir, "outside", "o.md"), "out of scope\n")
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(
        await api.checkpoint({ expectedHead: repo.head, files: ["outside/o.md"], message: "fix: out of scope" }, callerFor(child)),
      )
      expect(error.code).toBe("E_SCOPE")
      expect(error.message).toBe(`"outside/o.md" is outside your scope.paths [docs/*]. Report it in needs=[{kind:"path"...}].`)
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("checkpoint rejects a non-conventional message with E_MESSAGE", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = childInRepo("w-aaaaaaaaaaaaaaaa", repo)
      await saveRun(root, child)
      await fs.mkdir(path.join(repo.dir, "docs"), { recursive: true })
      await fs.writeFile(path.join(repo.dir, "docs", "notes.md"), "# notes\n")
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(
        await api.checkpoint({ expectedHead: repo.head, files: ["docs/notes.md"], message: "update notes without a type" }, callerFor(child)),
      )
      expect(error.code).toBe("E_MESSAGE")
      expect(error.message).toBe(
        `Use "<type>(<scope>)?: <subject>" with type in feat|fix|docs|chore|refactor|test. accepted: "fix: apply agent filter in query"`,
      )
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("checkpoint with an empty diff succeeds without committing", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = childInRepo("w-aaaaaaaaaaaaaaaa", repo)
      await saveRun(root, child)
      await fs.mkdir(path.join(repo.dir, "docs"), { recursive: true })
      await fs.writeFile(path.join(repo.dir, "docs", "notes.md"), "# notes\n")
      await git(repo.dir, ["add", "docs/notes.md"])
      await git(repo.dir, ["commit", "-m", "fix: track notes"])
      const head = await git(repo.dir, ["rev-parse", "HEAD"])
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const value = required(
        await api.checkpoint({ expectedHead: head, files: ["docs/notes.md"], message: "fix: nothing to do" }, callerFor(child)),
      ) as { head: string; committed: boolean }
      expect(value).toEqual({ head, committed: false })
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

const PASSING_TEST = `import { expect, test } from "bun:test"\n\ntest("ok", () => {\n  expect(1).toBe(1)\n})\n`
const FAILING_TEST = `import { expect, test } from "bun:test"\n\ntest("ok", () => {\n  expect(1).toBe(2)\n})\n`

async function finishChild(root: string, repo: { dir: string; head: string }, body: string): Promise<RunRecord> {
  await fs.writeFile(path.join(repo.dir, "t.test.ts"), body)
  await git(repo.dir, ["add", "t.test.ts"])
  await git(repo.dir, ["commit", "-m", "test: add unit test"])
  const head = await git(repo.dir, ["rev-parse", "HEAD"])
  const child = childInRepo("w-bbbbbbbbbbbbbbbb", { dir: repo.dir, head })
  const record: RunRecord = { ...child, base: repo.head, paths: ["t.test.ts"] }
  await saveRun(root, record)
  await atomicJson(path.join(root, "runs", record.id, "checks.json"), [{ id: "t", argv: ["bun", "test", "t.test.ts"] }])
  return record
}

test("finish done with a green check records the report and commits", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = await finishChild(root, repo, PASSING_TEST)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const value = required(await api.finish(finishInput({ status: "done", summary: "Filter fixed and covered." }), callerFor(child))) as {
        head: string
        reportPath: string
        commits: Array<{ sha: string; subject: string }>
        checks: Array<{ id: string; passed: boolean; head: string; at: number }>
      }
      expect(value.checks).toEqual([{ id: "t", passed: true, head: value.head, at: expect.any(Number) }])
      expect(value.commits).toEqual([{ sha: value.head, subject: "test: add unit test" }])
      expect(await Bun.file(value.reportPath).exists()).toBe(true)
      // The report the child wrote is not echoed back to it; the file has it.
      expect(value).not.toHaveProperty("summary")
      expect(await Bun.file(value.reportPath).text()).toContain("Filter fixed and covered.")
      const moved = await loadRun(root, child.id)
      expect(moved?.attempts[moved.attempts.length - 1]?.state).toBe("succeeded")
      expect(moved?.head).toBe(value.head)
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test.each(["done", "done_with_concerns"] as const)("finish %s refuses an untracked green test before running assigned checks", async (status) => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = await finishChild(root, repo, PASSING_TEST)
      const counter = path.join(root, "executions.log")
      await Bun.write(path.join(repo.dir, "new.test.ts"), `import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(counter)}, "run\\n")\n${PASSING_TEST}`)
      await atomicJson(path.join(root, "runs", child.id, "checks.json"), [{ id: "new", argv: ["bun", "test", "new.test.ts"] }])
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      expect(required(await api.check({ id: "new" }, callerFor(child)))).toMatchObject({ passed: true, dirty: true })
      const receipt = await lastReceipt(root, child.id, "new")
      const error = rejected(await api.finish(finishInput({ status, summary: "Code committed; test passes in the worktree." }), callerFor(child)))
      expect(error).toEqual({
        code: "E_DIRTY",
        message: "Worktree has uncommitted changes in [new.test.ts]. Assigned checks prove committed work only; team_checkpoint these files (or revert them), then finish.",
        accepted: { files: ["new.test.ts"] },
      })
      expect(await Bun.file(counter).text()).toBe("run\n")
      expect(await lastReceipt(root, child.id, "new")).toEqual(receipt)
      expect(await Bun.file(path.join(root, "runs", child.id, "report-1.json")).exists()).toBe(false)
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("finish done with a red check fails E_CHECKS_RED", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = await finishChild(root, repo, FAILING_TEST)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(await api.finish(finishInput({ status: "done", summary: "Filter fixed and covered." }), callerFor(child)))
      expect(error.code).toBe("E_CHECKS_RED")
      expect(error.message).toContain("Cannot report done: checks red at HEAD")
      expect(error.message).toContain("[t]")
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("finish runs a stale check instead of refusing it", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = await finishChild(root, repo, PASSING_TEST)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const checked = required(await api.check({ id: "t" }, callerFor(child))) as { passed: boolean; head: string }
      expect(checked.passed).toBe(true)
      await fs.writeFile(path.join(repo.dir, "extra.md"), "more work\n")
      await git(repo.dir, ["add", "extra.md"])
      await git(repo.dir, ["commit", "-m", "docs: extra notes"])
      const head = await git(repo.dir, ["rev-parse", "HEAD"])
      expect(head).not.toBe(checked.head)
      const value = required(await api.finish(finishInput({ status: "done", summary: "Filter fixed and covered." }), callerFor(child))) as {
        head: string
      }
      expect(value.head).toBe(head)
      expect((await lastReceipt(root, child.id, "t"))?.head).toBe(head)
      expect((await lastReceipt(root, child.id, "t"))?.passed).toBe(true)
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test.each([false, true])("finish reuses a dirty check after checkpoint only for identical content (changed: %s)", async (changed) => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const counter = path.join(root, "executions.log")
      await fs.mkdir(root, { recursive: true })
      const child = {
        ...await finishChild(root, repo, `import { appendFileSync } from "node:fs"\nappendFileSync(${JSON.stringify(counter)}, "run\\n")\n${PASSING_TEST}`),
        paths: ["docs/*"],
      }
      await saveRun(root, child)
      await fs.mkdir(path.join(repo.dir, "docs"))
      await fs.writeFile(path.join(repo.dir, "docs", "notes.md"), "checked content\n")
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const checked = required(await api.check({ id: "t" }, callerFor(child))) as { passed: boolean; at: number; dirty: boolean; measuredTree: string; reused: boolean }
      expect(checked).toMatchObject({ passed: true, dirty: true, reused: false })
      expect(await Bun.file(counter).text()).toBe("run\n")
      if (changed) await fs.writeFile(path.join(repo.dir, "docs", "notes.md"), "different content\n")
      required(await api.checkpoint({ files: ["docs/notes.md"], message: "docs: checkpoint notes" }, callerFor(child)))
      const head = await git(repo.dir, ["rev-parse", "HEAD"])
      const tree = await git(repo.dir, ["rev-parse", "HEAD^{tree}"])
      expect(checked.measuredTree === tree).toBe(!changed)
      const finished = required(await api.finish(finishInput({ status: "done", summary: "Checked and checkpointed the notes." }), callerFor(child))) as { checks: Array<{ reused?: boolean; at: number }>; reportPath: string }
      expect(await Bun.file(counter).text()).toBe(changed ? "run\nrun\n" : "run\n")
      expect(finished.checks[0].reused ?? false).toBe(!changed)
      const receipt = await lastReceipt(root, child.id, "t", head)
      expect(receipt).toMatchObject({ passed: true, dirty: false, measuredTree: tree, reused: !changed })
      expect((await lastReceipt(root, child.id, "t"))?.head).toBe(head)
      if (changed) return
      expect(finished.checks[0].at).toBe(checked.at)
      expect(receipt?.reusedFrom).toMatchObject({ at: checked.at, dirty: true })
      expect(await Bun.file(finished.reportPath).text()).toContain(`reused same-tree check from ${checked.at}`)
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("finish re-runs a dirty-tree receipt at the commit and fails E_CHECKS_RED with the exact message", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = childInRepo("w-dddddddddddddddd", repo)
      await saveRun(root, child)
      await atomicJson(path.join(root, "runs", child.id, "checks.json"), [{ id: "t", argv: ["bun", "test", "t.test.ts"] }])
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      // Edit without committing: the passing test is dirty, so the green
      // receipt is dirty-tree proof and must never satisfy finish at HEAD.
      await fs.writeFile(path.join(repo.dir, "t.test.ts"), PASSING_TEST)
      const checked = required(await api.check({ id: "t" }, callerFor(child))) as { passed: boolean; head: string }
      expect(checked.passed).toBe(true)
      // Commit a failing version, then finish: the stale check is re-run
      // at the commit and the exact 03 E_CHECKS_RED message results.
      await fs.writeFile(path.join(repo.dir, "t.test.ts"), FAILING_TEST)
      await git(repo.dir, ["add", "t.test.ts"])
      await git(repo.dir, ["commit", "-m", "test: add unit test"])
      const head = await git(repo.dir, ["rev-parse", "HEAD"])
      expect(head).not.toBe(checked.head)
      const error = rejected(await api.finish(finishInput({ status: "done", summary: "Filter fixed and covered." }), callerFor(child)))
      expect(error.code).toBe("E_CHECKS_RED")
      const receipt = await lastReceipt(root, child.id, "t")
      if (receipt === undefined) throw new Error("missing receipt after finish re-run")
      expect(receipt.head).toBe(head)
      expect(receipt.passed).toBe(false)
      // The suggested detail names what failed, not the runner's banner.
      expect(error.message).toStartWith(
        `Cannot report done: checks red at HEAD ${head}: [t]. Fix and finish again, or finish with status "blocked" and needs=[{kind:"check",detail:"t fails: error: expect(received).toBe(expected) — (fail) ok`,
      )
      expect(error.message).not.toContain("bun test v")
      const detail = (error.accepted as { needs: Array<{ detail: string }> }).needs[0]!.detail
      expect(detail.length).toBeLessThanOrEqual(1000)
      expect(error.message).toContain(`detail:"${detail}"`)
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("finish done moves run.state to idle and status reports it", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = await finishChild(root, repo, PASSING_TEST)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const value = required(await api.finish(finishInput({ status: "done", summary: "Filter fixed and covered." }), callerFor(child))) as {
        head: string
      }
      expect(value.head).toBeDefined()
      const moved = await loadRun(root, child.id)
      expect(moved?.attempts[moved.attempts.length - 1]?.state).toBe("succeeded")
      expect(moved?.state).toBe("idle")
      const entries = required(await api.status({ runs: [child.id] }, callerFor(child))) as Array<{
        run: string
        state: string
        attemptState: string
      }>
      expect(entries).toHaveLength(1)
      expect(entries[0]?.run).toBe(child.id)
      expect(entries[0]?.state).toBe("idle")
      expect(entries[0]?.attemptState).toBe("succeeded")
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("finish blocked without needs fails E_NEEDS", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = childInRepo("w-aaaaaaaaaaaaaaaa", repo)
      await saveRun(root, child)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(await api.finish(finishInput({ status: "blocked", summary: "Stuck on scope." }), callerFor(child)))
      expect(error.code).toBe("E_NEEDS")
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

// ── the report summary limit is the member's own row ────────────────────────

function summaryLines(n: number): string {
  return Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n")
}

// A run of a role with no preset (a "runner" configured outside the Basic
// team): every one of its rows is off, so the catalogue's shipped 15 is what
// team_finish enforces.
function runnerChild(id: string, repo: { dir: string; head: string }, role: string): RunRecord {
  const now = new Date().toISOString()
  return baseRun({
    id,
    role,
    directory: repo.dir,
    paths: ["docs/*"],
    base: repo.head,
    head: repo.head,
    state: "working",
    attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
    parent: "main-0123456789abcdef",
    sessionID: `ses_summary_${id.slice(2, 6)}`,
  })
}

test("team_finish refuses a report over the member's summary lines and names the limit and the row", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const runner = runnerChild("w-runnnnnnnnnnnnnn", repo, "runner")
      await saveRun(root, runner)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const refused = rejected(await api.finish(finishInput({ status: "blocked", summary: summaryLines(16), needs: [{ kind: "info", detail: "waiting" }] }), callerFor(runner)))
      expect(refused.code).toBe("E_SUMMARY")
      expect(refused.message).toBe(
        "summary is 16 lines (max 15 for runner, team_finish limits.summary). Shorten it: put detail in findings, concerns or a file in your worktree and name it.",
      )
      expect(refused.accepted).toBe("a summary of ≤15 lines")
      // 15 lines pass the limit and reach the next gate (blocked needs one need).
      expect(rejected(await api.finish(finishInput({ status: "blocked", summary: summaryLines(15) }), callerFor(runner))).code).toBe("E_NEEDS")
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("team_finish gives fixer-god 25 summary lines and scout 20, and a record can raise any member's", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const god = runnerChild("w-fixergodddddddd", repo, "fixer-god")
      await saveRun(root, god)
      // fixer-god is a member of a team configured outside the Basic presets:
      // it has no preset, so its row reads off and its 25 is the role default.
      const godApi = createTeamApi(
        context({ session: recordSession().domain }),
        teamState(presetTable({ members: [...shippedMembers(), { id: "fixer-god", team: shippedTeam }] })),
      )
      expect(rejected(await godApi.finish(finishInput({ status: "blocked", summary: summaryLines(26) }), callerFor(god))).message).toBe(
        "summary is 26 lines (max 25 for fixer-god, team_finish limits.summary). Shorten it: put detail in findings, concerns or a file in your worktree and name it.",
      )
      expect(rejected(await godApi.finish(finishInput({ status: "blocked", summary: summaryLines(25) }), callerFor(god))).code).toBe("E_NEEDS")

      // A scout ships its own row at 20.
      const scout = runnerChild("w-scoooooooooooooo", repo, "scout")
      await saveRun(root, scout)
      const scoutApi = createTeamApi(context({ session: recordSession().domain }), teamState())
      expect(rejected(await scoutApi.finish(finishInput({ status: "blocked", summary: summaryLines(21) }), callerFor(scout))).message).toStartWith("summary is 21 lines (max 20 for scout, team_finish limits.summary).")
      expect(rejected(await scoutApi.finish(finishInput({ status: "blocked", summary: summaryLines(20) }), callerFor(scout))).code).toBe("E_NEEDS")

      // A record setting the runner's row to 30 lets 30 through. The runner has
      // no preset, so its rows are off until a record turns this one on.
      const runner = runnerChild("w-runnnnnnnnnnnnnn", repo, "runner")
      await saveRun(root, runner)
      const runnerMember = { id: "runner", team: shippedTeam }
      const raised = presetTable({ members: [...shippedMembers(), runnerMember], records: [change(runnerMember, "perm:team_finish:limits.summary", { state: "on", text: "30" })] })
      const raisedApi = createTeamApi(context({ session: recordSession().domain }), teamState(raised))
      expect(rejected(await raisedApi.finish(finishInput({ status: "blocked", summary: summaryLines(31) }), callerFor(runner))).message).toStartWith("summary is 31 lines (max 30 for runner, team_finish limits.summary).")
      expect(rejected(await raisedApi.finish(finishInput({ status: "blocked", summary: summaryLines(30) }), callerFor(runner))).code).toBe("E_NEEDS")
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

// ── the wall at delegation ──────────────────────────────────────────────────

test("delegate takes a wall and stores it as the child's budget", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_wall",
      })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const value = required(await api.delegate(delegateInput({ requestID: "wall-1", wall: "2.5h" }), callerFor(parent))) as { run: string }
      expect((await loadRun(root, value.run))?.budget.wallMs).toBe(9_000_000)
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("delegate refuses an unreadable wall with E_DURATION and a wall over the member's limit", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_wall",
      })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const invalid = rejected(await api.delegate(delegateInput({ requestID: "wall-bad", wall: "soon" }), callerFor(parent)))
      expect(invalid.code).toBe("E_DURATION")
      expect(invalid.message).toBe(`Invalid duration "soon". Expected format like "7d", "24h", "30m", "60s", or "500ms".`)
      const over = rejected(await api.delegate(delegateInput({ requestID: "wall-long", wall: "10h" }), callerFor(parent)))
      expect(over.code).toBe("E_TOO_LONG")
      expect(over.message).toBe(
        "wall 10h is 600 minutes (max 480 minutes, team_delegate limits.wall). Shorten it or raise the row (Permissions → Limits → Longest wall at delegation).",
      )
      expect(await fs.readdir(path.join(root, "runs")).then((names) => names.filter((name) => name.startsWith("w-")))).toEqual([])
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("get_context returns the rendered brief once the session no longer holds it, with checks and scope", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_006",
      })
      await saveRun(root, parent)
      // The recording session has no context: as after a compaction, the
      // Brief message is gone from what the model sees.
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const delegated = required(await api.delegate(delegateInput({ requestID: "ctx-1" }), callerFor(parent))) as {
        run: string
        session: string
      }
      const child = await loadRun(root, delegated.run)
      if (child === undefined) throw new Error("missing child run")
      const value = required(await api.get_context({}, callerFor(child))) as {
        run: string
        brief: string
        briefPath: string
        scope: { paths: string[] }
        checks: Array<{ id: string }>
        inbox: unknown[]
      }
      expect(value.run).toBe(delegated.run)
      expect(value.brief).toBe(await Bun.file(value.briefPath).text())
      expect(value.brief).toContain("Fix the agent filter in the query module")
      expect(value.scope.paths).toEqual(["packages/plus/src/*"])
      expect(value.checks.map((check) => check.id)).toEqual(["unit"])
      expect(value.inbox).toEqual([])
      expect(value).not.toHaveProperty("interfaces")
      expect(value).not.toHaveProperty("decisions")
      expect((value as Record<string, unknown>).conventions).toBeUndefined()
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("get_context leaves the brief out while the session still holds the Brief message", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_006b",
      })
      await saveRun(root, parent)
      const session = recordSession()
      // The model's context is what the child was prompted with.
      const domain = {
        ...session.domain,
        context: (input: { sessionID: unknown }) =>
          Effect.succeed(
            session.prompted
              .filter((item) => item.sessionID === input.sessionID)
              .map((item) => ({ type: "user", text: item.text })) as never,
          ),
      } as unknown as SessionDomain
      const api = createTeamApi(context({ session: domain }), teamState())
      const delegated = required(await api.delegate(delegateInput({ requestID: "ctx-1b" }), callerFor(parent))) as {
        run: string
      }
      const child = await loadRun(root, delegated.run)
      if (child === undefined) throw new Error("missing child run")
      expect(session.prompted.some((item) => item.sessionID === child.sessionID)).toBe(true)
      const value = required(await api.get_context({}, callerFor(child))) as Record<string, unknown>
      expect(value).not.toHaveProperty("brief")
      expect(value.briefPath).toBe(path.join(root, "runs", delegated.run, "brief.md"))
      expect(value.scope).toEqual({ paths: ["packages/plus/src/*"], forbidden: [] })
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("get_context lists the parent's other open children as siblings, not other parents' runs", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parentFor = (id: string, sessionID: string) =>
        baseRun({ id, kind: "main", role: "orchestrator", directory: repo.dir, base: repo.head, head: repo.head, sessionID })
      const parent = parentFor("main-0123456789abcdef", "ses_parent_sib")
      const other = parentFor("main-fedcba9876543210", "ses_other_sib")
      await saveRun(root, parent)
      await saveRun(root, other)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const delegate = async (caller: RunRecord, requestID: string) =>
        (required(await api.delegate(delegateInput({ requestID }), callerFor((await loadRun(root, caller.id))!))) as { run: string }).run
      const first = await delegate(parent, "sib-1")
      const second = await delegate(parent, "sib-2")
      await delegate(other, "sib-3")
      const child = await loadRun(root, first)
      if (child === undefined) throw new Error("missing child run")
      const value = required(await api.get_context({}, callerFor(child))) as { siblings: unknown[] }
      expect(value.siblings).toEqual([{ run: second, role: "implementer", paths: ["packages/plus/src/*"], state: expect.any(String) }])
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("get_context on a root run has no brief and no conventions", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        kind: "main",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_006_root",
      })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const value = required(await api.get_context({}, callerFor(parent))) as Record<string, unknown>
      expect(value.run).toBe("main-0123456789abcdef")
      expect(value).not.toHaveProperty("brief")
      expect(value.briefPath).toBeNull()
      expect(value.scope).toEqual({ paths: [], forbidden: [] })
      expect(value.conventions).toBeUndefined()
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("status shows the child head and the check receipt", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_007",
      })
      await saveRun(root, parent)
      await fs.writeFile(path.join(repo.dir, "t.test.ts"), PASSING_TEST)
      await git(repo.dir, ["add", "t.test.ts"])
      await git(repo.dir, ["commit", "-m", "test: add unit test"])
      const head = await git(repo.dir, ["rev-parse", "HEAD"])
      const child = childInRepo("w-cccccccccccccccc", { dir: repo.dir, head })
      const record: RunRecord = { ...child, base: repo.head, paths: ["t.test.ts"] }
      await saveRun(root, record)
      await saveRun(root, { ...parent, children: [record.id] })
      await atomicJson(path.join(root, "runs", record.id, "checks.json"), [{ id: "t", argv: ["bun", "test", "t.test.ts"] }])
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const checked = required(await api.check({ id: "t" }, callerFor(record))) as { passed: boolean }
      expect(checked.passed).toBe(true)
      const entries = required(await api.status({ runs: [record.id] }, callerFor(parent))) as Array<{
        run: string
        head: string
        dirty: boolean
        checks: Array<{ id: string; passed: boolean | null; atHead: boolean }>
        report: unknown
      }>
      expect(entries).toHaveLength(1)
      expect(entries[0]?.run).toBe(record.id)
      expect(entries[0]?.head).toBe(head)
      expect(entries[0]?.dirty).toBe(false)
      expect(entries[0]?.checks).toEqual([{ id: "t", passed: true, atHead: true }])
      expect(entries[0]?.report).toBeNull()
      expect(entries[0]).toHaveProperty("task", record.task)
      expect(entries[0]).not.toHaveProperty("taskState")
      const defaults = required(await api.status({}, callerFor(parent))) as Array<{ run: string }>
      expect(defaults.map((entry) => entry.run).toSorted()).toEqual([parent.id, record.id].toSorted())
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("team_status shows retrying for a future until and null for a past one", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const parent = baseRun({ id: "main-0123456789abcdef", role: "orchestrator", kind: "main" })
    const futureUntil = new Date(Date.now() + 60000).toISOString()
    const pastUntil = new Date(Date.now() - 60000).toISOString()
    const retryingRun = baseRun({
      id: "w-future0000000000",
      parent: parent.id,
      retrying: {
        until: futureUntil,
        attempt: 1,
        error: { type: "rate_limit", message: "too many requests" },
      },
    })
    const expiredRun = baseRun({
      id: "w-past000000000000",
      parent: parent.id,
      retrying: {
        until: pastUntil,
        attempt: 2,
        error: { type: "overloaded", message: "server busy" },
      },
    })
    const normalRun = baseRun({
      id: "w-normal0000000000",
      parent: parent.id,
    })
    await saveRun(root, parent)
    await saveRun(root, retryingRun)
    await saveRun(root, expiredRun)
    await saveRun(root, normalRun)
    const api = createTeamApi(context({ session: recordSession().domain }), teamState())
    const entries = required(
      await api.status({ runs: [retryingRun.id, expiredRun.id, normalRun.id] }, callerFor(parent)),
    ) as Array<{ run: string; retrying: unknown }>
    expect(entries).toHaveLength(3)
    const retryingEntry = entries.find((e) => e.run === retryingRun.id)
    const expiredEntry = entries.find((e) => e.run === expiredRun.id)
    const normalEntry = entries.find((e) => e.run === normalRun.id)
    expect(retryingEntry?.retrying).toEqual({
      until: futureUntil,
      attempt: 1,
      error: { type: "rate_limit", message: "too many requests" },
    })
    expect(expiredEntry?.retrying).toBeNull()
    expect(normalEntry?.retrying).toBeNull()
  })
})

async function dirtyChild(root: string, repo: { dir: string; head: string }, id: string): Promise<RunRecord> {
  await fs.mkdir(path.join(repo.dir, "src"), { recursive: true })
  await fs.writeFile(path.join(repo.dir, "src", "greeting.ts"), "export const greeting = 'hi'\n")
  await fs.writeFile(path.join(repo.dir, "t.test.ts"), PASSING_TEST)
  await git(repo.dir, ["add", "src/greeting.ts", "t.test.ts"])
  await git(repo.dir, ["commit", "-m", "test: add greeting and unit test"])
  const head = await git(repo.dir, ["rev-parse", "HEAD"])
  const child = childInRepo(id, { dir: repo.dir, head })
  const record: RunRecord = { ...child, base: repo.head, paths: ["src/*"] }
  await saveRun(root, record)
  await atomicJson(path.join(root, "runs", record.id, "checks.json"), [{ id: "t", argv: ["bun", "test", "t.test.ts"] }])
  return record
}

test("check runs a project check the run was not assigned, apart from its assigned ones", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      await fs.writeFile(path.join(repo.dir, "t.test.ts"), PASSING_TEST)
      await fs.writeFile(path.join(repo.dir, "u.test.ts"), FAILING_TEST)
      await git(repo.dir, ["add", "t.test.ts", "u.test.ts"])
      await git(repo.dir, ["commit", "-m", "test: add tests"])
      await writeProjectChecks(repo.dir, { version: 1, checks: { "test-file": { argv: ["bun", "test", "{path}"], description: "one test file" } } })
      const child = { ...childInRepo("w-acacacacacacacac", repo), head: await git(repo.dir, ["rev-parse", "HEAD"]) }
      await saveRun(root, child)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      // No checks assigned: a project check still runs, by its name and path.
      expect(required(await api.check({ id: "test-file", path: "t.test.ts" }, callerFor(child)))).toMatchObject({ id: "test-file", passed: true })
      const unknown = rejected(await api.check({ id: "lint" }, callerFor(child)))
      expect(unknown.code).toBe("E_UNKNOWN_CHECK")
      expect(unknown.message).toContain("Project checks: test-file (one test file) — needs path")
      // Beside an assigned check of the same name, its receipts keep apart.
      await atomicJson(path.join(root, "runs", child.id, "checks.json"), [{ id: "test-file", argv: ["bun", "test", "t.test.ts"] }])
      expect(required(await api.check({ id: "test-file", path: "u.test.ts" }, callerFor(child)))).toMatchObject({ id: "test-file-own", passed: false })
      expect(required(await api.check({ id: "test-file", path: "./t.test.ts" }, callerFor(child)))).toMatchObject({ id: "test-file", passed: true })
      expect(required(await api.check({ id: "test-file" }, callerFor(child)))).toMatchObject({ id: "test-file", passed: true })
      await atomicJson(path.join(root, "runs", child.id, "checks.json"), [{ id: "test-file-report", argv: ["bun", "test", "./t.test.ts"] }])
      expect(required(await api.check({ id: "test-file-report", path: "test/../t.test.ts" }, callerFor(child)))).toMatchObject({ id: "test-file-report", passed: true })
      expect(rejected(await api.check({ id: "test-file-report", path: "u.test.ts" }, callerFor(child)))).toEqual({
        code: "E_UNKNOWN_CHECK",
        message: 'Check "test-file-report" is assigned with a fixed command (bun test ./t.test.ts): call it without path.',
        accepted: { id: "test-file-report" },
      })
      expect(required(await api.check({ id: "test-file-report" }, callerFor(child)))).toMatchObject({ id: "test-file-report", passed: true })
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("finish done with an unstaged modification names the full path in E_DIRTY", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = await dirtyChild(root, repo, "w-eeeeeeeeeeeeeeee")
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const checked = required(await api.check({ id: "t" }, callerFor(child))) as { passed: boolean }
      expect(checked.passed).toBe(true)
      await fs.writeFile(path.join(repo.dir, "src", "greeting.ts"), "export const greeting = 'hello'\n")
      const error = rejected(await api.finish(finishInput({ status: "done", summary: "Greeting updated." }), callerFor(child)))
      expect(error.code).toBe("E_DIRTY")
      expect(error.message).toBe(
        "Worktree has uncommitted changes in [src/greeting.ts]. Assigned checks prove committed work only; team_checkpoint these files (or revert them), then finish.",
      )
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("finish done with an untracked file names the full path in E_DIRTY", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = await dirtyChild(root, repo, "w-ffffffffffffffff")
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const checked = required(await api.check({ id: "t" }, callerFor(child))) as { passed: boolean }
      expect(checked.passed).toBe(true)
      await fs.writeFile(path.join(repo.dir, "src", "untracked.ts"), "export const extra = 1\n")
      const error = rejected(await api.finish(finishInput({ status: "done", summary: "Greeting updated." }), callerFor(child)))
      expect(error.code).toBe("E_DIRTY")
      expect(error.message).toBe(
        "Worktree has uncommitted changes in [src/untracked.ts]. Assigned checks prove committed work only; team_checkpoint these files (or revert them), then finish.",
      )
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("finish done with a spaced path names the full path in E_DIRTY", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = await dirtyChild(root, repo, "w-1111111111111111")
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const checked = required(await api.check({ id: "t" }, callerFor(child))) as { passed: boolean }
      expect(checked.passed).toBe(true)
      await fs.writeFile(path.join(repo.dir, "src", "with space.ts"), "export const spaced = 1\n")
      const error = rejected(await api.finish(finishInput({ status: "done", summary: "Greeting updated." }), callerFor(child)))
      expect(error.code).toBe("E_DIRTY")
      expect(error.message).toBe(
        "Worktree has uncommitted changes in [src/with space.ts]. Assigned checks prove committed work only; team_checkpoint these files (or revert them), then finish.",
      )
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("finish done with more than 50 dirty files names the first 50 and counts the rest", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = await dirtyChild(root, repo, "w-2222222222222222")
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const checked = required(await api.check({ id: "t" }, callerFor(child))) as { passed: boolean }
      expect(checked.passed).toBe(true)
      const files = Array.from({ length: 60 }, (_, i) => `src/bulk-${String(i).padStart(2, "0")}.ts`)
      for (const file of files) await fs.writeFile(path.join(repo.dir, file), "export const bulk = 1\n")
      const error = rejected(await api.finish(finishInput({ status: "done", summary: "Greeting updated." }), callerFor(child)))
      expect(error.code).toBe("E_DIRTY")
      expect(error.message).toBe(
        `Worktree has uncommitted changes in [${files.slice(0, 50).join(", ")} and 10 more]. Assigned checks prove committed work only; team_checkpoint these files (or revert them), then finish.`,
      )
      expect(error.message).not.toContain("src/bulk-50.ts")
      expect(error.accepted).toEqual({ files: files.slice(0, 50) })
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("a dirty finish result names at most 50 files and counts the rest, while the report holds them all", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = childInRepo("w-7777777777777777", repo)
      await saveRun(root, child)
      const files = Array.from({ length: 60 }, (_, i) => `bulk-${String(i).padStart(2, "0")}.ts`)
      for (const file of files) await fs.writeFile(path.join(repo.dir, file), "export const bulk = 1\n")
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const value = required(await api.finish(finishInput({ status: "done_with_concerns", summary: "Bulk files reviewed." }), callerFor(child))) as {
        dirty: boolean
        dirtyFiles: string[]
        dirtyCount: number
      }
      expect(value.dirty).toBe(true)
      expect(value.dirtyFiles).toEqual(files.slice(0, 50))
      expect(value.dirtyCount).toBe(60)
      const report = (await Bun.file(path.join(root, "runs", child.id, "report-1.json")).json()) as { dirtyFiles: string[] }
      expect(report.dirtyFiles).toEqual(files)
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

function finishedChild(id: string, repo: { dir: string; head: string }): RunRecord {
  const now = new Date().toISOString()
  return baseRun({
    id,
    role: "implementer",
    directory: repo.dir,
    paths: ["docs/*"],
    base: repo.head,
    head: repo.head,
    state: "idle",
    attempts: [{ n: 1, state: "succeeded", startedAt: now, trigger: "delegate", endedAt: now }],
    parent: "main-0123456789abcdef",
    sessionID: `ses_finished_${id.slice(2, 6)}`,
  })
}

function workingChild(id: string, repo: { dir: string; head: string }): RunRecord {
  const now = new Date().toISOString()
  return baseRun({
    id,
    role: "implementer",
    directory: repo.dir,
    paths: ["docs/*"],
    base: repo.head,
    head: repo.head,
    state: "working",
    attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
    parent: "main-0123456789abcdef",
    sessionID: `ses_working_${id.slice(2, 6)}`,
  })
}

test("delegate succeeds after four finished children free their slots", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_bounds_free",
      })
      await saveRun(root, parent)
      const ids = ["w-aaaaaaaaaaaaaaaa", "w-bbbbbbbbbbbbbbbb", "w-cccccccccccccccc", "w-dddddddddddddddd"]
      for (const id of ids) await saveRun(root, finishedChild(id, repo))
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const value = required(await api.delegate(delegateInput({ requestID: "bounds-free-1" }), callerFor(parent))) as {
        run: string
      }
      expect(typeof value.run).toBe("string")
      expect(value.run.startsWith("w-")).toBe(true)
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("delegate refuses a fifth working child with E_BOUNDS", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_bounds_full",
      })
      await saveRun(root, parent)
      const ids = ["w-aaaaaaaaaaaaaaaa", "w-bbbbbbbbbbbbbbbb", "w-cccccccccccccccc", "w-dddddddddddddddd"]
      for (const id of ids) await saveRun(root, workingChild(id, repo))
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(await api.delegate(delegateInput({ requestID: "bounds-full-1" }), callerFor(parent)))
      expect(error.code).toBe("E_BOUNDS")
      // The bound is the member's "Children working at once" row; the old
      // text pointed at a policy file that is never loaded.
      expect(error.message).toBe(
        "In-flight limit 4 reached (w-aaaaaaaaaaaaaaaa, w-bbbbbbbbbbbbbbbb, w-cccccccccccccccc, w-dddddddddddddddd). End your turn; a settling child wakes you, then delegate.",
      )
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("B — four live children plus one superseded-on-create → a fifth delegate succeeds", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_bounds_d3",
      })
      await saveRun(root, parent)

      // 3 live working children for parent
      const parentLiveIds = ["w-aaaaaaaaaaaaaaaa", "w-bbbbbbbbbbbbbbbb", "w-cccccccccccccccc"]
      for (const id of parentLiveIds) await saveRun(root, workingChild(id, repo))

      // 1 live working child for another parent (total 4 live children in workspace)
      const otherChild = { ...workingChild("w-dddddddddddddddd", repo), parent: "main-other0000000000" }
      await saveRun(root, otherChild)

      // 1 child whose session creation failed (superseded-on-create, sessionID is null)
      const failedChild = baseRun({
        id: "w-eeeeeeeeeeeeeeee",
        role: "implementer",
        directory: repo.dir,
        paths: ["docs/*"],
        base: repo.head,
        head: repo.head,
        state: "starting",
        attempts: [],
        parent: parent.id,
        sessionID: null,
      })
      await saveRun(root, failedChild)

      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const result = await api.delegate(delegateInput({ requestID: "fifth-delegate-1" }), callerFor(parent))
      const value = required(result) as { run: string }
      expect(typeof value.run).toBe("string")
      expect(value.run.startsWith("w-")).toBe(true)
    } finally {
      await removeRepo(repo.dir)
    }
  })
})

test("delegate switches the child to the role pin before prompting", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_pin_switch",
      })
      await saveRun(root, parent)
      const sessions = recordSession()
      const state = teamState()
      state.activeModels.set("implementer", { providerID: "cliproxyapi", modelID: "muse-spark-1.3-contributor", variant: "high" })
      const api = createTeamApi(context({ session: sessions.domain }), state)
      const value = required(await api.delegate(delegateInput({ requestID: "pin-switch-1" }), callerFor(parent))) as {
        run: string
        model: string
      }
      const child = await loadRun(root, value.run)
      expect(value.model).toBe("cliproxyapi/muse-spark-1.3-contributor@high")
      expect(sessions.switched).toHaveLength(1)
      expect(sessions.switched[0]?.sessionID).toBe(child?.sessionID)
      const model = sessions.switched[0]?.model as { providerID: unknown; id: unknown; variant?: unknown }
      expect(model.providerID).toBe("cliproxyapi")
      expect(model.id).toBe("muse-spark-1.3-contributor")
      expect(model.variant).toBe("high")
      expect(sessions.order).toEqual(["switchModel", "prompt"])
      expect(sessions.prompted).toHaveLength(1)
      expect(sessions.prompted[0]?.sessionID).toBe(child?.sessionID)
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test.each([undefined, "high"])("delegate without a role pin reports the host's resolved model (%s)", async (variant) => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: repo.head,
        sessionID: "ses_parent_pin_missing",
      })
      await saveRun(root, parent)
      const sessions = recordSession()
      const domain = {
        ...sessions.domain,
        get: () => Effect.succeed({ model: { providerID: "host", id: "resolved-model", variant } }),
      } as unknown as SessionDomain
      const api = createTeamApi(context({ session: domain }), teamState())
      const value = required(await api.delegate(delegateInput({ requestID: "pin-missing-1" }), callerFor(parent))) as {
        run: string
        model: string
      }
      expect(value.model).toBe(`host/resolved-model${variant === undefined ? "" : `@${variant}`}`)
      expect(sessions.switched).toHaveLength(0)
      expect(sessions.prompted).toHaveLength(1)
      expect(sessions.prompted[0]?.sessionID).toBe((await loadRun(root, value.run))?.sessionID)
      expect(typeof value.run).toBe("string")
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("finish ignores Plus project.json but still reports real untracked files", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      await fs.mkdir(path.join(repo.dir, ".opencodeplus"), { recursive: true })
      await fs.writeFile(path.join(repo.dir, ".opencodeplus", "project.json"), `{"version":1,"protectedAgents":[]}\n`)
      const child = childInRepo("w-3333333333333333", repo)
      await saveRun(root, child)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const value = required(await api.finish(finishInput({ status: "done", summary: "Filter fixed and covered." }), callerFor(child))) as {
        dirty: boolean
        dirtyFiles: string[]
      }
      expect(value.dirty).toBe(false)
      expect(value.dirtyFiles).toEqual([])
      const entries = required(await api.status({ runs: [child.id] }, callerFor(child))) as Array<{ dirty: boolean }>
      expect(entries).toHaveLength(1)
      expect(entries[0]?.dirty).toBe(false)
      const child2 = childInRepo("w-4444444444444444", repo)
      await saveRun(root, child2)
      await fs.writeFile(path.join(repo.dir, "real-untracked.txt"), "real\n")
      const error = rejected(await api.finish(finishInput({ status: "done", summary: "Greeting updated." }), callerFor(child2)))
      expect(error.code).toBe("E_DIRTY")
      expect(error.message).toContain("real-untracked.txt")
      expect(error.message).not.toContain(".opencodeplus")
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("finish done succeeds with an untracked Plus project.json and passing assigned check", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const child = await finishChild(root, repo, PASSING_TEST)
      await fs.mkdir(path.join(repo.dir, ".opencodeplus"), { recursive: true })
      await fs.writeFile(path.join(repo.dir, ".opencodeplus", "project.json"), `{"version":1,"protectedAgents":[]}\n`)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const value = required(await api.finish(finishInput({ status: "done", summary: "Completed task with passing check." }), callerFor(child))) as {
        head: string
        reportPath: string
        dirty: boolean
        dirtyFiles: string[]
        checks: Array<{ id: string; passed: boolean; head: string; at: number }>
      }
      expect(value.dirty).toBe(false)
      expect(value.dirtyFiles).toEqual([])
      expect(value.checks).toEqual([{ id: "t", passed: true, head: value.head, at: expect.any(Number) }])
      expect(await Bun.file(value.reportPath).exists()).toBe(true)
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("finish reports modified tracked project.json as dirty", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      await fs.mkdir(path.join(repo.dir, ".opencodeplus"), { recursive: true })
      await fs.writeFile(path.join(repo.dir, ".opencodeplus", "project.json"), `{"version":1,"protectedAgents":[]}\n`)
      await git(repo.dir, ["add", ".opencodeplus/project.json"])
      await git(repo.dir, ["commit", "-m", "chore: track project.json"])
      const head = await git(repo.dir, ["rev-parse", "HEAD"])
      const child = childInRepo("w-5555555555555555", { dir: repo.dir, head })
      await saveRun(root, child)

      // Modify the tracked project.json
      await fs.writeFile(path.join(repo.dir, ".opencodeplus", "project.json"), `{"version":2,"protectedAgents":["new"]}\n`)

      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(await api.finish(finishInput({ status: "done", summary: "Modified tracked project." }), callerFor(child)))
      expect(error.code).toBe("E_DIRTY")
      expect(error.message).toContain(".opencodeplus/project.json")
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("finish reports new untracked file under .opencodeplus as dirty", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      await fs.mkdir(path.join(repo.dir, ".opencodeplus"), { recursive: true })
      await fs.writeFile(path.join(repo.dir, ".opencodeplus", "project.json"), `{"version":1,"protectedAgents":[]}\n`)
      await fs.writeFile(path.join(repo.dir, ".opencodeplus", "agent.json"), `{"agent":"custom"}\n`)
      const child = childInRepo("w-6666666666666666", repo)
      await saveRun(root, child)

      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(await api.finish(finishInput({ status: "done", summary: "Added untracked config." }), callerFor(child)))
      expect(error.code).toBe("E_DIRTY")
      expect(error.message).toContain(".opencodeplus/agent.json")
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

// A reviewer can neither run checks nor read another run, and its own
// worktree starts at the end of the change, so its own diff from base is
// empty. Its Brief therefore carries the range (from where the delegating run
// started) as an exact team_diff call, and that run's check results.
test("a review brief names the change since the delegating run started and that run's check results", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      await fs.writeFile(path.join(repo.dir, "landed.txt"), "landed work\n")
      await git(repo.dir, ["add", "landed.txt"])
      await git(repo.dir, ["commit", "-m", "feat: landed work"])
      const landed = await git(repo.dir, ["rev-parse", "HEAD"])
      const parent = baseRun({
        id: "main-0123456789abcdef",
        role: "orchestrator",
        directory: repo.dir,
        base: repo.head,
        head: landed,
        sessionID: "ses_parent_review",
      })
      await saveRun(root, parent)
      await atomicJson(path.join(root, "runs", parent.id, "checks.json"), [
        { id: "unit", argv: ["bun", "test", "unit.test.ts"] },
        { id: "lint", argv: ["bun", "run", "lint"] },
      ])
      const receipt = { argv: [], cwd: "", head: landed, exitCode: 0, at: Date.now(), durationMs: 1, outputPath: "", tree: "t", dirty: false }
      await atomicJson(path.join(root, "runs", parent.id, "receipts", `unit-${landed.slice(0, 7)}.json`), { ...receipt, id: "unit", passed: true })
      const sessions = recordSession()
      const api = createTeamApi(context({ session: sessions.domain }), teamState())
      const delegated = required(
        await api.delegate(
          delegateInput({ requestID: "review-1", role: "reviewer", deliverable: { kind: "findings" }, scope: { paths: [] }, checks: [] }),
          callerFor(parent),
        ),
      ) as { run: string }
      const brief = await fs.readFile(path.join(root, "runs", delegated.run, "brief.md"), "utf8")
      expect(brief).toContain(`See the change with team_diff {run: "${delegated.run}", from: "${repo.head}"}; when the objective names one task's commits`)
      expect(brief).toContain(`Checks at ${landed.slice(0, 12)}: unit pass, lint not run.`)
      expect(brief).toContain("May edit: nothing (read-only task)")
      // The call the Brief names shows the change: the reviewer's worktree diffed from that commit.
      const reviewer = await loadRun(root, delegated.run)
      if (reviewer === undefined) throw new Error("missing reviewer run")
      const diff = required(await api.diff({ run: reviewer.id, from: repo.head }, callerFor(reviewer))) as { patch: string }
      expect(diff.patch).toContain("+landed work")
      // A non-review Brief carries no Review section.
      const implementer = required(await api.delegate(delegateInput({ requestID: "impl-1" }), callerFor(parent))) as { run: string }
      expect(await fs.readFile(path.join(root, "runs", implementer.run, "brief.md"), "utf8")).not.toContain("## Review")
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

// Live b6-s3/s13: an implementer read the test file its Brief named before
// creating it. The Brief marks a scope path the base does not hold as new.
test("delegate marks scope paths the base does not hold as new in the Brief", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({ id: "main-0123456789abcdef", role: "orchestrator", directory: repo.dir, base: repo.head, head: repo.head, sessionID: "ses_parent_new" })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const scope = { paths: ["README.md", "packages/plus/test/unit.test.ts", "src/new.ts", "test/new.test.ts", "packages/plus/src/*"] }
      const delegated = required(await api.delegate(delegateInput({ requestID: "new-1", scope }), callerFor(parent))) as { run: string }
      const brief = await fs.readFile(path.join(root, "runs", delegated.run, "brief.md"), "utf8")
      expect(brief).toContain("May edit: README.md, packages/plus/test/unit.test.ts, src/new.ts (new), test/new.test.ts (new), packages/plus/src/*\n")
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

// Live b7-s7: a build seat put long rules in a new file, named it in the
// prompt without attaching it, and the implementer found nothing there.
test("delegate refuses a Brief naming an uncommitted file unless it is the briefFile", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({ id: "main-0123456789abcdef", role: "orchestrator", directory: repo.dir, base: repo.head, head: repo.head, sessionID: "ses_parent_unseen" })
      await saveRun(root, parent)
      await fs.writeFile(path.join(repo.dir, "nbx-brief.md"), "# rules\n")
      await fs.writeFile(path.join(repo.dir, "README.md"), "# changed\n")
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const refused = await api.delegate(delegateInput({ requestID: "unseen-1", prompt: "The full rules are in nbx-brief.md; follow them." }), callerFor(parent))
      expect(refused).toMatchObject({ ok: false, error: { code: "E_PATHS", accepted: { files: ["nbx-brief.md"] } } })
      expect(refused.ok ? "" : refused.error.message).toContain("The Brief names [nbx-brief.md], which has uncommitted changes in your checkout")
      // A tracked file with changes is the same: the child sees its committed version.
      const tracked = await api.delegate(delegateInput({ requestID: "unseen-2", decisions: ["Keep README.md as it is."] }), callerFor(parent))
      expect(tracked).toMatchObject({ ok: false, error: { code: "E_PATHS", accepted: { files: ["README.md"] } } })
      // Attached, it reaches the child; a name inside another word is no mention.
      await fs.writeFile(path.join(repo.dir, "README.md"), "# team api test\n")
      required(await api.delegate(delegateInput({ requestID: "unseen-3", prompt: "Follow nbx-brief.md (attached), not old-nbx-brief.mdx.", briefFile: "nbx-brief.md" }), callerFor(parent)))
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

// Live b7-s7: a forbidden "docs/**" refused a whole Brief; it means "docs/*".
test("delegate reads dir/** and dir/ in scope as dir/*", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({ id: "main-0123456789abcdef", role: "orchestrator", directory: repo.dir, base: repo.head, head: repo.head, sessionID: "ses_parent_globs" })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const scope = { paths: ["packages/plus/src/**", "packages/plus/test/"], forbidden: ["docs/**"] }
      const delegated = required(await api.delegate(delegateInput({ requestID: "globs-1", scope }), callerFor(parent))) as { run: string }
      const stored = JSON.parse(await fs.readFile(path.join(root, "runs", delegated.run, "brief.json"), "utf8")) as { scope: { paths: string[]; forbidden: string[] } }
      expect(stored.scope.paths).toContain("packages/plus/src/*")
      expect(stored.scope.paths).toContain("packages/plus/test/*")
      expect(stored.scope.forbidden).toEqual(["docs/*"])
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

// checkpoint and integrate compare against the live HEAD; the stored one lags
// behind a landing or a commit made outside team tools.
test("get_context reports the worktree's live HEAD, not the stored one", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      await fs.writeFile(path.join(repo.dir, "later.txt"), "later\n")
      await git(repo.dir, ["add", "later.txt"])
      await git(repo.dir, ["commit", "-m", "chore: later commit"])
      const live = await git(repo.dir, ["rev-parse", "HEAD"])
      const parent = baseRun({ id: "main-0123456789abcdef", kind: "main", role: "orchestrator", directory: repo.dir, base: repo.head, head: repo.head, sessionID: "ses_parent_live_head" })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const value = required(await api.get_context({}, callerFor(parent))) as { head: string }
      expect(value.head).toBe(live)
      expect((await loadRun(root, parent.id))?.head).toBe(repo.head)
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

// A delegator names a project check; the run stores and renders the command
// the project wrote (.opencodeplus/checks.json in the main checkout), and a
// command nobody named is refused with the project's list.
test("delegate resolves a project check to the project's command and refuses a made-up one", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      await writeProjectChecks(repo.dir, { version: 1, checks: { unit: { argv: ["pytest", "tests"], description: "all tests" } } })
      const parent = baseRun({ id: "main-0123456789abcdef", role: "orchestrator", directory: repo.dir, base: repo.head, head: repo.head, sessionID: "ses_parent_checks" })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const delegated = required(await api.delegate(delegateInput({ requestID: "checks-1", checks: [{ id: "unit" }] }), callerFor(parent))) as {
        run: string
      }
      expect(await atomicRead(path.join(root, "runs", delegated.run, "checks.json"))).toEqual([{ id: "unit", argv: ["pytest", "tests"] }])
      expect(await fs.readFile(path.join(root, "runs", delegated.run, "brief.md"), "utf8")).toContain("- unit: pytest tests")
      const refused = await api.delegate(delegateInput({ requestID: "checks-2", checks: [{ id: "x", argv: ["sh", "-c", "id"] }] }), callerFor(parent))
      if (refused.ok) throw new Error("expected a refusal")
      expect((refused.error as { code: string }).code).toBe("E_CHECKS")
      expect((refused.error as { message: string }).message).toContain("Project checks: unit (all tests)")
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

async function atomicRead(file: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(file, "utf8"))
}

test("delegate with a task no integrate returned says to leave task out", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({ id: "main-0123456789abcdef", role: "orchestrator", directory: repo.dir, base: repo.head, head: repo.head, sessionID: "ses_parent_task" })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const error = rejected(await api.delegate(delegateInput({ requestID: "made-up-task", task: "T10.rework.1" }), callerFor(parent)))
      expect(error.code).toBe("E_TASK_BLOCKED")
      expect(error.message).toContain("Omit it for any other work")
      expect(error.accepted).toEqual({ task: null })
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("delegate drops forbidden entries naming protected state and names an invalid scope path", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({ id: "main-0123456789abcdef", role: "orchestrator", directory: repo.dir, base: repo.head, head: repo.head, sessionID: "ses_parent_forbid" })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const scope = (forbidden: string[]) => ({ paths: ["packages/plus/src/*"], forbidden })
      const delegated = required(
        await api.delegate(delegateInput({ requestID: "forbid-1", scope: scope(["packages/plus/src/x.ts", ".opencodeplus/*", ".git"]) }), callerFor(parent)),
      ) as { run: string }
      // What no run may change anyway is left out; the rest is kept and enforced.
      const stored = await Bun.file(path.join(root, "runs", delegated.run, "brief.json")).json()
      expect(stored.scope).toEqual({ paths: ["packages/plus/src/*"], forbidden: ["packages/plus/src/x.ts"] })
      const error = rejected(await api.delegate(delegateInput({ requestID: "forbid-2", scope: scope(["/etc/passwd"]) }), callerFor(parent)))
      expect(error.code).toBe("E_PATHS")
      expect(error.message).toContain('Not one: "/etc/passwd"')
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("delegate names a missing briefFile; a review of one unlanded done child takes its head, of several is refused", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({ id: "main-0123456789abcdef", role: "orchestrator", directory: repo.dir, base: repo.head, head: repo.head, sessionID: "ses_parent_review", children: ["w-abcdabcdabcdabcd", "w-efefefefefefefef"] })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const missing = rejected(await api.delegate(delegateInput({ requestID: "brief-missing", briefFile: "docs/plans/later.md" }), callerFor(parent)))
      expect(missing.code).toBe("E_PATHS")
      expect(missing.message).toContain("briefFile docs/plans/later.md does not exist or cannot be read: write it first")
      // A done child whose commit is still in its own worktree.
      await git(repo.dir, ["checkout", "-q", "-b", "child-work"])
      await fs.writeFile(path.join(repo.dir, "change.txt"), "x\n")
      await git(repo.dir, ["add", "change.txt"])
      await git(repo.dir, ["commit", "-q", "-m", "feat: change"])
      const childHead = await git(repo.dir, ["rev-parse", "HEAD"])
      await git(repo.dir, ["checkout", "-q", "-"])
      const child = baseRun({ id: "w-abcdabcdabcdabcd", parent: parent.id, directory: repo.dir, state: "idle", head: childHead })
      await saveRun(root, child)
      await atomicJson(path.join(root, "runs", child.id, "report-1.json"), { run: child.id, attempt: 1, status: "done", summary: "done", commits: [{ sha: childHead, subject: "feat: change" }] })
      const review = () =>
        api.delegate(
          delegateInput({ requestID: `review-${Math.random()}`, role: "reviewer", deliverable: { kind: "findings" }, scope: { paths: [] }, checks: [] }),
          callerFor(parent),
        )
      // b8-s12, b10-s12: the one child that reported done and has not landed is what a review sees.
      expect(required(await review())).toMatchObject({ base: childHead })
      // A landing of an earlier worktree of the child (before a followup reopened it) is not this one's.
      const landing = (id: string, childBranch: string) =>
        atomicJson(path.join(root, "runs", parent.id, "merge", `${id}.json`), {
          id, parentRun: parent.id, childRun: child.id, childBranch, childHead: repo.head, expectedParentHead: repo.head, state: "landed", at: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z",
        })
      await landing("entry-0", "team/implementer/earlier-20261019-1200")
      expect(required(await review())).toMatchObject({ base: childHead })
      // Two of them: the lead names one, or lands them first.
      const other = baseRun({ id: "w-efefefefefefefef", parent: parent.id, directory: repo.dir, state: "idle", head: childHead, branch: "team/other" })
      await saveRun(root, other)
      await atomicJson(path.join(root, "runs", other.id, "report-1.json"), { run: other.id, attempt: 1, status: "done", summary: "done", commits: [{ sha: childHead, subject: "feat: change" }] })
      const unlanded = rejected(await review())
      expect(unlanded.code).toBe("E_UNLANDED")
      expect(unlanded.message).toContain("reported done but have not landed")
      expect(unlanded.message).toContain("review one before it lands with base: its commit")
      // An explicit base still reviews that commit.
      const early = required(
        await api.delegate(
          delegateInput({ requestID: "review-early", role: "reviewer", deliverable: { kind: "findings" }, scope: { paths: [] }, checks: [], base: childHead }),
          callerFor(parent),
        ),
      ) as { base: string }
      expect(early.base).toBe(childHead)
      // Once both landed, the review starts from the parent's HEAD.
      await landing("entry-1", child.branch)
      await atomicJson(path.join(root, "runs", parent.id, "merge", "entry-2.json"), {
        id: "entry-2", parentRun: parent.id, childRun: other.id, childBranch: other.branch, childHead, expectedParentHead: repo.head, state: "landed", at: "2026-10-20T00:00:00.000Z", updatedAt: "2026-10-20T00:00:00.000Z",
      })
      expect(required(await review())).toMatchObject({ state: "starting", base: repo.head })
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test.each(["orchestrator", "implementer"].flatMap((role) => ["packages/plus/test/new.test.ts", "packages/plus/test/*"].map((scope) => [role, scope] as const)))("%s may write and finish a new assigned test inside %s", async (role, scope) => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({ id: "main-0123456789abcdef", role: "build-seat", directory: repo.dir, base: repo.head, head: repo.head, sessionID: "ses_parent_test_author" })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const brief = (requestID: string, paths: string[], forbidden: string[] = []) =>
        delegateInput({
          requestID,
          role,
          reason: "owned multi-step work",
          scope: { paths, forbidden },
          checks: [{ id: "unit", argv: ["bun", "test", "packages/plus/test/new.test.ts"] }],
        })
      // The checkpoint check-files row permits explicitly scoped test files.
      const delegated = required(await api.delegate(brief("author-1", ["packages/plus/src/*", scope]), callerFor(parent))) as { run: string }
      const child = (await loadRun(root, delegated.run))!
      expect(child.state).toBe("starting")
      // Outside its scope it could not write it: refused as before.
      expect(rejected(await api.delegate(brief("author-2", ["packages/plus/src/*"]), callerFor(parent))).code).toBe("E_CHECKS")
      expect(rejected(await api.delegate(brief("author-3", ["packages/plus/test/*"], ["packages/plus/test/new.test.ts"]), callerFor(parent))).code).toBe("E_CHECKS")
      const file = "packages/plus/test/new.test.ts"
      await Bun.write(path.join(child.directory, file), FAILING_TEST)
      required(await api.checkpoint({ files: [file], message: "test: add assigned test" }, callerFor(child)))
      expect(rejected(await api.finish(finishInput({ status: "done", summary: "New test written and verified." }), callerFor(child))).code).toBe("E_CHECKS_RED")
      await Bun.write(path.join(child.directory, file), PASSING_TEST)
      required(await api.checkpoint({ files: [file], message: "test: complete assigned test" }, callerFor(child)))
      required(await api.finish(finishInput({ status: "done", summary: "New test written and verified." }), callerFor(child)))
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

test("a member that writes plan files only gets docs/plans and docs/handoffs in its scope unless forbidden", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = baseRun({ id: "main-0123456789abcdef", role: "build-seat", directory: repo.dir, base: repo.head, head: repo.head, sessionID: "ses_parent_plan_scope" })
      await saveRun(root, parent)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const delegate = async (requestID: string, role: string, forbidden: string[]) => {
        const value = required(
          await api.delegate(
            delegateInput({ requestID, role, reason: "owned multi-step work", scope: { paths: ["src/*"], forbidden } }),
            callerFor(parent),
          ),
        ) as { run: string }
        const stored = await Bun.file(path.join(root, "runs", value.run, "brief.json")).json()
        return { scope: stored.scope.paths, run: (await loadRun(root, value.run))?.paths }
      }
      // s5-d: an orchestrator scoped to source paths writes its handoff files.
      expect(await delegate("plans-1", "orchestrator", [])).toEqual({ scope: ["src/*", "docs/plans/*", "docs/handoffs/*"], run: ["src/*"] })
      expect((await delegate("plans-2", "orchestrator", ["docs/*"])).scope).toEqual(["src/*"])
      // An implementer may change every file: its scope stays what was given.
      expect((await delegate("plans-3", "implementer", [])).scope).toEqual(["src/*"])
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

// s13-b: an orchestrator reported done right after delegating its first task.
// Done waits for every child to settle and for done commits to land; a
// reviewer's findings carry no commits and hold nothing up.
test("finish done is refused while a child works or a done child's commits have not landed", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = { ...(await finishChild(root, repo, PASSING_TEST)), children: ["w-cccccccccccccccc"] }
      await saveRun(root, parent)
      const now = new Date().toISOString()
      const child = baseRun({
        id: "w-cccccccccccccccc",
        parent: parent.id,
        directory: repo.dir,
        state: "working",
        sessionID: "ses_grandchild",
        attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
      })
      await saveRun(root, child)
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      const finish = () => api.finish(finishInput({ status: "done", summary: "All tasks landed." }), callerFor(parent))

      const waiting = rejected(await finish())
      expect(waiting.code).toBe("E_WAITING")
      expect(waiting.message).toContain("[w-cccccccccccccccc] are still working")

      // Settled done with a commit that has not landed.
      await saveRun(root, { ...child, state: "idle", attempts: [{ n: 1, state: "succeeded", startedAt: now, trigger: "delegate" }] })
      const report = { run: child.id, attempt: 1, status: "done", summary: "done", commits: [{ sha: repo.head, subject: "feat: change" }] }
      await atomicJson(path.join(root, "runs", child.id, "report-1.json"), report)
      const unlanded = rejected(await finish())
      expect(unlanded.code).toBe("E_UNLANDED")
      expect(unlanded.message).toContain("[w-cccccccccccccccc] reported done but have not landed")

      // Findings without commits never land and do not hold the parent.
      await atomicJson(path.join(root, "runs", child.id, "report-1.json"), { ...report, commits: [] })
      expect(required(await finish())).toMatchObject({ status: "done" })
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)

// s12-d: a fix built on the first implementer's commit landed both; the first
// implementer's commits are in the parent's HEAD and hold nothing up.
test("finish done passes when a done child's commits came in with another landing", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const repo = await makeRepo()
    try {
      const parent = { ...(await finishChild(root, repo, PASSING_TEST)), children: ["w-dddddddddddddddd"] }
      await saveRun(root, parent)
      const now = new Date().toISOString()
      await saveRun(root, baseRun({
        id: "w-dddddddddddddddd",
        parent: parent.id,
        directory: repo.dir,
        head: repo.head,
        sessionID: "ses_carried",
        attempts: [{ n: 1, state: "succeeded", startedAt: now, trigger: "delegate" }],
      }))
      await atomicJson(path.join(root, "runs", "w-dddddddddddddddd", "report-1.json"), { run: "w-dddddddddddddddd", attempt: 1, status: "done", summary: "done", commits: [{ sha: repo.head, subject: "feat: change" }] })
      const api = createTeamApi(context({ session: recordSession().domain }), teamState())
      expect(required(await api.finish(finishInput({ status: "done", summary: "All tasks landed." }), callerFor(parent)))).toMatchObject({ status: "done" })
    } finally {
      await removeRepo(repo.dir)
    }
  })
}, 30000)
