#!/bin/bash
set -e

REPO_DIR="/app/repo"
STATE_DIR="/app/state"

# --- Root-level init (runs as root) ---

# Initialize state directories
mkdir -p "$STATE_DIR"/{store,groups/main,groups/global,data,logs,config}

# Copy CLAUDE.md templates if not present
for dir in main global; do
  if [ ! -f "$STATE_DIR/groups/$dir/CLAUDE.md" ]; then
    cp "$REPO_DIR/groups/$dir/CLAUDE.md" "$STATE_DIR/groups/$dir/CLAUDE.md" 2>/dev/null || true
  fi
done

# --- Auto-merge env vars into state/.env ---
touch "$STATE_DIR/.env"
ENV_VARS_TO_MERGE=(
  CLAUDE_CODE_OAUTH_TOKEN
  ANTHROPIC_API_KEY
  ASSISTANT_NAME
  ASSISTANT_HAS_OWN_NUMBER
  TZ
)
for var in "${ENV_VARS_TO_MERGE[@]}"; do
  val="${!var}"
  if [ -n "$val" ]; then
    if grep -q "^${var}=" "$STATE_DIR/.env" 2>/dev/null; then
      sed -i "s|^${var}=.*|${var}=${val}|" "$STATE_DIR/.env"
    else
      echo "${var}=${val}" >> "$STATE_DIR/.env"
    fi
  fi
done

# Grant docker socket access to nanoclaw user
if [ -S /var/run/docker.sock ]; then
  SOCK_GID=$(stat -c '%g' /var/run/docker.sock)
  if ! getent group "$SOCK_GID" > /dev/null 2>&1; then
    groupadd -g "$SOCK_GID" dockerhost
  fi
  usermod -aG "$SOCK_GID" nanoclaw
fi

# Write env vars into nanoclaw user's profile so `docker exec -u nanoclaw`
# and `sudo -u nanoclaw` sessions inherit them.
{
  echo "export NANOCLAW_STATE_DIR=$STATE_DIR"
  echo "export NANOCLAW_CONFIG_DIR=$STATE_DIR/config"
  echo "export CREDENTIAL_PROXY_HOST=0.0.0.0"
  [ -n "$CLAUDE_CODE_OAUTH_TOKEN" ] && echo "export CLAUDE_CODE_OAUTH_TOKEN=$CLAUDE_CODE_OAUTH_TOKEN"
  [ -n "$ANTHROPIC_API_KEY" ] && echo "export ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY"
} > /home/nanoclaw/.nanoclaw-env
chown nanoclaw:nanoclaw /home/nanoclaw/.nanoclaw-env
# Source from .bashrc so interactive shells get it
grep -q '.nanoclaw-env' /home/nanoclaw/.bashrc 2>/dev/null || \
  echo '[ -f ~/.nanoclaw-env ] && . ~/.nanoclaw-env' >> /home/nanoclaw/.bashrc

# Own state dir and writable app dirs (not /app/repo which is read-only)
chown -R nanoclaw:nanoclaw "$STATE_DIR"
chown -R nanoclaw:nanoclaw /app/node_modules /app/package.json /app/package-lock.json /app/host-entrypoint.sh 2>/dev/null || true

# Refresh node_modules if package.json changed
if ! diff -q "$REPO_DIR/package.json" /app/package.json > /dev/null 2>&1; then
  cp "$REPO_DIR/package.json" "$REPO_DIR/package-lock.json" /app/
  gosu nanoclaw npm ci
fi

# Compile TypeScript from mounted repo
cp -r "$REPO_DIR/src" /app/src
cp "$REPO_DIR/tsconfig.json" /app/tsconfig.json
gosu nanoclaw npx tsc

# Auto-build agent image if missing
if ! docker image inspect nanoclaw-agent:latest > /dev/null 2>&1; then
  echo "Agent image not found, building nanoclaw-agent:latest..."
  cd "$REPO_DIR/container"
  docker build -t nanoclaw-agent:latest .
  cd /app
fi

# --- Drop to nanoclaw user ---
export NANOCLAW_STATE_DIR="$STATE_DIR"
export NANOCLAW_CONFIG_DIR="$STATE_DIR/config"
export CREDENTIAL_PROXY_HOST="0.0.0.0"
export HOME=/home/nanoclaw

cd "$REPO_DIR"

exec gosu nanoclaw node /app/dist/index.js
