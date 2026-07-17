import type { Plugin } from "@opencode-ai/plugin"
import { PROVIDER_NPM } from "./constants.js"
import { readStoredApiCredentials, type StoredApiCredential } from "./auth.js"
import { discoverModels, toModelConfig } from "./discovery.js"
import { parsePluginOptions } from "./options.js"
import type { LiteLLMModel, NeuronProfile, OpenCodeConfig, ProviderConfig } from "./types.js"

type LogLevel = "debug" | "info" | "warn" | "error"

interface RuntimeDependencies {
  discover: (
    baseURL: string,
    apiKey: string | undefined,
    options: { timeoutMs: number },
  ) => Promise<LiteLLMModel[]>
  readCredentials: () => Promise<Record<string, StoredApiCredential>>
  log: (level: LogLevel, message: string, extra?: Record<string, unknown>) => Promise<void>
}

interface NeuronPluginInput {
  client: {
    app: {
      log(input: {
        body: {
          service: string
          level: LogLevel
          message: string
          extra?: Record<string, unknown>
        }
      }): Promise<unknown>
    }
  }
}

export type NeuronPluginFunction = (
  input: NeuronPluginInput,
  options?: Record<string, unknown>,
) => Promise<{ config: (config: unknown) => Promise<void> }>

function resolveCredential(
  profile: NeuronProfile,
  storedCredentials: Record<string, StoredApiCredential>,
): { apiKey?: string; conflict: boolean } {
  const credential = storedCredentials[profile.id]
  if (!credential) return { conflict: false }
  if (credential.baseURL === profile.baseURL) return { apiKey: credential.key, conflict: false }
  return { conflict: true }
}

function ensureProvider(config: OpenCodeConfig, profile: NeuronProfile): ProviderConfig {
  config.provider ??= {}
  const existing = config.provider[profile.id] ?? {}
  const { env: _environment, options: rawOptions, ...existingProvider } = existing
  const { apiKey: _apiKey, ...existingOptions } = rawOptions ?? {}

  const provider: ProviderConfig = {
    ...existingProvider,
    npm: existing.npm ?? PROVIDER_NPM,
    name: profile.name,
    options: {
      ...existingOptions,
      baseURL: profile.baseURL,
    },
    models: { ...existing.models },
  }
  config.provider[profile.id] = provider
  return provider
}

export async function enhanceConfig(
  config: OpenCodeConfig,
  rawOptions: Record<string, unknown> | undefined,
  dependencies: RuntimeDependencies,
): Promise<void> {
  const options = parsePluginOptions(rawOptions)
  for (const error of options.errors) {
    await dependencies.log("warn", `Invalid Neuron plugin configuration: ${error}`)
  }
  if (!options.profiles.length) return

  let storedCredentials: Record<string, StoredApiCredential> = {}
  try {
    storedCredentials = await dependencies.readCredentials()
  } catch (error) {
    await dependencies.log("warn", "Could not read OpenCode credentials", {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  await Promise.all(
    options.profiles.map(async (profile) => {
      const credential = resolveCredential(profile, storedCredentials)
      if (credential.conflict) {
        if (config.provider) delete config.provider[profile.id]
        await dependencies.log("warn", `Credential URL mismatch for ${profile.name}; profile disabled`, {
          providerID: profile.id,
          baseURL: profile.baseURL,
        })
        return
      }
      const provider = ensureProvider(config, profile)

      try {
        const discovered = await dependencies.discover(profile.baseURL!, credential.apiKey, {
          timeoutMs: options.timeoutMs,
        })
        provider.models ??= {}
        for (const model of discovered) {
          if (provider.models[model.id]) continue
          provider.models[model.id] = toModelConfig(model)
        }
        await dependencies.log("info", `Discovered ${discovered.length} models for ${profile.name}`, {
          providerID: profile.id,
          baseURL: profile.baseURL,
        })
      } catch (error) {
        await dependencies.log("warn", `Model discovery failed for ${profile.name}`, {
          providerID: profile.id,
          baseURL: profile.baseURL,
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }),
  )
}

function createLogger(input: NeuronPluginInput): RuntimeDependencies["log"] {
  return async (level, message, extra) => {
    try {
      await input.client.app.log({
        body: {
          service: "opencode-plugin-neuron",
          level,
          message,
          ...(extra ? { extra } : {}),
        },
      })
    } catch {
      if (level === "warn" || level === "error") console.warn(`[opencode-neuron] ${message}`)
    }
  }
}

export const NeuronPlugin: NeuronPluginFunction = async (input, rawOptions) => {
  return {
    config: async (config) => {
      await enhanceConfig(config as unknown as OpenCodeConfig, rawOptions, {
        discover: discoverModels,
        readCredentials: readStoredApiCredentials,
        log: createLogger(input),
      })
    },
  }
}

NeuronPlugin satisfies Plugin
