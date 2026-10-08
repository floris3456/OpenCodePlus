// Fingerprint message lists are stored as deltas against the session's
// previous fingerprint (B35): a keyframe every 64 rows holds the full list,
// other rows store only the entries after `prefix_shared`. These tests prove
// the stored shape and that every read returns exactly the data that was
// written, across round trips, legacy files, changed rewrites and pruning.
import { afterEach, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "bun:sqlite"
import { createLedger, type Ledger } from "../src/monitor/ledger.js"
import type { MessagePrefixFingerprint, WireFingerprint } from "../src/monitor/fingerprint.js"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

async function tempFile(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(process.env.TMPDIR ?? os.tmpdir(), "plus-fp-deltas-"))
  dirs.push(dir)
  return path.join(dir, "monitor.db")
}

// A message entry as the fingerprint builder writes it.
function entry(idx: number, salt = "", chars = 120): MessagePrefixFingerprint {
  return {
    idx,
    role: idx % 2 === 0 ? "user" : "assistant",
    kind: "text",
    messageId: `msg_${idx}${salt}`,
    prefixHash: `hash_${idx}_${salt}`.padEnd(16, "0"),
    chars,
    estimatedTokens: Math.ceil(chars / 4),
  }
}

// A wire fingerprint whose message list is `list`; the other columns vary so
// each row is a distinct request.
function fingerprint(requestID: string, sessionID: string, list: MessagePrefixFingerprint[], created: number): WireFingerprint & { requestID: string; sessionID: string; created: number } {
  return {
    requestID,
    sessionID,
    created,
    protocol: "anthropic-messages",
    systemParts: [{ source: "base", hash: "s", chars: 10, estimatedTokens: 3 }],
    tools: [{ name: "read", descHash: "d", schemaHash: "c", chars: 4, estimatedTokens: 1 }],
    optionsHash: "opts",
    optionsKeys: { max_tokens: "x" },
    messagePrefixes: list,
    bodyHash: `body_${requestID}`,
  }
}

// The lists test 1 writes: growth of 1-3 entries per step, with an occasional
// rewrite of an early entry, as after a compaction.
function growingLists(count: number): MessagePrefixFingerprint[][] {
  const lists: MessagePrefixFingerprint[][] = []
  let list: MessagePrefixFingerprint[] = []
  for (let step = 0; step < count; step++) {
    const grown = [...list]
    const added = 1 + (step % 3)
    for (let i = 0; i < added; i++) grown.push(entry(grown.length))
    // A compaction rewrites an early entry every 17 steps.
    if (step % 17 === 5 && grown.length > 3) grown[1] = entry(1, `r${step}`)
    list = grown
    lists.push(list)
  }
  return lists
}

function stored(ledger: Ledger, requestID: string) {
  return ledger.db
    .query<{ message_prefixes: string; prefix_base: string | null; prefix_shared: number | null; prefix_depth: number | null }, [string]>(
      "select message_prefixes, prefix_base, prefix_shared, prefix_depth from request_fingerprint where request_id = ?",
    )
    .get(requestID)
}

test("200 growing fingerprints round trip and store deltas with keyframes every 64 rows", async () => {
  const file = await tempFile()
  const db = createLedger(file)
  try {
    const session = "ses_grow"
    const lists = growingLists(200)
    lists.forEach((list, index) => db.requestFingerprint(fingerprint(`req_${index}`, session, list, 1_000 + index)))

    // Every id decodes to exactly what was written...
    lists.forEach((list, index) => {
      expect(db.getFingerprint(`req_${index}`)?.messagePrefixes).toEqual(list)
    })
    // ...and so does the session read in one pass.
    const read = db.getFingerprints(session)
    expect(read.length).toBe(200)
    read.forEach((fp, index) => expect(fp.messagePrefixes).toEqual(lists[index]!))

    // Rows 0, 64, 128 and 192 are keyframes; the rest are deltas.
    for (let index = 0; index < 200; index++) {
      const row = stored(db, `req_${index}`)!
      const keyframe = index % 64 === 0
      if (keyframe) {
        expect(row.prefix_base).toBeNull()
        expect(row.prefix_depth).toBe(0)
        expect(JSON.parse(row.message_prefixes)).toEqual(lists[index]!)
      } else {
        expect(row.prefix_base).toBe(`req_${index - 1}`)
        expect(row.prefix_depth).toBe(index % 64)
        const shared = row.prefix_shared!
        expect(row.message_prefixes.length).toBeGreaterThan(0)
        expect(JSON.parse(row.message_prefixes)).toEqual(lists[index]!.slice(shared))
      }
    }
  } finally {
    db.close()
  }
})

test("a legacy full-row file migrates in place on read, once", async () => {
  const file = await tempFile()
  const seed = new Database(file, { create: true })
  // Today's pre-B35 schema: no prefix_* columns, full lists.
  seed.exec(`create table request_fingerprint (
    request_id text primary key, session_id text not null, protocol text not null,
    system_parts text not null default '[]', tools text not null default '[]',
    options_hash text not null default '', options_keys text not null default '{}',
    message_prefixes text not null default '[]', cache_key text, cache_control text,
    body_hash text not null, created integer not null);
    create table meta (key text primary key, value text not null);`)
  const lists = growingLists(90)
  const insert = seed.query(
    "insert into request_fingerprint (request_id, session_id, protocol, message_prefixes, body_hash, created) values (?, ?, 'anthropic-messages', ?, ?, ?)",
  )
  lists.forEach((list, index) =>
    insert.run(`req_${index}`, "ses_legacy", JSON.stringify(list), `body_${index}`, 1_000 + index),
  )
  seed.close()

  const db = createLedger(file)
  try {
    // The read returns exactly the legacy data.
    const first = db.getFingerprints("ses_legacy")
    expect(first.length).toBe(90)
    first.forEach((fp, index) => expect(fp.messagePrefixes).toEqual(lists[index]!))
    const revision = db.sessionRevision("ses_legacy")
    expect(revision).toBeGreaterThan(0)

    // Rows are deltas now, keyframes every 64.
    for (let index = 0; index < 90; index++) {
      const row = stored(db, `req_${index}`)!
      if (index % 64 === 0) expect(row.prefix_base).toBeNull()
      else expect(row.prefix_base).toBe(`req_${index - 1}`)
    }

    // A second read finds no legacy row and writes nothing.
    const second = db.getFingerprints("ses_legacy")
    second.forEach((fp, index) => expect(fp.messagePrefixes).toEqual(lists[index]!))
    expect(db.sessionRevision("ses_legacy")).toBe(revision)
  } finally {
    db.close()
  }
})

test("rewriting a middle fingerprint re-encodes the rows that chain on it", async () => {
  const file = await tempFile()
  const db = createLedger(file)
  try {
    const session = "ses_upsert"
    const lists = growingLists(100)
    lists.forEach((list, index) => db.requestFingerprint(fingerprint(`req_${index}`, session, list, 1_000 + index)))

    // Rewrite row 30's list (an early entry changed), then read every later row.
    const changed = [...lists[30]!]
    changed[0] = entry(0, "rewritten")
    db.requestFingerprint(fingerprint("req_30", session, changed, 1_030))

    expect(db.getFingerprint("req_30")?.messagePrefixes).toEqual(changed)
    for (const index of [29, 30, 31, 32, 33, 63, 64, 65, 99]) {
      const expected = index === 30 ? changed : lists[index]!
      expect(db.getFingerprint(`req_${index}`)?.messagePrefixes).toEqual(expected)
    }
    // The session read in one pass agrees.
    const read = db.getFingerprints(session)
    read.forEach((fp, index) =>
      expect(fp.messagePrefixes).toEqual(index === 30 ? changed : lists[index]!),
    )
  } finally {
    db.close()
  }
})

test("prune makes the first surviving fingerprint of each session a keyframe", async () => {
  const file = await tempFile()
  const db = createLedger(file)
  try {
    const session = "ses_prune"
    const lists = growingLists(140)
    lists.forEach((list, index) => db.requestFingerprint(fingerprint(`req_${index}`, session, list, 1_000 + index)))

    // Delete the first 70 rows: the survivor at index 70 was a delta whose
    // base is now gone, so it must have become a keyframe.
    db.prune(1_070)
    expect(stored(db, "req_70")).toMatchObject({ prefix_base: null, prefix_shared: 0, prefix_depth: 0 })
    expect(JSON.parse(stored(db, "req_70")!.message_prefixes)).toEqual(lists[70]!)

    // Every remaining row still decodes.
    for (let index = 70; index < 140; index++) {
      expect(db.getFingerprint(`req_${index}`)?.messagePrefixes).toEqual(lists[index]!)
    }
    const read = db.getFingerprints(session)
    read.forEach((fp, index) => expect(fp.messagePrefixes).toEqual(lists[index + 70]!))

    // A new fingerprint appended after the prune chains on the last survivor.
    const appended = [...lists[139]!, entry(139, "after-prune")]
    db.requestFingerprint(fingerprint("req_new", session, appended, 2_000))
    expect(db.getFingerprint("req_new")?.messagePrefixes).toEqual(appended)
  } finally {
    db.close()
  }
})

test("the delta encoding is below 10% of the legacy full-list size", async () => {
  const file = await tempFile()
  const db = createLedger(file)
  try {
    const lists = growingLists(200)
    const legacyBytes = lists.reduce((total, list) => total + JSON.stringify(list).length, 0)
    lists.forEach((list, index) => db.requestFingerprint(fingerprint(`req_${index}`, "ses_size", list, 1_000 + index)))
    const storedBytes = db.db
      .query<{ bytes: number }, []>("select sum(length(message_prefixes)) as bytes from request_fingerprint")
      .get()!.bytes
    expect(storedBytes).toBeLessThan(legacyBytes * 0.1)
  } finally {
    db.close()
  }
})