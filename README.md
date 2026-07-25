# OpenCode Neuron plugin

An OpenCode plugin for configurable LiteLLM-compatible proxies. It requests `GET /v1/models` when OpenCode starts and adds every returned model to the model picker. The interactive setup accepts any HTTPS endpoint or localhost URL.

It supports multiple named profiles against the same proxy. Each profile is a separate OpenCode provider and can use a different API key, so models remain selectable as, for example, `neuron-work/model-id` and `neuron-team/model-id`.

## Employee setup

For a short German employee guide, see [MITARBEITER-SETUP.md](MITARBEITER-SETUP.md).

Run the interactive setup command directly from public npm:

```sh
npx opencode-plugin-neuron setup
```

The setup asks for:

- Global or project-level configuration
- A display name; the technical provider ID is generated automatically
- The LiteLLM proxy URL
- An API key
- Any additional profiles to configure

API keys entered directly are stored in OpenCode's standard credential file; they are never written to `opencode.json`. On macOS and Linux the file is created with mode `0600`. Windows ignores POSIX modes, so there the file inherits the ACL of its parent directory. The setup also verifies the key by listing its available models.

Quit and restart OpenCode after setup, then run `/models`.

## Skipping prompts

Every flag skips its own question, so `npx opencode-plugin-neuron setup --global` only asks about the profile itself:

| Flag | Skips |
| --- | --- |
| `--global`, `--project` | Where to write the configuration |
| `--name <name>` | The display name; the provider ID is derived from it |
| `--url <url>` | The LiteLLM proxy URL |
| `--key <key>`, `--key-stdin` | The API key |

Passing `--url` runs the whole setup without a single prompt, which is what onboarding instructions and scripts want. It then requires `--global` or `--project`, because the scope cannot be guessed:

```sh
npx opencode-plugin-neuron setup --global \
  --name "Neuron Work" \
  --url https://litellm.example.com/v1 \
  --key sk-123
```

In this mode an existing profile of the same ID is updated without asking, so the command can be re-run safely. If the key or URL does not work, nothing is written and the exit code is 1.

`--name` is optional and defaults to `LiteLLM`. Without any key, the profile is written but requests fail until a key is configured; a stored key is reused as long as it still belongs to the same URL.

### Keeping the key out of the shell history

`--key` puts the key into the shell history and makes it visible to other users through the process list. Two alternatives avoid that:

```sh
# Read the key from stdin (requires --url)
echo "$KEY" | npx opencode-plugin-neuron setup --global \
  --url https://litellm.example.com/v1 --key-stdin

# Or pass it in the environment; works in both modes
NEURON_API_KEY="$KEY" npx opencode-plugin-neuron setup --global \
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
      "opencode-plugin-neuron",
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

## Behavior

- Discovery runs once for every profile at OpenCode startup.
- Profiles are queried concurrently and authenticated independently.
- Proxy URLs are configurable. Remote proxies must use HTTPS; plain HTTP is accepted only for localhost.
- Every stored API key is bound to its normalized proxy URL. A project configuration cannot redirect it to another host.
- Project-selected environment variables and provider API keys are not used for automatic discovery.
- A profile only sees models available to its own API key.
- Existing hand-curated entries under `provider.<profile-id>.models` are preserved.
- A failed or offline profile logs a warning but does not prevent OpenCode from starting.
- Discovery is capped at 5 seconds by default. Set `timeoutMs` in the plugin options to a value from 1000 to 30000 milliseconds to override it.

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

## License

MIT
