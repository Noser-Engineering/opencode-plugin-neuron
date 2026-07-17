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
      { id: "neuron-work", name: "Neuron Work", baseURL: "https://neuron.noser.com/v1" },
    ])

    expect(updated).toContain("// Keep this employee-specific plugin.")
    const config = parseConfigText(updated)
    expect(config.$schema).toBe("https://opencode.ai/config.json")
    expect(config.plugin).toEqual([
      "opencode-wakatime",
      [
        "opencode-plugin-neuron",
        {
          profiles: [{ id: "neuron-work", name: "Neuron Work", baseURL: "https://neuron.noser.com/v1" }],
        },
      ],
    ])
  })

  it("updates an existing entry without duplicating it", () => {
    const original = JSON.stringify({
      plugin: [["opencode-plugin-neuron@1.2.3", { timeoutMs: 10_000, profiles: [{ id: "old", name: "Old" }] }]],
    })
    const updated = updateConfigText(original, [
      { id: "neuron-team", name: "Neuron Team", baseURL: "https://proxy.example/v1" },
    ])
    const entry = readNeuronConfigEntry(parseConfigText(updated))

    expect(entry).toEqual({
      packageSpec: "opencode-plugin-neuron@1.2.3",
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

  it("migrates the former private package name", () => {
    const original = JSON.stringify({
      plugin: [
        [
          "@noser/opencode-plugin-neuron",
          { profiles: [{ id: "neuron", name: "Neuron", apiKeyEnv: "NEURON_API_KEY" }] },
        ],
      ],
    })

    const updated = parseConfigText(
      updateConfigText(original, [{ id: "neuron", name: "Neuron", baseURL: "https://neuron.noser.com/v1" }]),
    )

    expect(updated.plugin).toEqual([
      [
        "opencode-plugin-neuron",
        {
          profiles: [{ id: "neuron", name: "Neuron", baseURL: "https://neuron.noser.com/v1" }],
        },
      ],
    ])
  })
})
