export const PACKAGE_NAME = "@noser-engineering/opencode-plugin-neuron"
export const DEFAULT_TIMEOUT_MS = 5_000
export const PROVIDER_NPM = "@ai-sdk/openai-compatible"
/**
 * OpenCode's adapter for `/v1/responses`, as opposed to `PROVIDER_NPM`'s
 * `/v1/chat/completions`. A model whose deployment only implements the
 * Responses API returns `finish_reason: stop` after its first tool call
 * under the chat-completions adapter — indistinguishable from the model
 * genuinely being done, so OpenCode ends the agent loop early.
 */
export const RESPONSES_API_NPM = "@ai-sdk/openai"
export const CONFIG_SCHEMA = "https://opencode.ai/config.json"
