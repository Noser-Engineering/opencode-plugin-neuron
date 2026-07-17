import type { LiteLLMModel, ModelConfig } from "./types.js"

interface DiscoveryOptions {
  timeoutMs: number
  fetch?: typeof globalThis.fetch
}

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

function parseModel(value: unknown): LiteLLMModel | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const item = value as Record<string, unknown>
  if (typeof item.id !== "string" || !item.id.trim()) return undefined
  const id = item.id.trim()
  if (id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) return undefined
  const info =
    item.model_info && typeof item.model_info === "object" && !Array.isArray(item.model_info)
      ? (item.model_info as Record<string, unknown>)
      : {}

  const maxTokens = optionalNumber(item.max_tokens) ?? optionalNumber(info.max_tokens)
  const maxInputTokens = optionalNumber(item.max_input_tokens) ?? optionalNumber(info.max_input_tokens)
  const maxOutputTokens = optionalNumber(item.max_output_tokens) ?? optionalNumber(info.max_output_tokens)
  const supportsFunctionCalling =
    optionalBoolean(item.supports_function_calling) ?? optionalBoolean(info.supports_function_calling)
  const supportsVision = optionalBoolean(item.supports_vision) ?? optionalBoolean(info.supports_vision)

  return {
    id,
    ...(typeof item.object === "string" ? { object: item.object } : {}),
    ...(typeof item.created === "number" ? { created: item.created } : {}),
    ...(typeof item.owned_by === "string" ? { owned_by: item.owned_by } : {}),
    ...(typeof item.litellm_provider === "string" ? { litellm_provider: item.litellm_provider } : {}),
    ...(typeof item.mode === "string" ? { mode: item.mode } : {}),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(maxInputTokens ? { max_input_tokens: maxInputTokens } : {}),
    ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
    ...(supportsFunctionCalling !== undefined ? { supports_function_calling: supportsFunctionCalling } : {}),
    ...(supportsVision !== undefined ? { supports_vision: supportsVision } : {}),
  }
}

export async function discoverModels(
  baseURL: string,
  apiKey: string | undefined,
  options: DiscoveryOptions,
): Promise<LiteLLMModel[]> {
  const fetchImplementation = options.fetch ?? globalThis.fetch
  const headers: Record<string, string> = { Accept: "application/json" }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const response = await fetchImplementation(`${baseURL}/models`, {
    method: "GET",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(options.timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`model discovery returned HTTP ${response.status} ${response.statusText}`.trim())
  }

  const payload: unknown = await response.json()
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new Error("model discovery returned an invalid JSON object")
  }
  const data = (payload as Record<string, unknown>).data
  if (!Array.isArray(data)) throw new Error("model discovery response does not contain a data array")

  const models = new Map<string, LiteLLMModel>()
  for (const value of data) {
    const model = parseModel(value)
    if (model) models.set(model.id, model)
  }
  return [...models.values()]
}

export function toModelConfig(model: LiteLLMModel): ModelConfig {
  const context = model.max_input_tokens ?? model.max_tokens
  const output = model.max_output_tokens ?? model.max_tokens
  const reasoning =
    model.mode?.toLowerCase() === "responses" ||
    /(^|\/)(?:gpt-?5|o[134])(?:[-.]|$)/i.test(model.id)

  return {
    name: model.id,
    ...(model.supports_function_calling !== undefined ? { tool_call: model.supports_function_calling } : {}),
    ...(model.supports_vision ? { attachment: true } : {}),
    ...(reasoning ? { reasoning: true } : {}),
    ...(context && output ? { limit: { context, output } } : {}),
    ...(model.supports_vision
      ? {
          modalities: {
            input: ["text", "image"] as Array<"text" | "image">,
            output: ["text"] as Array<"text">,
          },
        }
      : {}),
  }
}
