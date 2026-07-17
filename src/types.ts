export interface NeuronProfile {
  id: string
  name: string
  baseURL?: string
}

export interface NeuronPluginOptions {
  profiles?: NeuronProfile[]
  timeoutMs?: number
}

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
}

export interface ModelConfig {
  name?: string
  attachment?: boolean
  reasoning?: boolean
  tool_call?: boolean
  limit?: {
    context: number
    output: number
  }
  modalities?: {
    input?: Array<"text" | "image">
    output?: Array<"text">
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

export interface OpenCodeConfig {
  provider?: Record<string, ProviderConfig>
  [key: string]: unknown
}

export interface ParsedPluginOptions {
  profiles: NeuronProfile[]
  timeoutMs: number
  errors: string[]
}
