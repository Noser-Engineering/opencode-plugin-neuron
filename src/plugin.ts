import type { Plugin } from "@opencode-ai/plugin"
import { PROVIDER_NPM } from "./constants.js"
import { readStoredApiKeys } from "./auth.js"
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
  readApiKeys: () => Promise<Record<string, string>>
  env: Record<string, string | undefined>
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

function resolveEnvironmentReference(value: string, env: NodeJS.ProcessEnv): string | undefined {
  const match = /^\{env:([A-Za-z_][A-Za-z0-9_]*)\}$/.exec(value)
  return match?.[1] ? env[match[1]] : value
}

function resolveApiKey(
  profile: NeuronProfile,
  provider: ProviderConfig,
  storedKeys: Record<string, string>,
  env: Record<string, string | undefined>,
): string | undefined {
  const configuredKey = provider.options?.apiKey
  if (typeof configuredKey === "string" && configuredKey) return resolveEnvironmentReference(configuredKey, env)
  if (storedKeys[profile.id]) return storedKeys[profile.id]
  if (profile.apiKeyEnv && env[profile.apiKeyEnv]) return env[profile.apiKeyEnv]
  for (const envName of provider.env ?? []) {
    if (env[envName]) return env[envName]
  }
  if (profile.id === "neuron") return env.NEURON_API_KEY
  return undefined
}

function ensureProvider(config: OpenCodeConfig, profile: NeuronProfile): ProviderConfig {
  config.provider ??= {}
  const existing = config.provider[profile.id] ?? {}
  const existingEnvironment = Array.isArray(existing.env) ? existing.env : []
  const environment = profile.apiKeyEnv
    ? [...new Set([...existingEnvironment, profile.apiKeyEnv])]
    : existingEnvironment

  const provider: ProviderConfig = {
    ...existing,
    npm: existing.npm ?? PROVIDER_NPM,
    name: profile.name,
    ...(environment.length ? { env: environment } : {}),
    options: {
      ...existing.options,
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

  let storedKeys: Record<string, string> = {}
  try {
    storedKeys = await dependencies.readApiKeys()
  } catch (error) {
    await dependencies.log("warn", "Could not read OpenCode credentials", {
      error: error instanceof Error ? error.message : String(error),
    })
  }

  await Promise.all(
    options.profiles.map(async (profile) => {
      const provider = ensureProvider(config, profile)
      const apiKey = resolveApiKey(profile, provider, storedKeys, dependencies.env)

      try {
        const discovered = await dependencies.discover(profile.baseURL!, apiKey, { timeoutMs: options.timeoutMs })
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
        readApiKeys: readStoredApiKeys,
        env: process.env,
        log: createLogger(input),
      })
    },
  }
}

NeuronPlugin satisfies Plugin
