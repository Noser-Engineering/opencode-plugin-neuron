import { describe, expect, it } from "vitest"
import { PACKAGE_VERSION } from "../src/constants.js"
import {
  detectConfigVersion,
  parseConfigText,
  parseOpenCodeVersion,
  PINNED_PACKAGE_SPEC,
  readNeuronConfigEntry,
  updateConfigText,
} from "../src/setup.js"

describe("OpenCode config setup", () => {
  it("preserves comments and unrelated plugins", () => {
    const original = `{
  // Keep this employee-specific plugin.
  "plugin": ["opencode-wakatime"],
  "share": "disabled",
}
`
    const updated = updateConfigText(original, [
      { id: "work", name: "Work", baseURL: "https://proxy.example/v1" },
    ])

    expect(updated).toContain("// Keep this employee-specific plugin.")
    const config = parseConfigText(updated)
    expect(config.$schema).toBe("https://opencode.ai/config.json")
    expect(config.plugin).toEqual([
      "opencode-wakatime",
      [
        PINNED_PACKAGE_SPEC,
        {
          profiles: [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }],
        },
      ],
    ])
  })

  it("pins the running version so OpenCode's plugin cache picks up updates", () => {
    expect(PINNED_PACKAGE_SPEC).toBe(`@noser-engineering/opencode-plugin-neuron@${PACKAGE_VERSION}`)
    expect(PACKAGE_VERSION).toMatch(/^\d+\.\d+\.\d+$/)
  })

  it("updates an existing entry without duplicating it, moving any old pin to the running version", () => {
    const original = JSON.stringify({
      plugin: [
        [
          "@noser-engineering/opencode-plugin-neuron@1.2.3",
          { timeoutMs: 10_000, profiles: [{ id: "old", name: "Old", baseURL: "https://old.example/v1" }] },
        ],
      ],
    })
    const updated = updateConfigText(original, [
      { id: "neuron-team", name: "Neuron Team", baseURL: "https://proxy.example/v1" },
    ])
    const entry = readNeuronConfigEntry(parseConfigText(updated))

    expect(entry).toEqual({
      packageSpec: PINNED_PACKAGE_SPEC,
      rawOptions: {
        timeoutMs: 10_000,
        profiles: [
          {
            id: "neuron-team",
            name: "Neuron Team",
            baseURL: "https://proxy.example/v1",
          },
        ],
      },
      profiles: [
        {
          id: "neuron-team",
          name: "Neuron Team",
          baseURL: "https://proxy.example/v1",
        },
      ],
    })
  })

  it("migrates the former unscoped package name", () => {
    const original = JSON.stringify({
      plugin: [
        [
          "opencode-plugin-neuron",
          {
            profiles: [
              { id: "legacy", name: "Legacy", baseURL: "https://proxy.example/v1", apiKeyEnv: "OLD_KEY" },
            ],
          },
        ],
      ],
    })

    const updated = parseConfigText(
      updateConfigText(original, [{ id: "legacy", name: "Legacy", baseURL: "https://proxy.example/v1" }]),
    )

    expect(updated.plugin).toEqual([
      [
        PINNED_PACKAGE_SPEC,
        {
          profiles: [{ id: "legacy", name: "Legacy", baseURL: "https://proxy.example/v1" }],
        },
      ],
    ])
  })
})

describe("OpenCode 2 config setup", () => {
  it("detects the major from the config shape", () => {
    expect(detectConfigVersion({ plugins: [] })).toBe(2)
    expect(detectConfigVersion({ providers: {} })).toBe(2)
    expect(detectConfigVersion({ permissions: [] })).toBe(2)
    expect(detectConfigVersion({ plugin: [] })).toBe(1)
    expect(detectConfigVersion({ provider: {} })).toBe(1)
    expect(detectConfigVersion({ share: "disabled" })).toBeUndefined()
    // A half-migrated file is treated as v2: that is where new entries go.
    expect(detectConfigVersion({ plugin: [], plugins: [] })).toBe(2)
  })

  it("parses the opencode --version output", () => {
    expect(parseOpenCodeVersion("opencode v2.0.22\n")).toBe(2)
    expect(parseOpenCodeVersion("1.18.30")).toBe(1)
    expect(parseOpenCodeVersion("3.1.0")).toBe(2)
    expect(parseOpenCodeVersion("0.0.0-beta-19271")).toBeUndefined()
    expect(parseOpenCodeVersion("")).toBeUndefined()
  })

  it("reads an existing v2 entry", () => {
    const entry = readNeuronConfigEntry({
      plugins: [
        "opencode-wakatime",
        {
          package: "@noser-engineering/opencode-plugin-neuron",
          options: { profiles: [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }], enforce: false },
        },
      ],
    })
    expect(entry).toEqual({
      packageSpec: "@noser-engineering/opencode-plugin-neuron",
      profiles: [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }],
      rawOptions: { profiles: [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }], enforce: false },
    })
  })

  it("writes an unpinned v2 entry and the two settings a v2 plugin cannot set", () => {
    const updated = updateConfigText("{}\n", [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }], "opencode.json", 2)
    const config = parseConfigText(updated)
    expect(config.plugins).toEqual([
      {
        package: "@noser-engineering/opencode-plugin-neuron",
        options: { profiles: [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }] },
      },
    ])
    expect(config.share).toBe("disabled")
    expect(config.update).toBe("notify")
    expect(config.$schema).toBe("https://opencode.ai/config.json")
    expect(config).not.toHaveProperty("plugin")
  })

  it("leaves share and update alone when the user set them", () => {
    const updated = updateConfigText(
      JSON.stringify({ share: "manual", update: "auto" }),
      [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }],
      "opencode.json",
      2,
    )
    const config = parseConfigText(updated)
    expect(config.share).toBe("manual")
    expect(config.update).toBe("auto")
  })

  it("replaces an existing v2 entry in place and keeps its other options", () => {
    const original = JSON.stringify({
      plugins: [
        "opencode-wakatime",
        { package: "@noser-engineering/opencode-plugin-neuron", options: { profiles: [{ id: "old", name: "Old", baseURL: "https://old.example/v1" }], denyProviders: ["anthropic"] } },
        "another",
      ],
    })
    const updated = updateConfigText(original, [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }], "opencode.json", 2)
    const config = parseConfigText(updated)
    expect(config.plugins).toEqual([
      "opencode-wakatime",
      {
        package: "@noser-engineering/opencode-plugin-neuron",
        options: { denyProviders: ["anthropic"], profiles: [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }] },
      },
      "another",
    ])
  })

  it("migrates a v1 entry into plugins and drops an emptied plugin array", () => {
    const original = `{
  // migrated from v1
  "plugin": [["@noser-engineering/opencode-plugin-neuron@0.4.1", { "profiles": [{ "id": "work", "name": "Work", "baseURL": "https://proxy.example/v1" }], "enforce": false }]],
  "plugins": ["opencode-wakatime"],
}
`
    const updated = updateConfigText(original, [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }], "opencode.jsonc", 2)
    expect(updated).toContain("// migrated from v1")
    const config = parseConfigText(updated)
    expect(config).not.toHaveProperty("plugin")
    expect(config.plugins).toEqual([
      "opencode-wakatime",
      {
        package: "@noser-engineering/opencode-plugin-neuron",
        options: { profiles: [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }], enforce: false },
      },
    ])
  })

  it("keeps unrelated v1 plugins when migrating only our entry", () => {
    const original = JSON.stringify({ plugin: ["opencode-wakatime", "@noser-engineering/opencode-plugin-neuron@0.4.1"] })
    const config = parseConfigText(updateConfigText(original, [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }], "opencode.json", 2))
    expect(config.plugin).toEqual(["opencode-wakatime"])
    expect(config.plugins).toHaveLength(1)
  })

  it("rejects a plugins value that is not an array", () => {
    expect(() => updateConfigText(JSON.stringify({ plugins: {} }), [], "opencode.json", 2)).toThrow("plugins must be an array")
  })
})
