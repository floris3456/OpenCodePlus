export * as ConfigInstructionPlugin from "./instruction.js"

import { define } from "@opencode/plugin/effect/plugin"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import path, { join } from "path"
import { Effect, FiberMap, PubSub, Semaphore, Stream } from "effect"
import { HttpClient, HttpClientRequest } from "effect/http"
import { Config } from "../../config.js"
import { Watcher } from "../../filesystem/watcher.js"
import { InstructionDiscovery } from "../../instruction-discovery.js"
import { Instructions } from "../../instructions/index.js"
import { Location } from "../../location.js"

type Loaded =
  | { readonly type: "available"; readonly files: InstructionDiscovery.File[] }
  | { readonly type: "unavailable" }

export const Plugin = define({
  id: "opencode.config.instruction",
  effect: Effect.fn(function* (ctx) {
    const discovery = yield* InstructionDiscovery.Service
    // Activate even when both discovery scopes are disabled: configured `instructions`
    // entries are explicit requests, not discovery.
    yield* Effect.gen(function* () {
      const config = yield* Config.Service
      const fs = yield* FSUtil.Service
      const global = yield* Global.Service
      const http = HttpClient.filterStatusOk(yield* HttpClient.HttpClient)
      const location = yield* Location.Service
      const watcher = yield* Watcher.Service
      const changes = yield* PubSub.sliding<string>(1)
      const watches = yield* FiberMap.make<string>()
      const lock = Semaphore.makeUnsafe(1)
      const start = yield* fs.resolve(location.directory)
      const root = yield* fs.resolve(location.project.directory)
      const home = yield* fs.resolve(global.home)
      const project = discovery.project && FSUtil.contains(root, start)
      const stop = FSUtil.contains(home, start) ? home : root
      const globalFile = yield* fs.resolve(join(global.config, "AGENTS.md"))
      const loaded: { current: Loaded; project: readonly InstructionDiscovery.File[] } = {
        current: { type: "available", files: [] },
        project: [],
      }
      const configured: { sources: string[]; remote: Map<string, InstructionDiscovery.File> } = {
        sources: [],
        remote: new Map(),
      }

      const publish = (update: Watcher.Update) => PubSub.publish(changes, update.path).pipe(Effect.asVoid)
      // Service-wide sources only: the global file is watched, so global
      // edits still land in every loaded folder. A project's own AGENTS.md
      // files are never watched (one watch set per loaded folder is what
      // scaled with the team): they load at boot, on demand (the next chat,
      // or `/refresh`), and are read again before each request (`recheck`).
      // Configured `instructions` entries are watched below.
      const candidates = [...(discovery.global ? [globalFile] : [])]
      for (const file of new Set(candidates)) {
        const updates = yield* watcher.subscribe({ path: file, type: "file" })
        yield* updates.pipe(Stream.runForEach(publish), Effect.forkScoped({ startImmediately: true }))
      }

      // A missing file may be mid-save and is transient; a denied file (e.g. outside a sandbox grant) stays absent.
      const read = Effect.fn("ConfigInstructionPlugin.read")(function* (filepath: string) {
        return yield* fs.readFileString(filepath).pipe(
          Effect.map((content) => new InstructionDiscovery.File({ path: filepath, content })),
          Effect.catchIf(
            (error) => error.reason._tag === "NotFound" || FSUtil.isAccessDenied(error),
            (error) =>
              Effect.logDebug("instruction file skipped", { path: filepath, reason: error.reason._tag }).pipe(
                Effect.as(error.reason._tag === "NotFound" ? undefined : ("denied" as const)),
              ),
          ),
        )
      })

      const globalSource = Effect.fn("ConfigInstructionPlugin.globalSource")(function* () {
        if (!discovery.global || !(yield* fs.isFile(globalFile))) return []
        const file = yield* read(globalFile)
        return file instanceof InstructionDiscovery.File ? [file] : []
      })

      const projectSource = Effect.fn("ConfigInstructionPlugin.projectSource")(function* () {
        if (!project) return []
        const walked = yield* Effect.forEach(
          yield* fs.up({ targets: ["AGENTS.md"], start, stop, type: "file" }),
          fs.resolve,
        )
        const discovered = new Set(walked.filter((file) => discovery.global || file !== globalFile))
        const files = yield* Effect.forEach(discovered, read, { concurrency: "unbounded" })
        if (files.some((file) => file === undefined)) return Instructions.unavailable
        return files.filter((file) => file instanceof InstructionDiscovery.File)
      })

      // Relative patterns search upward from the location to the project root. Without
      // project discovery they resolve against the global config directory instead.
      const match = Effect.fn("ConfigInstructionPlugin.match")(function* (source: string) {
        const expanded = source.startsWith("~/") ? path.join(global.home, source.slice(2)) : source
        const options = { absolute: true, include: "file", dot: true } as const
        if (path.isAbsolute(expanded))
          return yield* fs
            .scan(path.basename(expanded), { ...options, cwd: path.dirname(expanded) })
            .pipe(Effect.orElseSucceed(() => [] as string[]))
        if (project) return yield* fs.globUp(expanded, start, root)
        if (!discovery.global) return []
        return yield* fs
          .scan(expanded, { ...options, cwd: global.config })
          .pipe(Effect.orElseSucceed(() => [] as string[]))
      })

      const configuredSource = Effect.fn("ConfigInstructionPlugin.configuredSource")(function* () {
        const files: InstructionDiscovery.File[] = []
        const watched = new Set<string>()
        for (const source of configured.sources) {
          if (isUrl(source)) {
            const file = configured.remote.get(source)
            if (file) files.push(file)
            continue
          }
          for (const item of (yield* match(source)).toSorted()) {
            const resolved = yield* fs.resolve(item)
            if (watched.has(resolved)) continue
            watched.add(resolved)
            const file = yield* read(resolved)
            if (file instanceof InstructionDiscovery.File) files.push(file)
          }
        }
        for (const [key] of Array.from(watches)) if (!watched.has(key)) yield* FiberMap.remove(watches, key)
        for (const file of watched) {
          const updates = yield* watcher.subscribe({ path: file, type: "file" })
          yield* FiberMap.run(watches, file, updates.pipe(Stream.runForEach(publish)), {
            onlyIfMissing: true,
            startImmediately: true,
          })
        }
        return files
      })

      // Remote instructions are fetched only when config loads, not on every file rescan.
      // A failed fetch keeps the last good copy or skips the URL, so an unreachable URL
      // never makes the whole instruction set unavailable.
      const reconfigure = Effect.fn("ConfigInstructionPlugin.reconfigure")(
        function* () {
          const entries = yield* config.entries()
          const sources = Array.from(
            new Set(entries.flatMap((entry) => (entry.type === "document" ? (entry.info.instructions ?? []) : []))),
          )
          const fetched = yield* Effect.forEach(
            sources.filter(isUrl),
            (url) =>
              HttpClientRequest.get(url).pipe(
                http.execute,
                Effect.flatMap((response) => response.text),
                Effect.timeout("5 seconds"),
                Effect.map((content) => new InstructionDiscovery.File({ path: url, content })),
                Effect.catchCause((cause) =>
                  Effect.logWarning("failed to fetch instruction url", { url, cause }).pipe(
                    Effect.as(configured.remote.get(url)),
                  ),
                ),
              ),
            { concurrency: 4 },
          )
          configured.sources = sources
          configured.remote = new Map(
            fetched.filter((file) => file !== undefined).map((file) => [file.path, file] as const),
          )
        },
        (effect) => lock.withPermit(effect),
      )

      const isolate = <A, E, R>(source: string, effect: Effect.Effect<A, E, R>) =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to load instruction source", { source, cause }).pipe(
              Effect.as(Instructions.unavailable),
            ),
          ),
        )

      const refresh = Effect.fn("ConfigInstructionPlugin.refresh")(
        function* (file?: string) {
          const sources = yield* Effect.all({
            global: isolate("global", globalSource()),
            project: isolate("project", projectSource()),
            configured: isolate("configured", configuredSource()),
          })
          loaded.current =
            Array.isArray(sources.global) && Array.isArray(sources.project) && Array.isArray(sources.configured)
              ? { type: "available", files: [...sources.global, ...sources.project, ...sources.configured] }
              : { type: "unavailable" }
          if (Array.isArray(sources.project)) loaded.project = sources.project
          if (!file) return
          yield* Effect.logDebug("instructions rescanned", {
            file,
            instructions:
              loaded.current.type === "available" ? loaded.current.files.map((item) => item.path) : "unavailable",
          })
        },
        (effect, ..._args: [file?: string]) => lock.withPermit(effect),
      )

      // Editor saves arrive as bursts of watcher events; settle before rescanning once. Subscribe
      // before debouncing so no update slips through while the debounce starts its pull.
      const updates = yield* PubSub.subscribe(changes)
      yield* Stream.fromSubscription(updates).pipe(
        Stream.debounce("100 millis"),
        Stream.runForEach((file) => refresh(file).pipe(Effect.andThen(discovery.reload()))),
        Effect.forkScoped({ startImmediately: true }),
      )
      // Subscribe before the first config read so an update in between still triggers a reload.
      yield* ctx.event.subscribe().pipe(
        Stream.filter((event) => event.type === "config.updated"),
        Stream.runForEach(() => reconfigure().pipe(Effect.andThen(refresh()), Effect.andThen(discovery.reload()))),
        Effect.forkScoped({ startImmediately: true }),
      )
      // The folder's AGENTS.md files, walked again before each request: an edit, a new file
      // or a deleted one reaches the chats this folder serves at their next step, announced
      // as an instructions update, instead of only a new chat or `/refresh` seeing it.
      const recheck = Effect.fn("ConfigInstructionPlugin.recheck")(function* () {
        if (!project) return
        const files = yield* isolate("project", projectSource())
        const unchanged = Array.isArray(files)
          ? loaded.current.type === "available" && sameFiles(files, loaded.project)
          : loaded.current.type === "unavailable"
        if (unchanged) return
        yield* refresh("AGENTS.md")
        yield* discovery.reload()
      })
      yield* discovery.beforeLoad(recheck())

      yield* reconfigure()
      yield* refresh()
      yield* discovery.transform((editor) => {
        if (loaded.current.type === "unavailable") {
          editor.unavailable()
          return
        }
        for (const file of loaded.current.files) editor.add(file)
      })
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("failed to activate instruction source", { cause }).pipe(
          Effect.andThen(discovery.transform((editor) => editor.unavailable())),
          Effect.asVoid,
        ),
      ),
    )
  }),
})

function sameFiles(a: readonly InstructionDiscovery.File[], b: readonly InstructionDiscovery.File[]) {
  return a.length === b.length && a.every((file, index) => file.path === b[index]?.path && file.content === b[index]?.content)
}

function isUrl(source: string) {
  return URL.canParse(source) && /^https?:$/.test(new URL(source).protocol)
}
