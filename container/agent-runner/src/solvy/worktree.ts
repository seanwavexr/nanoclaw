/**
 * Git worktree management: create, promote, archive, cleanup.
 */

import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';

export function getWorkspacePrefix(): string {
  return process.env.SOLVY_WORKSPACE_PREFIX || '/workspace/group/';
}

export function getGitRoot(): string {
  return process.env.SOLVY_GIT_ROOT || '/workspace/group/';
}

/**
 * Ensure the git root is an initialized git repository.
 * Creates one with an initial commit if it doesn't exist yet.
 */
export function ensureGitRepo(): void {
  const gitRoot = getGitRoot();
  fs.mkdirSync(gitRoot, { recursive: true });

  const gitDir = path.join(gitRoot, '.git');
  if (fs.existsSync(gitDir)) return;

  execSync('git init', { cwd: gitRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  execSync('git config user.email "solvy@nanoclaw"', { cwd: gitRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  execSync('git config user.name "Solvy"', { cwd: gitRoot, stdio: ['pipe', 'pipe', 'pipe'] });
  // Need at least one commit for branches/worktrees to work
  execSync('git commit --allow-empty -m "solvy: initial commit"', { cwd: gitRoot, stdio: ['pipe', 'pipe', 'pipe'] });
}

function getWorktreeBase(contextId: string): string {
  return path.join(getWorkspacePrefix(), '.worktrees', contextId);
}

function exec(cmd: string, cwd?: string): string {
  try {
    return execSync(cmd, {
      cwd: cwd || getGitRoot(),
      encoding: 'utf-8',
      stdio: ['pipe', 'pipe', 'pipe'],
    }).trim();
  } catch (err: any) {
    throw new Error(`Git command failed: ${cmd}\n${err.stderr || err.message}`);
  }
}

/**
 * Create a worktree for a plan's context.
 * Returns the worktree path and branch name.
 */
export function createPlanWorktree(contextId: string): { worktreePath: string; branch: string } {
  const worktreePath = getWorktreeBase(contextId);
  const branch = `solvy/${contextId}`;

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  // Create branch from current HEAD if it doesn't exist
  try {
    exec(`git branch ${branch}`);
  } catch {
    // Branch might already exist (resume case)
  }

  try {
    exec(`git worktree add "${worktreePath}" ${branch}`);
  } catch {
    // Worktree might already exist (resume case)
    if (!fs.existsSync(worktreePath)) {
      throw new Error(`Failed to create worktree at ${worktreePath}`);
    }
  }

  return { worktreePath, branch };
}

/**
 * Create a worktree for a step, forked from the plan's branch.
 */
export function createStepWorktree(contextId: string, stepSequence: number, parentBranch: string): { worktreePath: string; branch: string } {
  const worktreePath = path.join(getWorktreeBase(contextId), `step-${stepSequence}`);
  const branch = `solvy/${contextId}-step-${stepSequence}`;

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  try {
    exec(`git branch ${branch} ${parentBranch}`);
  } catch {
    // Branch might already exist
  }

  try {
    exec(`git worktree add "${worktreePath}" ${branch}`);
  } catch {
    if (!fs.existsSync(worktreePath)) {
      throw new Error(`Failed to create step worktree at ${worktreePath}`);
    }
  }

  return { worktreePath, branch };
}

/**
 * Create a worktree for an attempt, forked from the step's branch.
 */
export function createAttemptWorktree(contextId: string, stepSequence: number, attemptNumber: number, parentBranch: string): { worktreePath: string; branch: string } {
  const worktreePath = path.join(getWorktreeBase(contextId), `step-${stepSequence}`, `attempt-${attemptNumber}`);
  const branch = `solvy/${contextId}-step-${stepSequence}-attempt-${attemptNumber}`;

  fs.mkdirSync(path.dirname(worktreePath), { recursive: true });

  try {
    exec(`git branch ${branch} ${parentBranch}`);
  } catch {
    // Branch might already exist
  }

  try {
    exec(`git worktree add "${worktreePath}" ${branch}`);
  } catch {
    if (!fs.existsSync(worktreePath)) {
      throw new Error(`Failed to create attempt worktree at ${worktreePath}`);
    }
  }

  return { worktreePath, branch };
}

/**
 * Promote a worktree's changes to its parent branch by merging.
 */
export function promoteWorktree(worktreePath: string, childBranch: string, parentBranch: string): boolean {
  try {
    // Commit any uncommitted changes in the child worktree
    try {
      exec('git add -A', worktreePath);
      exec('git commit -m "solvy: auto-commit before promote" --allow-empty', worktreePath);
    } catch {
      // Nothing to commit is fine
    }

    // Merge child into parent
    // Find the parent worktree path or use git root
    const parentWorktree = findWorktreeForBranch(parentBranch);
    const mergeCwd = parentWorktree || getGitRoot();

    exec(`git merge ${childBranch} --no-edit -m "solvy: promote ${childBranch}"`, mergeCwd);
    return true;
  } catch (err: any) {
    // Merge conflict — don't auto-resolve
    return false;
  }
}

/**
 * Archive a worktree (remove worktree but keep the branch for history).
 */
export function archiveWorktree(worktreePath: string): void {
  if (!fs.existsSync(worktreePath)) return;

  try {
    exec(`git worktree remove "${worktreePath}" --force`);
  } catch {
    // Force remove the directory if git worktree remove fails
    try {
      fs.rmSync(worktreePath, { recursive: true, force: true });
      exec('git worktree prune');
    } catch {
      // Best effort
    }
  }
}

/**
 * Clean up all worktrees for a context.
 */
export function cleanupContextWorktrees(contextId: string): void {
  const base = getWorktreeBase(contextId);
  if (fs.existsSync(base)) {
    // Remove all worktrees under this context
    try {
      exec(`git worktree remove "${base}" --force`);
    } catch {
      // May need to remove subdirectories first
      try {
        fs.rmSync(base, { recursive: true, force: true });
        exec('git worktree prune');
      } catch {
        // Best effort
      }
    }
  }

  // Clean up branches
  try {
    const branches = exec(`git branch --list "solvy/${contextId}*"`).split('\n').filter(Boolean).map(b => b.trim());
    for (const branch of branches) {
      try {
        exec(`git branch -D ${branch}`);
      } catch {
        // Best effort
      }
    }
  } catch {
    // Best effort
  }
}

function findWorktreeForBranch(branch: string): string | null {
  try {
    const output = exec('git worktree list --porcelain');
    const lines = output.split('\n');
    let currentPath: string | null = null;
    for (const line of lines) {
      if (line.startsWith('worktree ')) {
        currentPath = line.substring(9);
      }
      if (line.startsWith('branch refs/heads/') && line.substring(18) === branch) {
        return currentPath;
      }
    }
  } catch {
    // Fall through
  }
  return null;
}
