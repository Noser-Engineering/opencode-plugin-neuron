import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { configFileCandidates, readDeclaredProviderIDs } from "../../src/v2/declared.js"

async function scratch(): Promise<{ home: string; project: string }> {
  const root = await mkdtemp(join(tmpdir(), "neuron-declared-"))
  const home = join(root, "home")
  const project = join(root, "project")
  await mkdir(join(home, ".config", "opencode"), { recursive: true })
  await mkdir(join(project, ".opencode"), { recursive: true })
  return { home, project }
}

describe("configFileCandidates", () => {
  it("lists the global and project files OpenCode 2 reads, OPENCODE_CONFIG first", () => {
    expect(configFileCandidates("/proj", { OPENCODE_CONFIG: "/etc/oc.json" }, "/home/u")).toEqual([
      "/etc/oc.json",
      "/home/u/.config/opencode/opencode.json",
      "/home/u/.config/opencode/opencode.jsonc",
      "/proj/opencode.json",
      "/proj/opencode.jsonc",
      "/proj/.opencode/opencode.json",
      "/proj/.opencode/opencode.jsonc",
    ])
  })

  it("honours OPENCODE_CONFIG_DIR and XDG_CONFIG_HOME for the global directory", () => {
    expect(configFileCandidates("/proj", { OPENCODE_CONFIG_DIR: "/cfg" }, "/home/u")[0]).toBe("/cfg/opencode.json")
    expect(configFileCandidates("/proj", { XDG_CONFIG_HOME: "/xdg" }, "/home/u")[0]).toBe("/xdg/opencode/opencode.json")
  })
})

describe("readDeclaredProviderIDs", () => {
  it("collects provider ids from every config file, v2 and legacy key, with comments", async () => {
    const { home, project } = await scratch()
    await writeFile(
      join(home, ".config", "opencode", "opencode.json"),
      JSON.stringify({ providers: { opencode: {}, anthropic: { name: "A" } } }),
    )
    await writeFile(join(project, "opencode.jsonc"), `{\n  // project\n  "provider": { "github-copilot": {} },\n}\n`)
    await writeFile(join(project, ".opencode", "opencode.json"), JSON.stringify({ providers: { "custom-gw": {} } }))

    const declared = await readDeclaredProviderIDs(project, {}, home)

    expect([...declared].sort()).toEqual(["anthropic", "custom-gw", "github-copilot", "opencode"])
  })

  it("returns an empty set when no file exists", async () => {
    const { home, project } = await scratch()
    expect(await readDeclaredProviderIDs(project, {}, home)).toEqual(new Set())
  })

  it("ignores a file it cannot parse and a providers value that is not an object", async () => {
    const { home, project } = await scratch()
    await writeFile(join(project, "opencode.json"), "{ not json")
    await writeFile(join(project, ".opencode", "opencode.json"), JSON.stringify({ providers: ["opencode"] }))
    await writeFile(join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ providers: { opencode: {} } }))

    expect(await readDeclaredProviderIDs(project, {}, home)).toEqual(new Set(["opencode"]))
  })

  it("reads the file named by OPENCODE_CONFIG", async () => {
    const { home, project } = await scratch()
    const extra = join(project, "elsewhere.json")
    await writeFile(extra, JSON.stringify({ providers: { opencode: {} } }))

    expect(await readDeclaredProviderIDs(project, { OPENCODE_CONFIG: extra }, home)).toEqual(new Set(["opencode"]))
  })
})
