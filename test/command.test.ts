import { describe, expect, it, vi } from "vitest"
import {
  API_KEY_ENV,
  chooseCredentialStore,
  configureProfile,
  parseArgs,
  resolveApiKey,
  resolveOpenCodeVersion,
  type DiscoverModels,
  type SetupState,
} from "../src/command.js"
import { OpenCodeNotFoundError } from "../src/credential-store.js"

class FakePrompts {
  readonly asked: string[] = []

  constructor(
    private readonly texts: string[] = [],
    private readonly secrets: string[] = [],
    private readonly confirms: boolean[] = [],
  ) {}

  async text(message: string, defaultValue?: string): Promise<string> {
    this.asked.push(message)
    return this.texts.shift() ?? defaultValue ?? ""
  }

  async secret(message: string): Promise<string> {
    this.asked.push(message)
    return this.secrets.shift() ?? ""
  }

  async confirm(message: string, defaultValue: boolean): Promise<boolean> {
    this.asked.push(message)
    return this.confirms.shift() ?? defaultValue
  }

  async select(message: string, _options: string[], defaultIndex = 0): Promise<number> {
    this.asked.push(message)
    return defaultIndex
  }
}

function emptyState(): SetupState {
  return {
    configPath: "opencode.jsonc",
    configText: "{}\n",
    profiles: [],
    version: 1,
    credentials: {
      description: "memory",
      read: async () => ({}),
      write: async () => undefined,
    },
    storedCredentials: {},
    credentialUpdates: {},
    credentialRemovals: new Set<string>(),
  }
}

const discoverOne: DiscoverModels = async () => [{ id: "model-a" }]

describe("parseArgs", () => {
  it("reads values in both --flag value and --flag=value form", () => {
    expect(parseArgs(["setup", "--global", "--name", "Neuron Arbeit", "--url", "https://p.example/v1", "--key", "sk-1"])).toEqual({
      help: false,
      keyStdin: false,
      scope: "global",
      name: "Neuron Arbeit",
      url: "https://p.example/v1",
      key: "sk-1",
    })
    expect(parseArgs(["--project", "--url=https://p.example/v1", "--key=sk-1"])).toMatchObject({
      scope: "project",
      url: "https://p.example/v1",
      key: "sk-1",
    })
  })

  it("keeps the interactive mode when --url is absent", () => {
    expect(parseArgs([])).toEqual({ help: false, keyStdin: false })
    expect(parseArgs(["--name", "Neuron"])).toEqual({ help: false, keyStdin: false, name: "Neuron" })
  })

  it("leaves the scope unset when --url is given without --global or --project", () => {
    const args = parseArgs(["--url", "https://p.example/v1"])
    expect(args.scope).toBeUndefined()
    expect(args.url).toBe("https://p.example/v1")
  })

  it("only allows --key-stdin together with --url", () => {
    expect(() => parseArgs(["--global", "--key-stdin"])).toThrow("--key-stdin requires --url")
    expect(parseArgs(["--global", "--url", "https://p.example/v1", "--key-stdin"])).toMatchObject({ keyStdin: true })
  })

  it("requires an explicit scope when --key-stdin is used", () => {
    expect(() => parseArgs(["--url", "https://p.example/v1", "--key-stdin"])).toThrow(
      "--key-stdin requires --global or --project",
    )
  })

  it("rejects contradicting and malformed input", () => {
    expect(() => parseArgs(["--global", "--project"])).toThrow("not both")
    expect(() => parseArgs(["--global", "--url", "https://p.example/v1", "--key", "sk-1", "--key-stdin"])).toThrow(
      "Choose either --key or --key-stdin",
    )
    expect(() => parseArgs(["--url"])).toThrow("--url requires a value")
    expect(() => parseArgs(["--url", "--global"])).toThrow("--url requires a value")
    expect(() => parseArgs(["--name=  "])).toThrow("--name requires a value")
    expect(() => parseArgs(["--global=yes"])).toThrow("--global does not take a value")
    expect(() => parseArgs(["--verbose"])).toThrow("Unknown option: --verbose")
    expect(() => parseArgs(["install"])).toThrow("Unknown command: install")
  })

  it("short-circuits on --help before validating the rest", () => {
    expect(parseArgs(["--help", "--url", "https://p.example/v1"]).help).toBe(true)
    expect(parseArgs(["-h"]).help).toBe(true)
  })
})

describe("configureProfile", () => {
  it("asks nothing but the URL when --name and a key are given", async () => {
    const prompts = new FakePrompts(["https://proxy.example/v1"])
    const state = emptyState()

    await configureProfile(
      prompts,
      state,
      { name: "Neuron Arbeit", apiKey: { key: "sk-1", origin: "--key" } },
      discoverOne,
    )

    expect(prompts.asked).toEqual(["LiteLLM base URL"])
    expect(state.profiles).toEqual([
      { id: "neuron-arbeit", name: "Neuron Arbeit", baseURL: "https://proxy.example/v1" },
    ])
    expect(state.credentialUpdates).toEqual({
      "neuron-arbeit": { key: "sk-1", baseURL: "https://proxy.example/v1" },
    })
  })

  it("still asks for name and key when no flags are given", async () => {
    const prompts = new FakePrompts(["Neuron", "https://proxy.example/v1"], ["sk-typed"])
    const state = emptyState()

    await configureProfile(prompts, state, {}, discoverOne)

    expect(prompts.asked).toEqual([
      "Profile display name",
      "LiteLLM base URL",
      "API key (leave blank to configure later)",
    ])
    expect(state.credentialUpdates["neuron"]?.key).toBe("sk-typed")
  })

  it("keeps a stored key that still belongs to the same URL", async () => {
    const prompts = new FakePrompts(["Neuron", "https://proxy.example/v1"], [""])
    const state = emptyState()
    state.storedCredentials["neuron"] = { key: "sk-stored", baseURL: "https://proxy.example/v1" }

    await configureProfile(prompts, state, {}, discoverOne)

    expect(prompts.asked).toContain("API key (leave blank to keep the stored key)")
    expect(state.credentialUpdates["neuron"]?.key).toBe("sk-stored")
  })

  it("gives up instead of looping forever on invalid URLs", async () => {
    const prompts = new FakePrompts(Array.from({ length: 8 }, () => "not-a-url"))

    await expect(configureProfile(prompts, emptyState(), { name: "Neuron" }, discoverOne)).rejects.toThrow(
      "No valid LiteLLM base URL was given",
    )
    expect(prompts.asked.length).toBeLessThanOrEqual(6)
  })
})

describe("resolveApiKey", () => {
  const base = { help: false, keyStdin: false }
  const noStdin = async () => {
    throw new Error("stdin must not be read")
  }

  it("prefers --key over the environment", async () => {
    expect(await resolveApiKey({ ...base, key: "sk-flag" }, { [API_KEY_ENV]: "sk-env" }, noStdin)).toEqual({
      key: "sk-flag",
      origin: "--key",
    })
  })

  it("falls back to the environment and ignores a blank value", async () => {
    expect(await resolveApiKey(base, { [API_KEY_ENV]: " sk-env " }, noStdin)).toEqual({
      key: "sk-env",
      origin: API_KEY_ENV,
    })
    expect(await resolveApiKey(base, { [API_KEY_ENV]: "  " }, noStdin)).toEqual({})
    expect(await resolveApiKey(base, {}, noStdin)).toEqual({})
  })

  it("reads stdin for --key-stdin and rejects empty input", async () => {
    expect(await resolveApiKey({ ...base, keyStdin: true }, {}, async () => "sk-piped")).toEqual({
      key: "sk-piped",
      origin: "stdin",
    })
    await expect(resolveApiKey({ ...base, keyStdin: true }, {}, async () => "")).rejects.toThrow("stdin was empty")
  })
})

describe("parseArgs --opencode-version", () => {
  it("accepts 1 and 2", () => {
    expect(parseArgs(["setup", "--opencode-version", "2"]).opencodeVersion).toBe(2)
    expect(parseArgs(["setup", "--opencode-version=1"]).opencodeVersion).toBe(1)
  })

  it("rejects anything else", () => {
    expect(() => parseArgs(["setup", "--opencode-version", "3"])).toThrow("--opencode-version must be 1 or 2")
    expect(() => parseArgs(["setup", "--opencode-version", "v2"])).toThrow("--opencode-version must be 1 or 2")
  })
})

describe("resolveOpenCodeVersion", () => {
  const noAsk = async (): Promise<1 | 2> => {
    throw new Error("should not ask")
  }

  it("prefers the flag", async () => {
    const binary = vi.fn(async () => "opencode v2.0.22")
    expect(await resolveOpenCodeVersion({ help: false, keyStdin: false, opencodeVersion: 1 }, { configVersion: 2, binaryOutput: binary, ask: noAsk })).toBe(1)
    expect(binary).not.toHaveBeenCalled()
  })

  it("then the config shape", async () => {
    expect(await resolveOpenCodeVersion({ help: false, keyStdin: false }, { configVersion: 1, binaryOutput: async () => "opencode v2.0.22", ask: noAsk })).toBe(1)
  })

  it("then the binary", async () => {
    expect(await resolveOpenCodeVersion({ help: false, keyStdin: false }, { binaryOutput: async () => "opencode v2.0.22", ask: noAsk })).toBe(2)
    expect(await resolveOpenCodeVersion({ help: false, keyStdin: false }, { binaryOutput: async () => "1.18.30", ask: noAsk })).toBe(1)
  })

  it("asks when nothing else knows", async () => {
    const ask = vi.fn(async (): Promise<1 | 2> => 2)
    expect(await resolveOpenCodeVersion({ help: false, keyStdin: false }, { binaryOutput: async () => undefined, ask })).toBe(2)
    expect(ask).toHaveBeenCalledTimes(1)
  })
})

describe("chooseCredentialStore", () => {
  it("uses auth.json for OpenCode 1 without probing the binary", async () => {
    const run = vi.fn()
    const store = await chooseCredentialStore(1, "/tmp/auth.json", run)
    expect(store.description).toBe("/tmp/auth.json")
    expect(run).not.toHaveBeenCalled()
  })

  it("uses the opencode CLI for OpenCode 2", async () => {
    const run = vi.fn(async () => JSON.stringify({ data: [] }))
    const store = await chooseCredentialStore(2, "/tmp/auth.json", run)
    expect(store.description).toContain("opencode api credential")
    expect(await store.read()).toEqual({})
  })

  it("falls back to auth.json when the binary is missing", async () => {
    const run = vi.fn(async () => {
      throw new OpenCodeNotFoundError()
    })
    const writes: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      const store = await chooseCredentialStore(2, "/tmp/auth.json", run)
      expect(store.description).toBe("/tmp/auth.json")
    } finally {
      process.stdout.write = original
    }
    expect(writes.join("")).toContain("imports auth.json only on its first start")
  })
})
