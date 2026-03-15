/**
 * Host-side handler for worker-managed Docker containers.
 * Workers write IPC requests; this module validates and executes them.
 */
import { execSync } from 'child_process';
import fs from 'fs';
import path from 'path';

import {
  COMPOSE_PROJECT_LABEL,
  DATA_DIR,
  MAX_WORKER_CHILD_CONTAINERS,
  NANOCLAW_LABEL,
  WORKER_CONTAINER_BUILD_TIMEOUT,
} from './config.js';
import { toHostPath } from './container-runner.js';
import { CONTAINER_RUNTIME_BIN } from './container-runtime.js';
import {
  validateBuildContext,
  validateDockerfile,
  validatePorts,
  validateRunArgs,
} from './dockerfile-validator.js';
import { logger } from './logger.js';
import { RegisteredGroup } from './types.js';

export interface ContainerIpcDeps {
  registeredGroups: () => Record<string, RegisteredGroup>;
}

interface ContainerIpcRequest {
  type: string;
  responseId: string;
  [key: string]: unknown;
}

function writeResponse(
  ipcBaseDir: string,
  sourceGroup: string,
  responseId: string,
  data: object,
): void {
  const responsesDir = path.join(
    ipcBaseDir,
    sourceGroup,
    'containers',
    'responses',
  );
  fs.mkdirSync(responsesDir, { recursive: true });

  const filePath = path.join(responsesDir, `${responseId}.json`);
  const tempPath = `${filePath}.tmp`;
  fs.writeFileSync(tempPath, JSON.stringify(data, null, 2));
  fs.renameSync(tempPath, filePath);
}

function ownerLabel(groupFolder: string): string {
  return `nanoclaw.worker-owner=${groupFolder}`;
}

function verifyOwnership(containerId: string, groupFolder: string): boolean {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} inspect --format "{{index .Config.Labels \\"nanoclaw.worker-owner\\"}}" ${containerId}`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 10000 },
    );
    return output.trim() === groupFolder;
  } catch {
    return false;
  }
}

function countChildContainers(groupFolder: string): number {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps -a --filter label=${ownerLabel(groupFolder)} --filter label=nanoclaw.child-container=true --format "{{.ID}}"`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 10000 },
    );
    return output.trim().split('\n').filter(Boolean).length;
  } catch {
    return 0;
  }
}

function getMaxChildContainers(
  sourceGroup: string,
  deps: ContainerIpcDeps,
): number {
  const groups = deps.registeredGroups();
  for (const group of Object.values(groups)) {
    if (group.folder === sourceGroup && group.containerConfig?.maxChildContainers != null) {
      return group.containerConfig.maxChildContainers;
    }
  }
  return MAX_WORKER_CHILD_CONTAINERS;
}

export async function processContainerIpc(
  data: ContainerIpcRequest,
  sourceGroup: string,
  deps: ContainerIpcDeps,
): Promise<void> {
  const ipcBaseDir = path.join(DATA_DIR, 'ipc');
  const { type, responseId } = data;

  const respond = (result: object) =>
    writeResponse(ipcBaseDir, sourceGroup, responseId, result);

  try {
    switch (type) {
      case 'container_build':
        await handleBuild(data, sourceGroup, deps, respond);
        break;
      case 'container_list':
        handleList(sourceGroup, respond);
        break;
      case 'container_quota':
        handleQuota(sourceGroup, deps, respond);
        break;
      case 'container_stop':
        handleLifecycle('stop', data, sourceGroup, respond);
        break;
      case 'container_restart':
        handleLifecycle('restart', data, sourceGroup, respond);
        break;
      case 'container_destroy':
        handleDestroy(data, sourceGroup, respond);
        break;
      case 'container_exec':
        handleExec(data, sourceGroup, respond);
        break;
      case 'container_logs':
        handleLogs(data, sourceGroup, respond);
        break;
      default:
        respond({ success: false, error: `Unknown container operation: ${type}` });
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logger.error({ err, type, sourceGroup }, 'Container IPC error');
    respond({ success: false, error: msg });
  }
}

async function handleBuild(
  data: ContainerIpcRequest,
  sourceGroup: string,
  deps: ContainerIpcDeps,
  respond: (r: object) => void,
): Promise<void> {
  const ports = (data.ports as string[]) || [];
  const volumes = (data.volumes as string[]) || [];
  const dockerfilePath = (data.dockerfile_path as string) || 'Dockerfile';
  const imageName =
    (data.image_name as string) ||
    `nanoclaw-child-${sourceGroup}-${Date.now()}`;

  // Check quota
  const maxContainers = getMaxChildContainers(sourceGroup, deps);
  const currentCount = countChildContainers(sourceGroup);
  if (currentCount >= maxContainers) {
    respond({
      success: false,
      error: `Container quota exceeded: ${currentCount}/${maxContainers}. Stop or destroy existing containers first.`,
    });
    return;
  }

  // Resolve paths
  const workerContainersDir = path.join(
    DATA_DIR,
    'worker-containers',
    sourceGroup,
  );
  const hostContextDir = workerContainersDir;
  const dockerfileFullPath = path.join(hostContextDir, dockerfilePath);

  if (!fs.existsSync(dockerfileFullPath)) {
    respond({
      success: false,
      error: `Dockerfile not found at /workspace/containers/${dockerfilePath}`,
    });
    return;
  }

  // Validate Dockerfile
  const dockerfileContent = fs.readFileSync(dockerfileFullPath, 'utf-8');
  const dfValidation = validateDockerfile(dockerfileContent);
  if (!dfValidation.valid) {
    respond({ success: false, error: `Dockerfile validation failed: ${dfValidation.errors.join('; ')}` });
    return;
  }

  // Validate build context
  const contextValidation = validateBuildContext(
    hostContextDir,
    workerContainersDir,
  );
  if (!contextValidation.valid) {
    respond({ success: false, error: `Build context validation failed: ${contextValidation.errors.join('; ')}` });
    return;
  }

  // Validate ports
  const portValidation = validatePorts(ports, sourceGroup);
  if (!portValidation.valid) {
    respond({ success: false, error: `Port validation failed: ${portValidation.errors.join('; ')}` });
    return;
  }

  // Validate and resolve volumes
  // Workers specify paths relative to /workspace/containers/ (their workspace).
  // We translate to host paths for docker run -v (daemon resolves these).
  const volumeFlags: string[] = [];
  for (const vol of volumes) {
    const parts = vol.split(':');
    if (parts.length < 2 || parts.length > 3) {
      respond({
        success: false,
        error: `Invalid volume format: "${vol}" (expected "/workspace/containers/subdir:/container/path")`,
      });
      return;
    }
    const [workerPath, containerPath] = parts;
    const readonlyFlag = parts[2] || '';

    // Must be under /workspace/containers/
    if (!workerPath.startsWith('/workspace/containers/') && workerPath !== '/workspace/containers') {
      respond({
        success: false,
        error: `Volume source must be under /workspace/containers/, got "${workerPath}"`,
      });
      return;
    }

    // Prevent traversal
    if (workerPath.includes('..')) {
      respond({ success: false, error: `Volume path must not contain ".."` });
      return;
    }

    // Translate /workspace/containers/X → {workerContainersDir}/X
    const relativePath = workerPath.replace('/workspace/containers', '');
    const localPath = path.join(workerContainersDir, relativePath);
    fs.mkdirSync(localPath, { recursive: true });

    // docker run -v needs host-visible path (daemon resolves it)
    const hostPath = toHostPath(localPath);
    const mountSpec = readonlyFlag
      ? `${hostPath}:${containerPath}:${readonlyFlag}`
      : `${hostPath}:${containerPath}`;
    volumeFlags.push('-v', mountSpec);
  }

  // Validate run args (ports as -p flags)
  const runFlags = ports.flatMap((p) => ['-p', p]);
  const allRunFlags = [...runFlags, ...volumeFlags];
  const runValidation = validateRunArgs(allRunFlags);
  if (!runValidation.valid) {
    respond({ success: false, error: `Run args validation failed: ${runValidation.errors.join('; ')}` });
    return;
  }

  // Build — use container-local paths for docker build context.
  // Unlike `docker run -v` (which the daemon resolves), `docker build`
  // has the CLI tar up the context directory, so it must be a path
  // the CLI process can read (i.e., inside this container).
  const buildContext = hostContextDir;
  const buildDockerfile = dockerfileFullPath;
  const labels = [
    '--label', NANOCLAW_LABEL,
    '--label', ownerLabel(sourceGroup),
    '--label', 'nanoclaw.child-container=true',
    '--label', COMPOSE_PROJECT_LABEL,
  ];

  try {
    const buildCmd = [
      CONTAINER_RUNTIME_BIN, 'build',
      '-t', imageName,
      '-f', buildDockerfile,
      ...labels,
      buildContext,
    ].join(' ');

    logger.info({ sourceGroup, imageName }, 'Building child container image');
    execSync(buildCmd, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: WORKER_CONTAINER_BUILD_TIMEOUT,
    });
  } catch (err) {
    const msg = err instanceof Error ? (err as { stderr?: string }).stderr || err.message : String(err);
    respond({ success: false, error: `Docker build failed: ${msg.slice(-500)}` });
    return;
  }

  // Run
  const containerName = `nanoclaw-child-${sourceGroup}-${Date.now()}`;
  try {
    const runCmd = [
      CONTAINER_RUNTIME_BIN, 'run', '-d',
      '--name', containerName,
      ...runFlags,
      ...volumeFlags,
      ...labels,
      imageName,
    ].join(' ');

    logger.info({ sourceGroup, containerName, ports }, 'Starting child container');
    const containerId = execSync(runCmd, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 30000,
    }).trim();

    respond({
      success: true,
      containerId: containerId.slice(0, 12),
      containerName,
      ports,
    });
  } catch (err) {
    const msg = err instanceof Error ? (err as { stderr?: string }).stderr || err.message : String(err);
    respond({ success: false, error: `Docker run failed: ${msg.slice(-500)}` });
  }
}

function handleList(
  sourceGroup: string,
  respond: (r: object) => void,
): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps -a --filter label=${ownerLabel(sourceGroup)} --filter label=nanoclaw.child-container=true --format "{{json .}}"`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 10000 },
    );

    const containers = output
      .trim()
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);

    respond({ success: true, containers });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    respond({ success: false, error: `Failed to list containers: ${msg}` });
  }
}

function handleQuota(
  sourceGroup: string,
  deps: ContainerIpcDeps,
  respond: (r: object) => void,
): void {
  const max = getMaxChildContainers(sourceGroup, deps);
  const current = countChildContainers(sourceGroup);
  respond({ success: true, current, max, available: max - current });
}

function handleLifecycle(
  action: 'stop' | 'restart',
  data: ContainerIpcRequest,
  sourceGroup: string,
  respond: (r: object) => void,
): void {
  const containerId = data.container_id as string;
  if (!containerId) {
    respond({ success: false, error: 'Missing container_id' });
    return;
  }

  if (!verifyOwnership(containerId, sourceGroup)) {
    respond({ success: false, error: 'Container not found or not owned by this worker' });
    return;
  }

  try {
    execSync(`${CONTAINER_RUNTIME_BIN} ${action} ${containerId}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 30000,
    });
    respond({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    respond({ success: false, error: `Failed to ${action} container: ${msg}` });
  }
}

function handleDestroy(
  data: ContainerIpcRequest,
  sourceGroup: string,
  respond: (r: object) => void,
): void {
  const containerId = data.container_id as string;
  if (!containerId) {
    respond({ success: false, error: 'Missing container_id' });
    return;
  }

  if (!verifyOwnership(containerId, sourceGroup)) {
    respond({ success: false, error: 'Container not found or not owned by this worker' });
    return;
  }

  try {
    execSync(`${CONTAINER_RUNTIME_BIN} rm -f ${containerId}`, {
      stdio: ['pipe', 'pipe', 'pipe'],
      encoding: 'utf-8',
      timeout: 30000,
    });
    respond({ success: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    respond({ success: false, error: `Failed to destroy container: ${msg}` });
  }
}

function handleExec(
  data: ContainerIpcRequest,
  sourceGroup: string,
  respond: (r: object) => void,
): void {
  const containerId = data.container_id as string;
  const command = data.command as string;
  if (!containerId || !command) {
    respond({ success: false, error: 'Missing container_id or command' });
    return;
  }

  if (!verifyOwnership(containerId, sourceGroup)) {
    respond({ success: false, error: 'Container not found or not owned by this worker' });
    return;
  }

  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} exec ${containerId} sh -c ${JSON.stringify(command)}`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 30000 },
    );
    respond({ success: true, output });
  } catch (err) {
    const execErr = err as { stdout?: string; stderr?: string; message: string };
    respond({
      success: false,
      error: `Exec failed: ${(execErr.stderr || execErr.message).slice(-500)}`,
      stdout: execErr.stdout || '',
    });
  }
}

function handleLogs(
  data: ContainerIpcRequest,
  sourceGroup: string,
  respond: (r: object) => void,
): void {
  const containerId = data.container_id as string;
  const tail = (data.tail as number) || 100;
  if (!containerId) {
    respond({ success: false, error: 'Missing container_id' });
    return;
  }

  if (!verifyOwnership(containerId, sourceGroup)) {
    respond({ success: false, error: 'Container not found or not owned by this worker' });
    return;
  }

  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} logs --tail ${tail} ${containerId}`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8', timeout: 10000 },
    );
    respond({ success: true, logs: output });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    respond({ success: false, error: `Failed to get logs: ${msg}` });
  }
}

/**
 * Clean up orphaned child containers whose owner group no longer exists.
 */
export function cleanupOrphanedChildContainers(
  existingGroupFolders: Set<string>,
): void {
  try {
    const output = execSync(
      `${CONTAINER_RUNTIME_BIN} ps -a --filter label=nanoclaw.child-container=true --format "{{.Names}}"`,
      { stdio: ['pipe', 'pipe', 'pipe'], encoding: 'utf-8' },
    );
    const childContainers = output.trim().split('\n').filter(Boolean);

    for (const name of childContainers) {
      // Extract group folder from container name: nanoclaw-child-{groupFolder}-{timestamp}
      const match = name.match(/^nanoclaw-child-(.+)-\d+$/);
      if (match) {
        const ownerFolder = match[1];
        if (!existingGroupFolders.has(ownerFolder)) {
          try {
            execSync(`${CONTAINER_RUNTIME_BIN} rm -f ${name}`, {
              stdio: 'pipe',
            });
            logger.info(
              { name, ownerFolder },
              'Cleaned up orphaned child container',
            );
          } catch {
            /* already removed */
          }
        }
      }
    }
  } catch (err) {
    logger.warn({ err }, 'Failed to clean up orphaned child containers');
  }
}
