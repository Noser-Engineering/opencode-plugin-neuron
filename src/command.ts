import {
  extractApiCredentials,
  readAuthStore,
  resolveAuthPath,
  updateApiCredentials,
  type StoredApiCredential,
} from "./auth.js"
import { discoverModels } from "./discovery.js"
import { normalizeBaseURL, slugifyProviderID, validateProfile } from "./options.js"
import { Prompts } from "./prompts.js"
import {
  parseConfigText,
  readConfigText,
  readNeuronConfigEntry,
  resolveConfigPath,
  updateConfigText,
  writeConfigText,
  type ConfigScope,
} from "./setup.js"
import type { NeuronProfile } from "./types.js"

export const API_KEY_ENV = "NEURON_API_KEY"
const MAX_URL_ATTEMPTS = 5
const VALUE_FLAGS = new Set(["--name", "--url", "--key"])

export interface CliArgs {
  help: boolean
  keyStdin: boolean
  scope?: ConfigScope
  name?: string
  url?: string
  key?: string
}

export interface ApiKeySource {
  key?: string
  origin?: string
}

/** The part of {@link Prompts} the profile flow uses, so tests can drive it. */
export type PromptPort = Pick<Prompts, "text" | "secret" | "confirm">

export type DiscoverModels = typeof discoverModels

export function usage(): string {
  return `opencode-neuron setup [options]

Adds one or more named LiteLLM profiles to OpenCode. Without --url the setup is
interactive; every flag that is given skips its own question. Passing --url runs
without any prompt and therefore requires --global or --project.

Options:
  --global         Write the global OpenCode config
  --project        Write the config in the current project
  --name <name>    Profile display name; the provider ID is derived from it
  --url <url>      LiteLLM base URL; enables the non-interactive mode
  --key <key>      API key; visible in the shell history and in process lists
  --key-stdin      Read the API key from stdin; requires --url
  --help           Show this help

The API key can also be passed in ${API_KEY_ENV}, which avoids both the prompt
and the command line.

Examples:
  npx @noser-engineering/opencode-plugin-neuron setup --global
  npx @noser-engineering/opencode-plugin-neuron setup --global --name "Neuron Arbeit" \\
    --url https://litellm.example.com/v1 --key sk-123
  echo "$KEY" | npx @noser-engineering/opencode-plugin-neuron setup --global \\
    --url https://litellm.example.com/v1 --key-stdin`
}

export function parseArgs(argv: string[]): CliArgs {
  const args: CliArgs = { help: false, keyStdin: false }
  let global = false
  let project = false
  let command: string | undefined

  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index]!
    if (!argument.startsWith("-")) {
      if (command !== undefined) throw new Error(`Unexpected argument: ${argument}\n\n${usage()}`)
      command = argument
      continue
    }

    const separator = argument.indexOf("=")
    const flag = separator === -1 ? argument : argument.slice(0, separator)
    const inlineValue = separator === -1 ? undefined : argument.slice(separator + 1)

    if (VALUE_FLAGS.has(flag)) {
      const next = inlineValue ?? argv[index + 1]
      // A following token that looks like a flag means the value was forgotten.
      // Values that must start with "-" can still be passed as --flag=value.
      if (next === undefined || (inlineValue === undefined && next.startsWith("-"))) {
        throw new Error(`${flag} requires a value`)
      }
      const value = next.trim()
      if (!value) throw new Error(`${flag} requires a value`)
      if (inlineValue === undefined) index += 1
      if (flag === "--name") args.name = value
      else if (flag === "--url") args.url = value
      else args.key = value
      continue
    }

    if (inlineValue !== undefined) throw new Error(`${flag} does not take a value`)
    switch (flag) {
      case "--help":
      case "-h":
        args.help = true
        break
      case "--global":
        global = true
        break
      case "--project":
        project = true
        break
      case "--key-stdin":
        args.keyStdin = true
        break
      default:
        throw new Error(`Unknown option: ${flag}\n\n${usage()}`)
    }
  }

  if (args.help) return args
  if (command !== undefined && command !== "setup") throw new Error(`Unknown command: ${command}\n\n${usage()}`)
  if (global && project) throw new Error("Choose either --global or --project, not both")
  if (args.key && args.keyStdin) throw new Error("Choose either --key or --key-stdin, not both")
  if (global) args.scope = "global"
  else if (project) args.scope = "project"
  // Both restrictions keep the non-interactive mode free of hidden prompts: the
  // scope would have to be asked for, and reading stdin leaves nothing for the
  // prompts to read from.
  if (args.url && !args.scope) throw new Error("--url requires --global or --project")
  if (args.keyStdin && !args.url) throw new Error("--key-stdin requires --url")
  return args
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk as Buffer)
  return Buffer.concat(chunks).toString("utf8").trim()
}

export async function resolveApiKey(
  args: CliArgs,
  env: Record<string, string | undefined> = process.env,
  readInput: () => Promise<string> = readStdin,
): Promise<ApiKeySource> {
  if (args.key) return { key: args.key, origin: "--key" }
  if (args.keyStdin) {
    const key = await readInput()
    if (!key) throw new Error("--key-stdin was given but stdin was empty")
    return { key, origin: "stdin" }
  }
  const fromEnv = env[API_KEY_ENV]?.trim()
  if (fromEnv) return { key: fromEnv, origin: API_KEY_ENV }
  return {}
}

export interface SetupState {
  configPath: string
  configText: string
  profiles: NeuronProfile[]
  authPath: string
  storedCredentials: Record<string, StoredApiCredential>
  credentialUpdates: Record<string, StoredApiCredential>
  credentialRemovals: Set<string>
}

async function loadState(scope: ConfigScope): Promise<SetupState> {
  const configPath = await resolveConfigPath(scope)
  const configText = await readConfigText(configPath)
  const config = parseConfigText(configText, configPath)
  const authPath = resolveAuthPath()
  return {
    configPath,
    configText,
    profiles: [...(readNeuronConfigEntry(config)?.profiles ?? [])],
    authPath,
    storedCredentials: extractApiCredentials(await readAuthStore(authPath)),
    credentialUpdates: {},
    credentialRemovals: new Set<string>(),
  }
}

async function persist(state: SetupState): Promise<void> {
  await writeConfigText(state.configPath, updateConfigText(state.configText, state.profiles, state.configPath))
  if (Object.keys(state.credentialUpdates).length || state.credentialRemovals.size) {
    await updateApiCredentials(state.credentialUpdates, state.credentialRemovals, state.authPath)
  }
  const count = state.profiles.length
  process.stdout.write(`\n[ok] Configured ${count} LiteLLM profile${count === 1 ? "" : "s"}.\n`)
  process.stdout.write("Quit and restart OpenCode, then use /models to select a model.\n")
}

function defaultProfileName(profiles: NeuronProfile[]): string {
  return profiles.length ? `LiteLLM ${profiles.length + 1}` : "LiteLLM"
}

function replaceProfile(profiles: NeuronProfile[], profile: NeuronProfile): void {
  const index = profiles.findIndex((item) => item.id === profile.id)
  if (index === -1) profiles.push(profile)
  else profiles[index] = profile
}

function applyCredential(state: SetupState, providerID: string, key: string | undefined, baseURL: string): void {
  if (key) {
    const credential = { key, baseURL }
    state.credentialUpdates[providerID] = credential
    state.storedCredentials[providerID] = credential
    state.credentialRemovals.delete(providerID)
    return
  }
  if (state.storedCredentials[providerID]) {
    state.credentialRemovals.add(providerID)
    delete state.storedCredentials[providerID]
    delete state.credentialUpdates[providerID]
  }
}

// A stored key is only reusable while it still belongs to the same proxy URL.
function reusableStoredKey(state: SetupState, providerID: string, baseURL: string): string | undefined {
  const stored = state.storedCredentials[providerID]
  return stored && stored.baseURL === baseURL ? stored.key : undefined
}

// `fetch failed` from Node/undici hides the real reason (DNS, TLS, proxy,
// refused connection) one level down in `.cause`, sometimes nested further.
function describeError(error: unknown): string {
  if (!(error instanceof Error)) return String(error)
  const parts = [error.message]
  let cause = error.cause
  while (cause) {
    parts.push(cause instanceof Error ? cause.message : String(cause))
    cause = cause instanceof Error ? cause.cause : undefined
  }
  return parts.join(" -> ")
}

async function testConnection(
  profile: NeuronProfile,
  apiKey: string | undefined,
  discover: DiscoverModels,
): Promise<boolean> {
  if (!apiKey) return true
  try {
    const models = await discover(profile.baseURL!, apiKey, { timeoutMs: 5_000 })
    process.stdout.write(`[ok] ${models.length} model${models.length === 1 ? "" : "s"} available to this key.\n`)
    return true
  } catch (error) {
    process.stdout.write(`[error] ${describeError(error)}\n`)
    return false
  }
}

function parseBaseURL(input: string, flag: string): string {
  try {
    return normalizeBaseURL(input)
  } catch (error) {
    throw new Error(`${flag} is invalid: ${error instanceof Error ? error.message : String(error)}`)
  }
}

async function runNonInteractive(args: CliArgs, apiKey: ApiKeySource): Promise<void> {
  const state = await loadState(args.scope!)
  const name = args.name ?? defaultProfileName(state.profiles)
  const providerID = slugifyProviderID(name)
  const baseURL = parseBaseURL(args.url!, "--url")
  const profile = validateProfile({ id: providerID, name, baseURL })

  process.stdout.write(`\nConfig: ${state.configPath}\n`)
  const existing = state.profiles.find((item) => item.id === providerID)
  process.stdout.write(`${existing ? "Updating" : "Adding"} profile: ${profile.name} (${profile.id})\n`)

  const key = apiKey.key ?? reusableStoredKey(state, providerID, baseURL)
  if (apiKey.origin) process.stdout.write(`API key from ${apiKey.origin}.\n`)
  else if (key) process.stdout.write("Reusing the stored API key.\n")
  else process.stdout.write("[warn] No API key configured; requests will fail until one is set.\n")

  if (!(await testConnection(profile, key, discoverModels))) {
    throw new Error("Connection test failed; nothing was written")
  }
  replaceProfile(state.profiles, profile)
  applyCredential(state, providerID, key, baseURL)
  await persist(state)
}

export interface ProfileDefaults {
  name?: string
  apiKey?: ApiKeySource
}

export async function configureProfile(
  prompts: PromptPort,
  state: SetupState,
  defaults: ProfileDefaults,
  discover: DiscoverModels = discoverModels,
): Promise<void> {
  const name = defaults.name ?? (await prompts.text("Profile display name", defaultProfileName(state.profiles)))
  const providerID = slugifyProviderID(name)
  if (defaults.name) process.stdout.write(`Profile display name: ${name}\n`)
  process.stdout.write(`Provider ID: ${providerID} (used internally in model names)\n`)

  const existing = state.profiles.find((profile) => profile.id === providerID)
  if (existing && !(await prompts.confirm(`Replace existing profile "${existing.name}"?`, false))) return

  let baseURL = existing?.baseURL ?? ""
  for (let attempt = 1; ; attempt += 1) {
    try {
      baseURL = parseBaseURL(await prompts.text("LiteLLM base URL", baseURL), "The base URL")
      break
    } catch (error) {
      if (attempt >= MAX_URL_ATTEMPTS) throw new Error("No valid LiteLLM base URL was given")
      process.stdout.write(`${error instanceof Error ? error.message : String(error)}\n`)
    }
  }

  const storedKey = reusableStoredKey(state, providerID, baseURL)
  let key = defaults.apiKey?.key
  if (key) {
    process.stdout.write(`API key from ${defaults.apiKey?.origin}.\n`)
  } else {
    key =
      (await prompts.secret(
        storedKey ? "API key (leave blank to keep the stored key)" : "API key (leave blank to configure later)",
      )) || storedKey
  }

  const profile = validateProfile({ id: providerID, name, baseURL })
  const connected = await testConnection(profile, key, discover)
  if (!connected && !(await prompts.confirm("Save this profile anyway?", false))) return
  replaceProfile(state.profiles, profile)
  applyCredential(state, providerID, key, baseURL)
}

async function runInteractive(args: CliArgs, apiKey: ApiKeySource): Promise<void> {
  const prompts = new Prompts()
  try {
    const scope =
      args.scope ??
      ((await prompts.select("Where should the profile be configured?", ["Global config", "Current project"])) === 0
        ? "global"
        : "project")
    const state = await loadState(scope)

    process.stdout.write(`\nConfig: ${state.configPath}\n`)
    if (state.profiles.length) {
      process.stdout.write("Existing profiles:\n")
      state.profiles.forEach((profile) => process.stdout.write(`  - ${profile.name} (${profile.id})\n`))
    }

    // Flags describe a single profile, so they only prefill the first one.
    let defaults: ProfileDefaults = {
      ...(args.name ? { name: args.name } : {}),
      ...(apiKey.key ? { apiKey } : {}),
    }
    let addAnother = await prompts.confirm(
      state.profiles.length ? "Add or update a profile?" : "Configure a profile?",
      true,
    )
    while (addAnother) {
      await configureProfile(prompts, state, defaults)
      defaults = {}
      addAnother = await prompts.confirm("Configure another profile?", false)
    }

    if (!state.profiles.length) {
      process.stdout.write("No profiles configured; nothing was changed.\n")
      return
    }
    await persist(state)
  } finally {
    prompts.close()
  }
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const args = parseArgs(argv)
  if (args.help) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const apiKey = await resolveApiKey(args)
  if (args.url) await runNonInteractive(args, apiKey)
  else await runInteractive(args, apiKey)
}
