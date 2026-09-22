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
  workspaceID: Schema.optional(Workspace.ID),
  cause: Schema.optional(Schema.Defect()),
}) {}

export interface Placement {
  readonly workspaceID?: Workspace.ID
  readonly isPlaced: boolean
  readonly error?: UnplaceableError
}

export interface Interface {
  readonly files: Files
  readonly spawner: ChildProcessSpawner["Service"]
  readonly placement?: Placement
}

export function makeUnplaceableDriver(workspaceID: Workspace.ID, cause: unknown): Driver {
  const error = new UnplaceableError({
    message: `Location cannot be placed: workspace ${workspaceID} connection failed`,
    workspaceID,
    cause,
  })
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
  const fail = Effect.fail(new Failed({ path: `workspace://${workspaceID}`, cause: error }))
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
    if (!location.workspaceID) {
      const driver = makeLocalDriver(spawner)
      return Service.of({
        files: makeFiles(driver),
        spawner: driver.spawner,
        placement: { isPlaced: false },
      })
    }
    const workspaceID = location.workspaceID
    const connection = yield* workspace.connect(workspaceID).pipe(
      Effect.map((driver) => ({ driver, error: undefined })),
      Effect.catch((cause) =>
        Effect.succeed({
          driver: makeUnplaceableDriver(workspaceID, cause),
          error: new UnplaceableError({
            message: `Failed to bind Environment to workspace ${workspaceID}`,
            workspaceID,
            cause,
          }),
        }),
      ),
    )
    return Service.of({
      files: makeFiles(connection.driver),
      spawner: connection.driver.spawner,
      placement: {
        workspaceID,
        isPlaced: true,
        error: connection.error,
      },
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [CrossSpawnSpawner.node, Location.node, Workspace.node],
})

export * as EnvironmentService from "./environment.js"
