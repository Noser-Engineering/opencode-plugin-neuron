import type { OpenCodeConfig } from "./types.js"

/**
 * Providers OpenCode loads on its own as soon as a credential or environment
 * variable happens to exist, and that a workstation realistically carries a
 * stray credential for.
 *
 * This list is deliberately a denylist, not an allowlist: it never touches a
 * provider nobody named. The trade-off is that it cannot be complete. Every one
 * of the 172 providers in the models.dev catalog autoloads from an environment
 * variable, and a future OpenCode release can add more, so a credential for a
 * provider that is not listed here still gets picked up. Extend the list with
 * the `denyProviders` plugin option rather than editing this file downstream.
 */
export const AUTOLOADED_PROVIDERS: readonly string[] = [
  // OpenCode's own hosted gateway (Zen) — the default path on first contact
  "opencode",
  "opencode-go",
  // First-party model vendors
  "anthropic",
  "openai",
  "google",
  "xai",
  "meta",
  "llama",
  "mistral",
  "deepseek",
  "cohere",
  "perplexity",
  "moonshotai",
  "kimi-for-coding",
  "minimax",
  "zhipuai",
  "zai",
  "alibaba",
  "upstage",
  "sarvam",
  "inception",
  "venice",
  // Hyperscalers and enterprise platforms
  "azure",
  "azure-cognitive-services",
  "google-vertex",
  "google-vertex-anthropic",
  "amazon-bedrock",
  "databricks",
  "snowflake-cortex",
  "cloudflare-workers-ai",
  "cloudflare-ai-gateway",
  "scaleway",
  "ovhcloud",
  "digitalocean",
  "hetzner",
  "vultr",
  // Developer platforms that ship a token by default
  "github-copilot",
  "github-models",
  "gitlab",
  "vercel",
  "v0",
  // Aggregators and inference gateways
  "openrouter",
  "requesty",
  "helicone",
  "llmgateway",
  "togetherai",
  "fireworks-ai",
  "groq",
  "cerebras",
  "deepinfra",
  "novita-ai",
  "baseten",
  "nvidia",
  "huggingface",
  "chutes",
  "poe",
  "morph",
  "synthetic",
  "ollama-cloud",
  "lmstudio",
]

export interface CompliancePolicy {
  enforce: boolean
  denyProviders: string[]
}

/**
 * What a previous call added to this config object.
 *
 * The `config` hook can run several times per process against one cumulative
 * config, and the set of declared providers can grow between those calls. An
 * entry generated earlier has to be retracted once its provider turns out to be
 * declared, or the layer would keep blocking something the user asked for.
 *
 * Keyed by the config object so that entries the user wrote by hand are never
 * mistaken for generated ones, and so that no state survives between tests.
 */
const generatedEntries = new WeakMap<OpenCodeConfig, { providers: string[] }>()

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set(values)]
}

/**
 * Providers the user named on purpose. OpenCode only fills `config.provider`
 * from configuration files, never from an autoloaded credential, so presence
 * here is the signal that somebody made a deliberate choice.
 */
export function declaredProviderIDs(config: OpenCodeConfig): string[] {
  if (!config.provider || typeof config.provider !== "object") return []
  return Object.keys(config.provider)
}

/** The providers to block: everything denyable that was not declared. */
export function deniedProviderIDs(config: OpenCodeConfig, policy: CompliancePolicy): string[] {
  const declared = new Set(declaredProviderIDs(config))
  const denyable = uniqueStrings([...AUTOLOADED_PROVIDERS, ...policy.denyProviders])
  return denyable.filter((id) => !declared.has(id))
}

/**
 * Blocks providers nobody declared and turns off the two features that can leak
 * a conversation or change the provider set behind the user's back.
 *
 * Verified against OpenCode 1.18.4: `disabled_providers` set from the `config`
 * hook removes a provider from the catalog, and it wins over an explicitly
 * declared `provider.<id>` entry — which is why declared providers are
 * subtracted above instead of being blocked and re-allowed.
 *
 * Safe to call repeatedly. OpenCode may invoke the `config` hook more than once
 * per process with a cumulative config object.
 */
export function applyCompliance(config: OpenCodeConfig, policy: CompliancePolicy): void {
  if (!policy.enforce) return

  const denied = deniedProviderIDs(config, policy)
  const deniedSet = new Set(denied)
  const previous = generatedEntries.get(config)

  const retracted = new Set((previous?.providers ?? []).filter((id) => !deniedSet.has(id)))
  const existingDisabled = Array.isArray(config.disabled_providers)
    ? config.disabled_providers.filter((entry): entry is string => typeof entry === "string")
    : []
  config.disabled_providers = uniqueStrings([...existingDisabled.filter((id) => !retracted.has(id)), ...denied])
  generatedEntries.set(config, { providers: denied })

  // "disabled" is the strictest value; /share would publish the conversation
  // including code excerpts to opencode.ai, where a CDN caches it.
  config.share = "disabled"

  // An automatic update can introduce a new preconfigured provider without
  // anyone looking at it. `false` is stricter than "notify", so keep it.
  if (config.autoupdate !== false) config.autoupdate = "notify"
}
