# OpenCode v2 support — design

Date: 02.10.2026. Target: `@noser-engineering/opencode-plugin-neuron` 0.5.0.

## Goal

The plugin runs on OpenCode 2.x (released 20.09.2026) without dropping OpenCode 1.x. Both halves of its purpose survive the move: model discovery from LiteLLM profiles, and the compliance layer that blocks OpenCode Zen, pins tool permissions and turns off sharing and auto-update.

## Verified facts about OpenCode 2.0.22

All of these were checked against the `@opencode/cli@2.0.22` binary, not only the docs.

- **Entrypoint resolution.** For an npm plugin package v2 resolves `<pkg>/server` first and falls back to `<pkg>`. A package can therefore ship a v1 entry at `exports["."]` and a v2 entry at `exports["./server"]`. v1 only ever imports `.`.
- **v1 loader.** OpenCode 1.18.30 calls every module export and throws `Plugin export is not a function` for an object export without a `server()` function. A `{ id, setup }` default export in the v1 entry would break the plugin on v1. Object exports with `server()` work from 1.18.29 only. Separate entries avoid the issue for every v1 version.
- **Plugin shape.** `import { Plugin } from "@opencode/plugin"; export default Plugin.define({ id, async setup(ctx) {} })`. `Plugin.define` is the identity function. Options come from `ctx.options`; logging is `console.*`.
- **Providers.** `ctx.provider.transform(editor => …)`. `editor.list()` returns `{ provider: Provider.Info, models: Map }`. Providers declared in `opencode.json` have `activation: "enabled"`; auto-loaded catalog providers have `"auto"`. `editor.add({ info, models })`, `editor.remove(id)`, `editor.get(id)` work. Transform callbacks are replayed several times per process and must be pure.
- **Provider.Info.** `{ id, name, activation, package, settings?: { baseURL, … }, headers?, body? }`. OpenAI-compatible package is `@opencode/ai/providers/openai-compatible`, the Responses-API package is `@opencode/ai/providers/openai`. A model may carry its own `package`.
- **Model.Info.** `{ id, modelID, providerID, name, capabilities: { tools, input[], output[] }, variants: [], time: { released }, cost: [{ input, output, cache: { read, write } }], status: "active" | "deprecated" | …, enabled, limit: { context, output, input? }, package?, compatibility? }`. Costs are USD per million tokens.
- **Credentials.** Stored in SQLite, not `auth.json`. A DB migration imports a v1 `auth.json` exactly once (type `api` → `{ type: "key", key, metadata }`, metadata preserved). Non-interactive storage: `opencode auth import --standalone` reading the `auth export` JSON array from stdin, or `opencode api credential.create --standalone -d '{…}'`. Interactive `auth login --method key` refuses without a TTY. A plugin reads a key via `ctx.integration.connection.active(integrationID)` and `ctx.integration.connection.resolve(connection)` → `{ type: "key", key, metadata: { baseURL } }`.
- **Integrations.** `ctx.integration.transform(e => e.method.update({ integrationID, method: { type: "key", label } }))` makes a plugin provider appear in `/connect`.
- **Permissions.** Config key `permissions` is an ordered array `{ action, resource, effect }`, last match wins, `*` matches `/`. Actions: `read`, `edit`, `shell` (was `bash`), `glob`, `grep`, `subagent`, … Agents carry their own `permissions` array; `ctx.agent.transform(e => e.update(id, a => a.permissions.push(rule)))` works, and `ctx.agent.list()` reflects it. `ctx.permission.hook("evaluate", …)` exists but is not needed.
- **Config renames.** `plugin` → `plugins` (`{ package, options }`), `provider` → `providers`, `permission` → `permissions`, `autoupdate` → `update` (`"auto" | "notify" | "disable"`), `disabled_providers` removed (migrated internally to `experimental.policies`). `share` unchanged. File locations unchanged (`~/.config/opencode/opencode.json(c)`, `<project>/opencode.json(c)`, `<project>/.opencode/opencode.json(c)`).
- **Plugin packages.** v2 has `opencode plugin check|update`. Pinning the version is no longer needed to get updates.
- **Events.** `for await (const ev of ctx.event.subscribe({ signal }))`; `credential.updated` fires when a key is stored.

## Approach

Separate entrypoints, shared core.

```
exports["."]         → dist/index.js   (v1, unchanged behaviour)
exports["./server"]  → dist/v2.js      (v2, Plugin.define)
```

Rejected: a single `{ id, setup, server }` default export (breaks v1 < 1.18.29 and the existing named export); a v2-only release.

## Package layout

```
src/
  index.ts          v1 entry, unchanged
  plugin.ts         v1 adapter, unchanged
  compliance.ts     v1 compliance + shared policy data (BLOCKED_PROVIDERS, DEFAULT_PERMISSION_POLICY)
  discovery.ts      shared
  options.ts        shared
  auth.ts           v1 auth.json access, still used by setup fallback
  v2.ts             v2 entry: Plugin.define({ id: "neuron", setup })
  v2/
    context.ts      structural types for the slice of ctx we use (no SDK import at runtime)
    model.ts        LiteLLMModel → Model.Info
    compliance.ts   deny transform + agent permission rules
    plugin.ts       setup flow, injected dependencies, caches
  setup.ts          config read/write, now version-aware
  command.ts        CLI flow, version detection, credential storage
```

`@opencode/plugin` joins `devDependencies` for types only. `jsonc-parser` stays the single runtime dependency. `tsconfig` unchanged; `dist/v2.js` is produced by the same `tsc` run.

## v2 adapter (`setup`)

Dependencies are injected like in v1 (`discoverRawModels`, `fetchModelInfo`, `now`, logger), with a `DiscoveryCache` per plugin load.

1. `parsePluginOptions(ctx.options)`; each error → `console.warn("[opencode-neuron] …")`.
2. For every profile: `connection.active(profile.id)`. No connection → discover without key (public `/v1/models` may still answer). Connection present → `resolve()`; `metadata.baseURL` set and different from the profile URL → profile disabled with a warning, same rule as v1.
3. Discovery exactly as v1 (`discoverModelsOnce`, `modelInfoOnce`, `applyModelInfo`). Failures are logged, the profile is still registered with zero models so `/connect` can offer it.
4. `ctx.provider.transform(editor => editor.add({ info, models }))` with the cached result. `info = { id, name, activation: "enabled", package: PROVIDER_NPM_V2, settings: { baseURL } }`. Models with `mode: "responses"` get `package: RESPONSES_API_NPM_V2` on the model.
5. `ctx.integration.transform(e => e.method.update({ integrationID: profile.id, method: { type: "key", label: "API key" } }))` per profile.
6. Compliance (next section), always, even when discovery failed.
7. `credential.updated` subscription: re-run steps 2–4, `dispose()` the previous provider registration before adding the new one. Setup returns a cleanup that aborts the subscription and disposes registrations.

Mapping `LiteLLMModel → Model.Info`:

| LiteLLM | Model.Info |
| --- | --- |
| `id` | `id`, `modelID`, `name` |
| `supports_function_calling` | `capabilities.tools` (default `true`, as in v1) |
| `supports_vision` / `supports_pdf_input` | `capabilities.input` adds `image` / `pdf` |
| `*_cost_per_million` | `cost[0]` (`cache.read` falls back to `input`, `cache.write` to `input`, as v1) |
| `max_input_tokens` / `max_tokens` / `max_output_tokens` | `limit.context` / `limit.output` (v1 defaults kept) |
| deprecated (from `/model/info`) | filtered out, as v1 |
| `mode === "responses"` | `package: RESPONSES_API_NPM_V2` |

Fixed: `variants: []`, `time: { released: 0 }`, `status: "active"`, `enabled: true`.

## Compliance in v2

- **Deny list.** One `provider.transform` that removes every id in `BLOCKED_PROVIDERS ∪ denyProviders` whose `activation !== "enabled"`. Declared providers (including `opencode` when the user wrote `providers.opencode`) stay, same "declaration is approval" rule as v1. The plugin's own profiles are added with `activation: "enabled"` and are never removed.
- **Permission baseline.** `DEFAULT_PERMISSION_POLICY` is translated once into v2 rules and appended to every agent via `ctx.agent.transform`. `bash` → `shell`; `**/` prefixes become `*` (v2 `*` crosses `/`); `rule` values map 1:1 (`allow | ask | deny`). The baseline is appended as-is (only exact duplicates of action + resource + effect are skipped), so it wins over both OpenCode's built-in defaults and a user's rule for the same resource. OpenCode 2 merges defaults and user config into one array, so a plugin cannot leave only the user's rules alone; a project that needs an exception sets `enforce: false`.
- **share / update.** Not settable from a v2 plugin. The setup CLI writes `"share": "disabled"` and `"update": "notify"` into the config it edits, only when the key is absent. The plugin logs a warning at setup when `enforce` is on and it cannot verify these (it has no config access), pointing to the README.
- `enforce: false` skips the deny transform and the permission rules, with the same warning as v1.

## Setup CLI

- **Version detection**, in order: `--opencode-version 1|2` flag; then `opencode --version` on `PATH` parsing to a major (an upgraded user still has a v1-shaped config); then the config shape (`plugins`/`providers` → v2, `plugin`/`provider` → v1); otherwise ask. When binary and config shape disagree, setup prints an `[info]` line and follows the binary.
- **v2 config entry.** `plugins: [{ package: PACKAGE_NAME, options }]`, unpinned. An existing v1 `plugin` entry for this package (string or tuple, pinned or not) is migrated into `plugins` and removed from `plugin`. Existing `apiKeyEnv` cleanup stays.
- **v2 extras** written when absent: `share: "disabled"`, `update: "notify"`.
- **v1 path** unchanged, including pinning.
- **Credential storage v2.** `opencode api credential.list/create/remove --standalone`, body passed via `-d` (the only way in 2.0.22; no stdin). Create-then-remove: the new active credential is created first, then older ones for that integration are removed, so a failed create keeps the old key. Label `Neuron (<profile name>)`. `read()` prefers the active credential. Binary cannot be run (not found, or a spawn error such as `EINVAL` for the Windows npm shim) → write `auth.json` as before and print a warning that v2 imports this file only on its first start.
- Key verification against `/v1/models` unchanged.

## Tests

- `test/v2/model.test.ts`: mapping table above, Responses-API override, deprecated filtering.
- `test/v2/compliance.test.ts`: deny removes `opencode` and `opencode-go` when `auto`, keeps them when `enabled`; `denyProviders` honoured; permission rules translated, appended once, `bash` → `shell`.
- `test/v2/plugin.test.ts` with a fake context (editors backed by Maps, `connection` stub, async-iterable event stub): providers and models registered; two profiles on one proxy isolated; baseURL mismatch disables the profile; discovery failure still registers provider and compliance; `credential.updated` re-discovers and disposes the old registration; `enforce: false` logs and skips.
- `test/setup.test.ts`: v1 and v2 config shapes, v1 → v2 migration of the plugin entry, `share`/`update` only added when absent, version detection from config and from a stubbed `opencode --version`.
- `test/command.test.ts`: `auth import` invocation (spawn mocked) and the `auth.json` fallback.
- Manual smoke test against `@opencode/cli@2.0.22` with a scratch `HOME`, as done during the spike: plugin loads, profile appears in `/connect`, models usable, Zen gone.

## Documentation

- README: "OpenCode 2.x" section (install, `/connect`, what compliance can and cannot do in v2, `share`/`update` written by setup), compatibility table (v1 any version via `.`, v2 via `./server`).
- CHANGELOG 0.5.0.
- MITARBEITER-SETUP.md: v2 notes.

## Out of scope

- TUI plugin (`./tui`).
- Replacing v1 code paths or dropping v1.
- Live re-discovery on config changes other than credentials.
