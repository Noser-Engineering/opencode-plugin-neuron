import { describe, expect, it, vi } from "vitest"
import { createDiscoveryCache, enhanceConfig } from "../src/plugin.js"
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

  it("overrides the adapter only for the models that need the Responses API", async () => {
    const discover = vi.fn(async () => [
      { id: "gpt-5.6-luna", mode: "responses" },
      { id: "gpt-4-classic", mode: "chat" },
    ])
    const config: OpenCodeConfig = {}

    await enhanceConfig(
      config,
      { profiles: [{ id: "swissmon", name: "swissMon", baseURL: "https://proxy.example/v1" }] },
      {
        discover,
        readCredentials: async () => ({ swissmon: { key: "key", baseURL: "https://proxy.example/v1" } }),
        log: async () => undefined,
      },
    )

    expect(config.provider?.swissmon?.npm).toBe("@ai-sdk/openai-compatible")
    expect(config.provider?.swissmon?.models?.["gpt-5.6-luna"]?.provider).toEqual({ npm: "@ai-sdk/openai" })
    expect(config.provider?.swissmon?.models?.["gpt-4-classic"]?.provider).toBeUndefined()
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

describe("discovery cache", () => {
  it("issues one request per profile no matter how often the hook runs", async () => {
    const discover = vi.fn(async () => [{ id: "model" }])
    const cache = createDiscoveryCache()
    const options = {
      profiles: [
        { id: "proxy-a", name: "Proxy A", baseURL: "https://proxy.example/v1" },
        { id: "proxy-b", name: "Proxy B", baseURL: "https://proxy.example/v1" },
      ],
    }
    const dependencies = { discover, readCredentials: async () => ({}), log: async () => undefined, cache }

    const config: OpenCodeConfig = {}
    await enhanceConfig(config, options, dependencies)
    await enhanceConfig(config, options, dependencies)
    await enhanceConfig(config, options, dependencies)

    expect(discover).toHaveBeenCalledTimes(2)
    expect(config.provider?.["proxy-a"]?.models).toHaveProperty("model")
  })

  it("shares one in-flight request between concurrent hook calls", async () => {
    let resolveDiscovery!: (models: Array<{ id: string }>) => void
    const inFlight = new Promise<Array<{ id: string }>>((resolve) => {
      resolveDiscovery = resolve
    })
    const discover = vi.fn(() => inFlight)
    const cache = createDiscoveryCache()
    const options = { profiles: [{ id: "neuron", name: "Neuron", baseURL: "https://proxy.example/v1" }] }
    const dependencies = { discover, readCredentials: async () => ({}), log: async () => undefined, cache }

    const first = enhanceConfig({}, options, dependencies)
    const second = enhanceConfig({}, options, dependencies)
    resolveDiscovery([{ id: "model" }])
    await Promise.all([first, second])

    expect(discover).toHaveBeenCalledTimes(1)
  })

  it("does not serve a profile the models of the proxy it used to point at", async () => {
    const discover = vi.fn(async (baseURL: string) => [{ id: baseURL }])
    const cache = createDiscoveryCache()
    const dependencies = { discover, readCredentials: async () => ({}), log: async () => undefined, cache }

    const config: OpenCodeConfig = {}
    await enhanceConfig(
      config,
      { profiles: [{ id: "neuron", name: "Neuron", baseURL: "https://old.example/v1" }] },
      dependencies,
    )
    await enhanceConfig(
      config,
      { profiles: [{ id: "neuron", name: "Neuron", baseURL: "https://new.example/v1" }] },
      dependencies,
    )

    expect(discover).toHaveBeenCalledTimes(2)
    expect(config.provider?.neuron?.models).toHaveProperty("https://new.example/v1")
  })

  it("keeps a failure cached rather than retrying on every hook call", async () => {
    const discover = vi.fn(async () => {
      throw new Error("offline")
    })
    const cache = createDiscoveryCache()
    const options = { profiles: [{ id: "neuron", name: "Neuron", baseURL: "https://proxy.example/v1" }] }
    const dependencies = { discover, readCredentials: async () => ({}), log: async () => undefined, cache }

    await enhanceConfig({}, options, dependencies)
    await enhanceConfig({}, options, dependencies)

    expect(discover).toHaveBeenCalledTimes(1)
  })
})
