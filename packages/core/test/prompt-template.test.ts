import { describe, expect, test } from "bun:test"
import { PromptTemplate } from "@opencode/core/prompt-template"
import PROMPT_GPT from "../src/plugin/system-prompt/gpt.txt"
import PROMPT_ASTRA from "../src/plugin/system-prompt/gpt-astra.txt"

describe("PromptTemplate", () => {
  test("active resolves representative model ids", () => {
    expect(PromptTemplate.active({ id: "gpt-5", name: "GPT 5" })).toBe("gpt")
    expect(PromptTemplate.active({ id: "openai/gpt-6", name: "GPT 6" })).toBe("gpt")
    expect(PromptTemplate.active({ id: "muse-opus", name: "Muse" })).toBe("muse")
    expect(PromptTemplate.active({ id: "moonshot/kimi-k2", name: "Kimi" })).toBe("kimi")
    expect(PromptTemplate.active({ id: "arcee/trinity-large", name: "Trinity" })).toBe("trinity")
    expect(PromptTemplate.active({ id: "claude-opus-4", name: "Claude" })).toBe("claude")
    expect(PromptTemplate.active({ id: "cliproxyapi/claude-fable-5", name: "Claude Fable 5" })).toBe("claude")
    expect(PromptTemplate.active({ id: "gemini-2.5-pro", name: "Gemini" })).toBe("gemini")
    expect(PromptTemplate.active({ id: "llama-3.3-70b", name: "Llama" })).toBe("general")
  })

  test("raw returns the template optimize renders for the model", () => {
    // The gpt-6 rule lives here so the OpenAI optimize plugin and the
    // plugin-host seam can never drift: gpt-6 classifies as gpt but
    // renders the astra text.
    expect(PromptTemplate.raw({ id: "gpt-6", name: "GPT 6" })).toBe(PROMPT_ASTRA)
    expect(PromptTemplate.raw({ id: "openai/gpt-6-mini", name: "GPT 6 Mini" })).toBe(PROMPT_ASTRA)
    expect(PromptTemplate.raw({ id: "OpenAI/GPT-6", name: "GPT 6" })).toBe(PROMPT_ASTRA)
    expect(PromptTemplate.raw({ id: "gpt-5", name: "GPT 5" })).toBe(PROMPT_GPT)
    const byId = new Map(PromptTemplate.templates.map((template) => [template.id, template.text]))
    expect(PromptTemplate.raw({ id: "moonshot/kimi-k2", name: "Kimi" })).toBe(byId.get("kimi"))
    expect(PromptTemplate.raw({ id: "arcee/trinity-large", name: "Trinity" })).toBe(byId.get("trinity"))
    expect(PromptTemplate.raw({ id: "muse-opus", name: "Muse" })).toBe(byId.get("muse"))
    expect(PromptTemplate.raw({ id: "claude-fable-5", name: "Claude" })).toBeUndefined()
    expect(PromptTemplate.raw({ id: "gemini-2.5-pro", name: "Gemini" })).toBeUndefined()
    expect(PromptTemplate.raw({ id: "llama-3.3-70b", name: "Llama" })).toBeUndefined()
  })

  test("templates have stable unique ids and non-empty text", () => {
    const ids = PromptTemplate.templates.map((template) => template.id)
    expect(ids).toEqual(["gpt", "claude", "muse", "gemini", "general", "kimi", "trinity"])
    expect(new Set(ids).size).toBe(ids.length)
    for (const template of PromptTemplate.templates) {
      expect(template.title.length).toBeGreaterThan(0)
      expect(template.text.length).toBeGreaterThan(0)
    }
  })
})
