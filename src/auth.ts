import { homedir } from "node:os"
import { dirname, join } from "node:path"
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"

interface ApiAuth {
  type: "api"
  key: string
  metadata?: Record<string, string>
}

interface OAuthAuth {
  type: "oauth"
  access: string
}

type AuthEntry = ApiAuth | OAuthAuth | Record<string, unknown>
export type AuthStore = Record<string, AuthEntry>

export interface StoredApiCredential {
  key: string
  baseURL?: string
}

export function resolveAuthPath(
  env: Record<string, string | undefined> = process.env,
  platform = process.platform,
  home = homedir(),
): string {
  if (env.OPENCODE_AUTH_PATH) return env.OPENCODE_AUTH_PATH
  if (env.XDG_DATA_HOME) return join(env.XDG_DATA_HOME, "opencode", "auth.json")
  if (platform === "win32") {
    return join(env.LOCALAPPDATA ?? join(home, "AppData", "Local"), "opencode", "auth.json")
  }
  return join(home, ".local", "share", "opencode", "auth.json")
}

export async function readAuthStore(filePath = resolveAuthPath()): Promise<AuthStore> {
  try {
    const parsed: unknown = JSON.parse(await readFile(filePath, "utf8"))
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    return parsed as AuthStore
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return {}
    throw error
  }
}

export function extractApiCredentials(store: AuthStore): Record<string, StoredApiCredential> {
  const credentials: Record<string, StoredApiCredential> = {}
  for (const [providerID, entry] of Object.entries(store)) {
    if (entry.type !== "api" || typeof entry.key !== "string" || !entry.key) continue
    const metadata =
      entry.metadata && typeof entry.metadata === "object"
        ? (entry.metadata as Record<string, unknown>)
        : undefined
    const baseURL =
      metadata && typeof metadata.baseURL === "string" ? metadata.baseURL : undefined
    credentials[providerID] = { key: entry.key, ...(baseURL ? { baseURL } : {}) }
  }
  return credentials
}

export async function readStoredApiCredentials(
  filePath = resolveAuthPath(),
): Promise<Record<string, StoredApiCredential>> {
  return extractApiCredentials(await readAuthStore(filePath))
}

export async function updateApiCredentials(
  updates: Record<string, StoredApiCredential>,
  removals: Iterable<string> = [],
  filePath = resolveAuthPath(),
): Promise<void> {
  const store = await readAuthStore(filePath)
  for (const providerID of removals) delete store[providerID]
  for (const [providerID, credential] of Object.entries(updates)) {
    store[providerID] = {
      type: "api",
      key: credential.key,
      ...(credential.baseURL ? { metadata: { baseURL: credential.baseURL } } : {}),
    }
  }

  await mkdir(dirname(filePath), { recursive: true, mode: 0o700 })
  const temporaryPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  try {
    await writeFile(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf8", mode: 0o600 })
    await rename(temporaryPath, filePath)
    await chmod(filePath, 0o600)
  } catch (error) {
    await rm(temporaryPath, { force: true }).catch(() => undefined)
    throw error
  }
}
