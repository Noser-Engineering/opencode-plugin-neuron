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
          { id: "proxy-a", name: "Proxy A", baseURL: "https://proxy.example/v1" },
          { id: "proxy-b", name: "Proxy B", baseURL: "https://proxy.example/v1" },
        ],
      },
      {
        discover,
        readCredentials: async () => ({
          "proxy-a": { key: "key-a", baseURL: "https://proxy.example/v1" },
          "proxy-b": { key: "key-b", baseURL: "https://proxy.example/v1" },
        }),
        log: async () => undefined,
      },
    )

    expect(discover).toHaveBeenCalledTimes(2)
    expect(discover).toHaveBeenCalledWith("https://proxy.example/v1", "key-a", { timeoutMs: 5_000 })
    expect(discover).toHaveBeenCalledWith("https://proxy.example/v1", "key-b", { timeoutMs: 5_000 })
    expect(config.provider?.["proxy-a"]).toMatchObject({
      name: "Proxy A",
      npm: "@ai-sdk/openai-compatible",
      models: { "model-a": { name: "model-a" } },
    })
    expect(config.provider?.["proxy-b"]).toMatchObject({
      name: "Proxy B",
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
            baseURL: "https://proxy.example/v1",
          },
        ],
      },
      {
        discover,
        readCredentials: async () => ({
          "neuron-team": { key: "bound-key", baseURL: "https://proxy.example/v1" },
        }),
        log: async () => undefined,
      },
    )

    expect(discover).toHaveBeenCalledWith("https://proxy.example/v1", "bound-key", { timeoutMs: 5_000 })
    expect(config.provider?.["neuron-team"]?.env).toBeUndefined()
    expect(config.provider?.["neuron-team"]?.options).toEqual({ baseURL: "https://proxy.example/v1" })
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
      { profiles: [{ id: "neuron", name: "Neuron", baseURL: "https://proxy.example/v1" }] },
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

  it("rejects legacy credentials that are not bound to a URL", async () => {
    const discover = vi.fn(async () => [{ id: "model" }])

    await enhanceConfig(
      {},
      { profiles: [{ id: "legacy", name: "Legacy", baseURL: "https://proxy.example/v1" }] },
      {
        discover,
        readCredentials: async () => ({ legacy: { key: "legacy-key" } }),
        log: async () => undefined,
      },
    )

    expect(discover).not.toHaveBeenCalled()
  })
})
