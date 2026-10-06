import { describe, expect, it } from "vitest"
import { NeuronPlugin } from "../../src/plugin.js"
import entry from "../../src/v2.js"

describe("the ./server entry", () => {
  it("serves OpenCode 2 through setup and OpenCode 1 through server", () => {
    // OpenCode 1.16 to 1.18 resolve exports["./server"] for npm packages too
    // and insist on a server() function; 0.5.0 and 0.5.1 lacked it.
    expect(entry.id).toBe("neuron")
    expect(typeof entry.setup).toBe("function")
    expect(entry.server).toBe(NeuronPlugin)
  })
})
