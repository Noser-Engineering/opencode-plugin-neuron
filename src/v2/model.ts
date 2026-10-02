import { DEFAULT_CONTEXT_LIMIT, DEFAULT_OUTPUT_LIMIT, RESPONSES_API_PACKAGE_V2 } from "../constants.js"
import type { LiteLLMModel } from "../types.js"
import type { V2ModelCost, V2ModelInfo } from "./context.js"

/**
 * One LiteLLM model as OpenCode 2.x wants it.
 *
 * Mirrors `toModelConfig` for v1 with the differences v2 forces: `limit` and
 * `cost` are mandatory (defaults and an empty array stand in), capability
 * flags move into `capabilities`, and the Responses-API override is a
 * `package` on the model instead of `provider.npm`. Deprecated aliases never
 * reach this function; `applyModelInfo` has already dropped them.
 */
export function toModelInfo(model: LiteLLMModel, providerID: string): V2ModelInfo {
  const context = model.max_input_tokens ?? model.max_tokens ?? DEFAULT_CONTEXT_LIMIT
  const output = model.max_output_tokens ?? model.max_tokens ?? model.max_input_tokens ?? DEFAULT_OUTPUT_LIMIT

  const input = [
    "text",
    ...(model.supports_vision ? ["image"] : []),
    ...(model.supports_pdf_input ? ["pdf"] : []),
  ]

  // Same rule as v1: a missing cache price falls back to the input price, because
  // OpenCode treats a missing cache price as free and that hides most of a
  // session's real cost.
  const cost: V2ModelCost[] =
    model.input_cost_per_million !== undefined && model.output_cost_per_million !== undefined
      ? [
          {
            input: model.input_cost_per_million,
            output: model.output_cost_per_million,
            cache: {
              read: model.cache_read_cost_per_million ?? model.input_cost_per_million,
              write: model.cache_write_cost_per_million ?? model.input_cost_per_million,
            },
          },
        ]
      : []

  const isResponsesAPI = model.mode?.toLowerCase() === "responses"

  return {
    id: model.id,
    modelID: model.id,
    providerID,
    name: model.id,
    ...(isResponsesAPI ? { package: RESPONSES_API_PACKAGE_V2 } : {}),
    capabilities: { tools: model.supports_function_calling ?? true, input, output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost,
    status: "active",
    enabled: true,
    limit: { context, output },
  }
}
