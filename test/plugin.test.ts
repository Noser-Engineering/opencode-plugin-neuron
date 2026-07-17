import { describe, expect, it, vi } from "vitest"
import { enhanceConfig } from "../src/plugin.js"
import type { OpenCodeConfig } from "../src/types.js"

describe("enhanceConfig", () => {
  it("creates isolated providers for profiles sharing one proxy", async () => {
    const discover = vi.fn(async (_baseURL: string, apiKey: string | undefined) => [
      { id: apiKey === "key-a" ? "model-a" : "model-b" },
    ])
    const config: OpenCodeConfig = {}

    await enhanceConfig(
      config,
      {
        profiles: [
          { id: "neuron-a", name: "Neuron A", baseURL: "https://neuron.noser.com/v1" },
          { id: "neuron-b", name: "Neuron B", baseURL: "https://neuron.noser.com/v1" },
        ],
      },
      {
        discover,
        readApiKeys: async () => ({ "neuron-a": "key-a", "neuron-b": "key-b" }),
        env: {},
        log: async () => undefined,
      },
    )

    expect(discover).toHaveBeenCalledTimes(2)
    expect(discover).toHaveBeenCalledWith("https://neuron.noser.com/v1", "key-a", { timeoutMs: 5_000 })
    expect(discover).toHaveBeenCalledWith("https://neuron.noser.com/v1", "key-b", { timeoutMs: 5_000 })
    expect(config.provider?.["neuron-a"]).toMatchObject({
      name: "Neuron A",
      npm: "@ai-sdk/openai-compatible",
      models: { "model-a": { name: "model-a" } },
    })
    expect(config.provider?.["neuron-b"]).toMatchObject({
      name: "Neuron B",
      models: { "model-b": { name: "model-b" } },
    })
  })

  it("preserves curated models and uses a profile-specific environment variable", async () => {
    const config: OpenCodeConfig = {
      provider: {
        "neuron-team": {
          models: { shared: { name: "Curated name", reasoning: true } },
        },
      },
    }
    const discover = vi.fn(async () => [{ id: "shared" }, { id: "new-model" }])

    await enhanceConfig(
      config,
      {
        profiles: [
          {
            id: "neuron-team",
            name: "Neuron Team",
            baseURL: "https://neuron.noser.com/v1",
            apiKeyEnv: "NEURON_TEAM_KEY",
          },
        ],
      },
      {
        discover,
        readApiKeys: async () => ({}),
        env: { NEURON_TEAM_KEY: "from-env" },
        log: async () => undefined,
      },
    )

    expect(discover).toHaveBeenCalledWith("https://neuron.noser.com/v1", "from-env", { timeoutMs: 5_000 })
    expect(config.provider?.["neuron-team"]?.env).toEqual(["NEURON_TEAM_KEY"])
    expect(config.provider?.["neuron-team"]?.models).toEqual({
      shared: { name: "Curated name", reasoning: true },
      "new-model": { name: "new-model" },
    })
  })

  it("keeps OpenCode usable when one profile cannot be discovered", async () => {
    const log = vi.fn(async () => undefined)
    const config: OpenCodeConfig = {}

    await enhanceConfig(
      config,
      { profiles: [{ id: "neuron", name: "Neuron" }] },
      {
        discover: async () => {
          throw new Error("offline")
        },
        readApiKeys: async () => ({}),
        env: {},
        log,
      },
    )

    expect(config.provider?.neuron).toBeDefined()
    expect(log).toHaveBeenCalledWith("warn", "Model discovery failed for Neuron", expect.objectContaining({ error: "offline" }))
  })
})
