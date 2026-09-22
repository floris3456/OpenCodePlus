import { CrossSpawnSpawner } from "@opencode/util/cross-spawn-spawner"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { Context, Effect, Layer, PlatformError, Schema } from "effect"
import { ChildProcessSpawner, make } from "effect/unstable/process/ChildProcessSpawner"
import type { Driver } from "./driver.js"
import { Failed, type Files } from "./files.js"
import { makeFiles } from "./index.js"
import { makeLocalDriver } from "./local.js"
import { Location } from "../location.js"
import { Workspace } from "../workspace.js"

export class UnplaceableError extends Schema.TaggedError<UnplaceableError>()("Environment.UnplaceableError", {
  message: Schema.String,
  workspaceID: Workspace.ID,
  cause: Schema.optional(Schema.Defect()),
}) {}

/**
 * How this Environment is bound, decided once when the location's services boot.
 *
 * `host` reaches the process's own machine. `workspace` routes every file
 * operation and spawn through the workspace driver. `unplaceable` is a placed
 * location whose workspace could not be bound: agent-controlled I/O must fail
 * rather than silently fall back to secret-bearing host state, so its driver
 * refuses every operation and the consumers that would otherwise degrade
 * quietly (config, instruction discovery, shell) refuse too.
 */
export type Placement =
  | { readonly kind: "host" }
  | { readonly kind: "workspace"; readonly workspaceID: Workspace.ID }
  | { readonly kind: "unplaceable"; readonly workspaceID: Workspace.ID; readonly error: UnplaceableError }

export interface Interface {
  readonly files: Files
  readonly spawner: ChildProcessSpawner["Service"]
  readonly placement: Placement
}

/** Every file operation and spawn fails with `error`, so nothing reaches the host instead. */
export function makeUnplaceableDriver(error: UnplaceableError): Driver {
  const spawner = make(() =>
    Effect.fail(
      PlatformError.systemError({
        _tag: "Unknown",
        module: "Environment",
        method: "spawn",
        description: error.message,
        cause: error,
      }),
    ),
  )
  const fail = Effect.fail(new Failed({ path: `workspace://${error.workspaceID}`, cause: error }))
  return {
    spawner,
    overrides: {
      read: () => fail,
      write: () => fail,
      stat: () => fail,
      list: () => fail,
      remove: () => fail,
      move: () => fail,
      mkdir: () => fail,
    },
  }
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Environment") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner
    const location = yield* Location.Service
    const workspace = yield* Workspace.Service
    const workspaceID = location.workspaceID
    if (workspaceID === undefined) {
      const driver = makeLocalDriver(spawner)
      return Service.of({ files: makeFiles(driver), spawner: driver.spawner, placement: { kind: "host" } })
    }
    return yield* workspace.connect(workspaceID).pipe(
      Effect.map((driver) =>
        Service.of({
          files: makeFiles(driver),
          spawner: driver.spawner,
          placement: { kind: "workspace", workspaceID },
        }),
      ),
      Effect.catch((cause) => {
        const error = new UnplaceableError({
          message: `Failed to bind Environment to workspace ${workspaceID}`,
          workspaceID,
          cause,
        })
        const driver = makeUnplaceableDriver(error)
        return Effect.succeed(
          Service.of({
            files: makeFiles(driver),
            spawner: driver.spawner,
            placement: { kind: "unplaceable", workspaceID, error },
          }),
        )
      }),
    )
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [CrossSpawnSpawner.node, Location.node, Workspace.node],
})

export * as EnvironmentService from "./environment.js"
