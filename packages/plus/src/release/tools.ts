import type { Context, ReleaseDomain, ReleaseResult } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import { ReleaseRequest } from "@opencode/schema/release"
import { Tool } from "@opencode/schema/tool"
import { Effect, Schema } from "effect"
import { runRegistration } from "../instructions/apply.js"

// The whole model-facing release vocabulary: record an intent, read its status.
// There is deliberately no tool that authorizes, promotes, rebuilds or activates
// anything — that decision belongs to the external controller, which reaches the
// product through a separately issued permit, never through a tool call. The
// tools hold no request state of their own: they submit and read through the
// host's in-process release seam, which is backed by the durable store the HTTP
// release routes serve.

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
      execute: (input) => throughSeam(ctx, (release) => release.submit({ request: input })),
    })
    editor.add({
      name: "status",
      description: StatusDescription,
      input: StatusInput,
      output: Schema.Unknown,
      options,
      origin,
      execute: (input) => throughSeam(ctx, (release) => release.status(input.requestID)),
    })
  })
}

// The seam is optional on the host contract, so a host that cannot provide the
// durable store is a refusal the model can read rather than an empty store that
// answers like the real one.
function throughSeam(
  ctx: Context,
  call: (release: ReleaseDomain) => Effect.Effect<ReleaseResult>,
): Effect.Effect<{ output: unknown }, Tool.Error> {
  const release = ctx.release
  if (release === undefined)
    return Effect.fail(
      new Tool.Error({
        message: "unsupported_host: this host does not expose the release request store",
        metadata: { reason: "unsupported_host" },
      }),
    )
  return call(release).pipe(Effect.flatMap(resultOf))
}

function resultOf(result: ReleaseResult): Effect.Effect<{ output: unknown }, Tool.Error> {
  if (result.ok) return Effect.succeed({ output: { ...result.status, reconciled: result.reconciled } })
  return Effect.fail(
    new Tool.Error({
      message: `${result.reason}: ${result.message}`,
      metadata: { reason: result.reason },
    }),
  )
}
