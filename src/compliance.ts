import type { OpenCodeConfig, PermissionCategory, PermissionConfig, PermissionRule } from "./types.js"

/**
 * Providers blocked out of the box.
 *
 * Only OpenCode's own hosted gateway (Zen). It is the default path on first
 * contact, needs no credential to show up, and sends the conversation to a
 * third party nobody cleared. Everything else — Anthropic, OpenAI/Codex,
 * GitHub Copilot, Google, … — is left alone: a credential for one of those is
 * a licence somebody paid for, not an accident. Extend the list with the
 * `denyProviders` plugin option for a provider your organisation rules out.
 */
export const BLOCKED_PROVIDERS: readonly string[] = ["opencode", "opencode-go"]

/**
 * Files that hold credentials. Reading one would put a secret into the
 * conversation, editing one could plant a credential; neither is ever
 * something an agent needs for ordinary work.
 */
const SECRET_PATTERNS: readonly string[] = [
  "**/.env",
  "**/.env.*",
  "**/.npmrc",
  "**/.pypirc",
  "**/.netrc",
  "**/.git-credentials",
  "**/credentials",
  "**/credentials.json",
  "**/.aws/**",
  "**/.ssh/**",
  "**/.kube/config",
  "**/.docker/config.json",
  "**/id_rsa",
  "**/id_ed25519",
  "**/*_rsa",
  "**/*_ed25519",
  "**/*.pem",
  "**/*.key",
  "**/*.p12",
  "**/*.pfx",
]

/** Templates that look like secrets but are meant to be read. Listed after the denies so they win in OpenCode 2. */
const SECRET_EXCEPTIONS: readonly string[] = ["**/.env.example", "**/.env.sample"]

/** Shell commands that send data off the machine or are hard to undo. */
const SHELL_ASK_PATTERNS: readonly string[] = [
  // network egress
  "curl *",
  "wget *",
  "ssh *",
  "scp *",
  "sftp *",
  "rsync *",
  "nc *",
  "ncat *",
  // cloud and cluster access
  "az *",
  "aws *",
  "gcloud *",
  "kubectl *",
  "docker push*",
  "docker login*",
  // publishing
  "npm publish*",
  "pnpm publish*",
  "twine *",
  "gh release*",
  "gh pr create*",
  "git push*",
  // irreversible
  "rm -rf *",
  "rm -r *",
  "git reset --hard*",
  "git clean -f*",
  "git checkout -- *",
  "sudo *",
]

function withEffect(patterns: readonly string[], effect: PermissionRule): PermissionCategory {
  return Object.fromEntries(patterns.map((pattern) => [pattern, effect]))
}

/**
 * Baseline tool permissions: everyday work (read, edit, build, test, commit)
 * runs without a prompt; secrets are off limits; a prompt appears only when
 * data leaves the machine or something cannot be undone.
 *
 * Two kinds of rules live here. A `deny` is hard: it is the compliance
 * core and overrides whatever the user configured for the same pattern. An
 * `ask` or `allow` is soft: a user's own rule for the same pattern wins.
 *
 * Fixed here rather than exposed as a plugin option, deliberately: this is a
 * Noser-wide baseline. A project that needs more relaxes a soft rule in its
 * own config; `enforce: false` is the only way around the hard ones.
 */
export const DEFAULT_PERMISSION_POLICY: PermissionConfig = {
  read: { "*": "allow", ...withEffect(SECRET_PATTERNS, "deny"), ...withEffect(SECRET_EXCEPTIONS, "allow") },
  edit: { "*": "allow", ...withEffect(SECRET_PATTERNS, "deny") },
  bash: { "*": "allow", ...withEffect(SHELL_ASK_PATTERNS, "ask") },
  // The prompt, or parts of it, goes to a third party.
  webfetch: "ask",
}

/**
 * Merges one category of the baseline into what the user has: hard rules
 * (deny) overwrite, soft rules fill gaps only. A category the user set as a
 * plain blanket rule (e.g. `edit: "ask"`) keeps that value as its `*` entry
 * and still receives the hard rules; the soft ones would only restate the
 * blanket the user chose.
 */
function mergePermissionCategory(
  existing: PermissionRule | PermissionCategory | undefined,
  defaults: PermissionCategory,
): PermissionRule | PermissionCategory {
  const blanket = typeof existing === "string" ? existing : undefined
  const merged: PermissionCategory = blanket ? { "*": blanket } : { ...(existing as PermissionCategory | undefined) }
  for (const [pattern, rule] of Object.entries(defaults)) {
    if (rule === "deny") merged[pattern] = rule
    else if (!blanket && !(pattern in merged)) merged[pattern] = rule
  }
  return merged
}

/**
 * Adds the baseline permission policy to whatever the user already has.
 * Safe to call repeatedly: a second call changes nothing.
 */
export function applyPermissionPolicy(config: OpenCodeConfig, policy: PermissionConfig): void {
  const existing = config.permission ?? {}
  const merged: PermissionConfig = { ...existing }

  if (existing["*"] === undefined && policy["*"] !== undefined) merged["*"] = policy["*"]

  for (const [category, defaults] of Object.entries(policy)) {
    if (category === "*" || defaults === undefined) continue
    if (typeof defaults === "string") {
      if (existing[category] === undefined) merged[category] = defaults
      continue
    }
    if (typeof defaults !== "object" || defaults === null) continue
    merged[category] = mergePermissionCategory(
      existing[category] as PermissionRule | PermissionCategory | undefined,
      defaults as PermissionCategory,
    )
  }

  config.permission = merged
}

export interface CompliancePolicy {
  enforce: boolean
  denyProviders: string[]
}

/**
 * What a previous call added to this config object.
 *
 * The `config` hook can run several times per process against one cumulative
 * config, and the set of declared providers can grow between those calls. An
 * entry generated earlier has to be retracted once its provider turns out to be
 * declared, or the layer would keep blocking something the user asked for.
 *
 * Keyed by the config object so that entries the user wrote by hand are never
 * mistaken for generated ones, and so that no state survives between tests.
 */
const generatedEntries = new WeakMap<OpenCodeConfig, { providers: string[] }>()

function uniqueStrings(values: Iterable<string>): string[] {
  return [...new Set(values)]
}

/**
 * Providers the user named on purpose. OpenCode only fills `config.provider`
 * from configuration files, never from an autoloaded credential, so presence
 * here is the signal that somebody made a deliberate choice.
 */
export function declaredProviderIDs(config: OpenCodeConfig): string[] {
  if (!config.provider || typeof config.provider !== "object") return []
  return Object.keys(config.provider)
}

/** The providers to block: the block list plus denyProviders, minus what was declared. */
export function deniedProviderIDs(config: OpenCodeConfig, policy: CompliancePolicy): string[] {
  const declared = new Set(declaredProviderIDs(config))
  const denyable = uniqueStrings([...BLOCKED_PROVIDERS, ...policy.denyProviders])
  return denyable.filter((id) => !declared.has(id))
}

/**
 * Blocks the listed providers unless declared and turns off the two features
 * that can leak a conversation or change the provider set behind the user's back.
 *
 * Verified against OpenCode 1.18.4: `disabled_providers` set from the `config`
 * hook removes a provider from the catalog, and it wins over an explicitly
 * declared `provider.<id>` entry — which is why declared providers are
 * subtracted above instead of being blocked and re-allowed.
 *
 * Safe to call repeatedly. OpenCode may invoke the `config` hook more than once
 * per process with a cumulative config object.
 */
export function applyCompliance(config: OpenCodeConfig, policy: CompliancePolicy): void {
  if (!policy.enforce) return

  const denied = deniedProviderIDs(config, policy)
  const deniedSet = new Set(denied)
  const previous = generatedEntries.get(config)

  const retracted = new Set((previous?.providers ?? []).filter((id) => !deniedSet.has(id)))
  const existingDisabled = Array.isArray(config.disabled_providers)
    ? config.disabled_providers.filter((entry): entry is string => typeof entry === "string")
    : []
  config.disabled_providers = uniqueStrings([...existingDisabled.filter((id) => !retracted.has(id)), ...denied])
  generatedEntries.set(config, { providers: denied })

  // "disabled" is the strictest value; /share would publish the conversation
  // including code excerpts to opencode.ai, where a CDN caches it.
  config.share = "disabled"

  // An automatic update can introduce a new preconfigured provider without
  // anyone looking at it. `false` is stricter than "notify", so keep it.
  if (config.autoupdate !== false) config.autoupdate = "notify"

  applyPermissionPolicy(config, DEFAULT_PERMISSION_POLICY)
}
