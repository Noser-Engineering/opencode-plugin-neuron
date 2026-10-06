export const PACKAGE_NAME = "@noser-engineering/opencode-plugin-neuron"
/**
 * Kept in sync with package.json by scripts/sync-version.mjs via the
 * `npm version` hook — do not edit by hand. A constant rather than a
 * runtime read of package.json because the standalone binaries
 * (`bun build --compile`) ship without one.
 */
export const PACKAGE_VERSION = "0.5.2"
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

/** OpenCode 2.x plugin id, shown in `opencode plugin list`. */
export const PLUGIN_ID = "neuron"
/** OpenCode 2.x adapters. v2 moved the AI SDK adapters into its own package. */
export const PROVIDER_PACKAGE_V2 = "@opencode/ai/providers/openai-compatible"
export const RESPONSES_API_PACKAGE_V2 = "@opencode/ai/providers/openai"
/**
 * OpenCode 2.x requires `limit` on every model. These stand in when the proxy
 * reports nothing: 128k is the common context size today, and 32k output
 * matches the cap OpenCode 1.x applied on its own when the plugin omitted
 * `limit`.
 */
export const DEFAULT_CONTEXT_LIMIT = 128_000
export const DEFAULT_OUTPUT_LIMIT = 32_000
