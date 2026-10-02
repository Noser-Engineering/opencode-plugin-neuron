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

  it("re-fetches model info after a credential change", async () => {
    const ctx = new FakeContext({ profiles: [PROFILE] }, {})
    const fetchInfo = vi.fn(async (_url: string, key: string | undefined) => {
      if (!key) throw new Error("401")
      return { deprecated: new Set(["old"]), cacheCosts: new Map() }
    })

    const cleanup = await setupNeuron(ctx, deps({ discoverRawModels: async () => [{ id: "old" }, { id: "new" }], fetchModelInfo: fetchInfo }))
    expect(ctx.rebuild().providers.get("work")?.models.map((m) => m.id)).toEqual(["old", "new"])

    ctx.setCredentials({ work: { type: "key", key: "sk-1" } })
    ctx.integration.connection.resolve = async () => ({ type: "key", key: "sk-1", metadata: { baseURL: PROFILE.baseURL } })
    ctx.emit("credential.updated")
    await flush()

    expect(fetchInfo).toHaveBeenCalledTimes(2)
    expect(ctx.rebuild().providers.get("work")?.models.map((m) => m.id)).toEqual(["new"])
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
