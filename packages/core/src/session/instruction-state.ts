export * as InstructionState from "./instruction-state.js"

import { and, desc, eq, inArray, or, sql } from "drizzle-orm"
import { Effect, Option, Schema } from "effect"
import type { Database } from "../database/database.js"
import type { Bus } from "../bus.js"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { Instructions } from "../instructions/index.js"
import { SessionEvent } from "./event.js"
import { SessionSchema } from "./schema.js"
import { InstructionBlobTable, InstructionStateTable, SessionMessageTable } from "./sql.js"

type DatabaseService = Database.Interface["db"]

export interface Observation extends Instructions.Admission {
  readonly sessionID: SessionSchema.ID
  readonly initial: boolean
  readonly previous: Instructions.Values
  readonly current: Instructions.Values
}

export const observe = Effect.fn("InstructionState.observe")(function* (
  db: DatabaseService,
  instructions: Instructions.List,
  sessionID: SessionSchema.ID,
): Effect.fn.Return<Observation, Instructions.InitializationBlocked> {
  const stored = yield* find(db, sessionID)
  const observed = yield* Instructions.read(
    InstructionDiscovery.retain(instructions, Object.keys(stored?.current_values ?? {})),
  )
  const result = yield* observeAgainst(observed, stored?.current_values)
  return {
    sessionID,
    initial: !stored,
    previous: stored?.current_values ?? {},
    ...result,
  }
})

/** `rebase` takes a later change into the baseline unannounced: no notice, and the next request's system prompt has it. */
export const commit = Effect.fn("InstructionState.commit")(function* (
  db: DatabaseService,
  bus: Bus.Interface,
  instructions: Instructions.List,
  observation: Observation,
  rebase = false,
) {
  if (!observation.initial && Object.keys(observation.delta).length === 0) return
  // The rendered text is frozen into the durable event because re-rendering it
  // later would require the original Location-scoped instruction sources.
  const text = observation.initial || rebase ? "" : yield* renderUpdateText(db, instructions, observation)
  yield* bus.publish(
    SessionEvent.InstructionsUpdated,
    {
      sessionID: observation.sessionID,
      delta: observation.delta,
      ...(text.length > 0 ? { text } : {}),
      ...(rebase && !observation.initial ? { rebase: true as const } : {}),
    },
    {
      // Initial sync establishes the baseline; unlike later deltas it is not chronological history.
      ...(observation.initial ? { metadata: { instructions: { initial: true } } } : {}),
      commit: () => insertBlobs(db, observation.blobs),
    },
  )
})

const renderUpdateText = Effect.fnUntraced(function* (
  db: DatabaseService,
  instructions: Instructions.List,
  observation: Observation,
) {
  const replaced = Object.entries(observation.previous).filter(([key]) => Object.hasOwn(observation.delta, key))
  const blobs = yield* loadBlobs(
    db,
    replaced.map(([, hash]) => hash),
  )
  const previous = Object.fromEntries(replaced.map(([key, hash]) => [key, requireBlob(blobs, hash)]))
  const admitted = new Map(
    Object.entries(observation.blobs).map(([hash, value]) => [Instructions.Hash.make(hash), value]),
  )
  return Instructions.renderUpdate(
    InstructionDiscovery.retain(instructions, Object.keys(observation.previous)),
    previous,
    dereferenceDelta(observation.delta, admitted),
  )
})

/**
 * Admits the instructions' changes before a step. A change is announced in the history, so the cached prefix
 * stays valid, unless nothing is read from cache anyway: the chat was compacted and no step went out since,
 * or `rebase` says so for the chat (a cold one).
 */
export const prepare = Effect.fn("InstructionState.prepare")(function* (
  db: DatabaseService,
  bus: Bus.Interface,
  instructions: Instructions.List,
  sessionID: SessionSchema.ID,
  rebase: (sources: ReadonlyArray<string>) => Effect.Effect<boolean> = () => Effect.succeed(false),
) {
  const observation = yield* observe(db, instructions, sessionID)
  const sources = Object.keys(observation.delta)
  const absorbed =
    !observation.initial && sources.length > 0 && ((yield* compactedSinceStep(db, sessionID)) || (yield* rebase(sources)))
  yield* commit(db, bus, instructions, observation, absorbed)
})

/** Whether the chat's newest step or completed compaction is a compaction. A step is recorded once it gets an answer. */
const compactedSinceStep = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  const newest = yield* db
    .select({ type: SessionMessageTable.type })
    .from(SessionMessageTable)
    .where(
      and(
        eq(SessionMessageTable.session_id, sessionID),
        or(
          eq(SessionMessageTable.type, "assistant"),
          and(
            eq(SessionMessageTable.type, "compaction"),
            sql`json_extract(${SessionMessageTable.data}, '$.status') = 'completed'`,
          ),
        ),
      ),
    )
    .orderBy(desc(SessionMessageTable.seq))
    .limit(1)
    .get()
    .pipe(Effect.orDie)
  return newest?.type === "compaction"
})

export const apply = Effect.fn("InstructionState.apply")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  seq: number,
  delta: Instructions.Delta,
) {
  const stored = yield* find(db, sessionID)
  const current = Instructions.applyHashDelta(stored?.current_values ?? {}, delta)
  if (!stored) {
    yield* db
      .insert(InstructionStateTable)
      .values({
        session_id: sessionID,
        epoch_start: seq,
        through_seq: seq,
        initial_values: current,
        current_values: current,
      })
      .run()
      .pipe(Effect.orDie)
    return
  }
  yield* db
    .update(InstructionStateTable)
    .set({ through_seq: seq, current_values: current })
    .where(eq(InstructionStateTable.session_id, sessionID))
    .run()
    .pipe(Effect.orDie)
})

export const initialize = Effect.fn("InstructionState.initialize")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  seq: number,
  values: Instructions.Values,
) {
  yield* db
    .insert(InstructionStateTable)
    .values({
      session_id: sessionID,
      epoch_start: seq,
      through_seq: seq,
      initial_values: values,
      current_values: values,
    })
    .onConflictDoNothing()
    .run()
    .pipe(Effect.orDie)
})

export const advanceEpoch = Effect.fn("InstructionState.advanceEpoch")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  epochStart: number,
) {
  yield* db
    .update(InstructionStateTable)
    .set({
      epoch_start: epochStart,
      through_seq: epochStart,
      initial_values: sql`${InstructionStateTable.current_values}`,
    })
    .where(eq(InstructionStateTable.session_id, sessionID))
    .run()
    .pipe(Effect.orDie)
})

/**
 * Moves the epoch baseline to the chat's current instructions without a compaction; the event's
 * projection advances the epoch. False when the baseline already holds them.
 */
export const rebase = Effect.fn("InstructionState.rebase")(function* (
  db: DatabaseService,
  bus: Bus.Interface,
  sessionID: SessionSchema.ID,
) {
  const stored = yield* find(db, sessionID)
  if (!stored || sameValues(stored.initial_values, stored.current_values)) return false
  yield* bus.publish(SessionEvent.InstructionsUpdated, { sessionID, delta: {}, rebase: true })
  return true
})

export const reset = Effect.fn("InstructionState.reset")(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  yield* db
    .delete(InstructionStateTable)
    .where(eq(InstructionStateTable.session_id, sessionID))
    .run()
    .pipe(Effect.orDie)
})

/** Renders the epoch baseline shown at the start of every model request. */
export const initial = Effect.fn("InstructionState.initial")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  instructions: Instructions.List,
) {
  const state = yield* find(db, sessionID)
  if (!state) return yield* Effect.die(new Error(`Instruction state not found during assembly: ${sessionID}`))
  const values = dereference(state.initial_values, yield* loadBlobs(db, Object.values(state.initial_values)))
  return Instructions.renderInitialParts(
    InstructionDiscovery.retain(instructions, Object.keys(values), values),
    values,
  )
})

/** The sequence the epoch baseline was taken at; every instruction update before it is part of it. */
export const epochStart = Effect.fn("InstructionState.epochStart")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  return (yield* find(db, sessionID))?.epoch_start
})

/** The current instruction values, used to seed a fork's baseline. */
export const current = Effect.fn("InstructionState.current")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
) {
  return (yield* find(db, sessionID))?.current_values
})

export const preview = Effect.fn("InstructionState.preview")(function* (
  db: DatabaseService,
  sessionID: SessionSchema.ID,
  instructions: Instructions.List,
  observed: Instructions.ReadResult,
) {
  const state = yield* find(db, sessionID)
  const current = InstructionDiscovery.retain(instructions, Object.keys(state?.current_values ?? {}))
  const read = new Set(observed.map((entry) => entry.key))
  const retained = yield* Instructions.read(current.filter((source) => !read.has(source.key)))
  const result = yield* observeAgainst([...observed, ...retained], state?.current_values)
  const observedBlobs = new Map<Instructions.Hash, Schema.Json>(
    Object.entries(result.blobs).map(([hash, value]) => [Instructions.Hash.make(hash), value]),
  )
  if (!state) {
    const values = dereference(result.current, observedBlobs)
    return { initial: Instructions.renderInitialParts(instructions, values), update: "" }
  }
  const stored = yield* loadBlobs(db, [...Object.values(state.initial_values), ...Object.values(state.current_values)])
  const initial = dereference(state.initial_values, stored)
  return {
    initial: Instructions.renderInitialParts(
      InstructionDiscovery.retain(instructions, Object.keys(initial), initial),
      initial,
    ),
    update: Instructions.renderUpdate(
      current,
      dereference(state.current_values, stored),
      dereferenceDelta(result.delta, observedBlobs),
    ),
  }
})

const observeAgainst = Effect.fnUntraced(function* (observed: Instructions.ReadResult, previous?: Instructions.Values) {
  const admission = yield* Instructions.diff(observed, previous)
  return {
    current: Instructions.applyHashDelta(previous ?? {}, admission.delta),
    ...admission,
  }
})

const find = Effect.fnUntraced(function* (db: DatabaseService, sessionID: SessionSchema.ID) {
  return yield* db
    .select()
    .from(InstructionStateTable)
    .where(eq(InstructionStateTable.session_id, sessionID))
    .get()
    .pipe(Effect.orDie)
})

const insertBlobs = Effect.fnUntraced(function* (db: DatabaseService, blobs: Readonly<Record<string, Schema.Json>>) {
  const rows = Object.entries(blobs).map(([hash, value]) => ({ hash: Instructions.Hash.make(hash), value }))
  if (rows.length === 0) return
  yield* db.insert(InstructionBlobTable).values(rows).onConflictDoNothing().run().pipe(Effect.orDie)
})

const loadBlobs = Effect.fnUntraced(function* (db: DatabaseService, values: ReadonlyArray<Instructions.Hash>) {
  const hashes = [...new Set(values)]
  const batches = Array.from({ length: Math.ceil(hashes.length / 500) }, (_, index) =>
    hashes.slice(index * 500, (index + 1) * 500),
  )
  const rows = (yield* Effect.forEach(
    batches,
    (batch) =>
      db.select().from(InstructionBlobTable).where(inArray(InstructionBlobTable.hash, batch)).all().pipe(Effect.orDie),
    { concurrency: 4 },
  )).flat()
  const blobs = new Map(rows.map((row) => [row.hash, row.value]))
  for (const hash of hashes) {
    if (!blobs.has(hash)) return yield* Effect.die(new Error(`Instruction blob not found: ${hash}`))
  }
  return blobs
})

function sameValues(a: Instructions.Values, b: Instructions.Values) {
  const keys = Object.keys(a)
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key])
}

function dereference(
  values: Instructions.Values,
  blobs: ReadonlyMap<Instructions.Hash, Schema.Json>,
): Readonly<Record<string, Schema.Json>> {
  return Object.fromEntries(Object.entries(values).map(([key, hash]) => [key, requireBlob(blobs, hash)]))
}

function dereferenceDelta(
  delta: Instructions.Delta,
  blobs: ReadonlyMap<Instructions.Hash, Schema.Json>,
): Readonly<Record<string, Option.Option<Schema.Json>>> {
  return Object.fromEntries(
    Object.entries(delta).map(([key, hash]) => [
      key,
      hash === "removed" ? Option.none() : Option.some(requireBlob(blobs, hash)),
    ]),
  )
}

function requireBlob(blobs: ReadonlyMap<Instructions.Hash, Schema.Json>, hash: Instructions.Hash) {
  const value = blobs.get(hash)
  if (value === undefined) throw new Error(`Instruction blob not found: ${hash}`)
  return value
}
