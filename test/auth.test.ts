import { mkdtemp, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { readStoredApiCredentials, updateApiCredentials } from "../src/auth.js"

describe("OpenCode credentials", () => {
  it("merges profile keys and writes a private file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "opencode-neuron-"))
    const authPath = join(directory, "opencode", "auth.json")

    await updateApiCredentials(
      {
        "neuron-a": { key: "key-a", baseURL: "https://proxy-a.example/v1" },
        "neuron-b": { key: "key-b", baseURL: "https://proxy-b.example/v1" },
      },
      [],
      authPath,
    )
    await updateApiCredentials(
      { "neuron-a": { key: "key-a-2", baseURL: "https://proxy-a.example/v1" } },
      ["neuron-b"],
      authPath,
    )

    expect(await readStoredApiCredentials(authPath)).toEqual({
      "neuron-a": { key: "key-a-2", baseURL: "https://proxy-a.example/v1" },
    })
    expect(JSON.parse(await readFile(authPath, "utf8"))).toEqual({
      "neuron-a": {
        type: "api",
        key: "key-a-2",
        metadata: { baseURL: "https://proxy-a.example/v1" },
      },
    })
    if (process.platform !== "win32") expect((await stat(authPath)).mode & 0o777).toBe(0o600)
  })
})
