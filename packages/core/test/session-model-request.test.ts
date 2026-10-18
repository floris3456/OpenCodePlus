import { describe, expect, test } from "bun:test"
import { Message, ToolResultPart, Media } from "@opencode/ai"
import { AnthropicMessages, OpenAIChat, OpenAIResponses } from "@opencode/ai/protocols"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { boundImages, imageLimits, SessionModelRequest, unsupportedParts } from "@opencode/core/session/model-request"
import { SessionModelTransport } from "@opencode/core/session/model-transport"
import { SessionRunnerModel } from "@opencode/core/session/runner/model"
import { DateTime, Effect } from "effect"
import { testEffect } from "./lib/effect"
import { PluginTestLayer } from "./plugin/fixture"

const it = testEffect(PluginTestLayer)

const capabilities = (input: string[]) => ({ tools: true, input, output: ["text"] })

describe("SessionModelRequest.unsupportedParts", () => {
  test("replaces unsupported user media with a visible error", () => {
    const messages = unsupportedParts(
      [
        Message.user([
          Message.text("Describe these files"),
          { type: "media", media: Media.base64("aGVsbG8=", "image/png"), filename: "logo.png" },
          { type: "media", media: Media.base64("JVBERg==", "application/pdf"), filename: "document.pdf" },
        ]),
      ],
      capabilities(["text"]),
    )

    expect(messages[0]?.content).toEqual([
      Message.text("Describe these files"),
      Message.text('ERROR: Cannot read "logo.png" (this model does not support image input). Inform the user.'),
      Message.text('ERROR: Cannot read "document.pdf" (this model does not support pdf input). Inform the user.'),
    ])
  })

  test("replaces unsupported media nested in tool results", () => {
    const messages = unsupportedParts(
      [
        Message.tool(
          ToolResultPart.make({
            id: "call_1",
            name: "read",
            result: {
              type: "content",
              value: [
                { type: "text", text: "Image read successfully" },
                { type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "logo.png" },
              ],
            },
          }),
        ),
      ],
      capabilities(["text"]),
    )

    expect(messages[0]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          {
            type: "text",
            text: 'ERROR: Cannot read "logo.png" (this model does not support image input). Inform the user.',
          },
        ],
      },
    })
  })

  test("replaces images xAI cannot decode and keeps png, jpeg and webp", () => {
    const image = (mime: string, name: string) => ({
      type: "media" as const,
      media: Media.base64("aGVsbG8=", mime),
      filename: name,
    })
    const user = [image("image/png", "a.png"), image("image/jpeg", "b.jpg"), image("image/webp", "c.webp")]
    const messages = [
      Message.user([...user, image("image/gif", "d.gif")]),
      Message.tool(
        ToolResultPart.make({
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Image read successfully" },
              { type: "file", uri: "data:image/gif;base64,R0lGODlh", mime: "image/gif", name: "e.gif" },
            ],
          },
        }),
      ),
    ]
    const result = unsupportedParts(messages, capabilities(["text", "image"]), "xai")

    expect(result[0]?.content).toEqual([
      ...user,
      Message.text('ERROR: Cannot read "d.gif" (this model does not support image/gif input). Inform the user.'),
    ])
    expect(result[1]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Image read successfully" },
          {
            type: "text",
            text: 'ERROR: Cannot read "e.gif" (this model does not support image/gif input). Inform the user.',
          },
        ],
      },
    })
    expect(unsupportedParts(messages, capabilities(["text", "image"]), "openai")).toEqual(messages)
  })

  test("preserves supported media", () => {
    const message = Message.user({ type: "media", media: Media.base64("aGVsbG8=", "image/png") })
    expect(unsupportedParts([message], capabilities(["text", "image"]))[0]?.content).toEqual(message.content)
  })

  test("returns the same messages when nothing is unsupported", () => {
    const messages = [
      Message.user([Message.text("hi"), { type: "media", media: Media.base64("aGVsbG8=", "image/png") }]),
      Message.assistant("hello"),
      Message.tool(
        ToolResultPart.make({
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [{ type: "file", uri: "data:image/png;base64,aGVsbG8=", mime: "image/png", name: "logo.png" }],
          },
        }),
      ),
    ]
    const result = unsupportedParts(messages, capabilities(["text", "image"]))
    expect(result).toHaveLength(messages.length)
    result.forEach((message, index) => expect(message).toBe(messages[index]))
  })

  test("rebuilds only messages with unsupported media", () => {
    const text = Message.user("plain")
    const supported = Message.tool(
      ToolResultPart.make({
        id: "call_1",
        name: "read",
        result: { type: "content", value: [{ type: "text", text: "no files" }] },
      }),
    )
    const tool = ToolResultPart.make({
      id: "call_2",
      name: "read",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Read" },
          { type: "file", uri: "data:application/pdf;base64,JVBERg==", mime: "application/pdf" },
        ],
      },
    })
    const unsupported = Message.make({ role: "tool", content: [tool, Message.text("caption")] })
    const result = unsupportedParts([text, supported, unsupported], capabilities(["text"]))

    expect(result[0]).toBe(text)
    expect(result[1]).toBe(supported)
    expect(result[2]).not.toBe(unsupported)
    expect(result[2]).toBeInstanceOf(Message)
    expect(result[2]?.content[1]).toEqual(Message.text("caption"))
    expect(result[2]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [
          { type: "text", text: "Read" },
          { type: "text", text: "ERROR: Cannot read pdf (this model does not support pdf input). Inform the user." },
        ],
      },
    })
    expect(tool.result).toMatchObject({
      type: "content",
      value: [
        { type: "text", text: "Read" },
        { type: "file", mime: "application/pdf" },
      ],
    })
  })
})

describe("SessionModelRequest.boundImages", () => {
  const read = (index: number, mebibytes: number) =>
    Message.tool(
      ToolResultPart.make({
        id: `call_${index}`,
        name: "read",
        result: {
          type: "content",
          value: [
            { type: "text", text: "Image read successfully" },
            {
              type: "file",
              uri: `data:image/png;base64,${"a".repeat(mebibytes * 1024 * 1024)}`,
              mime: "image/png",
              name: `${index}.png`,
            },
          ],
        },
      }),
    )
  /** Per message: "image", "warned" (attached, with a fill note) or "withheld" (a note instead of the image). */
  const outcome = (messages: ReturnType<typeof boundImages>) =>
    messages.map((message) => {
      const part = message.content[0]
      if (part?.type !== "tool-result" || part.result.type !== "content") return "other"
      const items = part.result.value
      if (items.some((item) => item.type === "text" && item.text.startsWith("[Image not attached: "))) return "withheld"
      if (items.some((item) => item.type === "text" && item.text.startsWith("[Images in this chat: "))) return "warned"
      return items.some((item) => item.type === "file") ? "image" : "other"
    })

  test("preserves images below the limit", () => {
    const messages = [Message.user({ type: "media", media: Media.base64("aGVsbG8=", "image/png") })]
    expect(boundImages(messages)).toBe(messages)
  })

  test("never changes an image already sent: each request repeats the previous one and only adds to it", () => {
    // 4 MiB screenshots: the sixth brings 25 MiB to 96%, the seventh does not fit.
    const history = Array.from({ length: 9 }, (_, index) => read(index, 4))
    const sent = Array.from({ length: history.length }, (_, length) => boundImages(history.slice(0, length + 1)))
    sent.slice(1).forEach((request, index) => expect(request.slice(0, index + 1)).toEqual([...sent[index]!]))
    expect(outcome(sent.at(-1)!)).toEqual(["image", "image", "image", "image", "image", "warned", "withheld", "withheld", "withheld"])
    // The earlier images are the very same messages, untouched.
    sent.at(-1)!.slice(0, 4).forEach((message, index) => expect(message).toBe(history[index]))
  })

  test("tells the model how full the chat is and why a new image is missing", () => {
    const result = boundImages(Array.from({ length: 7 }, (_, index) => read(index, 4)))
    const notes = result.flatMap((message) =>
      message.content.flatMap((part) =>
        part.type === "tool-result" && part.result.type === "content"
          ? part.result.value.flatMap((item) => (item.type === "text" && item.text.startsWith("[") ? [item.text] : []))
          : [],
      ),
    )
    expect(notes).toEqual([
      "[Images in this chat: 96% of what one request may carry (24.0 of 25.0 MB). At 100% new images are no longer attached; compacting the chat (/compact) makes room for more.]",
      "[Image not attached: 6.png. This chat already carries the most images one request may hold (6 images, 24.0 of 25.0 MB). The earlier images are still attached. New images stay unattached until the chat is compacted (/compact).]",
    ])
  })

  test("says how full the chat is once, on the image that reaches 90%", () => {
    // A budget of exactly twenty 1 MiB images: the eighteenth reaches 90%, the twenty-first does not fit.
    const history = Array.from({ length: 21 }, (_, index) => read(index, 1))
    const each = 1024 * 1024 + "data:image/png;base64,".length
    const result = outcome(boundImages(history, { bytes: 20 * each }))
    expect(result.map((value, index) => (value === "image" ? undefined : [index, value])).filter(Boolean)).toEqual([
      [17, "warned"],
      [20, "withheld"],
    ])
  })

  test("a provider's image count is a limit too", () => {
    const history = Array.from({ length: 4 }, (_, index) => read(index, 0))
    // 1 and 2 of 3 are under 80%; 3 of 3 is full and says so; the fourth is not attached.
    expect(outcome(boundImages(history, { bytes: 25 * 1024 * 1024, count: 3 }))).toEqual(["image", "image", "warned", "withheld"])
  })

  test("withholds the image that does not fit inside a tool result, keeping the one before it", () => {
    const image = "a".repeat(13 * 1024 * 1024)
    const result = boundImages([
      Message.tool(
        ToolResultPart.make({
          id: "call_1",
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "file", uri: `data:image/png;base64,${image}`, mime: "image/png", name: "first.png" },
              { type: "file", uri: `data:image/png;base64,${image}`, mime: "image/png", name: "second.png" },
            ],
          },
        }),
      ),
    ])

    expect(result[0]?.content[0]).toMatchObject({
      type: "tool-result",
      result: {
        type: "content",
        value: [{ type: "file", name: "first.png" }, { type: "text", text: expect.stringContaining("Image not attached: second.png") }],
      },
    })
  })

  test("the image limits follow the provider's documented ones", () => {
    const limits = (route: { model: (input: { id: string; provider: string }) => Parameters<typeof SessionRunnerModel.resolved>[0] }, context: number) =>
      imageLimits(
        SessionRunnerModel.resolved(route.model({ id: "model", provider: "test" }), {
          capabilities: { tools: true, input: ["text", "image"], output: ["text"] },
          cost: [],
          limit: { context, output: 32_000 },
        }),
      )
    const mib25 = 25 * 1024 * 1024
    expect(limits(AnthropicMessages.route, 1_000_000)).toEqual({ bytes: mib25, count: 600 })
    expect(limits(AnthropicMessages.route, 200_000)).toEqual({ bytes: mib25, count: 100 })
    expect(limits(OpenAIResponses.route, 400_000)).toEqual({ bytes: mib25, count: 500 })
    expect(limits(OpenAIChat.route, 128_000)).toEqual({ bytes: mib25 })
  })
})

const testSession = Session.Info.make({
  id: Session.ID.make("ses_idle_timeout"),
  projectID: Project.ID.global,
  cost: Money.USD.zero,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  time: { created: DateTime.makeUnsafe(0), updated: DateTime.makeUnsafe(0) },
  location: Location.Ref.make({ directory: AbsolutePath.make("/project") }),
})

const makeModel = (chunkTimeout?: number) =>
  SessionRunnerModel.resolved(OpenAIChat.route.model({ id: "gpt-5.5", provider: "test" }), {
    capabilities: { tools: true, input: ["text"], output: ["text"] },
    cost: [],
    limit: { context: 200_000, output: 32_000 },
    chunkTimeout,
  })

const testTransport = SessionModelTransport.Service.of({
  bind: () => ({ execute: () => Effect.die("unused WebSocket execution") }),
  close: () => Effect.void,
  closeAll: Effect.void,
})

describe("SessionModelRequest.idleTimeout", () => {
  it.effect("prepares options.idleTimeout as '10 minutes' by default", () =>
    Effect.gen(function* () {
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const prepared = yield* requests.primary({
        session: testSession,
        agent: Agent.ID.make("build"),
        model: makeModel(),
        system: [],
        messages: [],
      })
      expect(prepared.options.idleTimeout).toBe("10 minutes")
    }).pipe(Effect.provideService(SessionModelTransport.Service, testTransport)),
  )

  it.effect("prepares options.idleTimeout as chunkTimeout when set", () =>
    Effect.gen(function* () {
      const requests = yield* SessionModelRequest.Service.pipe(Effect.provide(SessionModelRequest.layer))
      const prepared = yield* requests.primary({
        session: testSession,
        agent: Agent.ID.make("build"),
        model: makeModel(20_000),
        system: [],
        messages: [],
      })
      expect(prepared.options.idleTimeout).toBe(20_000)
    }).pipe(Effect.provideService(SessionModelTransport.Service, testTransport)),
  )
})
