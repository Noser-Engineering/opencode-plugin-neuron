import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import {
  applyEdits,
  modify,
  parse,
  parseTree,
  printParseErrorCode,
  type FormattingOptions,
  type ParseError,
} from "jsonc-parser"
import { CONFIG_SCHEMA, PACKAGE_NAME, PACKAGE_VERSION } from "./constants.js"
import { parsePluginOptions } from "./options.js"
import type { NeuronProfile } from "./types.js"

export type ConfigScope = "global" | "project"

export type OpenCodeMajor = 1 | 2

const V2_KEYS = ["plugins", "providers", "permissions"] as const
const V1_KEYS = ["plugin", "provider", "permission"] as const

/**
 * Which major wrote this file. A file that already carries v2 keys is v2,
 * even if a v1 key is still around: new entries belong where OpenCode 2 reads
 * them, and the v1 leftover is migrated on write.
 */
export function detectConfigVersion(config: Record<string, unknown>): OpenCodeMajor | undefined {
  if (V2_KEYS.some((key) => config[key] !== undefined)) return 2
  if (V1_KEYS.some((key) => config[key] !== undefined)) return 1
  return undefined
}

/** `opencode --version` prints `opencode v2.0.22` (v2) or `1.18.30` (v1). */
export function parseOpenCodeVersion(output: string): OpenCodeMajor | undefined {
  const match = /(?:^|\D)(\d+)\.\d+\.\d+/.exec(output)
  if (!match) return undefined
  const major = Number(match[1])
  if (major === 0) return undefined
  return major >= 2 ? 2 : 1
}

export interface NeuronConfigEntry {
  profiles: NeuronProfile[]
  rawOptions: Record<string, unknown>
  packageSpec: string
}

// Recognized so an existing entry is migrated to the current name instead of
// being duplicated. "opencode-plugin-neuron" was the unscoped name up to 0.2.2.
const LEGACY_PACKAGE_NAMES = ["opencode-plugin-neuron"]

async function exists(filePath: string): Promise<boolean> {
  try {
    await access(filePath)
    return true
  } catch {
    return false
  }
}

async function firstExisting(candidates: string[]): Promise<string | undefined> {
  for (const candidate of candidates) {
    if (await exists(candidate)) return candidate
  }
  return undefined
}

export async function resolveConfigPath(
  scope: ConfigScope,
  cwd = process.cwd(),
  env: Record<string, string | undefined> = process.env,
  home = homedir(),
): Promise<string> {
  if (scope === "global") {
    if (env.OPENCODE_CONFIG) return env.OPENCODE_CONFIG
    const root = env.OPENCODE_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode")
    const candidates = ["opencode.jsonc", "opencode.json", "config.json"].map((name) => join(root, name))
    return (await firstExisting(candidates)) ?? candidates[0]!
  }

  const candidates = [
    join(cwd, "opencode.jsonc"),
    join(cwd, "opencode.json"),
    join(cwd, ".opencode", "opencode.jsonc"),
    join(cwd, ".opencode", "opencode.json"),
  ]
  return (await firstExisting(candidates)) ?? candidates[0]!
}

export async function readConfigText(filePath: string): Promise<string> {
  try {
    const text = await readFile(filePath, "utf8")
    return text.trim() ? text : "{}\n"
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return "{}\n"
    throw error
  }
}

export function parseConfigText(text: string, filePath = "opencode.jsonc"): Record<string, unknown> {
  const errors: ParseError[] = []
  const value: unknown = parse(text, errors, { allowTrailingComma: true, disallowComments: false })
  if (errors[0]) {
    throw new Error(`${filePath}: ${printParseErrorCode(errors[0].error)} at offset ${errors[0].offset}`)
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${filePath}: root config must be an object`)
  }
  return value as Record<string, unknown>
}

function isPackageSpec(value: string): boolean {
  return [PACKAGE_NAME, ...LEGACY_PACKAGE_NAMES].some(
    (packageName) => value === packageName || value.startsWith(`${packageName}@`),
  )
}

/**
 * The plugin entry setup writes, pinned to the version of the CLI that is
 * running. OpenCode installs a plugin spec into ~/.cache/opencode/packages
 * once and never updates it — even an explicit `@latest` stays at whatever
 * "latest" meant on first install. An exact version is the only spec it
 * treats as new when it changes, so every setup run moves the config to the
 * version the user just ran (npx fetches the latest by default).
 */
export const PINNED_PACKAGE_SPEC = `${PACKAGE_NAME}@${PACKAGE_VERSION}`

function removeLegacyApiKeyEnv(options: Record<string, unknown>): Record<string, unknown> {
  if (!Array.isArray(options.profiles)) return options
  return {
    ...options,
    profiles: options.profiles.map((profile) => {
      if (!profile || typeof profile !== "object" || Array.isArray(profile)) return profile
      const { apiKeyEnv: _apiKeyEnv, ...rest } = profile as Record<string, unknown>
      return rest
    }),
  }
}

function entryFromOptions(packageSpec: string, rawOptions: Record<string, unknown>): NeuronConfigEntry {
  const migratedOptions = removeLegacyApiKeyEnv(rawOptions)
  const parsed = parsePluginOptions(migratedOptions)
  if (parsed.errors.length) throw new Error(parsed.errors.join("; "))
  return { profiles: parsed.profiles, rawOptions: migratedOptions, packageSpec }
}

function isV2Entry(entry: unknown): entry is { package: string; options?: unknown } {
  return (
    !!entry &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    typeof (entry as { package?: unknown }).package === "string" &&
    isPackageSpec((entry as { package: string }).package)
  )
}

function isV1Entry(entry: unknown): boolean {
  if (typeof entry === "string") return isPackageSpec(entry)
  return Array.isArray(entry) && typeof entry[0] === "string" && isPackageSpec(entry[0])
}

function readV2Entry(config: Record<string, unknown>): NeuronConfigEntry | undefined {
  const plugins = config.plugins
  if (plugins === undefined) return undefined
  if (!Array.isArray(plugins)) throw new Error("plugins must be an array")
  for (const entry of plugins) {
    if (typeof entry === "string" && isPackageSpec(entry)) {
      const parsed = parsePluginOptions()
      return { profiles: parsed.profiles, rawOptions: {}, packageSpec: entry }
    }
    if (!isV2Entry(entry)) continue
    const rawOptions =
      entry.options && typeof entry.options === "object" && !Array.isArray(entry.options)
        ? (entry.options as Record<string, unknown>)
        : {}
    return entryFromOptions(entry.package, rawOptions)
  }
  return undefined
}

function readV1Entry(config: Record<string, unknown>): NeuronConfigEntry | undefined {
  const plugins = config.plugin
  if (plugins === undefined) return undefined
  if (!Array.isArray(plugins)) throw new Error("plugin must be an array")
  for (const entry of plugins) {
    if (typeof entry === "string" && isPackageSpec(entry)) {
      const parsed = parsePluginOptions()
      return { profiles: parsed.profiles, rawOptions: {}, packageSpec: entry }
    }
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || !isPackageSpec(entry[0])) continue
    const rawOptions =
      entry[1] && typeof entry[1] === "object" && !Array.isArray(entry[1])
        ? (entry[1] as Record<string, unknown>)
        : {}
    return entryFromOptions(entry[0], rawOptions)
  }
  return undefined
}

/** The plugin's entry from either config shape; v2 wins when both exist. */
export function readNeuronConfigEntry(config: Record<string, unknown>): NeuronConfigEntry | undefined {
  return readV2Entry(config) ?? readV1Entry(config)
}

function cleanProfile(profile: NeuronProfile): Record<string, string> {
  return {
    id: profile.id,
    name: profile.name,
    ...(profile.baseURL ? { baseURL: profile.baseURL } : {}),
  }
}

function updateConfigTextV1(text: string, profiles: NeuronProfile[], filePath: string): string {
  const config = parseConfigText(text, filePath)
  const existingEntry = readNeuronConfigEntry(config)
  const plugins = config.plugin === undefined ? [] : config.plugin
  if (!Array.isArray(plugins)) throw new Error(`${filePath}: plugin must be an array`)

  const filtered = plugins.filter((entry) => !isV1Entry(entry))
  const insertionIndex = plugins.findIndex((entry) => isV1Entry(entry))
  const pluginEntry = [
    PINNED_PACKAGE_SPEC,
    {
      ...existingEntry?.rawOptions,
      profiles: profiles.map(cleanProfile),
    },
  ]
  filtered.splice(insertionIndex >= 0 ? Math.min(insertionIndex, filtered.length) : filtered.length, 0, pluginEntry)

  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }
  let updated = text
  if (config.$schema === undefined) {
    updated = applyEdits(updated, modify(updated, ["$schema"], CONFIG_SCHEMA, { formattingOptions }))
  }
  updated = applyEdits(updated, modify(updated, ["plugin"], filtered, { formattingOptions }))
  return `${updated.trimEnd()}\n`
}

/**
 * Remove a top-level property while leaving comments around it alone;
 * `modify(..., undefined)` also swallows a comment that precedes the property.
 * Falls back to `modify` when a comment sits where a separating comma would go.
 */
function removeTopLevelProperty(text: string, key: string, formattingOptions: FormattingOptions): string {
  const root = parseTree(text, [], { allowTrailingComma: true })
  const property = root?.children?.find((child) => child.type === "property" && child.children?.[0]?.value === key)
  if (property) {
    let start = property.offset
    let end = property.offset + property.length
    while (start > 0 && (text[start - 1] === " " || text[start - 1] === "\t")) start--
    let after = end
    while (after < text.length && /\s/.test(text[after]!)) after++
    if (text[after] === ",") {
      end = after + 1
      while (end < text.length && (text[end] === " " || text[end] === "\t")) end++
      if (text[end] === "\n") end++
      else if (text[end] === "\r" && text[end + 1] === "\n") end += 2
      return text.slice(0, start) + text.slice(end)
    }
    let before = start
    while (before > 0 && /\s/.test(text[before - 1]!)) before--
    if (text[before - 1] === "{") return text.slice(0, before) + text.slice(end)
    if (text[before - 1] === ",") return text.slice(0, before - 1) + text.slice(end)
  }
  return applyEdits(text, modify(text, [key], undefined, { formattingOptions }))
}

function updateConfigTextV2(text: string, profiles: NeuronProfile[], filePath: string): string {
  const config = parseConfigText(text, filePath)
  const existingEntry = readNeuronConfigEntry(config)
  const plugins = config.plugins === undefined ? [] : config.plugins
  if (!Array.isArray(plugins)) throw new Error(`${filePath}: plugins must be an array`)

  const filtered = plugins.filter((entry) => !(typeof entry === "string" && isPackageSpec(entry)) && !isV2Entry(entry))
  const insertionIndex = plugins.findIndex((entry) => (typeof entry === "string" && isPackageSpec(entry)) || isV2Entry(entry))
  const pluginEntry = {
    package: PACKAGE_NAME,
    options: { ...existingEntry?.rawOptions, profiles: profiles.map(cleanProfile) },
  }
  filtered.splice(insertionIndex >= 0 ? Math.min(insertionIndex, filtered.length) : filtered.length, 0, pluginEntry)

  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }
  let updated = text
  const edit = (path: (string | number)[], value: unknown) => {
    updated = applyEdits(updated, modify(updated, path, value, { formattingOptions }))
  }
  if (config.$schema === undefined) edit(["$schema"], CONFIG_SCHEMA)
  edit(["plugins"], filtered)

  // Our v1 entry moves into `plugins`; other people's v1 entries stay where
  // OpenCode 2 still reads them (it accepts `plugin` with a warning).
  if (Array.isArray(config.plugin)) {
    const remaining = config.plugin.filter((entry) => !isV1Entry(entry))
    const movedOurs = remaining.length !== config.plugin.length
    if (movedOurs && remaining.length) edit(["plugin"], remaining)
    else if (movedOurs) updated = removeTopLevelProperty(updated, "plugin", formattingOptions)
  }

  // A v2 plugin cannot set these; writing them here is the only way to keep
  // the v1 guarantees. Only when absent: an explicit choice stays an explicit choice.
  if (config.share === undefined) edit(["share"], "disabled")
  if (config.update === undefined) edit(["update"], "notify")
  return `${updated.trimEnd()}\n`
}

export function updateConfigText(
  text: string,
  profiles: NeuronProfile[],
  filePath = "opencode.jsonc",
  version: OpenCodeMajor = 1,
): string {
  return version === 2 ? updateConfigTextV2(text, profiles, filePath) : updateConfigTextV1(text, profiles, filePath)
}

export async function writeConfigText(filePath: string, text: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true })
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporaryPath, text, "utf8")
    await rename(temporaryPath, filePath)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}
