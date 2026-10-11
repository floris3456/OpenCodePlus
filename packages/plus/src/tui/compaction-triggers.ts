import type { Plugin } from "@opencode/plugin/tui"
import { Definition } from "../rpc.js"

/** Blank restores model inheritance; it never disables the normal context limit. */
export function parseCompactionTrigger(text: string) {
  const value = text.trim()
  if (value === "") return { value: null }
  const tokens = Number(value)
  if (!/^\d+$/.test(value) || !Number.isSafeInteger(tokens) || tokens <= 0)
    return { error: "Enter a positive whole number of tokens, or leave blank to reset" }
  return { value: tokens }
}

/** Changes plugin settings only: no prompt submission, refresh or agent notification. */
export async function editCompactionTriggers(context: Plugin.Context) {
  const route = context.ui.router.current()
  if (route.type !== "session") {
    context.ui.toast.show({ variant: "warning", message: "Open a chat to set its compaction triggers" })
    return
  }
  const sessionID = route.sessionID
  const plus = context.client.rpc(Definition)
  const current = await plus["compaction.triggers"]({ sessionID }).catch((error: unknown) => {
    context.ui.toast.show({ variant: "error", message: error instanceof Error ? error.message : String(error) })
  })
  if (!current) return
  const inputText = await context.ui.dialog.prompt({
    title: "Compaction input trigger · this chat",
    description: "Estimated next-prompt tokens. Overrides the model's early trigger; normal context limit remains. Blank follows model settings. Both fields save together.",
    value: current.input === undefined ? "" : String(current.input),
    placeholder: "Follow model settings",
  })
  if (inputText === undefined) return
  const input = parseCompactionTrigger(inputText)
  if (input.error) {
    context.ui.toast.show({ variant: "error", message: input.error })
    return
  }
  const outputText = await context.ui.dialog.prompt({
    title: "Compaction output trigger · this chat",
    description: "Generated output + reasoning tokens since compaction. Blank follows model settings. Applies at the next safe boundary; no message is sent. Automatic compaction must be on.",
    value: current.output === undefined ? "" : String(current.output),
    placeholder: "Follow model settings",
  })
  if (outputText === undefined) return
  const output = parseCompactionTrigger(outputText)
  if (output.error) {
    context.ui.toast.show({ variant: "error", message: output.error })
    return
  }
  const saved = await plus["compaction.triggers.set"]({
    sessionID,
    input: input.value,
    output: output.value,
  }).catch((error: unknown) => {
    context.ui.toast.show({ variant: "error", message: error instanceof Error ? error.message : String(error) })
  })
  if (!saved) return
  context.ui.toast.show({
    variant: "success",
    message: `Compaction triggers saved: input ${saved.input ?? "follow model"}, output ${saved.output ?? "follow model"}. Next safe boundary; no message sent.`,
  })
}
