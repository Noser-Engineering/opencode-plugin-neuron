import { describe, expect, it, vi } from "vitest"
import { discoverModels, toModelConfig } from "../src/discovery.js"

describe("discoverModels", () => {
  it("authenticates and parses LiteLLM model metadata", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            {
              id: "anthropic/claude-sonnet-4-6",
              model_info: {
                max_input_tokens: 200_000,
                max_output_tokens: 64_000,
                supports_function_calling: true,
                supports_vision: true,
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      ),
    )

    const models = await discoverModels("https://neuron.example/v1", "secret", {
      timeoutMs: 1_000,
      fetch: fetchMock as typeof fetch,
    })

    expect(fetchMock).toHaveBeenCalledWith(
      "https://neuron.example/v1/models",
      expect.objectContaining({
        headers: { Accept: "application/json", Authorization: "Bearer secret" },
        redirect: "error",
      }),
    )
    expect(models).toEqual([
      expect.objectContaining({
        id: "anthropic/claude-sonnet-4-6",
        max_input_tokens: 200_000,
        max_output_tokens: 64_000,
        supports_function_calling: true,
        supports_vision: true,
      }),
    ])
  })

  it("rejects unsuccessful and malformed responses", async () => {
    const unauthorized = vi.fn(async () => new Response(null, { status: 401, statusText: "Unauthorized" }))
    await expect(
      discoverModels("https://neuron.example/v1", "wrong", {
        timeoutMs: 1_000,
        fetch: unauthorized as typeof fetch,
      }),
    ).rejects.toThrow("HTTP 401 Unauthorized")

    const malformed = vi.fn(async () => new Response(JSON.stringify({ models: [] }), { status: 200 }))
    await expect(
      discoverModels("https://neuron.example/v1", undefined, {
        timeoutMs: 1_000,
        fetch: malformed as typeof fetch,
      }),
    ).rejects.toThrow("data array")
  })

  it("ignores model ids that could inject terminal controls", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ data: [{ id: "safe-model" }, { id: "bad\u001b[2J-model" }] }), { status: 200 }),
    )

    await expect(
      discoverModels("https://neuron.example/v1", undefined, {
        timeoutMs: 1_000,
        fetch: fetchMock as typeof fetch,
      }),
    ).resolves.toEqual([{ id: "safe-model" }])
  })
})

describe("toModelConfig", () => {
  it("maps known capabilities without changing the wire model id", () => {
    expect(
      toModelConfig({
        id: "team/model-a",
        max_input_tokens: 100_000,
        max_output_tokens: 8_000,
        supports_function_calling: true,
        supports_vision: true,
      }),
    ).toEqual({
      name: "team/model-a",
      tool_call: true,
      attachment: true,
      limit: { context: 100_000, output: 8_000 },
      modalities: { input: ["text", "image"], output: ["text"] },
    })
  })
})
