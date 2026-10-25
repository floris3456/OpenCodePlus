import type { Plugin } from "@opencode/plugin"
import { Model } from "@opencode/schema/model"
import { Session } from "@opencode/schema/session"
import { Schema } from "effect"
import type { UsageInput, UsageResult, UsageSnapshot } from "./quota/usage.js"

/**
 * `pacer.usage`: the credential usage the Usage sidebar and `/usage` show, for an agent to read itself
 * (in Code Mode `tools.pacer.usage({})`): each account's 5-hour and 7-day windows, the account serving
 * this chat, and where Pacer moves it next.
 */
export const UsageToolInput = Schema.Struct({
  model: Schema.optionalKey(Schema.String).annotate({
    description: 'A model as "provider/model". Default: this chat\'s model.',
  }),
  all: Schema.optionalKey(Schema.Boolean).annotate({
    description: "Every account Pacer meters, not only those serving the model.",
  }),
})
export type UsageToolInput = typeof UsageToolInput.Type

const WindowOutput = Schema.Struct({
  window: Schema.String.annotate({ description: 'Its length, as "5h" or "7d", with its scope when not every model ("7d sonnet").' }),
  left: Schema.Number.annotate({ description: "Percent left." }),
  resets_at: Schema.optionalKey(Schema.String).annotate({ description: "When it resets (ISO 8601); absent while it has not started." }),
  resets_in: Schema.optionalKey(Schema.String),
  state: Schema.String.annotate({ description: "current, dormant (not started), stale, estimated, …" }),
})

const AccountOutput = Schema.Struct({
  alias: Schema.String,
  provider: Schema.String,
  id: Schema.String,
  in_use: Schema.Boolean.annotate({ description: "The account serving (or that last served) this chat." }),
  shared_with: Schema.Array(Schema.String).annotate({ description: "Aliases of the same account: one quota." }),
  windows: Schema.Array(WindowOutput),
})

export const UsageToolOutput = Schema.Struct({
  text: Schema.String.annotate({ description: "The same as a short readable summary." }),
  model: Schema.String,
  in_use: Schema.optionalKey(Schema.String).annotate({ description: "Alias of the account serving this chat now." }),
  last_used: Schema.optionalKey(Schema.String).annotate({ description: "Alias of the account that served it last, while idle." }),
  next_use: Schema.optionalKey(
    Schema.Struct({ alias: Schema.String, reason: Schema.String }).annotate({
      description: "Where Pacer moves this chat once its prompt cache is cold.",
    }),
  ),
  force_use: Schema.optionalKey(
    Schema.Struct({ alias: Schema.String, when: Schema.Literals(["now", "soon"]) }).annotate({
      description: "Where a forced move sends it: its account cannot serve now, or will not soon.",
    }),
  ),
  accounts: Schema.Array(AccountOutput),
})
export type UsageToolOutput = typeof UsageToolOutput.Type

export function registerUsageTool(ctx: Plugin.Context, read: (input: UsageInput) => Promise<UsageResult>) {
  return ctx.tool.transform((editor) => {
    editor.namespace({
      name: "pacer",
      description: "Credential usage of the CLIProxyAPI accounts, as Pacer meters it.",
    })
    editor.add({
      name: "usage",
      description:
        "Read the credential usage of the CLIProxyAPI accounts: each account's 5-hour and 7-day windows (percent left, when they reset), which account serves this chat, and where Pacer moves it next (NEXT USE once its cache is cold, FORCE USE when its account cannot serve). Read-only; it sends no model request.",
      input: UsageToolInput,
      output: UsageToolOutput,
      options: { namespace: "pacer" },
      origin: { type: "plugin", name: "opencode-pacer" },
      execute: async (input, context) => {
        const model = input.model === undefined ? await chatModel(ctx, context.sessionID) : Model.Ref.parse(input.model)
        const result = await read({
          sessionID: context.sessionID,
          providerID: model.providerID,
          modelID: model.id,
          all: input.all ?? false,
        })
        if (result.status !== "ready" || result.snapshot === undefined)
          throw new Error(result.message ?? "Pacer's usage is not available.")
        const output = usageOutput(result.snapshot, `${model.providerID}/${model.id}`, Date.now())
        return { output, content: output.text }
      },
    })
  })
}

async function chatModel(ctx: Plugin.Context, sessionID: string) {
  const session = await ctx.session.get({ sessionID: Session.ID.make(sessionID) })
  if (session.model === undefined) throw new Error('This chat has no model yet; pass model as "provider/model".')
  return session.model
}

/** The snapshot the Usage sidebar reads, as the tool's output. */
export function usageOutput(snapshot: UsageSnapshot, model: string, now: number): UsageToolOutput {
  const serving = snapshot.active[0]
  const served = serving ?? (snapshot.current || undefined)
  const alias = (id: string | undefined) => snapshot.credentials.find((credential) => credential.id === id)?.alias ?? id
  const next = snapshot.next_use
  const accounts = snapshot.credentials.map((credential) => ({
    alias: credential.alias,
    provider: credential.provider,
    id: credential.id,
    in_use: credential.id === served,
    shared_with: credential.shared_with,
    windows: credential.windows
      .filter((window) => window.not_applicable !== true)
      .map((window) => ({
        window: `${length(window.seconds)}${window.scope === "all" ? "" : ` ${window.scope}`}`,
        left: Math.floor(window.remaining),
        ...(window.dormant === true || window.reset === 0
          ? {}
          : { resets_at: new Date(window.reset * 1000).toISOString(), resets_in: duration(window.reset * 1000 - now) }),
        state: window.state ?? "current",
      })),
  }))
  const nextUse = next?.auth === undefined ? undefined : { alias: next.alias ?? alias(next.auth)!, reason: next.reason }
  const forceUse =
    next?.force_auth === undefined || next.force_reason === undefined
      ? undefined
      : { alias: next.force_alias ?? alias(next.force_auth)!, when: next.force_reason }
  const output = {
    model,
    ...(serving === undefined ? {} : { in_use: alias(serving)! }),
    ...(serving === undefined && served !== undefined ? { last_used: alias(served)! } : {}),
    ...(nextUse === undefined ? {} : { next_use: nextUse }),
    ...(forceUse === undefined ? {} : { force_use: forceUse }),
    accounts,
  }
  return { text: summary(output, serving !== undefined), ...output }
}

function summary(output: Omit<UsageToolOutput, "text">, running: boolean) {
  const lines = output.accounts.map((account) => {
    const marker = account.in_use ? (running ? " IN USE" : " LAST USED") : ""
    const windows = account.windows.map((window) =>
      window.resets_in === undefined
        ? `${window.window} ${window.left}% left (not started)`
        : `${window.window} ${window.left}% left, resets in ${window.resets_in}${window.state === "current" ? "" : ` (${window.state})`}`,
    )
    return `- ${account.alias} (${account.provider})${marker}: ${windows.join("; ") || "no limited windows"}`
  })
  return [
    `Credential usage for ${output.model}:`,
    ...(lines.length > 0 ? lines : ["No account serves this model."]),
    ...(output.next_use === undefined ? [] : [`NEXT USE, once this chat's cache is cold: ${output.next_use.alias}`]),
    ...(output.force_use === undefined
      ? []
      : [`FORCE USE ${output.force_use.when === "now" ? "now" : "soon"}: ${output.force_use.alias}`]),
  ].join("\n")
}

function length(seconds: number) {
  if (seconds % 86_400 === 0) return `${seconds / 86_400}d`
  if (seconds % 3600 === 0) return `${seconds / 3600}h`
  return `${Math.round(seconds / 60)}m`
}

function duration(ms: number) {
  if (ms <= 0) return "0m (awaiting a new reading)"
  const minutes = Math.round(ms / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  if (days > 0) return `${days}d ${hours}h`
  if (hours > 0) return `${hours}h ${minutes % 60}m`
  return `${minutes}m`
}
