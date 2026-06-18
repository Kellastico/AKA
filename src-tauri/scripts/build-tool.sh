#!/usr/bin/env bash
# Build the `aka-tool` shim and copy the binary into src-tauri/binaries/ with the
# Tauri-required `<name>-<target-triple>` suffix, so the externalBin entry
# "binaries/aka-tool" resolves for the host (or --target) triple at build time.
# Mirrors rename-runtime.sh, except aka-tool lives in the main src-tauri crate
# (src/bin/aka-tool.rs), so we build it with `--bin aka-tool` here rather than in
# a sibling crate.
#
# Usage:
#   scripts/build-tool.sh                      # build for the host triple
#   scripts/build-tool.sh aarch64-apple-darwin # cross / explicit triple
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAURI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BIN_DIR="$TAURI_DIR/binaries"

HOST="$(rustc -vV | awk '/^host:/{print $2}')"
if [[ $# -ge 1 ]]; then
  TRIPLE="$1"
else
  TRIPLE="$HOST"
fi

echo "Building aka-tool for $TRIPLE ..."
TARGET_ARGS=()
if [[ "$TRIPLE" != "$HOST" ]]; then
  TARGET_ARGS=(--target "$TRIPLE")
  SRC="$TAURI_DIR/target/$TRIPLE/release/aka-tool"
else
  SRC="$TAURI_DIR/target/release/aka-tool"
fi

# Scrub the builder's absolute paths from the binary, matching rename-runtime.sh.
REMAP_RUSTFLAGS="${RUSTFLAGS:-} --remap-path-prefix=$HOME=/home/builder"
( cd "$TAURI_DIR" && RUSTFLAGS="$REMAP_RUSTFLAGS" cargo build --release --bin aka-tool ${TARGET_ARGS[@]+"${TARGET_ARGS[@]}"} )

EXT=""
case "$TRIPLE" in
  *windows*) EXT=".exe" ;;
esac
SRC="${SRC}${EXT}"

mkdir -p "$BIN_DIR"
DEST="$BIN_DIR/aka-tool-${TRIPLE}${EXT}"
cp "$SRC" "$DEST"
echo "Copied -> $DEST"
