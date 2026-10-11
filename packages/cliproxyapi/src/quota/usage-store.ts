import type { Plugin } from "@opencode/plugin/tui"
import { Meter } from "opencode-pacer/core"
import { PacerRpc, type PacerMeterEvent } from "opencode-pacer/rpc"
import { batch, createEffect, createMemo, createRoot, createSignal, onCleanup, untrack } from "solid-js"
import { UsageDefinition, type UsageInput, type UsageResult, type UsageSnapshot } from "./usage.js"
import { pacerSnapshot } from "./pacer-snapshot.js"

export type UsageScope = "model" | "all"

export interface UsageReading {
  /** Selection this reading belongs to; a reading never outlives a selection change. */
  readonly key: string
  readonly result?: UsageResult
  /** Last usable snapshot for this selection, kept while a refresh fails. */
  readonly snapshot?: UsageSnapshot
  /** Local time the snapshot was received, to advance its server clock. */
  readonly received: number
  /** Present while the latest refresh failed and an older snapshot is still shown. */
  readonly failure?: string
}

/**
 * Pacer pushes response readings directly into visible views. One cached-RPC
 * polling loop seeds/reconciles the sidebar and popup. It follows the current
 * route/model/scope and discards responses that belong to an older selection.
 */
export function createUsageStore(context: Plugin.Context, options: { interval?: number } = {}) {
  const rpc = context.client.rpc(UsageDefinition)
  const interval = options.interval ?? 5000
  return createRoot((dispose) => {
    const [scope, setScope] = createSignal<UsageScope>("model")
    const [details, setDetails] = createSignal(false)
    const [views, setViews] = createSignal(0)
    const [reading, setReading] = createSignal<UsageReading>()
    const [clock, setClock] = createSignal(Date.now())
    const input = createMemo<UsageInput | undefined>(
      () => {
        const model = context.ui.model.current()
        if (!model) return
        const route = context.ui.router.current()
        return {
          sessionID: route.type === "session" ? route.sessionID : undefined,
          providerID: model.providerID,
          modelID: model.modelID,
          all: scope() === "all",
        }
      },
      undefined,
      { equals: (left, right) => selectionKey(left) === selectionKey(right) },
    )

    createEffect(() => {
      const value = input()
      if (views() === 0 || !value) return
      const key = selectionKey(value)
      // A changed selection starts empty instead of showing another chat's identity.
      untrack(() => {
        if (reading()?.key !== key) setReading({ key, received: 0 })
      })
      const controller = new AbortController()
      const state = { pushed: 0, pending: false }
      const meter = new Meter()
      const off = context.client.rpc(PacerRpc).events.on("meter", (event) => {
        const snapshot = (event.data as unknown as PacerMeterEvent).snapshot
        meter.restore(snapshot, true)
        state.pushed++
        const now = Date.now()
        batch(() => {
          setClock(now)
          setReading({
            key,
            result: { status: "ready" },
            snapshot: {
              ...pacerSnapshot(meter, value, now, reading()?.snapshot?.providers),
              next_use: reading()?.snapshot?.next_use,
            },
            received: now,
          })
        })
      })
      const load = async () => {
        if (state.pending) return
        state.pending = true
        const pushed = state.pushed
        const next = await rpc.read(value, { signal: controller.signal }).then(
          (result) => ({ result }),
          () => ({ result: undefined }),
        )
        state.pending = false
        if (controller.signal.aborted) return
        const now = Date.now()
        const result =
          next.result?.snapshot && state.pushed !== pushed
            ? {
                ...next.result,
                snapshot: {
                  ...pacerSnapshot(meter, value, now, next.result.snapshot.providers),
                  next_use: next.result.snapshot.next_use,
                },
              }
            : next.result
        batch(() => {
          setClock(now)
          setReading((previous) => merge(key, previous, result, now))
        })
      }
      void load()
      const tick = setInterval(() => {
        setClock(Date.now())
        void load()
      }, interval)
      onCleanup(() => {
        off()
        clearInterval(tick)
        controller.abort()
      })
    })

    const current = createMemo(() => {
      const value = reading()
      const selected = input()
      if (!value || !selected || value.key !== selectionKey(selected)) return
      return value
    })

    return {
      dispose,
      input,
      scope,
      setScope,
      details,
      setDetails,
      reading: current,
      /** Server time in seconds, advanced locally between readings. */
      now() {
        const value = current()
        if (!value?.snapshot) return 0
        return value.snapshot.now + Math.max(0, (clock() - value.received) / 1000)
      },
      /** Registers a mounted view; polling runs while any view is mounted. */
      view() {
        setViews((count) => count + 1)
        return () => setViews((count) => count - 1)
      },
      polling: () => views() > 0 && input() !== undefined,
    }
  })
}

export type UsageStore = ReturnType<typeof createUsageStore>

function selectionKey(input: UsageInput | undefined) {
  if (!input) return ""
  return JSON.stringify([input.sessionID ?? "", input.providerID, input.modelID, input.all])
}

/** Keeps the last usable snapshot through transient failures of the same selection. */
function merge(key: string, previous: UsageReading | undefined, result: UsageResult | undefined, now: number) {
  const same = previous?.key === key ? previous : undefined
  if (result?.snapshot) return { key, result, snapshot: result.snapshot, received: now }
  const failure = result?.message ?? "Credential usage could not be retrieved. Retrying automatically."
  const transient = result === undefined || result.status === "unavailable"
  if (transient && same?.snapshot) return { ...same, failure }
  return { key, result: result ?? { status: "unavailable" as const, message: failure }, received: now }
}
