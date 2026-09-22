export * as SessionAdmission from "./admission.js"

import { Effect, Schema } from "effect"

export class AdmissionFencedError extends Schema.TaggedError<AdmissionFencedError>()(
  "Session.AdmissionFencedError",
  {
    message: Schema.String,
  },
) {}

export interface DrainStatus {
  readonly fenced: boolean
  readonly activeCount: number
  readonly activeSessions: ReadonlyArray<string>
  readonly quiescent: boolean
  readonly drained: boolean
}

type ActiveSource = () => Iterable<string>

class AdmissionFenceState {
  private _fenced = false
  private _activeSources = new Set<ActiveSource>()

  get isEngaged(): boolean {
    return this._fenced
  }

  engage(): void {
    this._fenced = true
  }

  disengage(): void {
    this._fenced = false
  }

  registerActiveSource(source: ActiveSource): () => void {
    this._activeSources.add(source)
    return () => {
      this._activeSources.delete(source)
    }
  }

  drainStatus(): DrainStatus {
    const activeSessions = new Set<string>()
    for (const source of this._activeSources) {
      for (const id of source()) {
        activeSessions.add(id)
      }
    }
    const activeCount = activeSessions.size
    const quiescent = this._fenced && activeCount === 0
    return {
      fenced: this._fenced,
      activeCount,
      activeSessions: Array.from(activeSessions),
      quiescent,
      drained: quiescent,
    }
  }

  reset(): void {
    this._fenced = false
    this._activeSources.clear()
  }
}

const state = new AdmissionFenceState()

export const AdmissionFence = {
  isEngaged: () => state.isEngaged,
  engage: () => state.engage(),
  disengage: () => state.disengage(),
  registerActiveSource: (source: ActiveSource) => state.registerActiveSource(source),
  drainStatus: () => state.drainStatus(),
  reset: () => state.reset(),
  check: Effect.gen(function* () {
    if (state.isEngaged) {
      return yield* new AdmissionFencedError({
        message: "Session admission is fenced",
      })
    }
  }),
}

export const isEngaged = AdmissionFence.isEngaged
export const engage = AdmissionFence.engage
export const disengage = AdmissionFence.disengage
export const drainStatus = AdmissionFence.drainStatus
export const check = AdmissionFence.check
export const reset = AdmissionFence.reset
export const registerActiveSource = AdmissionFence.registerActiveSource
