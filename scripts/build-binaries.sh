#!/usr/bin/env bash
set -euo pipefail

if [ ! -f "dist/cli.js" ]; then
  echo "error: dist/cli.js missing — run 'npm run build' first" >&2
  exit 1
fi

OUT_DIR="release-binaries"
rm -rf "$OUT_DIR"
mkdir -p "$OUT_DIR"

# bun-target:os-arch -> output filename
TARGETS=(
  "bun-linux-x64:opencode-neuron-linux-x64"
  "bun-linux-arm64:opencode-neuron-linux-arm64"
  "bun-darwin-x64:opencode-neuron-darwin-x64"
  "bun-darwin-arm64:opencode-neuron-darwin-arm64"
  "bun-windows-x64:opencode-neuron-windows-x64.exe"
  "bun-windows-arm64:opencode-neuron-windows-arm64.exe"
)

for entry in "${TARGETS[@]}"; do
  target="${entry%%:*}"
  name="${entry##*:}"
  echo "==> building ${name} (${target})"
  bun build ./dist/cli.js --compile --target="$target" --outfile "${OUT_DIR}/${name}"
done

echo "==> built:"
ls -la "$OUT_DIR"
