import { describe, expect, test } from "bun:test"
import { Duration, Schema } from "effect"
import { ConfigWarming } from "@opencode/core/config/warming"
import { Info } from "@opencode/schema/config"
import { Scoped, Warming } from "@opencode/schema/config/warming"

const decode = Schema.decodeUnknownSync(Info)
const decodeGlobalWarming = Schema.decodeUnknownSync(Warming)
const decodeScopedWarming = Schema.decodeUnknownSync(Scoped)

describe("config warming", () => {
  test("accepts boolean enablement", () => {
    expect(decode({}).warming).toBeUndefined()
    expect(decode({ warming: false }).warming).toBe(false)
    expect(decode({ warming: true }).warming).toBe(true)
  })

  test("decodes custom durations", () => {
    const warming = decode({
      warming: { prompt: "Reply pong", interval: "2 minutes", duration: "1 hour" },
    }).warming
    expect(typeof warming).toBe("object")
    if (typeof warming !== "object") return
    expect(warming.prompt).toBe("Reply pong")
    expect(warming.interval).toEqual(Duration.minutes(2))
    expect(warming.duration).toEqual(Duration.hours(1))
  })

  test("decodes provider and model warming in settings overlays", () => {
    const provider = decode({
      providers: {
        anthropic: {
          settings: { warming: { prompt: "provider ping", interval: "2 minutes" } },
          models: {
            opus: { settings: { warming: { duration: "1 hour" } } },
            sonnet: { settings: { warming: false } },
          },
        },
      },
    }).providers?.anthropic
    // Scoped durations stay in their configuration string form: provider and model
    // settings pass through JSON overlays that cannot carry decoded Duration values.
    expect(provider?.settings?.warming).toEqual({ prompt: "provider ping", interval: "2 minutes" })
    expect(provider?.models?.opus?.settings?.warming).toEqual({ duration: "1 hour" })
    expect(provider?.models?.sonnet?.settings?.warming).toBe(false)
  })
})

const resolved = (input: { global?: unknown; provider?: unknown; model?: unknown; id?: string }) => {
  const settings = ConfigWarming.resolve({
    global: input.global === undefined ? undefined : decodeGlobalWarming(input.global),
    provider: input.provider === undefined ? undefined : decodeScopedWarming(input.provider),
    model: input.model === undefined ? undefined : decodeScopedWarming(input.model),
    ...(input.id === undefined ? {} : { id: input.id }),
  })
  if (!settings) return
  return {
    prompt: settings.prompt,
    interval: Duration.toMillis(settings.interval),
    duration: Duration.toMillis(settings.duration),
  }
}

const defaults = {
  prompt: "This is a keep-alive request. Do not perform any work or use tools. Reply with exactly: OK",
  interval: Duration.toMillis(Duration.minutes(4)),
  duration: Duration.toMillis(Duration.minutes(30)),
}

describe("warming resolution", () => {
  test("warms Claude and GPT-5.6+ when nothing configures warming", () => {
    const gpt = { ...defaults, interval: Duration.toMillis(Duration.minutes(25)), duration: Duration.toMillis(Duration.minutes(90)) }
    expect(resolved({ id: "claude-opus-5-5" })).toEqual(defaults)
    expect(resolved({ id: "anthropic/claude-haiku-5-5" })).toEqual(defaults)
    expect(resolved({ id: "gpt-6-astra" })).toEqual(gpt)
    expect(resolved({ id: "gpt-5.6-luna" })).toEqual(gpt)
    for (const id of ["gpt-5.3-codex-spark", "gpt-oss-120b", "gemini-3.8-flash-high", "deepseek-v4.1-flash"])
      expect(resolved({ id })).toBeUndefined()
    // Any configuration decides instead; `true` and objects start from the model's own defaults.
    expect(resolved({ id: "claude-opus-5-5", model: false })).toBeUndefined()
    expect(resolved({ id: "claude-opus-5-5", global: false })).toBeUndefined()
    expect(resolved({ id: "gpt-6-astra", model: true })).toEqual(gpt)
    expect(resolved({ id: "gpt-6-astra", provider: { prompt: "ping" } })).toEqual({ ...gpt, prompt: "ping" })
    expect(resolved({ id: "deepseek-v4.1-flash", global: true })).toEqual(defaults)
  })

  test("resolves global-only settings unchanged", () => {
    expect(resolved({})).toBeUndefined()
    expect(resolved({ global: false })).toBeUndefined()
    expect(resolved({ global: true })).toEqual(defaults)
    expect(resolved({ global: { prompt: "global", interval: "2 minutes" } })).toEqual({
      ...defaults,
      prompt: "global",
      interval: Duration.toMillis(Duration.minutes(2)),
    })
  })

  test("provider inherits from global and model overrides provider", () => {
    expect(
      resolved({
        global: { prompt: "global", interval: "1 minute", duration: "10 minutes" },
        provider: { prompt: "provider" },
      }),
    ).toEqual({
      prompt: "provider",
      interval: Duration.toMillis(Duration.minutes(1)),
      duration: Duration.toMillis(Duration.minutes(10)),
    })
    expect(
      resolved({
        global: { prompt: "global", interval: "1 minute", duration: "10 minutes" },
        provider: { prompt: "provider" },
        model: { prompt: "model" },
      }),
    ).toEqual({
      prompt: "model",
      interval: Duration.toMillis(Duration.minutes(1)),
      duration: Duration.toMillis(Duration.minutes(10)),
    })
    expect(
      resolved({
        global: { prompt: "global" },
        provider: { interval: "2 minutes" },
        model: { duration: "1 hour" },
      }),
    ).toEqual({
      prompt: "global",
      interval: Duration.toMillis(Duration.minutes(2)),
      duration: Duration.toMillis(Duration.hours(1)),
    })
  })

  test("false disables a scope and true resets it to defaults", () => {
    expect(resolved({ global: { prompt: "global" }, provider: false })).toBeUndefined()
    expect(resolved({ global: { prompt: "global" }, provider: { prompt: "provider" }, model: false })).toBeUndefined()
    expect(resolved({ global: { prompt: "global" }, provider: true })).toEqual(defaults)
    expect(resolved({ global: { prompt: "global" }, provider: { prompt: "provider" }, model: true })).toEqual(defaults)
  })

  test("an object enables a disabled scope over defaults", () => {
    expect(
      resolved({
        global: { prompt: "global", duration: "10 minutes" },
        provider: false,
        model: { interval: "2 minutes" },
      }),
    ).toEqual({ ...defaults, interval: Duration.toMillis(Duration.minutes(2)) })
    expect(resolved({ global: false, provider: { prompt: "provider" } })).toEqual({ ...defaults, prompt: "provider" })
    expect(resolved({ global: false, provider: true, model: { prompt: "model" } })).toEqual({
      ...defaults,
      prompt: "model",
    })
  })
})
