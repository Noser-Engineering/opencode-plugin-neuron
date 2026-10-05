import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { parse } from "jsonc-parser"

/**
 * The provider ids a user wrote into an OpenCode config file on purpose.
 *
 * "Declaration is approval" needs to know what the user declared, and the
 * OpenCode 2 plugin context does not expose the config. Nor does a
 * provider's `activation` tell: OpenCode 2 ships Zen as `"enabled"` even
 * when nobody declared it, because its public key always works. So the
 * files OpenCode itself reads are consulted directly: the global config,
 * the project config, and `OPENCODE_CONFIG` when set, in `opencode.json`
 * and `opencode.jsonc` form. Both the v2 key `providers` and the legacy v1
 * key `provider` count; OpenCode 2 still accepts the latter.
 */
export function configFileCandidates(
  directory: string,
  env: Record<string, string | undefined>,
  home: string,
): string[] {
  const globalDir = env.OPENCODE_CONFIG_DIR ?? join(env.XDG_CONFIG_HOME ?? join(home, ".config"), "opencode")
  const names = ["opencode.json", "opencode.jsonc"]
  return [
    ...(env.OPENCODE_CONFIG ? [env.OPENCODE_CONFIG] : []),
    ...names.map((name) => join(globalDir, name)),
    ...names.map((name) => join(directory, name)),
    ...names.map((name) => join(directory, ".opencode", name)),
  ]
}

function providerKeys(config: unknown): string[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) return []
  const keys: string[] = []
  for (const field of ["providers", "provider"]) {
    const value = (config as Record<string, unknown>)[field]
    if (value && typeof value === "object" && !Array.isArray(value)) keys.push(...Object.keys(value))
  }
  return keys
}

/**
 * Union of the declared provider ids over every candidate file. A missing
 * or unparseable file contributes nothing; the caller decides whether that
 * is worth a warning.
 */
export async function readDeclaredProviderIDs(
  directory: string,
  env: Record<string, string | undefined> = process.env,
  home: string,
): Promise<Set<string>> {
  const declared = new Set<string>()
  for (const file of configFileCandidates(directory, env, home)) {
    let text: string
    try {
      text = await readFile(file, "utf8")
    } catch {
      continue
    }
    const parsed: unknown = parse(text, undefined, { allowTrailingComma: true, disallowComments: false })
    for (const id of providerKeys(parsed)) declared.add(id)
  }
  return declared
}
