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

API keys entered directly are stored in OpenCode's standard credential file with mode `0600`; they are never written to `opencode.json`. The setup also verifies the key by listing its available models.

Quit and restart OpenCode after setup, then run `/models`.

Use `--global` or `--project` to skip the first prompt:

```sh
npx opencode-plugin-neuron setup --global
npx opencode-plugin-neuron setup --project
```

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

`XDG_DATA_HOME` and the equivalent Windows data directory are supported.

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
