#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../tests/harness"
tmp="$TEMP/auth-harness-$$.log"
npx wrangler dev --config wrangler.auth.jsonc --port 8790 --ip 127.0.0.1 > "$tmp" 2>&1 &
PID=$!
echo "PID=$PID"
pid=$!
echo "PID=$pid"
for i in $(seq 1 60); do
  if grep -q "Ready on" "$tmp" 2>/dev/null; then
    echo "--- log head ---"
    head -8 "$tmp"
    echo "--- ready ---"
    exit 0
  fi
  sleep 0.5
done
echo "--- log tail ---"
tail -12 "$tmp"
exit 1
