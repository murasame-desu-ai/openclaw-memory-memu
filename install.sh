#!/usr/bin/env bash
set -euo pipefail

# openclaw-memory-memu installer
# Downloads the latest release tarball and installs to ~/.openclaw/extensions/memory-memu/

REPO="murasame-desu-ai/openclaw-memory-memu"
INSTALL_DIR="${HOME}/.openclaw/extensions/memory-memu"

echo "==> Fetching latest release from ${REPO}..."
TARBALL_URL=$(curl -sL "https://api.github.com/repos/${REPO}/releases/latest" \
  | grep '"browser_download_url".*\.tar\.gz"' \
  | head -1 \
  | cut -d '"' -f 4)

if [ -z "${TARBALL_URL}" ]; then
  echo "ERROR: Could not find a .tar.gz asset in the latest release."
  echo "Visit https://github.com/${REPO}/releases for manual download."
  exit 1
fi

TMPDIR=$(mktemp -d)
trap 'rm -rf "${TMPDIR}"' EXIT

echo "==> Downloading ${TARBALL_URL}..."
curl -sL -o "${TMPDIR}/memory-memu.tar.gz" "${TARBALL_URL}"

echo "==> Installing to ${INSTALL_DIR}..."
mkdir -p "${INSTALL_DIR}"
tar xzf "${TMPDIR}/memory-memu.tar.gz" -C "${INSTALL_DIR}" --strip-components=1

# Install npm dependencies
if [ -f "${INSTALL_DIR}/package.json" ]; then
  echo "==> Installing npm dependencies..."
  (cd "${INSTALL_DIR}" && npm install --production 2>/dev/null) || true
fi

echo "==> Building TypeScript..."
(cd "${INSTALL_DIR}" && npm run build 2>/dev/null) || true

echo ""
echo "Done! Plugin installed to ${INSTALL_DIR}"
echo ""
echo "Next steps:"
echo "  1. Install the forked memU:  pip install -e <path-to-memU-fork>"
echo "  2. Add plugin config to ~/.openclaw/openclaw.json (see README.md)"
echo "  3. Restart OpenClaw:  openclaw gateway restart"
