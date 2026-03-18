import os from 'os';
import path from 'path';

import { readEnvFile } from './env.js';

// Read config values from .env (falls back to process.env).
// Secrets (API keys, tokens) are NOT read here — they are loaded only
// by the credential proxy (credential-proxy.ts), never exposed to containers.
const envConfig = readEnvFile(['ASSISTANT_NAME', 'ASSISTANT_HAS_OWN_NUMBER']);

export const ASSISTANT_NAME =
  process.env.ASSISTANT_NAME || envConfig.ASSISTANT_NAME || 'Andy';
export const ASSISTANT_HAS_OWN_NUMBER =
  (process.env.ASSISTANT_HAS_OWN_NUMBER ||
    envConfig.ASSISTANT_HAS_OWN_NUMBER) === 'true';
export const SOLVY_ENABLED =
  (process.env.SOLVY_ENABLED) === 'true';
export const POLL_INTERVAL = 2000;
export const SCHEDULER_POLL_INTERVAL = 60000;

// Absolute paths needed for container mounts
const PROJECT_ROOT = process.cwd();
const HOME_DIR = process.env.HOME || os.homedir();

// When running in a container, state lives in a separate mounted volume
const STATE_DIR = process.env.NANOCLAW_STATE_DIR || PROJECT_ROOT;

// Mount security: allowlist stored OUTSIDE project root, never mounted into containers
const CONFIG_DIR =
  process.env.NANOCLAW_CONFIG_DIR ||
  path.join(HOME_DIR, '.config', 'nanoclaw');
export const MOUNT_ALLOWLIST_PATH = path.join(
  CONFIG_DIR,
  'mount-allowlist.json',
);
export const SENDER_ALLOWLIST_PATH = path.join(
  CONFIG_DIR,
  'sender-allowlist.json',
);
export const STORE_DIR = path.resolve(STATE_DIR, 'store');
export const GROUPS_DIR = path.resolve(STATE_DIR, 'groups');
export const DATA_DIR = path.resolve(STATE_DIR, 'data');

// Host-path translation for sibling container mounts.
// When NanoClaw runs in a container, docker -v paths must use host paths.
export const DOCKER_HOST_REPO_PATH = process.env.DOCKER_HOST_REPO_PATH || '';
export const DOCKER_HOST_STATE_PATH = process.env.DOCKER_HOST_STATE_PATH || '';

// Label constants for container management
export const NANOCLAW_LABEL = 'nanoclaw.managed=true';
// Docker Desktop project grouping — agent containers appear under the "nanoclaw" project
export const COMPOSE_PROJECT_LABEL = 'com.docker.compose.project=nanoclaw';
export const COMPOSE_SERVICE_LABEL = 'com.docker.compose.service=workers';

export const CONTAINER_IMAGE =
  process.env.CONTAINER_IMAGE || 'nanoclaw-agent:latest';
export const CONTAINER_TIMEOUT = parseInt(
  process.env.CONTAINER_TIMEOUT || '1800000',
  10,
);
export const CONTAINER_MAX_OUTPUT_SIZE = parseInt(
  process.env.CONTAINER_MAX_OUTPUT_SIZE || '10485760',
  10,
); // 10MB default
export const CREDENTIAL_PROXY_PORT = parseInt(
  process.env.CREDENTIAL_PROXY_PORT || '3001',
  10,
);
export const IPC_POLL_INTERVAL = 1000;
export const IDLE_TIMEOUT = parseInt(process.env.IDLE_TIMEOUT || '1800000', 10); // 30min default — how long to keep container alive after last result
export const MAX_CONCURRENT_CONTAINERS = Math.max(
  1,
  parseInt(process.env.MAX_CONCURRENT_CONTAINERS || '5', 10) || 5,
);
export const MAX_WORKER_CHILD_CONTAINERS = Math.max(
  0,
  parseInt(process.env.MAX_WORKER_CHILD_CONTAINERS || '3', 10),
);
export const WORKER_PORT_RANGE_START = parseInt(
  process.env.WORKER_PORT_RANGE_START || '8900',
  10,
);
export const WORKER_PORT_RANGE_END = parseInt(
  process.env.WORKER_PORT_RANGE_END || '9000',
  10,
);
export const WORKER_CONTAINER_BUILD_TIMEOUT = parseInt(
  process.env.WORKER_CONTAINER_BUILD_TIMEOUT || '300000',
  10,
);

function escapeRegex(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export const TRIGGER_PATTERN = new RegExp(
  `^@${escapeRegex(ASSISTANT_NAME)}\\b`,
  'i',
);

// Timezone for scheduled tasks (cron expressions, etc.)
// Uses system timezone by default
export const TIMEZONE =
  process.env.TZ || Intl.DateTimeFormat().resolvedOptions().timeZone;
