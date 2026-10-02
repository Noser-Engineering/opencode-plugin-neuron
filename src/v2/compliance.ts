import { BLOCKED_PROVIDERS, type CompliancePolicy } from "../compliance.js"
import type { PermissionCategory, PermissionConfig, PermissionRule as V1Rule } from "../types.js"
import type { AgentEditor, PermissionRule, ProviderEditor, ProviderRecord } from "./context.js"

/**
 * The providers to remove: the block list plus denyProviders, minus anything
 * the user declared. In OpenCode 2 a provider named in opencode.json arrives
 * with activation set to enabled, an auto-loaded one with auto - that is the
 * same declaration is approval signal config.provider gave in v1. The
 * plugin's own profiles are added as enabled, so they are never denied.
 * Ids that are not loaded at all are skipped; removing them would be a no-op.
 */
export function deniedProviderIDs(records: readonly ProviderRecord[], policy: CompliancePolicy): string[] {
  const byId = new Map(records.map((record) => [record.provider.id, record]))
  const denyable = [...new Set([...BLOCKED_PROVIDERS, ...policy.denyProviders])]
  return denyable.filter((id) => {
    const record = byId.get(id)
    return record !== undefined && record.provider.activation !== "enabled"
  })
}

/** Transform callback body. Pure: OpenCode replays it on every registry rebuild. */
export function applyDenyList(editor: ProviderEditor, policy: CompliancePolicy): void {
  for (const id of deniedProviderIDs(editor.list(), policy)) editor.remove(id)
}

/** v1 permission actions that were renamed in v2. */
const ACTION_RENAMES: Record<string, string> = { bash: "shell" }

// v1 globs are gitignore-style (** crosses directories, * does not). In
// v2 * matches any characters including /, so ** prefix collapses into *
// and any run of stars into one.
function toV2Resource(pattern: string): string {
  return pattern.replace(/\*\*\//g, "*").replace(/\*{2,}/g, "*")
}

function categoryRules(action: string, category: V1Rule | PermissionCategory): PermissionRule[] {
  if (typeof category === "string") return [{ action, resource: "*", effect: category }]
  // v1 picks the most specific matching pattern; v2 picks the last matching
  // rule. Emitting the blanket pattern first keeps the specific ones winning.
  const entries = Object.entries(category)
  const blanket = entries.filter(([pattern]) => pattern === "*")
  const specific = entries.filter(([pattern]) => pattern !== "*")
  return [...blanket, ...specific].map(([pattern, effect]) => ({ action, resource: toV2Resource(pattern), effect }))
}

/** The v1 baseline policy as an ordered v2 rule list, broad rules first. */
export function toPermissionRules(policy: PermissionConfig): PermissionRule[] {
  const rules: PermissionRule[] = []
  if (policy["*"] !== undefined) rules.push({ action: "*", resource: "*", effect: policy["*"] })
  for (const [key, value] of Object.entries(policy)) {
    if (key === "*" || value === undefined) continue
    if (typeof value !== "string" && (typeof value !== "object" || value === null)) continue
    rules.push(...categoryRules(ACTION_RENAMES[key] ?? key, value as V1Rule | PermissionCategory))
  }
  return rules
}

function sameRule(a: PermissionRule, b: PermissionRule): boolean {
  return a.action === b.action && a.resource === b.resource && a.effect === b.effect
}

/**
 * Appends the baseline to every agent. Last match wins in v2, so appending is
 * what makes the baseline effective over OpenCode's own defaults. Exact
 * duplicates are skipped; they would change nothing. Pure, see applyDenyList.
 */
export function applyPermissionRules(editor: AgentEditor, rules: readonly PermissionRule[]): void {
  for (const agent of editor.list()) {
    editor.update(agent.id, (target) => {
      for (const rule of rules) {
        if (target.permissions.some((existing) => sameRule(existing, rule))) continue
        target.permissions.push(rule)
      }
    })
  }
}
