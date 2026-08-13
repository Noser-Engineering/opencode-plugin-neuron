# OpenCode Neuron plugin

An OpenCode plugin for configurable LiteLLM-compatible proxies. When OpenCode starts it asks the proxy which models the key may use and adds them to the model picker. The interactive setup accepts any HTTPS endpoint or localhost URL.

It supports multiple named profiles against the same proxy. Each profile is a separate OpenCode provider and can use a different API key, so models remain selectable as, for example, `neuron-work/model-id` and `neuron-team/model-id`.

It also blocks providers nobody asked for. See [Compliance behavior](#compliance-behavior).

## Setup

A short German onboarding guide lives in the repository as `MITARBEITER-SETUP.md`. It is Noser-internal and deliberately not part of the published package.

Run the interactive setup command:

```sh
npx @noser-engineering/opencode-plugin-neuron setup
```

Don't have Node.js? Install a standalone binary instead — no Node/npm required:

```sh
# macOS / Linux
curl -fsSL https://raw.githubusercontent.com/Noser-Engineering/opencode-plugin-neuron/main/install.sh | sh
```

```powershell
# Windows
irm https://raw.githubusercontent.com/Noser-Engineering/opencode-plugin-neuron/main/install.ps1 | iex
```

Windows users with [Scoop](https://scoop.sh) can use it as a bucket instead:

```powershell
scoop bucket add opencode-neuron https://github.com/Noser-Engineering/opencode-plugin-neuron
scoop install opencode-neuron/opencode-neuron
```

Then run `opencode-neuron setup` instead of the `npx ...` form in every example below.

To update a binary install, re-run the same install command (or `scoop update opencode-neuron` for Scoop users).

The setup asks for:

- Global or project-level configuration
- A display name; the technical provider ID is generated automatically
- The LiteLLM proxy URL
- An API key
- Any additional profiles to configure

API keys entered directly are stored in OpenCode's standard credential file; they are never written to `opencode.json`. On macOS and Linux the file is created with mode `0600`. Windows ignores POSIX modes, so there the file inherits the ACL of its parent directory. The setup also verifies the key by listing its available models.

Quit and restart OpenCode after setup, then run `/models`.

## Skipping prompts

Every flag skips its own question, so `npx @noser-engineering/opencode-plugin-neuron setup --global` only asks about the profile itself:

| Flag | Skips |
| --- | --- |
| `--global`, `--project` | Where to write the configuration |
| `--name <name>` | The display name; the provider ID is derived from it |
| `--url <url>` | The LiteLLM proxy URL |
| `--key <key>`, `--key-stdin` | The API key |

Passing `--url` runs the whole setup without a single prompt, which is what onboarding instructions and scripts want. It still asks where to write the config if `--global`/`--project` is omitted, since the scope cannot be guessed:

```sh
npx @noser-engineering/opencode-plugin-neuron setup --global \
  --name "Neuron Work" \
  --url https://litellm.example.com/v1 \
  --key sk-123
```

In this mode an existing profile of the same ID is updated without asking, so the command can be re-run safely. If the key or URL does not work, nothing is written and the exit code is 1.

`--name` is optional and defaults to `LiteLLM`. Without any key, the profile is written but requests fail until a key is configured; a stored key is reused as long as it still belongs to the same URL.

### Keeping the key out of the shell history

`--key` puts the key into the shell history and makes it visible to other users through the process list. Two alternatives avoid that:

```sh
# Read the key from stdin (requires --url and --global/--project up front,
# since stdin is already spoken for and can't also answer a scope prompt)
echo "$KEY" | npx @noser-engineering/opencode-plugin-neuron setup --global \
  --url https://litellm.example.com/v1 --key-stdin

# Or pass it in the environment; works in both modes
NEURON_API_KEY="$KEY" npx @noser-engineering/opencode-plugin-neuron setup --global \
  --url https://litellm.example.com/v1
```

Precedence is `--key`, then `--key-stdin`, then `NEURON_API_KEY`. The interactive setup does not use `--key-stdin`, since reading stdin would leave nothing for the prompts.

## Generated config

A two-profile setup looks like this:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    [
      "@noser-engineering/opencode-plugin-neuron",
      {
        "profiles": [
          {
            "id": "work-litellm",
            "name": "Work LiteLLM",
            "baseURL": "https://litellm.example.com/v1"
          },
          {
            "id": "neuron-team",
            "name": "Team LiteLLM",
            "baseURL": "https://litellm.example.com/v1"
          }
        ]
      }
    ]
  ]
}
```

The plugin creates the corresponding `provider` entries in memory. You do not need to maintain a `models` block.

The setup command writes each API key to OpenCode's credential store, keyed by provider ID:

```text
~/.local/share/opencode/auth.json
```

This path matches OpenCode's own credential store on every platform, Windows included: `XDG_DATA_HOME` is honored when set, otherwise the location is derived from the home directory. On Windows that means `%USERPROFILE%\.local\share\opencode\auth.json` — OpenCode does not use `%LOCALAPPDATA%` for its data directory. `OPENCODE_AUTH_PATH` overrides the path entirely.

## Compliance behavior

OpenCode loads a provider as soon as a credential for it exists. A leftover `ANTHROPIC_API_KEY` from another engagement, a `GITHUB_TOKEN`, or the built-in `opencode` provider is enough to make an endpoint selectable that nobody cleared for the data being worked on. From 0.3.0 the plugin closes that gap.

**Declaring a provider is how you approve it.** OpenCode fills `config.provider` from configuration files only, never from an autoloaded credential. Everything named in `opencode.json` keeps working, including the plugin's own profiles; the plugin only blocks what nobody named:

```json
{
  "provider": {
    "anthropic": {}
  }
}
```

Two lines, and `anthropic` is available again with its full model list from models.dev. That is deliberate and not a hole to be plugged. The goal is to stop an accident, not to stop a decision. Anyone who writes a provider into their config has made a decision.

Alongside that, the plugin sets:

| Setting | Value | Why |
| --- | --- | --- |
| `share` | `"disabled"` | `/share` publishes the conversation including code excerpts to opencode.ai, where a CDN caches it |
| `autoupdate` | `"notify"` | an unattended update can introduce a new preconfigured provider. An existing `false` is stricter and is left alone |
| `disabled_providers` | the block list | entries already present are kept |

### What this does not cover

- **The block list cannot be complete.** All 172 providers in the models.dev catalog load from an environment variable, and an OpenCode release can add more. The list covers the mainstream vendors, hyperscalers, developer platforms and gateways; a credential for something outside it is still picked up. Extend the list with `denyProviders`.
- **Deliberate misuse is out of scope.** Anyone can declare a provider, or set `enforce: false`.

The plugin used to also mirror the block list into `experimental.policies`. That statement shape is inert on OpenCode 1.18.4 for provider resolution, and worse, that release's `GET /config` response fails to validate it — the TUI calls that endpoint on startup and crashes with `Expected ConfigV2.Experimental.Policy, got {...}`. 0.3.1 stops writing it; `disabled_providers` is the only enforcement mechanism.

### Options

```json
[
  "@noser-engineering/opencode-plugin-neuron",
  {
    "profiles": [{ "id": "neuron", "name": "Neuron", "baseURL": "https://litellm.example.com/v1" }],
    "denyProviders": ["some-internal-gateway"],
    "enforce": true
  }
]
```

`denyProviders` adds to the block list; a provider that is also declared stays available. `enforce: false` turns the whole layer off and is logged as a warning at startup. Only a literal `false` does that: a malformed value leaves protection on and reports the mistake, because a typo must not silently disable it.

The layer runs even when the plugin's own configuration is broken or the proxy is unreachable. In that case you lose your models but keep the protection, never the other way around.

### After an OpenCode update

```sh
npm run build && ./scripts/verify-protection.sh
```

The layer depends on the `config` hook running before OpenCode resolves providers. That holds in 1.18.4 and is the kind of thing a release can change quietly, so the script checks it against a real installation. It also runs as its own CI job.

## Behavior

- Discovery prefers `GET /v1/model_group/info`, which reports one entry per alias with mode, context limits, costs and capability flags. It falls back to `GET /v1/models` for older LiteLLM versions and restricted keys.
- Costs are converted from LiteLLM's per-token prices to the per-million unit OpenCode expects.
- Wildcard entries are LiteLLM access rules rather than callable models and are dropped, as is anything whose mode is not `chat` or `responses`. An entry without a mode is kept.
- Discovery runs once for every profile at OpenCode startup, and the result is reused for the rest of the process.
- Profiles are queried concurrently and authenticated independently.
- Proxy URLs are configurable. Remote proxies must use HTTPS; plain HTTP is accepted only for localhost.
- Every stored API key is bound to its normalized proxy URL. A project configuration cannot redirect it to another host.
- Project-selected environment variables and provider API keys are not used for automatic discovery.
- A profile only sees models available to its own API key.
- Existing hand-curated entries under `provider.<profile-id>.models` are preserved.
- A failed or offline profile logs a warning but does not prevent OpenCode from starting.
- Discovery is capped at 5 seconds by default. Set `timeoutMs` in the plugin options to a value from 1000 to 30000 milliseconds to override it.
- A model the proxy reports is only added if the provider does not already define it, so hand-curated entries win.

OpenCode only reads plugin configuration during startup. Restart it whenever profiles or LiteLLM's model list change.

## Development

```sh
npm install
npm run check
```

To inspect the package that will be distributed:

```sh
npm pack --dry-run
```

## Publishing

The package is public. Its `publishConfig` is pinned to npmjs.org with public access. Authenticate with npm, then publish:

```sh
npm publish
```

npm package versions are immutable. Increment the version before every later publish:

```sh
npm version patch
npm publish
```

### Publishing standalone binaries

The GitHub mirror (`https://github.com/Noser-Engineering/opencode-plugin-neuron`) is not auto-synced from Azure DevOps. After tagging a release here, push it there too to trigger the binary build:

```sh
git push github main --tags
```

(`github` is a manually-added remote; if it isn't set up yet, add it once with `git remote add github https://github.com/Noser-Engineering/opencode-plugin-neuron.git`.) That publishes a GitHub Release with binaries for `install.sh`/`install.ps1` to fetch. `npm publish` stays a separate, manual step.

## License

MIT
