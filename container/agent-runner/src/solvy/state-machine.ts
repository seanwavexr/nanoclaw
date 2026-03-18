/**
 * State machine: valid transitions, escalation chain, budget tracking.
 */

import { solvyLog } from './log.js';

export function log(entity: string, id: string, message: string): void {
  solvyLog(`${entity}(${id}): ${message}`);
}

// --- Session states ---
export type SessionState = 'new' | 'classifying' | 'validating' | 'planning' | 'executing' | 'suspended' | 'completed' | 'failed';

const SESSION_TRANSITIONS: Record<SessionState, SessionState[]> = {
  new: ['classifying', 'completed', 'failed'],
  classifying: ['validating', 'planning', 'completed', 'failed'],  // simple tasks go straight to completed
  validating: ['planning', 'classifying', 'completed', 'failed'],  // re-validate loops back
  planning: ['executing', 'completed', 'failed'],
  executing: ['suspended', 'completed', 'failed', 'planning'],  // planning for sub-plans
  suspended: ['executing', 'completed', 'failed'],
  completed: [],
  failed: [],
};

export function canTransitionSession(from: SessionState, to: SessionState): boolean {
  return SESSION_TRANSITIONS[from]?.includes(to) ?? false;
}

export function transitionSession(from: SessionState, to: SessionState): SessionState {
  if (!canTransitionSession(from, to)) {
    throw new Error(`Invalid session transition: ${from} → ${to}`);
  }
  return to;
}

// --- Step states ---
export type StepStatus = 'pending' | 'in_progress' | 'completed' | 'blocked' | 'skipped' | 'failed';

const STEP_TRANSITIONS: Record<StepStatus, StepStatus[]> = {
  pending: ['in_progress', 'skipped'],
  in_progress: ['completed', 'blocked', 'failed'],
  blocked: ['in_progress', 'skipped', 'failed'],  // unblocked after strategy succeeds
  completed: [],
  skipped: ['pending'],  // reactivated by concern rework
  failed: [],
};

export function canTransitionStep(from: StepStatus, to: StepStatus): boolean {
  return STEP_TRANSITIONS[from]?.includes(to) ?? false;
}

// --- Strategy states ---
export type StrategyStatus = 'pending' | 'in_progress' | 'succeeded' | 'failed' | 'skipped';

const STRATEGY_TRANSITIONS: Record<StrategyStatus, StrategyStatus[]> = {
  pending: ['in_progress', 'skipped'],
  in_progress: ['succeeded', 'failed'],
  succeeded: [],
  failed: [],
  skipped: [],
};

export function canTransitionStrategy(from: StrategyStatus, to: StrategyStatus): boolean {
  return STRATEGY_TRANSITIONS[from]?.includes(to) ?? false;
}

// --- Escalation chain ---
export type EscalationAction =
  | 'step_unblocked'
  | 'try_next_strategy'
  | 'exploratory_round'
  | 'widen_research'
  | 'reframe'
  | 'check_concerns'
  | 'escalate'
  | 'terminal_failure';

export interface EscalationContext {
  pendingStrategiesRemaining: number;
  exploratoryStrategiesUsed: number;
  maxExploratoryRounds: number;
  researchRounds: number;
  maxResearchRounds: number;
  activeConcernsCount: number;
  totalAttempts: number;
  maxTotalAttempts: number;
  totalProblems: number;
  maxProblems: number;
}

/**
 * Determine the next escalation action after an attempt fails.
 * Walks the chain: next strategy → exploratory → widen → reframe → check concerns → escalate → terminal.
 */
export function getNextEscalationAction(ctx: EscalationContext): EscalationAction {
  // Budget exhausted → terminal
  if (ctx.totalAttempts >= ctx.maxTotalAttempts) {
    return 'terminal_failure';
  }
  if (ctx.totalProblems >= ctx.maxProblems) {
    return 'terminal_failure';
  }

  // More pending strategies → try next
  if (ctx.pendingStrategiesRemaining > 0) {
    return 'try_next_strategy';
  }

  // Haven't exhausted exploratory rounds → try exploratory
  if (ctx.exploratoryStrategiesUsed < ctx.maxExploratoryRounds) {
    return 'exploratory_round';
  }

  // Haven't exhausted research rounds → widen research
  if (ctx.researchRounds < ctx.maxResearchRounds) {
    return 'widen_research';
  }

  // Have active concerns → check them
  if (ctx.activeConcernsCount > 0) {
    return 'check_concerns';
  }

  // Try reframing
  if (ctx.researchRounds < ctx.maxResearchRounds + 1) {
    return 'reframe';
  }

  // Last resort
  return 'escalate';
}

// --- Budget defaults ---
export const BUDGET_DEFAULTS = {
  maxTotalAttempts: parseInt(process.env.SOLVY_MAX_TOTAL_ATTEMPTS || '20', 10),
  maxProblems: parseInt(process.env.SOLVY_MAX_PROBLEMS || '5', 10),
  maxStrategiesPerProblem: parseInt(process.env.SOLVY_MAX_STRATEGIES_PER_PROBLEM || '5', 10),
  maxExploratoryRounds: parseInt(process.env.SOLVY_MAX_EXPLORATORY_ROUNDS || '2', 10),
  maxResearchRounds: parseInt(process.env.SOLVY_MAX_RESEARCH_ROUNDS || '3', 10),
  maxPlanDepth: parseInt(process.env.SOLVY_MAX_PLAN_DEPTH || '3', 10),
  reservedAttemptsPerStrategy: parseInt(process.env.SOLVY_RESERVED_ATTEMPTS_PER_STRATEGY || '1', 10),
};

export interface Budget {
  total_attempts_remaining: number;
  max_problems_remaining: number;
  max_strategies_per_problem: number;
}

export function computeBudget(totalAttempts: number, totalProblems: number): Budget {
  return {
    total_attempts_remaining: Math.max(0, BUDGET_DEFAULTS.maxTotalAttempts - totalAttempts),
    max_problems_remaining: Math.max(0, BUDGET_DEFAULTS.maxProblems - totalProblems),
    max_strategies_per_problem: BUDGET_DEFAULTS.maxStrategiesPerProblem,
  };
}
