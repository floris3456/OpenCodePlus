import { Tool } from "@opencode/schema/tool"
import { Effect, Option } from "effect"
import { Permission } from "../permission.js"

/**
 * Asserts a registered tool's declared permission before the registry runs it.
 *
 * Tools that own a leaf authorize themselves: built-ins call `Permission.assert`, and MCP
 * registrations assert the same action in `tool/mcp.ts` with the resources and save list
 * only that leaf knows. Gating those here would evaluate one call twice and prompt twice
 * for one answer. Plugin registrations have no leaf, so they are the ones that reach
 * execution unauthorized, and the ones this gate covers.
 *
 * A plugin tool carries no resource vocabulary, so it asserts with `resources: ["*"]`: every
 * rule whose action matches decides every call of that tool, and a rule whose resource is
 * narrower than `*` never matches it. The same `*` is the save list, so answering "always"
 * approves the action itself for the project.
 *
 * The service is read from the calling fiber rather than captured by the registry's layer.
 * Session work runs under `Instance.provide`, which makes the Location's permission service
 * ambient, while the registry itself stays buildable without a Location (`Permission.node`
 * depends on the unbound `Location.node`, so depending on it would make every tool graph
 * bind one). A context without the service refuses the call instead of running it.
 *
 * The request carries the canonical tool source, so an observer correlates an ask with the
 * call that caused it through `source.id`, and reads a refusal's cause from `Tool.Error.error`.
 */
export const assertToolPermission = Effect.fnUntraced(function* (
  tool: Tool.Info,
  name: string,
  context: Tool.Context,
) {
  if (tool.origin?.type !== "plugin") return
  const action = tool.options?.permission ?? name
  const permission = Option.getOrUndefined(yield* Effect.serviceOption(Permission.Service))
  if (!permission)
    return yield* new Tool.Error({ message: `Cannot authorize ${action}: no permission service in this context` })
  yield* permission
    .assert({
      action,
      resources: ["*"],
      save: ["*"],
      sessionID: context.sessionID,
      agent: context.agent,
      source: {
        type: "tool",
        messageID: context.messageID,
        id: context.id,
      },
    })
    .pipe(
      // A refusal is this call's model-visible outcome, exactly like a built-in leaf's. A
      // decline without feedback stays a defect inside `Permission.assert` and resurfaces at
      // SessionModelRequest.executeTool, so it is never caught here.
      Effect.mapError(
        (error) =>
          new Tool.Error({
            message: error._tag === "Permission.CorrectedError" ? error.feedback : error.message,
            error,
          }),
      ),
    )
})
