#!/usr/bin/env bash
# Build the aka-runtime sidecar and copy the binary into src-tauri/binaries/
# with the Tauri-required `<name>-<target-triple>` suffix. Tauri's bundler
# resolves the externalBin entry "binaries/aka-runtime" to the file matching
# the host (or --target) triple at build time.
#
# Usage:
#   scripts/rename-runtime.sh                # build for the host triple
#   scripts/rename-runtime.sh aarch64-apple-darwin   # cross / explicit triple
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
TAURI_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
RUNTIME_DIR="$TAURI_DIR/aka-runtime"
BIN_DIR="$TAURI_DIR/binaries"

# Resolve the target triple: explicit arg, else the host's rustc default.
if [[ $# -ge 1 ]]; then
  TRIPLE="$1"
else
  TRIPLE="$(rustc -vV | awk '/^host:/{print $2}')"
fi

echo "Building aka-runtime for $TRIPLE ..."
TARGET_ARGS=()
if [[ "$TRIPLE" != "$(rustc -vV | awk '/^host:/{print $2}')" ]]; then
  TARGET_ARGS=(--target "$TRIPLE")
  SRC="$RUNTIME_DIR/target/$TRIPLE/release/aka-runtime"
else
  SRC="$RUNTIME_DIR/target/release/aka-runtime"
fi

( cd "$RUNTIME_DIR" && cargo build --release ${TARGET_ARGS[@]+"${TARGET_ARGS[@]}"} )

EXT=""
case "$TRIPLE" in
  *windows*) EXT=".exe" ;;
esac
SRC="${SRC}${EXT}"

mkdir -p "$BIN_DIR"
DEST="$BIN_DIR/aka-runtime-${TRIPLE}${EXT}"
cp "$SRC" "$DEST"
echo "Copied -> $DEST"
