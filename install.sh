#!/usr/bin/env bash
set -euo pipefail

REPO="meetsmore/sequin-red-black"
INSTALL_DIR="${SRB_INSTALL_DIR:-/usr/local/bin}"

# Detect architecture
ARCH=$(uname -m)
case "$ARCH" in
  x86_64)  ARTIFACT="srb-linux-amd64" ;;
  aarch64) ARTIFACT="srb-linux-arm64" ;;
  *)       echo "Unsupported architecture: $ARCH"; exit 1 ;;
esac

# Determine version
VERSION="${SRB_VERSION:-latest}"

echo "Installing srb ($ARTIFACT)..."

TMPDIR=$(mktemp -d)
trap 'rm -rf "$TMPDIR"' EXIT

# Download binary
if [ "$VERSION" = "latest" ]; then
  URL="https://github.com/$REPO/releases/latest/download/$ARTIFACT"
else
  URL="https://github.com/$REPO/releases/download/$VERSION/$ARTIFACT"
fi
curl -fsSL -o "$TMPDIR/$ARTIFACT" "$URL"

chmod +x "$TMPDIR/$ARTIFACT"
# Use sudo if available (CI runners), skip if already root (containers)
if command -v sudo &>/dev/null && [ "$(id -u)" -ne 0 ]; then
  sudo mv "$TMPDIR/$ARTIFACT" "$INSTALL_DIR/srb"
else
  mv "$TMPDIR/$ARTIFACT" "$INSTALL_DIR/srb"
fi

echo "Installed srb to $INSTALL_DIR/srb"
"$INSTALL_DIR/srb" --version
