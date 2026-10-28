import { expect, test } from "bun:test"
import type { SessionDomain } from "@opencode/plugin/effect/session"
import { Session } from "@opencode/schema/session"
import { Effect } from "effect"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { context } from "../harness.js"
import {
  briefResendKey,
  briefResendMessageID,
  BRIEF_RESEND_PREFIX,
  resetBriefResends,
  resendBriefAfterCompaction,
} from "../../src/teams/brief-resend.js"
import { saveRun, type RunRecord } from "../../src/teams/run.js"
import { atomicJson } from "../../src/teams/store.js"

// The Brief a child started from is its first prompt, and core's compaction
// summarises it away: a completed compaction in the child's own session sends
// it again whole, once, as a steer.

async function withIsolatedTeamsRoot<T>(fn: (root: string) => Promise<T>): Promise<T> {
  const parent = process.env.TMPDIR ?? os.tmpdir()
  const tmp = await fs.mkdtemp(path.join(parent, "plus-team-brief-resend-"))
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

function recordSession() {
  const prompted: Array<{ id?: unknown; sessionID: unknown; text: unknown; delivery?: unknown }> = []
  const domain = {
    get: () => Effect.succeed({ id: Session.ID.make("ses_child_001") }),
    prompt: (input: { id?: unknown; sessionID: unknown; text: unknown; delivery?: unknown }) => {
      prompted.push({ id: input.id, sessionID: input.sessionID, text: input.text, delivery: input.delivery })
      return Effect.succeed(undefined as never)
    },
  } as unknown as SessionDomain
  return { prompted, domain }
}

function baseRun(overrides: Partial<RunRecord> & { id: string }): RunRecord {
  const now = new Date().toISOString()
  return {
    role: "implementer",
    kind: "w",
    repo: "opencode",
    repoKey: "opencode",
    directory: process.cwd(),
    paths: [],
    branch: "team/implementer/test",
    base: "0123456789abcdef0123456789abcdef01234567",
    head: "0123456789abcdef0123456789abcdef01234567",
    state: "working",
    attempts: [{ n: 1, state: "streaming", startedAt: now, trigger: "delegate" }],
    task: null,
    parent: "main-0123456789abcdef",
    children: [],
    briefSha: "abc",
    bundle: "team-brief-resend-test",
    budget: {},
    createdAt: now,
    lastUsed: now,
    sessionID: "ses_child_001",
    configDigest: null,
    history: [],
    ...overrides,
  }
}

const BRIEF = "# Implementer: fix the filter\n\nFix the agent filter in the query module so scoped listing works as documented."

async function writeBrief(root: string, run: RunRecord): Promise<void> {
  await fs.mkdir(path.join(root, "runs", run.id), { recursive: true })
  await fs.writeFile(path.join(root, "runs", run.id, "brief.md"), BRIEF, "utf8")
  await atomicJson(path.join(root, "runs", run.id, "brief.json"), {
    requestID: "brief-1",
    role: run.role,
    objective: "Fix the agent filter in the query module so scoped listing works as documented.",
    deliverable: { kind: "commit" },
    scope: { paths: ["src/*"], forbidden: [] },
    interfaces: [],
    decisions: [],
    checks: [],
    effort: "medium",
  })
}

const EVENT = { id: "evt_compaction_one", sessionID: "ses_child_001" }

test("a completed compaction in a working child's session sends the Brief again whole, once", async () => {
  resetBriefResends()
  await withIsolatedTeamsRoot(async (root) => {
    const child = baseRun({ id: "w-aaaaaaaaaaaaaaaa" })
    await saveRun(root, child)
    await writeBrief(root, child)
    const session = recordSession()

    expect(await resendBriefAfterCompaction(context({ session: session.domain }), root, EVENT)).toBe(true)
    expect(session.prompted).toEqual([
      {
        id: briefResendMessageID(briefResendKey(child.id, EVENT.id)),
        sessionID: "ses_child_001",
        text: `${BRIEF_RESEND_PREFIX}\n\n${BRIEF}`,
        delivery: "steer",
      },
    ])
    // The same event again (a duplicate delivery) sends nothing more.
    expect(await resendBriefAfterCompaction(context({ session: session.domain }), root, EVENT)).toBe(false)
    expect(session.prompted).toHaveLength(1)
    // A later compaction is a new condense and sends the Brief again.
    expect(
      await resendBriefAfterCompaction(context({ session: session.domain }), root, { ...EVENT, id: "evt_compaction_two" }),
    ).toBe(true)
    expect(session.prompted).toHaveLength(2)
  })
})

test("the steer id is stable per run and compaction, so a restart replays the same inbox item", () => {
  const first = briefResendMessageID(briefResendKey("w-aaaaaaaaaaaaaaaa", "evt_one"))
  expect(first).toBe(briefResendMessageID(briefResendKey("w-aaaaaaaaaaaaaaaa", "evt_one")))
  expect(first.startsWith("msg_")).toBe(true)
  expect(first).not.toBe(briefResendMessageID(briefResendKey("w-aaaaaaaaaaaaaaaa", "evt_two")))
  expect(first).not.toBe(briefResendMessageID(briefResendKey("w-bbbbbbbbbbbbbbbb", "evt_one")))
})

test("a lead's own run, a stopped run, a settled idle run and a run with no Brief get nothing", async () => {
  resetBriefResends()
  await withIsolatedTeamsRoot(async (root) => {
    const session = recordSession()
    const ctx = context({ session: session.domain })
    const lead = baseRun({ id: "main-bbbbbbbbbbbbbbbb", kind: "main", parent: null, sessionID: "ses_lead_001", role: "orchestrator" })
    await saveRun(root, lead)
    await writeBrief(root, lead)
    expect(await resendBriefAfterCompaction(ctx, root, { id: "evt_a", sessionID: "ses_lead_001" })).toBe(false)

    const stopped = baseRun({ id: "w-cccccccccccccccc", state: "stopped", sessionID: "ses_stopped_001" })
    await saveRun(root, stopped)
    await writeBrief(root, stopped)
    expect(await resendBriefAfterCompaction(ctx, root, { id: "evt_b", sessionID: "ses_stopped_001" })).toBe(false)

    const settled = baseRun({
      id: "w-dddddddddddddddd",
      state: "idle",
      sessionID: "ses_settled_001",
      attempts: [{ n: 1, state: "succeeded", startedAt: new Date().toISOString(), trigger: "delegate", endedAt: new Date().toISOString() }],
    })
    await saveRun(root, settled)
    await writeBrief(root, settled)
    expect(await resendBriefAfterCompaction(ctx, root, { id: "evt_c", sessionID: "ses_settled_001" })).toBe(false)

    const noBrief = baseRun({ id: "w-eeeeeeeeeeeeeeee", sessionID: "ses_nobrief_001" })
    await saveRun(root, noBrief)
    expect(await resendBriefAfterCompaction(ctx, root, { id: "evt_d", sessionID: "ses_nobrief_001" })).toBe(false)

    // A session with no run at all is ignored.
    expect(await resendBriefAfterCompaction(ctx, root, { id: "evt_e", sessionID: "ses_stranger_001" })).toBe(false)
    expect(session.prompted).toEqual([])
  })
})

test("an idle child whose attempt is still open is continuing its turn, so it is steered", async () => {
  resetBriefResends()
  await withIsolatedTeamsRoot(async (root) => {
    const child = baseRun({ id: "w-ffffffffffffffff", state: "idle", sessionID: "ses_open_001" })
    await saveRun(root, child)
    await writeBrief(root, child)
    const session = recordSession()
    expect(await resendBriefAfterCompaction(context({ session: session.domain }), root, { id: "evt_f", sessionID: "ses_open_001" })).toBe(true)
    expect(session.prompted).toHaveLength(1)
  })
})
