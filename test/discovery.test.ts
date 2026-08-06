import { describe, expect, it, vi } from "vitest"
import { discoverModels, toModelConfig } from "../src/discovery.js"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

/** Answers /model_group/info and /v1/models from separate fixtures. */
function routedFetch(routes: { modelGroup?: () => Response; models?: () => Response }) {
  return vi.fn(async (url: string | URL) => {
    const href = String(url)
    if (href.endsWith("/model_group/info")) {
      if (!routes.modelGroup) return new Response(null, { status: 404, statusText: "Not Found" })
      return routes.modelGroup()
    }
    if (!routes.models) return new Response(null, { status: 404, statusText: "Not Found" })
    return routes.models()
  })
}

async function discover(fetchMock: ReturnType<typeof routedFetch>) {
  return discoverModels("https://neuron.example/v1", "secret", {
    timeoutMs: 1_000,
    fetch: fetchMock as unknown as typeof fetch,
  })
}

describe("discoverModels via /model_group/info", () => {
  it("prefers the model group endpoint and converts costs to OpenCode's unit", async () => {
    const fetchMock = routedFetch({
      modelGroup: () =>
        jsonResponse({
          data: [
            {
              model_group: "claude-sonnet-4-6",
              mode: "chat",
              max_input_tokens: 200_000,
              max_output_tokens: 64_000,
              input_cost_per_token: 0.000003,
              output_cost_per_token: 0.000015,
              supports_function_calling: true,
              supports_vision: true,
              supports_reasoning: true,
            },
          ],
        }),
    })

    const models = await discover(fetchMock)

    expect(fetchMock).toHaveBeenCalledWith(
      "https://neuron.example/v1/model_group/info",
      expect.objectContaining({
        headers: { Accept: "application/json", Authorization: "Bearer secret" },
        redirect: "error",
      }),
    )
    expect(models).toEqual([
      {
        id: "claude-sonnet-4-6",
        mode: "chat",
        max_input_tokens: 200_000,
        max_output_tokens: 64_000,
        supports_function_calling: true,
        supports_vision: true,
        supports_reasoning: true,
        input_cost_per_million: 3,
        output_cost_per_million: 15,
      },
    ])
    expect(toModelConfig(models[0]!).cost).toEqual({ input: 3, output: 15 })
  })

  it("keeps a free model's zero price instead of dropping it", async () => {
    const fetchMock = routedFetch({
      modelGroup: () =>
        jsonResponse({
          data: [{ model_group: "local-llama", input_cost_per_token: 0, output_cost_per_token: 0 }],
        }),
    })

    const [model] = await discover(fetchMock)

    expect(toModelConfig(model!).cost).toEqual({ input: 0, output: 0 })
  })

  it("takes reasoning from the flag rather than the model id", async () => {
    const fetchMock = routedFetch({
      modelGroup: () =>
        jsonResponse({
          data: [
            { model_group: "claude-opus-5", supports_reasoning: true },
            // The id heuristic would call this one a reasoning model.
            { model_group: "gpt-5-chat", supports_reasoning: false },
          ],
        }),
    })

    const [claude, gpt] = await discover(fetchMock)

    expect(toModelConfig(claude!).reasoning).toBe(true)
    expect(toModelConfig(gpt!).reasoning).toBeUndefined()
  })

  it("reports pdf input as a modality", async () => {
    const fetchMock = routedFetch({
      modelGroup: () =>
        jsonResponse({
          data: [{ model_group: "reader", supports_vision: true, supports_pdf_input: true }],
        }),
    })

    const [model] = await discover(fetchMock)

    expect(toModelConfig(model!)).toMatchObject({
      attachment: true,
      modalities: { input: ["text", "image", "pdf"], output: ["text"] },
    })
  })
})

describe("discoverModels fallback to /v1/models", () => {
  it("falls back when the model group endpoint is missing", async () => {
    const fetchMock = routedFetch({
      models: () => jsonResponse({ data: [{ id: "fallback-model" }] }),
    })

    await expect(discover(fetchMock)).resolves.toEqual([{ id: "fallback-model" }])
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("falls back when the model group endpoint answers with an unexpected schema", async () => {
    const fetchMock = routedFetch({
      modelGroup: () => jsonResponse({ data: [{ unexpected: "shape" }] }),
      models: () => jsonResponse({ data: [{ id: "fallback-model" }] }),
    })

    await expect(discover(fetchMock)).resolves.toEqual([{ id: "fallback-model" }])
  })

  it("still guesses reasoning from the id, since the fallback reports no flags", async () => {
    const fetchMock = routedFetch({
      models: () => jsonResponse({ data: [{ id: "gpt-5" }, { id: "claude-opus-5" }] }),
    })

    const [gpt, claude] = await discover(fetchMock)

    expect(toModelConfig(gpt!).reasoning).toBe(true)
    expect(toModelConfig(claude!).reasoning).toBeUndefined()
  })

  it("reports the fallback's failure rather than the model group's", async () => {
    const fetchMock = routedFetch({
      models: () => new Response(null, { status: 401, statusText: "Unauthorized" }),
    })

    await expect(discover(fetchMock)).rejects.toThrow("HTTP 401 Unauthorized")
  })

  it("rejects a malformed fallback payload", async () => {
    const fetchMock = routedFetch({ models: () => jsonResponse({ models: [] }) })

    await expect(discover(fetchMock)).rejects.toThrow("data array")
  })

  it("reads capabilities out of model_info", async () => {
    const fetchMock = routedFetch({
      models: () =>
        jsonResponse({
          data: [
            {
              id: "anthropic/claude-sonnet-4-6",
              model_info: {
                max_input_tokens: 200_000,
                max_output_tokens: 64_000,
                supports_function_calling: true,
                supports_vision: true,
                input_cost_per_token: 0.000003,
              },
            },
          ],
        }),
    })

    await expect(discover(fetchMock)).resolves.toEqual([
      expect.objectContaining({
        id: "anthropic/claude-sonnet-4-6",
        max_input_tokens: 200_000,
        supports_vision: true,
        input_cost_per_million: 3,
      }),
    ])
  })

  it("ignores model ids that could inject terminal controls", async () => {
    const fetchMock = routedFetch({
      models: () => jsonResponse({ data: [{ id: "safe-model" }, { id: "bad\u001b[2J-model" }] }),
    })

    await expect(discover(fetchMock)).resolves.toEqual([{ id: "safe-model" }])
  })
})

describe("discovery filters", () => {
  it("drops wildcard entries, which are access rules and not callable models", async () => {
    const fetchMock = routedFetch({
      modelGroup: () =>
        jsonResponse({
          data: [{ model_group: "real-model" }, { model_group: "openai/*" }, { model_group: "*" }],
        }),
    })

    await expect(discover(fetchMock)).resolves.toEqual([{ id: "real-model" }])
  })

  it("drops wildcard entries in the fallback too", async () => {
    const fetchMock = routedFetch({
      models: () => jsonResponse({ data: [{ id: "real-model" }, { id: "anthropic/*" }] }),
    })

    await expect(discover(fetchMock)).resolves.toEqual([{ id: "real-model" }])
  })

  it("keeps chat and responses models and drops everything else", async () => {
    const fetchMock = routedFetch({
      modelGroup: () =>
        jsonResponse({
          data: [
            { model_group: "chatter", mode: "chat" },
            { model_group: "responder", mode: "responses" },
            { model_group: "embedder", mode: "embedding" },
            { model_group: "painter", mode: "image_generation" },
            { model_group: "listener", mode: "audio_transcription" },
            { model_group: "ranker", mode: "rerank" },
            { model_group: "censor", mode: "moderations" },
          ],
        }),
    })

    const models = await discover(fetchMock)

    expect(models.map((model) => model.id)).toEqual(["chatter", "responder"])
  })

  it("lets a model without a mode through", async () => {
    const fetchMock = routedFetch({
      modelGroup: () => jsonResponse({ data: [{ model_group: "unknown-mode" }] }),
    })

    await expect(discover(fetchMock)).resolves.toEqual([{ id: "unknown-mode" }])
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

  it("omits cost unless both directions are priced", () => {
    expect(toModelConfig({ id: "half-priced", input_cost_per_million: 3 }).cost).toBeUndefined()
  })

  it("omits modalities for a text-only model", () => {
    expect(toModelConfig({ id: "plain" }).modalities).toBeUndefined()
  })
})
