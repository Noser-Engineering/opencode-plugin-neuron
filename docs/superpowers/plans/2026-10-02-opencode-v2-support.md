# OpenCode v2 Support Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `@noser-engineering/opencode-plugin-neuron` load and work on OpenCode 2.x while keeping OpenCode 1.x untouched, including the setup CLI.

**Architecture:** Two entrypoints in one package. `exports["."]` keeps the v1 plugin exactly as it is; `exports["./server"]` is a new v2 entry built on the `Plugin.define({ id, setup })` API. Discovery and option parsing are shared; v2 gets its own model mapper, compliance module and adapter under `src/v2/`. The setup CLI detects the installed OpenCode major and writes the matching config shape and credential store.

**Tech Stack:** TypeScript 5.9 ESM (`NodeNext`), vitest 3, `jsonc-parser` (only runtime dep), `@opencode/plugin` 2.0.x and `@opencode-ai/plugin` 1.18.x as type-only devDependencies, `tsc` build.

**Spec:** `docs/superpowers/specs/2026-10-02-opencode-v2-support-design.md`

## Global Constraints

- `jsonc-parser` stays the only runtime dependency. `@opencode/plugin` is a devDependency used for types only; `dist/v2.js` must not import it at runtime.
- v1 behaviour and the v1 entry `dist/index.js` do not change. Existing tests must keep passing untouched.
- v2 transform callbacks are replayed by OpenCode; they must be pure and only apply data computed beforehand.
- Provider package ids: `@opencode/ai/providers/openai-compatible` (default), `@opencode/ai/providers/openai` (Responses API, per model).
- Plugin id in v2: `neuron`.
- Setup writes the v2 plugin entry unpinned (`{ "package": "@noser-engineering/opencode-plugin-neuron", "options": {…} }`); the v1 entry stays pinned.
- `npm run check` (typecheck, tests, build) must be green before every commit. Code style: functions, injected dependencies, no classes except where the codebase already has them, defensive parsing at the edges.
- Commit messages follow the repo style: imperative sentence, no prefix (e.g. `Price cache reads and writes so …`).
- Do not run `npm version` or publish; release is manual (see memory). CHANGELOG gets an `Unreleased` section.

## Review Focus

1. A profile without a stored key must still be registered (with whatever `/v1/models` returns anonymously) and must appear in `/connect`, otherwise a fresh user can never enter a key. Pinned in Task 3.
2. Two `credential.updated` events arriving back to back must not run two discoveries concurrently or leave two provider registrations alive. Pinned in Task 3.
3. A config that carries both a legacy v1 `plugin` entry for this package and a v2 `plugins` array must end up with exactly one v2 entry and no v1 entry. Pinned in Task 5.
4. On OpenCode 2 without an `opencode` binary on `PATH`, setup must fall back to `auth.json` and say that v2 imports it only on first start, instead of crashing. Pinned in Task 7.
5. A LiteLLM model without any price must produce `cost: []`, never `NaN` or a half-filled cost entry. Pinned in Task 1.

---

### Task 1: v2 model mapping

**Files:**
- Modify: `src/constants.ts`
- Create: `src/v2/context.ts`
- Create: `src/v2/model.ts`
- Test: `test/v2/model.test.ts`

**Interfaces:**
- Consumes: `LiteLLMModel` from `src/types.ts`.
- Produces: `V2ModelInfo`, `V2ProviderInfo`, `Activation` types in `src/v2/context.ts`; `toModelInfo(model: LiteLLMModel, providerID: string): V2ModelInfo` in `src/v2/model.ts`; constants `PROVIDER_PACKAGE_V2`, `RESPONSES_API_PACKAGE_V2`, `PLUGIN_ID`, `DEFAULT_CONTEXT_LIMIT`, `DEFAULT_OUTPUT_LIMIT` in `src/constants.ts`.

- [ ] **Step 1: Add constants**

Append to `src/constants.ts`:

```ts
/** OpenCode 2.x plugin id, shown in `opencode plugin list`. */
export const PLUGIN_ID = "neuron"
/** OpenCode 2.x adapters. v2 moved the AI SDK adapters into its own package. */
export const PROVIDER_PACKAGE_V2 = "@opencode/ai/providers/openai-compatible"
export const RESPONSES_API_PACKAGE_V2 = "@opencode/ai/providers/openai"
/**
 * OpenCode 2.x requires `limit` on every model. These stand in when the proxy
 * reports nothing: 128k is the common context size today, and 32k output
 * matches the cap OpenCode 1.x applied on its own when the plugin omitted
 * `limit`.
 */
export const DEFAULT_CONTEXT_LIMIT = 128_000
export const DEFAULT_OUTPUT_LIMIT = 32_000
```

- [ ] **Step 2: Create the structural v2 types**

Create `src/v2/context.ts`. These mirror the slice of `@opencode/plugin`'s `Context` the plugin touches, so tests and the adapter never import the SDK at runtime.

```ts
/**
 * The part of OpenCode 2.x's plugin `Context` this plugin uses, written out
 * structurally so the adapter and its tests do not depend on the SDK's
 * branded types. `src/v2.ts` casts the real context to this shape once.
 */

export type Activation = "auto" | "enabled" | "disabled"

export interface V2ProviderInfo {
  id: string
  name: string
  activation: Activation
  package: string
  settings?: Record<string, unknown>
}

export interface V2ModelCost {
  input: number
  output: number
  cache: { read: number; write: number }
}

export interface V2ModelInfo {
  id: string
  modelID: string
  providerID: string
  name: string
  /** Overrides the provider's adapter for this one model. */
  package?: string
  capabilities: { tools: boolean; input: string[]; output: string[] }
  variants: unknown[]
  time: { released: number }
  cost: V2ModelCost[]
  status: "active" | "deprecated"
  enabled: boolean
  limit: { context: number; output: number }
}

export interface ProviderRecord {
  provider: V2ProviderInfo
  models: ReadonlyMap<string, V2ModelInfo>
}

export interface ProviderEditor {
  list(): readonly ProviderRecord[]
  get(providerID: string): ProviderRecord | undefined
  add(input: { info: V2ProviderInfo; models: readonly V2ModelInfo[] }): void
  remove(providerID: string): void
}

export type PermissionEffect = "allow" | "ask" | "deny"

export interface PermissionRule {
  action: string
  resource: string
  effect: PermissionEffect
}

export interface AgentRecord {
  id: string
  permissions: PermissionRule[]
}

export interface AgentEditor {
  list(): readonly AgentRecord[]
  update(agentID: string, update: (agent: AgentRecord) => void): void
}

export interface IntegrationEditor {
  readonly method: {
    update(input: { integrationID: string; method: { type: "key"; label?: string } }): void
  }
}

export interface Registration {
  dispose(): Promise<void>
}

export type Transform<Editor> = (callback: (editor: Editor) => void) => Promise<Registration>

export interface Connection {
  type: "credential" | "env"
}

export interface KeyCredential {
  type: "key"
  key: string
  metadata?: Record<string, unknown>
}

export interface OtherCredential {
  type: "oauth"
}

export interface NeuronContext {
  readonly options: Readonly<Record<string, unknown>>
  readonly provider: { readonly transform: Transform<ProviderEditor> }
  readonly agent: { readonly transform: Transform<AgentEditor> }
  readonly integration: {
    readonly transform: Transform<IntegrationEditor>
    readonly connection: {
      active(integrationID: string): Promise<Connection | undefined>
      resolve(connection: Connection): Promise<KeyCredential | OtherCredential | undefined>
    }
  }
  readonly event: {
    subscribe(options: { signal: AbortSignal }): AsyncIterable<{ type: string }>
  }
}
```

- [ ] **Step 3: Write the failing mapping tests**

Create `test/v2/model.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { DEFAULT_CONTEXT_LIMIT, DEFAULT_OUTPUT_LIMIT, RESPONSES_API_PACKAGE_V2 } from "../../src/constants.js"
import { toModelInfo } from "../../src/v2/model.js"

describe("toModelInfo", () => {
  it("maps ids, limits, capabilities and prices", () => {
    const info = toModelInfo(
      {
        id: "claude-sonnet",
        mode: "chat",
        max_input_tokens: 200_000,
        max_output_tokens: 16_000,
        supports_function_calling: true,
        supports_vision: true,
        supports_pdf_input: true,
        input_cost_per_million: 3,
        output_cost_per_million: 15,
        cache_read_cost_per_million: 0.3,
        cache_write_cost_per_million: 3.75,
      },
      "work",
    )

    expect(info).toEqual({
      id: "claude-sonnet",
      modelID: "claude-sonnet",
      providerID: "work",
      name: "claude-sonnet",
      capabilities: { tools: true, input: ["text", "image", "pdf"], output: ["text"] },
      variants: [],
      time: { released: 0 },
      cost: [{ input: 3, output: 15, cache: { read: 0.3, write: 3.75 } }],
      status: "active",
      enabled: true,
      limit: { context: 200_000, output: 16_000 },
    })
  })

  it("prices cache tokens like input tokens when the proxy does not say otherwise", () => {
    const info = toModelInfo({ id: "m", input_cost_per_million: 2, output_cost_per_million: 8 }, "p")
    expect(info.cost).toEqual([{ input: 2, output: 8, cache: { read: 2, write: 2 } }])
  })

  it("reports no price at all when either side is missing", () => {
    expect(toModelInfo({ id: "m", input_cost_per_million: 2 }, "p").cost).toEqual([])
    expect(toModelInfo({ id: "m" }, "p").cost).toEqual([])
  })

  it("falls back to defaults when the proxy reports no limits", () => {
    expect(toModelInfo({ id: "m" }, "p").limit).toEqual({
      context: DEFAULT_CONTEXT_LIMIT,
      output: DEFAULT_OUTPUT_LIMIT,
    })
  })

  it("uses max_tokens for both limits and context for a missing output limit", () => {
    expect(toModelInfo({ id: "m", max_tokens: 32_000 }, "p").limit).toEqual({ context: 32_000, output: 32_000 })
    expect(toModelInfo({ id: "m", max_input_tokens: 100_000 }, "p").limit).toEqual({
      context: 100_000,
      output: 100_000,
    })
  })

  it("assumes tool calling unless the proxy denies it", () => {
    expect(toModelInfo({ id: "m" }, "p").capabilities.tools).toBe(true)
    expect(toModelInfo({ id: "m", supports_function_calling: false }, "p").capabilities.tools).toBe(false)
  })

  it("switches Responses-API models to the openai adapter", () => {
    expect(toModelInfo({ id: "gpt-5", mode: "responses" }, "p").package).toBe(RESPONSES_API_PACKAGE_V2)
    expect(toModelInfo({ id: "gpt-4", mode: "chat" }, "p")).not.toHaveProperty("package")
  })
})
```

- [ ] **Step 4: Run the tests to verify they fail**

Run: `npx vitest run test/v2/model.test.ts`
Expected: FAIL with `Cannot find module '../../src/v2/model.js'`.

- [ ] **Step 5: Implement the mapper**

Create `src/v2/model.ts`:

```ts
import { DEFAULT_CONTEXT_LIMIT, DEFAULT_OUTPUT_LIMIT, RESPONSES_API_PACKAGE_V2 } from "../constants.js"
import type { LiteLLMModel } from "../types.js"
import type { V2ModelCost, V2ModelInfo } from "./context.js"

/**
 * One LiteLLM model as OpenCode 2.x wants it.
 *
 * Mirrors `toModelConfig` for v1 with the differences v2 forces: `limit` and
 * `cost` are mandatory (defaults and an empty array stand in), capability
 * flags move into `capabilities`, and the Responses-API override is a
 * `package` on the model instead of `provider.npm`. Deprecated aliases never
 * reach this function; `applyModelInfo` has already dropped them.
 */
export function toModelInfo(model: LiteLLMModel, providerID: string): V2ModelInfo {
  const context = model.max_input_tokens ?? model.max_tokens ?? DEFAULT_CONTEXT_LIMIT
  const output = model.max_output_tokens ?? model.max_tokens ?? model.max_input_tokens ?? DEFAULT_OUTPUT_LIMIT

  const input = [
    "text",
    ...(model.supports_vision ? ["image"] : []),
    ...(model.supports_pdf_input ? ["pdf"] : []),
  ]

  // Same rule as v1: a missing cache price falls back to the input price, because
  // OpenCode treats a missing cache price as free and that hides most of a
  // session's real cost.
  const cost: V2ModelCost[] =
    model.input_cost_per_million !== undefined && model.output_cost_per_million !== undefined
      ? [
          {
            input: model.input_cost_per_million,
            output: model.output_cost_per_million,
            cache: {
              read: model.cache_read_cost_per_million ?? model.input_cost_per_million,
              write: model.cache_write_cost_per_million ?? model.input_cost_per_million,
            },
          },
        ]
      : []

  const isResponsesAPI = model.mode?.toLowerCase() === "responses"

  return {
    id: model.id,
    modelID: model.id,
    providerID,
    name: model.id,
    ...(isResponsesAPI ? { package: RESPONSES_API_PACKAGE_V2 } : {}),
    capabilities: { tools: model.supports_function_calling ?? true, input, output: ["text"] },
    variants: [],
    time: { released: 0 },
    cost,
    status: "active",
    enabled: true,
    limit: { context, output },
  }
}
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run test/v2/model.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 7: Typecheck and commit**

Run: `npm run typecheck`
Expected: no output, exit 0.

```bash
git add src/constants.ts src/v2/context.ts src/v2/model.ts test/v2/model.test.ts
git commit -m "Map LiteLLM models to the OpenCode 2 model shape"
```

---

### Task 2: v2 compliance module

**Files:**
- Create: `src/v2/compliance.ts`
- Modify: `docs/superpowers/specs/2026-10-02-opencode-v2-support-design.md` (one sentence, see Step 1)
- Test: `test/v2/compliance.test.ts`

**Interfaces:**
- Consumes: `BLOCKED_PROVIDERS`, `DEFAULT_PERMISSION_POLICY`, `CompliancePolicy` from `src/compliance.ts`; `PermissionConfig`, `PermissionCategory`, `PermissionRule as V1Rule` from `src/types.ts`; `ProviderEditor`, `ProviderRecord`, `AgentEditor`, `PermissionRule` from `src/v2/context.ts`.
- Produces: `deniedProviderIDs(records: readonly ProviderRecord[], policy: CompliancePolicy): string[]`, `applyDenyList(editor: ProviderEditor, policy: CompliancePolicy): void`, `toPermissionRules(policy: PermissionConfig): PermissionRule[]`, `applyPermissionRules(editor: AgentEditor, rules: readonly PermissionRule[]): void`.

- [ ] **Step 1: Amend the spec on rule precedence**

OpenCode 2 merges its built-in defaults, the user's config and the agent's own rules into one array; a plugin cannot tell them apart. Skipping "same action + resource" would let v2's built-in `read *.env ask` beat the baseline `deny`. Replace the sentence in the spec's "Permission baseline" bullet that starts with `A rule is skipped when the agent already has one` with:

```
The baseline is appended as-is (only exact duplicates of action + resource + effect are skipped), so it wins over both OpenCode's built-in defaults and a user's rule for the same resource. OpenCode 2 merges defaults and user config into one array, so a plugin cannot leave only the user's rules alone; a project that needs an exception sets `enforce: false`.
```

- [ ] **Step 2: Write the failing tests**

Create `test/v2/compliance.test.ts`:

```ts
import { describe, expect, it } from "vitest"
import { DEFAULT_PERMISSION_POLICY } from "../../src/compliance.js"
import { applyDenyList, applyPermissionRules, deniedProviderIDs, toPermissionRules } from "../../src/v2/compliance.js"
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
  it("denies the blocked providers while they are only auto-loaded", () => {
    const records = [record("opencode", "auto"), record("opencode-go", "auto"), record("anthropic", "auto")]
    expect(deniedProviderIDs(records, enforce)).toEqual(["opencode", "opencode-go"])
  })

  it("keeps a blocked provider the user declared", () => {
    const records = [record("opencode", "enabled"), record("opencode-go", "auto")]
    expect(deniedProviderIDs(records, enforce)).toEqual(["opencode-go"])
  })

  it("adds denyProviders and ignores ids that are not loaded at all", () => {
    const records = [record("anthropic", "auto")]
    expect(deniedProviderIDs(records, { enforce: true, denyProviders: ["anthropic", "missing"] })).toEqual([
      "anthropic",
    ])
  })
})

describe("applyDenyList", () => {
  it("removes exactly the denied providers", () => {
    const editor = new FakeProviderEditor([record("opencode", "auto"), record("work", "enabled")])
    applyDenyList(editor, enforce)
    expect(editor.removed).toEqual(["opencode"])
  })
})

describe("toPermissionRules", () => {
  const rules = toPermissionRules(DEFAULT_PERMISSION_POLICY)

  it("puts the blanket rule first so later rules win", () => {
    expect(rules[0]).toEqual({ action: "*", resource: "*", effect: "ask" })
  })

  it("renames bash to shell and keeps command patterns", () => {
    expect(rules).toContainEqual({ action: "shell", resource: "git status*", effect: "allow" })
    expect(rules).toContainEqual({ action: "shell", resource: "rm *", effect: "ask" })
    expect(rules.some((r) => r.action === "bash")).toBe(false)
  })

  it("translates **/ globs to v2 wildcards and orders each category broad-first", () => {
    const read = rules.filter((r) => r.action === "read")
    expect(read[0]).toEqual({ action: "read", resource: "*", effect: "allow" })
    expect(read).toContainEqual({ action: "read", resource: "*.env", effect: "deny" })
    expect(read).toContainEqual({ action: "read", resource: "*.env.*", effect: "deny" })
    expect(read).toContainEqual({ action: "read", resource: "*_rsa", effect: "deny" })
    expect(read.some((r) => r.resource.includes("**"))).toBe(false)
  })

  it("leaves a category that is a plain blanket rule as one rule", () => {
    expect(toPermissionRules({ edit: "allow" })).toEqual([{ action: "edit", resource: "*", effect: "allow" }])
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
    { action: "*", resource: "*", effect: "ask" },
    { action: "read", resource: "*.env", effect: "deny" },
  ]

  it("appends the rules to every agent", () => {
    const build: AgentRecord = { id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }] }
    const plan: AgentRecord = { id: "plan", permissions: [] }
    applyPermissionRules(editor([build, plan]), rules)
    expect(build.permissions).toEqual([{ action: "*", resource: "*", effect: "allow" }, ...rules])
    expect(plan.permissions).toEqual(rules)
  })

  it("skips a rule the agent already has verbatim", () => {
    const build: AgentRecord = { id: "build", permissions: [{ action: "read", resource: "*.env", effect: "deny" }] }
    applyPermissionRules(editor([build]), rules)
    expect(build.permissions).toEqual([
      { action: "read", resource: "*.env", effect: "deny" },
      { action: "*", resource: "*", effect: "ask" },
    ])
  })
})
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/v2/compliance.test.ts`
Expected: FAIL with `Cannot find module '../../src/v2/compliance.js'`.

- [ ] **Step 4: Implement the module**

Create `src/v2/compliance.ts`:

```ts
import { BLOCKED_PROVIDERS, type CompliancePolicy } from "../compliance.js"
import type { PermissionCategory, PermissionConfig, PermissionRule as V1Rule } from "../types.js"
import type { AgentEditor, PermissionRule, ProviderEditor, ProviderRecord } from "./context.js"

/**
 * The providers to remove: the block list plus `denyProviders`, minus anything
 * the user declared. In OpenCode 2 a provider named in `opencode.json` arrives
 * with `activation: "enabled"`, an auto-loaded one with `"auto"` — that is the
 * same "declaration is approval" signal `config.provider` gave in v1. The
 * plugin's own profiles are added as `"enabled"`, so they are never denied.
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

/**
 * v1 globs are gitignore-style (`**` crosses directories, `*` does not). In
 * v2 `*` matches any characters including `/`, so `**/` collapses into `*`
 * and any run of stars into one.
 */
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
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/v2/compliance.test.ts`
Expected: PASS, 10 tests.

- [ ] **Step 6: Typecheck and commit**

Run: `npm run typecheck`
Expected: exit 0.

```bash
git add src/v2/compliance.ts test/v2/compliance.test.ts docs/superpowers/specs/2026-10-02-opencode-v2-support-design.md
git commit -m "Express the compliance layer as OpenCode 2 transforms"
```

---

### Task 3: v2 adapter (`setup` flow)

**Files:**
- Create: `src/v2/plugin.ts`
- Test: `test/v2/plugin.test.ts`

**Interfaces:**
- Consumes: `NeuronContext`, `ProviderEditor`, `AgentEditor`, `IntegrationEditor`, `Registration`, `V2ModelInfo`, `V2ProviderInfo` (Task 1); `toModelInfo` (Task 1); `applyDenyList`, `applyPermissionRules`, `toPermissionRules` (Task 2); `DiscoveryCache`, `createDiscoveryCache` from `src/plugin.ts`; `parsePluginOptions`; `applyModelInfo`, `emptyModelInfo`; `DEFAULT_PERMISSION_POLICY`; `PROVIDER_PACKAGE_V2`.
- Produces:
  ```ts
  export type V2LogLevel = "info" | "warn" | "error"
  export interface V2Dependencies {
    discoverRawModels: (baseURL: string, apiKey: string | undefined, options: { timeoutMs: number }) => Promise<LiteLLMModel[]>
    fetchModelInfo: (baseURL: string, apiKey: string | undefined, options: { timeoutMs: number }) => Promise<ModelInfo>
    log: (level: V2LogLevel, message: string, extra?: Record<string, unknown>) => void
    cache?: DiscoveryCache
  }
  export type Cleanup = () => Promise<void>
  export async function setupNeuron(ctx: NeuronContext, dependencies: V2Dependencies): Promise<Cleanup>
  export function consoleLogger(): V2Dependencies["log"]
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/v2/plugin.test.ts`:

```ts
import { describe, expect, it, vi } from "vitest"
import { PROVIDER_PACKAGE_V2, RESPONSES_API_PACKAGE_V2 } from "../../src/constants.js"
import type {
  AgentEditor,
  AgentRecord,
  Connection,
  IntegrationEditor,
  KeyCredential,
  NeuronContext,
  ProviderEditor,
  ProviderRecord,
  Registration,
  V2ModelInfo,
  V2ProviderInfo,
} from "../../src/v2/context.js"
import { setupNeuron, type V2Dependencies } from "../../src/v2/plugin.js"

type Credentials = Record<string, KeyCredential>

/**
 * Enough of OpenCode 2's plugin context to run `setupNeuron`. Transform
 * callbacks are replayed on `rebuild()` the way OpenCode replays them, so a
 * callback that is not pure shows up as a test failure.
 */
class FakeContext implements NeuronContext {
  readonly options: Record<string, unknown>
  private readonly providerCallbacks: Array<{ run: (e: ProviderEditor) => void; disposed: boolean }> = []
  private readonly agentCallbacks: Array<(e: AgentEditor) => void> = []
  private readonly integrationCallbacks: Array<(e: IntegrationEditor) => void> = []
  readonly events: Array<{ type: string }> = []
  private eventWaiters: Array<() => void> = []
  private eventsClosed = false
  readonly integrationMethods: Array<{ integrationID: string; label?: string }> = []
  readonly agents: AgentRecord[] = [{ id: "build", permissions: [{ action: "*", resource: "*", effect: "allow" }] }]
  disposals = 0

  constructor(
    options: Record<string, unknown>,
    private credentials: Credentials,
    private readonly catalog: ProviderRecord[] = [],
  ) {
    this.options = options
  }

  setCredentials(credentials: Credentials) {
    this.credentials = credentials
  }

  readonly provider = {
    transform: async (run: (e: ProviderEditor) => void): Promise<Registration> => {
      const entry = { run, disposed: false }
      this.providerCallbacks.push(entry)
      return {
        dispose: async () => {
          entry.disposed = true
          this.disposals += 1
        },
      }
    },
  }

  readonly agent = {
    transform: async (run: (e: AgentEditor) => void): Promise<Registration> => {
      this.agentCallbacks.push(run)
      return { dispose: async () => undefined }
    },
  }

  readonly integration = {
    transform: async (run: (e: IntegrationEditor) => void): Promise<Registration> => {
      this.integrationCallbacks.push(run)
      return { dispose: async () => undefined }
    },
    connection: {
      active: async (id: string): Promise<Connection | undefined> =>
        this.credentials[id] ? { type: "credential" } : undefined,
      resolve: async (_c: Connection) => undefined as KeyCredential | undefined,
    },
  }

  readonly event = {
    subscribe: (options: { signal: AbortSignal }) => {
      const self = this
      return {
        async *[Symbol.asyncIterator]() {
          let index = 0
          while (!options.signal.aborted && !self.eventsClosed) {
            if (index < self.events.length) {
              yield self.events[index++]!
              continue
            }
            await new Promise<void>((resolve) => {
              self.eventWaiters.push(resolve)
              options.signal.addEventListener("abort", () => resolve(), { once: true })
            })
          }
        },
      }
    },
  }

  emit(type: string) {
    this.events.push({ type })
    const waiters = this.eventWaiters
    this.eventWaiters = []
    for (const wake of waiters) wake()
  }

  /** Replays every live transform onto a fresh registry, like OpenCode. */
  rebuild(): { providers: Map<string, { info: V2ProviderInfo; models: V2ModelInfo[] }>; agents: AgentRecord[] } {
    const providers = new Map<string, { info: V2ProviderInfo; models: V2ModelInfo[] }>()
    for (const record of this.catalog) providers.set(record.provider.id, { info: record.provider, models: [...record.models.values()] })
    const editor: ProviderEditor = {
      list: () => [...providers.values()].map((p) => ({ provider: p.info, models: new Map(p.models.map((m) => [m.id, m])) })),
      get: (id) => {
        const p = providers.get(id)
        return p ? { provider: p.info, models: new Map(p.models.map((m) => [m.id, m])) } : undefined
      },
      add: ({ info, models }) => providers.set(info.id, { info, models: [...models] }),
      remove: (id) => void providers.delete(id),
    }
    for (const entry of this.providerCallbacks) if (!entry.disposed) entry.run(editor)

    const agents = this.agents.map((a) => ({ id: a.id, permissions: [...a.permissions] }))
    const agentEditor: AgentEditor = {
      list: () => agents,
      update: (id, update) => {
        const agent = agents.find((a) => a.id === id)
        if (agent) update(agent)
      },
    }
    for (const run of this.agentCallbacks) run(agentEditor)

    this.integrationMethods.length = 0
    const integrationEditor: IntegrationEditor = {
      method: { update: ({ integrationID, method }) => void this.integrationMethods.push({ integrationID, ...(method.label ? { label: method.label } : {}) }) },
    }
    for (const run of this.integrationCallbacks) run(integrationEditor)
    return { providers, agents }
  }
}

function catalog(id: string, activation: V2ProviderInfo["activation"]): ProviderRecord {
  return { provider: { id, name: id, activation, package: "x" }, models: new Map() }
}

const PROFILE = { id: "work", name: "Work", baseURL: "https://proxy.example/v1" }
const noInfo = async () => ({ deprecated: new Set<string>(), cacheCosts: new Map() })

function deps(overrides: Partial<V2Dependencies> = {}): V2Dependencies & { log: ReturnType<typeof vi.fn> } {
  return {
    discoverRawModels: async () => [{ id: "model-a" }],
    fetchModelInfo: noInfo,
    log: vi.fn(),
    ...overrides,
  } as V2Dependencies & { log: ReturnType<typeof vi.fn> }
}

async function flush() {
  for (let i = 0; i < 5; i += 1) await new Promise((r) => setTimeout(r, 0))
}

describe("setupNeuron", () => {
  it("registers a provider with its discovered models and the stored key's connection", async () => {
    const ctx = new FakeContext({ profiles: [PROFILE] }, { work: { type: "key", key: "sk-1", metadata: { baseURL: PROFILE.baseURL } } })
    ctx.integration.connection.resolve = async () => ({ type: "key", key: "sk-1", metadata: { baseURL: PROFILE.baseURL } })
    const discover = vi.fn(async () => [{ id: "model-a" }, { id: "gpt-5", mode: "responses" }])

    const cleanup = await setupNeuron(ctx, deps({ discoverRawModels: discover }))
    const { providers } = ctx.rebuild()

    expect(discover).toHaveBeenCalledWith(PROFILE.baseURL, "sk-1", { timeoutMs: 5_000 })
    const work = providers.get("work")!
    expect(work.info).toEqual({
      id: "work",
      name: "Work",
      activation: "enabled",
      package: PROVIDER_PACKAGE_V2,
      settings: { baseURL: PROFILE.baseURL },
    })
    expect(work.models.map((m) => [m.id, m.package])).toEqual([
      ["model-a", undefined],
      ["gpt-5", RESPONSES_API_PACKAGE_V2],
    ])
    expect(ctx.integrationMethods).toEqual([{ integrationID: "work", label: "API key" }])
    await cleanup()
  })

  it("registers a profile without a key so it can be connected later", async () => {
    const ctx = new FakeContext({ profiles: [PROFILE] }, {})
    const discover = vi.fn(async () => [])

    await setupNeuron(ctx, deps({ discoverRawModels: discover }))
    const { providers } = ctx.rebuild()

    expect(discover).toHaveBeenCalledWith(PROFILE.baseURL, undefined, { timeoutMs: 5_000 })
    expect(providers.get("work")?.models).toEqual([])
    expect(ctx.integrationMethods).toEqual([{ integrationID: "work", label: "API key" }])
  })

  it("disables a profile whose stored key belongs to another proxy", async () => {
    const ctx = new FakeContext({ profiles: [PROFILE] }, { work: { type: "key", key: "sk-1" } })
    ctx.integration.connection.resolve = async () => ({ type: "key", key: "sk-1", metadata: { baseURL: "https://other.example/v1" } })
    const d = deps()

    await setupNeuron(ctx, d)
    const { providers } = ctx.rebuild()

    expect(providers.has("work")).toBe(false)
    expect(ctx.integrationMethods).toEqual([{ integrationID: "work", label: "API key" }])
    expect(d.log).toHaveBeenCalledWith("warn", expect.stringContaining("Credential URL mismatch"), expect.anything())
  })

  it("still registers the provider when discovery fails", async () => {
    const ctx = new FakeContext({ profiles: [PROFILE] }, {})
    const d = deps({
      discoverRawModels: async () => {
        throw new Error("boom")
      },
    })

    await setupNeuron(ctx, d)
    const { providers } = ctx.rebuild()

    expect(providers.get("work")?.models).toEqual([])
    expect(d.log).toHaveBeenCalledWith("warn", expect.stringContaining("Model discovery failed"), expect.anything())
  })

  it("removes blocked providers unless declared and appends the permission baseline", async () => {
    const ctx = new FakeContext({ profiles: [PROFILE] }, {}, [catalog("opencode", "auto"), catalog("opencode-go", "enabled"), catalog("anthropic", "auto")])

    await setupNeuron(ctx, deps())
    const { providers, agents } = ctx.rebuild()

    expect([...providers.keys()].sort()).toEqual(["anthropic", "opencode-go", "work"])
    const build = agents.find((a) => a.id === "build")!
    expect(build.permissions[0]).toEqual({ action: "*", resource: "*", effect: "allow" })
    expect(build.permissions).toContainEqual({ action: "read", resource: "*.env", effect: "deny" })
    expect(build.permissions).toContainEqual({ action: "shell", resource: "git push*", effect: "ask" })
  })

  it("skips the compliance layer and warns when enforce is false", async () => {
    const ctx = new FakeContext({ profiles: [PROFILE], enforce: false }, {}, [catalog("opencode", "auto")])
    const d = deps()

    await setupNeuron(ctx, d)
    const { providers, agents } = ctx.rebuild()

    expect(providers.has("opencode")).toBe(true)
    expect(agents[0]!.permissions).toHaveLength(1)
    expect(d.log).toHaveBeenCalledWith("warn", expect.stringContaining("enforce: false"))
  })

  it("re-discovers after a credential change and disposes the previous registration", async () => {
    const ctx = new FakeContext({ profiles: [PROFILE] }, {})
    const discover = vi.fn(async (_url: string, key: string | undefined) => [{ id: key ? "private-model" : "public-model" }])

    const cleanup = await setupNeuron(ctx, deps({ discoverRawModels: discover }))
    expect(ctx.rebuild().providers.get("work")?.models.map((m) => m.id)).toEqual(["public-model"])

    ctx.setCredentials({ work: { type: "key", key: "sk-1" } })
    ctx.integration.connection.resolve = async () => ({ type: "key", key: "sk-1", metadata: { baseURL: PROFILE.baseURL } })
    ctx.emit("credential.updated")
    await flush()

    expect(discover).toHaveBeenCalledTimes(2)
    expect(ctx.disposals).toBe(1)
    expect(ctx.rebuild().providers.get("work")?.models.map((m) => m.id)).toEqual(["private-model"])
    await cleanup()
  })

  it("serialises overlapping credential events", async () => {
    const ctx = new FakeContext({ profiles: [PROFILE] }, {})
    let inFlight = 0
    let maxInFlight = 0
    const discover = vi.fn(async () => {
      inFlight += 1
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise((r) => setTimeout(r, 5))
      inFlight -= 1
      return [{ id: "m" }]
    })

    const cleanup = await setupNeuron(ctx, deps({ discoverRawModels: discover }))
    ctx.emit("credential.updated")
    ctx.emit("credential.updated")
    await new Promise((r) => setTimeout(r, 40))

    expect(maxInFlight).toBe(1)
    expect(discover).toHaveBeenCalledTimes(3)
    await cleanup()
  })

  it("ignores unrelated events and stops after cleanup", async () => {
    const ctx = new FakeContext({ profiles: [PROFILE] }, {})
    const discover = vi.fn(async () => [{ id: "m" }])

    const cleanup = await setupNeuron(ctx, deps({ discoverRawModels: discover }))
    ctx.emit("session.created")
    await flush()
    expect(discover).toHaveBeenCalledTimes(1)

    await cleanup()
    ctx.emit("credential.updated")
    await flush()
    expect(discover).toHaveBeenCalledTimes(1)
  })

  it("logs configuration errors and registers nothing without profiles", async () => {
    const ctx = new FakeContext({}, {})
    const d = deps()

    await setupNeuron(ctx, d)

    expect(d.log).toHaveBeenCalledWith("warn", expect.stringContaining("profiles must be configured"))
    expect(ctx.rebuild().providers.size).toBe(0)
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/v2/plugin.test.ts`
Expected: FAIL with `Cannot find module '../../src/v2/plugin.js'`.

- [ ] **Step 3: Implement the adapter**

Create `src/v2/plugin.ts`:

```ts
import { DEFAULT_PERMISSION_POLICY } from "../compliance.js"
import { PROVIDER_PACKAGE_V2 } from "../constants.js"
import { applyModelInfo, emptyModelInfo } from "../discovery.js"
import { parsePluginOptions } from "../options.js"
import { createDiscoveryCache, type DiscoveryCache } from "../plugin.js"
import type { LiteLLMModel, ModelInfo, NeuronProfile, ParsedPluginOptions } from "../types.js"
import { applyDenyList, applyPermissionRules, toPermissionRules } from "./compliance.js"
import type { NeuronContext, Registration, V2ModelInfo, V2ProviderInfo } from "./context.js"
import { toModelInfo } from "./model.js"

export type V2LogLevel = "info" | "warn" | "error"

export interface V2Dependencies {
  discoverRawModels: (
    baseURL: string,
    apiKey: string | undefined,
    options: { timeoutMs: number },
  ) => Promise<LiteLLMModel[]>
  fetchModelInfo: (baseURL: string, apiKey: string | undefined, options: { timeoutMs: number }) => Promise<ModelInfo>
  log: (level: V2LogLevel, message: string, extra?: Record<string, unknown>) => void
  cache?: DiscoveryCache
}

export type Cleanup = () => Promise<void>

/** OpenCode 2 routes a plugin's console output into its own log. */
export function consoleLogger(): V2Dependencies["log"] {
  return (level, message, extra) => {
    const line = `[opencode-neuron] ${message}${extra ? ` ${JSON.stringify(extra)}` : ""}`
    if (level === "error") console.error(line)
    else if (level === "warn") console.warn(line)
    else console.log(line)
  }
}

interface ProfileRegistration {
  info: V2ProviderInfo
  models: V2ModelInfo[]
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

async function resolveKey(
  ctx: NeuronContext,
  profile: NeuronProfile,
): Promise<{ apiKey?: string; conflict: boolean }> {
  const connection = await ctx.integration.connection.active(profile.id)
  if (!connection) return { conflict: false }
  const credential = await ctx.integration.connection.resolve(connection)
  if (!credential || credential.type !== "key") return { conflict: false }
  const storedURL = credential.metadata?.baseURL
  if (typeof storedURL === "string" && storedURL !== profile.baseURL) return { conflict: true }
  return { apiKey: credential.key, conflict: false }
}

async function discover(
  profile: NeuronProfile,
  apiKey: string | undefined,
  options: ParsedPluginOptions,
  dependencies: V2Dependencies,
  cache: DiscoveryCache,
): Promise<LiteLLMModel[]> {
  const baseURL = profile.baseURL!
  const key = `${profile.id}|${baseURL}`
  let models = cache.models.get(key)
  if (!models) {
    models = dependencies.discoverRawModels(baseURL, apiKey, { timeoutMs: options.timeoutMs })
    cache.models.set(key, models)
  }
  let info = cache.modelInfo.get(baseURL)
  if (!info) {
    info = dependencies.fetchModelInfo(baseURL, apiKey, { timeoutMs: options.timeoutMs }).catch((error) => {
      dependencies.log("warn", `Model-info lookup failed for ${baseURL}; showing all models, pricing cached tokens like input`, {
        baseURL,
        error: describe(error),
      })
      return emptyModelInfo()
    })
    cache.modelInfo.set(baseURL, info)
  }
  const [discovered, resolvedInfo] = await Promise.all([models, info])
  return applyModelInfo(discovered, resolvedInfo)
}

/**
 * Everything discovery needs to know per profile, computed before the
 * transform so the transform callback itself stays pure.
 */
async function prepareProfiles(
  ctx: NeuronContext,
  options: ParsedPluginOptions,
  dependencies: V2Dependencies,
  cache: DiscoveryCache,
): Promise<ProfileRegistration[]> {
  const results = await Promise.all(
    options.profiles.map(async (profile): Promise<ProfileRegistration | undefined> => {
      let apiKey: string | undefined
      try {
        const resolved = await resolveKey(ctx, profile)
        if (resolved.conflict) {
          dependencies.log("warn", `Credential URL mismatch for ${profile.name}; profile disabled`, {
            providerID: profile.id,
            baseURL: profile.baseURL,
          })
          return undefined
        }
        apiKey = resolved.apiKey
      } catch (error) {
        dependencies.log("warn", `Could not read the credential for ${profile.name}`, {
          providerID: profile.id,
          error: describe(error),
        })
      }

      const info: V2ProviderInfo = {
        id: profile.id,
        name: profile.name,
        activation: "enabled",
        package: PROVIDER_PACKAGE_V2,
        settings: { baseURL: profile.baseURL },
      }
      try {
        const models = await discover(profile, apiKey, options, dependencies, cache)
        dependencies.log("info", `Discovered ${models.length} models for ${profile.name}`, {
          providerID: profile.id,
          baseURL: profile.baseURL,
        })
        return { info, models: models.map((model) => toModelInfo(model, profile.id)) }
      } catch (error) {
        dependencies.log("warn", `Model discovery failed for ${profile.name}`, {
          providerID: profile.id,
          baseURL: profile.baseURL,
          error: describe(error),
        })
        // Registered anyway, with no models: /connect still has to offer the
        // profile so the user can fix the key.
        return { info, models: [] }
      }
    }),
  )
  return results.filter((result): result is ProfileRegistration => result !== undefined)
}

async function registerCompliance(ctx: NeuronContext, options: ParsedPluginOptions, dependencies: V2Dependencies): Promise<Registration[]> {
  if (!options.enforce) {
    dependencies.log("warn", "Neuron compliance layer is disabled via enforce: false")
    return []
  }
  const policy = { enforce: true, denyProviders: options.denyProviders }
  const rules = toPermissionRules(DEFAULT_PERMISSION_POLICY)
  const registrations = [
    await ctx.provider.transform((editor) => applyDenyList(editor, policy)),
    await ctx.agent.transform((editor) => applyPermissionRules(editor, rules)),
  ]
  dependencies.log(
    "info",
    "OpenCode 2 plugins cannot set share or update; the setup command writes share: disabled and update: notify into opencode.json",
  )
  return registrations
}

/**
 * The v2 plugin body. Compliance first, so a broken profile configuration
 * costs the user their models but never their protection; then the profiles;
 * then a subscription that re-runs discovery whenever a credential changes,
 * so `/connect` takes effect without a restart.
 */
export async function setupNeuron(ctx: NeuronContext, dependencies: V2Dependencies): Promise<Cleanup> {
  const options = parsePluginOptions(ctx.options as Record<string, unknown>)
  for (const error of options.errors) dependencies.log("warn", `Invalid Neuron plugin configuration: ${error}`)
  const cache = dependencies.cache ?? createDiscoveryCache()

  const fixed: Registration[] = []
  try {
    fixed.push(...(await registerCompliance(ctx, options, dependencies)))
  } catch (error) {
    dependencies.log("error", "Neuron compliance layer could not be applied", { error: describe(error) })
  }

  if (!options.profiles.length) {
    return async () => {
      for (const registration of fixed) await registration.dispose()
    }
  }

  const profiles = options.profiles
  fixed.push(
    await ctx.integration.transform((editor) => {
      for (const profile of profiles) {
        editor.method.update({ integrationID: profile.id, method: { type: "key", label: "API key" } })
      }
    }),
  )

  let providers: Registration | undefined
  const refresh = async (): Promise<void> => {
    try {
      const prepared = await prepareProfiles(ctx, options, dependencies, cache)
      const next = await ctx.provider.transform((editor) => {
        for (const { info, models } of prepared) editor.add({ info, models })
      })
      const previous = providers
      providers = next
      await previous?.dispose()
    } catch (error) {
      dependencies.log("error", "Neuron model discovery failed", { error: describe(error) })
    }
  }
  await refresh()

  // Serialised: a second event while a refresh runs waits for it, then runs
  // once more against the new credentials.
  let chain: Promise<void> = Promise.resolve()
  const controller = new AbortController()
  void (async () => {
    try {
      for await (const event of ctx.event.subscribe({ signal: controller.signal })) {
        if (event.type !== "credential.updated") continue
        chain = chain.then(async () => {
          if (controller.signal.aborted) return
          cache.models.clear()
          await refresh()
        })
      }
    } catch (error) {
      if (!controller.signal.aborted) dependencies.log("warn", "Credential event stream ended", { error: describe(error) })
    }
  })()

  return async () => {
    controller.abort()
    await chain.catch(() => undefined)
    for (const registration of fixed) await registration.dispose()
    await providers?.dispose()
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/v2/plugin.test.ts`
Expected: PASS, 10 tests. If "serialises overlapping credential events" is flaky on timing, raise the wait from 40 ms to 80 ms; do not loosen the `maxInFlight` assertion.

- [ ] **Step 5: Typecheck, full test run, commit**

Run: `npm run typecheck && npm test`
Expected: both exit 0, all v1 tests unchanged.

```bash
git add src/v2/plugin.ts test/v2/plugin.test.ts
git commit -m "Add the OpenCode 2 plugin adapter with live credential refresh"
```

---

### Task 4: v2 entrypoint, package exports and smoke test

**Files:**
- Create: `src/v2.ts`
- Modify: `package.json` (`exports`, `devDependencies`; `files` unchanged)
- Test: build output check and a manual smoke test against `@opencode/cli@2.0.22`

**Interfaces:**
- Consumes: `setupNeuron`, `consoleLogger` (Task 3); `discoverRawModels`, `fetchModelInfo`; `createDiscoveryCache`; `PLUGIN_ID`.
- Produces: `dist/v2.js` default export `{ id: "neuron", setup }`, resolved by OpenCode 2 through `exports["./server"]`.

- [ ] **Step 1: Add the type-only SDK and the export**

Run: `npm install --save-dev @opencode/plugin@2.0.22`

Edit `package.json` `exports` to:

```json
"exports": {
  ".": {
    "types": "./dist/index.d.ts",
    "import": "./dist/index.js"
  },
  "./server": {
    "types": "./dist/v2.d.ts",
    "import": "./dist/v2.js"
  },
  "./setup": {
    "types": "./dist/setup.d.ts",
    "import": "./dist/setup.js"
  }
}
```

- [ ] **Step 2: Write the entry**

Create `src/v2.ts`:

```ts
/**
 * OpenCode 2.x entrypoint, resolved through `exports["./server"]`.
 *
 * OpenCode 2 tries `<package>/server` before `<package>`, and OpenCode 1
 * only ever imports `<package>`, so the two majors never see each other's
 * module. Keep this file free of a runtime import from `@opencode/plugin`:
 * `Plugin.define` is the identity function and the SDK is a devDependency.
 */
import type { Plugin } from "@opencode/plugin"
import { PLUGIN_ID } from "./constants.js"
import { discoverRawModels, fetchModelInfo } from "./discovery.js"
import { createDiscoveryCache } from "./plugin.js"
import type { NeuronContext } from "./v2/context.js"
import { consoleLogger, setupNeuron } from "./v2/plugin.js"

const plugin: Plugin.Plugin = {
  id: PLUGIN_ID,
  async setup(context) {
    // `NeuronContext` is the structural subset this plugin uses; the SDK's
    // branded ids are not assignable from plain strings, hence the cast.
    return setupNeuron(context as unknown as NeuronContext, {
      discoverRawModels,
      fetchModelInfo,
      log: consoleLogger(),
      cache: createDiscoveryCache(),
    })
  },
}

export default plugin
```

- [ ] **Step 3: Typecheck and build**

Run: `npm run typecheck && npm run build && ls dist/v2.js dist/v2.d.ts && (grep -q "@opencode/plugin" dist/v2.js && echo "RUNTIME IMPORT FOUND" || echo "no runtime import")`
Expected: typecheck and build exit 0, both files listed, last line `no runtime import`. If `tsc` cannot resolve `Plugin.Plugin`, use `import type { Plugin } from "@opencode/plugin"` and the type `Plugin.Plugin` exactly as above; the SDK exports `Plugin` as a namespace with `Plugin` and `Context` types.

- [ ] **Step 4: Smoke test against the real OpenCode 2 binary**

Use the scratchpad environment from the spike (or recreate it):

```bash
S=/private/tmp/claude-502/-Users-tobias-ritscher-Desktop-Projects-04-AI-opencode-litellm-plugin/349a7014-4f25-48bd-8be7-78fc2fb4f557/scratchpad
mkdir -p $S/smoke/home/.config/opencode $S/smoke/home/.local/share $S/smoke/home/.cache $S/smoke/proj
cd $S/smoke/proj && npm init -y >/dev/null && npm install /Users/tobias.ritscher/Desktop/Projects/04_AI/opencode_litellm_plugin >/dev/null
cat > opencode.json <<'EOF'
{
  "plugins": [{ "package": "@noser-engineering/opencode-plugin-neuron", "options": { "profiles": [{ "id": "work", "name": "Work", "baseURL": "https://proxy.invalid/v1" }] } }]
}
EOF
export HOME=$S/smoke/home XDG_CONFIG_HOME=$S/smoke/home/.config XDG_DATA_HOME=$S/smoke/home/.local/share XDG_CACHE_HOME=$S/smoke/home/.cache
$S/v2/node_modules/.bin/opencode run --standalone --print-logs --log-level info --model work/anything "hi" 2>&1 | grep -i "neuron\|plugin\|error" | head -20
$S/v2/node_modules/.bin/opencode plugin list
```

Expected: `plugin list` shows id `neuron` for the package; the run log contains `[opencode-neuron] Model discovery failed for Work` (proxy.invalid does not resolve), the run itself fails because `work` has no models, and there is no `PluginModule.LoadError`. If the local install does not resolve `./server` because npm linked instead of copied, run `npm pack` in the repo and install the tarball.

Record the observed output in the commit message body.

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/v2.ts
git commit -m "Ship an OpenCode 2 entrypoint under the server export"
```

---

### Task 5: Version-aware config in `setup.ts`

**Files:**
- Modify: `src/setup.ts`
- Test: `test/setup.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type OpenCodeMajor = 1 | 2
  export function detectConfigVersion(config: Record<string, unknown>): OpenCodeMajor | undefined
  export function parseOpenCodeVersion(output: string): OpenCodeMajor | undefined
  export function readNeuronConfigEntry(config): NeuronConfigEntry | undefined   // now also reads v2 `plugins`
  export function updateConfigText(text: string, profiles: NeuronProfile[], filePath?: string, version?: OpenCodeMajor): string
  ```
  `updateConfigText` defaults `version` to `1` so every existing call and test keeps its behaviour.

- [ ] **Step 1: Write the failing tests**

Append to `test/setup.test.ts` (keep the existing imports and add `detectConfigVersion`, `parseOpenCodeVersion` to the import from `../src/setup.js`):

```ts
describe("OpenCode 2 config setup", () => {
  it("detects the major from the config shape", () => {
    expect(detectConfigVersion({ plugins: [] })).toBe(2)
    expect(detectConfigVersion({ providers: {} })).toBe(2)
    expect(detectConfigVersion({ permissions: [] })).toBe(2)
    expect(detectConfigVersion({ plugin: [] })).toBe(1)
    expect(detectConfigVersion({ provider: {} })).toBe(1)
    expect(detectConfigVersion({ share: "disabled" })).toBeUndefined()
    // A half-migrated file is treated as v2: that is where new entries go.
    expect(detectConfigVersion({ plugin: [], plugins: [] })).toBe(2)
  })

  it("parses the opencode --version output", () => {
    expect(parseOpenCodeVersion("opencode v2.0.22\n")).toBe(2)
    expect(parseOpenCodeVersion("1.18.30")).toBe(1)
    expect(parseOpenCodeVersion("3.1.0")).toBe(2)
    expect(parseOpenCodeVersion("0.0.0-beta-19271")).toBeUndefined()
    expect(parseOpenCodeVersion("")).toBeUndefined()
  })

  it("reads an existing v2 entry", () => {
    const entry = readNeuronConfigEntry({
      plugins: [
        "opencode-wakatime",
        {
          package: "@noser-engineering/opencode-plugin-neuron",
          options: { profiles: [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }], enforce: false },
        },
      ],
    })
    expect(entry).toEqual({
      packageSpec: "@noser-engineering/opencode-plugin-neuron",
      profiles: [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }],
      rawOptions: { profiles: [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }], enforce: false },
    })
  })

  it("writes an unpinned v2 entry and the two settings a v2 plugin cannot set", () => {
    const updated = updateConfigText("{}\n", [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }], "opencode.json", 2)
    const config = parseConfigText(updated)
    expect(config.plugins).toEqual([
      {
        package: "@noser-engineering/opencode-plugin-neuron",
        options: { profiles: [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }] },
      },
    ])
    expect(config.share).toBe("disabled")
    expect(config.update).toBe("notify")
    expect(config.$schema).toBe("https://opencode.ai/config.json")
    expect(config).not.toHaveProperty("plugin")
  })

  it("leaves share and update alone when the user set them", () => {
    const updated = updateConfigText(
      JSON.stringify({ share: "manual", update: "auto" }),
      [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }],
      "opencode.json",
      2,
    )
    const config = parseConfigText(updated)
    expect(config.share).toBe("manual")
    expect(config.update).toBe("auto")
  })

  it("replaces an existing v2 entry in place and keeps its other options", () => {
    const original = JSON.stringify({
      plugins: [
        "opencode-wakatime",
        { package: "@noser-engineering/opencode-plugin-neuron", options: { profiles: [{ id: "old", name: "Old", baseURL: "https://old.example/v1" }], denyProviders: ["anthropic"] } },
        "another",
      ],
    })
    const updated = updateConfigText(original, [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }], "opencode.json", 2)
    const config = parseConfigText(updated)
    expect(config.plugins).toEqual([
      "opencode-wakatime",
      {
        package: "@noser-engineering/opencode-plugin-neuron",
        options: { denyProviders: ["anthropic"], profiles: [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }] },
      },
      "another",
    ])
  })

  it("migrates a v1 entry into plugins and drops an emptied plugin array", () => {
    const original = `{
  // migrated from v1
  "plugin": [["@noser-engineering/opencode-plugin-neuron@0.4.1", { "profiles": [{ "id": "work", "name": "Work", "baseURL": "https://proxy.example/v1" }], "enforce": false }]],
  "plugins": ["opencode-wakatime"],
}
`
    const updated = updateConfigText(original, [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }], "opencode.jsonc", 2)
    expect(updated).toContain("// migrated from v1")
    const config = parseConfigText(updated)
    expect(config).not.toHaveProperty("plugin")
    expect(config.plugins).toEqual([
      "opencode-wakatime",
      {
        package: "@noser-engineering/opencode-plugin-neuron",
        options: { profiles: [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }], enforce: false },
      },
    ])
  })

  it("keeps unrelated v1 plugins when migrating only our entry", () => {
    const original = JSON.stringify({ plugin: ["opencode-wakatime", "@noser-engineering/opencode-plugin-neuron@0.4.1"] })
    const config = parseConfigText(updateConfigText(original, [{ id: "work", name: "Work", baseURL: "https://proxy.example/v1" }], "opencode.json", 2))
    expect(config.plugin).toEqual(["opencode-wakatime"])
    expect(config.plugins).toHaveLength(1)
  })

  it("rejects a plugins value that is not an array", () => {
    expect(() => updateConfigText(JSON.stringify({ plugins: {} }), [], "opencode.json", 2)).toThrow("plugins must be an array")
  })
})
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/setup.test.ts`
Expected: FAIL; the first failures are missing exports `detectConfigVersion`, `parseOpenCodeVersion`.

- [ ] **Step 3: Implement**

In `src/setup.ts`:

Add after `export type ConfigScope`:

```ts
export type OpenCodeMajor = 1 | 2

const V2_KEYS = ["plugins", "providers", "permissions"] as const
const V1_KEYS = ["plugin", "provider", "permission"] as const

/**
 * Which major wrote this file. A file that already carries v2 keys is v2,
 * even if a v1 key is still around: new entries belong where OpenCode 2 reads
 * them, and the v1 leftover is migrated on write.
 */
export function detectConfigVersion(config: Record<string, unknown>): OpenCodeMajor | undefined {
  if (V2_KEYS.some((key) => config[key] !== undefined)) return 2
  if (V1_KEYS.some((key) => config[key] !== undefined)) return 1
  return undefined
}

/** `opencode --version` prints `opencode v2.0.22` (v2) or `1.18.30` (v1). */
export function parseOpenCodeVersion(output: string): OpenCodeMajor | undefined {
  const match = /(?:^|\D)(\d+)\.\d+\.\d+/.exec(output)
  if (!match) return undefined
  const major = Number(match[1])
  if (major === 0) return undefined
  return major >= 2 ? 2 : 1
}
```

Replace `readNeuronConfigEntry` with a version that reads both shapes (keep `isPackageSpec` and `removeLegacyApiKeyEnv` as they are):

```ts
function entryFromOptions(packageSpec: string, rawOptions: Record<string, unknown>): NeuronConfigEntry {
  const migratedOptions = removeLegacyApiKeyEnv(rawOptions)
  const parsed = parsePluginOptions(migratedOptions)
  if (parsed.errors.length) throw new Error(parsed.errors.join("; "))
  return { profiles: parsed.profiles, rawOptions: migratedOptions, packageSpec }
}

function isV2Entry(entry: unknown): entry is { package: string; options?: unknown } {
  return (
    !!entry &&
    typeof entry === "object" &&
    !Array.isArray(entry) &&
    typeof (entry as { package?: unknown }).package === "string" &&
    isPackageSpec((entry as { package: string }).package)
  )
}

function isV1Entry(entry: unknown): boolean {
  if (typeof entry === "string") return isPackageSpec(entry)
  return Array.isArray(entry) && typeof entry[0] === "string" && isPackageSpec(entry[0])
}

function readV2Entry(config: Record<string, unknown>): NeuronConfigEntry | undefined {
  const plugins = config.plugins
  if (plugins === undefined) return undefined
  if (!Array.isArray(plugins)) throw new Error("plugins must be an array")
  for (const entry of plugins) {
    if (typeof entry === "string" && isPackageSpec(entry)) {
      const parsed = parsePluginOptions()
      return { profiles: parsed.profiles, rawOptions: {}, packageSpec: entry }
    }
    if (!isV2Entry(entry)) continue
    const rawOptions =
      entry.options && typeof entry.options === "object" && !Array.isArray(entry.options)
        ? (entry.options as Record<string, unknown>)
        : {}
    return entryFromOptions(entry.package, rawOptions)
  }
  return undefined
}

function readV1Entry(config: Record<string, unknown>): NeuronConfigEntry | undefined {
  const plugins = config.plugin
  if (plugins === undefined) return undefined
  if (!Array.isArray(plugins)) throw new Error("plugin must be an array")
  for (const entry of plugins) {
    if (typeof entry === "string" && isPackageSpec(entry)) {
      const parsed = parsePluginOptions()
      return { profiles: parsed.profiles, rawOptions: {}, packageSpec: entry }
    }
    if (!Array.isArray(entry) || typeof entry[0] !== "string" || !isPackageSpec(entry[0])) continue
    const rawOptions =
      entry[1] && typeof entry[1] === "object" && !Array.isArray(entry[1])
        ? (entry[1] as Record<string, unknown>)
        : {}
    return entryFromOptions(entry[0], rawOptions)
  }
  return undefined
}

/** The plugin's entry from either config shape; v2 wins when both exist. */
export function readNeuronConfigEntry(config: Record<string, unknown>): NeuronConfigEntry | undefined {
  return readV2Entry(config) ?? readV1Entry(config)
}
```

Rename the existing `updateConfigText` body to `updateConfigTextV1(text, profiles, filePath)` (unchanged logic, using `isV1Entry` where it currently inlines the checks) and add:

```ts
function updateConfigTextV2(text: string, profiles: NeuronProfile[], filePath: string): string {
  const config = parseConfigText(text, filePath)
  const existingEntry = readNeuronConfigEntry(config)
  const plugins = config.plugins === undefined ? [] : config.plugins
  if (!Array.isArray(plugins)) throw new Error(`${filePath}: plugins must be an array`)

  const filtered = plugins.filter((entry) => !(typeof entry === "string" && isPackageSpec(entry)) && !isV2Entry(entry))
  const insertionIndex = plugins.findIndex((entry) => (typeof entry === "string" && isPackageSpec(entry)) || isV2Entry(entry))
  const pluginEntry = {
    package: PACKAGE_NAME,
    options: { ...existingEntry?.rawOptions, profiles: profiles.map(cleanProfile) },
  }
  filtered.splice(insertionIndex >= 0 ? Math.min(insertionIndex, filtered.length) : filtered.length, 0, pluginEntry)

  const formattingOptions = { insertSpaces: true, tabSize: 2, eol: "\n" }
  let updated = text
  const edit = (path: (string | number)[], value: unknown) => {
    updated = applyEdits(updated, modify(updated, path, value, { formattingOptions }))
  }
  if (config.$schema === undefined) edit(["$schema"], CONFIG_SCHEMA)
  edit(["plugins"], filtered)

  // Our v1 entry moves into `plugins`; other people's v1 entries stay where
  // OpenCode 2 still reads them (it accepts `plugin` with a warning).
  if (Array.isArray(config.plugin)) {
    const remaining = config.plugin.filter((entry) => !isV1Entry(entry))
    if (remaining.length !== config.plugin.length) edit(["plugin"], remaining.length ? remaining : undefined)
  }

  // A v2 plugin cannot set these; writing them here is the only way to keep
  // the v1 guarantees. Only when absent: an explicit choice stays an explicit choice.
  if (config.share === undefined) edit(["share"], "disabled")
  if (config.update === undefined) edit(["update"], "notify")
  return `${updated.trimEnd()}\n`
}

export function updateConfigText(
  text: string,
  profiles: NeuronProfile[],
  filePath = "opencode.jsonc",
  version: OpenCodeMajor = 1,
): string {
  return version === 2 ? updateConfigTextV2(text, profiles, filePath) : updateConfigTextV1(text, profiles, filePath)
}
```

`PACKAGE_NAME` is already imported in `setup.ts`. `modify(..., undefined, ...)` removes the property in `jsonc-parser`.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/setup.test.ts`
Expected: PASS, every existing test plus the 9 new ones.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck && npm test`

```bash
git add src/setup.ts test/setup.test.ts
git commit -m "Teach setup to read and write the OpenCode 2 config shape"
```

---

### Task 6: Credential store abstraction

**Files:**
- Create: `src/credential-store.ts`
- Test: `test/credential-store.test.ts`

**Interfaces:**
- Consumes: `StoredApiCredential`, `readAuthStore`, `extractApiCredentials`, `updateApiCredentials` from `src/auth.ts`.
- Produces:
  ```ts
  export interface CredentialStore {
    /** Where keys end up, for the setup summary. */
    readonly description: string
    read(): Promise<Record<string, StoredApiCredential>>
    write(updates: Record<string, StoredApiCredential>, removals: Iterable<string>): Promise<void>
  }
  export type RunOpenCode = (args: string[], stdin?: string) => Promise<string>   // resolves stdout, rejects on non-zero exit
  export class OpenCodeNotFoundError extends Error {}
  export function fileCredentialStore(authPath: string): CredentialStore
  export function opencodeCredentialStore(run: RunOpenCode, label?: (providerID: string) => string): CredentialStore
  export function runOpenCodeBinary(args: string[], stdin?: string): Promise<string>  // execFile("opencode", …); throws OpenCodeNotFoundError on ENOENT
  ```

- [ ] **Step 1: Write the failing tests**

Create `test/credential-store.test.ts`:

```ts
import { mkdtemp, readFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { fileCredentialStore, opencodeCredentialStore, type RunOpenCode } from "../src/credential-store.js"

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

  it("removes the integration's old credentials before creating the new one, active", async () => {
    const run = fakeRun()
    await opencodeCredentialStore(run).write({ work: { key: "sk-new", baseURL: "https://proxy.example/v1" } }, [])
    expect(run.calls.slice(1)).toEqual([
      { args: ["api", "credential.remove", "--standalone", "-d", JSON.stringify({ credentialID: "cred_1" })] },
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
    ])
  })

  it("removes credentials for cleared profiles and nothing else", async () => {
    const run = fakeRun()
    await opencodeCredentialStore(run).write({}, ["work", "unknown"])
    expect(run.calls.slice(1)).toEqual([
      { args: ["api", "credential.remove", "--standalone", "-d", JSON.stringify({ credentialID: "cred_1" })] },
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/credential-store.test.ts`
Expected: FAIL with `Cannot find module '../src/credential-store.js'`.

- [ ] **Step 3: Implement**

Create `src/credential-store.ts`:

```ts
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
        return reject(new Error(`opencode ${args.slice(0, 2).join(" ")} failed: ${stderr.trim() || error.message}`))
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
      for (const entry of existing) {
        if (!touched.has(entry.integrationID)) continue
        await run(["api", "credential.remove", STANDALONE, "-d", JSON.stringify({ credentialID: entry.id })])
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
      }
    },
  }
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/credential-store.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Typecheck and commit**

Run: `npm run typecheck`

```bash
git add src/credential-store.ts test/credential-store.test.ts
git commit -m "Abstract where setup stores API keys for OpenCode 1 and 2"
```

---

### Task 7: Wire version detection and the credential store into the CLI

**Files:**
- Modify: `src/command.ts`
- Test: `test/command.test.ts`

**Interfaces:**
- Consumes: `OpenCodeMajor`, `detectConfigVersion`, `parseOpenCodeVersion`, `updateConfigText(…, version)` (Task 5); `CredentialStore`, `fileCredentialStore`, `opencodeCredentialStore`, `runOpenCodeBinary`, `OpenCodeNotFoundError`, `RunOpenCode` (Task 6).
- Produces:
  ```ts
  export interface CliArgs { …; opencodeVersion?: OpenCodeMajor }          // new flag --opencode-version 1|2
  export interface SetupState { configPath; configText; profiles; version: OpenCodeMajor; credentials: CredentialStore; storedCredentials; credentialUpdates; credentialRemovals }
  export interface VersionProbe { configVersion?: OpenCodeMajor; binaryOutput: () => Promise<string | undefined>; ask: () => Promise<OpenCodeMajor> }
  export async function resolveOpenCodeVersion(args: CliArgs, probe: VersionProbe): Promise<OpenCodeMajor>
  export function chooseCredentialStore(version: OpenCodeMajor, authPath: string, run?: RunOpenCode): Promise<CredentialStore>
  ```
  `authPath` leaves `SetupState` (it is inside the file store now). Update `emptyState()` in `test/command.test.ts` accordingly.

- [ ] **Step 1: Write the failing tests**

In `test/command.test.ts`, change `emptyState()` to:

```ts
function emptyState(): SetupState {
  return {
    configPath: "opencode.jsonc",
    configText: "{}\n",
    profiles: [],
    version: 1,
    credentials: {
      description: "memory",
      read: async () => ({}),
      write: async () => undefined,
    },
    storedCredentials: {},
    credentialUpdates: {},
    credentialRemovals: new Set<string>(),
  }
}
```

Add `chooseCredentialStore`, `resolveOpenCodeVersion` to the import from `../src/command.js`, and `OpenCodeNotFoundError` from `../src/credential-store.js`. Append:

```ts
describe("parseArgs --opencode-version", () => {
  it("accepts 1 and 2", () => {
    expect(parseArgs(["setup", "--opencode-version", "2"]).opencodeVersion).toBe(2)
    expect(parseArgs(["setup", "--opencode-version=1"]).opencodeVersion).toBe(1)
  })

  it("rejects anything else", () => {
    expect(() => parseArgs(["setup", "--opencode-version", "3"])).toThrow("--opencode-version must be 1 or 2")
    expect(() => parseArgs(["setup", "--opencode-version", "v2"])).toThrow("--opencode-version must be 1 or 2")
  })
})

describe("resolveOpenCodeVersion", () => {
  const noAsk = async (): Promise<1 | 2> => {
    throw new Error("should not ask")
  }

  it("prefers the flag", async () => {
    const binary = vi.fn(async () => "opencode v2.0.22")
    expect(await resolveOpenCodeVersion({ help: false, keyStdin: false, opencodeVersion: 1 }, { configVersion: 2, binaryOutput: binary, ask: noAsk })).toBe(1)
    expect(binary).not.toHaveBeenCalled()
  })

  it("then the config shape", async () => {
    expect(await resolveOpenCodeVersion({ help: false, keyStdin: false }, { configVersion: 1, binaryOutput: async () => "opencode v2.0.22", ask: noAsk })).toBe(1)
  })

  it("then the binary", async () => {
    expect(await resolveOpenCodeVersion({ help: false, keyStdin: false }, { binaryOutput: async () => "opencode v2.0.22", ask: noAsk })).toBe(2)
    expect(await resolveOpenCodeVersion({ help: false, keyStdin: false }, { binaryOutput: async () => "1.18.30", ask: noAsk })).toBe(1)
  })

  it("asks when nothing else knows", async () => {
    const ask = vi.fn(async (): Promise<1 | 2> => 2)
    expect(await resolveOpenCodeVersion({ help: false, keyStdin: false }, { binaryOutput: async () => undefined, ask })).toBe(2)
    expect(ask).toHaveBeenCalledTimes(1)
  })
})

describe("chooseCredentialStore", () => {
  it("uses auth.json for OpenCode 1 without probing the binary", async () => {
    const run = vi.fn()
    const store = await chooseCredentialStore(1, "/tmp/auth.json", run)
    expect(store.description).toBe("/tmp/auth.json")
    expect(run).not.toHaveBeenCalled()
  })

  it("uses the opencode CLI for OpenCode 2", async () => {
    const run = vi.fn(async () => JSON.stringify({ data: [] }))
    const store = await chooseCredentialStore(2, "/tmp/auth.json", run)
    expect(store.description).toContain("opencode api credential")
    expect(await store.read()).toEqual({})
  })

  it("falls back to auth.json when the binary is missing", async () => {
    const run = vi.fn(async () => {
      throw new OpenCodeNotFoundError()
    })
    const writes: string[] = []
    const original = process.stdout.write.bind(process.stdout)
    process.stdout.write = ((chunk: string) => {
      writes.push(String(chunk))
      return true
    }) as typeof process.stdout.write
    try {
      const store = await chooseCredentialStore(2, "/tmp/auth.json", run)
      expect(store.description).toBe("/tmp/auth.json")
    } finally {
      process.stdout.write = original
    }
    expect(writes.join("")).toContain("imports auth.json only on its first start")
  })
})

import { vi } from "vitest"
```

Move the `vi` import up into the existing `import { describe, expect, it } from "vitest"` line instead of the trailing import.

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/command.test.ts`
Expected: FAIL; TypeScript complains about `authPath` / `version` in `emptyState()` and missing exports.

- [ ] **Step 3: Implement**

In `src/command.ts`:

Imports: replace the `auth.js` import with `import { resolveAuthPath } from "./auth.js"` plus `import type { StoredApiCredential } from "./auth.js"`; add

```ts
import {
  fileCredentialStore,
  OpenCodeNotFoundError,
  opencodeCredentialStore,
  runOpenCodeBinary,
  type CredentialStore,
  type RunOpenCode,
} from "./credential-store.js"
```

and extend the `./setup.js` import with `detectConfigVersion, parseOpenCodeVersion, type OpenCodeMajor`.

Flags: add `"--opencode-version"` to `VALUE_FLAGS`, `opencodeVersion?: OpenCodeMajor` to `CliArgs`, and in the value-flag branch of `parseArgs`:

```ts
      if (flag === "--name") args.name = value
      else if (flag === "--url") args.url = value
      else if (flag === "--opencode-version") {
        if (value !== "1" && value !== "2") throw new Error("--opencode-version must be 1 or 2")
        args.opencodeVersion = value === "2" ? 2 : 1
      } else args.key = value
```

Add to `usage()` under Options:

```
  --opencode-version <1|2>  Which OpenCode major to configure; detected otherwise
```

Version resolution and store choice:

```ts
export interface VersionProbe {
  configVersion?: OpenCodeMajor
  binaryOutput: () => Promise<string | undefined>
  ask: () => Promise<OpenCodeMajor>
}

/** Flag, then the config file's own shape, then `opencode --version`, then the user. */
export async function resolveOpenCodeVersion(args: CliArgs, probe: VersionProbe): Promise<OpenCodeMajor> {
  if (args.opencodeVersion) return args.opencodeVersion
  if (probe.configVersion) return probe.configVersion
  const fromBinary = parseOpenCodeVersion((await probe.binaryOutput()) ?? "")
  if (fromBinary) return fromBinary
  return probe.ask()
}

async function binaryVersionOutput(run: RunOpenCode): Promise<string | undefined> {
  try {
    return await run(["--version"])
  } catch {
    return undefined
  }
}

export async function chooseCredentialStore(
  version: OpenCodeMajor,
  authPath: string,
  run: RunOpenCode = runOpenCodeBinary,
): Promise<CredentialStore> {
  if (version === 1) return fileCredentialStore(authPath)
  const store = opencodeCredentialStore(run)
  try {
    await store.read()
    return store
  } catch (error) {
    if (!(error instanceof OpenCodeNotFoundError)) throw error
    process.stdout.write(
      "[warn] opencode is not on PATH; writing the key to auth.json instead. OpenCode 2 imports auth.json only on its first start, so run `opencode auth login` if the key does not show up.\n",
    )
    return fileCredentialStore(authPath)
  }
}
```

`SetupState`: replace `authPath: string` with `version: OpenCodeMajor` and `credentials: CredentialStore`. `loadState`:

```ts
async function loadState(scope: ConfigScope, args: CliArgs, prompts?: PromptPort): Promise<SetupState> {
  const configPath = await resolveConfigPath(scope)
  const configText = await readConfigText(configPath)
  const config = parseConfigText(configText, configPath)
  const version = await resolveOpenCodeVersion(args, {
    ...(detectConfigVersion(config) ? { configVersion: detectConfigVersion(config) } : {}),
    binaryOutput: () => binaryVersionOutput(runOpenCodeBinary),
    ask: async () => {
      if (!prompts) throw new Error("Could not detect the OpenCode version; pass --opencode-version 1 or 2")
      return (await prompts.select("Which OpenCode version is installed?", ["OpenCode 2.x", "OpenCode 1.x"])) === 0 ? 2 : 1
    },
  })
  const credentials = await chooseCredentialStore(version, resolveAuthPath())
  return {
    configPath,
    configText,
    profiles: [...(readNeuronConfigEntry(config)?.profiles ?? [])],
    version,
    credentials,
    storedCredentials: await credentials.read(),
    credentialUpdates: {},
    credentialRemovals: new Set<string>(),
  }
}
```

`persist`:

```ts
async function persist(state: SetupState): Promise<void> {
  await writeConfigText(
    state.configPath,
    updateConfigText(state.configText, state.profiles, state.configPath, state.version),
  )
  if (Object.keys(state.credentialUpdates).length || state.credentialRemovals.size) {
    await state.credentials.write(state.credentialUpdates, state.credentialRemovals)
  }
  const count = state.profiles.length
  process.stdout.write(`\n[ok] Configured ${count} LiteLLM profile${count === 1 ? "" : "s"} for OpenCode ${state.version}.x.\n`)
  if (state.version === 1) process.stdout.write(`Plugin pinned to ${PINNED_PACKAGE_SPEC}; rerun setup to update.\n`)
  else process.stdout.write("Plugin added unpinned; `opencode plugin update` picks up new versions.\n")
  process.stdout.write(`API keys: ${state.credentials.description}\n`)
  process.stdout.write("Quit and restart OpenCode, then use /models to select a model.\n")
}
```

Call sites: `runNonInteractive` calls `loadState(args.scope!, args)`; `runInteractive` calls `loadState(scope, args, prompts)`. `applyCredential`, `reusableStoredKey`, `configureProfile` are unchanged (they only touch `storedCredentials`, `credentialUpdates`, `credentialRemovals`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/command.test.ts`
Expected: PASS, all existing tests plus the 10 new ones.

- [ ] **Step 5: Full check and commit**

Run: `npm run check`
Expected: typecheck, all tests, build green.

```bash
git add src/command.ts test/command.test.ts
git commit -m "Detect the OpenCode major in setup and store keys where it reads them"
```

- [ ] **Step 6: Manual end-to-end against OpenCode 2**

Reuse the smoke environment from Task 4 (`$S/smoke`, env vars exported). Build and run the CLI from the repo:

```bash
cd /Users/tobias.ritscher/Desktop/Projects/04_AI/opencode_litellm_plugin && npm run build
PATH=$S/v2/node_modules/.bin:$PATH node dist/cli.js setup --global --name "Smoke" --url https://proxy.invalid/v1 --key sk-smoke 2>&1 | tail -8
cat $S/smoke/home/.config/opencode/opencode.json
PATH=$S/v2/node_modules/.bin:$PATH opencode auth list --standalone
```

Expected: the connection test fails (`proxy.invalid`) and setup aborts with `Connection test failed; nothing was written`. Re-run with `--key` omitted and `NEURON_API_KEY` unset so no key is tested: the config shows a `plugins` entry with `package` and `options.profiles`, `share: "disabled"`, `update: "notify"`, and the summary says `OpenCode 2.x`. Then store a key through the store directly to prove the CLI path works:

```bash
PATH=$S/v2/node_modules/.bin:$PATH node -e '
import("./dist/credential-store.js").then(async (m) => {
  const s = m.opencodeCredentialStore(m.runOpenCodeBinary)
  await s.write({ smoke: { key: "sk-smoke", baseURL: "https://proxy.invalid/v1" } }, [])
  console.log(await s.read())
})'
PATH=$S/v2/node_modules/.bin:$PATH opencode auth list --standalone
```

Expected: `{ smoke: { key: 'sk-smoke', baseURL: 'https://proxy.invalid/v1' } }` and `auth list` shows `Smoke … stored`. Note the result in the Task 8 CHANGELOG entry if anything deviated.

---

### Task 8: Documentation and changelog

**Files:**
- Modify: `README.md`
- Modify: `CHANGELOG.md`
- Modify: `MITARBEITER-SETUP.md`

- [ ] **Step 1: README**

Add a section `## OpenCode 2.x` after `## Setup` with this content (adjust wording to the README's voice, keep every fact):

```markdown
## OpenCode 2.x

The package ships two entrypoints. OpenCode 1.x loads `.` (the `plugin` config key, pinned version). OpenCode 2.x loads `./server` (the `plugins` config key, unpinned; `opencode plugin update` picks up new versions). The setup command detects the installed major from the config file, then from `opencode --version`, and asks if neither tells; `--opencode-version 1|2` overrides.

What changes on OpenCode 2:

- API keys live in OpenCode's credential store, not in `auth.json`. Setup writes them through the `opencode` CLI, so it has to be on `PATH`; otherwise setup falls back to `auth.json`, which OpenCode 2 imports only on its very first start. You can also connect a profile from inside OpenCode with `/connect`; the plugin picks the key up without a restart.
- A key stored for a profile whose URL changed is ignored, with a warning in the log, exactly as before.
- The compliance layer removes OpenCode Zen (`opencode`, `opencode-go`) and any `denyProviders` entry unless the provider is declared under `providers` in `opencode.json`, and appends the permission baseline to every agent (`bash` is `shell` in v2). OpenCode 2 merges built-in defaults and your own `permissions` into one list, so the baseline also overrides a conflicting rule of yours for the same resource; set `enforce: false` if a project needs that.
- A v2 plugin cannot set `share` or `update`. Setup writes `"share": "disabled"` and `"update": "notify"` into the config it edits, only when they are absent. Removing them is your call, and the plugin will not put them back.
```

Also update the existing "Declaring a provider is how you approve it" example to show both shapes:

```json
// OpenCode 1.x
{ "provider": { "opencode": {} } }
// OpenCode 2.x
{ "providers": { "opencode": {} } }
```

- [ ] **Step 2: CHANGELOG**

Add at the top of `CHANGELOG.md`:

```markdown
## Unreleased (0.5.0)

- OpenCode 2.x support through a second entrypoint (`exports["./server"]`). OpenCode 1.x keeps loading the unchanged v1 entry.
- Setup detects the installed OpenCode major (`--opencode-version` overrides), writes the matching config shape, migrates an existing v1 `plugin` entry into `plugins`, and stores API keys through `opencode api credential.*` on v2.
- On OpenCode 2 the plugin re-runs discovery when a credential changes, so `/connect` works without a restart.
- Compliance on OpenCode 2: Zen is removed via a provider transform unless declared under `providers`; the permission baseline is appended to every agent; `share: "disabled"` and `update: "notify"` are written by setup because a v2 plugin cannot set them.
```

- [ ] **Step 3: MITARBEITER-SETUP.md**

Add this paragraph directly after the setup command:

```markdown
**OpenCode 2.x:** Das Setup erkennt die installierte Version automatisch (`--opencode-version 1|2` erzwingt sie). Damit der API-Key gespeichert wird, muss `opencode` im `PATH` liegen; fehlt es, landet der Key in `auth.json`, das OpenCode 2 nur beim allerersten Start übernimmt. Alternativ in OpenCode `/connect` ausführen und das Profil wählen, der Key wird ohne Neustart übernommen. Updates des Plugins holt `opencode plugin update`.
```

- [ ] **Step 4: Final check and commit**

Run: `npm run check`
Expected: green.

```bash
git add README.md CHANGELOG.md MITARBEITER-SETUP.md
git commit -m "Document OpenCode 2 support and the setup differences"
```

Do not bump the version or publish; that is the manual release step.
