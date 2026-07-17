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
        readCredentials: async () => ({
          "neuron-a": { key: "key-a", baseURL: "https://neuron.noser.com/v1" },
          "neuron-b": { key: "key-b", baseURL: "https://neuron.noser.com/v1" },
        }),
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

  it("preserves curated models and strips unbound provider credentials", async () => {
    const config: OpenCodeConfig = {
      provider: {
        "neuron-team": {
          env: ["AWS_SECRET_ACCESS_KEY"],
          options: { apiKey: "project-controlled-secret" },
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
          },
        ],
      },
      {
        discover,
        readCredentials: async () => ({
          "neuron-team": { key: "bound-key", baseURL: "https://neuron.noser.com/v1" },
        }),
        log: async () => undefined,
      },
    )

    expect(discover).toHaveBeenCalledWith("https://neuron.noser.com/v1", "bound-key", { timeoutMs: 5_000 })
    expect(config.provider?.["neuron-team"]?.env).toBeUndefined()
    expect(config.provider?.["neuron-team"]?.options).toEqual({ baseURL: "https://neuron.noser.com/v1" })
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
        readCredentials: async () => ({}),
        log,
      },
    )

    expect(config.provider?.neuron).toBeDefined()
    expect(log).toHaveBeenCalledWith("warn", "Model discovery failed for Neuron", expect.objectContaining({ error: "offline" }))
  })

  it("disables a profile when its stored credential belongs to another URL", async () => {
    const discover = vi.fn(async () => [{ id: "should-not-load" }])
    const log = vi.fn(async () => undefined)
    const config: OpenCodeConfig = {
      provider: {
        team: {
          options: { apiKey: "project-controlled-secret" },
          models: { injected: { name: "Injected" } },
        },
      },
    }

    await enhanceConfig(
      config,
      { profiles: [{ id: "team", name: "Team", baseURL: "https://attacker.example/v1" }] },
      {
        discover,
        readCredentials: async () => ({
          team: { key: "real-secret", baseURL: "https://trusted.example/v1" },
        }),
        log,
      },
    )

    expect(discover).not.toHaveBeenCalled()
    expect(config.provider?.team).toBeUndefined()
    expect(log).toHaveBeenCalledWith(
      "warn",
      "Credential URL mismatch for Team; profile disabled",
      expect.objectContaining({ providerID: "team" }),
    )
  })

  it("keeps legacy unbound credentials limited to the original Neuron URL", async () => {
    const discover = vi.fn(async () => [{ id: "model" }])

    await enhanceConfig(
      {},
      { profiles: [{ id: "neuron", name: "Neuron" }] },
      {
        discover,
        readCredentials: async () => ({ neuron: { key: "legacy-key" } }),
        log: async () => undefined,
      },
    )

    expect(discover).toHaveBeenCalledWith("https://neuron.noser.com/v1", "legacy-key", { timeoutMs: 5_000 })
  })
})
