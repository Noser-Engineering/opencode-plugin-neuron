import { access, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { applyEdits, modify, parse, printParseErrorCode, type ParseError } from "jsonc-parser"
import { CONFIG_SCHEMA, PACKAGE_NAME } from "./constants.js"
import { parsePluginOptions } from "./options.js"
import type { NeuronProfile } from "./types.js"

export type ConfigScope = "global" | "project"

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

function isCurrentPackageSpec(value: string): boolean {
  return value === PACKAGE_NAME || value.startsWith(`${PACKAGE_NAME}@`)
}

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

export function readNeuronConfigEntry(config: Record<string, unknown>): NeuronConfigEntry | undefined {
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
    const migratedOptions = removeLegacyApiKeyEnv(rawOptions)
    const parsed = parsePluginOptions(migratedOptions)
    if (parsed.errors.length) throw new Error(parsed.errors.join("; "))
    return { profiles: parsed.profiles, rawOptions: migratedOptions, packageSpec: entry[0] }
  }
  return undefined
}

function cleanProfile(profile: NeuronProfile): Record<string, string> {
  return {
    id: profile.id,
    name: profile.name,
    ...(profile.baseURL ? { baseURL: profile.baseURL } : {}),
  }
}

export function updateConfigText(text: string, profiles: NeuronProfile[], filePath = "opencode.jsonc"): string {
  const config = parseConfigText(text, filePath)
  const existingEntry = readNeuronConfigEntry(config)
  const plugins = config.plugin === undefined ? [] : config.plugin
  if (!Array.isArray(plugins)) throw new Error(`${filePath}: plugin must be an array`)

  const filtered = plugins.filter((entry) => {
    if (typeof entry === "string") return !isPackageSpec(entry)
    return !(Array.isArray(entry) && typeof entry[0] === "string" && isPackageSpec(entry[0]))
  })
  const insertionIndex = plugins.findIndex((entry) => {
    if (typeof entry === "string") return isPackageSpec(entry)
    return Array.isArray(entry) && typeof entry[0] === "string" && isPackageSpec(entry[0])
  })
  const packageSpec =
    existingEntry && isCurrentPackageSpec(existingEntry.packageSpec) ? existingEntry.packageSpec : PACKAGE_NAME
  const pluginEntry = [
    packageSpec,
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
