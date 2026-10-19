import { describe, expect } from "bun:test"
import { Deferred, Effect, Fiber, Layer, PlatformError, PubSub, Stream } from "effect"
import { HttpClient, HttpClientResponse } from "effect/http"
import fs from "fs/promises"
import path from "path"
import { AppNodeBuilder } from "@opencode/core/effect/app-node-builder"
import { Bus } from "@opencode/core/bus"
import { Config } from "@opencode/core/config"
import { ConfigInstructionPlugin } from "@opencode/core/config/plugin/instruction"
import { Watcher } from "@opencode/core/filesystem/watcher"
import { InstructionDiscovery } from "@opencode/core/instruction-discovery"
import { Location } from "@opencode/core/location"
import { AbsolutePath } from "@opencode/core/schema"
import { Document, Info } from "@opencode/schema/config"
import { Event } from "@opencode/schema/event"
import { FSUtil } from "@opencode/util/fs-util"
import { Global } from "@opencode/util/global"
import { LayerNode } from "@opencode/util/effect/layer-node"
import { tempGlobalLayer } from "./fixture/global"
import { location } from "./fixture/location"
import { tmpdir } from "./fixture/tmpdir"
import { readInitial, readUpdate, state } from "./lib/instructions"
import { testEffect } from "./lib/effect"
import { host } from "./plugin/host"

const it = testEffect(Layer.empty)

const instructionLayer = (input: {
  config?: string
  home?: string
  locationServiceLayer: Layer.Layer<Location.Service>
  filesystemLayer?: Layer.Layer<FSUtil.Service>
  instructions?: string[]
  http?: HttpClient.HttpClient
  project?: boolean
}) => {
  const watcher = Watcher.testLayer
  const config = Config.testLayer(input.instructions ? [configured(input.instructions)] : [])
  return Layer.mergeAll(
    AppNodeBuilder.build(
      LayerNode.group([
        InstructionDiscovery.node,
        Bus.node,
        Config.node,
        FSUtil.node,
        Global.node,
        Location.node,
        Watcher.node,
      ]),
      [
        Config.node.replace(config),
        InstructionDiscovery.node.replace(InstructionDiscovery.configured({ project: input.project })),
        Global.node.replace(
          input.config || input.home
            ? Global.layerWith({
                ...(input.config ? { config: input.config } : {}),
                ...(input.home ? { home: input.home } : {}),
              })
            : tempGlobalLayer,
        ),
        Location.node.replace(input.locationServiceLayer),
        Watcher.node.replace(watcher),
        ...(input.filesystemLayer ? [FSUtil.node.replace(input.filesystemLayer)] : []),
      ],
    ),
    watcher,
    config,
    Layer.succeed(HttpClient.HttpClient, input.http ?? respond(() => new Response(null, { status: 404 }))),
  )
}

const start = Effect.fnUntraced(function* (ctx = host()) {
  yield* ConfigInstructionPlugin.Plugin.effect(ctx)
  return yield* InstructionDiscovery.Service
})

const configured = (instructions: string[]) => new Document({ type: "document", info: new Info({ instructions }) })

const readFailure = (tag: "NotFound" | "Unknown", code: string, file: string) =>
  PlatformError.systemError({
    _tag: tag,
    module: "FileSystem",
    method: "readFile",
    pathOrDescriptor: file,
    cause: Object.assign(new Error(code), { code }),
  })

const configUpdated = () => ({ id: Event.ID.create(), created: Date.now(), type: "config.updated" as const, data: {} })

const respond = (handler: (url: string) => Response) =>
  HttpClient.make((request) => Effect.succeed(HttpClientResponse.fromWeb(request, handler(request.url))))

const file = (path: string, content: string) => new InstructionDiscovery.File({ path, content })

function emitAndWait(update: Watcher.Update) {
  return Effect.gen(function* () {
    const watcher = yield* Watcher.Test
    yield* triggerAndWait(watcher.emit(update))
  })
}

function triggerAndWait<E, R>(trigger: Effect.Effect<void, E, R>) {
  return Effect.gen(function* () {
    const bus = yield* Bus.Service
    const updated = yield* Deferred.make<void>()
    const fiber = yield* bus.subscribe(InstructionDiscovery.Event.Updated).pipe(
      Stream.runForEach(() => Deferred.succeed(updated, undefined).pipe(Effect.asVoid)),
      Effect.forkScoped,
    )
    yield* Effect.yieldNow
    yield* trigger
    yield* Deferred.await(updated).pipe(Effect.timeout("2 seconds"))
    yield* Fiber.interrupt(fiber)
  })
}

describe("InstructionDiscovery", () => {
  it.effect("stores ordered values with last-write-wins precedence", () =>
    Effect.gen(function* () {
      const discovery = yield* InstructionDiscovery.Service
      yield* discovery.transform((editor) => {
        editor.add(file("/repo/AGENTS.md", "first"))
        editor.add(file("/repo/packages/AGENTS.md", "package"))
        editor.add(file("/repo/AGENTS.md", "last"))
        editor.update("/repo/packages/AGENTS.md", (current) => {
          current.content = "updated"
          current.path = AbsolutePath.make("/ignored")
        })
        editor.remove("/missing")
      })

      expect(yield* discovery.list()).toEqual([
        file("/repo/AGENTS.md", "last"),
        file("/repo/packages/AGENTS.md", "updated"),
      ])
    }).pipe(
      Effect.provide(
        LayerNode.compile(LayerNode.group([InstructionDiscovery.node, Bus.node]), {
          replacements: [
            Bus.node.replace(
              Layer.mock(Bus.Service, {
                publish: (definition, data) => {
                  // `Payload<D>` is per-call-site; a generic mock body cannot produce it without a cast.
                  const event = {
                    id: Event.ID.create(),
                    created: Date.now(),
                    type: definition.type,
                    data,
                  } as Event.Payload<typeof definition>
                  return Effect.succeed(event)
                },
              }),
            ),
          ],
        }),
      ),
    ),
  )

  it.effect("preserves admitted values while the source is unavailable", () =>
    Effect.gen(function* () {
      const discovery = yield* InstructionDiscovery.Service
      yield* discovery.transform((editor) => editor.unavailable())
      expect(
        (yield* readUpdate(
          yield* discovery.load(),
          state({ "core/instructions": [{ path: "/repo/AGENTS.md", content: "old" }] }),
        )).changed,
      ).toBe(false)
    }).pipe(
      Effect.provide(
        LayerNode.compile(LayerNode.group([InstructionDiscovery.node, Bus.node]), {
          replacements: [
            Bus.node.replace(
              Layer.mock(Bus.Service, {
                publish: (definition, data) => {
                  // `Payload<D>` is per-call-site; a generic mock body cannot produce it without a cast.
                  const event = {
                    id: Event.ID.create(),
                    created: Date.now(),
                    type: definition.type,
                    data,
                  } as Event.Payload<typeof definition>
                  return Effect.succeed(event)
                },
              }),
            ),
          ],
        }),
      ),
    ),
  )

  it.effect("renders granular instruction updates", () =>
    Effect.gen(function* () {
      const discovery = yield* InstructionDiscovery.Service
      yield* discovery.transform((editor) => {
        editor.add(file("/global/AGENTS.md", "global"))
        editor.add(
          file("/repo/AGENTS.md", ["old", ...Array.from({ length: 20 }, (_, index) => `keep ${index}`)].join("\n")),
        )
      })
      const initial = yield* readInitial(yield* discovery.load())

      yield* discovery.transform((editor) => {
        editor.update("/repo/AGENTS.md", (current) => {
          current.content = ["new", ...Array.from({ length: 20 }, (_, index) => `keep ${index}`)].join("\n")
        })
      })
      const modified = (yield* readUpdate(yield* discovery.load(), initial)).text
      expect(modified).toContain("The instructions from /repo/AGENTS.md changed. Here's the diff:")
      expect(modified).toContain("-old\n+new")
      expect(modified).not.toContain("global")

      // Per-file keys changed this case: the legacy aggregate state no longer
      // shares a key with the updated file, so the update renders as the new
      // file's own initial text rather than the aggregate diff-replacement.
      const rewritten = state({
        "core/instructions": [{ path: "/repo/AGENTS.md", content: "old one\nold two\nold three\nold four" }],
      })
      yield* discovery.transform((editor) => {
        editor.remove("/global/AGENTS.md")
        editor.update("/repo/AGENTS.md", (current) => {
          current.content = "new"
        })
      })
      expect((yield* readUpdate(yield* discovery.load(), rewritten)).text).toBe(
        "Instructions from: /repo/AGENTS.md\nnew",
      )

      yield* discovery.transform((editor) => {
        editor.add(file("/repo/packages/AGENTS.md", "package"))
      })
      const structural = (yield* readUpdate(yield* discovery.load(), initial)).text
      expect(structural).toContain("The instructions from /global/AGENTS.md no longer apply.")
      // Per-file keys changed the added-file rendering here: added and changed
      // files render through their own initial text rather than the legacy
      // aggregate "New instructions apply from:" wrapper.
      expect(structural).toContain("Instructions from: /repo/AGENTS.md\nnew")
      expect(structural).toContain("Instructions from: /repo/packages/AGENTS.md\npackage")
      expect(structural).not.toContain("Instructions from: /global/AGENTS.md\nglobal")
    }).pipe(
      Effect.provide(
        LayerNode.compile(LayerNode.group([InstructionDiscovery.node, Bus.node]), {
          replacements: [
            Bus.node.replace(
              Layer.mock(Bus.Service, {
                publish: (definition, data) => {
                  // `Payload<D>` is per-call-site; a generic mock body cannot produce it without a cast.
                  const event = {
                    id: Event.ID.create(),
                    created: Date.now(),
                    type: definition.type,
                    data,
                  } as Event.Payload<typeof definition>
                  return Effect.succeed(event)
                },
              }),
            ),
          ],
        }),
      ),
    ),
  )
})

describe("ConfigInstructionPlugin.Plugin", () => {
  it.live("loads global and upward project files and watches only the global file", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const home = path.join(tmp.path, "home")
        const shared = path.join(home, "code")
        const project = path.join(shared, "repo")
        const directory = path.join(project, "packages", "core")
        const outside = path.join(tmp.path, "AGENTS.md")
        const globalFile = path.join(global, "AGENTS.md")
        const sharedFile = path.join(shared, "AGENTS.md")
        const projectFile = path.join(project, "AGENTS.md")
        const packageFile = path.join(directory, "AGENTS.md")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(global, { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await fs.writeFile(outside, "outside")
            await fs.writeFile(globalFile, "global")
            await fs.writeFile(sharedFile, "shared")
            await fs.writeFile(projectFile, "project")
            await fs.writeFile(packageFile, "package")
          })

          const discovery = yield* start()
          const watcher = yield* Watcher.Test
          // Project files are read at boot and on each rescan, never watched per folder.
          expect(yield* watcher.subscriptions()).toEqual([{ path: globalFile, type: "file" }])
          const initialized = yield* readInitial(yield* discovery.load())
          expect(initialized.text).toBe(
            [
              `Instructions from: ${globalFile}\nglobal`,
              `Instructions from: ${packageFile}\npackage`,
              `Instructions from: ${projectFile}\nproject`,
              `Instructions from: ${sharedFile}\nshared`,
            ].join("\n\n"),
          )
          expect(initialized.text).not.toContain("outside")

          // A project edit reaches the folder on its next rescan; a global change rescans here.
          yield* Effect.promise(() => fs.writeFile(packageFile, "changed"))
          yield* emitAndWait({ type: "update", path: globalFile })
          const changed = (yield* readUpdate(yield* discovery.load(), initialized)).text
          // Per-file keys changed the replacement rendering: a single changed
          // file renders through the aggregate `changed` renderer as "The
          // instructions changed:" plus its own initial text, not as a
          // per-file diff.
          expect(changed).toContain(`The instructions changed:\nInstructions from: ${packageFile}\nchanged`)
          expect(changed).not.toContain(`Instructions from: ${globalFile}\nglobal`)

          yield* Effect.promise(() => fs.rm(packageFile))
          yield* emitAndWait({ type: "update", path: globalFile })
          const removed = (yield* readUpdate(yield* discovery.load(), initialized)).text
          // Per-file keys changed this too: silent disk disappearances leave no
          // tombstones, so a deleted file renders no removal sentence through
          // the disk-refresh path (explicit transform removals still do).
          expect(removed).toBe("")
          expect(removed).not.toContain(`Instructions from: ${globalFile}\nglobal`)

          yield* Effect.promise(() => fs.rm(projectFile))
          yield* Effect.promise(() => fs.rm(sharedFile))
          yield* Effect.promise(() => fs.rm(globalFile))
          yield* emitAndWait({ type: "delete", path: globalFile })
          // Per-file keys changed this too: silent disk disappearances leave no
          // tombstones, so the dead files render no removal text and the update
          // is empty — the aggregate "no longer apply" sentence only fires for
          // legacy-keyed previous state, not for per-file keys.
          expect((yield* readUpdate(yield* discovery.load(), initialized)).text).toBe("")
        }).pipe(
          Effect.provide(
            instructionLayer({
              config: global,
              home,
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(
                  location(
                    { directory: AbsolutePath.make(directory) },
                    { projectDirectory: AbsolutePath.make(project) },
                  ),
                ),
              ),
            }),
          ),
        )
      }),
    ),
  )

  it.live("loads configured files, globs, home paths, and URLs alongside AGENTS.md", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const project = path.join(tmp.path, "repo")
        const directory = path.join(project, "packages", "core")
        const agents = path.join(project, "AGENTS.md")
        const first = path.join(project, "rules", "a.md")
        const second = path.join(project, "rules", "b.md")
        const absolute = path.join(tmp.path, "absolute.md")
        const homeFile = path.join(tmp.path, "home.md")
        const remote = "https://example.test/instructions.md"
        const requests: string[] = []
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(path.dirname(first), { recursive: true })
            await fs.mkdir(directory, { recursive: true })
            await Promise.all([
              fs.writeFile(agents, "agents"),
              fs.writeFile(first, "first"),
              fs.writeFile(second, "second"),
              fs.writeFile(absolute, "absolute"),
              fs.writeFile(homeFile, "home"),
            ])
          })

          const discovery = yield* start()
          const initialized = yield* readInitial(yield* discovery.load())
          // The unreachable URL and missing file are skipped without making AGENTS.md unavailable.
          expect(initialized.text).toBe(
            [
              `Instructions from: ${agents}\nagents`,
              `Instructions from: ${first}\nfirst`,
              `Instructions from: ${second}\nsecond`,
              `Instructions from: ${absolute}\nabsolute`,
              `Instructions from: ${homeFile}\nhome`,
              `Instructions from: ${remote}\nremote`,
            ].join("\n\n"),
          )

          yield* Effect.promise(() => fs.writeFile(first, "changed"))
          yield* emitAndWait({ type: "update", path: first })
          expect((yield* readUpdate(yield* discovery.load(), initialized)).text).toBe(
            `The instructions changed:\nInstructions from: ${first}\nchanged`,
          )
          // File rescans reuse fetched URLs instead of requesting them again.
          expect(requests).toHaveLength(2)
        }).pipe(
          Effect.provide(
            instructionLayer({
              config: path.join(tmp.path, "global"),
              home: tmp.path,
              instructions: [
                "rules/*.md",
                absolute,
                "~/home.md",
                remote,
                "missing.md",
                "https://example.test/missing.md",
              ],
              http: respond((url) => {
                requests.push(url)
                return url === remote ? new Response("remote") : new Response(null, { status: 404 })
              }),
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(
                  location(
                    { directory: AbsolutePath.make(directory) },
                    { projectDirectory: AbsolutePath.make(project) },
                  ),
                ),
              ),
            }),
          ),
        )
      }),
    ),
  )

  it.live("reloads configured sources on config updates and keeps the last fetched URL", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const first = path.join(tmp.path, "first.md")
        const second = path.join(tmp.path, "second.md")
        const remote = "https://example.test/instructions.md"
        const responses = [new Response("remote"), new Response(null, { status: 500 })]
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.writeFile(first, "first")
            await fs.writeFile(second, "second")
          })
          const events = yield* PubSub.unbounded<ReturnType<typeof configUpdated>>()
          const config = yield* Config.Test
          const discovery = yield* start(host({ event: { subscribe: () => Stream.fromPubSub(events) } }))
          const initialized = yield* readInitial(yield* discovery.load())
          expect(initialized.text).toBe(
            [`Instructions from: ${first}\nfirst`, `Instructions from: ${remote}\nremote`].join("\n\n"),
          )

          yield* config.setEntries([configured([second, remote])])
          yield* triggerAndWait(PubSub.publish(events, configUpdated()).pipe(Effect.asVoid))
          expect((yield* readInitial(yield* discovery.load())).text).toBe(
            [`Instructions from: ${second}\nsecond`, `Instructions from: ${remote}\nremote`].join("\n\n"),
          )
        }).pipe(
          Effect.provide(
            instructionLayer({
              config: path.join(tmp.path, "global"),
              instructions: [first, remote],
              http: respond(() => responses.shift() ?? new Response(null, { status: 500 })),
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
              ),
            }),
          ),
        )
      }),
    ),
  )

  it.live("keeps an empty AGENTS.md as available context", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) =>
        Effect.gen(function* () {
          const file = path.join(tmp.path, "AGENTS.md")
          yield* Effect.promise(() => fs.writeFile(file, ""))
          const discovery = yield* start()
          expect((yield* readInitial(yield* discovery.load())).text).toBe(`Instructions from: ${file}\n`)
        }).pipe(
          Effect.provide(
            instructionLayer({
              config: path.join(tmp.path, "global"),
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(location({ directory: AbsolutePath.make(tmp.path) })),
              ),
            }),
          ),
        ),
      ),
    ),
  )

  it.live("discovers a newly created instruction file above the project root", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const home = path.join(tmp.path, "home")
        const shared = path.join(home, "code")
        const project = path.join(shared, "repo")
        const intermediate = path.join(shared, "AGENTS.md")
        const directory = path.join(project, "core")
        const projectFile = path.join(project, "AGENTS.md")
        return Effect.gen(function* () {
          yield* Effect.promise(() => fs.mkdir(directory, { recursive: true }))
          yield* Effect.promise(() => fs.writeFile(projectFile, "project"))
          const discovery = yield* start()
          expect((yield* readInitial(yield* discovery.load())).text).toBe(`Instructions from: ${projectFile}\nproject`)

          // Not watched: the new file arrives with the folder's next rescan (a global change here).
          yield* Effect.promise(() => fs.writeFile(intermediate, "intermediate"))
          yield* emitAndWait({ type: "create", path: path.join(tmp.path, "global", "AGENTS.md") })

          expect((yield* readInitial(yield* discovery.load())).text).toBe(
            [`Instructions from: ${projectFile}\nproject`, `Instructions from: ${intermediate}\nintermediate`].join(
              "\n\n",
            ),
          )
        }).pipe(
          Effect.provide(
            instructionLayer({
              config: path.join(tmp.path, "global"),
              home,
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(
                  location(
                    { directory: AbsolutePath.make(directory) },
                    { projectDirectory: AbsolutePath.make(project) },
                  ),
                ),
              ),
            }),
          ),
        )
      }),
    ),
  )

  it.live("stops instruction candidates at the project root outside home", () =>
    Effect.acquireRelease(
      Effect.promise(() => tmpdir()),
      (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
    ).pipe(
      Effect.flatMap((tmp) => {
        const global = path.join(tmp.path, "global")
        const home = path.join(tmp.path, "home")
        const project = path.join(tmp.path, "scratch", "repo")
        const directory = path.join(project, "packages", "core")
        return Effect.gen(function* () {
          yield* Effect.promise(async () => {
            await fs.mkdir(directory, { recursive: true })
            await fs.writeFile(path.join(directory, "AGENTS.md"), "core")
            await fs.writeFile(path.join(project, "AGENTS.md"), "project")
            await fs.writeFile(path.join(tmp.path, "scratch", "AGENTS.md"), "above the root")
          })
          const discovery = yield* start()
          const watcher = yield* Watcher.Test
          expect(yield* watcher.subscriptions()).toEqual([{ path: path.join(global, "AGENTS.md"), type: "file" }])
          expect((yield* readInitial(yield* discovery.load())).text).toBe(
            [
              `Instructions from: ${path.join(directory, "AGENTS.md")}\ncore`,
              `Instructions from: ${path.join(project, "AGENTS.md")}\nproject`,
            ].join("\n\n"),
          )
        }).pipe(
          Effect.provide(
            instructionLayer({
              config: global,
              home,
              locationServiceLayer: Layer.succeed(
                Location.Service,
                Location.Service.of(
                  location(
                    { directory: AbsolutePath.make(directory) },
                    { projectDirectory: AbsolutePath.make(project) },
                  ),
                ),
              ),
            }),
          ),
        )
      }),
    ),
  )

  // A client CWD can spell the drive `c:` while git reports the project root as `C:`.
  ;(process.platform === "win32" ? it.live : it.live.skip)(
    "stops at the project root when the location drive letter differs in case",
    () =>
      Effect.acquireRelease(
        Effect.promise(() => tmpdir()),
        (tmp) => Effect.promise(() => tmp[Symbol.asyncDispose]()),
      ).pipe(
        Effect.flatMap((tmp) => {
          const global = path.join(tmp.path, "global")
          const home = path.join(tmp.path, "home")
          const project = path.join(tmp.path, "repo")
          const directory = project[0].toLowerCase() + project.slice(1)
          return Effect.gen(function* () {
            yield* Effect.promise(() => fs.mkdir(project, { recursive: true }))
            yield* Effect.promise(() => fs.writeFile(path.join(project, "AGENTS.md"), "project"))
            yield* Effect.promise(() => fs.writeFile(path.join(tmp.path, "AGENTS.md"), "outside"))
            const discovery = yield* start()
            const watcher = yield* Watcher.Test
            expect(yield* watcher.subscriptions()).toEqual([
              { path: path.join(global, "AGENTS.md"), type: "file" },
              { path: path.join(directory, "AGENTS.md"), type: "file" },
            ])
            expect((yield* readInitial(yield* discovery.load())).text).toBe(
              `Instructions from: ${path.join(directory, "AGENTS.md")}\nproject`,
            )
          }).pipe(
            Effect.provide(
              instructionLayer({
                config: global,
                home,
                locationServiceLayer: Layer.succeed(
                  Location.Service,
                  Location.Service.of(
                    location(
                      { directory: AbsolutePath.make(directory) },
                      { projectDirectory: AbsolutePath.make(project) },
                    ),
                  ),
                ),
              }),
            ),
          )
        }),
      ),
  )

  it.effect("isolates source failure without failing activation", () => {
    const failingFS = Layer.effect(
      FSUtil.Service,
      FSUtil.Service.pipe(
        Effect.map((fs) =>
          FSUtil.Service.of({ ...fs, up: () => Effect.fail(new FSUtil.FileSystemError({ method: "up" })) }),
        ),
      ),
    ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
    return Effect.gen(function* () {
      const discovery = yield* start()
      expect(
        (yield* readUpdate(
          yield* discovery.load(),
          state({ "core/instructions": [{ path: "/repo/AGENTS.md", content: "old" }] }),
        )).changed,
      ).toBe(false)
    }).pipe(
      Effect.provide(
        instructionLayer({
          filesystemLayer: failingFS,
          locationServiceLayer: Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
          ),
        }),
      ),
    )
  })

  it.effect("marks a discovered file that disappears before read as unavailable", () => {
    const discovered = AbsolutePath.make("/repo/AGENTS.md")
    const racingFS = Layer.effect(
      FSUtil.Service,
      FSUtil.Service.pipe(
        Effect.map((fs) =>
          FSUtil.Service.of({
            ...fs,
            up: () => Effect.succeed([discovered]),
            readFileString: (file) => Effect.fail(readFailure("NotFound", "ENOENT", file)),
          }),
        ),
      ),
    ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
    return Effect.gen(function* () {
      const discovery = yield* start()
      expect(
        (yield* readUpdate(
          yield* discovery.load(),
          state({ "core/instructions": [{ path: discovered, content: "old" }] }),
        )).changed,
      ).toBe(false)
    }).pipe(
      Effect.provide(
        instructionLayer({
          filesystemLayer: racingFS,
          locationServiceLayer: Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
          ),
        }),
      ),
    )
  })

  it.effect("skips discovered files a sandbox denies and keeps the rest available", () => {
    const denied = path.resolve("/repo/AGENTS.md")
    const readable = path.resolve("/repo/packages/AGENTS.md")
    const sandboxedFS = Layer.effect(
      FSUtil.Service,
      FSUtil.Service.pipe(
        Effect.map((fs) =>
          FSUtil.Service.of({
            ...fs,
            up: () => Effect.succeed([readable, denied]),
            readFileString: (file) =>
              file === denied ? Effect.fail(readFailure("Unknown", "EPERM", file)) : Effect.succeed("package"),
          }),
        ),
      ),
    ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))
    return Effect.gen(function* () {
      const discovery = yield* start()
      expect((yield* readInitial(yield* discovery.load())).text).toBe(`Instructions from: ${readable}\npackage`)
    }).pipe(
      Effect.provide(
        instructionLayer({
          filesystemLayer: sandboxedFS,
          locationServiceLayer: Layer.succeed(
            Location.Service,
            Location.Service.of(location({ directory: AbsolutePath.make("/repo/packages") })),
          ),
        }),
      ),
    )
  })

  it.effect("canonicalizes boundaries and honors project opt-out", () =>
    Effect.gen(function* () {
      const observed: { values: FSUtil.UpOptions[] } = { values: [] }
      const observingFS = Layer.effect(
        FSUtil.Service,
        FSUtil.Service.pipe(
          Effect.map((fs) =>
            FSUtil.Service.of({
              ...fs,
              up: (options) => Effect.sync(() => (observed.values.push(options), [])),
            }),
          ),
        ),
      ).pipe(Layer.provide(LayerNode.compile(FSUtil.node)))

      yield* start().pipe(
        Effect.provide(
          instructionLayer({
            filesystemLayer: observingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location({ directory: AbsolutePath.make("/repo/") }, { projectDirectory: AbsolutePath.make("/repo") }),
              ),
            ),
          }),
        ),
      )
      yield* start().pipe(
        Effect.provide(
          instructionLayer({
            filesystemLayer: observingFS,
            project: false,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(location({ directory: AbsolutePath.make("/repo") })),
            ),
          }),
        ),
      )
      yield* start().pipe(
        Effect.provide(
          instructionLayer({
            filesystemLayer: observingFS,
            locationServiceLayer: Layer.succeed(
              Location.Service,
              Location.Service.of(
                location(
                  { directory: AbsolutePath.make("/outside") },
                  { projectDirectory: AbsolutePath.make("/repo") },
                ),
              ),
            ),
          }),
        ),
      )

      const repo = path.resolve("/repo")
      expect(observed.values).toEqual([{ targets: ["AGENTS.md"], start: repo, stop: repo, type: "file" }])
    }),
  )
})
