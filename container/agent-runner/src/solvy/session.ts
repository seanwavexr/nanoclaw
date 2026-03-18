/**
 * Session lifecycle: begin, end, load, save.
 */

import * as db from './db.js';
import { log, transitionSession, type SessionState } from './state-machine.js';
import { generateSummary } from './summary.js';
import { cleanupContextWorktrees } from './worktree.js';

export interface BeginResult {
  context_id: string;
  status: 'created' | 'resumed';
  session_state: SessionState;
}

/**
 * Begin a session: create new or resume existing.
 */
export function beginSession(contextId?: string): BeginResult {
  if (!contextId) {
    // Create new session
    const id = db.genId();
    const session = db.createSession(id);
    log('session', session.context_id, `created`);
    return {
      context_id: session.context_id,
      status: 'created',
      session_state: session.state as SessionState,
    };
  }

  // Try to resume
  const session = db.getSession(contextId);
  if (!session) {
    throw new Error(`Session not found: ${contextId}`);
  }

  log('session', session.context_id, `resumed`);
  return {
    context_id: session.context_id,
    status: 'resumed',
    session_state: session.state as SessionState,
  };
}

/**
 * End a session: persist state and optionally generate summary.
 */
export function endSession(
  contextId: string,
  reason: 'completed' | 'suspended' | 'failed',
  summary?: string,
): { context_id: string; status: string; summary_path?: string } {
  const session = db.getSession(contextId);
  if (!session) throw new Error(`Session not found: ${contextId}`);

  let targetState: SessionState;
  switch (reason) {
    case 'completed': targetState = 'completed'; break;
    case 'suspended': targetState = 'suspended'; break;
    case 'failed': targetState = 'failed'; break;
  }

  // Validate and apply state transition
  const currentState = session.state as SessionState;
  if (currentState !== 'completed' && currentState !== 'failed') {
    log('session', contextId, `state → ${targetState} reason=${reason}`);
    transitionSession(currentState, targetState);
    db.updateSession(contextId, {
      state: targetState,
      ended_at: reason !== 'suspended' ? new Date().toISOString() : null,
      end_reason: reason,
      summary: summary || null,
    });
  }

  let summaryPath: string | undefined;

  if (reason === 'completed' || reason === 'failed') {
    summaryPath = generateSummary(contextId, reason, summary);
  }

  return {
    context_id: contextId,
    status: reason,
    summary_path: summaryPath,
  };
}

/**
 * Update session state with transition validation.
 */
export function updateSessionState(contextId: string, newState: SessionState): void {
  const session = db.getSession(contextId);
  if (!session) throw new Error(`Session not found: ${contextId}`);

  const currentState = session.state as SessionState;
  log('session', contextId, `${currentState} → ${newState}`);
  transitionSession(currentState, newState);
  db.updateSession(contextId, { state: newState });
}
