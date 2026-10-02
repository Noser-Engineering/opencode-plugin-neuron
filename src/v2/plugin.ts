import { DEFAULT_PERMISSION_POLICY } from "../compliance.js"
import { PROVIDER_PACKAGE_V2 } from "../constants.js"
import { applyModelInfo, emptyModelInfo } from "../discovery.js"
import { parsePluginOptions } from "../options.js"
import { createDiscoveryCache, type DiscoveryCache } from "../plugin.js"
import type { LiteLLMModel, ModelInfo, NeuronProfile, ParsedPluginOptions } from "../types.js"
import { applyDenyList, applyPermissionRules, toPermissionRules } from "./compliance.js"
import type { NeuronContext, Registration, V2ModelInfo, V2ProviderInfo } from "./context.js"
import { toModelInfo } from "./model.js"

export type V2LogLevel = "info" | "warn" | "error"

export interface V2Dependencies {
  discoverRawModels: (
    baseURL: string,
    apiKey: string | undefined,
    options: { timeoutMs: number },
  ) => Promise<LiteLLMModel[]>
  fetchModelInfo: (baseURL: string, apiKey: string | undefined, options: { timeoutMs: number }) => Promise<ModelInfo>
  log: (level: V2LogLevel, message: string, extra?: Record<string, unknown>) => void
  cache?: DiscoveryCache
}

export type Cleanup = () => Promise<void>

/** OpenCode 2 routes a plugin's console output into its own log. */
export function consoleLogger(): V2Dependencies["log"] {
  return (level, message, extra) => {
    const line = `[opencode-neuron] ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}`
    if (level === "error") console.error(line)
    else if (level === "warn") console.warn(line)
    else console.log(line)
  }
}

interface ProfileRegistration {
  info: V2ProviderInfo
  models: V2ModelInfo[]
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function resolveKey(
  ctx: NeuronContext,
  profile: NeuronProfile,
): Promise<{ apiKey?: string; conflict: boolean }> {
  const connection = await ctx.integration.connection.active(profile.id)
  if (!connection) return { conflict: false }
  const credential = await ctx.integration.connection.resolve(connection)
  if (!credential || credential.type !== "key") return { conflict: false }
  const storedURL = credential.metadata?.baseURL
  if (typeof storedURL === "string" && storedURL !== profile.baseURL) return { conflict: true }
  return { apiKey: credential.key, conflict: false }
}

async function discover(
  profile: NeuronProfile,
  apiKey: string | undefined,
  options: ParsedPluginOptions,
  dependencies: V2Dependencies,
  cache: DiscoveryCache,
): Promise<LiteLLMModel[]> {
  const baseURL = profile.baseURL!
  const key = `${profile.id}|${baseURL}`
  let models = cache.models.get(key)
  if (!models) {
    models = dependencies.discoverRawModels(baseURL, apiKey, { timeoutMs: options.timeoutMs })
    cache.models.set(key, models)
  }
  let info = cache.modelInfo.get(baseURL)
  if (!info) {
    info = dependencies.fetchModelInfo(baseURL, apiKey, { timeoutMs: options.timeoutMs }).catch((error) => {
      dependencies.log("warn", `Model-info lookup failed for ${baseURL}; showing all models, pricing cached tokens like input`, {
        baseURL,
        error: describe(error),
      })
      return emptyModelInfo()
    })
    cache.modelInfo.set(baseURL, info)
  }
  const [discovered, resolvedInfo] = await Promise.all([models, info])
  return applyModelInfo(discovered, resolvedInfo)
}

/**
 * Everything discovery needs to know per profile, computed before the
 * transform so the transform callback itself stays pure.
 */
async function prepareProfiles(
  ctx: NeuronContext,
  options: ParsedPluginOptions,
  dependencies: V2Dependencies,
  cache: DiscoveryCache,
): Promise<ProfileRegistration[]> {
  const results = await Promise.all(
    options.profiles.map(async (profile): Promise<ProfileRegistration | undefined> => {
      let apiKey: string | undefined
      try {
        const resolved = await resolveKey(ctx, profile)
        if (resolved.conflict) {
          dependencies.log("warn", `Credential URL mismatch for ${profile.name}; profile disabled`, {
            providerID: profile.id,
            baseURL: profile.baseURL,
          })
          return undefined
        }
        apiKey = resolved.apiKey
      } catch (error) {
        dependencies.log("warn", `Could not read the credential for ${profile.name}`, {
          providerID: profile.id,
          error: describe(error),
        })
      }

      const info: V2ProviderInfo = {
        id: profile.id,
        name: profile.name,
        activation: "enabled",
        package: PROVIDER_PACKAGE_V2,
        settings: { baseURL: profile.baseURL },
      }
      try {
        const models = await discover(profile, apiKey, options, dependencies, cache)
        dependencies.log("info", `Discovered ${models.length} models for ${profile.name}`, {
          providerID: profile.id,
          baseURL: profile.baseURL,
        })
        return { info, models: models.map((model) => toModelInfo(model, profile.id)) }
      } catch (error) {
        dependencies.log("warn", `Model discovery failed for ${profile.name}`, {
          providerID: profile.id,
          baseURL: profile.baseURL,
          error: describe(error),
        })
        // Registered anyway, with no models: /connect still has to offer the
        // profile so the user can fix the key.
        return { info, models: [] }
      }
    }),
  )
  return results.filter((result): result is ProfileRegistration => result !== undefined)
}

async function registerCompliance(ctx: NeuronContext, options: ParsedPluginOptions, dependencies: V2Dependencies): Promise<Registration[]> {
  if (!options.enforce) {
    dependencies.log("warn", "Neuron compliance layer is disabled via enforce: false")
    return []
  }
  const policy = { enforce: true, denyProviders: options.denyProviders }
  const rules = toPermissionRules(DEFAULT_PERMISSION_POLICY)
  const registrations = [
    await ctx.provider.transform((editor) => applyDenyList(editor, policy)),
    await ctx.agent.transform((editor) => applyPermissionRules(editor, rules)),
  ]
  dependencies.log(
    "warn",
    "OpenCode 2 plugins cannot set share or update; the setup command writes share: disabled and update: notify into opencode.json; see README, section OpenCode 2.x",
  )
  return registrations
}

/**
 * The v2 plugin body. Compliance first, so a broken profile configuration
 * costs the user their models but never their protection; then the profiles;
 * then a subscription that re-runs discovery whenever a credential changes,
 * so `/connect` takes effect without a restart.
 */
export async function setupNeuron(ctx: NeuronContext, dependencies: V2Dependencies): Promise<Cleanup> {
  const options = parsePluginOptions(ctx.options as Record<string, unknown>)
  for (const error of options.errors) dependencies.log("warn", `Invalid Neuron plugin configuration: ${error}`)
  const cache = dependencies.cache ?? createDiscoveryCache()

  const fixed: Registration[] = []
  try {
    fixed.push(...(await registerCompliance(ctx, options, dependencies)))
  } catch (error) {
    dependencies.log("error", "Neuron compliance layer could not be applied", { error: describe(error) })
  }

  if (!options.profiles.length) {
    return async () => {
      for (const registration of fixed) await registration.dispose()
    }
  }

  const profiles = options.profiles
  fixed.push(
    await ctx.integration.transform((editor) => {
      for (const profile of profiles) {
        editor.method.update({ integrationID: profile.id, method: { type: "key", label: "API key" } })
      }
    }),
  )

  let providers: Registration | undefined
  const refresh = async (): Promise<void> => {
    try {
      const prepared = await prepareProfiles(ctx, options, dependencies, cache)
      const next = await ctx.provider.transform((editor) => {
        for (const { info, models } of prepared) editor.add({ info, models })
      })
      const previous = providers
      providers = next
      await previous?.dispose()
    } catch (error) {
      dependencies.log("error", "Neuron model discovery failed", { error: describe(error) })
    }
  }
  await refresh()

  // Serialised: a second event while a refresh runs waits for it, then runs
  // once more against the new credentials.
  let chain: Promise<void> = Promise.resolve()
  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type !== "credential.updated") continue
        chain = chain.then(async () => {
          if (controller.signal.aborted) return
          // The credential may change what /model/info answers too (a failed
          // unauthenticated lookup must not stick), so drop both caches.
          cache.models.clear()
          cache.modelInfo.clear()
          await refresh()
        })
      }
    } catch (error) {
      if (!controller.signal.aborted) dependencies.log("warn", "Credential event stream ended", { error: describe(error) })
    }
  })()

  return async () => {
    controller.abort()
    await chain.catch(() => undefined)
    for (const registration of fixed) await registration.dispose()
    await providers?.dispose()
  }
}
