import { Plugin } from "@opencode/plugin/effect"
import type { RpcRegistration } from "@opencode/plugin/effect/rpc"
import { Effect } from "effect"
import { Definition, Status } from "./rpc.js"
import { disable, enable, read } from "./project.js"

export default Plugin.define({
  id: "opencode.plus",
  effect: (ctx) =>
    Effect.gen(function* () {
      const ref = { current: undefined as RpcRegistration<typeof Definition> | undefined }

      const registration = yield* ctx.rpc
        .register(Definition, {
          "project.status": () =>
            Effect.gen(function* () {
              const directory = ctx.location.directory
              const config = yield* Effect.promise(() => read(directory))
              return {
                enabled: config !== undefined,
                directory,
              }
            }),
          "project.enable": () =>
            Effect.gen(function* () {
              const directory = ctx.location.directory
              yield* Effect.promise(() => enable(directory))
              const status: Status = {
                enabled: true,
                directory,
              }
              if (ref.current) {
                yield* ref.current.events.emit("project.changed", status).pipe(Effect.orDie)
              }
              return status
            }),
          "project.disable": () =>
            Effect.gen(function* () {
              const directory = ctx.location.directory
              yield* Effect.promise(() => disable(directory))
              const status: Status = {
                enabled: false,
                directory,
              }
              if (ref.current) {
                yield* ref.current.events.emit("project.changed", status).pipe(Effect.orDie)
              }
              return status
            }),
        })
        .pipe(Effect.orDie)

      ref.current = registration
    }),
})
