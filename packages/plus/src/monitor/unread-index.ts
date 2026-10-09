// Numeric range maxima for unread-write estimates. No compatible write/read
// pairs are retained: one read belongs to each of its reusable-prefix keys.
import type { RequestFingerprintData, RequestRow } from "./ledger.js"

export interface UnreadKey {
  readonly key: string
  readonly tail?: string
}

export interface UnreadKeyWork {
  prefixHashes: number
  prefixHits: number
  sharedKeys: number
}

export interface UnreadWrite {
  readonly row: number
  readonly at: number
  readonly tokens: number
  readonly cacheRead: number
  readonly lifetime: number
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly agent: string | undefined
  readonly isTitle: boolean
  readonly keys: readonly UnreadKey[]
}

export interface UnreadRead {
  readonly row: number
  readonly at: number
  readonly cacheRead: number
  readonly provider: string | undefined
  readonly model: string | undefined
  readonly agent: string | undefined
  readonly isTitle: boolean
  readonly keys: readonly UnreadKey[]
}

interface Maximum {
  readonly value: number
  readonly tail: string | undefined
}

interface Node {
  readonly first: number
  readonly last: number
  readonly all: readonly Maximum[]
  readonly real: readonly Maximum[]
  readonly left?: Node
  readonly right?: Node
}

interface Bucket {
  readonly length: number
  readonly capacity: number
  readonly root: Node
}

export interface UnreadIndex {
  readonly buckets: ReadonlyMap<string, Bucket>
  readonly subscriptions: ReadonlyMap<string, { expires: number; floor: number }>
  /** Actual construction work for this fold, not model/provider cache work. */
  readonly work: UnreadKeyWork & { rows: number; replayedRows: number; keys: number; memberships: number; nodes: number; copiedBuckets: number; copiedSubscriptions: number }
}

// Two maxima with distinct tails suffice to exclude one identical private tail.
// This is exact, not a capped candidate search or a sampled attribution.
function maxima(a: readonly Maximum[], b: readonly Maximum[]): readonly Maximum[] {
  const ordered = [...a, ...b].sort((a, b) => b.value - a.value)
  const first = ordered[0]
  if (!first) return []
  const second = ordered.find((entry) => entry.tail !== first.tail)
  return second ? [first, second] : [first]
}

function append(node: Node | undefined, capacity: number, position: number, leaf: Node, work: UnreadIndex["work"]): Node {
  work.nodes++
  if (capacity === 1) return leaf
  const left = position < capacity / 2 ? append(node?.left, capacity / 2, position, leaf, work) : node?.left
  const right = position < capacity / 2 ? node?.right : append(node?.right, capacity / 2, position - capacity / 2, leaf, work)
  return {
    first: left?.first ?? right!.first,
    last: right?.last ?? left!.last,
    all: maxima(left?.all ?? [], right?.all ?? []),
    real: maxima(left?.real ?? [], right?.real ?? []),
    left,
    right,
  }
}

function add(buckets: Map<string, Bucket>, subscriptions: UnreadIndex["subscriptions"], read: UnreadRead, work: UnreadIndex["work"]) {
  for (const key of read.keys) {
    work.keys++
    const id = JSON.stringify([read.provider, read.model, key.key])
    const subscription = subscriptions.get(id)
    if (!subscription || subscription.expires < read.at || read.cacheRead <= subscription.floor) continue
    work.memberships++
    const bucket = buckets.get(id)
    const grown = bucket && bucket.length === bucket.capacity
    const capacity = bucket ? bucket.capacity * (grown ? 2 : 1) : 1
    const root = grown ? { ...bucket.root, left: bucket.root, right: undefined } : bucket?.root
    const maximum = { value: read.cacheRead, tail: key.tail }
    buckets.set(id, {
      length: (bucket?.length ?? 0) + 1,
      capacity,
      root: append(root, capacity, bucket?.length ?? 0, {
        first: read.at, last: read.at, all: [maximum], real: read.isTitle ? [] : [maximum],
      }, work),
    })
  }
}

export function foldUnread(
  rows: readonly RequestRow[],
  fingerprints: ReadonlyMap<string, RequestFingerprintData | undefined>,
  lifetime: (row: RequestRow, fp: RequestFingerprintData | undefined) => number | undefined,
  keys: (fp: RequestFingerprintData | undefined, write: boolean, work?: UnreadKeyWork) => readonly UnreadKey[],
  previous?: { readonly writes: readonly UnreadWrite[]; readonly reads: readonly UnreadRead[]; readonly unreadIndex: UnreadIndex },
  from = 0,
) {
  const work = { rows: 0, replayedRows: 0, keys: 0, memberships: 0, nodes: 0, copiedBuckets: 0, copiedSubscriptions: 0, prefixHashes: 0, prefixHits: 0, sharedKeys: 0 }
  const reads = previous?.reads.filter((read) => read.row < from) ?? []
  const writes = previous?.writes.filter((write) => write.row < from) ?? []
  // Appends share immutable numeric trees. Corrections replay prefix reads and
  // the changed suffix; no stale fingerprint or usage result can survive replay.
  const appendOnly = previous &&
    previous.reads.every((read) => read.row < from) && previous.writes.every((write) => write.row < from)
  work.copiedBuckets = appendOnly ? previous.unreadIndex.buckets.size : 0
  work.copiedSubscriptions = appendOnly ? previous.unreadIndex.subscriptions.size : 0
  const buckets = new Map(appendOnly ? previous.unreadIndex.buckets : [])
  const subscriptions = new Map(appendOnly ? previous.unreadIndex.subscriptions : [])
  const subscribe = (write: UnreadWrite) => write.keys.forEach((key) => {
    const id = JSON.stringify([write.provider, write.model, key.key])
    const known = subscriptions.get(id)
    subscriptions.set(id, { expires: Math.max(known?.expires ?? 0, write.at + write.lifetime), floor: Math.min(known?.floor ?? Infinity, write.cacheRead) })
  })
  if (!appendOnly) {
    const prefixWrites = new Map(writes.map((write) => [write.row, write]))
    const prefixReads = new Map(reads.map((read) => [read.row, read]))
    for (let row = 0; row < from; row++) {
      work.replayedRows++
      const read = prefixReads.get(row)
      if (read) add(buckets, subscriptions, read, work)
      const write = prefixWrites.get(row)
      if (write) subscribe(write)
    }
  }
  rows.slice(from).forEach((row, index) => {
    work.rows++
    const fp = fingerprints.get(row.id)
    const identity = { row: from + index, at: row.started, cacheRead: row.cacheReadTokens, provider: row.provider, model: row.model, agent: row.agent, isTitle: row.isTitle }
    if (row.cacheReadTokens > 0) {
      const read = { ...identity, keys: keys(fp, false, work) }
      reads.push(read)
      add(buckets, subscriptions, read, work)
    }
    if (row.cacheWriteTokens <= 0) return
    const duration = lifetime(row, fp)
    if (duration === undefined) return
    const write = { ...identity, tokens: row.cacheWriteTokens, lifetime: duration, keys: keys(fp, true, work) }
    writes.push(write)
    subscribe(write)
  })
  return { reads, writes, unreadIndex: { buckets, subscriptions, work } }
}

function maximum(node: Node | undefined, after: number, expires: number, cutoff: number, titles: boolean, exclude: string | undefined, work?: { visits: number }): number {
  if (!node) return 0
  if (work) work.visits++
  if (node.last <= after || node.first > expires || node.first >= cutoff) return 0
  if (node.first > after && node.last <= expires && node.last < cutoff) {
    return (titles ? node.all : node.real).find((entry) => exclude === undefined || entry.tail !== exclude)?.value ?? 0
  }
  return Math.max(maximum(node.left, after, expires, cutoff, titles, exclude, work), maximum(node.right, after, expires, cutoff, titles, exclude, work))
}

export function unreadGain(index: UnreadIndex, write: UnreadWrite, cutoff: number, titles: boolean, work?: { visits: number }): number {
  const read = write.keys.reduce((best, key) => Math.max(best, maximum(
    index.buckets.get(JSON.stringify([write.provider, write.model, key.key]))?.root,
    write.at, write.at + write.lifetime, cutoff, titles, key.tail, work,
  )), 0)
  return Math.max(0, read - write.cacheRead)
}

const nodeWeights = new WeakMap<Node, { serializedBytes: number; nodes: number }>()
const indexWeights = new WeakMap<UnreadIndex, { serializedBytes: number; nodes: number; memberships: number; buckets: number; subscriptions: number }>()

/** Retained index objects absent from writes/reads/resume. This counts the UTF-8
 * serialization of numeric trees, map entries and construction-work metadata,
 * not engine/allocator heap bytes. Shared immutable subtrees are measured once
 * and reused across append folds. Keys already present on writes/reads are
 * deliberately counted here too: this is a conservative serialization budget.
 */
export function unreadIndexWeight(index: UnreadIndex) {
  const cached = indexWeights.get(index)
  if (cached) return cached
  const weight = {
    serializedBytes: Buffer.byteLength(JSON.stringify(index.work)) + 12,
    nodes: 0,
    memberships: 0,
    buckets: index.buckets.size,
    subscriptions: index.subscriptions.size,
  }
  for (const [key, bucket] of index.buckets) {
    const root = nodeWeight(bucket.root)
    // [key,{length,capacity,root}], including its list separator.
    weight.serializedBytes += Buffer.byteLength(JSON.stringify([key, { length: bucket.length, capacity: bucket.capacity, root: null }])) - 4 + root.serializedBytes + 1
    weight.nodes += root.nodes
    weight.memberships += bucket.length
  }
  for (const entry of index.subscriptions) weight.serializedBytes += Buffer.byteLength(JSON.stringify(entry)) + 1
  indexWeights.set(index, weight)
  return weight
}

function nodeWeight(node: Node): { serializedBytes: number; nodes: number } {
  const cached = nodeWeights.get(node)
  if (cached) return cached
  const left = node.left ? nodeWeight(node.left) : undefined
  const right = node.right ? nodeWeight(node.right) : undefined
  const weight = {
    serializedBytes: Buffer.byteLength(JSON.stringify({ first: node.first, last: node.last, all: node.all, real: node.real })) +
      (left ? left.serializedBytes + 8 : 0) + (right ? right.serializedBytes + 9 : 0),
    nodes: 1 + (left?.nodes ?? 0) + (right?.nodes ?? 0),
  }
  nodeWeights.set(node, weight)
  return weight
}
