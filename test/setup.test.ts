import { describe, expect, it } from "vitest"
import { parseConfigText, readNeuronConfigEntry, updateConfigText } from "../src/setup.js"

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
        "@noser-engineering/opencode-plugin-neuron",
        {
          profiles: [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }],
        },
      ],
    ])
  })

  it("updates an existing entry without duplicating it", () => {
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
      packageSpec: "@noser-engineering/opencode-plugin-neuron@1.2.3",
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
        "@noser-engineering/opencode-plugin-neuron",
        {
          profiles: [{ id: "legacy", name: "Legacy", baseURL: "https://proxy.example/v1" }],
        },
      ],
    ])
  })
})
