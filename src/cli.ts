#!/usr/bin/env node

import { Writable } from "node:stream"
import { createInterface, type Interface } from "node:readline/promises"
import { extractApiKeys, readAuthStore, resolveAuthPath, updateApiCredentials } from "./auth.js"
import { DEFAULT_BASE_URL } from "./constants.js"
import { discoverModels } from "./discovery.js"
import { defaultApiKeyEnv, slugifyProviderID, validateProfile } from "./options.js"
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

class MuteableOutput extends Writable {
  muted = false

  override _write(chunk: Buffer, encoding: BufferEncoding, callback: (error?: Error | null) => void): void {
    if (!this.muted) process.stdout.write(chunk, encoding)
    callback()
  }
}

class Prompts {
  private readonly output = new MuteableOutput()
  private readonly readline: Interface

  constructor() {
    this.readline = createInterface({ input: process.stdin, output: this.output, terminal: process.stdin.isTTY })
  }

  close(): void {
    this.readline.close()
  }

  async text(message: string, defaultValue?: string): Promise<string> {
    const suffix = defaultValue ? ` [${defaultValue}]` : ""
    const value = (await this.readline.question(`${message}${suffix}: `)).trim()
    return value || defaultValue || ""
  }

  async secret(message: string): Promise<string> {
    if (!process.stdin.isTTY) return (await this.readline.question(`${message}: `)).trim()
    process.stdout.write(`${message}: `)
    this.output.muted = true
    try {
      return (await this.readline.question("")).trim()
    } finally {
      this.output.muted = false
      process.stdout.write("\n")
    }
  }

  async confirm(message: string, defaultValue: boolean): Promise<boolean> {
    const hint = defaultValue ? "Y/n" : "y/N"
    while (true) {
      const answer = (await this.readline.question(`${message} [${hint}]: `)).trim().toLowerCase()
      if (!answer) return defaultValue
      if (answer === "y" || answer === "yes") return true
      if (answer === "n" || answer === "no") return false
      process.stdout.write("Enter y or n.\n")
    }
  }

  async select(message: string, options: string[], defaultIndex = 0): Promise<number> {
    process.stdout.write(`${message}\n`)
    options.forEach((option, index) => process.stdout.write(`  ${index + 1}. ${option}\n`))
    while (true) {
      const answer = await this.text("Choice", String(defaultIndex + 1))
      const selected = Number(answer) - 1
      if (Number.isInteger(selected) && selected >= 0 && selected < options.length) return selected
      process.stdout.write(`Enter a number from 1 to ${options.length}.\n`)
    }
  }
}

function usage(): string {
  return `opencode-neuron setup [--global | --project]

Interactively adds one or more named Neuron profiles to OpenCode.

Options:
  --global   Write the global OpenCode config (default when selected)
  --project  Write the config in the current project
  --help     Show this help`
}

function replaceProfile(profiles: NeuronProfile[], profile: NeuronProfile): void {
  const index = profiles.findIndex((item) => item.id === profile.id)
  if (index === -1) profiles.push(profile)
  else profiles[index] = profile
}

async function testConnection(profile: NeuronProfile, apiKey: string | undefined): Promise<boolean> {
  if (!apiKey) return true
  try {
    const models = await discoverModels(profile.baseURL!, apiKey, { timeoutMs: 5_000 })
    process.stdout.write(`[ok] ${models.length} model${models.length === 1 ? "" : "s"} available to this key.\n`)
    return true
  } catch (error) {
    process.stdout.write(`[error] ${error instanceof Error ? error.message : String(error)}\n`)
    return false
  }
}

async function configureProfile(
  prompts: Prompts,
  profiles: NeuronProfile[],
  storedKeys: Record<string, string>,
  credentialUpdates: Record<string, string>,
  credentialRemovals: Set<string>,
): Promise<void> {
  const name = await prompts.text("Profile display name", profiles.length ? `Neuron ${profiles.length + 1}` : "Neuron")
  let providerID = await prompts.text("Provider ID", slugifyProviderID(name))
  while (
    !/^[a-z0-9][a-z0-9._-]*$/.test(providerID) ||
    providerID.length > 64 ||
    ["__proto__", "constructor", "prototype"].includes(providerID)
  ) {
    process.stdout.write("Use up to 64 lowercase letters, numbers, dots, underscores, or hyphens.\n")
    providerID = await prompts.text("Provider ID", slugifyProviderID(name))
  }

  const existing = profiles.find((profile) => profile.id === providerID)
  if (existing && !(await prompts.confirm(`Replace existing profile \"${existing.name}\"?`, false))) return

  const authMethod = await prompts.select("Authentication", [
    "Store an API key in OpenCode credentials (recommended)",
    "Read the API key from an environment variable",
  ])

  let apiKeyEnv: string | undefined
  let keyForTest: string | undefined
  let enteredKey: string | undefined
  if (authMethod === 0) {
    const hasStoredKey = Boolean(storedKeys[providerID])
    const key = await prompts.secret(
      hasStoredKey ? "API key (leave blank to keep the stored key)" : "API key (leave blank to configure later)",
    )
    if (key) {
      enteredKey = key
      keyForTest = key
    } else {
      keyForTest = storedKeys[providerID]
    }
  } else {
    apiKeyEnv = await prompts.text("Environment variable", existing?.apiKeyEnv ?? defaultApiKeyEnv(providerID))
    while (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(apiKeyEnv)) {
      process.stdout.write("Enter a valid environment variable name.\n")
      apiKeyEnv = await prompts.text("Environment variable", defaultApiKeyEnv(providerID))
    }
    keyForTest = process.env[apiKeyEnv]
    if (!keyForTest) process.stdout.write(`Connection test skipped because ${apiKeyEnv} is not set.\n`)
  }

  const profile = validateProfile({
    id: providerID,
    name,
    baseURL: DEFAULT_BASE_URL,
    ...(apiKeyEnv ? { apiKeyEnv } : {}),
  })
  const connected = await testConnection(profile, keyForTest)
  if (!connected && !(await prompts.confirm("Save this profile anyway?", false))) return
  replaceProfile(profiles, profile)
  if (authMethod === 0) {
    if (enteredKey) credentialUpdates[providerID] = enteredKey
    credentialRemovals.delete(providerID)
  } else {
    credentialRemovals.add(providerID)
    delete credentialUpdates[providerID]
  }
}

async function runSetup(scopeFlag?: ConfigScope): Promise<void> {
  const prompts = new Prompts()
  try {
    const scope =
      scopeFlag ??
      ((await prompts.select("Where should the profile be configured?", ["Global config", "Current project"])) === 0
        ? "global"
        : "project")
    const configPath = await resolveConfigPath(scope)
    const configText = await readConfigText(configPath)
    const config = parseConfigText(configText, configPath)
    const profiles = [...(readNeuronConfigEntry(config)?.profiles ?? [])]
    const authPath = resolveAuthPath()
    const storedKeys = extractApiKeys(await readAuthStore(authPath))
    const credentialUpdates: Record<string, string> = {}
    const credentialRemovals = new Set<string>()

    process.stdout.write(`\nConfig: ${configPath}\n`)
    if (profiles.length) {
      process.stdout.write("Existing profiles:\n")
      profiles.forEach((profile) => process.stdout.write(`  - ${profile.name} (${profile.id})\n`))
    }

    let addAnother = await prompts.confirm(profiles.length ? "Add or update a profile?" : "Configure a profile?", true)
    while (addAnother) {
      await configureProfile(prompts, profiles, storedKeys, credentialUpdates, credentialRemovals)
      addAnother = await prompts.confirm("Configure another profile?", false)
    }

    if (!profiles.length) {
      process.stdout.write("No profiles configured; nothing was changed.\n")
      return
    }

    await writeConfigText(configPath, updateConfigText(configText, profiles, configPath))
    if (Object.keys(credentialUpdates).length || credentialRemovals.size) {
      await updateApiCredentials(credentialUpdates, credentialRemovals, authPath)
    }

    process.stdout.write(`\n[ok] Configured ${profiles.length} Neuron profile${profiles.length === 1 ? "" : "s"}.\n`)
    process.stdout.write("Quit and restart OpenCode, then use /models to select a model.\n")
  } finally {
    prompts.close()
  }
}

async function main(): Promise<void> {
  const args = process.argv.slice(2)
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage()}\n`)
    return
  }
  const command = args.find((arg) => !arg.startsWith("-"))
  if (command && command !== "setup") throw new Error(`Unknown command: ${command}\n\n${usage()}`)
  if (args.includes("--global") && args.includes("--project")) {
    throw new Error("Choose either --global or --project, not both")
  }
  const scope = args.includes("--global") ? "global" : args.includes("--project") ? "project" : undefined
  await runSetup(scope)
}

main().catch((error) => {
  process.stderr.write(`[error] ${error instanceof Error ? error.message : String(error)}\n`)
  process.exitCode = 1
})
