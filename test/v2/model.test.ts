import { describe, expect, it } from "vitest"
import { DEFAULT_CONTEXT_LIMIT, DEFAULT_OUTPUT_LIMIT, RESPONSES_API_PACKAGE_V2 } from "../../src/constants.js"
import { toModelInfo } from "../../src/v2/model.js"

describe("toModelInfo", () => {
  it("maps ids, limits, capabilities and prices", () => {
    const info = toModelInfo(
      {
        id: "claude-sonnet",
        mode: "chat",
        max_input_tokens: 200_000,
        max_output_tokens: 16_000,
        supports_function_calling: true,
        supports_vision: true,
        supports_pdf_input: true,
        input_cost_per_million: 3,
        output_cost_per_million: 15,
        cache_read_cost_per_million: 0.3,
        cache_write_cost_per_million: 3.75,
      },
      "work",
    )

    expect(info).toEqual({
      id: "claude-sonnet",
      modelID: "claude-sonnet",
      providerID: "work",
      name: "claude-sonnet",
      capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
      variants: [],
      time: { released: 0 },
      cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }],
      status: "active",
      enabled: true,
      limit: { context: 200_000, output: 16_000 },
    })
  })

  it("prices cache tokens like input tokens when the proxy does not say otherwise", () => {
    const info = toModelInfo({ id: "m", input_cost_per_million: 2, output_cost_per_million: 8 }, "p")
    expect(info.cost).toEqual([{ input: 2, output: 8, cache: { read: 2, write: 2 } }])
  })

  it("reports no price at all when either side is missing", () => {
    expect(toModelInfo({ id: "m", input_cost_per_million: 2 }, "p").cost).toEqual([])
    expect(toModelInfo({ id: "m" }, "p").cost).toEqual([])
  })

  it("falls back to defaults when the proxy reports no limits", () => {
    expect(toModelInfo({ id: "m" }, "p").limit).toEqual({
      context: DEFAULT_CONTEXT_LIMIT,
      output: DEFAULT_OUTPUT_LIMIT,
    })
  })

  it("uses max_tokens for both limits and context for a missing output limit", () => {
    expect(toModelInfo({ id: "m", max_tokens: 32_000 }, "p").limit).toEqual({ context: 32_000, output: 32_000 })
    expect(toModelInfo({ id: "m", max_input_tokens: 100_000 }, "p").limit).toEqual({
      context: 100_000,
      output: 100_000,
    })
  })

  it("assumes tool calling unless the proxy denies it", () => {
    expect(toModelInfo({ id: "m" }, "p").capabilities.tools).toBe(true)
    expect(toModelInfo({ id: "m", supports_function_calling: false }, "p").capabilities.tools).toBe(false)
  })

  it("switches Responses-API models to the openai adapter", () => {
    expect(toModelInfo({ id: "gpt-5", mode: "responses" }, "p").package).toBe(RESPONSES_API_PACKAGE_V2)
    expect(toModelInfo({ id: "gpt-4", mode: "chat" }, "p")).not.toHaveProperty("package")
  })
})
