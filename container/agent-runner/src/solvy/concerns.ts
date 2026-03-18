/**
 * Concern lifecycle: raise, clarify, process, queue drain, rework.
 */

import * as db from './db.js';
import { log } from './state-machine.js';

const CONCERN_SATURATION_THRESHOLD = parseInt(process.env.SOLVY_CONCERN_SATURATION_THRESHOLD || '5', 10);

export interface ReworkResult {
  steps_skipped: string[];
  steps_reactivated: string[];
  strategies_skipped: string[];
  branches_archived: string[];
}

/**
 * Raise a concern on a node. Returns the concern and whether saturation is reached.
 */
export function raiseConcern(
  contextId: string,
  nodeType: string,
  nodeId: string,
  sourcePhase: string,
  description: string,
  interpretations: Array<{ label: string; description: string; likelihood: string }>,
  wideningApplied?: string,
): { concern: db.ConcernRow; saturationReached: boolean } {
  const concern = db.createConcern(contextId, nodeType, nodeId, sourcePhase, description, interpretations, wideningApplied);
  const activeConcerns = db.getActiveConcerns(contextId);
  const saturationReached = activeConcerns.length >= CONCERN_SATURATION_THRESHOLD;
  log('concern', concern.concern_id, `raised on ${nodeType}/${nodeId} saturation=${saturationReached}`);
  return { concern, saturationReached };
}

/**
 * Record a user's clarification for a concern.
 */
export function clarifyConcern(contextId: string, shortId: string, userMessage: string): db.ConcernRow {
  const concern = db.getConcernByShortId(contextId, shortId);
  if (!concern) throw new Error(`Concern not found: ${shortId}`);
  if (concern.status !== 'raised') throw new Error(`Concern ${shortId} is not in 'raised' state (current: ${concern.status})`);

  log('concern', concern.concern_id, `raised → clarified`);
  db.updateConcern(concern.concern_id, {
    status: 'clarified',
    user_message: userMessage,
  });

  return db.getConcern(concern.concern_id)!;
}

/**
 * Process a clarified concern: apply impact assessment and rework.
 */
export function processConcern(
  contextId: string,
  concernId: string,
  selectedInterpretation: string,
  impact: 'none' | 'compatible' | 'significant',
  reasoning: string,
  nodesToRework?: string[],
  reworkInstructions?: Record<string, string>,
): ReworkResult {
  const concern = db.getConcern(concernId);
  if (!concern) throw new Error(`Concern not found: ${concernId}`);

  log('concern', concernId, `→ processed impact=${impact}`);
  db.updateConcern(concernId, {
    status: 'processed',
    selected_interpretation: selectedInterpretation,
    impact,
    impact_reasoning: reasoning,
    nodes_to_rework: nodesToRework ? JSON.stringify(nodesToRework) : null,
    rework_instructions: reworkInstructions ? JSON.stringify(reworkInstructions) : null,
  });

  const result: ReworkResult = {
    steps_skipped: [],
    steps_reactivated: [],
    strategies_skipped: [],
    branches_archived: [],
  };

  if (impact === 'none' || !nodesToRework || nodesToRework.length === 0) {
    return result;
  }

  // Apply rework to affected nodes
  for (const nodeId of nodesToRework) {
    // Try as step
    const step = db.getStep(nodeId);
    if (step) {
      if (impact === 'significant') {
        if (step.status === 'completed' || step.status === 'in_progress') {
          log('step', nodeId, `${step.status} → skipped (rework)`);
          db.updateStep(nodeId, { status: 'skipped' });
          result.steps_skipped.push(nodeId);
        }
      } else if (impact === 'compatible') {
        if (step.status === 'skipped') {
          log('step', nodeId, `skipped → pending (rework)`);
          db.updateStep(nodeId, { status: 'pending' });
          result.steps_reactivated.push(nodeId);
        }
      }
      continue;
    }

    // Try as strategy
    const strategy = db.getStrategy(nodeId);
    if (strategy) {
      if (strategy.status === 'pending') {
        log('strategy', nodeId, `pending → skipped (rework)`);
        db.updateStrategy(nodeId, { status: 'skipped' });
        result.strategies_skipped.push(nodeId);
      }
      continue;
    }
  }

  return result;
}

/**
 * Get concerns that are ready to be drained at a step boundary.
 */
export function getConcernsToDrain(contextId: string): db.ConcernRow[] {
  return db.getClarifiedConcerns(contextId);
}
