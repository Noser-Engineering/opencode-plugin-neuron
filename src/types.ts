export interface NeuronProfile {
  id: string
  name: string
  baseURL?: string
}

export interface NeuronPluginOptions {
  profiles?: NeuronProfile[]
  timeoutMs?: number
  enforce?: boolean
  denyProviders?: string[]
}

/**
 * A model as the plugin understands it, normalized from either discovery
 * endpoint. Costs are already converted to OpenCode's unit; the wire fields
 * `input_cost_per_token` and `output_cost_per_token` do not survive parsing.
 */
export interface LiteLLMModel {
  id: string
  object?: string
  created?: number
  owned_by?: string
  litellm_provider?: string
  mode?: string
  max_tokens?: number
  max_input_tokens?: number
  max_output_tokens?: number
  supports_function_calling?: boolean
  supports_vision?: boolean
  supports_reasoning?: boolean
  supports_pdf_input?: boolean
  input_cost_per_million?: number
  output_cost_per_million?: number
}

export interface ModelConfig {
  name?: string
  attachment?: boolean
  reasoning?: boolean
  tool_call?: boolean
  /** Per million tokens, matching OpenCode's own unit. */
  cost?: {
    input: number
    output: number
  }
  limit?: {
    context: number
    output: number
  }
  modalities?: {
    input?: Array<"text" | "image" | "pdf">
    output?: Array<"text">
  }
  /** Overrides the provider's adapter for this one model; see RESPONSES_API_NPM. */
  provider?: {
    npm: string
  }
  [key: string]: unknown
}

export interface ProviderConfig {
  npm?: string
  name?: string
  env?: string[]
  options?: Record<string, unknown>
  models?: Record<string, ModelConfig>
  [key: string]: unknown
}

export type PermissionRule = "ask" | "allow" | "deny"

/** A category's rules, keyed by the glob/command pattern OpenCode matches against. */
export type PermissionCategory = Record<string, PermissionRule>

export interface PermissionConfig {
  "*"?: PermissionRule
  read?: PermissionRule | PermissionCategory
  edit?: PermissionRule | PermissionCategory
  bash?: PermissionRule | PermissionCategory
  [key: string]: unknown
}

export interface OpenCodeConfig {
  provider?: Record<string, ProviderConfig>
  disabled_providers?: string[]
  share?: "manual" | "auto" | "disabled"
  autoupdate?: boolean | "notify"
  permission?: PermissionConfig
  [key: string]: unknown
}

export interface ParsedPluginOptions {
  profiles: NeuronProfile[]
  timeoutMs: number
  enforce: boolean
  denyProviders: string[]
  errors: string[]
}
