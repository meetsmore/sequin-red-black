#!/usr/bin/env bash
set -euo pipefail

REPO="sequin-io/sequin-red-black"
INSTALL_DIR="/usr/local/bin"

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
if command -v gh &>/dev/null; then
  if [ "$VERSION" = "latest" ]; then
    gh release download --repo "$REPO" --pattern "$ARTIFACT" --dir "$TMPDIR"
  else
    gh release download "$VERSION" --repo "$REPO" --pattern "$ARTIFACT" --dir "$TMPDIR"
  fi
else
  if [ "$VERSION" = "latest" ]; then
    URL="https://github.com/$REPO/releases/latest/download/$ARTIFACT"
  else
    URL="https://github.com/$REPO/releases/download/$VERSION/$ARTIFACT"
  fi
  curl -fsSL -o "$TMPDIR/$ARTIFACT" "$URL"
fi

chmod +x "$TMPDIR/$ARTIFACT"
sudo mv "$TMPDIR/$ARTIFACT" "$INSTALL_DIR/srb"

echo "Installed srb to $INSTALL_DIR/srb"
srb --version
