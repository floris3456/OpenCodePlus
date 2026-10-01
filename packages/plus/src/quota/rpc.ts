import { Schema } from "effect"
import { Rpc } from "@opencode/schema/rpc"

export const Definition = Rpc.define({
  id: "opencode.plus.quota",
  methods: {
    status: {
      input: Schema.toStandardSchemaV1(Schema.Struct({ sessionID: Schema.String })),
      output: Schema.toStandardSchemaV1(
        Schema.Array(Schema.Struct({ sessionID: Schema.String, kind: Schema.String, text: Schema.String })),
      ),
      errors: {},
    },
  },
  events: {},
})
