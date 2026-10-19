export * as SessionModelRequest from "./model-request.js"
import { isDeepStrictEqual } from "node:util"
import { applyCachePolicy } from "@opencode/ai/cache-policy"

import {
  GenerationOptions,
  type GenerationOptionsFields,
  HttpOptions,
  LanguageModel,
  LLM,
  LLMRequest,
  type Media,
  Message,
  SystemPart,
} from "@opencode/ai"
import type { StreamOptions } from "@opencode/ai/route"
import type {
  SessionCompaction,
  SessionContext,
  SessionGenerate,
  SessionRequest,
  SessionRequestKind,
  SessionTitle,
} from "@opencode/plugin/effect/session"
import type { Agent } from "@opencode/schema/agent"
import type { Model } from "@opencode/schema/model"
import { Provider } from "@opencode/schema/provider"
import type { Content } from "@opencode/schema/tool"
import { Cause, Context, Duration, Effect, Layer, Option, Result, Schema, Stream } from "effect"
import { HttpClientRequest, HttpClientResponse } from "effect/http"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { App } from "../app.js"
import { Permission } from "../permission.js"
import { PluginHooks } from "../plugin/hooks.js"
import { QuestionTool } from "../tool/plugin/question.js"
import { Tool } from "../tool.js"
import { SessionAffinity } from "./affinity.js"
import { SessionModelTransport } from "./model-transport.js"
import { SessionModelObservation } from "./model-observation.js"
import { SessionProviderContext } from "./provider-context.js"
import { SessionRunnerModel } from "./runner/model.js"
import { SessionSchema } from "./schema.js"
import { SessionSystemPrompt } from "./system-prompt.js"
import { toLLMMessages } from "./runner/to-llm-message.js"
import { Instructions } from "../instructions/index.js"
import type { SessionMessage } from "./message.js"

// Inline images one request may carry: under Anthropic's 32 MB request limit, with room for the text.
const IMAGE_BYTES_BUDGET = 25 * 1024 * 1024
// The attached image that brings the chat to this share of the limits tells the model, once, how full it is.
const IMAGE_WARNING_SHARE = 0.9
const GENERATION_KEYS = new Set(Object.keys(GenerationOptions.fields))
// Used when the catalog has no output limit for the model.
const OUTPUT_TOKEN_FALLBACK = 32_000
// No reply needs more, however much the model allows.
const OUTPUT_TOKEN_MAX = 256_000
// A summary never needs more, and a request asking for more cannot be shrunk to fit a window the catalog overstates.
const SUMMARY_OUTPUT_MAX = 32_000
// Prompt text is estimated at about 4 characters per token, which can run low on dense text such as code.
const ESTIMATE_ERROR = 0.15
// Never ask for less; only reachable with automatic compaction off, since it keeps the window from filling this far.
const OUTPUT_TOKEN_MIN = 1_024
// Zen's free tier serves only requests that declare OpenCode's shell and read tools and refuses the rest as not
// coming from OpenCode ("FreeTierError"). A request without them (an agent denied the shell or given no tools)
// declares placeholders under those names; they execute nothing, so a call to one fails as for any unavailable
// tool. Title requests are the exception: Zen serves OpenCode's title request as it is, without tools, and
// refuses it once it declares any.
const FREE_TIER_TOOLS = ["shell", "read"]
const FREE_TIER_PLACEHOLDER = "Not available to you. Never call this tool."
const HTTP_IDLE_TIMEOUT: Duration.Input = "10 minutes"

/** Tool errors, plus the user declining a permission or dismissing a question. */
export type ExecuteError = Tool.Error | Permission.DeclinedError | QuestionTool.CancelledError

export interface Prepared<Event = SessionRequest> {
  readonly observer?: SessionModelObservation.Observer
  readonly event: Event
  readonly request: LLMRequest
  readonly options: StreamOptions
  readonly retry: (event: PluginHooks.Domains["session"]["retry"]) => Effect.Effect<void>
  /** Runs a tool call against the tools this request advertised. */
  readonly executeTool: (
    input: Parameters<Tool.Snapshot["execute"]>[0],
  ) => Effect.Effect<Tool.NormalizedResult, ExecuteError>
}

export interface Input {
  readonly historyEpoch?: string
  readonly session: SessionSchema.Info
  readonly agent: Agent.ID
  readonly model: SessionRunnerModel.Resolved
  readonly tools?: Tool.Snapshot
  readonly system: Array<SystemPart>
  readonly messages: Array<Message>
  readonly toolChoice?: LLM.RequestInput["toolChoice"]
  /** Only the durable runner may use a stateful WebSocket. */
  readonly webSocket?: "session"
  /**
   * Labels this request's transport hooks (model.request, http.*, ws.*) while its
   * content hook stays the one for its flow. A warming ping reuses the primary
   * content transforms so its cache prefix matches the next real step, but its wire
   * request is an auxiliary generate so Monitor can join it to its outcome.
   */
  readonly transportKind?: SessionRequestKind
  /** False for a throwaway request (warming ping, `/generate`) that must not persist Session state. */
  readonly durable?: boolean
  /** Mandatory native-to-readable conversion using the checkpoint owner, not a compaction decision's model. */
  readonly checkpointHandoff?: true
  /** Prompt size, measured by the provider or estimated. The default output limit leaves room for it. */
  readonly inputTokens?: { readonly measured: number; readonly estimated: number }
}

/** The default output limit: the catalog limit, fitted to the room the prompt leaves in the context window. */
export const outputLimit = (
  limit: Model.Info["limit"],
  kind: "primary" | "compaction",
  inputTokens?: Input["inputTokens"],
) => {
  const model = Math.min(limit.output > 0 ? limit.output : OUTPUT_TOKEN_FALLBACK, OUTPUT_TOKEN_MAX)
  const requested = kind === "compaction" ? Math.min(model, SUMMARY_OUTPUT_MAX) : model
  if (inputTokens === undefined || limit.context <= 0) return requested
  const room = limit.context - inputTokens.measured - Math.ceil(inputTokens.estimated * (1 + ESTIMATE_ERROR))
  return Math.min(requested, Math.max(OUTPUT_TOKEN_MIN, room))
}

export const baseTranscript = (input: {
  readonly agent: Agent.Info
  readonly model: SessionRunnerModel.Resolved
  readonly tools: Tool.Snapshot
  // Ordered instruction parts; one SystemPart per part, so each instruction
  // source keeps its own part boundary. A baseline part is an
  // `Instructions.Part` carrying its source key and, when file-backed, its
  // canonical absolute file path; the model request carries them as
  // `metadata.instruction` so plugins can tell the parts apart. The agent's
  // own system prompt stays the first part.
  readonly initial: ReadonlyArray<string | Instructions.Part>
  readonly messages: ReadonlyArray<SessionMessage.Info>
}) => {
  const providerMetadataKey = input.model.model.route.providerMetadataKey ?? input.model.model.provider
  return {
    providerMetadataKey,
    historyEpoch: input.messages.findLast((message) => message.type === "compaction" && message.status === "completed")?.id ?? "initial",
    system: [
      input.agent.system
        ? SystemPart.make(input.agent.system)
        : SystemPart.make(SessionSystemPrompt.make(input.tools.definitions.map((tool) => tool.name))),
      ...input.initial.map((part) => (typeof part === "string" ? SystemPart.make(part) : instructionPart(part))),
    ].filter((part) => part.text.length > 0),
    messages: toLLMMessages(input.messages, input.model.ref, providerMetadataKey),
  }
}

const instructionPart = (part: Instructions.Part): SystemPart =>
  SystemPart.make(part.text, {
    instruction: part.path === undefined ? { key: part.key } : { key: part.key, path: part.path },
  })

const mimeToModality = (mime: string) => {
  if (mime.startsWith("image/")) return "image"
  if (mime.startsWith("audio/")) return "audio"
  if (mime.startsWith("video/")) return "video"
  if (mime === "application/pdf") return "pdf"
}

// xAI rejects any other image type (e.g. GIF) with invalid_image, and the stored image would fail every later turn.
const XAI_IMAGE_MIMES = new Set(["image/png", "image/jpeg", "image/webp"])

const unsupportedMedia = (
  mime: string,
  name: string | undefined,
  capabilities: Model.Capabilities,
  provider: string | undefined,
) => {
  const modality = mimeToModality(mime)
  if (!modality) return
  const unsupported = !capabilities.input.some((item) => item.startsWith(modality))
    ? modality
    : provider === "xai" && modality === "image" && !XAI_IMAGE_MIMES.has(mime.toLowerCase())
      ? mime
      : undefined
  if (!unsupported) return
  return `ERROR: Cannot read ${name ? `"${name}"` : modality} (this model does not support ${unsupported} input). Inform the user.`
}

// Remote and provider-referenced media carry no local payload and never count toward the inline budget.
const mediaBytes = (media: Media.Asset) => {
  if (media.source.type === "base64") return Buffer.byteLength(media.source.data)
  if (media.source.type === "bytes") return Math.ceil(media.source.data.byteLength / 3) * 4
  return 0
}

/** Replaces media with the returned text; messages without replacements are returned unchanged. */
const replaceMedia = (
  messages: LLMRequest["messages"],
  replace: (media: { mime: string; name: string | undefined }) => string | undefined,
) =>
  messages.map((message) => {
    const content = message.content.map((part) => {
      if (part.type === "media") {
        const text = replace({ mime: part.media.mediaType, name: part.filename })
        return text === undefined ? part : Message.text(text)
      }
      if (part.type !== "tool-result" || part.result.type !== "content") return part
      const result = part.result
      const value = result.value.map((item): Content => {
        if (item.type !== "file") return item
        const text = replace({ mime: item.mime, name: item.name })
        return text === undefined ? item : { type: "text", text }
      })
      return value.every((item, index) => item === result.value[index])
        ? part
        : { ...part, result: { ...result, value } }
    })
    return content.every((part, index) => part === message.content[index])
      ? message
      : new Message({ ...message, content })
  })

export const unsupportedParts = (
  messages: LLMRequest["messages"],
  capabilities: Model.Capabilities,
  provider?: string,
) => replaceMedia(messages, (media) => unsupportedMedia(media.mime, media.name, capabilities, provider))

/** What one request may carry in inline images; `count` only where the provider documents a limit. */
export interface ImageLimits {
  readonly bytes: number
  readonly count?: number
}

export const DEFAULT_IMAGE_LIMITS: ImageLimits = { bytes: IMAGE_BYTES_BUDGET }

/** Anthropic: 600 images a request, 100 on 200k-context models; OpenAI Responses: 500. */
export const imageLimits = (model: Pick<SessionRunnerModel.Resolved, "model" | "limit">): ImageLimits => {
  const protocol = model.model.route.protocol
  if (protocol === "anthropic-messages")
    return { bytes: IMAGE_BYTES_BUDGET, count: model.limit.context > 0 && model.limit.context <= 200_000 ? 100 : 600 }
  if (protocol === "openai-responses") return { bytes: IMAGE_BYTES_BUDGET, count: 500 }
  return DEFAULT_IMAGE_LIMITS
}

/**
 * Never changes an image once it was sent, so the provider's prompt cache stays valid. Images are attached in the
 * order the history gained them while they fit the limits; the first one that would not fit, and every image after
 * it, is replaced where it arrives by a note telling the model so, until compaction starts a new history. The image
 * that brings the chat to 90% of the limits is followed by one note saying how full it is. Every decision depends
 * only on the images before it, so a request repeats the previous one's history exactly and only adds to it.
 */
export const boundImages = (messages: LLMRequest["messages"], limits: ImageLimits = DEFAULT_IMAGE_LIMITS) => {
  // `full` names the limit the first image that did not fit ran into.
  const state = { bytes: 0, count: 0, warned: false, full: undefined as "bytes" | "count" | undefined }
  const place = (name: string | undefined, bytes: number): { keep: boolean; note?: string } => {
    if (!state.full && state.bytes + bytes <= limits.bytes && (limits.count === undefined || state.count < limits.count)) {
      state.bytes += bytes
      state.count += 1
      const share = Math.max(state.bytes / limits.bytes, limits.count === undefined ? 0 : state.count / limits.count)
      if (state.warned || share < IMAGE_WARNING_SHARE) return { keep: true }
      state.warned = true
      return { keep: true, note: imagesFilling(state, limits, share) }
    }
    state.full ??= limits.count !== undefined && state.count >= limits.count ? "count" : "bytes"
    return { keep: false, note: imageWithheld(name, { ...state, full: state.full }, limits) }
  }
  const shaped = messages.map((message) => {
    const content = message.content.flatMap((part) => {
      if (part.type === "media") {
        if (!isImage(part.media.mediaType)) return [part]
        const placed = place(part.filename, mediaBytes(part.media))
        return [...(placed.keep ? [part] : []), ...(placed.note === undefined ? [] : [Message.text(placed.note)])]
      }
      if (part.type !== "tool-result" || part.result.type !== "content") return [part]
      const result = part.result
      const value = result.value.flatMap((item): Content[] => {
        if (item.type !== "file" || !isImage(item.mime)) return [item]
        const placed = place(item.name, Buffer.byteLength(item.uri))
        return [...(placed.keep ? [item] : []), ...(placed.note === undefined ? [] : [{ type: "text" as const, text: placed.note }])]
      })
      return sameItems(value, result.value) ? [part] : [{ ...part, result: { ...result, value } }]
    })
    return sameItems(content, message.content) ? message : new Message({ ...message, content })
  })
  return sameItems(shaped, messages) ? messages : shaped
}

/** The inline images these messages carry, counted as `boundImages` counts them. */
export const imageLoad = (messages: LLMRequest["messages"]) => {
  const sizes = messages.flatMap((message) =>
    message.content.flatMap((part) => {
      if (part.type === "media") return isImage(part.media.mediaType) ? [mediaBytes(part.media)] : []
      if (part.type !== "tool-result" || part.result.type !== "content") return []
      return part.result.value.flatMap((item) => (item.type === "file" && isImage(item.mime) ? [Buffer.byteLength(item.uri)] : []))
    }),
  )
  return { bytes: sizes.reduce((total, bytes) => total + bytes, 0), count: sizes.length }
}

/** Whether `boundImages` would leave an image out of these messages. */
export const imagesExceed = (messages: LLMRequest["messages"], limits: ImageLimits = DEFAULT_IMAGE_LIMITS) => {
  const load = imageLoad(messages)
  return load.bytes > limits.bytes || (limits.count !== undefined && load.count > limits.count)
}

const isImage = (mime: string) => mime.toLowerCase().startsWith("image/")

const sameItems = <T,>(next: ReadonlyArray<T>, previous: ReadonlyArray<T>) =>
  next.length === previous.length && next.every((item, index) => item === previous[index])

const megabytes = (bytes: number) => (bytes / 1024 / 1024).toFixed(1)

const imagesFilling = (state: { bytes: number; count: number }, limits: ImageLimits, share: number) =>
  `[Images in this chat: ${Math.floor(share * 100)}% of what one request may carry (${megabytes(state.bytes)} of ${megabytes(limits.bytes)} MB${limits.count === undefined ? "" : `, ${state.count} of ${limits.count} images`}). Images beyond 100% are only attached after the chat is compacted.]`

const imageWithheld = (
  name: string | undefined,
  state: { bytes: number; count: number; full: "bytes" | "count" },
  limits: ImageLimits,
) =>
  `[Image not attached${name === undefined ? "" : `: ${name}`}. ${
    state.full === "count"
      ? `The images already attached fill the ${limits.count} images one request may carry.`
      : `The images already attached fill the ${megabytes(limits.bytes)} MB one request may carry (${megabytes(state.bytes)} MB in ${state.count} images).`
  } They stay attached. New images are attached again after the chat is compacted; load this image again then to see it.]`

const decodeHookMessage = Schema.decodeUnknownOption(Message)

function normalizeStringContent(candidate: unknown): unknown {
  if (typeof candidate !== "object" || candidate === null) return candidate
  const content = (candidate as { content?: unknown }).content
  if (typeof content !== "string") return candidate
  return { ...candidate, content: [Message.text(content)] }
}

// Validates only what the hook produced at the hook boundary. Messages the
// hook left untouched (identical to a pre-hook input message) pass through
// as-is, so history is never re-decoded; added or replaced messages with
// plain-string content are normalized to one text part, and anything else
// that does not decode against the core message schema is dropped (its index
// is reported) so a plugin's malformed message never fails the step.
function sanitizeHookMessages(
  candidates: ReadonlyArray<unknown>,
  untouched: ReadonlySet<unknown>,
): {
  readonly messages: Array<Message>
  readonly dropped: Array<number>
} {
  const messages: Array<Message> = []
  const dropped: Array<number> = []
  for (const [index, candidate] of candidates.entries()) {
    if (untouched.has(candidate)) {
      messages.push(candidate as Message)
      continue
    }
    const decoded = decodeHookMessage(normalizeStringContent(candidate))
    if (Option.isSome(decoded)) messages.push(decoded.value)
    else dropped.push(index)
  }
  return { messages, dropped }
}

/** Placeholder shell and read definitions a Zen free-tier request lacks; none for any other model. */
const freeTierPlaceholders = (model: SessionRunnerModel.Resolved, declared: ReadonlyMap<string, unknown>) => {
  if (model.ref.providerID !== Provider.ID.opencode) return []
  if (model.cost.some((cost) => cost.input > 0 || cost.output > 0)) return []
  return FREE_TIER_TOOLS.filter((name) => !declared.has(name)).map((name) => ({
    name,
    description: FREE_TIER_PLACEHOLDER,
    inputSchema: { type: "object", properties: {} },
  }))
}

type Definitions = PluginHooks.Domains["session"]["context"]["tools"]

/** Builds the model request for each session flow. Each entry runs its own plugin hook. */
export interface Interface {
  readonly primary: (input: Input) => Effect.Effect<Prepared<SessionContext>>
  readonly compaction: (input: Input) => Effect.Effect<Prepared<SessionCompaction>>
  readonly generate: (input: Input) => Effect.Effect<Prepared<SessionGenerate>>
  readonly title: (input: Input) => Effect.Effect<Prepared<SessionTitle>>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/SessionModelRequest") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const hooks = yield* PluginHooks.Service
    const transport = yield* SessionModelTransport.Service
    const app = yield* App.Metadata
    // Reuse the completed primary/warming context, including inline cache markers.
    // Warming's private prompt is appended outside prepare and is never retained here.
    const completed = new Map<string, { request: LLMRequest; model: Model.Ref; epoch?: string }>()
    const prepare = Effect.fn("SessionModelRequest.prepare")(function* <
      S extends SessionRequest & { tools?: Definitions },
    >(kind: SessionRequestKind, input: Input, shape: (draft: SessionRequest, tools: Definitions) => Effect.Effect<S>) {
      const session = input.session
      const model = input.model
      // The content hook below follows `kind`; the transport hooks carry `transportKind`
      // when set, so an auxiliary wire request can be labelled precisely (see Input).
      const scope = { sessionID: session.id, agent: input.agent, model: model.ref, kind: input.transportKind ?? kind }
      const tools = input.tools ?? {
        definitions: [],
        execute: () => new Tool.Error({ message: "Tools are not available for this request" }),
      }
      // Remember which tool each definition object came from. Hooks rename a tool by moving
      // its definition to a new key, so after the hook we find the tool by object identity.
      const given = new Map(
        tools.definitions.map((t) => [{ description: t.description, input: { ...t.inputSchema } }, t] as const),
      )
      // Snapshot the pre-hook messages first: hooks mutate the draft's
      // messages array in place, so anything not identical to these after the
      // hook is hook-produced and needs validating at the boundary.
      const untouched = new Set<unknown>(input.messages)
      // Hooks see the default output limit and may change or remove it. Titles and generate keep the provider default,
      // because their reasoning is hard to budget.
      const shaped = yield* shape(
        {
          sessionID: session.id,
          model: model.ref,
          system: input.system,
          messages: input.messages,
          options:
            kind === "primary" || kind === "compaction"
              ? { maxTokens: outputLimit(model.limit, kind, input.inputTokens) }
              : {},
          ...(input.durable === undefined ? {} : { durable: input.durable }),
        },
        Object.fromEntries(Array.from(given, ([d, t]) => [t.name, d])),
      )
      const checked = sanitizeHookMessages(shaped.messages, untouched)
      if (checked.dropped.length > 0)
        yield* Effect.logWarning("Dropping malformed messages from session hook", {
          kind,
          index: checked.dropped,
        })
      // Match by identity first, then by key. Entries matching neither were invented by a
      // hook and are dropped. `t.name` stays the real name so execution can map renames back.
      const byName = new Map(tools.definitions.map((t) => [t.name, t]))
      const hooked = new Map(
        Object.entries(shaped.tools ?? {}).flatMap(([name, d]) => {
          const t = given.get(d) ?? byName.get(name)
          return t ? [[name, { ...t, description: d.description, inputSchema: d.input }] as const] : []
        }),
      )
      const entries = Object.entries(shaped.options)
      const generation = Object.fromEntries(entries.filter(([k]) => GENERATION_KEYS.has(k))) as GenerationOptionsFields
      const providerOptions = Object.fromEntries(entries.filter(([k]) => !GENERATION_KEYS.has(k)))
      const affinity = SessionAffinity.get(session)
      const placeholders = kind === "title" ? [] : freeTierPlaceholders(model, hooked)
      const base = LLM.request({
        model: model.model,
        http: {
          headers: {
            "x-opencode-session-id": session.id,
            ...(session.parentID ? { "x-opencode-parent-session-id": session.parentID } : {}),
            "x-session-affinity": affinity,
            "X-Session-Id": affinity,
            ...(session.parentID ? { "x-parent-session-id": session.parentID } : {}),
            "User-Agent": App.useragent(app),
            "x-opencode-project": session.projectID,
            "x-opencode-session": affinity,
            "x-opencode-client": app.name,
          },
        },
        // TODO: Persist cache lineage so nested forks reuse the root session's cache key.
        promptCacheKey: /^ses_[0-9a-f]{64}$/.test(affinity) ? affinity.slice(4) : affinity,
        system: shaped.system,
        messages: boundImages(unsupportedParts(shaped.messages, model.capabilities, model.model.provider), imageLimits(model)),
        tools: [...Array.from(hooked, ([name, t]) => ({ ...t, name })), ...placeholders],
        toolChoice: input.toolChoice,
        generation: Object.keys(generation).length === 0 ? undefined : generation,
        providerOptions: Object.keys(providerOptions).length === 0 ? undefined : providerOptions,
      })

      const baseURL = base.model.route.endpoint.baseURL
      const modelHook = yield* hooks.trigger("session", "model.request", {
        ...scope,
        baseURL: typeof baseURL === "string" ? baseURL : undefined,
        headers: { ...base.http?.headers },
      })
      const route =
        modelHook.baseURL !== undefined && modelHook.baseURL !== baseURL
          ? base.model.route.with({ endpoint: { baseURL: modelHook.baseURL } })
          : base.model.route
      const fresh = LLMRequest.update(base, {
        model: route === base.model.route ? base.model : LanguageModel.update(base.model, { route }),
        http: new HttpOptions({
          ...base.http,
          headers: Object.keys(modelHook.headers).length === 0 ? undefined : modelHook.headers,
        }),
      })
      const prior = completed.get(session.id)
      const reusable = kind === "compaction" && prior && prior.epoch === input.historyEpoch &&
        isDeepStrictEqual(prior.model, model.ref) && prior.request.model.route.endpoint.baseURL === fresh.model.route.endpoint.baseURL &&
        prior.request.messages.length <= fresh.messages.length &&
        prior.request.messages.every((message, index) => isDeepStrictEqual(message, fresh.messages[index]))
      const pinned = reusable ? applyCachePolicy(prior.request) : undefined
      const request = pinned ? LLMRequest.update(pinned, {
        // Keep authentication/session routing current; prompt content remains pinned.
        http: fresh.http,
        generation: new GenerationOptions({ ...pinned.generation, maxTokens: fresh.generation?.maxTokens }),
        messages: [...pinned.messages, ...fresh.messages.slice(pinned.messages.length)],
      }) : fresh
      const cacheColdCause = kind !== "compaction" || pinned ? undefined :
        (session.model && !isDeepStrictEqual(session.model, model.ref)) || (prior && !isDeepStrictEqual(prior.model, model.ref)) ? "model-switch" :
        !prior ? "snapshot-unavailable" : "history-or-epoch-changed"
      if (cacheColdCause) yield* Effect.logWarning("Compaction cache prefix could not be pinned", {
        sessionID: session.id,
        cause: cacheColdCause,
      })
      // History selects native windows against the catalog route before hooks run. A newly installed
      // routing hook must not send an existing opaque window to another deployment; `prepare` has no
      // error channel, so like hook failures this surfaces as a defect.
      const selected = SessionProviderContext.provenance(model)
      if (
        selected &&
        !SessionProviderContext.compatible(
          selected,
          SessionProviderContext.provenance({ model: request.model, ref: model.ref }),
        ) &&
        request.messages.some((message) => message.content.some((part) => part.type === "compaction"))
      )
        return yield* Effect.die(
          new Error("Provider context is incompatible with the route selected by model request hooks"),
        )

      const hasHttpHooks =
        (yield* hooks.has("session", "http.request", model.ref.providerID)) ||
        (yield* hooks.has("session", "http.response", model.ref.providerID)) ||
        (yield* hooks.has("session", "model.observed", model.ref.providerID))
      const http: StreamOptions["http"] = hasHttpHooks
        ? (req, handler) =>
            Effect.gen(function* () {
              const requestID = crypto.randomUUID()
              const started = Date.now()
              const observed = yield* SessionModelObservation.exchange("http", requestID, started)
              const before = yield* hooks.trigger("session", "http.request", {
                ...scope,
                requestID,
                started,
                invocationID: observed?.invocationID,
                request: yield* HttpClientRequest.toWeb(req),
              })
              yield* SessionModelObservation.finalObservers(before.observers ?? [], before.request)
              let sent = HttpClientRequest.fromWeb(before.request)
              if (before.request.body)
                sent = HttpClientRequest.bodyUint8Array(
                  sent,
                  new Uint8Array(yield* Effect.promise(() => before.request.clone().arrayBuffer())),
                  before.request.headers.get("content-type") ?? undefined,
                )
              const res = yield* handler(sent).pipe(
                Effect.tap(() =>
                  Effect.sync(() => {
                    if (observed) observed.exchange.outcome = "response"
                  }),
                ),
                Effect.tapError(() =>
                  Effect.sync(() => {
                    if (observed) observed.exchange.outcome = "failed"
                  }),
                ),
              )
              const after = yield* hooks.trigger("session", "http.response", {
                ...scope,
                request: before.request,
                response: new Response(
                  [204, 205, 304].includes(res.status) ? null : yield* Stream.toReadableStreamEffect(res.stream),
                  { status: res.status, headers: res.headers },
                ),
              })
              return HttpClientResponse.fromWeb(sent, after.response)
            }).pipe(Effect.mapError((cause) => (cause instanceof Error ? cause : new Error(String(cause)))))
        : undefined
      // HTTP hooks wrap every HTTP request, including the WebSocket fallback path. The route decides
      // which transport actually carries the request, so both hook families are always offered.
      const webSocket =
        input.webSocket === "session" && model.transport === "websocket"
          ? transport.bind(
              session.id,
              {
                handshake: (connect) =>
                  hooks
                    .trigger("session", "experimental.ws.handshake", {
                      ...scope,
                      url: connect.url,
                      headers: connect.headers,
                    })
                    .pipe(Effect.map((event) => ({ url: event.url, headers: event.headers }))),
                send: (frame) =>
                  Effect.gen(function* () {
                    const requestID = crypto.randomUUID()
                    const started = Date.now()
                    const observed = yield* SessionModelObservation.exchange("websocket", requestID, started)
                    return yield* hooks
                      .trigger("session", "experimental.ws.send", {
                        ...scope,
                        frame,
                        requestID,
                        started,
                        invocationID: observed?.invocationID,
                      })
                      .pipe(
                        Effect.tap((event) =>
                          SessionModelObservation.finalObservers(event.observers ?? [], event.frame),
                        ),
                        Effect.map((event) => event.frame),
                      )
                  }),
                receive: (frame) =>
                  hooks
                    .trigger("session", "experimental.ws.receive", { ...scope, frame })
                    .pipe(Effect.map((event) => event.frame)),
              },
              model.chunkTimeout,
            )
          : undefined

      const observer = SessionModelObservation.make(hooks, { ...scope, historyEpoch: input.historyEpoch }, model.cost, cacheColdCause)
      const remember: SessionModelObservation.Observer = (effect, identity) => observer(effect.pipe(Effect.tap(() => Effect.sync(() => {
          if (kind !== "primary") return
          completed.set(session.id, { request, model: model.ref, epoch: input.historyEpoch })
        }))), identity)
      return {
        observer: remember,
        event: { ...shaped, messages: checked.messages },
        request,
        options: {
          ...(http ? { http } : {}),
          ...(webSocket ? { webSocket } : {}),
          idleTimeout: model.chunkTimeout === false ? Duration.infinity : model.chunkTimeout ?? HTTP_IDLE_TIMEOUT,
        },
        retry: (event: Parameters<Prepared["retry"]>[0]) =>
          hooks.trigger("session", "retry", event).pipe(Effect.asVoid),
        // Permission.assert and the question tool throw declines as defects so tools cannot
        // catch them and turn a "no" into model-visible output. Recover them here as failures,
        // including declines a tool rethrew and its wrapper attached to a Tool.Error, as Promise
        // plugin tools do.
        executeTool: (call: Parameters<Prepared["executeTool"]>[0]) =>
          (placeholders.some((tool) => tool.name === call.call.name)
            ? Effect.fail(
                new Tool.Error({
                  message: `No tool named "${call.call.name}" is available to you. Use a tool from your tool list.`,
                }),
              )
            : tools.execute({ ...call, definitions: hooked })
          ).pipe(
            Effect.catchCauseFilter(
              (cause) => {
                const decline = cause.reasons
                  .map((r) => (Cause.isDieReason(r) ? r.defect : Cause.isFailReason(r) ? r.error.error : undefined))
                  .find(
                    (value): value is Permission.DeclinedError | QuestionTool.CancelledError =>
                      value instanceof Permission.DeclinedError || value instanceof QuestionTool.CancelledError,
                  )
                return decline ? Result.succeed(decline) : Result.fail(cause)
              },
              (decline) => Effect.fail(decline),
            ),
          ),
      }
    })

    const agentHook =
      (name: "context" | "compaction" | "generate", agent: Agent.ID) => (draft: SessionRequest, tools: Definitions) =>
        hooks.trigger("session", name, { ...draft, agent, tools })

    return Service.of({
      primary: (input) => prepare("primary", input, agentHook("context", input.agent)),
      compaction: (input) =>
        prepare("compaction", input, (draft, tools) =>
          hooks.trigger("session", "compaction", {
            ...draft,
            agent: input.agent,
            tools,
            ...(input.checkpointHandoff ? { checkpointHandoff: input.checkpointHandoff } : {}),
          }),
        ),
      generate: (input) => prepare("generate", input, agentHook("generate", input.agent)),
      title: (input) => prepare("title", input, (draft) => hooks.trigger("session", "title", draft)),
    })
  }),
)

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [PluginHooks.node, SessionModelTransport.node, App.node],
})
