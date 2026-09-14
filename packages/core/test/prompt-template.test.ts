import { describe, expect, test } from "bun:test"
import { PromptTemplate } from "@opencode/core/prompt-template"

describe("PromptTemplate", () => {
  test("active resolves representative model ids", () => {
    expect(PromptTemplate.active({ id: "gpt-5", name: "GPT 5" })).toBe("gpt")
    expect(PromptTemplate.active({ id: "openai/gpt-6", name: "GPT 6" })).toBe("gpt")
    expect(PromptTemplate.active({ id: "muse-opus", name: "Muse" })).toBe("muse")
    expect(PromptTemplate.active({ id: "moonshot/kimi-k2", name: "Kimi" })).toBe("kimi")
    expect(PromptTemplate.active({ id: "arcee/trinity-large", name: "Trinity" })).toBe("trinity")
    expect(PromptTemplate.active({ id: "claude-opus-4", name: "Claude" })).toBe("general")
    expect(PromptTemplate.active({ id: "gemini-2.5-pro", name: "Gemini" })).toBe("general")
    expect(PromptTemplate.active({ id: "llama-3.3-70b", name: "Llama" })).toBe("general")
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
