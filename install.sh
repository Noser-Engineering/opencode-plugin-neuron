#!/usr/bin/env sh
set -eu

REPO="Noser-Engineering/opencode-plugin-neuron"

os="$(uname -s)"
case "$os" in
  Linux) os_name="linux" ;;
  Darwin) os_name="darwin" ;;
  *)
    echo "error: unsupported OS '$os'. Use 'npx @noser-engineering/opencode-plugin-neuron setup' instead." >&2
    exit 1
    ;;
esac

arch="$(uname -m)"
case "$arch" in
  x86_64 | amd64) arch_name="x64" ;;
  arm64 | aarch64) arch_name="arm64" ;;
  *)
    echo "error: unsupported architecture '$arch'. Use 'npx @noser-engineering/opencode-plugin-neuron setup' instead." >&2
    exit 1
    ;;
esac

asset="opencode-neuron-${os_name}-${arch_name}"
url="https://github.com/${REPO}/releases/latest/download/${asset}"
install_dir="${OPENCODE_NEURON_INSTALL_DIR:-$HOME/.local/bin}"
tmp_file="$(mktemp)"

echo "==> downloading ${asset}"
curl -fsSL "$url" -o "$tmp_file"
mkdir -p "$install_dir"
chmod +x "$tmp_file"
mv "$tmp_file" "${install_dir}/opencode-neuron"

echo "==> installed to ${install_dir}/opencode-neuron"

case ":$PATH:" in
  *":$install_dir:"*) ;;
  *) echo "note: ${install_dir} is not on your PATH. Add it, e.g.: export PATH=\"${install_dir}:\$PATH\"" ;;
esac

echo "==> run: opencode-neuron setup"
