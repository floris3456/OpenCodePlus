import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import { ReleaseRequest } from "@opencode/schema/release"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { runRegistration } from "../instructions/apply.js"
import { getReleaseRequestStatus, submitReleaseRequest, type RequestResult } from "./request.js"

// The whole model-facing release vocabulary: record an intent, read its status.
// There is deliberately no tool that authorizes, promotes, rebuilds or activates
// anything — that decision belongs to the external controller, which reaches the
// product through a separately issued permit, never through a tool call.

const namespace = "release"
const origin = { type: "plugin", name: "opencode.plus" } as const
const options = { namespace, permission: "release" } as const

export const RequestDescription =
  "Record a release build or promotion intent for the external controller to decide.\n" +
  "Submitting grants no authority: nothing is built, promoted or activated by this call, and re-submitting the same requestID with the same body reconciles the recorded request instead of creating a second one."

export const StatusDescription =
  "Read the recorded status of one release request by requestID. Reads never change a request."

const StatusInput = Schema.Struct({ requestID: Schema.String })

export async function registerReleaseTools(ctx: Context): Promise<Registration> {
  return runRegistration(ctx.tool.transform, (editor) => {
    editor.namespace({
      name: namespace,
      description: "Release requests: record a build or promotion intent and read its status.",
    })
    editor.add({
      name: "request",
      description: RequestDescription,
      input: ReleaseRequest,
      output: Schema.Unknown,
      options,
      origin,
      execute: (input) => resultOf(submitReleaseRequest(input)),
    })
    editor.add({
      name: "status",
      description: StatusDescription,
      input: StatusInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: (input) => resultOf(getReleaseRequestStatus(input.requestID)),
    })
  })
}

function resultOf(result: RequestResult): Effect.Effect<{ output: unknown }, Tool.Error> {
  if (result.ok) return Effect.succeed({ output: { ...result.status, reconciled: result.reconciled } })
  return Effect.fail(
    new Tool.Error({
      message: `${result.reason}: ${result.message}`,
      metadata: { reason: result.reason },
    }),
  )
}
