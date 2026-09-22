import { Effect } from "effect"
import { Commands } from "../commands"
import { Runtime } from "../../framework/runtime"
import { runSearchMcpServer } from "../../../../plus/src/search/mcp"

export default Runtime.handler(
  Commands.commands["search-mcp"]!,
  Effect.fn("cli.searchMcp")(function* () {
    yield* Effect.promise(() => runSearchMcpServer())
    yield* Effect.never
  }),
)
