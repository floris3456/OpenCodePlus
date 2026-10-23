export * as InstructionDiscovery from "./instruction-discovery.js"

import { Context, Effect, Layer, Option, Schema, Scope, Types } from "effect"
import { createHash } from "crypto"
import { dirname } from "path"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { FSUtil } from "@opencode/util/fs-util"
import { createPatch } from "diff"
import { Bus } from "./bus.js"
import { Environment } from "./environment/index.js"
import { Instructions } from "./instructions/index.js"
import { Location } from "./location.js"
import { State } from "./state.js"

export class File extends Schema.Class<File>("InstructionDiscovery.File")({
  // An absolute file path, or the URL of a configured remote instruction.
  path: Schema.String,
  content: Schema.String,
}) {}

// One source per file, keyed by its path. Raw absolute paths cannot be keys —
// instruction keys must match the Key pattern, so uppercase, spaces, and the
// leading slash are illegal. The key keeps a readable slug of the path plus a
// hash over the full path: stable across rebuilds, and unique across paths that
// differ only by case or punctuation.
const Files = Schema.Array(File)
const keyFor = (path: string) => {
  const slug = path
    .replace(/^\/+/, "")
    .toLowerCase()
    .replace(/[^a-z0-9._/-]+/g, "-")
    .replace(/^-+|-+$/g, "")
  const fingerprint = createHash("sha256").update(path, "utf8").digest("hex").slice(0, 12)
  return Instructions.Key.make(`core/instructions/${slug === "" ? "root" : slug}-${fingerprint}`)
}
// Deliberate key migration: sessions admitted before per-file sources hold durable
// `instruction_state` rows under the `core/instructions` aggregate key. After this
// change that key is simply absent and per-file keys appear; the old rows stop
// rendering because no source reads them anymore, and core models the absence plus
// the new keys as removed/added sources. Prompt content is unchanged — each file
// still renders `Instructions from: <path>\n<content>` — only part boundaries and
// identity change.
const legacy = Instructions.Key.make("core/instructions")

export const Event = {
  Updated: Bus.ephemeral({ type: "instruction-discovery.updated", schema: {} }),
}

export type Data = {
  files: Map<string, Types.DeepMutable<File>>
  // Explicitly removed paths keep a removal notice until the file returns. Rebuilds
  // replay transforms, so a plugin `remove` re-records its tombstone every rebuild
  // while a re-added file clears it; silent disk disappearances stay silent.
  removed: Set<string>
  available: boolean
}

export type Editor = {
  list: () => readonly Types.DeepMutable<File>[]
  // Map insertion order is render order: config adds global then nearest-to-farthest project files;
  // sibling contributors interleave by transform registration order.
  add: (file: File) => void
  update: (path: string, update: (file: Types.DeepMutable<File>) => void) => void
  remove: (path: string) => void
  unavailable: () => void
}

export interface Interface extends State.Transformable<Editor> {
  // Discovery policy lives here because internal plugins have no per-composition options channel.
  // Move it into plugin config once plugins can consume their own options.
  readonly project: boolean
  readonly global: boolean
  readonly list: () => Effect.Effect<File[] | Instructions.Unavailable>
  readonly load: () => Effect.Effect<Instructions.List>
  /**
   * Runs `check` at the start of every `load` while the calling scope is open: a source
   * whose files are not watched reads them again there, so a change reaches the next request.
   */
  readonly beforeLoad: (check: Effect.Effect<void>) => Effect.Effect<void, never, Scope.Scope>
}

export const Options = Schema.Struct({
  project: Schema.optional(Schema.Boolean),
  global: Schema.optional(Schema.Boolean),
})
export type Options = typeof Options.Type

export class Service extends Context.Service<Service, Interface>()("@opencode/InstructionDiscovery") {}

export const layer = (options?: Options) =>
  Layer.effect(
    Service,
    Effect.gen(function* () {
      const bus = yield* Bus.Service
      const location = yield* Effect.serviceOption(Location.Service).pipe(Effect.map(Option.getOrUndefined))
      const environment = yield* Effect.serviceOption(Environment.Service).pipe(Effect.map(Option.getOrUndefined))
      const state = State.create<Data, Editor>({
        name: "instruction-discovery",
        initial: () => ({ files: new Map(), removed: new Set(), available: true }),
        editor: (editor) => ({
          list: () => Array.from(editor.files.values()),
          add: (file) => {
            editor.files.set(file.path, new File(file) as Types.DeepMutable<File>)
            editor.removed.delete(file.path)
          },
          update: (path, update) => {
            const current = editor.files.get(path)
            if (!current) return
            update(current)
            current.path = path
          },
          remove: (path) => {
            if (!editor.files.delete(path)) return
            editor.removed.add(path)
          },
          unavailable: () => {
            editor.available = false
          },
        }),
        notify: () => bus.publish(Event.Updated, {}).pipe(Effect.asVoid),
      })

      // An outage keeps every per-file source and its last value: each source
      // reads unavailable, `diff` retains the stored hashes, and the per-file
      // renderers still resolve those values. The legacy aggregate key covers
      // no-longer-served rows admitted before per-file keys existed.
      const unavailable = (value: File) =>
        Instructions.make<File>({
          key: keyFor(value.path),
          path: value.path,
          codec: Schema.toCodecJson(File),
          read: Effect.succeed(Instructions.unavailable),
          render: {
            initial: (current) => render([current]),
            changed: (previous, current) => renderFileUpdate(previous, current),
            removed: (previous) => `The instructions from ${previous.path} no longer apply.`,
          },
        })

      const legacyUnavailable = Instructions.make<ReadonlyArray<File>>({
        key: legacy,
        codec: Schema.toCodecJson(Files),
        read: Effect.succeed(Instructions.unavailable),
        render: {
          initial: render,
          changed: renderUpdate,
          removed: () => "Previously loaded instructions no longer apply.",
        },
      })

      const file = (value: File) =>
        Instructions.make<File>({
          key: keyFor(value.path),
          path: value.path,
          codec: Schema.toCodecJson(File),
          read: Effect.succeed(value),
          render: {
            initial: (current) => render([current]),
            changed: (previous, current) => renderFileUpdate(previous, current),
            removed: (previous) => `The instructions from ${previous.path} no longer apply.`,
          },
        })

      const tombstone = (path: string): Instructions.Source => ({
        key: keyFor(path),
        path,
        read: Effect.succeed(Instructions.removed),
        initial: () => undefined,
        changed: () => undefined,
        removed: () => `The instructions from ${path} no longer apply.`,
      })

      const list = Effect.fn("InstructionDiscovery.list")(function* () {
        if (environment?.placement.kind === "unplaceable") return yield* Effect.die(environment.placement.error)
        const current = state.get()
        if (!current.available) return Instructions.unavailable
        return Array.from(current.files.values())
      })

      const checks = new Set<Effect.Effect<void>>()

      return Service.of({
        project: options?.project !== false,
        global: location?.workspaceID !== undefined ? false : options?.global !== false,
        transform: state.transform,
        reload: state.reload,
        list,
        beforeLoad: (check) =>
          Effect.acquireRelease(
            Effect.sync(() => checks.add(check)),
            () => Effect.sync(() => checks.delete(check)),
          ).pipe(Effect.asVoid),
        load: Effect.fn("InstructionDiscovery.load")(function* () {
          if (environment?.placement.kind === "unplaceable") return yield* Effect.die(environment.placement.error)
          yield* Effect.forEach(checks, (check) => check, { discard: true })
          const current = state.get()
          if (!current.available)
            return [
              ...Array.from(current.removed).map(tombstone),
              ...Array.from(current.files.values()).flatMap(unavailable),
              ...legacyUnavailable,
            ]
          return [
            ...Array.from(current.removed).map(tombstone),
            ...Array.from(current.files.values()).flatMap(file),
          ]
        }),
      })
    }),
  )

export function configured(options?: Options) {
  return makeLocationNode({
    service: Service,
    layer: layer(options),
    deps: [Bus.node],
  })
}

export const node = configured()

const decodeFile = Schema.decodeUnknownOption(Schema.toCodecJson(File))

/**
 * Adds the per-file sources a Session still holds but this Location does not
 * serve, as after a move. Each reads as removed, so the Session records once
 * that the file no longer applies, while the epoch baseline keeps rendering
 * the stored file where it stood: the cached prompt prefix survives the move.
 * `keys` are the Session's stored keys in stored order; `values` carries their
 * stored values where the caller has them (baseline rendering needs them).
 */
export function retain(
  list: Instructions.List,
  keys: ReadonlyArray<string>,
  values: Readonly<Record<string, Schema.Json>> = {},
): Instructions.List {
  const served = new Set<string>(list.map((source) => source.key))
  return keys
    .filter((key) => key.startsWith(`${legacy}/`) && !served.has(key))
    .reduce((placed, key) => {
      const value = values[key]
      const file = value === undefined ? undefined : Option.getOrUndefined(decodeFile(value))
      const at = retainedPosition(placed, file?.path, key, keys)
      return [
        ...placed.slice(0, at),
        ...Instructions.make<File>({
          key: Instructions.Key.make(key),
          ...(file === undefined ? {} : { path: file.path }),
          codec: Schema.toCodecJson(File),
          read: Effect.succeed(Instructions.removed),
          render: {
            initial: (current) => render([current]),
            changed: (previous, current) => renderFileUpdate(previous, current),
            removed: (previous) => `The instructions from ${previous.path} no longer apply.`,
          },
        }),
        ...placed.slice(at),
      ]
    }, list)
}

// Project files list nearest folder first, so a retained file goes before the
// first placed file whose folder holds its own; otherwise right after the
// source stored before it.
function retainedPosition(
  placed: Instructions.List,
  path: string | undefined,
  key: string,
  keys: ReadonlyArray<string>,
) {
  const folder = path === undefined ? undefined : dirname(path)
  const farther =
    folder === undefined
      ? -1
      : placed.findIndex(
          (source) =>
            source.path !== undefined &&
            dirname(source.path) !== folder &&
            FSUtil.contains(dirname(source.path), folder),
        )
  if (farther !== -1) return farther
  const before = new Set(keys.slice(0, keys.indexOf(key)))
  return placed.findLastIndex((source) => before.has(source.key)) + 1
}

function render(files: ReadonlyArray<File>) {
  return files.map((file) => `Instructions from: ${file.path}\n${file.content}`).join("\n\n")
}

function renderFileUpdate(previous: File, current: File) {
  const patch = createPatch(current.path, previous.content, current.content, "", "", { context: 3 })
  const diff = [
    `The instructions from ${current.path} changed. Here's the diff:`,
    "```diff",
    patch.slice(patch.indexOf("@@")).trimEnd(),
    "```",
  ].join("\n")
  const replacement = `The instructions changed:\n${render([current])}`
  return diff.length < replacement.length ? diff : replacement
}

function renderUpdate(previous: ReadonlyArray<File>, current: ReadonlyArray<File>) {
  const changes = Instructions.diffByKey(
    previous,
    current,
    (file) => file.path,
    (before, after) => before.content !== after.content,
  )
  return [
    ...changes.removed.map((file) => `The instructions from ${file.path} no longer apply.`),
    ...changes.added.map((file) => `New instructions apply from:\n${render([file])}`),
    ...changes.changed.map(({ previous: before, current: after }) => renderFileUpdate(before, after)),
  ].join("\n\n")
}
