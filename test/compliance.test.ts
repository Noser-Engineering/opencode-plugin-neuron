import { describe, expect, it, vi } from "vitest"
import { applyCompliance, applyPermissionPolicy, AUTOLOADED_PROVIDERS, DEFAULT_PERMISSION_POLICY } from "../src/compliance.js"
import { enhanceConfig } from "../src/plugin.js"
import type { OpenCodeConfig } from "../src/types.js"

const ENFORCED = { enforce: true, denyProviders: [] }

function neuronOptions(extra: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    profiles: [{ id: "neuron", name: "Neuron", baseURL: "https://proxy.example/v1" }],
    ...extra,
  }
}

function silentDependencies(overrides: Partial<Parameters<typeof enhanceConfig>[2]> = {}) {
  return {
    discover: async () => [{ id: "model-a" }],
    readCredentials: async () => ({ neuron: { key: "k", baseURL: "https://proxy.example/v1" } }),
    log: async () => undefined,
    ...overrides,
  }
}

describe("applyCompliance", () => {
  it("blocks autoloaded providers and leaves declared ones alone", () => {
    const config: OpenCodeConfig = { provider: { anthropic: {}, neuron: {} } }

    applyCompliance(config, ENFORCED)

    expect(config.disabled_providers).toContain("opencode")
    expect(config.disabled_providers).toContain("github-copilot")
    expect(config.disabled_providers).not.toContain("anthropic")
    expect(config.disabled_providers).not.toContain("neuron")
  })

  it("keeps disabled_providers the user set", () => {
    const config: OpenCodeConfig = { disabled_providers: ["some-internal-provider"] }

    applyCompliance(config, ENFORCED)

    expect(config.disabled_providers).toContain("some-internal-provider")
    expect(config.disabled_providers).toContain("anthropic")
  })

  it("honours a provider the user disabled even though it is declared", () => {
    const config: OpenCodeConfig = { provider: { anthropic: {} }, disabled_providers: ["anthropic"] }

    applyCompliance(config, ENFORCED)

    expect(config.disabled_providers).toContain("anthropic")
  })

  it("extends the block list with denyProviders", () => {
    const config: OpenCodeConfig = {}

    applyCompliance(config, { enforce: true, denyProviders: ["some-gateway"] })

    expect(config.disabled_providers).toContain("some-gateway")
  })

  it("does not block a declared provider that denyProviders also names", () => {
    const config: OpenCodeConfig = { provider: { "customer-account": {} } }

    applyCompliance(config, { enforce: true, denyProviders: ["customer-account"] })

    expect(config.disabled_providers).not.toContain("customer-account")
  })

  it("leaves experimental config alone", () => {
    const config: OpenCodeConfig = { experimental: { chatMaxRetries: 3 } }

    applyCompliance(config, ENFORCED)

    expect(config.experimental).toEqual({ chatMaxRetries: 3 })
  })

  it("produces no duplicates when called twice", () => {
    const config: OpenCodeConfig = { provider: { neuron: {} } }

    applyCompliance(config, ENFORCED)
    const afterFirst = structuredClone(config)
    applyCompliance(config, ENFORCED)

    expect(config).toEqual(afterFirst)
    expect(new Set(config.disabled_providers).size).toBe(config.disabled_providers?.length)
  })

  it("stays idempotent when the second call sees a newly declared provider", () => {
    const config: OpenCodeConfig = {}

    applyCompliance(config, ENFORCED)
    config.provider = { anthropic: {} }
    applyCompliance(config, ENFORCED)

    expect(config.disabled_providers).not.toContain("anthropic")
    expect(new Set(config.disabled_providers).size).toBe(config.disabled_providers?.length)
  })

  it("disables sharing and downgrades autoupdate", () => {
    const config: OpenCodeConfig = { share: "auto", autoupdate: true }

    applyCompliance(config, ENFORCED)

    expect(config.share).toBe("disabled")
    expect(config.autoupdate).toBe("notify")
  })

  it("does not weaken autoupdate: false", () => {
    const config: OpenCodeConfig = { autoupdate: false }

    applyCompliance(config, ENFORCED)

    expect(config.autoupdate).toBe(false)
  })

  it("changes nothing when enforcement is off", () => {
    const config: OpenCodeConfig = { share: "auto" }

    applyCompliance(config, { enforce: false, denyProviders: [] })

    expect(config).toEqual({ share: "auto" })
  })

  it("covers the vectors the layer exists for", () => {
    // A1 Zen, A2 a stray credential, A3 /share, A4 an unattended update.
    expect(AUTOLOADED_PROVIDERS).toContain("opencode")
    expect(AUTOLOADED_PROVIDERS).toContain("anthropic")
  })

  it("writes the baseline permission policy", () => {
    const config: OpenCodeConfig = {}

    applyCompliance(config, ENFORCED)

    expect(config.permission).toEqual(DEFAULT_PERMISSION_POLICY)
  })

  it("does not touch permissions when enforcement is off", () => {
    const config: OpenCodeConfig = { permission: { "*": "allow" } }

    applyCompliance(config, { enforce: false, denyProviders: [] })

    expect(config.permission).toEqual({ "*": "allow" })
  })
})

describe("applyPermissionPolicy", () => {
  it("writes the full default policy into an empty config", () => {
    const config: OpenCodeConfig = {}

    applyPermissionPolicy(config, DEFAULT_PERMISSION_POLICY)

    expect(config.permission).toEqual(DEFAULT_PERMISSION_POLICY)
  })

  it("keeps the user's top-level default instead of overwriting it", () => {
    const config: OpenCodeConfig = { permission: { "*": "allow" } }

    applyPermissionPolicy(config, DEFAULT_PERMISSION_POLICY)

    expect(config.permission?.["*"]).toBe("allow")
  })

  it("adds missing patterns to a category without touching existing ones", () => {
    const config: OpenCodeConfig = { permission: { bash: { "*": "allow", "rm *": "allow" } } }

    applyPermissionPolicy(config, DEFAULT_PERMISSION_POLICY)

    // User's own choices for patterns we also default survive untouched.
    expect((config.permission?.bash as Record<string, string>)["*"]).toBe("allow")
    expect((config.permission?.bash as Record<string, string>)["rm *"]).toBe("allow")
    // A pattern the user never mentioned gets our default.
    expect((config.permission?.bash as Record<string, string>)["git push*"]).toBe("ask")
  })

  it("leaves a category the user set as a blanket rule untouched", () => {
    const config: OpenCodeConfig = { permission: { edit: "allow" } }

    applyPermissionPolicy(config, DEFAULT_PERMISSION_POLICY)

    expect(config.permission?.edit).toBe("allow")
  })

  it("leaves an unrelated permission category alone", () => {
    const config: OpenCodeConfig = { permission: { webfetch: "allow" } as OpenCodeConfig["permission"] }

    applyPermissionPolicy(config, DEFAULT_PERMISSION_POLICY)

    expect((config.permission as Record<string, unknown>).webfetch).toBe("allow")
  })

  it("is idempotent", () => {
    const config: OpenCodeConfig = {}

    applyPermissionPolicy(config, DEFAULT_PERMISSION_POLICY)
    const afterFirst = structuredClone(config)
    applyPermissionPolicy(config, DEFAULT_PERMISSION_POLICY)

    expect(config).toEqual(afterFirst)
  })
})

describe("enhanceConfig compliance wiring", () => {
  it("protects a config even when no profile is configured", async () => {
    const config: OpenCodeConfig = {}

    await enhanceConfig(config, {}, silentDependencies())

    expect(config.disabled_providers).toContain("anthropic")
    expect(config.share).toBe("disabled")
    expect(config.autoupdate).toBe("notify")
  })

  it("protects a config whose plugin options are malformed", async () => {
    const config: OpenCodeConfig = {}

    await enhanceConfig(config, { profiles: "not-an-array" }, silentDependencies())

    expect(config.disabled_providers).toContain("anthropic")
    expect(config.share).toBe("disabled")
  })

  it("protects a config when discovery throws", async () => {
    const config: OpenCodeConfig = {}

    await enhanceConfig(
      config,
      neuronOptions(),
      silentDependencies({
        discover: async () => {
          throw new Error("proxy unreachable")
        },
      }),
    )

    expect(config.disabled_providers).toContain("anthropic")
    expect(config.provider?.neuron).toBeDefined()
  })

  it("protects a config when reading credentials throws", async () => {
    const config: OpenCodeConfig = {}

    await enhanceConfig(
      config,
      neuronOptions(),
      silentDependencies({
        readCredentials: async () => {
          throw new Error("auth.json is corrupt")
        },
      }),
    )

    expect(config.disabled_providers).toContain("anthropic")
  })

  it("allows the plugin's own profiles, so it never locks itself out", async () => {
    const config: OpenCodeConfig = {}

    await enhanceConfig(config, neuronOptions(), silentDependencies())

    expect(config.disabled_providers).not.toContain("neuron")
    expect(config.provider?.neuron?.models).toHaveProperty("model-a")
  })

  it("keeps a provider the user declared on purpose", async () => {
    const config: OpenCodeConfig = { provider: { anthropic: { models: { "claude-sonnet-4-5": {} } } } }

    await enhanceConfig(config, neuronOptions(), silentDependencies())

    expect(config.disabled_providers).not.toContain("anthropic")
    expect(config.provider?.anthropic).toBeDefined()
  })

  it("keeps protection when enforce is not a boolean", async () => {
    const log = vi.fn(async () => undefined)
    const config: OpenCodeConfig = {}

    await enhanceConfig(config, neuronOptions({ enforce: "false" }), silentDependencies({ log }))

    expect(config.disabled_providers).toContain("anthropic")
    expect(log).toHaveBeenCalledWith(
      "warn",
      expect.stringContaining("enforce must be a boolean"),
    )
  })

  it("lets enforce: false through and says so", async () => {
    const log = vi.fn(async () => undefined)
    const config: OpenCodeConfig = {}

    await enhanceConfig(config, neuronOptions({ enforce: false }), silentDependencies({ log }))

    expect(config.disabled_providers).toBeUndefined()
    expect(config.share).toBeUndefined()
    expect(log).toHaveBeenCalledWith("warn", expect.stringContaining("enforce: false"))
  })
})
