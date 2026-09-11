export * as Plus from "./rpc.js"

import { Schema } from "effect"
import { Rpc } from "@opencode/schema/rpc"

export interface Status extends Schema.Schema.Type<typeof Status> {}
export const Status = Schema.Struct({
  enabled: Schema.Boolean,
  directory: Schema.String,
}).annotate({ identifier: "Plus.Status" })

export const Definition = Rpc.define({
  id: "opencode.plus",
  methods: {
    "project.status": {
      input: Schema.Struct({}),
      output: Status,
    },
    "project.enable": {
      input: Schema.Struct({}),
      output: Status,
    },
    "project.disable": {
      input: Schema.Struct({}),
      output: Status,
    },
  },
  events: {
    "project.changed": {
      schema: Status,
    },
  },
})
