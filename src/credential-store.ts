import { execFile } from "node:child_process"
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
  constructor() {
    super("The opencode binary was not found on PATH")
    this.name = "OpenCodeNotFoundError"
  }
}

export function runOpenCodeBinary(args: string[], stdin?: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("opencode", args, { maxBuffer: 16 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return reject(new OpenCodeNotFoundError())
        // Never echo error.message or the full argv: both carry the JSON body, including the API key.
        const code = (error as NodeJS.ErrnoException).code
        const detail = stderr.trim() || stdout.trim().slice(-200)
        return reject(
          new Error(`opencode ${args[0]} ${args[1]} failed (exit ${code ?? "unknown"})${detail ? `: ${detail}` : ""}`),
        )
      }
      resolve(stdout)
    })
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
        if (credentials[entry.integrationID]) continue
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
          await run(["api", "credential.remove", STANDALONE, "-d", JSON.stringify({ credentialID: entry.id })])
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
