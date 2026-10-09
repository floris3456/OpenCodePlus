export * as PluginHooks from "./hooks.js"

import type { AISDKHooks } from "@opencode/plugin/effect/aisdk"
import type { SessionHooks } from "@opencode/plugin/effect/session"
import type { ShellHooks } from "@opencode/plugin/effect/shell"
import type { ToolFailures, ToolHooks } from "@opencode/plugin/effect/tool"
import type { ModelHookOptions } from "@opencode/plugin/effect/registration"
import type { PermissionHooks } from "@opencode/plugin/effect/permission"
import { Context, Effect, Layer, Ref, Scope } from "effect"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { State } from "../state.js"

/**
 * The plugin whose effect is currently loading, read when a hook registers so a later timeout can
 * name the registering plugin. Set by the plugin loader around `plugin.effect`.
 */
export const CurrentPlugin = Context.Reference<string | undefined>("@opencode/PluginHooks/CurrentPlugin", {
  defaultValue: () => undefined,
})

export interface Domains {
  readonly aisdk: AISDKHooks
  readonly session: SessionHooks
  readonly permission: PermissionHooks
  readonly shell: ShellHooks
  readonly tool: ToolHooks
}

type NoFailures<Spec> = { readonly [Name in keyof Spec]: never }

// Failure channel for each hook event. Only tool execute.before may fail: a Tool.Error rejects the call before it runs.
interface Failures extends Record<keyof Domains, unknown> {
  readonly aisdk: NoFailures<AISDKHooks>
  readonly session: NoFailures<SessionHooks>
  readonly permission: NoFailures<PermissionHooks>
  readonly shell: NoFailures<ShellHooks>
  readonly tool: ToolFailures
}

type Callback<Event, Error> = (event: Event) => Effect.Effect<void, Error>
type Entry = { readonly callback: Function; readonly options?: ModelHookOptions; readonly plugin?: string }

/**
 * Where a request preparation currently is, read only when a preparation bound fires. A hook stage
 * is set by `trigger`; a named stage is set by the caller around work that is not a plugin hook
 * (for example loading the session context).
 */
export type Stage =
  | { readonly kind: "hook"; readonly domain: keyof Domains; readonly name: string; readonly plugin?: string }
  | { readonly kind: "stage"; readonly label: string }

const eventProviderID = (event: unknown) => {
  if (typeof event !== "object" || event === null || !("model" in event)) return undefined
  const model = event.model
  if (typeof model !== "object" || model === null || !("providerID" in model)) return undefined
  return typeof model.providerID === "string" ? model.providerID : undefined
}

export interface Interface {
  readonly has: <Domain extends keyof Domains>(
    domain: Domain,
    name: keyof Domains[Domain] & keyof Failures[Domain],
    providerID?: string,
  ) => Effect.Effect<boolean>
  readonly register: <Domain extends keyof Domains, Name extends keyof Domains[Domain] & keyof Failures[Domain]>(
    domain: Domain,
    name: Name,
    callback: Callback<Domains[Domain][Name], Failures[Domain][Name]>,
    options?: ModelHookOptions,
  ) => Effect.Effect<State.Registration, never, Scope.Scope>
  readonly trigger: <Domain extends keyof Domains, Name extends keyof Domains[Domain] & keyof Failures[Domain]>(
    domain: Domain,
    name: Name,
    event: Domains[Domain][Name],
  ) => Effect.Effect<Domains[Domain][Name], Failures[Domain][Name]>
  /**
   * The hook or named stage currently running, or undefined outside one. A request-preparation
   * bound reads it when the timeout fires to name what hung; it is not a stable identity under
   * concurrency.
   */
  readonly stage: Effect.Effect<Stage | undefined>
  /** Installs a diagnostic stage for a preparation bound; callers restore the previous value after. */
  readonly setStage: (stage: Stage | undefined) => Effect.Effect<void>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/PluginHooks") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const callbacks = new Map<string, Entry[]>()
    const key = (domain: keyof Domains, name: PropertyKey) => `${domain}.${String(name)}`
    const stage = yield* Ref.make<Stage | undefined>(undefined)

    const register: Interface["register"] = Effect.fn("PluginHooks.register")(
      function* (domain, name, callback, options) {
        const scope = yield* Scope.Scope
        const plugin = yield* CurrentPlugin
        const id = key(domain, name)
        let active = true
        const entry = { callback, options, ...(plugin === undefined ? {} : { plugin }) }
        callbacks.set(id, [...(callbacks.get(id) ?? []), entry])
        const dispose = Effect.sync(() => {
          if (!active) return
          active = false
          const next = (callbacks.get(id) ?? []).filter((item) => item !== entry)
          if (next.length === 0) callbacks.delete(id)
          else callbacks.set(id, next)
        })
        yield* Scope.addFinalizer(scope, dispose)
        return { dispose }
      },
    )

    const trigger: Interface["trigger"] = Effect.fnUntraced(function* (domain, name, event) {
      let observationWarning = false
      for (const entry of callbacks.get(key(domain, name)) ?? []) {
        if (entry.options?.providerID !== undefined && entry.options.providerID !== eventProviderID(event)) continue
        if (domain === "session" && name === "model.observed") {
          yield* Effect.suspend(() => {
            const result: Effect.Effect<void, Failures[typeof domain][typeof name]> = entry.callback(event)
            return result
          }).pipe(
            Effect.timeout("1 second"),
            Effect.catchCause(() => {
              if (observationWarning) return Effect.void
              observationWarning = true
              return Effect.logWarning("session model observer failed", { code: "observer-failed" })
            }),
          )
          continue
        }
        // Save and restore so a surrounding named stage survives a completed hook. A hung hook never
        // reaches the restore, so the preparation bound still names it.
        const previous = yield* Ref.get(stage)
        yield* Ref.set(
          stage,
          entry.plugin === undefined
            ? { kind: "hook", domain, name: String(name) }
            : { kind: "hook", domain, name: String(name), plugin: entry.plugin },
        )
        const result: Effect.Effect<void, Failures[typeof domain][typeof name]> = entry.callback(event)
        yield* result
        yield* Ref.set(stage, previous)
      }
      return event
    })

    const has: Interface["has"] = (domain, name, providerID) =>
      Effect.sync(() =>
        (callbacks.get(key(domain, name)) ?? []).some(
          (entry) => entry.options?.providerID === undefined || entry.options.providerID === providerID,
        ),
      )

    return Service.of({ has, register, trigger, stage: Ref.get(stage), setStage: (value) => Ref.set(stage, value) })
  }),
)

export const node = makeLocationNode({ service: Service, layer, deps: [] })
