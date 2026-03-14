#!/bin/bash
# start-nanoclaw.sh — Start NanoClaw without systemd
# To stop: kill \$(cat /app/repo/nanoclaw.pid)

set -euo pipefail

cd "/app/repo"

# Stop existing instance if running
if [ -f "/app/repo/nanoclaw.pid" ]; then
  OLD_PID=$(cat "/app/repo/nanoclaw.pid" 2>/dev/null || echo "")
  if [ -n "$OLD_PID" ] && kill -0 "$OLD_PID" 2>/dev/null; then
    echo "Stopping existing NanoClaw (PID $OLD_PID)..."
    kill "$OLD_PID" 2>/dev/null || true
    sleep 2
  fi
fi

echo "Starting NanoClaw..."
nohup "/usr/bin/node" "/app/repo/dist/index.js" \
  >> "/app/repo/logs/nanoclaw.log" \
  2>> "/app/repo/logs/nanoclaw.error.log" &

echo $! > "/app/repo/nanoclaw.pid"
echo "NanoClaw started (PID $!)"
echo "Logs: tail -f /app/repo/logs/nanoclaw.log"
