#!/usr/bin/env bash
# Rebuild the downloadable extension zip the SunoGrid app serves at /suno-bridge.zip.
# The zip mirrors this folder (minus this script and OS cruft) under a `suno-bridge/` root,
# so users get the same "Load unpacked" layout. Run after editing any extension file.
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
root="$(cd "$here/.." && pwd)"
out="$root/web/public/suno-bridge.zip"
cd "$root"
rm -f "$out"
zip -rX "$out" suno-bridge \
  -x 'suno-bridge/pack.sh' \
  -x '*/.DS_Store' \
  -x '*.zip' >/dev/null
echo "Built $out"
unzip -l "$out"
