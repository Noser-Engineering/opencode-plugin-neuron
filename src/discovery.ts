import type { LiteLLMModel, ModelConfig } from "./types.js"

interface DiscoveryOptions {
  timeoutMs: number
  fetch?: typeof globalThis.fetch
}

/** Modes that produce a chat completion. Everything else is not a chat model. */
const CHAT_MODES = new Set(["chat", "responses"])

/** Anything that could smuggle terminal escapes into the model picker. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/

/**
 * Reasoning models whose id gives them away.
 *
 * Only used for the /v1/models fallback, which carries no capability flags.
 * It guesses wrong for Claude, Gemini and every custom alias, which is why
 * /model_group/info is the primary source.
 */
const REASONING_ID_PATTERN = /(^|\/)(?:gpt-?5|o[134])(?:[-.]|$)/i

function optionalNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function optionalBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined
}

/**
 * LiteLLM prices per token, OpenCode per million tokens.
 *
 * Verified against OpenCode 1.18.4, which computes a request's cost as
 * `tokens * cost.input / 1e6`. Zero is a real price, so it is kept; only
 * negative and non-finite values are dropped.
 */
function costPerMillion(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined
  return Math.round(value * 1e6 * 1e6) / 1e6
}

function validModelID(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  const id = value.trim()
  if (!id || id.length > 256 || CONTROL_CHARACTERS.test(id)) return undefined
  // A wildcard entry is a LiteLLM access rule, not a model anyone can call.
  if (id.includes("*")) return undefined
  return id
}

function isChatModel(model: LiteLLMModel): boolean {
  // A missing mode is normal on older LiteLLM versions and must not hide a model.
  if (model.mode === undefined) return true
  return CHAT_MODES.has(model.mode.toLowerCase())
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  return value as Record<string, unknown>
}

/** One entry of `GET /v1/models`. Carries an id and, if lucky, a `model_info`. */
function parseModel(value: unknown): LiteLLMModel | undefined {
  const item = asRecord(value)
  if (!item) return undefined
  const id = validModelID(item.id)
  if (!id) return undefined
  const info = asRecord(item.model_info) ?? {}

  const maxTokens = optionalNumber(item.max_tokens) ?? optionalNumber(info.max_tokens)
  const maxInputTokens = optionalNumber(item.max_input_tokens) ?? optionalNumber(info.max_input_tokens)
  const maxOutputTokens = optionalNumber(item.max_output_tokens) ?? optionalNumber(info.max_output_tokens)
  const supportsFunctionCalling =
    optionalBoolean(item.supports_function_calling) ?? optionalBoolean(info.supports_function_calling)
  const supportsVision = optionalBoolean(item.supports_vision) ?? optionalBoolean(info.supports_vision)
  const supportsReasoning = optionalBoolean(item.supports_reasoning) ?? optionalBoolean(info.supports_reasoning)
  const supportsPdfInput = optionalBoolean(item.supports_pdf_input) ?? optionalBoolean(info.supports_pdf_input)
  const inputCost = costPerMillion(item.input_cost_per_token ?? info.input_cost_per_token)
  const outputCost = costPerMillion(item.output_cost_per_token ?? info.output_cost_per_token)
  const mode = typeof item.mode === "string" ? item.mode : typeof info.mode === "string" ? info.mode : undefined

  return {
    id,
    ...(typeof item.object === "string" ? { object: item.object } : {}),
    ...(typeof item.created === "number" ? { created: item.created } : {}),
    ...(typeof item.owned_by === "string" ? { owned_by: item.owned_by } : {}),
    ...(typeof item.litellm_provider === "string" ? { litellm_provider: item.litellm_provider } : {}),
    ...(mode !== undefined ? { mode } : {}),
    ...(maxTokens ? { max_tokens: maxTokens } : {}),
    ...(maxInputTokens ? { max_input_tokens: maxInputTokens } : {}),
    ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
    ...(supportsFunctionCalling !== undefined ? { supports_function_calling: supportsFunctionCalling } : {}),
    ...(supportsVision !== undefined ? { supports_vision: supportsVision } : {}),
    ...(supportsReasoning !== undefined ? { supports_reasoning: supportsReasoning } : {}),
    ...(supportsPdfInput !== undefined ? { supports_pdf_input: supportsPdfInput } : {}),
    ...(inputCost !== undefined ? { input_cost_per_million: inputCost } : {}),
    ...(outputCost !== undefined ? { output_cost_per_million: outputCost } : {}),
  }
}

/**
 * One entry of `GET /v1/model_group/info`.
 *
 * Already deduplicated per alias and, unlike /v1/models, it carries real
 * capability booleans: LiteLLM coerces them to false rather than leaving them
 * null, so an absent flag means the endpoint is old, not that the model lacks
 * the capability.
 */
function parseModelGroup(value: unknown): LiteLLMModel | undefined {
  const item = asRecord(value)
  if (!item) return undefined
  const id = validModelID(item.model_group)
  if (!id) return undefined

  const maxInputTokens = optionalNumber(item.max_input_tokens)
  const maxOutputTokens = optionalNumber(item.max_output_tokens)
  const supportsFunctionCalling = optionalBoolean(item.supports_function_calling)
  const supportsVision = optionalBoolean(item.supports_vision)
  const supportsReasoning = optionalBoolean(item.supports_reasoning)
  const supportsPdfInput = optionalBoolean(item.supports_pdf_input)
  const inputCost = costPerMillion(item.input_cost_per_token)
  const outputCost = costPerMillion(item.output_cost_per_token)

  return {
    id,
    ...(typeof item.mode === "string" ? { mode: item.mode } : {}),
    ...(maxInputTokens ? { max_input_tokens: maxInputTokens } : {}),
    ...(maxOutputTokens ? { max_output_tokens: maxOutputTokens } : {}),
    ...(supportsFunctionCalling !== undefined ? { supports_function_calling: supportsFunctionCalling } : {}),
    ...(supportsVision !== undefined ? { supports_vision: supportsVision } : {}),
    ...(supportsReasoning !== undefined ? { supports_reasoning: supportsReasoning } : {}),
    ...(supportsPdfInput !== undefined ? { supports_pdf_input: supportsPdfInput } : {}),
    ...(inputCost !== undefined ? { input_cost_per_million: inputCost } : {}),
    ...(outputCost !== undefined ? { output_cost_per_million: outputCost } : {}),
  }
}

async function fetchModelList(
  url: string,
  apiKey: string | undefined,
  options: DiscoveryOptions,
): Promise<unknown[]> {
  const fetchImplementation = options.fetch ?? globalThis.fetch
  const headers: Record<string, string> = { Accept: "application/json" }
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`

  const response = await fetchImplementation(url, {
    method: "GET",
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(options.timeoutMs),
  })
  if (!response.ok) {
    throw new Error(`model discovery returned HTTP ${response.status} ${response.statusText}`.trim())
  }

  const payload: unknown = await response.json()
  if (!asRecord(payload)) throw new Error("model discovery returned an invalid JSON object")
  const data = (payload as Record<string, unknown>).data
  if (!Array.isArray(data)) throw new Error("model discovery response does not contain a data array")
  return data
}

function collect(data: unknown[], parse: (value: unknown) => LiteLLMModel | undefined): LiteLLMModel[] {
  const models = new Map<string, LiteLLMModel>()
  for (const value of data) {
    const model = parse(value)
    if (model && isChatModel(model)) models.set(model.id, model)
  }
  return [...models.values()]
}

/**
 * Asks the proxy which models this key may use.
 *
 * /model_group/info is the better source: deduplicated per alias, with costs,
 * a mode and honest capability flags. It is also newer, and a restricted key
 * may not reach it, so /v1/models remains as a fallback. Both paths return the
 * same normalized shape.
 */
export async function discoverModels(
  baseURL: string,
  apiKey: string | undefined,
  options: DiscoveryOptions,
): Promise<LiteLLMModel[]> {
  try {
    const groups = await fetchModelList(`${baseURL}/model_group/info`, apiKey, options)
    const models = collect(groups, parseModelGroup)
    // An empty result is treated as an unusable endpoint rather than as a key
    // with no models: older LiteLLM answers 200 with an unrelated body.
    if (models.length) return models
  } catch {
    // Fall through. The fallback reports its own failure.
  }

  return collect(await fetchModelList(`${baseURL}/models`, apiKey, options), parseModel)
}

export function toModelConfig(model: LiteLLMModel): ModelConfig {
  const context = model.max_input_tokens ?? model.max_tokens
  const output = model.max_output_tokens ?? model.max_tokens

  // Trust the proxy when it says anything at all. The id heuristic only runs
  // for /v1/models, which reports no capabilities.
  const reasoning =
    model.supports_reasoning ??
    (model.mode?.toLowerCase() === "responses" || REASONING_ID_PATTERN.test(model.id))

  const attachment = Boolean(model.supports_vision || model.supports_pdf_input)
  const input: Array<"text" | "image" | "pdf"> = [
    "text",
    ...(model.supports_vision ? (["image"] as const) : []),
    ...(model.supports_pdf_input ? (["pdf"] as const) : []),
  ]

  const cost =
    model.input_cost_per_million !== undefined && model.output_cost_per_million !== undefined
      ? { input: model.input_cost_per_million, output: model.output_cost_per_million }
      : undefined

  return {
    name: model.id,
    ...(model.supports_function_calling !== undefined ? { tool_call: model.supports_function_calling } : {}),
    ...(attachment ? { attachment: true } : {}),
    ...(reasoning ? { reasoning: true } : {}),
    ...(cost ? { cost } : {}),
    ...(context && output ? { limit: { context, output } } : {}),
    ...(input.length > 1 ? { modalities: { input, output: ["text"] as Array<"text"> } } : {}),
  }
}
