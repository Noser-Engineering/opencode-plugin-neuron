import { describe, expect, it } from "vitest"
import { DEFAULT_PERMISSION_POLICY } from "../../src/compliance.js"
import { applyDenyList, applyPermissionRules, deniedProviderIDs, toPermissionRules, V2_EXTRA_PERMISSIONS } from "../../src/v2/compliance.js"
import type { AgentRecord, PermissionRule, ProviderEditor, ProviderRecord, V2ProviderInfo } from "../../src/v2/context.js"

function record(id: string, activation: V2ProviderInfo["activation"]): ProviderRecord {
  return { provider: { id, name: id, activation, package: "x" }, models: new Map() }
}

class FakeProviderEditor implements ProviderEditor {
  readonly removed: string[] = []
  constructor(private readonly records: ProviderRecord[]) {}
  list() {
    return this.records
  }
  get(id: string) {
    return this.records.find((r) => r.provider.id === id)
  }
  add() {
    throw new Error("not used")
  }
  remove(id: string) {
    this.removed.push(id)
  }
}

const enforce = { enforce: true, denyProviders: [] }

describe("deniedProviderIDs", () => {
  const none = new Set<string>()

  it("denies the blocked providers whatever their activation says", () => {
    // OpenCode 2 ships Zen as "enabled" even when nobody declared it, so
    // activation cannot stand in for a declaration.
    const records = [record("opencode", "enabled"), record("opencode-go", "auto"), record("anthropic", "auto")]
    expect(deniedProviderIDs(records, enforce, none)).toEqual(["opencode", "opencode-go"])
  })

  it("keeps a blocked provider the user declared in a config file", () => {
    const records = [record("opencode", "enabled"), record("opencode-go", "auto")]
    expect(deniedProviderIDs(records, enforce, new Set(["opencode"]))).toEqual(["opencode-go"])
  })

  it("adds denyProviders and ignores ids that are not loaded at all", () => {
    const records = [record("anthropic", "auto")]
    expect(deniedProviderIDs(records, { enforce: true, denyProviders: ["anthropic", "missing"] }, none)).toEqual([
      "anthropic",
    ])
  })

  it("never denies the plugin's own profiles", () => {
    const records = [record("work", "enabled")]
    expect(deniedProviderIDs(records, { enforce: true, denyProviders: ["work"] }, none, new Set(["work"]))).toEqual([])
  })
})

describe("applyDenyList", () => {
  it("removes exactly the denied providers", () => {
    const editor = new FakeProviderEditor([record("opencode", "enabled"), record("work", "enabled")])
    applyDenyList(editor, enforce, new Set<string>())
    expect(editor.removed).toEqual(["opencode"])
  })
})

describe("toPermissionRules", () => {
  const rules = toPermissionRules(DEFAULT_PERMISSION_POLICY)

  it("has no blanket rule across all actions", () => {
    expect(rules.some((r) => r.action === "*")).toBe(false)
  })

  it("renames bash to shell, allows by default and asks for egress and publishing", () => {
    const shell = rules.filter((r) => r.action === "shell")
    expect(shell[0]).toEqual({ action: "shell", resource: "*", effect: "allow" })
    expect(shell).toContainEqual({ action: "shell", resource: "curl *", effect: "ask" })
    expect(shell).toContainEqual({ action: "shell", resource: "git push*", effect: "ask" })
    expect(shell).toContainEqual({ action: "shell", resource: "rm -rf *", effect: "ask" })
    expect(rules.some((r) => r.action === "bash")).toBe(false)
  })

  it("translates **/ globs to v2 wildcards and orders each category broad-first, exceptions last", () => {
    const read = rules.filter((r) => r.action === "read")
    expect(read[0]).toEqual({ action: "read", resource: "*", effect: "allow" })
    expect(read).toContainEqual({ action: "read", resource: "*.env", effect: "deny" })
    expect(read).toContainEqual({ action: "read", resource: "*.env.*", effect: "deny" })
    expect(read).toContainEqual({ action: "read", resource: "*.ssh/*", effect: "deny" })
    expect(read.findIndex((r) => r.resource === "*.env.example")).toBeGreaterThan(read.findIndex((r) => r.resource === "*.env.*"))
    expect(read.some((r) => r.resource.includes("**"))).toBe(false)
  })

  it("leaves a category that is a plain blanket rule as one rule", () => {
    expect(toPermissionRules({ edit: "allow" })).toEqual([{ action: "edit", resource: "*", effect: "allow" }])
  })

  it("carries the v2-only extras", () => {
    expect(toPermissionRules(V2_EXTRA_PERMISSIONS)).toEqual([{ action: "websearch", resource: "*", effect: "ask" }])
  })
})

describe("applyPermissionRules", () => {
  function editor(agents: AgentRecord[]) {
    return {
      list: () => agents,
      update: (id: string, update: (agent: AgentRecord) => void) => {
        const agent = agents.find((a) => a.id === id)
        if (agent) update(agent)
      },
    }
  }

  const rules: PermissionRule[] = [
    { action: "shell", resource: "curl *", effect: "ask" },
    { action: "read", resource: "*.env", effect: "deny" },
  ]

  it("appends the rules to every agent", () => {
    const build: AgentRecord = { id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }] }
    const plan: AgentRecord = { id: "plan", permissions: [] }
    applyPermissionRules(editor([build, plan]), rules)
    expect(build.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }, ...rules])
    expect(plan.permissions).toEqual(rules)
  })

  it("lets a user's rule for the same pattern win over an ask, but not over a deny", () => {
    const build: AgentRecord = {
      id: "build",
      permissions: [
        { action: "shell", resource: "curl *", effect: "allow" },
        { action: "read", resource: "*.env", effect: "allow" },
      ],
    }
    applyPermissionRules(editor([build]), rules)
    expect(build.permissions).toEqual([
      { action: "shell", resource: "curl *", effect: "allow" },
      { action: "read", resource: "*.env", effect: "allow" },
      { action: "read", resource: "*.env", effect: "deny" },
    ])
  })

  it("skips a rule the agent already has verbatim", () => {
    const build: AgentRecord = { id: "build", permissions: [{ action: "read", resource: "*.env", effect: "deny" }] }
    applyPermissionRules(editor([build]), rules)
    expect(build.permissions).toEqual([
      { action: "read", resource: "*.env", effect: "deny" },
      { action: "shell", resource: "curl *", effect: "ask" },
    ])
  })
})
