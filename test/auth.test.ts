import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readStoredApiKeys, updateApiCredentials } from "../src/auth.js"

describe("OpenCode credentials", () => {
  it("merges profile keys and writes a private file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-neuron-"))
    const authPath = join(directory, "opencode", "auth.json")

    await updateApiCredentials({ "neuron-a": "key-a", "neuron-b": "key-b" }, [], authPath)
    await updateApiCredentials({ "neuron-a": "key-a-2" }, ["neuron-b"], authPath)

    expect(await readStoredApiKeys(authPath)).toEqual({ "neuron-a": "key-a-2" })
    expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({
      "neuron-a": { type: "api", key: "key-a-2" },
    })
    if (process.platform !== "win32") expect((await stat(authPath)).mode & 0o777).toBe(0o600)
  })
})
