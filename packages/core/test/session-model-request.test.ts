import { describe, expect, test } from "bun:test"
import { Message, ToolResultPart, Media } from "@opencode/ai"
import { OpenAIChat } from "@opencode/ai/protocols"
import { Agent } from "@opencode/schema/agent"
import { Money } from "@opencode/schema/money"
import { Session } from "@opencode/schema/session"
import { Location } from "@opencode/core/location"
import { Project } from "@opencode/core/project"
import { AbsolutePath } from "@opencode/core/schema"
import { boundImages, SessionModelRequest, unsupportedParts } from "@opencode/core/session/model-request"
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
  test("preserves images below the trigger", () => {
    const messages = [Message.user({ type: "media", media: Media.base64("aGVsbG8=", "image/png") })]
    expect(boundImages(messages)).toBe(messages)
  })

  test("replaces oldest images until the retained payload reaches the target", () => {
    const image = "a".repeat(9 * 1024 * 1024)
    const text = Message.user("plain")
    const third = Message.user({ type: "media", media: Media.base64(image, "image/png"), filename: "third.png" })
    const messages = [
      Message.user({ type: "media", media: Media.base64(image, "image/png"), filename: "first.png" }),
      text,
      Message.user({ type: "media", media: Media.base64(image, "image/png"), filename: "second.png" }),
      third,
    ]
    const result = boundImages(messages)

    expect(result[0]).toBeInstanceOf(Message)
    expect(result[0]?.content).toEqual([Message.text(expect.stringContaining("image was removed"))])
    expect(result[1]).toBe(text)
    expect(result[2]).not.toBe(messages[2])
    expect(result[2]?.content[0]).toMatchObject({ type: "text" })
    expect(result[3]).toBe(third)
  })

  test("keeps earlier cuts when a newer image arrives, until the kept images pass the trigger again", () => {
    // Seven 4 MiB screenshots pass 25 MiB at the seventh, which cuts the oldest four (down to 12 MiB kept).
    const image = "a".repeat(4 * 1024 * 1024)
    const read = (index: number) =>
      Message.tool(
        ToolResultPart.make({
          id: `call_${index}`,
          name: "read",
          result: {
            type: "content",
            value: [
              { type: "text", text: "Image read successfully" },
              { type: "file", uri: `data:image/png;base64,${image}`, mime: "image/png", name: `${index}.png` },
            ],
          },
        }),
      )
    const history = Array.from({ length: 11 }, (_, index) => read(index))
    const removed = (messages: ReturnType<typeof boundImages>) =>
      messages.flatMap((message, index) =>
        message.content.some(
          (part) =>
            part.type === "tool-result" &&
            part.result.type === "content" &&
            part.result.value.some((item) => item.type === "text" && item.text.includes("image was removed")),
        )
          ? [index]
          : [],
      )

    expect(removed(boundImages(history.slice(0, 7)))).toEqual([0, 1, 2, 3])
    // Images 8 to 10 fit under the trigger again: the sent prefix stays byte-for-byte the same.
    for (const length of [8, 9, 10]) {
      const sent = boundImages(history.slice(0, length))
      expect(removed(sent)).toEqual([0, 1, 2, 3])
      expect(sent.slice(0, 7)).toEqual([...boundImages(history.slice(0, 7))])
    }
    // The eleventh passes 25 MiB again (28 MiB kept) and cuts the next batch at once, down to 12 MiB.
    expect(removed(boundImages(history))).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
  })

  test("replaces images nested in tool results", () => {
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
        value: [{ type: "text" }, { type: "file", name: "second.png" }],
      },
    })
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
