export * as Plus from "./rpc.js"

import { Schema } from "effect"
import { Rpc } from "@opencode/schema/rpc"

export interface Status extends Schema.Schema.Type<typeof Status> {}
export const Status = Schema.Struct({
  enabled: Schema.Boolean,
  directory: Schema.String,
}).annotate({ identifier: "Plus.Status" })

// The TUI promise client only accepts portable schemas (Standard Schema or
// JSON Schema views), which bare Effect schemas structurally lack. Wrap fresh
// annotated copies so the shared Status export is never mutated in place.
const Empty = Schema.toStandardSchemaV1(Schema.Void.annotate({ identifier: "Plus.Empty" }))
const PortableStatus = Schema.toStandardSchemaV1(Status.annotate({ identifier: "Plus.Status" }))

export const Definition = Rpc.define({
  id: "opencode.plus",
  methods: {
    "project.status": {
      input: Empty,
      output: PortableStatus,
    },
    "project.enable": {
      input: Empty,
      output: PortableStatus,
    },
    "project.disable": {
      input: Empty,
      output: PortableStatus,
    },
  },
  events: {
    "project.changed": {
      schema: PortableStatus,
    },
  },
})
