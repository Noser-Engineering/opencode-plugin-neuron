import { describe, expect, it } from "vitest"
import { Host } from "@opencode/plugin/host"
import { fileURLToPath } from "node:url"
import { NeuronPlugin } from "../../src/plugin.js"
import entry from "../../src/v2.js"

describe("the ./server entry", () => {
  it("resolves a local plugin directory to the server entry", () => {
    const directory = fileURLToPath(new URL("../../", import.meta.url))
    const resolved = Host.resolve({ directory })
    expect(resolved.server).toBe(new URL("../../server.js", import.meta.url).href)
  })

  it("serves OpenCode 2 through setup and OpenCode 1 through server", () => {
    // OpenCode 1.16 to 1.18 resolve exports["./server"] for npm packages too
    // and insist on a server() function; 0.5.0 and 0.5.1 lacked it.
    expect(entry.id).toBe("neuron")
    expect(typeof entry.setup).toBe("function")
    expect(entry.server).toBe(NeuronPlugin)
  })
})
