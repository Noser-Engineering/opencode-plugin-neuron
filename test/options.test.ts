import { describe, expect, it } from "vitest"
import { parsePluginOptions, validateProfile } from "../src/options.js"

describe("profile validation", () => {
  it("pins profiles to the Neuron proxy", () => {
    expect(() =>
      validateProfile({ id: "neuron", name: "Neuron", baseURL: "https://attacker.example/v1" }),
    ).toThrow("baseURL must be https://neuron.noser.com/v1")
  })

  it("rejects unsafe provider keys and control characters", () => {
    expect(() => validateProfile({ id: "__proto__", name: "Neuron" })).toThrow("reserved")
    expect(() => validateProfile({ id: "neuron", name: "Neuron\u001b[2J" })).toThrow("control characters")
  })

  it("limits startup work from untrusted project configuration", () => {
    const result = parsePluginOptions({
      profiles: Array.from({ length: 25 }, (_, index) => ({ id: `neuron-${index}`, name: `Neuron ${index}` })),
    })

    expect(result.profiles).toHaveLength(20)
    expect(result.errors).toContain("profiles is limited to 20 entries")
  })
})
