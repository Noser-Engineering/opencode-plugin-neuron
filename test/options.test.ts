import { describe, expect, it } from "vitest"
import { parsePluginOptions, slugifyProviderID, validateProfile } from "../src/options.js"

describe("profile validation", () => {
  it("normalizes configurable HTTPS proxy URLs", () => {
    expect(validateProfile({ id: "team", name: "Team", baseURL: "https://proxy.example/" })).toEqual({
      id: "team",
      name: "Team",
      baseURL: "https://proxy.example/v1",
    })
  })

  it("rejects clear-text remote proxy URLs", () => {
    expect(() => validateProfile({ id: "team", name: "Team", baseURL: "http://proxy.example/v1" })).toThrow(
      "must use https",
    )
    expect(validateProfile({ id: "local", name: "Local", baseURL: "http://localhost:4000" }).baseURL).toBe(
      "http://localhost:4000/v1",
    )
  })

  it("rejects unsafe provider keys and control characters", () => {
    expect(() => validateProfile({ id: "__proto__", name: "Neuron" })).toThrow("reserved")
    expect(() => validateProfile({ id: "neuron", name: "Neuron\u001b[2J" })).toThrow("control characters")
  })

  it("limits startup work from untrusted project configuration", () => {
    const result = parsePluginOptions({
      profiles: Array.from({ length: 25 }, (_, index) => ({
        id: `proxy-${index}`,
        name: `Proxy ${index}`,
        baseURL: "https://proxy.example/v1",
      })),
    })

    expect(result.profiles).toHaveLength(20)
    expect(result.errors).toContain("profiles is limited to 20 entries")
  })

  it("rejects project-selected API key environment variables", () => {
    expect(() => validateProfile({ id: "team", name: "Team", apiKeyEnv: "AWS_SECRET_ACCESS_KEY" })).toThrow(
      "apiKeyEnv is no longer supported",
    )
  })

  it("derives safe provider ids from display names", () => {
    expect(slugifyProviderID("My Team Proxy")).toBe("my-team-proxy")
    expect(slugifyProviderID("constructor")).toBe("litellm-constructor")
  })
})
