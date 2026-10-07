export * as SessionContext from "./context.js"

import { Model } from "../model.js"
import { Permission } from "../permission.js"
import { Context, DateTime, Effect, Layer } from "effect"
import { Agent } from "../agent.js"
import { CodeModeCatalog } from "../codemode/catalog.js"
import { CodeModeInstructions } from "../codemode/instructions.js"
import { Database } from "../database/database.js"
import { makeLocationNode } from "@opencode/util/effect/app-node"
import { InstructionDiscovery } from "../instruction-discovery.js"
import { Instructions } from "../instructions/index.js"
import { InstructionBuiltIns } from "../instructions/builtins.js"
import { Location } from "../location.js"
import { McpInstructions } from "../mcp/instructions.js"
import { McpTool } from "../tool/mcp.js"
import { ReferenceInstructions } from "../reference/instructions.js"
import { SkillInstructions } from "../skill/instructions.js"
import { PluginHooks } from "../plugin/hooks.js"
import { Tool } from "../tool.js"
import { AgentNotFoundError } from "./error.js"
import { SessionHistory } from "./history.js"
import { SessionProviderContext } from "./provider-context.js"
import { InstructionEntry } from "./instruction-entry.js"
import { SessionMessage } from "./message.js"
import { SessionModelRequest } from "./model-request.js"
import { SessionRunnerModel } from "./runner/model.js"
import { SessionSchema } from "./schema.js"
import { SessionStore } from "./store.js"

export interface Selection {
  readonly session: SessionSchema.Info
  readonly agent: Agent.Selection & { readonly info: Agent.Info }
  readonly instructions: Instructions.List
  readonly tools: Tool.Snapshot
}

export interface Loaded {
  readonly session: SessionSchema.Info
  readonly agent: Agent.Selection & { readonly info: Agent.Info }
  readonly model: SessionRunnerModel.Resolved
  readonly initial: ReadonlyArray<string | Instructions.Part>
  readonly messages: ReadonlyArray<SessionMessage.Info>
  readonly tools: Tool.Snapshot
}

/**
 * Resolves model-request state in two phases: `select` fixes the Session,
 * agent, instruction sources, and tool snapshot; `load` adds the model and
 * active history for that selection. Auxiliary operations resolve only the
 * capabilities they need; request preparation stays separate from selection.
 */
export interface Interface {
  /** Selects the Session, agent, instructions, and tools used by subsequent work. */
  readonly select: (
    sessionID: SessionSchema.ID,
    /** Pins selection to an earlier request's agent; used by warming. */
    agent?: Agent.ID,
  ) => Effect.Effect<Selection, AgentNotFoundError>
  /** Resolves active history. Preview observes instruction changes without committing them. */
  readonly load: (
    selection: Selection,
    mode?: "preview",
  ) => Effect.Effect<Loaded, SessionRunnerModel.Error | Instructions.InitializationBlocked>
  readonly resolveModel: (
    session: SessionSchema.Info,
  ) => Effect.Effect<SessionRunnerModel.Resolved, SessionRunnerModel.Error>
  /** Selects auxiliary title capabilities without instruction or tool preflight. */
  readonly selectTitle: (session: SessionSchema.Info) => Effect.Effect<
    | {
        readonly agent: Agent.Info
        readonly primary: SessionRunnerModel.Resolved | undefined
        readonly selected: SessionRunnerModel.Resolved
      }
    | undefined
  >
  readonly request: SessionModelRequest.Interface
  readonly hooks: PluginHooks.Interface
}

/** Location-scoped model-context loader for durable Session Steps. */
export class Service extends Context.Service<Service, Interface>()("@opencode/SessionContext") {}

const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const agents = yield* Agent.Service
    const builtins = yield* InstructionBuiltIns.Service
    const model = yield* Model.Service
    const db = (yield* Database.Service).db
    const discovery = yield* InstructionDiscovery.Service
    const entries = yield* InstructionEntry.Service
    const hooks = yield* PluginHooks.Service
    const location = yield* Location.Service
    const mcpInstructions = yield* McpInstructions.Service
    const mcpTools = yield* McpTool.Service
    const models = yield* SessionRunnerModel.Service
    const request = yield* SessionModelRequest.Service
    const referenceInstructions = yield* ReferenceInstructions.Service
    const skillInstructions = yield* SkillInstructions.Service
    const store = yield* SessionStore.Service
    const registry = yield* Tool.Service

    const resolveModel = (session: SessionSchema.Info) => models.resolve(session, model.available)

    const selectTitle = Effect.fn("SessionContext.selectTitle")(function* (session: SessionSchema.Info) {
      const agent = yield* agents.get(Agent.ID.make("title"))
      if (!agent) return
      const primary = yield* resolveModel(session).pipe(Effect.orElseSucceed(() => undefined))
      const info = yield* Effect.gen(function* () {
        if (agent.model) return yield* model.get(agent.model.providerID, agent.model.id)
        if (!primary) return
        return yield* model.small(primary.ref.providerID)
      })
      const variant =
        agent.model?.variant ?? MINIMAL_REASONING_VARIANTS.find((id) => info?.variants.some((item) => item.id === id))
      const preferred =
        info &&
        (yield* resolveModel({
          ...session,
          model: Model.Ref.make({
            providerID: info.providerID,
            id: info.id,
            ...(variant ? { variant } : {}),
          }),
        }).pipe(Effect.orElseSucceed(() => undefined)))
      const selected = preferred ?? primary
      if (!selected) return
      return { agent, primary, selected }
    })

    const select = Effect.fn("SessionContext.select")(function* (sessionID: SessionSchema.ID, pinned?: Agent.ID) {
      const session = yield* store.get(sessionID)
      if (!session) return yield* Effect.die(new Error(`Session not found: ${sessionID}`))
      if (session.location.directory !== location.directory || session.location.workspaceID !== location.workspaceID)
        return yield* Effect.interrupt

      yield* mcpTools.flush
      // A Location loaded only for its config starts no MCP server until its
      // first Session use. Start and settle them before the tool snapshot, so
      // the first request sees the server's tools.
      yield* mcpTools.ensure
      const agent = yield* agents.select(pinned ?? session.agent)
      if (!agent.info)
        return yield* new AgentNotFoundError({ sessionID: session.id, agent: pinned ?? session.agent ?? agent.id })
      const info = agent.info
      // Session permissions narrow discovery the same way they narrow the tool snapshot.
      const permissions = Permission.merge(info.permissions, session.permissions ?? [])
      const loaded = yield* Effect.all(
        {
          tools: registry.snapshot(permissions),
          builtins: builtins.load(sessionID),
          discovery: discovery.load(),
          skills: skillInstructions.load(permissions),
          references: referenceInstructions.load(),
          mcp: mcpInstructions.load(permissions),
          entries: entries.load(sessionID),
        },
        { concurrency: "unbounded" },
      )
      const catalogued = yield* Effect.gen(function* () {
        if (loaded.tools.codeModeCatalog === undefined) return { tools: loaded.tools, catalog: undefined }
        const own = loaded.tools.codeModeInputs
        const event = yield* hooks.trigger("session", "catalog", {
          sessionID,
          agent: info.id,
          tools: CodeModeCatalog.flattenToRecord(loaded.tools.codeModeCatalog, own),
        })
        // A hook shows a tool's parameters edited by replacing its `input`: those tools
        // render from the edited schema, in the catalog and in `search()`, for this request.
        const inputs = new Map(
          Object.entries(event.tools).flatMap(([path, entry]) =>
            entry.input !== undefined && entry.input !== own?.get(path) ? [[path, entry.input] as const] : [],
          ),
        )
        const tools = inputs.size === 0 ? loaded.tools : yield* registry.snapshot(permissions, inputs)
        if (tools.codeModeCatalog === undefined) return { tools, catalog: undefined }
        return { tools, catalog: CodeModeCatalog.applyOverrides(tools.codeModeCatalog, event.tools) }
      })
      const codeModeCatalog = catalogued.catalog
      return {
        session,
        agent: { ...agent, info },
        instructions: Instructions.combine([
          loaded.builtins,
          CodeModeInstructions.make(codeModeCatalog),
          loaded.discovery,
          loaded.skills,
          loaded.references,
          loaded.mcp,
          loaded.entries,
        ]),
        tools: catalogued.tools,
      }
    })

    const load = Effect.fn("SessionContext.load")(function* (selection: Selection, mode?: "preview") {
      const model = yield* resolveModel(selection.session)
      const boundary = SessionProviderContext.provenance(model) ?? "local"
      const history = yield* Effect.gen(function* () {
        if (mode === "preview") {
          // The read-only counterpart of the runner's InstructionState.prepare + load.
          const preview = yield* SessionHistory.preview(db, selection.session.id, selection.instructions, boundary)
          return {
            initial: preview.initial,
            messages: [
              ...preview.messages,
              ...(preview.instructionUpdate
                ? [
                    SessionMessage.System.make({
                      id: SessionMessage.ID.create(),
                      type: "system",
                      time: { created: yield* DateTime.now },
                      text: preview.instructionUpdate,
                    }),
                  ]
                : []),
            ],
          }
        }
        const loaded = yield* SessionHistory.entriesForRunner(
          db,
          selection.session.id,
          selection.instructions,
          boundary,
        )
        return { initial: loaded.initial, messages: loaded.entries.map((entry) => entry.message) }
      })
      return {
        session: selection.session,
        agent: selection.agent,
        model,
        initial: history.initial,
        messages: history.messages,
        tools: selection.tools,
      }
    })

    return Service.of({ select, load, resolveModel, selectTitle, request, hooks })
  }),
)

/** Variant IDs that minimize reasoning output, in preference order. */
const MINIMAL_REASONING_VARIANTS = ["none", "minimal", "low"].map((id) => Model.VariantID.make(id))

export const node = makeLocationNode({
  service: Service,
  layer,
  deps: [
    Agent.node,
    Model.node,
    Database.node,
    InstructionBuiltIns.node,
    InstructionDiscovery.node,
    InstructionEntry.node,
    Location.node,
    McpInstructions.node,
    McpTool.node,
    PluginHooks.node,
    ReferenceInstructions.node,
    SessionRunnerModel.node,
    SessionModelRequest.node,
    SessionStore.node,
    SkillInstructions.node,
    Tool.node,
  ],
})
