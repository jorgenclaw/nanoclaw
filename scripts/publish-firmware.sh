#!/bin/bash
# Publish T-Watch firmware for OTA updates.
# Usage: ./scripts/publish-firmware.sh [version_number]
#
# Builds the firmware, copies the binary to data/watch-firmware/,
# and writes version.json. The watch checks /api/watch/version
# and downloads from /api/watch/firmware.

set -e

WATCH_DIR="$HOME/projects/nanoclaw-watch"
FIRMWARE_DIR="$(cd "$(dirname "$0")/.." && pwd)/data/watch-firmware"
VERSION="${1:-}"

if [ -z "$VERSION" ]; then
    # Extract from config.h
    VERSION=$(grep '#define FIRMWARE_VERSION ' "$WATCH_DIR/src/config.h" | awk '{print $3}')
fi

if [ -z "$VERSION" ]; then
    echo "Error: could not determine version. Pass as argument or set in config.h"
    exit 1
fi

echo "Building firmware v${VERSION}..."
cd "$WATCH_DIR"
~/.platformio/penv/bin/pio run 2>&1 | tail -5

BIN="$WATCH_DIR/.pio/build/twatch-s3/firmware.bin"
if [ ! -f "$BIN" ]; then
    echo "Error: firmware.bin not found at $BIN"
    exit 1
fi

mkdir -p "$FIRMWARE_DIR"
cp "$BIN" "$FIRMWARE_DIR/firmware.bin"

cat > "$FIRMWARE_DIR/version.json" <<EOF
{
  "version": ${VERSION},
  "version_str": "v${VERSION}",
  "published": "$(date -Iseconds)",
  "size": $(stat -c%s "$FIRMWARE_DIR/firmware.bin")
}
EOF

echo "Published firmware v${VERSION} to $FIRMWARE_DIR"
echo "  Binary: $(stat -c%s "$FIRMWARE_DIR/firmware.bin") bytes"
echo "  Version: $FIRMWARE_DIR/version.json"
cat "$FIRMWARE_DIR/version.json"
