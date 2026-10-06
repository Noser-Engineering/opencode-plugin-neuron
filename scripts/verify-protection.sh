#!/usr/bin/env bash
#
# Proves against a real OpenCode installation that the compliance layer works.
#
# Everything else about the layer is testable in isolation; this is not. It
# rests on one assumption that only OpenCode itself can confirm: that the
# `config` hook runs before providers are resolved, so that what the hook writes
# still has an effect. Run this after every OpenCode update.
#
# Skips with exit code 0 when OpenCode is not installed.

set -euo pipefail

readonly REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

if ! command -v opencode >/dev/null 2>&1; then
  echo "skip: opencode is not installed"
  exit 0
fi

if [[ ! -f "$REPO_ROOT/dist/index.js" ]]; then
  echo "error: dist/index.js is missing; run npm run build first" >&2
  exit 1
fi

readonly OPENCODE_VERSION="$(opencode --version 2>/dev/null || echo unknown)"
echo "verifying against opencode $OPENCODE_VERSION"

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

# Runs `opencode models` in an isolated config and data directory, with a
# leftover credential in the environment. Argument 1 is the workspace subdir.
run_models() {
  local dir="$1"
  (
    cd "$dir"
    env -u OPENAI_API_KEY -u GEMINI_API_KEY -u GOOGLE_API_KEY -u GROQ_API_KEY \
      -u OPENROUTER_API_KEY -u GITHUB_TOKEN -u OPENCODE_API_KEY -u OPENCODE_CONFIG \
      XDG_CONFIG_HOME="$dir/xdg-config" \
      XDG_DATA_HOME="$dir/xdg-data" \
      ANTHROPIC_API_KEY=sk-dummy-not-a-real-key \
      opencode models 2>/dev/null
  )
}

run_debug_config() {
  local dir="$1"
  (
    cd "$dir"
    env -u OPENCODE_CONFIG \
      XDG_CONFIG_HOME="$dir/xdg-config" \
      XDG_DATA_HOME="$dir/xdg-data" \
      ANTHROPIC_API_KEY=sk-dummy-not-a-real-key \
      opencode debug config 2>/dev/null
  )
}

# Builds an isolated workspace. Argument 2 is the project opencode.json.
make_case() {
  local name="$1" config="$2"
  local dir="$WORKSPACE/$name"
  mkdir -p "$dir/xdg-config/opencode" "$dir/xdg-data"
  echo '{"$schema":"https://opencode.ai/config.json"}' >"$dir/xdg-config/opencode/opencode.json"
  printf '%s\n' "$config" >"$dir/opencode.json"
  echo "$dir"
}

# The plugin entry points at the repository root as a package directory, so
# OpenCode resolves the entry through package.json exactly as it does for an
# npm install (exports["./server"] first, then "."). A package name here would
# make OpenCode install that package from the registry and hand the options
# to it, not to the code under test; a direct file path would skip the
# exports resolution that broke 0.5.0 and 0.5.1 on OpenCode 1.18.
readonly PLUGIN_SPEC="file://$REPO_ROOT"

# Argument 1: plugin options as JSON. Argument 2 (optional): extra top-level
# config members, without the surrounding braces.
plugin_entry() {
  local options="${1:-{\}}" extra="${2:-}"
  printf '{"$schema":"https://opencode.ai/config.json","plugin":[["%s",%s]]%s}' \
    "$PLUGIN_SPEC" "$options" "${extra:+,$extra}"
}

# ---------------------------------------------------------------------------
# 1. Baseline. Without the plugin the stray credential must produce an
#    anthropic provider, otherwise the checks below would pass for the wrong
#    reason and this script would be worthless.
# ---------------------------------------------------------------------------
echo "case: baseline without the plugin"
baseline_dir="$(make_case baseline '{"$schema":"https://opencode.ai/config.json"}')"
baseline_output="$(run_models "$baseline_dir")"
if grep -q '^anthropic/' <<<"$baseline_output"; then
  pass "a leftover ANTHROPIC_API_KEY does load the anthropic provider"
else
  fail "baseline did not load anthropic; this environment cannot prove anything"
  echo "$baseline_output" | head -5 >&2
fi

# ---------------------------------------------------------------------------
# 2. The vector the layer exists for: the plugin is loaded, nothing is
#    declared. Since 0.4.0 only OpenCode Zen is blocked out of the box; a
#    stray vendor credential stays usable, exactly as in plain OpenCode.
# ---------------------------------------------------------------------------
echo "case: plugin loaded, nothing declared"
protected_dir="$(make_case protected "$(plugin_entry)")"
protected_output="$(run_models "$protected_dir")"
if grep -q '^opencode/' <<<"$protected_output"; then
  fail "the built-in opencode provider (Zen) is still available"
else
  pass "the built-in opencode provider (Zen) is blocked"
fi
if grep -q '^opencode-go/' <<<"$protected_output"; then
  fail "the opencode-go provider is still available"
else
  pass "the opencode-go provider is blocked"
fi
if grep -q '^anthropic/' <<<"$protected_output"; then
  pass "a stray vendor credential is left alone"
else
  fail "anthropic was blocked although it is not on the deny list"
fi

# ---------------------------------------------------------------------------
# 3. Declaration is approval. A blocked provider written into opencode.json
#    on purpose has to work again, or the layer is a blunt instrument.
# ---------------------------------------------------------------------------
echo "case: opencode (Zen) declared on purpose"
declared_dir="$(make_case declared "$(plugin_entry '{}' '"provider":{"opencode":{}}')")"
declared_output="$(run_models "$declared_dir")"
if grep -q '^opencode/' <<<"$declared_output"; then
  pass "a declared opencode provider works again"
else
  fail "a declared opencode provider was still blocked"
fi

# ---------------------------------------------------------------------------
# 4. denyProviders extends the block list. The stray anthropic credential
#    from the baseline is the provider to rule out here.
# ---------------------------------------------------------------------------
echo "case: anthropic on denyProviders"
denied_dir="$(make_case denied "$(plugin_entry '{"denyProviders":["anthropic"]}')")"
denied_output="$(run_models "$denied_dir")"
if grep -q '^anthropic/' <<<"$denied_output"; then
  fail "anthropic is still available although it is on denyProviders"
  grep '^anthropic/' <<<"$denied_output" | head -3 >&2
else
  pass "a provider on denyProviders is blocked"
fi

# ---------------------------------------------------------------------------
# 5. The resolved config carries the settings the layer promises.
# ---------------------------------------------------------------------------
echo "case: resolved config"
resolved="$(run_debug_config "$protected_dir")"
node -e '
  const config = JSON.parse(require("node:fs").readFileSync(0, "utf8"))
  const problems = []
  if (config.share !== "disabled") problems.push(`share is ${JSON.stringify(config.share)}, expected "disabled"`)
  if (config.autoupdate !== "notify" && config.autoupdate !== false) {
    problems.push(`autoupdate is ${JSON.stringify(config.autoupdate)}, expected "notify" or false`)
  }
  const disabled = config.disabled_providers ?? []
  for (const id of ["opencode", "opencode-go"]) {
    if (!disabled.includes(id)) problems.push(`disabled_providers is missing ${id}`)
  }
  for (const id of ["anthropic", "github-copilot"]) {
    if (disabled.includes(id)) problems.push(`disabled_providers wrongly contains ${id}`)
  }
  for (const problem of problems) console.log(`FAIL ${problem}`)
  if (!problems.length) console.log("OK resolved config carries share, autoupdate and disabled_providers")
' <<<"$resolved" >"$WORKSPACE/resolved-report"
while IFS= read -r line; do
  case "$line" in
    FAIL*) fail "${line#FAIL }" ;;
    OK*) pass "${line#OK }" ;;
  esac
done <"$WORKSPACE/resolved-report"

echo
if ((failures)); then
  echo "$failures check(s) failed"
  exit 1
fi
echo "all checks passed"
