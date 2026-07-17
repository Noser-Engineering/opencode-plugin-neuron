# OpenCode Neuron plugin

An OpenCode plugin for Noser's Neuron LiteLLM proxy. It requests `GET /v1/models` when OpenCode starts and adds every returned model to the model picker.

It supports multiple named profiles against the same proxy. Each profile is a separate OpenCode provider and can use a different API key, so models remain selectable as, for example, `neuron-work/model-id` and `neuron-team/model-id`.

## Employee setup

Run the interactive setup command:

```sh
npx opencode-plugin-neuron setup
```

The setup asks for:

- Global or project-level configuration
- A display name and unique provider ID
- An API key or the name of an environment variable containing one
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
            "id": "neuron-work",
            "name": "Neuron Work",
            "baseURL": "https://neuron.noser.com/v1"
          },
          {
            "id": "neuron-team",
            "name": "Neuron Team",
            "baseURL": "https://neuron.noser.com/v1",
            "apiKeyEnv": "NEURON_TEAM_API_KEY"
          }
        ]
      }
    ]
  ]
}
```

The plugin creates the corresponding `provider` entries in memory. You do not need to maintain a `models` block.

### Manual credential setup

For an environment-backed profile, export the configured variable before starting OpenCode:

```sh
export NEURON_TEAM_API_KEY="your-key"
opencode
```

For OpenCode credential storage, the setup command writes an entry keyed by the profile's provider ID to:

```text
~/.local/share/opencode/auth.json
```

`XDG_DATA_HOME` and the equivalent Windows data directory are supported.

## Behavior

- Discovery runs once for every profile at OpenCode startup.
- Profiles are queried concurrently and authenticated independently.
- Discovery is pinned to `https://neuron.noser.com/v1` so project configuration cannot redirect stored credentials to another host.
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

The package name `opencode-plugin-neuron` is currently available on npm. Publish it to the registry employees use:

```sh
npm publish
```

If Noser uses a scoped internal registry, change `name` in `package.json` and the `PACKAGE_NAME` constant in `src/constants.ts` to the scoped package name before publishing.

## License

MIT
