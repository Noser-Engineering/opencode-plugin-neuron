import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it, vi } from "vitest"

const execFileMock = vi.hoisted(() => vi.fn())
vi.mock("node:child_process", () => ({ execFile: execFileMock }))

import {
  fileCredentialStore,
  OpenCodeNotFoundError,
  opencodeCredentialStore,
  resolveOpenCodeExecutable,
  runOpenCodeBinary,
  type RunOpenCode,
} from "../src/credential-store.js"

describe("fileCredentialStore", () => {
  it("round-trips through auth.json", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neuron-store-"))
    const store = fileCredentialStore(join(dir, "auth.json"))
    await store.write({ work: { key: "sk-1", baseURL: "https://proxy.example/v1" } }, [])
    expect(await store.read()).toEqual({ work: { key: "sk-1", baseURL: "https://proxy.example/v1" } })
    const raw = JSON.parse(await readFile(join(dir, "auth.json"), "utf8"))
    expect(raw.work).toEqual({ type: "api", key: "sk-1", metadata: { baseURL: "https://proxy.example/v1" } })
  })
})

describe("opencodeCredentialStore", () => {
  const existing = [
    { id: "cred_1", integrationID: "work", label: "Neuron (Work)", active: true, value: { type: "key", key: "sk-old", metadata: { baseURL: "https://proxy.example/v1" } } },
    { id: "cred_2", integrationID: "github", label: "OAuth", active: true, value: { type: "oauth", access: "x" } },
    { id: "cred_3", integrationID: "env-only", label: "k", active: true, value: { type: "key", key: "sk-env" } },
  ]

  function fakeRun(): RunOpenCode & { calls: Array<{ args: string[]; stdin?: string }> } {
    const calls: Array<{ args: string[]; stdin?: string }> = []
    const run = (async (args: string[], stdin?: string) => {
      calls.push(stdin === undefined ? { args } : { args, stdin })
      if (args[0] === "api" && args[1] === "credential.list") return JSON.stringify({ data: existing })
      return JSON.stringify({ data: {} })
    }) as RunOpenCode & { calls: typeof calls }
    run.calls = calls
    return run
  }

  it("reads only key credentials, keyed by integration, with their baseURL", async () => {
    const run = fakeRun()
    expect(await opencodeCredentialStore(run).read()).toEqual({
      work: { key: "sk-old", baseURL: "https://proxy.example/v1" },
      "env-only": { key: "sk-env" },
    })
    expect(run.calls).toEqual([{ args: ["api", "credential.list", "--standalone"] }])
  })

  it("prefers the active credential over an inactive leftover", async () => {
    const listing = [
      { id: "cred_a", integrationID: "work", active: false, value: { type: "key", key: "sk-old" } },
      { id: "cred_b", integrationID: "work", active: true, value: { type: "key", key: "sk-new" } },
    ]
    const run: RunOpenCode = async () => JSON.stringify({ data: listing })
    expect(await opencodeCredentialStore(run).read()).toEqual({ work: { key: "sk-new" } })
  })

  it("creates the new active credential first, then removes the old ones", async () => {
    const run = fakeRun()
    await opencodeCredentialStore(run).write({ work: { key: "sk-new", baseURL: "https://proxy.example/v1" } }, [])
    expect(run.calls.slice(1)).toEqual([
      {
        args: [
          "api",
          "credential.create",
          "--standalone",
          "-d",
          JSON.stringify({
            integrationID: "work",
            label: "Neuron (work)",
            value: { type: "key", key: "sk-new", metadata: { baseURL: "https://proxy.example/v1" } },
            activate: true,
          }),
        ],
      },
      { args: ["api", "credential.remove", "--standalone", "--param", "credentialID=cred_1"] },
    ])
  })

  it("removes credentials for cleared profiles and nothing else", async () => {
    const run = fakeRun()
    await opencodeCredentialStore(run).write({}, ["work", "unknown"])
    expect(run.calls.slice(1)).toEqual([
      { args: ["api", "credential.remove", "--standalone", "--param", "credentialID=cred_1"] },
    ])
  })

  it("does not call the binary when there is nothing to write", async () => {
    const run = fakeRun()
    await opencodeCredentialStore(run).write({}, [])
    expect(run.calls).toEqual([])
  })

  it("uses the label callback", async () => {
    const run = fakeRun()
    await opencodeCredentialStore(run, (id) => `Neuron ${id.toUpperCase()}`).write({ other: { key: "k" } }, [])
    const create = run.calls.find((c) => c.args[1] === "credential.create")!
    expect(JSON.parse(create.args[4]!)).toMatchObject({ integrationID: "other", label: "Neuron OTHER", value: { type: "key", key: "k" } })
  })

  it("fails loudly on unparseable output", async () => {
    const run: RunOpenCode = async () => "not json"
    await expect(opencodeCredentialStore(run).read()).rejects.toThrow("opencode api credential.list returned invalid JSON")
  })
})

describe("runOpenCodeBinary", () => {
  beforeEach(() => {
    execFileMock.mockReset()
  })

  const stubExec = (error: unknown, stdout: string, stderr: string) =>
    execFileMock.mockImplementation((_cmd, _args, _opts, cb) => {
      cb(error, stdout, stderr)
      return { stdin: { end: vi.fn() } }
    })

  it("maps ENOENT to OpenCodeNotFoundError", async () => {
    stubExec(Object.assign(new Error("spawn opencode ENOENT"), { code: "ENOENT" }), "", "")
    await expect(runOpenCodeBinary(["api", "credential.list"])).rejects.toBeInstanceOf(OpenCodeNotFoundError)
  })

  it("maps spawn-level errors such as EINVAL to OpenCodeNotFoundError", async () => {
    stubExec(Object.assign(new Error("spawn EINVAL"), { code: "EINVAL" }), "", "")
    const error = await runOpenCodeBinary(["api", "credential.list"]).catch((e: Error) => e)
    expect(error).toBeInstanceOf(OpenCodeNotFoundError)
    expect((error as Error).message).toBe("The opencode binary could not be run (EINVAL)")
  })

  it("never leaks argv or the API key into the error", async () => {
    const args = ["api", "credential.create", "--standalone", "-d", JSON.stringify({ value: { key: "sk-secret" } })]
    stubExec(Object.assign(new Error(`Command failed: opencode ${args.join(" ")}`), { code: 1 }), "", "")
    const error = await runOpenCodeBinary(args).catch((e: Error) => e)
    expect((error as Error).message).toBe("opencode api credential.create failed (exit 1)")
    expect((error as Error).message).not.toContain("sk-secret")
  })

  it("appends stderr when present", async () => {
    stubExec(Object.assign(new Error("x"), { code: 2 }), "", " boom \n")
    await expect(runOpenCodeBinary(["api", "credential.list"])).rejects.toThrow(
      "opencode api credential.list failed (exit 2): boom",
    )
  })

  it("resolves stdout on success", async () => {
    stubExec(null, "out", "")
    await expect(runOpenCodeBinary(["api", "credential.list"])).resolves.toBe("out")
  })

  it("maps synchronous spawn errors without leaking argv", async () => {
    execFileMock.mockImplementation(() => {
      throw Object.assign(new Error('args[5] contains a cmd.exe special character: {"key":"sk-secret"}'), {
        code: "ERR_INVALID_ARG_VALUE",
      })
    })
    const error = await runOpenCodeBinary(["api", "credential.create", "-d", '{"key":"sk-secret"}']).catch((e: Error) => e)
    expect(error).toBeInstanceOf(OpenCodeNotFoundError)
    expect((error as Error).message).not.toContain("sk-secret")
  })
})

describe("resolveOpenCodeExecutable", () => {
  const win = (path: string | undefined, appData?: string) =>
    resolveOpenCodeExecutable({ platform: "win32", path, appData, arch: "x64" })

  async function desktopCli(versions: string[]): Promise<{ appData: string; exe: (name: string) => string }> {
    const appData = await mkdtemp(join(tmpdir(), "neuron-appdata-"))
    const exe = (name: string) => join(appData, "ai.opencode.desktop", "cli", name, "opencode-cli.exe")
    for (const name of versions) {
      await mkdir(join(appData, "ai.opencode.desktop", "cli", name), { recursive: true })
      await writeFile(exe(name), "")
    }
    return { appData, exe }
  }

  it("uses the bare name outside Windows", async () => {
    expect(await resolveOpenCodeExecutable({ platform: "linux", path: "/usr/bin" })).toBe("opencode")
  })

  it("prefers opencode.exe on PATH", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neuron-path-"))
    await writeFile(join(dir, "opencode.exe"), "")
    const { appData } = await desktopCli(["2.0.29-x64"])
    expect(await win(`C:\\nowhere;${dir}`, appData)).toBe(join(dir, "opencode.exe"))
  })

  it("falls back to the newest CLI bundled with OpenCode Desktop for this architecture", async () => {
    const { appData, exe } = await desktopCli(["2.0.9-x64", "2.0.29-x64", "2.1.0-arm64"])
    expect(await win("", appData)).toBe(exe("2.0.29-x64"))
  })

  it("skips a Desktop CLI directory without the executable", async () => {
    const { appData, exe } = await desktopCli(["2.0.20-x64"])
    await mkdir(join(appData, "ai.opencode.desktop", "cli", "2.0.30-x64"), { recursive: true })
    expect(await win("", appData)).toBe(exe("2.0.20-x64"))
  })

  it("looks through the npm .cmd shim to the real executable", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neuron-path-"))
    const exe = join(dir, "node_modules", "@opencode", "cli", "bin", "opencode.exe")
    await mkdir(join(dir, "node_modules", "@opencode", "cli", "bin"), { recursive: true })
    await writeFile(exe, "")
    await writeFile(
      join(dir, "opencode.cmd"),
      '@ECHO off\r\nCALL :find_dp0\r\n"%dp0%\\node_modules\\@opencode\\cli\\bin\\opencode.exe"   %*\r\n',
    )
    expect(await win(dir, undefined)).toBe(exe)
  })

  it("falls back to the bare name when nothing usable is found", async () => {
    const dir = await mkdtemp(join(tmpdir(), "neuron-path-"))
    await writeFile(join(dir, "opencode.cmd"), "@ECHO off\r\nnode something.js %*\r\n")
    const appData = await mkdtemp(join(tmpdir(), "neuron-appdata-"))
    expect(await win(dir, appData)).toBe("opencode")
  })
})
