import type { Plugin } from "@opencode-ai/plugin"
import { PROVIDER_NPM } from "./constants.js"
import { readStoredApiCredentials, type StoredApiCredential } from "./auth.js"
import { applyCompliance } from "./compliance.js"
import { discoverRawModels, fetchDeprecatedModelNames, filterDeprecated, toModelConfig } from "./discovery.js"
import { parsePluginOptions } from "./options.js"
import type {
  LiteLLMModel,
  NeuronProfile,
  OpenCodeConfig,
  ParsedPluginOptions,
  ProviderConfig,
} from "./types.js"

type LogLevel = "debug" | "info" | "warn" | "error"

/**
 * Discovery results for the lifetime of the process.
 *
 * OpenCode calls the `config` hook more than once per process, and without this
 * every call would fan out one HTTP request per profile. Holds the promise
 * rather than the result so that concurrent calls share one request.
 *
 * Two profiles commonly point at the same proxy (one org, several keys), so
 * the two lookups are cached at different granularities: the model list is
 * per profile (`models`, keyed by profile + URL) since it depends on what
 * that profile's key may call, but which models the proxy has *deprecated*
 * is a property of the proxy itself, independent of which key asks — so
 * `deprecated` is keyed by URL alone. That also means a slow or failing
 * `/model/info` call only ever happens once per proxy per process, not once
 * per profile.
 *
 * Injected rather than module-global so tests get a fresh one for free.
 */
export interface DiscoveryCache {
  models: Map<string, Promise<LiteLLMModel[]>>
  deprecated: Map<string, Promise<Set<string>>>
}

export function createDiscoveryCache(): DiscoveryCache {
  return { models: new Map(), deprecated: new Map() }
}

interface RuntimeDependencies {
  discoverRawModels: (
    baseURL: string,
    apiKey: string | undefined,
    options: { timeoutMs: number },
  ) => Promise<LiteLLMModel[]>
  fetchDeprecatedModelNames: (
    baseURL: string,
    apiKey: string | undefined,
    options: { timeoutMs: number },
  ) => Promise<Set<string>>
  readCredentials: () => Promise<Record<string, StoredApiCredential>>
  log: (level: LogLevel, message: string, extra?: Record<string, unknown>) => Promise<void>
  cache?: DiscoveryCache
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

function discoverModelsOnce(
  profile: NeuronProfile,
  apiKey: string | undefined,
  options: ParsedPluginOptions,
  dependencies: RuntimeDependencies,
): Promise<LiteLLMModel[]> {
  const run = () => dependencies.discoverRawModels(profile.baseURL!, apiKey, { timeoutMs: options.timeoutMs })
  if (!dependencies.cache) return run()

  // The URL is part of the key so that a profile pointed at a different proxy
  // is not served the previous proxy's models.
  const key = `${profile.id}|${profile.baseURL}`
  const cached = dependencies.cache.models.get(key)
  if (cached) return cached

  // Failures are cached too. OpenCode only reads the config at startup, so
  // retrying on a later hook call within the same process would cost requests
  // without ever producing a usable model list.
  const pending = run()
  dependencies.cache.models.set(key, pending)
  return pending
}

/**
 * Which of the proxy's models are deprecated, cached once per `baseURL`
 * (see `DiscoveryCache`). Never rejects: a failed lookup is logged and
 * resolved to an empty set, so a slow or inaccessible `/model/info` costs
 * only deprecation filtering for that proxy, never a profile's model list.
 */
function deprecatedModelNamesOnce(
  baseURL: string,
  apiKey: string | undefined,
  options: ParsedPluginOptions,
  dependencies: RuntimeDependencies,
): Promise<Set<string>> {
  const run = async () => {
    try {
      return await dependencies.fetchDeprecatedModelNames(baseURL, apiKey, { timeoutMs: options.timeoutMs })
    } catch (error) {
      await dependencies.log("warn", `Deprecated-model lookup failed for ${baseURL}; showing all models`, {
        baseURL,
        error: error instanceof Error ? error.message : String(error),
      })
      return new Set<string>()
    }
  }
  if (!dependencies.cache) return run()

  const cached = dependencies.cache.deprecated.get(baseURL)
  if (cached) return cached

  const pending = run()
  dependencies.cache.deprecated.set(baseURL, pending)
  return pending
}

/**
 * Adds the configured profiles and their models to the config.
 *
 * Everything in here is convenience. It may fail, and it may return early;
 * `enhanceConfig` applies the compliance layer either way.
 */
async function applyDiscovery(
  config: OpenCodeConfig,
  options: ParsedPluginOptions,
  dependencies: RuntimeDependencies,
): Promise<void> {
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
        const [discovered, deprecated] = await Promise.all([
          discoverModelsOnce(profile, credential.apiKey, options, dependencies),
          deprecatedModelNamesOnce(profile.baseURL!, credential.apiKey, options, dependencies),
        ])
        const models = filterDeprecated(discovered, deprecated)
        provider.models ??= {}
        for (const model of models) {
          if (provider.models[model.id]) continue
          provider.models[model.id] = toModelConfig(model)
        }
        await dependencies.log("info", `Discovered ${models.length} models for ${profile.name}`, {
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

export async function enhanceConfig(
  config: OpenCodeConfig,
  rawOptions: Record<string, unknown> | undefined,
  dependencies: RuntimeDependencies,
): Promise<void> {
  const options = parsePluginOptions(rawOptions)
  for (const error of options.errors) {
    await dependencies.log("warn", `Invalid Neuron plugin configuration: ${error}`)
  }

  // Discovery and compliance are kept apart on purpose. OpenCode swallows
  // exceptions thrown out of the config hook (`Effect.ignore`), so a failure in
  // one half would silently take the other half with it. Compliance runs in a
  // finally block: after ensureProvider, so the plugin's own profiles count as
  // declared, and regardless of how discovery ended, so a broken plugin
  // configuration costs the user their models but never their protection.
  try {
    await applyDiscovery(config, options, dependencies)
  } catch (error) {
    await dependencies.log("error", "Neuron model discovery failed", {
      error: error instanceof Error ? error.message : String(error),
    })
  } finally {
    try {
      applyCompliance(config, { enforce: options.enforce, denyProviders: options.denyProviders })
      if (!options.enforce) {
        await dependencies.log("warn", "Neuron compliance layer is disabled via enforce: false")
      }
    } catch (error) {
      await dependencies.log("error", "Neuron compliance layer could not be applied", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
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
  // One cache per plugin load, so repeated hook calls share its entries.
  const cache = createDiscoveryCache()
  return {
    config: async (config) => {
      await enhanceConfig(config as unknown as OpenCodeConfig, rawOptions, {
        discoverRawModels,
        fetchDeprecatedModelNames,
        readCredentials: readStoredApiCredentials,
        log: createLogger(input),
        cache,
      })
    },
  }
}

NeuronPlugin satisfies Plugin
