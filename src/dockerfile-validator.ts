/**
 * Validates Dockerfiles and docker run arguments for worker-spawned containers.
 * Prevents sandbox escapes and enforces port/capability constraints.
 */
import { execSync } from 'child_process';

import {
  WORKER_PORT_RANGE_END,
  WORKER_PORT_RANGE_START,
} from './config.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

/**
 * Validate a Dockerfile's content for safety.
 */
export function validateDockerfile(content: string): ValidationResult {
  const errors: string[] = [];

  // Block COPY --from referencing host paths (multi-stage is fine with named stages)
  if (/FROM\s+scratch/i.test(content)) {
    const copyFromLines = content
      .split('\n')
      .filter((l) => /COPY\s+--from=/i.test(l));
    for (const line of copyFromLines) {
      // Allow named stages (alphanumeric), block paths
      const match = line.match(/--from=(\S+)/i);
      if (match && /[/\\.]/.test(match[1])) {
        errors.push(
          `Unsafe COPY --from with path reference: ${line.trim()}`,
        );
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate that a build context path is safe (within allowed directory, no traversal).
 */
export function validateBuildContext(
  contextPath: string,
  allowedBase: string,
): ValidationResult {
  const errors: string[] = [];

  if (contextPath.includes('..')) {
    errors.push('Build context path must not contain ".." traversal');
  }

  // Normalize and check containment
  const normalizedContext = contextPath.replace(/\\/g, '/');
  const normalizedBase = allowedBase.replace(/\\/g, '/');
  if (!normalizedContext.startsWith(normalizedBase)) {
    errors.push(
      `Build context must be within ${allowedBase}, got ${contextPath}`,
    );
  }

  return { valid: errors.length === 0, errors };
}

const BLOCKED_FLAGS = [
  '--privileged',
  '--pid=host',
  '--ipc=host',
  '--network=host',
];

const BLOCKED_CAP_ADD = [
  'SYS_ADMIN',
  'NET_ADMIN',
  'SYS_PTRACE',
  'ALL',
];

/**
 * Validate docker run arguments for safety.
 */
export function validateRunArgs(args: string[]): ValidationResult {
  const errors: string[] = [];

  for (const arg of args) {
    // Block dangerous flags
    for (const blocked of BLOCKED_FLAGS) {
      if (arg === blocked) {
        errors.push(`Blocked flag: ${arg}`);
      }
    }

    // Block docker socket mount
    if (arg.includes('/var/run/docker.sock')) {
      errors.push('Cannot mount Docker socket');
    }

    // Block dangerous capabilities
    if (arg.startsWith('--cap-add')) {
      const cap = arg.includes('=') ? arg.split('=')[1] : '';
      if (BLOCKED_CAP_ADD.includes(cap.toUpperCase())) {
        errors.push(`Blocked capability: ${cap}`);
      }
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate port mappings are within the allowed range and not conflicting.
 */
export function validatePorts(
  ports: string[],
  ownerGroup: string,
): ValidationResult {
  const errors: string[] = [];

  const requestedHostPorts: number[] = [];

  for (const mapping of ports) {
    const parts = mapping.split(':');
    if (parts.length !== 2) {
      errors.push(`Invalid port mapping format: ${mapping} (expected "hostPort:containerPort")`);
      continue;
    }

    const hostPort = parseInt(parts[0], 10);
    if (isNaN(hostPort)) {
      errors.push(`Invalid host port: ${parts[0]}`);
      continue;
    }

    if (hostPort < WORKER_PORT_RANGE_START || hostPort > WORKER_PORT_RANGE_END) {
      errors.push(
        `Host port ${hostPort} outside allowed range ${WORKER_PORT_RANGE_START}-${WORKER_PORT_RANGE_END}`,
      );
    }

    requestedHostPorts.push(hostPort);
  }

  // Check for conflicts with other workers' child containers
  if (requestedHostPorts.length > 0) {
    try {
      const output = execSync(
        `${CONTAINER_RUNTIME_BIN} ps --filter label=nanoclaw.child-container=true --format "{{.Ports}} {{.Labels}}"`,
        { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 10000 },
      );

      for (const line of output.trim().split('\n').filter(Boolean)) {
        // Skip containers owned by the same group (they'll be replaced)
        if (line.includes(`nanoclaw.worker-owner=${ownerGroup}`)) continue;

        // Parse port bindings like "0.0.0.0:8900->80/tcp"
        const portMatches = line.matchAll(/(\d+)->/g);
        for (const match of portMatches) {
          const usedPort = parseInt(match[1], 10);
          if (requestedHostPorts.includes(usedPort)) {
            errors.push(
              `Host port ${usedPort} already in use by another worker's container`,
            );
          }
        }
      }
    } catch {
      // If we can't check, allow it — docker will fail on conflict anyway
    }
  }

  return { valid: errors.length === 0, errors };
}
