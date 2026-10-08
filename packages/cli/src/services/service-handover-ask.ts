export * as ServiceHandoverAsk from "./service-handover-ask"

// The question the Plus TUI asks before it takes the screen while chats run
// on a service of another version. Lives apart from service-handover so
// non-interactive commands never bundle prompt UI.

import { select } from "@clack/prompts"
import { Effect } from "effect"
import { prompt } from "../ui/prompt"
import type { Ask } from "./service-handover"

export const askHandover: Ask = (info) =>
  Effect.gen(function* () {
    const chats = info.active === 1 ? "1 chat" : `${info.active} chats`
    const answer = yield* prompt<string>(() =>
      select({
        message: `A service of version ${info.version} is running ${chats}.`,
        options: [
          {
            value: "replace",
            label: "Replace now",
            hint: "running chats pause and resume after the restart",
          },
          { value: "existing", label: "Use the old one", hint: "connect with a version warning" },
          { value: "quit", label: "Quit" },
        ],
      }),
    ).pipe(
      Effect.catch((cause) =>
        // Dismissing the prompt quits instead of failing into the TUI.
        typeof cause === "symbol" ? Effect.succeed("quit") : Effect.fail(cause),
      ),
    )
    if (answer !== "replace" && answer !== "existing" && answer !== "quit")
      return yield* Effect.fail(new Error(`Unknown handover answer: ${answer}`))
    return answer
  })
