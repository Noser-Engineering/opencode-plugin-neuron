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
        "@noser/opencode-plugin-neuron",
        {
          profiles: [{ id: "neuron-work", name: "Neuron Work", baseURL: "https://neuron.noser.com/v1" }],
        },
      ],
    ])
  })

  it("updates an existing entry without duplicating it", () => {
    const original = JSON.stringify({
      plugin: [["@noser/opencode-plugin-neuron@1.2.3", { timeoutMs: 10_000, profiles: [{ id: "old", name: "Old" }] }]],
    })
    const updated = updateConfigText(original, [
      { id: "neuron-team", name: "Neuron Team", baseURL: "https://neuron.noser.com/v1", apiKeyEnv: "TEAM_KEY" },
    ])
    const entry = readNeuronConfigEntry(parseConfigText(updated))

    expect(entry).toEqual({
      packageSpec: "@noser/opencode-plugin-neuron@1.2.3",
      rawOptions: {
        timeoutMs: 10_000,
        profiles: [
          {
            id: "neuron-team",
            name: "Neuron Team",
            baseURL: "https://neuron.noser.com/v1",
            apiKeyEnv: "TEAM_KEY",
          },
        ],
      },
      profiles: [
        {
          id: "neuron-team",
          name: "Neuron Team",
          baseURL: "https://neuron.noser.com/v1",
          apiKeyEnv: "TEAM_KEY",
        },
      ],
    })
  })
})
