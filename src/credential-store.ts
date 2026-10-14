import { execFile } from "node:child_process"
import { readdir, readFile, stat } from "node:fs/promises"
import { join } from "node:path"
import { extractApiCredentials, readAuthStore, updateApiCredentials, type StoredApiCredential } from "./auth.js"

/**
 * Where API keys live. OpenCode 1 reads `auth.json`; OpenCode 2 keeps
 * credentials in its SQLite database and only imports `auth.json` once, on
 * the first start after upgrading. The setup CLI picks the store that matches
 * the installed major and falls back to the file when no binary is around.
 */
export interface CredentialStore {
  /** Where keys end up, for the setup summary. */
  readonly description: string
  read(): Promise<Record<string, StoredApiCredential>>
  write(updates: Record<string, StoredApiCredential>, removals: Iterable<string>): Promise<void>
}

/** Runs the `opencode` binary; resolves stdout, rejects on a non-zero exit. */
export type RunOpenCode = (args: string[], stdin?: string) => Promise<string>

export class OpenCodeNotFoundError extends Error {
  constructor(code?: string) {
    super(
      code && code !== "ENOENT"
        ? `The opencode binary could not be run (${code})`
        : "The opencode binary was not found on PATH or in OpenCode Desktop",
    )
    this.name = "OpenCodeNotFoundError"
  }
}

const NPM_SHIM_TARGET = /"%~?dp0%?\\?([^"%]*\\opencode\.exe)"/i

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

function compareVersions(a: string, b: string): number {
  const pa = a.split(".").map(Number)
  const pb = b.split(".").map(Number)
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const diff = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (diff) return diff
  }
  return 0
}

/**
 * OpenCode Desktop 2 on Windows ships its own CLI under
 * `%APPDATA%\ai.opencode.desktop\cli\<version>-<arch>\opencode-cli.exe` and
 * does not put it on PATH. Picks the newest version, preferring the current
 * architecture.
 */
async function findDesktopCli(appData: string | undefined, arch: string): Promise<string | undefined> {
  if (!appData) return undefined
  const root = join(appData, "ai.opencode.desktop", "cli")
  const entries = await readdir(root).catch(() => [] as string[])
  const candidates = entries
    .map((name) => ({ name, match: /^(\d+(?:\.\d+)*)-(.+)$/.exec(name) }))
    .filter((entry): entry is { name: string; match: RegExpExecArray } => entry.match !== null)
    .sort((a, b) => {
      const archDiff = Number(b.match[2] === arch) - Number(a.match[2] === arch)
      return archDiff || compareVersions(b.match[1]!, a.match[1]!)
    })
  for (const { name } of candidates) {
    const exe = join(root, name, "opencode-cli.exe")
    if (await isFile(exe)) return exe
  }
  return undefined
}

export interface ExecutableLookup {
  platform?: NodeJS.Platform
  path?: string
  appData?: string
  arch?: string
}

/**
 * On Windows `opencode` is often an npm `.cmd` shim. Neither Node nor Bun can
 * pass a JSON body to a batch file safely, so resolve the real `opencode.exe`
 * from PATH, looking through npm shims to the executable they forward to.
 * Without one on PATH, falls back to the CLI bundled with OpenCode Desktop.
 */
export async function resolveOpenCodeExecutable(lookup: ExecutableLookup = {}): Promise<string> {
  const platform = lookup.platform ?? process.platform
  if (platform !== "win32") return "opencode"
  const pathValue = "path" in lookup ? lookup.path : (process.env.PATH ?? process.env.Path)
  for (const dir of (pathValue ?? "").split(";").filter(Boolean)) {
    const exe = join(dir, "opencode.exe")
    if (await isFile(exe)) return exe
    for (const shim of ["opencode.cmd", "opencode.bat"]) {
      const text = await readFile(join(dir, shim), "utf8").catch(() => undefined)
      const target = text?.match(NPM_SHIM_TARGET)?.[1]
      if (!target) continue
      const resolved = join(dir, ...target.split(/[\\/]/).filter(Boolean))
      if (await isFile(resolved)) return resolved
    }
  }
  const appData = "appData" in lookup ? lookup.appData : process.env.APPDATA
  return (await findDesktopCli(appData, lookup.arch ?? process.arch)) ?? "opencode"
}

let executable: Promise<string> | undefined

export function runOpenCodeBinary(args: string[], stdin?: string): Promise<string> {
  executable ??= resolveOpenCodeExecutable()
  return executable.then((command) => spawnOpenCode(command, args, stdin))
}

function spawnOpenCode(command: string, args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    let child: ReturnType<typeof execFile>
    try {
      child = execFile(command, args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
        if (error) {
          const code = (error as NodeJS.ErrnoException).code
          // A string code is a spawn-level failure (ENOENT, EINVAL for the Windows npm shim, EACCES);
          // a numeric code is the process exit status.
          if (typeof code === "string") return reject(new OpenCodeNotFoundError(code))
          // Never echo error.message or the full argv: both carry the JSON body, including the API key.
          const detail = stderr.trim() || stdout.trim().slice(-200)
          return reject(
            new Error(`opencode ${args[0]} ${args[1]} failed (exit ${code ?? "unknown"})${detail ? `: ${detail}` : ""}`),
          )
        }
        resolve(stdout)
      })
    } catch (error) {
      // Synchronous spawn failures (e.g. argument validation for batch files) echo the argv; never forward them.
      const code = (error as NodeJS.ErrnoException).code
      return reject(new OpenCodeNotFoundError(typeof code === "string" ? code : "spawn failed"))
    }
    if (stdin !== undefined) child.stdin?.end(stdin)
    else child.stdin?.end()
  })
}

export function fileCredentialStore(authPath: string): CredentialStore {
  return {
    description: authPath,
    read: async () => extractApiCredentials(await readAuthStore(authPath)),
    write: (updates, removals) => updateApiCredentials(updates, removals, authPath),
  }
}

interface CredentialEntry {
  id: string
  integrationID: string
  active?: boolean
  value: { type: string; key?: string; metadata?: Record<string, unknown> }
}

function parseList(output: string): CredentialEntry[] {
  let parsed: unknown
  try {
    parsed = JSON.parse(output)
  } catch {
    throw new Error("opencode api credential.list returned invalid JSON")
  }
  const data = (parsed as { data?: unknown })?.data ?? parsed
  if (!Array.isArray(data)) throw new Error("opencode api credential.list returned invalid JSON")
  return data.filter(
    (entry): entry is CredentialEntry =>
      !!entry &&
      typeof entry === "object" &&
      typeof (entry as CredentialEntry).id === "string" &&
      typeof (entry as CredentialEntry).integrationID === "string" &&
      !!(entry as CredentialEntry).value &&
      typeof (entry as CredentialEntry).value === "object",
  )
}

const STANDALONE = "--standalone"

/**
 * Talks to OpenCode 2 through its own CLI, so the database layout stays its
 * business. `--standalone` spins up a private server per call instead of
 * depending on a running background service.
 *
 * Write order is create-then-remove per integration: if `credential.create`
 * fails, the previous credential is still in place. Integrations that are only
 * being cleared are removed directly.
 */
export function opencodeCredentialStore(
  run: RunOpenCode,
  label: (providerID: string) => string = (id) => `Neuron (${id})`,
): CredentialStore {
  const list = async () => parseList(await run(["api", "credential.list", STANDALONE]))
  return {
    description: "OpenCode's credential store (opencode api credential.*)",
    read: async () => {
      const credentials: Record<string, StoredApiCredential> = {}
      for (const entry of await list()) {
        if (entry.value.type !== "key" || typeof entry.value.key !== "string" || !entry.value.key) continue
        // The active credential wins; otherwise the first key credential stays.
        if (credentials[entry.integrationID] && entry.active !== true) continue
        const baseURL = entry.value.metadata?.baseURL
        credentials[entry.integrationID] = {
          key: entry.value.key,
          ...(typeof baseURL === "string" ? { baseURL } : {}),
        }
      }
      return credentials
    },
    write: async (updates, removals) => {
      const touched = new Set([...Object.keys(updates), ...removals])
      if (!touched.size) return
      const existing = await list()
      const removeOld = async (providerID: string) => {
        for (const entry of existing) {
          if (entry.integrationID !== providerID) continue
          await run(["api", "credential.remove", STANDALONE, "--param", `credentialID=${entry.id}`])
        }
      }
      for (const [providerID, credential] of Object.entries(updates)) {
        const body = {
          integrationID: providerID,
          label: label(providerID),
          value: {
            type: "key",
            key: credential.key,
            ...(credential.baseURL ? { metadata: { baseURL: credential.baseURL } } : {}),
          },
          activate: true,
        }
        await run(["api", "credential.create", STANDALONE, "-d", JSON.stringify(body)])
        await removeOld(providerID)
      }
      for (const providerID of removals) {
        if (providerID in updates) continue
        await removeOld(providerID)
      }
    },
  }
}
