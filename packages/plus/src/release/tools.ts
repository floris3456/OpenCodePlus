import type { Context } from "@opencode/plugin/effect/plugin"
import type { Registration } from "@opencode/plugin/effect/registration"
import { ReleaseRequest } from "@opencode/schema/release"
import { Schema } from "effect"
import { runRegistration } from "../instructions/apply.js"
import { submitReleaseRequest, getReleaseRequestStatus } from "./request.js"

export const RequestDescription =
  "Submit a bounded release build or promotion request intent. Submits intent only; grants no execution authority and does not block on outcome."
export const StatusDescription = "Read the status of a previously submitted release request."

export async function registerReleaseTools(ctx: Context): Promise<Registration> {
  return await runRegistration(ctx.tool.transform, (editor) => {
    editor.namespace({
      name: "release",
      description: "Release tools: submit bounded release requests and query their status.",
    })
    editor.add({
      name: "request",
      description: RequestDescription,
      input: ReleaseRequest,
      output: Schema.Unknown,
      execute: async (input) => {
        return submitReleaseRequest(input)
      },
    })
    editor.add({
      name: "status",
      description: StatusDescription,
      input: Schema.Struct({ requestID: Schema.String }),
      output: Schema.Unknown,
      execute: async (input) => {
        return getReleaseRequestStatus(input.requestID)
      },
    })
  })
}
