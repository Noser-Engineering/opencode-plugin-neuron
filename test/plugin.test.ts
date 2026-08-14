import { describe, expect, it, vi } from "vitest"
import { createDiscoveryCache, enhanceConfig } from "../src/plugin.js"
import type { OpenCodeConfig } from "../src/types.js"

const noDeprecations = async () => new Set<string>()

describe("enhanceConfig", () => {
  it("creates isolated providers for profiles sharing one proxy", async () => {
    const discoverRawModels = vi.fn(async (_baseURL: string, apiKey: string | undefined) => [
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
        discoverRawModels,
        fetchDeprecatedModelNames: noDeprecations,
        readCredentials: async () => ({
          "proxy-a": { key: "key-a", baseURL: "https://proxy.example/v1" },
          "proxy-b": { key: "key-b", baseURL: "https://proxy.example/v1" },
        }),
        log: async () => undefined,
      },
    )

    expect(discoverRawModels).toHaveBeenCalledTimes(2)
    expect(discoverRawModels).toHaveBeenCalledWith("https://proxy.example/v1", "key-a", { timeoutMs: 5_000 })
    expect(discoverRawModels).toHaveBeenCalledWith("https://proxy.example/v1", "key-b", { timeoutMs: 5_000 })
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
    const discoverRawModels = vi.fn(async () => [
      { id: "gpt-5.6-luna", mode: "responses" },
      { id: "gpt-4-classic", mode: "chat" },
    ])
    const config: OpenCodeConfig = {}

    await enhanceConfig(
      config,
      { profiles: [{ id: "swissmon", name: "swissMon", baseURL: "https://proxy.example/v1" }] },
      {
        discoverRawModels,
        fetchDeprecatedModelNames: noDeprecations,
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
    const discoverRawModels = vi.fn(async () => [{ id: "shared" }, { id: "new-model" }])

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
        discoverRawModels,
        fetchDeprecatedModelNames: noDeprecations,
        readCredentials: async () => ({
          "neuron-team": { key: "bound-key", baseURL: "https://proxy.example/v1" },
        }),
        log: async () => undefined,
      },
    )

    expect(discoverRawModels).toHaveBeenCalledWith("https://proxy.example/v1", "bound-key", { timeoutMs: 5_000 })
    expect(config.provider?.["neuron-team"]?.env).toBeUndefined()
    expect(config.provider?.["neuron-team"]?.options).toEqual({ baseURL: "https://proxy.example/v1" })
    expect(config.provider?.["neuron-team"]?.models).toEqual({
      shared: { name: "Curated name", reasoning: true },
      "new-model": { name: "new-model" },
    })
  })

  it("drops models the proxy marks deprecated", async () => {
    const discoverRawModels = vi.fn(async () => [{ id: "gpt-4-old" }, { id: "gpt-5.6-luna" }])
    const config: OpenCodeConfig = {}

    await enhanceConfig(
      config,
      { profiles: [{ id: "neuron", name: "Neuron", baseURL: "https://proxy.example/v1" }] },
      {
        discoverRawModels,
        fetchDeprecatedModelNames: async () => new Set(["gpt-4-old"]),
        readCredentials: async () => ({}),
        log: async () => undefined,
      },
    )

    expect(config.provider?.neuron?.models).toEqual({
      "gpt-5.6-luna": { name: "gpt-5.6-luna", reasoning: true },
    })
  })

  it("keeps OpenCode usable when one profile cannot be discovered", async () => {
    const log = vi.fn(async () => undefined)
    const config: OpenCodeConfig = {}

    await enhanceConfig(
      config,
      { profiles: [{ id: "neuron", name: "Neuron", baseURL: "https://proxy.example/v1" }] },
      {
        discoverRawModels: async () => {
          throw new Error("offline")
        },
        fetchDeprecatedModelNames: noDeprecations,
        readCredentials: async () => ({}),
        log,
      },
    )

    expect(config.provider?.neuron).toBeDefined()
    expect(log).toHaveBeenCalledWith("warn", "Model discovery failed for Neuron", expect.objectContaining({ error: "offline" }))
  })

  it("keeps a profile's models when only the deprecation lookup fails, and logs it", async () => {
    const discoverRawModels = vi.fn(async () => [{ id: "still-here" }])
    const log = vi.fn(async () => undefined)
    const config: OpenCodeConfig = {}

    await enhanceConfig(
      config,
      { profiles: [{ id: "neuron", name: "Neuron", baseURL: "https://proxy.example/v1" }] },
      {
        discoverRawModels,
        fetchDeprecatedModelNames: async () => {
          throw new Error("HTTP 403 Forbidden")
        },
        readCredentials: async () => ({}),
        log,
      },
    )

    expect(config.provider?.neuron?.models).toEqual({ "still-here": { name: "still-here" } })
    expect(log).toHaveBeenCalledWith(
      "warn",
      "Deprecated-model lookup failed for https://proxy.example/v1; showing all models",
      expect.objectContaining({ error: "HTTP 403 Forbidden" }),
    )
  })

  it("disables a profile when its stored credential belongs to another URL", async () => {
    const discoverRawModels = vi.fn(async () => [{ id: "should-not-load" }])
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
        discoverRawModels,
        fetchDeprecatedModelNames: noDeprecations,
        readCredentials: async () => ({
          team: { key: "real-secret", baseURL: "https://trusted.example/v1" },
        }),
        log,
      },
    )

    expect(discoverRawModels).not.toHaveBeenCalled()
    expect(config.provider?.team).toBeUndefined()
    expect(log).toHaveBeenCalledWith(
      "warn",
      "Credential URL mismatch for Team; profile disabled",
      expect.objectContaining({ providerID: "team" }),
    )
  })

  it("rejects legacy credentials that are not bound to a URL", async () => {
    const discoverRawModels = vi.fn(async () => [{ id: "model" }])

    await enhanceConfig(
      {},
      { profiles: [{ id: "legacy", name: "Legacy", baseURL: "https://proxy.example/v1" }] },
      {
        discoverRawModels,
        fetchDeprecatedModelNames: noDeprecations,
        readCredentials: async () => ({ legacy: { key: "legacy-key" } }),
        log: async () => undefined,
      },
    )

    expect(discoverRawModels).not.toHaveBeenCalled()
  })
})

describe("discovery cache", () => {
  it("issues one request per profile no matter how often the hook runs", async () => {
    const discoverRawModels = vi.fn(async () => [{ id: "model" }])
    const cache = createDiscoveryCache()
    const options = {
      profiles: [
        { id: "proxy-a", name: "Proxy A", baseURL: "https://proxy.example/v1" },
        { id: "proxy-b", name: "Proxy B", baseURL: "https://proxy.example/v1" },
      ],
    }
    const dependencies = {
      discoverRawModels,
      fetchDeprecatedModelNames: noDeprecations,
      readCredentials: async () => ({}),
      log: async () => undefined,
      cache,
    }

    const config: OpenCodeConfig = {}
    await enhanceConfig(config, options, dependencies)
    await enhanceConfig(config, options, dependencies)
    await enhanceConfig(config, options, dependencies)

    expect(discoverRawModels).toHaveBeenCalledTimes(2)
    expect(config.provider?.["proxy-a"]?.models).toHaveProperty("model")
  })

  it("shares one in-flight request between concurrent hook calls", async () => {
    let resolveDiscovery!: (models: Array<{ id: string }>) => void
    const inFlight = new Promise<Array<{ id: string }>>((resolve) => {
      resolveDiscovery = resolve
    })
    const discoverRawModels = vi.fn(() => inFlight)
    const cache = createDiscoveryCache()
    const options = { profiles: [{ id: "neuron", name: "Neuron", baseURL: "https://proxy.example/v1" }] }
    const dependencies = {
      discoverRawModels,
      fetchDeprecatedModelNames: noDeprecations,
      readCredentials: async () => ({}),
      log: async () => undefined,
      cache,
    }

    const first = enhanceConfig({}, options, dependencies)
    const second = enhanceConfig({}, options, dependencies)
    resolveDiscovery([{ id: "model" }])
    await Promise.all([first, second])

    expect(discoverRawModels).toHaveBeenCalledTimes(1)
  })

  it("does not serve a profile the models of the proxy it used to point at", async () => {
    const discoverRawModels = vi.fn(async (baseURL: string) => [{ id: baseURL }])
    const cache = createDiscoveryCache()
    const dependencies = {
      discoverRawModels,
      fetchDeprecatedModelNames: noDeprecations,
      readCredentials: async () => ({}),
      log: async () => undefined,
      cache,
    }

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

    expect(discoverRawModels).toHaveBeenCalledTimes(2)
    expect(config.provider?.neuron?.models).toHaveProperty("https://new.example/v1")
  })

  it("keeps a failure cached rather than retrying on every hook call", async () => {
    const discoverRawModels = vi.fn(async () => {
      throw new Error("offline")
    })
    const cache = createDiscoveryCache()
    const options = { profiles: [{ id: "neuron", name: "Neuron", baseURL: "https://proxy.example/v1" }] }
    const dependencies = {
      discoverRawModels,
      fetchDeprecatedModelNames: noDeprecations,
      readCredentials: async () => ({}),
      log: async () => undefined,
      cache,
    }

    await enhanceConfig({}, options, dependencies)
    await enhanceConfig({}, options, dependencies)

    expect(discoverRawModels).toHaveBeenCalledTimes(1)
  })

  it("fetches deprecated names once per baseURL, not once per profile", async () => {
    const fetchDeprecatedModelNames = vi.fn(async () => new Set<string>())
    const cache = createDiscoveryCache()
    const options = {
      profiles: [
        { id: "proxy-a", name: "Proxy A", baseURL: "https://proxy.example/v1" },
        { id: "proxy-b", name: "Proxy B", baseURL: "https://proxy.example/v1" },
      ],
    }
    const dependencies = {
      discoverRawModels: async (baseURL: string) => [{ id: `model-${baseURL}` }],
      fetchDeprecatedModelNames,
      readCredentials: async () => ({}),
      log: async () => undefined,
      cache,
    }

    await enhanceConfig({}, options, dependencies)

    expect(fetchDeprecatedModelNames).toHaveBeenCalledTimes(1)
  })

  it("reuses the cached deprecation lookup across repeated hook calls", async () => {
    const fetchDeprecatedModelNames = vi.fn(async () => new Set<string>())
    const cache = createDiscoveryCache()
    const options = { profiles: [{ id: "neuron", name: "Neuron", baseURL: "https://proxy.example/v1" }] }
    const dependencies = {
      discoverRawModels: async () => [{ id: "model" }],
      fetchDeprecatedModelNames,
      readCredentials: async () => ({}),
      log: async () => undefined,
      cache,
    }

    await enhanceConfig({}, options, dependencies)
    await enhanceConfig({}, options, dependencies)

    expect(fetchDeprecatedModelNames).toHaveBeenCalledTimes(1)
  })

  it("logs the deprecation-lookup failure only once when it is cached per baseURL", async () => {
    const fetchDeprecatedModelNames = vi.fn(async () => {
      throw new Error("HTTP 403 Forbidden")
    })
    const log = vi.fn(async () => undefined)
    const cache = createDiscoveryCache()
    const options = {
      profiles: [
        { id: "proxy-a", name: "Proxy A", baseURL: "https://proxy.example/v1" },
        { id: "proxy-b", name: "Proxy B", baseURL: "https://proxy.example/v1" },
      ],
    }
    const dependencies = {
      discoverRawModels: async (baseURL: string) => [{ id: `model-${baseURL}` }],
      fetchDeprecatedModelNames,
      readCredentials: async () => ({}),
      log,
      cache,
    }

    await enhanceConfig({}, options, dependencies)

    expect(fetchDeprecatedModelNames).toHaveBeenCalledTimes(1)
    expect(log.mock.calls.filter(([, message]) => String(message).startsWith("Deprecated-model lookup failed"))).toHaveLength(1)
  })
})
