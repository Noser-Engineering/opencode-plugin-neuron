import { DEFAULT_BASE_URL, DEFAULT_TIMEOUT_MS } from "./constants.js"
import type { NeuronPluginOptions, NeuronProfile, ParsedPluginOptions } from "./types.js"

const PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9._-]*$/
const UNSAFE_OBJECT_KEYS = new Set(["__proto__", "constructor", "prototype"])
const MAX_PROFILES = 20

export function normalizeBaseURL(input: string): string {
  const url = new URL(input)
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("baseURL must use http or https")
  }
  if (url.username || url.password) {
    throw new Error("baseURL must not contain credentials")
  }
  const localHostnames = new Set(["localhost", "127.0.0.1", "[::1]"])
  if (url.protocol === "http:" && !localHostnames.has(url.hostname)) {
    throw new Error("baseURL must use https unless it points to localhost")
  }

  url.search = ""
  url.hash = ""
  let pathname = url.pathname.replace(/\/+$/, "")
  if (!pathname.endsWith("/v1")) pathname += "/v1"
  url.pathname = pathname
  return url.toString().replace(/\/$/, "")
}

export function validateProfile(input: unknown, index = 0): NeuronProfile {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new Error(`profiles[${index}] must be an object`)
  }

  const value = input as Record<string, unknown>
  const id = typeof value.id === "string" ? value.id.trim() : ""
  const name = typeof value.name === "string" ? value.name.trim() : ""
  if (UNSAFE_OBJECT_KEYS.has(id)) throw new Error(`profiles[${index}].id is reserved`)
  if (!PROVIDER_ID_PATTERN.test(id)) {
    throw new Error(`profiles[${index}].id must match ${PROVIDER_ID_PATTERN}`)
  }
  if (id.length > 64) throw new Error(`profiles[${index}].id must be 64 characters or fewer`)
  if (!name) throw new Error(`profiles[${index}].name is required`)
  if (name.length > 100) throw new Error(`profiles[${index}].name must be 100 characters or fewer`)
  if (/[\u0000-\u001f\u007f]/.test(name)) throw new Error(`profiles[${index}].name contains control characters`)
  if (value.apiKeyEnv !== undefined) {
    throw new Error(`profiles[${index}].apiKeyEnv is no longer supported; run the setup command again`)
  }

  const baseURL = normalizeBaseURL(typeof value.baseURL === "string" ? value.baseURL : DEFAULT_BASE_URL)

  return {
    id,
    name,
    baseURL,
  }
}

export function parsePluginOptions(input?: Record<string, unknown>): ParsedPluginOptions {
  const value = (input ?? {}) as NeuronPluginOptions
  const rawProfiles = value.profiles ?? [{ id: "neuron", name: "Neuron", baseURL: DEFAULT_BASE_URL }]
  const profiles: NeuronProfile[] = []
  const errors: string[] = []
  const ids = new Set<string>()

  if (!Array.isArray(rawProfiles)) {
    errors.push("profiles must be an array")
  } else {
    if (rawProfiles.length > MAX_PROFILES) errors.push(`profiles is limited to ${MAX_PROFILES} entries`)
    rawProfiles.slice(0, MAX_PROFILES).forEach((profile, index) => {
      try {
        const parsed = validateProfile(profile, index)
        if (ids.has(parsed.id)) {
          errors.push(`profiles contains duplicate provider id \"${parsed.id}\"`)
          return
        }
        ids.add(parsed.id)
        profiles.push(parsed)
      } catch (error) {
        errors.push(error instanceof Error ? error.message : String(error))
      }
    })
  }

  const timeoutMs =
    typeof value.timeoutMs === "number" && Number.isFinite(value.timeoutMs)
      ? Math.min(Math.max(Math.round(value.timeoutMs), 1_000), 30_000)
      : DEFAULT_TIMEOUT_MS

  return { profiles, timeoutMs, errors }
}

export function slugifyProviderID(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  return slug || "neuron"
}
