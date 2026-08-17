# Changelog

## 0.3.10

### Fixed: setup now pins the plugin version, so OpenCode actually picks up updates

OpenCode installs a plugin spec into `~/.cache/opencode/packages` once and
never updates it — even an unversioned spec or `@latest` stays at whatever
version was current on first install. Anyone who set up before now has been
running the plugin version from their first setup, regardless of releases
since (which is why 0.3.7's deprecated-model filtering never reached
configs set up earlier).

`setup` now writes an exact pin (`@noser-engineering/opencode-plugin-neuron@<version>`
of the CLI that is running) instead of the bare package name, and moves any
existing pin along. A changed spec is the one thing OpenCode's cache treats
as new, so rerunning setup — which npx serves at the latest version — is now
also the update path. One-time fix for existing installs: rerun setup, or
delete `~/.cache/opencode/packages/@noser-engineering` and restart OpenCode.

## 0.3.9

### Fixed: the deprecation check could silently fail open, showing removed models

The `/v1/model/info` call that filters out models marked `model_info.deprecated: true`
ran once per configured profile, all fired at once on OpenCode startup. If a
proxy hosts several profiles, that's a burst of concurrent requests to the
same host, and a failed one — whether from load, a permission gap, or a
timeout — used to fail open without a trace: no log entry, deprecated models
just stayed visible. The deprecation lookup is now cached once per proxy URL
instead of once per profile, and a failure is logged
(`Deprecated-model lookup failed for <url>; showing all models`) instead of
disappearing silently.

## 0.3.8

### Fixed: the agent loop stopped after one tool call on Responses-only models

A model whose LiteLLM deployment only implements `/v1/responses` returned
`finish_reason: stop` right after its first tool call under the plugin's
hard-coded `@ai-sdk/openai-compatible` adapter (`/v1/chat/completions`),
indistinguishable to OpenCode from the model genuinely being done. A model
reporting `mode: "responses"` now gets `@ai-sdk/openai` as a per-model
provider override instead, leaving the rest of the profile — including a mix
of both kinds of models under one proxy — on the previous default.

## 0.3.7

### Added: models marked `deprecated` in config.yaml are hidden

`model_info.deprecated: true` on a model now removes it from the picker,
checked via `GET /v1/model/info` alongside the existing discovery call.
`/model_group/info` and `/v1/models` never carry this flag, so this was the
one endpoint that could answer it. Best effort: if the check fails, nothing
is filtered on this basis.

## 0.3.6

### Added: a baseline `permission` policy

The compliance layer now also fills in a baseline `permission` config: deny
reading/editing secrets (`.env`, `.npmrc`, `.pypirc`, SSH keys), allow
read-only shell commands without asking, and ask for confirmation on
anything else. Additive like the provider block list — an existing rule for
the same pattern, or a category set as a blanket string, is never
overwritten. Governed by the existing `enforce` flag.

## 0.3.5

### Added: standalone binaries as a Node-free install option

`install.sh` / `install.ps1` fetch a self-contained binary from GitHub
Releases, for people who don't have Node.js/npm. `npx` remains the primary,
documented install path.

## 0.3.4

### Changed: `setup --url` asks for the scope instead of erroring

Previously, non-interactive setup (`--url` without a prompt) required
`--global` or `--project` up front and refused to run otherwise. Now it asks
which one to use if it's missing, same as the interactive flow. `--key-stdin`
still requires the scope explicitly, since it consumes stdin for the key
before any prompt could use it.

## 0.3.1

### Fixed: the plugin crashed OpenCode's TUI on startup

`experimental.policies` was mirrored from the block list on every `config`
hook call. On OpenCode 1.18.4 that statement shape fails the `GET /config`
response schema (`Expected ConfigV2.Experimental.Policy, got {...}`), and
since the TUI calls that endpoint on startup, every install of 0.3.0 crashed
before showing a prompt.

The feature was already documented as inert for provider resolution on
1.18.4; 0.3.1 stops writing it. `disabled_providers` remains the only
enforcement mechanism.

**If you already hit this crash**, fixing the plugin's own code is not
enough by itself: OpenCode caches an installed plugin package under
`~/.cache/opencode/packages/` and does not refetch it just because a newer
version is on npm. After upgrading, clear the cached copy once:

```sh
rm -rf ~/.cache/opencode/packages/@noser-engineering/opencode-plugin-neuron*
```

## 0.3.0

### Renamed to `@noser-engineering/opencode-plugin-neuron`

The plugin now enforces one organization's provider policy, which is not
something a neutrally named package should do to a stranger who installs it.
The scope says whose policy it is.

Update the `plugin` entry in `opencode.json`, or re-run the setup command,
which migrates an existing unscoped entry in place:

```sh
npx @noser-engineering/opencode-plugin-neuron setup --global
```

The unscoped `opencode-plugin-neuron` stops at 0.2.2.

The German onboarding guide no longer ships in the tarball; it is internal and
of no use to anyone outside Noser. It stays in the repository.

### Providers nobody declared are blocked

This changes what existing users see. A provider that used to appear because a
credential for it happened to exist is gone after the update.

OpenCode loads a provider as soon as any credential for it exists, so a
leftover `ANTHROPIC_API_KEY`, a `GITHUB_TOKEN` or the built-in `opencode`
provider could make an uncleared endpoint selectable. The plugin now blocks
providers that appear in no configuration file.

Anything declared in `opencode.json` keeps working, including the plugin's own
profiles. To get a provider back, name it:

```json
{ "provider": { "anthropic": {} } }
```

Two new plugin options: `denyProviders` extends the block list, `enforce:
false` turns the layer off and is logged at startup.

Also set: `share` to `"disabled"`, `autoupdate` to `"notify"` unless it is
already `false`, and a `deny provider.use` policy per blocked provider.

Known limitations, both documented in the README: the block list cannot cover
all 172 providers in the models.dev catalog, and `experimental.policies` is
inert on OpenCode 1.18.4, so `disabled_providers` is what enforces the block
today.

The layer applies even when the plugin's own configuration is broken or the
proxy is unreachable — models are the thing that fails, never the protection.

### Models carry real metadata

Discovery now prefers `GET /v1/model_group/info` and falls back to
`GET /v1/models`.

- Costs are populated, converted from LiteLLM's per-token prices to the
  per-million unit OpenCode expects. The picker no longer shows zero for
  everything.
- `reasoning` comes from `supports_reasoning` instead of a regex over model
  ids that was wrong for Claude, Gemini and every custom alias. The heuristic
  survives only in the fallback path, which reports no capabilities.
- `supports_pdf_input` is mapped to the `pdf` input modality.
- Wildcard entries are dropped: they are LiteLLM access rules, not callable
  models.
- Models whose mode is not `chat` or `responses` are dropped, so embeddings,
  image and audio models no longer reach the picker. An entry without a mode
  is kept.

### One discovery request per profile

The config hook runs several times per process and used to issue a fresh
request per profile each time. Results are now cached for the process
lifetime, keyed by profile and base URL.

### Verification

`scripts/verify-protection.sh` checks the layer against an installed OpenCode
and runs as its own CI job. It exists because the whole construction depends
on the `config` hook running before OpenCode resolves providers, which only a
real OpenCode can confirm. Run it after every OpenCode update.

## 0.2.2

Setup flags for name, URL and API key. Credential path fixed on Windows.
