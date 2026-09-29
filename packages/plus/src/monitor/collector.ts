// Folds the host's session events into the monitor ledger.
//
// Every Plus instance (one per Location) feeds the events its Location sees;
// the ledger is shared and every write is keyed by session and message or
// call id, so an event observed twice writes the same row twice. Only the
// small per-session state needed for attribution lives in memory: the open
// steps, the previous finished step (to measure its results against the next
// prompt) and the session's step index and compaction epoch.
import { estimateTokens, promptTokens, split, targetOf } from "./attribution.js"
import type { Ledger, SessionFacts, Usage } from "./ledger.js"

/** The event types the collector reads; everything else is dropped before any work. */
export const MonitorEvents: ReadonlySet<string> = new Set([
  "session.created",
  "session.renamed",
  "session.step.started",
  "session.step.ended",
  "session.step.failed",
  "session.text.ended",
  "session.tool.input.started",
  "session.tool.called",
  "session.tool.success",
  "session.tool.failed",
  "session.compaction.ended",
  "session.inbox.delivered",
  "session.synthetic",
  "session.instructions.updated",
  "session.deleted",
])

export interface CollectorOptions {
  readonly ledger: Ledger
  /** The Location's directory: file targets are shown relative to it. */
  readonly directory?: string
  /** A short identity of the instructions in force, stored on each step. */
  readonly config?: () => string | undefined
  /** Facts about a session the collector first meets mid-life (parent, agent, team run). */
  readonly resolve?: (sessionID: string) => Promise<SessionFacts | undefined>
  readonly now?: () => number
}

export interface Collector {
  observe(event: { readonly type: string; readonly data?: unknown; readonly created?: number }): void
  /** Waits for pending session lookups (tests and shutdown). */
  settle(): Promise<void>
}

interface CallState {
  readonly id: string
  readonly tool: string
  inputChars: number
  resultChars: number
}

interface OpenStep {
  readonly messageID: string
  readonly idx: number
  readonly epoch: number
  readonly agent?: string
  readonly model?: string
  readonly config?: string
  textChars: number
  readonly calls: Map<string, CallState>
}

interface FinishedStep {
  readonly epoch: number
  readonly prompt: number
  readonly output: number
  readonly finish: string
  readonly calls: readonly CallState[]
}

interface Track {
  idx: number
  epoch: number
  /** Something besides tool results entered the prompt since the last step ended. */
  dirty: boolean
  previous?: FinishedStep
  readonly steps: Map<string, OpenStep>
  /** Tool name by call id, from `tool.input.started`, until the call is recorded. */
  readonly names: Map<string, string>
}

type Data = Readonly<Record<string, unknown>>

export function createCollector(options: CollectorOptions): Collector {
  const ledger = options.ledger
  const clock = options.now ?? Date.now
  // The event's own publication time when it carries one: a subscriber that
  // lags behind still records when things happened, not when it caught up.
  let eventTime: number | undefined
  const now = () => eventTime ?? clock()
  const tracks = new Map<string, Track>()
  const pending = new Set<Promise<void>>()

  function track(sessionID: string): Track {
    const existing = tracks.get(sessionID)
    if (existing !== undefined) return existing
    const position = ledger.position(sessionID)
    const created: Track = {
      idx: position.idx,
      epoch: position.epoch,
      dirty: false,
      steps: new Map(),
      names: new Map(),
    }
    tracks.set(sessionID, created)
    learn(sessionID)
    return created
  }

  // A session first met mid-life (the plugin started after it) is looked up
  // once; its row exists immediately so its steps are never orphaned.
  function learn(sessionID: string) {
    ledger.session({ id: sessionID }, now())
    const resolve = options.resolve
    if (resolve === undefined) return
    const lookup = resolve(sessionID)
      .then((facts) => {
        if (facts !== undefined) ledger.session({ ...facts, id: sessionID }, now())
      })
      .catch(() => undefined)
      .finally(() => pending.delete(lookup))
    pending.add(lookup)
  }

  function stepFor(sessionID: string, messageID: string): OpenStep | undefined {
    return tracks.get(sessionID)?.steps.get(messageID)
  }

  function startStep(sessionID: string, data: Data) {
    const state = track(sessionID)
    const messageID = String(data.assistantMessageID)
    if (state.steps.has(messageID)) return
    const model = data.model as { id?: string; providerID?: string; variant?: string } | undefined
    const agent = typeof data.agent === "string" ? data.agent : undefined
    state.idx += 1
    const step: OpenStep = {
      messageID,
      idx: state.idx,
      epoch: state.epoch,
      ...(agent === undefined ? {} : { agent }),
      ...(model?.id === undefined ? {} : { model: `${model.providerID}/${model.id}` }),
      ...configOf(),
      textChars: 0,
      calls: new Map(),
    }
    state.steps.set(messageID, step)
    ledger.stepStarted({
      sessionID,
      messageID,
      kind: "step",
      idx: step.idx,
      epoch: step.epoch,
      ...(agent === undefined ? {} : { agent }),
      ...(model?.providerID === undefined ? {} : { provider: model.providerID }),
      ...(model?.id === undefined ? {} : { model: model.id }),
      ...(model?.variant === undefined ? {} : { variant: model.variant }),
      ...(step.config === undefined ? {} : { config: step.config }),
      started: typeof data.started === "number" ? data.started : now(),
    })
  }

  function configOf(): { config?: string } {
    const config = options.config?.()
    return config === undefined ? {} : { config }
  }

  function called(sessionID: string, data: Data) {
    const state = track(sessionID)
    const callID = String(data.id)
    const step = state.steps.get(String(data.assistantMessageID))
    const input = (data.input ?? {}) as Readonly<Record<string, unknown>>
    const tool = state.names.get(callID) ?? (typeof data.name === "string" ? data.name : "unknown")
    state.names.delete(callID)
    const inputChars = JSON.stringify(input).length
    const call: CallState = { id: callID, tool, inputChars, resultChars: 0 }
    step?.calls.set(callID, call)
    ledger.callStarted({
      sessionID,
      callID,
      messageID: String(data.assistantMessageID),
      idx: step?.idx ?? state.idx,
      epoch: step?.epoch ?? state.epoch,
      ...(step?.agent === undefined ? {} : { agent: step.agent }),
      ...(step?.model === undefined ? {} : { model: step.model }),
      ...(step?.config === undefined ? {} : { config: step.config }),
      tool,
      ...targetField(targetOf(tool, input, options.directory)),
      status: "running",
      started: now(),
      inputChars,
    })
  }

  function settled(sessionID: string, data: Data, status: "completed" | "error") {
    const callID = String(data.id)
    // A malformed input fails without ever being called: record it first.
    if (track(sessionID).names.has(callID)) called(sessionID, { ...data, input: {} })
    const step = stepFor(sessionID, String(data.assistantMessageID))
    const content = Array.isArray(data.content) ? (data.content as readonly { type?: string; text?: string }[]) : []
    const error = data.error as { type?: string; message?: string } | undefined
    const resultChars =
      content.reduce((sum, part) => sum + (typeof part.text === "string" ? part.text.length : 0), 0) +
      (error?.message?.length ?? 0)
    const call = step?.calls.get(callID) ?? previousCall(sessionID, callID)
    if (call !== undefined) call.resultChars = resultChars
    ledger.callEnded({
      sessionID,
      callID,
      status,
      ...(error === undefined ? {} : { error: `${error.type ?? "error"}: ${(error.message ?? "").slice(0, 160)}` }),
      ended: now(),
      resultChars,
      resultTokens: estimateTokens(resultChars),
    })
    innerCalls(sessionID, callID, step, data)
  }

  // Code Mode runs other tools inside one `execute` call and reports them in
  // its metadata; each becomes a zero-token row under the execute call so
  // filtering by an inner tool finds who used it.
  function innerCalls(sessionID: string, callID: string, step: OpenStep | undefined, data: Data) {
    const metadata = data.metadata as { toolCalls?: unknown } | undefined
    if (!Array.isArray(metadata?.toolCalls)) return
    const state = track(sessionID)
    const at = now()
    const entries = (metadata.toolCalls as readonly { tool?: unknown; status?: unknown; input?: unknown }[]).filter(
      (entry): entry is { tool: string; status?: unknown; input?: unknown } => typeof entry.tool === "string",
    )
    const names = [...new Set(entries.map((entry) => entry.tool))]
    if (names.length > 0)
      ledger.callTarget(
        sessionID,
        callID,
        names.length <= 3 ? names.join(", ") : `${names.slice(0, 3).join(", ")} +${names.length - 3}`,
      )
    entries.forEach((inner, index) => {
      const input =
        inner.input !== null && typeof inner.input === "object"
          ? (inner.input as Readonly<Record<string, unknown>>)
          : {}
      const status = inner.status === "error" ? "error" : "completed"
      const id = `${callID}#${index}`
      ledger.callStarted({
        sessionID,
        callID: id,
        messageID: String(data.assistantMessageID),
        parentCall: callID,
        idx: step?.idx ?? state.idx,
        epoch: step?.epoch ?? state.epoch,
        ...(step?.agent === undefined ? {} : { agent: step.agent }),
        ...(step?.model === undefined ? {} : { model: step.model }),
        ...(step?.config === undefined ? {} : { config: step.config }),
        tool: inner.tool,
        ...targetField(innerTarget(inner.tool, input)),
        status,
        started: at,
        inputChars: JSON.stringify(input).length,
      })
      ledger.callEnded({ sessionID, callID: id, status, ended: at, resultChars: 0, resultTokens: 0 })
    })
  }

  function previousCall(sessionID: string, callID: string): CallState | undefined {
    return tracks.get(sessionID)?.previous?.calls.find((call) => call.id === callID)
  }

  function endStep(sessionID: string, data: Data, failed: boolean) {
    const state = track(sessionID)
    const messageID = String(data.assistantMessageID)
    const step = state.steps.get(messageID)
    state.steps.delete(messageID)
    const tokens = data.tokens as
      | { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
      | undefined
    const usage: Usage = {
      input: tokens?.input ?? 0,
      output: tokens?.output ?? 0,
      reasoning: tokens?.reasoning ?? 0,
      cacheRead: tokens?.cache.read ?? 0,
      cacheWrite: tokens?.cache.write ?? 0,
      cost: typeof data.cost === "number" ? data.cost : 0,
    }
    const finish = failed ? "error" : String(data.finish ?? "unknown")
    ledger.stepEnded(sessionID, messageID, now(), finish, usage)
    if (step === undefined) return
    const calls = [...step.calls.values()]
    // Visible output is split between the text the step wrote and its calls' inputs.
    const shares = split(usage.output, [step.textChars, ...calls.map((call) => call.inputChars)])
    const prompt = promptTokens(usage)
    ledger.callTokens([
      ...calls.map((call, index) => ({ sessionID, callID: call.id, callTokens: shares[index + 1] ?? 0 })),
      ...measure(state, step.epoch, prompt).map((update) => ({ sessionID, ...update })),
    ])
    state.previous =
      tokens === undefined ? undefined : { epoch: step.epoch, prompt, output: usage.output, finish, calls }
    state.dirty = false
  }

  // The previous step's results entered this prompt: its growth over the
  // previous prompt, minus what the previous step wrote itself, is what they
  // cost. Only a clean tool-call → next-step pair is measured; anything else
  // (a user message, a compaction, instruction updates) keeps the estimate.
  function measure(
    state: Track,
    epoch: number,
    prompt: number,
  ): { callID: string; resultTokens: number; measured: boolean }[] {
    const previous = state.previous
    if (previous === undefined || state.dirty || previous.epoch !== epoch || previous.finish !== "tool-calls") return []
    if (previous.calls.length === 0) return []
    const growth = prompt - previous.prompt - previous.output
    if (growth <= 0) return []
    const parts = split(
      growth,
      previous.calls.map((call) => call.resultChars),
    )
    return previous.calls.map((call, index) => ({ callID: call.id, resultTokens: parts[index] ?? 0, measured: true }))
  }

  function compacted(sessionID: string, data: Data) {
    const state = track(sessionID)
    const tokens = data.tokens as
      | { input: number; output: number; reasoning: number; cache: { read: number; write: number } }
      | undefined
    const model = data.model as { id?: string; providerID?: string; variant?: string } | undefined
    state.idx += 1
    state.epoch += 1
    const at = now()
    const messageID = `compaction:${at}:${state.idx}`
    ledger.stepStarted({
      sessionID,
      messageID,
      kind: "compaction",
      idx: state.idx,
      epoch: state.epoch,
      ...(model?.providerID === undefined ? {} : { provider: model.providerID }),
      ...(model?.id === undefined ? {} : { model: model.id }),
      ...(model?.variant === undefined ? {} : { variant: model.variant }),
      ...configOf(),
      started: at,
    })
    ledger.stepEnded(sessionID, messageID, at, "compaction", {
      input: tokens?.input ?? 0,
      output: tokens?.output ?? 0,
      reasoning: tokens?.reasoning ?? 0,
      cacheRead: tokens?.cache.read ?? 0,
      cacheWrite: tokens?.cache.write ?? 0,
      cost: typeof data.cost === "number" ? data.cost : 0,
    })
    state.previous = undefined
    state.dirty = true
  }

  function created(sessionID: string, data: Data) {
    const location = data.location as { directory?: string } | undefined
    ledger.session(
      {
        id: sessionID,
        ...(typeof data.parentID === "string" ? { parentID: data.parentID } : {}),
        ...(typeof data.agent === "string" ? { agent: data.agent } : {}),
        ...(typeof data.title === "string" ? { title: data.title } : {}),
        ...(typeof location?.directory === "string" ? { directory: location.directory } : {}),
      },
      now(),
    )
    // The session is still looked up at its first step: a team run's record
    // (its delegating session) is written only after the host created it.
  }

  return {
    observe(event) {
      if (!MonitorEvents.has(event.type)) return
      eventTime = typeof event.created === "number" ? event.created : undefined
      const data = (event.data ?? {}) as Data
      const sessionID = data.sessionID
      if (typeof sessionID !== "string" || sessionID.length === 0) return
      if (event.type === "session.created") return created(sessionID, data)
      if (event.type === "session.deleted") return void tracks.delete(sessionID)
      if (event.type === "session.renamed" && typeof data.title === "string")
        return ledger.session({ id: sessionID, title: data.title }, now())
      if (event.type === "session.step.started") return startStep(sessionID, data)
      if (event.type === "session.step.ended") return endStep(sessionID, data, false)
      if (event.type === "session.step.failed") return endStep(sessionID, data, true)
      if (event.type === "session.text.ended") {
        const step = stepFor(sessionID, String(data.assistantMessageID))
        if (step !== undefined && typeof data.text === "string") step.textChars += data.text.length
        return
      }
      if (event.type === "session.tool.input.started") {
        if (typeof data.name === "string") track(sessionID).names.set(String(data.id), data.name)
        return
      }
      if (event.type === "session.tool.called") return called(sessionID, data)
      if (event.type === "session.tool.success") return settled(sessionID, data, "completed")
      if (event.type === "session.tool.failed") return settled(sessionID, data, "error")
      if (event.type === "session.compaction.ended") return compacted(sessionID, data)
      // A user prompt, a synthetic message or an instructions update entered the prompt.
      track(sessionID).dirty = true
    },
    settle: async () => {
      while (pending.size > 0) await Promise.all([...pending])
    },
  }
}

function targetField(target: string | undefined): { target?: string } {
  return target === undefined ? {} : { target }
}

// An inner Code Mode call's own arguments: an instructions row id, a search
// query, … — the first short string argument, clipped.
function innerTarget(tool: string, input: Readonly<Record<string, unknown>>): string | undefined {
  const own = targetOf(tool.slice(tool.lastIndexOf(".") + 1), input)
  if (own !== undefined) return own
  const first = Object.values(input).find((value): value is string => typeof value === "string" && value.length > 0)
  if (first === undefined) return undefined
  const single = first.replace(/\s+/g, " ").trim()
  return single.length <= 80 ? single : `${single.slice(0, 79)}…`
}
