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
