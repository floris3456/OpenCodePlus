import type { PlusApi } from "../index.js"
import type { Plus } from "../rpc.js"
import { contentOf, keyIdentity, recordIdentity, recordKeyOf } from "./delta.js"
import type { StoredRecord } from "./store.js"

// One call that changes several rows: every op runs against one in-memory
// store (the snapshot it reads carries the changes made so far), and the call
// writes once at the end, so it is one store revision, one log entry and one
// publish. Record writes (`mutate`) and placement (`layoutWrite`) are staged;
// an op that writes anything else (a file, a team, a link) first writes what
// is staged, then runs as itself. A dry run stages the same way, never writes,
// and refuses those other writes, since it cannot show them.
export interface Staged {
  readonly api: PlusApi
  /** Write what is staged (once); the rows it covered stay pending until then. */
  readonly commit: () => Promise<Written>
  /** Changes made so far: staged record and layout changes and direct writes. */
  readonly changes: () => number
  /** A row that succeeded: its staged change is written, or fails, with the next write. */
  readonly settle: (row: string) => void
  /** Rows whose staged change a write refused, with the reason. */
  readonly refused: () => readonly { readonly id: string; readonly reason: string }[]
  /** Store writes made (staged writes and direct ones). */
  readonly writes: () => number
}

export interface Written {
  readonly revision?: number
  readonly globalRevision?: number
}

// SnapshotRecord carries every field recordIdentity and recordKeyOf read.
const identityOf = (record: Plus.SnapshotRecord) => recordIdentity(record as unknown as StoredRecord)

const reads = new Set<keyof PlusApi>(["snapshot", "log", "assembled", "catalogModels", "listTeams"])

export function stagedApi(real: PlusApi, options: { readonly dryRun: boolean; readonly status?: () => string }): Staged {
  const state: {
    base?: Plus.Snapshot
    view?: Plus.Snapshot
    // identity → the staged record (undefined: removed), relative to base.
    records: Map<string, Plus.SnapshotRecord | undefined>
    layout?: { folders: readonly Plus.SnapshotFolderRecord[]; orders: readonly Plus.SnapshotOrderRecord[]; targets: string[] }
    actor?: Plus.Actor
    changes: number
    writes: number
    pending: string[]
    refused: { id: string; reason: string }[]
    written: Written
  } = { records: new Map(), changes: 0, writes: 0, pending: [], refused: [], written: {} }

  const current = async () => {
    if (state.view !== undefined) return state.view
    const snapshot = await real.snapshot()
    state.base = snapshot.value
    return snapshot.value
  }

  const stage = (base: Plus.Snapshot, upsert: readonly Plus.SnapshotRecord[], remove: readonly Plus.RecordKey[]) => {
    const now = new Map((state.view ?? base).records.map((record) => [identityOf(record), record] as const))
    const differs = [
      ...upsert.filter((record) => {
        const known = now.get(identityOf(record))
        return known === undefined || contentOf(known as unknown as StoredRecord) !== contentOf(record as unknown as StoredRecord)
      }),
      ...remove.filter((key) => now.has(keyIdentity(key))),
    ].length
    for (const key of remove) state.records.set(keyIdentity(key), undefined)
    for (const record of upsert) state.records.set(identityOf(record), record)
    const touched = new Set(state.records.keys())
    state.view = {
      ...base,
      records: [
        ...base.records.filter((record) => !touched.has(identityOf(record))),
        ...[...state.records.values()].filter((record) => record !== undefined),
      ],
      ...(state.layout === undefined ? {} : { folders: [...state.layout.folders], orders: [...state.layout.orders] }),
    }
    return differs
  }

  const flush = async (): Promise<{ error?: string }> => {
    const base = state.base
    if (state.view === undefined || base === undefined) return {}
    const before = new Map(base.records.map((record) => [identityOf(record), record] as const))
    const upsert = [...state.records.entries()].flatMap(([key, record]) => {
      if (record === undefined) return []
      const known = before.get(key)
      return known !== undefined && contentOf(known as unknown as StoredRecord) === contentOf(record as unknown as StoredRecord) ? [] : [record]
    })
    const remove = [...state.records.entries()].flatMap(([key, record]) => {
      const known = before.get(key)
      if (record !== undefined || known === undefined) return []
      const recordKey = recordKeyOf(known as unknown as StoredRecord)
      return recordKey === undefined ? [] : [recordKey]
    })
    const layout = state.layout
    const actor = state.actor
    const pending = state.pending
    state.view = undefined
    state.base = undefined
    state.records = new Map()
    state.layout = undefined
    state.pending = []
    if (upsert.length === 0 && remove.length === 0 && layout === undefined) return {}
    const error = await write(base, { upsert, remove }, layout, actor)
    if (error !== undefined) state.refused.push(...pending.map((id) => ({ id, reason: `not saved: ${error}` })))
    return error === undefined ? {} : { error }
  }

  const write = async (
    base: Plus.Snapshot,
    changes: Plus.MutateChanges,
    layout: { folders: readonly Plus.SnapshotFolderRecord[]; orders: readonly Plus.SnapshotOrderRecord[]; targets: string[] } | undefined,
    actor: Plus.Actor | undefined,
  ): Promise<string | undefined> => {
    state.writes++
    if (layout !== undefined) {
      const written = await real.layoutWrite({
        expectedProjectRevision: base.revision,
        expectedGlobalRevision: base.globalRevision,
        changes,
        folders: [...layout.folders],
        orders: [...layout.orders],
        target: layout.targets[0] ?? "records",
        status: options.status?.() ?? `${layout.targets.length} change(s)`,
        ...(actor === undefined ? {} : { actor }),
      })
      if (!written.ok) return `${written.error.code}: ${written.error.message}`
      state.written = { revision: written.value.revision, globalRevision: written.value.globalRevision }
      return undefined
    }
    const result = await real.mutate({ changes, ...(actor === undefined ? {} : { actor }) })
    if (!result.ok) return `${result.error.code}: ${result.error.message}`
    if (!result.value.ok) return "stale: delta write was refused"
    state.written = { revision: result.value.revision, globalRevision: result.value.globalRevision }
    return undefined
  }

  const refuse = (name: string) => ({
    ok: false as const,
    error: { code: "dryRun", message: `a dry run cannot show what ${name} would write (it changes files or server rows directly); run it without dryRun`, data: {} },
  })

  const direct = Object.fromEntries(
    (Object.keys(real) as (keyof PlusApi)[]).map((name) => {
      const method = real[name] as (...args: unknown[]) => Promise<unknown>
      if (reads.has(name)) return [name, method]
      return [
        name,
        async (...args: unknown[]) => {
          if (options.dryRun) return refuse(name)
          await flush()
          state.changes++
          state.writes++
          return method(...args)
        },
      ]
    }),
  ) as unknown as PlusApi

  const api: PlusApi = {
    ...direct,
    snapshot: async () => ({ ok: true as const, value: await current() }),
    // With nothing staged a refresh is the real one; staged changes publish with the commit.
    refresh: async () => (state.view === undefined && !options.dryRun ? real.refresh() : { ok: true as const, value: await current() }),
    mutate: async (input, mutateOptions) => {
      if (!("changes" in input)) {
        if (options.dryRun) return refuse("a whole-store write") as never
        await flush()
        state.writes++
        state.changes++
        return real.mutate(input, mutateOptions)
      }
      await current()
      const base = state.base!
      state.actor ??= input.actor
      state.changes += stage(base, input.changes.upsert, input.changes.remove) > 0 ? 1 : 0
      return { ok: true as const, value: { ok: true as const, revision: base.revision, globalRevision: base.globalRevision } }
    },
    layoutWrite: async (input) => {
      const view = await current()
      const base = state.base!
      if (input.expectedProjectRevision !== view.revision || input.expectedGlobalRevision !== view.globalRevision)
        return { ok: false as const, error: { code: "layout.invalid" as const, message: "the folders changed since they were read; read them again and retry", data: { code: "layout.invalid" as const, reason: "stale" } } }
      state.actor ??= input.actor
      state.layout = { folders: input.folders, orders: input.orders, targets: [...(state.layout?.targets ?? []), input.target] }
      stage(base, input.changes?.upsert ?? [], input.changes?.remove ?? [])
      state.changes++
      return { ok: true as const, value: { changed: true, revision: base.revision, globalRevision: base.globalRevision, status: input.status } }
    },
  }

  return {
    api,
    commit: async () => {
      if (!options.dryRun) await flush()
      return state.written
    },
    changes: () => state.changes,
    settle: (row) => {
      if (state.view !== undefined) state.pending.push(row)
    },
    refused: () => state.refused,
    writes: () => state.writes,
  }
}
