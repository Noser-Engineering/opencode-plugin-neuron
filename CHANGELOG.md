# Changelog

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
