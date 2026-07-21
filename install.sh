#!/usr/bin/env bash
# agent-cli-bridge installer — macOS / Linux.
#
# What this script does (nothing else):
#   1. Looks for Node.js >= 20 on your PATH; if absent, downloads a private
#      copy of the Node 22 LTS runtime into ~/.agent-cli-bridge/node
#      (checksum-verified; your system and any existing Node stay untouched).
#   2. Downloads the latest agent-cli-bridge release (two readable JS files)
#      from github.com — the same files you can inspect on the Releases page.
#   3. Writes an `agent-cli-bridge` launcher into ~/.local/bin.
#
# Uninstall: rm -rf ~/.agent-cli-bridge ~/.local/bin/agent-cli-bridge
set -euo pipefail

REPO="${AGENT_CLI_BRIDGE_REPO:-moonomat/agent-cli-bridge}"
INSTALL_DIR="${AGENT_CLI_BRIDGE_HOME:-$HOME/.agent-cli-bridge}"
RELEASE_BASE="https://github.com/$REPO/releases/latest/download"
NODE_DIST_BASE="https://nodejs.org/dist/latest-v22.x"

say() { printf '\033[1m[agent-cli-bridge]\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31m[agent-cli-bridge]\033[0m ERROR: %s\n' "$*" >&2; exit 1; }

command -v curl > /dev/null || fail "curl is required but not found."

# --- 1. Node >= 20: use the system one, or install a private runtime ---------
NODE_BIN=""
if command -v node > /dev/null; then
  found="$(node -v 2> /dev/null || echo v0)"
  major="$(printf '%s' "$found" | sed 's/^v\([0-9]*\).*/\1/')"
  if [ "${major:-0}" -ge 20 ]; then
    NODE_BIN="node"
    say "Found Node $found on PATH — using it."
  else
    say "Found Node $found — too old (need >= 20), installing a private runtime instead."
  fi
fi

if [ -z "$NODE_BIN" ]; then
  case "$(uname -s)" in
    Darwin) os=darwin ;;
    Linux) os=linux ;;
    *) fail "Unsupported OS: $(uname -s)" ;;
  esac
  case "$(uname -m)" in
    x86_64) arch=x64 ;;
    aarch64 | arm64) arch=arm64 ;;
    *) fail "Unsupported CPU: $(uname -m)" ;;
  esac

  say "Downloading the Node 22 LTS runtime (private copy in $INSTALL_DIR/node — does not touch your system)…"
  shasums="$(curl -fsSL "$NODE_DIST_BASE/SHASUMS256.txt")"
  tarball="$(printf '%s\n' "$shasums" | grep -oE "node-v[0-9.]+-$os-$arch\.tar\.gz" | head -1)"
  [ -n "$tarball" ] || fail "No Node build found for $os-$arch."

  tmp="$(mktemp -d)"
  trap 'rm -rf "$tmp"' EXIT
  curl -fL --progress-bar -o "$tmp/$tarball" "$NODE_DIST_BASE/$tarball"

  say "Verifying checksum…"
  expected="$(printf '%s\n' "$shasums" | grep " $tarball\$" | awk '{print $1}')"
  if command -v sha256sum > /dev/null; then
    actual="$(sha256sum "$tmp/$tarball" | awk '{print $1}')"
  else
    actual="$(shasum -a 256 "$tmp/$tarball" | awk '{print $1}')"
  fi
  [ "$actual" = "$expected" ] || fail "Checksum mismatch for $tarball — aborting."

  rm -rf "$INSTALL_DIR/node"
  mkdir -p "$INSTALL_DIR/node"
  tar -xzf "$tmp/$tarball" -C "$INSTALL_DIR/node" --strip-components=1
  NODE_BIN="$INSTALL_DIR/node/bin/node"
  say "Node $("$NODE_BIN" -v) installed."
fi

# --- 2. Download the bridge from the latest GitHub release -------------------
mkdir -p "$INSTALL_DIR"
say "Downloading agent-cli-bridge (latest release of github.com/$REPO)…"
curl -fsSL -o "$INSTALL_DIR/agent-cli-bridge.mjs" "$RELEASE_BASE/agent-cli-bridge.mjs" \
  || fail "Download failed — does github.com/$REPO have a release yet?"
curl -fsSL -o "$INSTALL_DIR/mcp-proxy-server.cjs" "$RELEASE_BASE/mcp-proxy-server.cjs"

# --- 3. Launcher -------------------------------------------------------------
BIN_DIR="$HOME/.local/bin"
mkdir -p "$BIN_DIR"
cat > "$BIN_DIR/agent-cli-bridge" << EOF
#!/bin/sh
exec "$NODE_BIN" "$INSTALL_DIR/agent-cli-bridge.mjs" "\$@"
EOF
chmod +x "$BIN_DIR/agent-cli-bridge"
say "Launcher written to $BIN_DIR/agent-cli-bridge"

say "Installed."
case ":$PATH:" in
  *":$BIN_DIR:"*)
    say "Now start it:"
    printf '\n    agent-cli-bridge\n\n'
    ;;
  *)
    # ~/.local/bin is not on PATH (typical on macOS). Add it via the shell
    # profile — announced and idempotent — so future terminals find the
    # launcher (the same pattern bun/uv/cargo installers use).
    case "${SHELL:-}" in
      */zsh) rc="$HOME/.zshrc" ;;
      */bash) rc="$HOME/.bashrc" ;;
      *) rc="$HOME/.profile" ;;
    esac
    if [ -f "$rc" ] && grep -qF '.local/bin' "$rc"; then
      say "$rc already mentions ~/.local/bin — left untouched (log in again to pick it up)."
    else
      printf '\n# Added by the agent-cli-bridge installer\nexport PATH="$HOME/.local/bin:$PATH"\n' >> "$rc"
      say "Added ~/.local/bin to your PATH in $rc."
    fi
    say "Now start it (in a NEW terminal — or in this one via $BIN_DIR/agent-cli-bridge):"
    printf '\n    agent-cli-bridge\n\n'
    ;;
esac
say "It will print a pairing token — paste that into your app's bridge settings."
