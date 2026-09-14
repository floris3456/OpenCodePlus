export * as InstructionDiscovery from "./instruction-discovery.js"

import { Context, Effect, Layer, Schema, Types } from "effect"
import { createHash } from "crypto"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { createPatch } from "diff"
import { Bus } from "./bus.js"
import { Instructions } from "./instructions/index.js"
import { AbsolutePath } from "./schema.js"
import { State } from "./state.js"

export class File extends Schema.Class<File>("InstructionDiscovery.File")({
  path: AbsolutePath,
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
  files: Map<AbsolutePath, Types.DeepMutable<File>>
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
            const current = editor.files.get(AbsolutePath.make(path))
            if (!current) return
            update(current)
            current.path = AbsolutePath.make(path)
          },
          remove: (path) => {
            if (!editor.files.delete(AbsolutePath.make(path))) return
            editor.removed.add(AbsolutePath.make(path))
          },
          unavailable: () => {
            editor.available = false
          },
        }),
        notify: () => bus.publish(Event.Updated, {}).pipe(Effect.asVoid),
      })

      // The aggregate key survives only for outages: an unavailable read retains the
      // stored value and blocks only the initial complete delta, exactly as before.
      const unavailable = Instructions.make<ReadonlyArray<File>>({
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
        read: Effect.succeed(Instructions.removed),
        initial: () => undefined,
        changed: () => undefined,
        removed: () => `The instructions from ${path} no longer apply.`,
      })

      const list = Effect.fn("InstructionDiscovery.list")(function* () {
        const current = state.get()
        if (!current.available) return Instructions.unavailable
        return Array.from(current.files.values())
      })

      return Service.of({
        project: options?.project !== false,
        global: options?.global !== false,
        transform: state.transform,
        reload: state.reload,
        list,
        load: Effect.fn("InstructionDiscovery.load")(function* () {
          const current = state.get()
          if (!current.available) return unavailable
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
