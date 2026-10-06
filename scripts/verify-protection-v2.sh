#!/usr/bin/env bash
#
# Proves against a real OpenCode 2.x installation that the compliance layer
# of the v2 entrypoint (dist/v2.js) works.
#
# OpenCode 2 has no headless command that prints the provider list after the
# plugins ran, so a second, throwaway plugin is registered after ours. Its
# transform callbacks run in registration order on every registry rebuild,
# which means they see the state our transforms left behind, and they write
# that state to a file. `opencode run` with a model that cannot exist is the
# cheapest way to force a rebuild; its failure is expected and ignored.
#
# Skips with exit code 0 when OpenCode is not installed or is not a 2.x.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v opencode >/dev/null 2>&1; then
  echo "skip: opencode is not installed"
  exit 0
fi

readonly OPENCODE_VERSION="$(opencode --version 2>/dev/null || echo unknown)"
if [[ ! "$OPENCODE_VERSION" =~ (^|[^0-9.])2\.[0-9]+\.[0-9]+ ]]; then
  echo "skip: $OPENCODE_VERSION is not an OpenCode 2.x"
  exit 0
fi

if [[ ! -f "$REPO_ROOT/dist/v2.js" ]]; then
  echo "error: dist/v2.js is missing; run npm run build first" >&2
  exit 1
fi

echo "verifying against $OPENCODE_VERSION"

WORKSPACE="$(mktemp -d)"
trap 'rm -rf "$WORKSPACE"' EXIT

failures=0

fail() {
  echo "  FAIL: $*" >&2
  failures=$((failures + 1))
}

pass() {
  echo "  ok: $*"
}

# Boots a standalone OpenCode 2 in an isolated config, data and cache
# directory, with a stray vendor credential in the environment, and forces
# one registry rebuild. The run itself fails on purpose (unknown model).
run_case() {
  local dir="$1"
  (
    cd "$dir"
    env -u OPENAI_API_KEY -u GEMINI_API_KEY -u GOOGLE_API_KEY -u GROQ_API_KEY \
      -u OPENROUTER_API_KEY -u GITHUB_TOKEN -u OPENCODE_API_KEY -u OPENCODE_CONFIG \
      HOME="$dir/home" \
      XDG_CONFIG_HOME="$dir/xdg-config" \
      XDG_DATA_HOME="$dir/xdg-data" \
      XDG_CACHE_HOME="$dir/xdg-cache" \
      ANTHROPIC_API_KEY=sk-dummy-not-a-real-key \
      opencode run --standalone --model nobody/nothing "hi" >/dev/null 2>&1 &
    local pid=$!
    # A standalone server occasionally fails to exit; the probe has written
    # its files long before that, so give up on the process after a while.
    (sleep 90 && kill "$pid" 2>/dev/null) &
    local watchdog=$!
    wait "$pid" 2>/dev/null || true
    kill "$watchdog" 2>/dev/null
    wait "$watchdog" 2>/dev/null || true
  )
}

# Builds an isolated workspace with the probe plugin and, unless the first
# argument is "baseline", our plugin in front of it. Argument 2 is our plugin's
# options as JSON, argument 3 extra top-level config members without braces.
make_case() {
  local name="$1" options="${2:-{\}}" extra="${3:-}"
  local dir="$WORKSPACE/$name"
  mkdir -p "$dir/home" "$dir/xdg-config/opencode" "$dir/xdg-data" "$dir/xdg-cache" "$dir/plugin/neuron" "$dir/plugin/probe"
  echo '{"$schema":"https://opencode.ai/config.json"}' >"$dir/xdg-config/opencode/opencode.json"

  # OpenCode 2 only accepts a directory (a package) as a local plugin, so the
  # build under test is wrapped in one.
  printf 'export { default } from "file://%s/dist/v2.js"\n' "$REPO_ROOT" >"$dir/plugin/neuron/index.js"
  echo '{"name":"neuron-under-test","type":"module","exports":{".":"./index.js"}}' >"$dir/plugin/neuron/package.json"

  cat >"$dir/plugin/probe/index.js" <<EOF
import { writeFileSync } from "node:fs"
export default {
  id: "neuron-verify-probe",
  async setup(ctx) {
    await ctx.provider.transform((editor) => {
      const providers = Object.fromEntries(editor.list().map((record) => [record.provider.id, record.provider.activation]))
      writeFileSync("$dir/providers.json", JSON.stringify(providers))
    })
    await ctx.agent.transform((editor) => {
      const build = editor.list().find((agent) => agent.id === "build")
      writeFileSync("$dir/agents.json", JSON.stringify(build ? build.permissions : []))
    })
  },
}
EOF
  echo '{"name":"neuron-verify-probe","type":"module","exports":{".":"./index.js"}}' >"$dir/plugin/probe/package.json"

  local plugins='"./plugin/probe"'
  if [[ "$name" != "baseline" ]]; then
    plugins="{\"package\":\"./plugin/neuron\",\"options\":$options},$plugins"
  fi
  printf '{"$schema":"https://opencode.ai/config.json","plugins":[%s]%s}\n' "$plugins" "${extra:+,$extra}" >"$dir/opencode.json"
  echo "$dir"
}

# Argument 1: case dir, 2: provider id. Exit 0 when the probe saw the provider.
has_provider() {
  node -e 'process.exit(Object.hasOwn(JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8")), process.argv[2]) ? 0 : 1)' "$1/providers.json" "$2"
}

# Argument 1: case dir, 2: action, 3: resource, 4: effect. Exit 0 when the
# build agent carries exactly that rule.
has_rule() {
  node -e '
    const rules = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"))
    const [action, resource, effect] = process.argv.slice(2)
    process.exit(rules.some((r) => r.action === action && r.resource === resource && r.effect === effect) ? 0 : 1)
  ' "$1/agents.json" "$2" "$3" "$4"
}

require_report() {
  if [[ ! -f "$1/providers.json" || ! -f "$1/agents.json" ]]; then
    fail "the probe plugin produced no report in $1; did the plugins load?"
    return 1
  fi
}

readonly PROFILE_OPTIONS='{"profiles":[{"id":"work","name":"Work","baseURL":"https://proxy.invalid/v1"}]}'

# ---------------------------------------------------------------------------
# 1. Baseline. Without our plugin, Zen must be in the registry, otherwise the
#    checks below would pass for the wrong reason.
# ---------------------------------------------------------------------------
echo "case: baseline without the plugin"
baseline_dir="$(make_case baseline)"
run_case "$baseline_dir"
if require_report "$baseline_dir"; then
  if has_provider "$baseline_dir" opencode; then
    pass "the built-in opencode provider (Zen) is in the registry"
  else
    fail "Zen is missing from the baseline; this environment cannot prove anything"
  fi
fi

# ---------------------------------------------------------------------------
# 2. The vector the layer exists for: the plugin is loaded, nothing is
#    declared. Only Zen is blocked; a stray vendor credential stays usable.
# ---------------------------------------------------------------------------
echo "case: plugin loaded, nothing declared"
protected_dir="$(make_case protected "$PROFILE_OPTIONS")"
run_case "$protected_dir"
if require_report "$protected_dir"; then
  if has_provider "$protected_dir" opencode; then
    fail "the built-in opencode provider (Zen) is still in the registry"
  else
    pass "the built-in opencode provider (Zen) is removed"
  fi
  if has_provider "$protected_dir" opencode-go; then
    fail "the opencode-go provider is still in the registry"
  else
    pass "the opencode-go provider is removed"
  fi
  if has_provider "$protected_dir" anthropic; then
    pass "a stray vendor credential is left alone"
  else
    fail "anthropic was removed although it is not on the deny list"
  fi
  if has_provider "$protected_dir" work; then
    pass "the configured profile is registered"
  else
    fail "the configured profile work is missing"
  fi
  if has_rule "$protected_dir" read '*.env' deny && has_rule "$protected_dir" shell 'git push*' ask; then
    pass "the permission baseline is appended to the build agent"
  else
    fail "the permission baseline is missing from the build agent"
  fi
fi

# ---------------------------------------------------------------------------
# 3. Declaration is approval. Zen written into opencode.json on purpose has
#    to stay, or the layer is a blunt instrument.
# ---------------------------------------------------------------------------
echo "case: opencode (Zen) declared on purpose"
declared_dir="$(make_case declared "$PROFILE_OPTIONS" '"providers":{"opencode":{}}')"
run_case "$declared_dir"
if require_report "$declared_dir"; then
  if has_provider "$declared_dir" opencode; then
    pass "a declared opencode provider stays"
  else
    fail "a declared opencode provider was removed"
  fi
fi

# ---------------------------------------------------------------------------
# 4. denyProviders extends the block list.
# ---------------------------------------------------------------------------
echo "case: anthropic on denyProviders"
denied_dir="$(make_case denied '{"profiles":[{"id":"work","name":"Work","baseURL":"https://proxy.invalid/v1"}],"denyProviders":["anthropic"]}')"
run_case "$denied_dir"
if require_report "$denied_dir"; then
  if has_provider "$denied_dir" anthropic; then
    fail "anthropic is still in the registry although it is on denyProviders"
  else
    pass "a provider on denyProviders is removed"
  fi
fi

echo
if ((failures)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
