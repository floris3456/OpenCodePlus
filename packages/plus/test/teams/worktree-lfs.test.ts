// A member's "LFS files in its worktrees" row decides whether the worktree
// `delegate` creates for it gets the LFS content (the default) or pointer
// files. These tests use a real repository with real git-lfs filters, so they
// skip on a machine without git-lfs: nothing else reproduces the smudge
// command a worktree checkout runs.
import { afterAll, beforeAll, expect, test } from "bun:test"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import { Session } from "@opencode/schema/session"
import { Effect, Schema } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { context } from "../harness.js"
import { controlItems } from "../../src/instructions/agent-controls.js"
import { lfsRowsOf, type ApplyInput } from "../../src/instructions/apply.js"
import { createTeamApi, type TeamCaller } from "../../src/teams/api.js"
import { git } from "../../src/teams/git.js"
import { loadRun, saveRun, type RunRecord } from "../../src/teams/run.js"
import { Brief } from "../../src/teams/schema.js"
import { create as createWorktree } from "../../src/teams/worktree.js"
import { change, linked, presetInput, shippedTeam, teamState } from "./preset-table.js"

const POINTER = "version https://git-lfs.github.com/spec/v1"
const CONTENT = Buffer.from("real LFS content, not a pointer\n".repeat(40))

// The LFS filters are written by `git lfs install --local`, which needs the
// binary; without it the repository is an ordinary one and proves nothing.
const skip = Bun.spawnSync(["git", "lfs", "version"], { stdout: "pipe", stderr: "pipe" }).exitCode === 0
  ? false
  : "git lfs is not installed on this machine"
if (skip !== false) console.log(`[worktree-lfs] ${skip}: skipping the LFS worktree tests`)

let scratch = ""
let repo = ""
let stateDir = ""
let wsRoot = ""
let base = ""

// `delegate` reads its root from teamsDataDir(), so the test scopes
// XDG_DATA_HOME to a fresh directory and restores it afterwards.
async function withIsolatedTeamsRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const tmp = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-team-lfs-"))
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

beforeAll(async () => {
  if (skip !== false) return
  scratch = await fs.mkdtemp(path.join(os.tmpdir(), "teams-wt-lfs-"))
  repo = path.join(scratch, "repo")
  stateDir = path.join(scratch, "state")
  wsRoot = path.join(scratch, "ws")
  await fs.mkdir(repo, { recursive: true })
  await fs.mkdir(wsRoot, { recursive: true })
  await git(repo, ["init", "-b", "main"])
  await git(repo, ["config", "user.email", "teams@test.local"])
  await git(repo, ["config", "user.name", "teams"])
  await git(repo, ["lfs", "install", "--local"])
  await fs.writeFile(path.join(repo, ".gitattributes"), "*.bin filter=lfs diff=lfs merge=lfs -text\n")
  await fs.writeFile(path.join(repo, "asset.bin"), CONTENT)
  await fs.writeFile(path.join(repo, "README.md"), "fixture\n")
  await git(repo, ["add", ".gitattributes", "asset.bin", "README.md"])
  await git(repo, ["commit", "-m", "chore: lfs fixture"])
  base = await git(repo, ["rev-parse", "HEAD"])
  // The main checkout holds the content: that is what the smudge filter the
  // pointer worktree skips would have produced.
  expect(await fs.readFile(path.join(repo, "asset.bin"))).toEqual(CONTENT)
})

afterAll(async () => {
  if (scratch !== "") await fs.rm(scratch, { recursive: true, force: true })
})

const worktree = (name: string, lfs?: "pointers") => ({
  repoRoot: repo,
  repoKey: "opencode",
  role: "implementer",
  name,
  base,
  workspaceRoot: wsRoot,
  ...(lfs === undefined ? {} : { lfs }),
})

test.skipIf(skip !== false)("a pointers worktree holds the LFS pointer text and a clean status", async () => {
  const created = await createWorktree(stateDir, worktree("pointers", "pointers"))
  const file = path.join(created.dir, "asset.bin")
  const text = await fs.readFile(file, "utf8")
  expect(text.startsWith(POINTER)).toBe(true)
  expect(text).toContain("oid sha256:")
  expect(await git(created.dir, ["status", "--porcelain"])).toBe("")
  // A checkpoint-shaped commit (stage the files the run names, then commit)
  // leaves the pointer alone: the clean filter keeps it, so the LFS file is
  // not "modified" afterwards either.
  await fs.writeFile(path.join(created.dir, "notes.md"), "work\n")
  await git(created.dir, ["add", "--", "notes.md"])
  expect(await git(created.dir, ["status", "--porcelain"])).toBe("A  notes.md")
  await git(created.dir, ["-c", "user.name=team", "-c", "user.email=team@test.local", "commit", "-m", "docs: note"])
  expect(await git(created.dir, ["status", "--porcelain"])).toBe("")
  expect(await fs.readFile(file, "utf8")).toBe(text)
})

test.skipIf(skip !== false)("without the setting the worktree holds the LFS content", async () => {
  const created = await createWorktree(stateDir, worktree("full"))
  expect(await fs.readFile(path.join(created.dir, "asset.bin"))).toEqual(CONTENT)
  expect(await git(created.dir, ["status", "--porcelain"])).toBe("")
})

// The row resolves through the same chain a publish uses: a member's stored
// `setting:lfs` text with the control rows discovery publishes beside the
// team rows.
function inputWith(records: ApplyInput["records"]): ApplyInput {
  const input = presetInput({ members: [linked("implementer", "implementer")], records })
  return { ...input, items: [...input.items, ...controlItems()] }
}

const member = { id: "implementer", team: shippedTeam }

test("only a member whose row says pointers is in the set", () => {
  const rows = (text: string) => [...lfsRowsOf(inputWith([change(member, "setting:lfs", { text })])).keys()]
  expect(rows("pointers")).toEqual(["implementer"])
  expect(rows("full")).toEqual([])
  expect(rows("")).toEqual([])
  expect([...lfsRowsOf(inputWith([])).keys()]).toEqual([])
})

function recordSession() {
  const created: unknown[] = []
  const prompted: Array<{ sessionID: unknown; text: unknown }> = []
  let seq = 0
  // Narrow host double: the handlers only read child.id and pass the prompt on.
  const domain = {
    create: (input: unknown) => {
      created.push(input)
      seq += 1
      return Effect.succeed({ id: Session.ID.make(`ses_child_${seq}`) })
    },
    prompt: (input: { sessionID: unknown; text: unknown }) => {
      prompted.push({ sessionID: input.sessionID, text: input.text })
      return Effect.succeed(undefined as never)
    },
    switchModel: () => Effect.succeed(undefined as never),
  } as unknown as SessionDomain
  return { created, prompted, domain }
}

function parentRun(): RunRecord {
  const now = new Date().toISOString()
  return {
    id: "main-0123456789abcdef",
    role: "orchestrator",
    kind: "main",
    repo: "opencode",
    repoKey: "opencode",
    directory: repo,
    paths: [],
    branch: "main",
    base,
    head: base,
    state: "idle",
    attempts: [],
    task: null,
    parent: null,
    children: [],
    briefSha: "abc",
    bundle: "lfs-test",
    budget: {},
    createdAt: now,
    lastUsed: now,
    sessionID: "ses_parent_lfs",
    configDigest: null,
    history: [],
  }
}

// Delegates one Brief through the real handler, with `pointers` standing in
// for the set a publish computes from the member's row.
async function delegateTo(root: string, pointers: boolean) {
  const parent = parentRun()
  await saveRun(root, parent)
  const sessions = recordSession()
  const state = teamState()
  state.lfsPointers = pointers ? new Set(lfsRowsOf(inputWith([change(member, "setting:lfs", { text: "pointers" })])).keys()) : new Set()
  const api = createTeamApi(context({ session: sessions.domain }), state)
  const caller: TeamCaller = { sessionID: "ses_parent_lfs", agent: "orchestrator", run: parent }
  const brief = Schema.decodeUnknownSync(Brief)({
    requestID: "lfs-1",
    role: "implementer",
    objective: "Read the binary asset and describe what its bytes start with.",
    deliverable: { kind: "report" },
    scope: { paths: ["asset.bin"] },
    checks: [],
    effort: "small",
  })
  const result = await api.delegate(brief, caller)
  if (!result.ok) throw new Error(`delegate failed: ${JSON.stringify(result.error)}`)
  return { value: result.value as { run: string }, sessions }
}

test.skipIf(skip !== false)("delegate gives a pointers member pointer files, a record field and a Brief line", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { value, sessions } = await delegateTo(root, true)
    const child = await loadRun(root, value.run)
    if (child === undefined) throw new Error("missing child run")
    expect(child.lfs).toBe("pointers")
    expect((await fs.readFile(path.join(child.directory, "asset.bin"), "utf8")).startsWith(POINTER)).toBe(true)
    expect(await git(child.directory, ["status", "--porcelain"])).toBe("")
    const brief = await Bun.file(path.join(root, "runs", value.run, "brief.md")).text()
    expect(brief).toContain(
      `## Environment\nWorktree: ${child.directory} (your session's working directory).\nLFS files here are pointer files; \`git lfs pull --include <path>\` fetches one.`,
    )
    // The child reads exactly the file on disk, so the Brief it was prompted
    // with is the stored one.
    expect(sessions.prompted[0]?.text).toBe(brief)
  })
})

test.skipIf(skip !== false)("delegate without the row keeps the LFS content and says nothing about pointers", async () => {
  await withIsolatedTeamsRoot(async (root) => {
    const { value } = await delegateTo(root, false)
    const child = await loadRun(root, value.run)
    if (child === undefined) throw new Error("missing child run")
    expect(child.lfs).toBeUndefined()
    expect(await fs.readFile(path.join(child.directory, "asset.bin"))).toEqual(CONTENT)
    const brief = await Bun.file(path.join(root, "runs", value.run, "brief.md")).text()
    expect(brief).toContain(`## Environment\nWorktree: ${child.directory} (your session's working directory).`)
    expect(brief).not.toContain("pointer files")
  })
})
