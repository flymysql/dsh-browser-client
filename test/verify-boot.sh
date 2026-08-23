#!/usr/bin/env bash
# verify-boot.sh — boot an ISOLATED DSH instance on a fresh port with the
# dsh-browser-host plugin mounted, for verification/testing.
#
# RULE: never touch the 3080 production instance. Every verification uses a
# brand-new port. Default port is chosen from an env var or auto-incremented.
#
# Usage:
#   ./test/verify-boot.sh [port]        # boot on the given port (default 4101)
#   ./test/verify-boot.sh stop [port]   # stop the instance on that port
#
# The instance's token is written to test/env/browser-client-token-<port> and
# its log to test/env/boot-<port>.log. Store tests should point TOKEN_FILE at
# the per-port token.

set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_DIR="$ROOT/test/env"
PORT="${1:-4101}"
ACTION="${2:-boot}"

case "$ACTION" in
  stop)
    if [ -f "$ENV_DIR/dsh-$PORT.pid" ]; then
      kill "$(cat "$ENV_DIR/dsh-$PORT.pid")" 2>/dev/null || true
      rm -f "$ENV_DIR/dsh-$PORT.pid"
      echo "stopped instance on :$PORT"
    else
      echo "no instance on :$PORT"
    fi
    exit 0
    ;;
esac

# Stop any stale instance on this port first.
if [ -f "$ENV_DIR/dsh-$PORT.pid" ]; then
  kill "$(cat "$ENV_DIR/dsh-$PORT.pid")" 2>/dev/null || true
  sleep 1
fi

# Per-port overlay: mount the plugin, persist token to a per-port file.
cat > "$ENV_DIR/overlay-$PORT.yml" <<EOF
- insert:
    - id: dsh-browser-host
      name: '$ROOT/lib/index.js'
      config:
        extPrefix: /ext-api
        extEventsPath: /ext-events.mux
        persistToken: true
        tokenFile: $ENV_DIR/browser-client-token-$PORT
        toolTimeoutMs: 60000
EOF

echo "booting isolated DSH on :$PORT (plugin: $ROOT/lib/index.js)…"
(
  cd "$ENV_DIR"
  nohup node "$ENV_DIR/profiles/node_modules/@deepseek-ai/dsh/lib/bin.js" \
    web --patch "$ENV_DIR/overlay-$PORT.yml" --port "$PORT" --no-open \
    > "$ENV_DIR/boot-$PORT.log" 2>&1 &
  echo $! > "$ENV_DIR/dsh-$PORT.pid"
)

# Wait for the plugin to report readiness.
for i in $(seq 1 30); do
  if grep -q "dsh web:" "$ENV_DIR/boot-$PORT.log" 2>/dev/null; then
    break
  fi
  sleep 1
done

echo "=== boot-$PORT.log ==="
grep -E "extension token|registered tool|workflow store|dsh web|Error|error" "$ENV_DIR/boot-$PORT.log" | head -20 || true

if lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1; then
  echo "✓ instance ready on http://127.0.0.1:$PORT"
  echo "  token: $ENV_DIR/browser-client-token-$PORT"
else
  echo "✗ instance failed to boot on :$PORT — see $ENV_DIR/boot-$PORT.log"
  exit 1
fi
