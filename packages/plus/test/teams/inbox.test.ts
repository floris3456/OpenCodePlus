import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readdir, rename, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { batchNotify, partition, peek, pendingBytes, put, take } from "../../src/teams/inbox.js"
import type { InboxItem } from "../../src/teams/inbox.js"
import { readJson } from "../../src/teams/store.js"

let dir = ""

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "teams-inbox-"))
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

describe("inbox", () => {
  test("puts come back from peek in ULID order", async () => {
    const runID = "w-0123456789abcdef"
    const item1 = await put(dir, runID, { kind: "notify", from: "child-1", text: "msg 1" })
    const item2 = await put(dir, runID, { kind: "notify", from: "child-2", text: "msg 2" })
    const item3 = await put(dir, runID, { kind: "notify", from: "child-3", text: "msg 3" })
    const peeked = await peek(dir, runID)
    expect(peeked).toHaveLength(3)
    expect(peeked).toEqual([item1, item2, item3])
    expect(peeked[0].id < peeked[1].id).toBe(true)
  })

  test("take empties peek and moves files to processed", async () => {
    const runID = "w-0123456789abcdef"
    const item1 = await put(dir, runID, { kind: "brief", from: "parent", text: "do task" })
    const item2 = await put(dir, runID, { kind: "followup", from: "parent", text: "more context" })
    expect((await peek(dir, runID)).length).toBe(2)
    expect(await pendingBytes(dir, runID)).toBeGreaterThan(0)
    const taken = await take(dir, runID)
    expect(taken).toEqual([item1, item2])
    expect(await peek(dir, runID)).toEqual([])
    const processedDir = join(dir, "runs", runID, "inbox", "processed")
    const files = (await readdir(processedDir)).sort()
    expect(files).toEqual([`${item1.id}.json`, `${item2.id}.json`].sort())
    expect(await readJson<InboxItem>(join(processedDir, `${item1.id}.json`))).toEqual(item1)
    expect(await take(dir, runID)).toEqual([])
    expect(await pendingBytes(dir, runID)).toBe(0)
  })

  test("exceeding the byte bound throws E_INBOX_FULL and writes nothing", async () => {
    const runID = "w-0123456789abcdef"
    const item1 = await put(dir, runID, { kind: "notify", from: "c1", text: "first message" })
    const bytes1 = await pendingBytes(dir, runID)
    expect(bytes1).toBeGreaterThan(0)
    let err: unknown
    try {
      await put(dir, runID, { kind: "notify", from: "c2", text: "second message that will exceed" }, { inboxUnreadBytes: bytes1 + 10 })
    } catch (e) {
      err = e
    }
    expect(err).toBeDefined()
    const toolErr = err as { code?: string; message?: string; accepted?: unknown }
    expect(toolErr.code).toBe("E_INBOX_FULL")
    expect(toolErr.accepted).toBeDefined()
    expect(toolErr.message).toContain(`Run ${runID} has ${bytes1} bytes of undelivered inbox`)
    expect(await peek(dir, runID)).toEqual([item1])
    expect(await pendingBytes(dir, runID)).toBe(bytes1)
  })

  test("partition routes kinds and batchNotify joins synthetic lines", () => {
    const notifyItem: InboxItem = { id: "01J00000000000000000000001", kind: "notify", from: "c1", text: "line 1", at: 1 }
    const systemItem: InboxItem = { id: "01J00000000000000000000002", kind: "system", from: "s", text: "line 2", at: 2 }
    const briefItem: InboxItem = { id: "01J00000000000000000000003", kind: "brief", from: "p", text: "brief", at: 3 }
    const followupItem: InboxItem = { id: "01J00000000000000000000004", kind: "followup", from: "p", text: "follow", at: 4 }
    const shutdownItem: InboxItem = { id: "01J00000000000000000000005", kind: "shutdown", from: "p", text: "stop", at: 5 }
    const p = partition([briefItem, shutdownItem, systemItem, followupItem, notifyItem])
    expect(p.synthetic).toEqual([notifyItem, systemItem])
    expect(p.prompts).toEqual([briefItem, followupItem])
    expect(p.shutdown).toEqual([shutdownItem])
    const batched = batchNotify([notifyItem, systemItem, { ...notifyItem, id: "01J00000000000000000000003", text: "line 3\n" }])
    expect(batched.text.split("\n")).toHaveLength(3)
    const mixed = batchNotify([briefItem, shutdownItem, notifyItem, systemItem])
    expect(mixed.text).toBe("line 1\nline 2")
    expect(mixed.taken).toEqual([notifyItem, systemItem])
  })

  test("child.settled is synthetic and batches with the other synthetic kinds", async () => {
    const runID = "w-0123456789abcdef"
    const settled: InboxItem = { id: "01J00000000000000000000001", kind: "child.settled", from: "w-child", text: "settled: done", at: 1 }
    const notifyItem: InboxItem = { id: "01J00000000000000000000002", kind: "notify", from: "c1", text: "line 2", at: 2 }
    const followupItem: InboxItem = { id: "01J00000000000000000000003", kind: "followup", from: "p", text: "follow", at: 3 }
    const p = partition([followupItem, notifyItem, settled])
    expect(p.synthetic).toEqual([settled, notifyItem])
    expect(p.prompts).toEqual([followupItem])
    expect(batchNotify([followupItem, notifyItem, settled]).text).toBe("settled: done\nline 2")
    const written = await put(dir, runID, { kind: "child.settled", from: "w-child", text: "settled: done" })
    expect((await peek(dir, runID))[0]).toEqual(written)
    expect(await take(dir, runID)).toEqual([written])
  })

  test("empty inbox returns empty lists and zero bytes", async () => {
    expect(await peek(dir, "w-empty00000000000")).toEqual([])
    expect(await take(dir, "w-empty00000000000")).toEqual([])
    expect(await pendingBytes(dir, "w-empty00000000000")).toBe(0)
  })

  test("take skips already-moved files gracefully", async () => {
    const runID = "w-0123456789abcdef"
    const item1 = await put(dir, runID, { kind: "notify", from: "c1", text: "msg 1" })
    const item2 = await put(dir, runID, { kind: "notify", from: "c2", text: "msg 2" })
    const inboxDir = join(dir, "runs", runID, "inbox")
    await mkdir(join(inboxDir, "processed"), { recursive: true })
    await rename(join(inboxDir, `${item1.id}.json`), join(inboxDir, "processed", `${item1.id}.json`))
    const taken = await take(dir, runID)
    expect(taken).toEqual([item2])
    expect(await peek(dir, runID)).toEqual([])
  })
})
