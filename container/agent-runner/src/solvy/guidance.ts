/**
 * Guidance generator: produces human-readable + machine-parseable guidance for each tool response.
 */

import * as db from './db.js';
import { computeBudget, BUDGET_DEFAULTS, getNextEscalationAction, type EscalationContext } from './state-machine.js';
import { getWorkspacePrefix } from './worktree.js';
import path from 'path';

export interface Guidance {
  next_action: string;
  message: string;
  [key: string]: unknown;
}

// --- Session guidance ---

export function guidanceForNewSession(contextId: string): Guidance {
  const workspacePath = path.join(getWorkspacePrefix(), '.worktrees', contextId);
  return {
    next_action: 'classify',
    message: 'New session created. Classify this task\'s complexity, then call solvy_classify.',
    workspace_path: workspacePath,
  };
}

export function guidanceForResumedSession(contextId: string): Guidance {
  const session = db.getSession(contextId)!;
  const activeConcerns = db.getActiveConcerns(contextId);
  const activeStep = db.getActiveStep(contextId);
  const workspacePath = path.join(getWorkspacePrefix(), '.worktrees', contextId);

  // Determine what to do based on session state
  let nextAction: string;
  let message: string;

  switch (session.state) {
    case 'new':
      nextAction = 'classify';
      message = 'Session resumed in new state. Classify this task\'s complexity.';
      break;
    case 'classifying':
      nextAction = 'classify';
      message = 'Session resumed during classification. Call solvy_classify.';
      break;
    case 'validating':
      nextAction = 'validate';
      message = 'Session resumed during validation. Call solvy_validate.';
      break;
    case 'planning':
      nextAction = 'plan';
      message = 'Session resumed during planning. Call solvy_plan_create.';
      break;
    case 'executing':
      if (activeStep) {
        if (activeStep.status === 'blocked') {
          nextAction = 'resume_research';
          message = `Session resumed. Step ${activeStep.sequence} is blocked. Resume research or strategy attempts.`;
        } else {
          nextAction = 'continue_step';
          message = `Session resumed. Continue executing step ${activeStep.sequence}: '${activeStep.description}'.`;
        }
      } else {
        nextAction = 'execute_step';
        message = 'Session resumed. Start the next pending step.';
      }
      break;
    default:
      nextAction = 'check_status';
      message = `Session in state '${session.state}'. Call solvy_status for details.`;
  }

  return {
    next_action: nextAction,
    message,
    workspace_path: workspacePath,
    active_step: activeStep ? {
      step_id: activeStep.step_id,
      sequence: activeStep.sequence,
      description: activeStep.description,
      status: activeStep.status,
    } : undefined,
    active_concerns: activeConcerns.map(c => ({
      short_id: c.short_id,
      description: c.description,
      status: c.status,
    })),
  };
}

// --- Classification guidance ---

export function guidanceForClassification(contextId: string, complexity: string): Guidance {
  if (complexity === 'simple') {
    return {
      next_action: 'handle_directly',
      message: 'Task is simple. Handle it directly without plan-solve. Call solvy_end when done.',
    };
  }
  return {
    next_action: 'validate',
    message: 'Task classified as complex. Validate the command for issues, then call solvy_validate.',
  };
}

// --- Validation guidance ---

export function guidanceForValidation(contextId: string, hasUserResponse: boolean, resolution?: string): Guidance {
  if (!hasUserResponse) {
    const validation = db.getLatestValidation(contextId);
    const issues = validation ? JSON.parse(validation.issues) : [];
    const issuesSummary = issues.map((i: any) => `- [${i.severity}] ${i.description}`).join('\n');
    return {
      next_action: 'ask_user',
      message: `Issues found. Ask the user about these issues, then call solvy_validate with their response:\n${issuesSummary}`,
      issues_count: issues.length,
    };
  }

  if (resolution === 'resolved' || resolution === 'overridden') {
    return {
      next_action: 'plan',
      message: 'Validation resolved. Create a plan by calling solvy_plan_create.',
    };
  }

  if (resolution === 'abandoned') {
    return {
      next_action: 'end',
      message: 'Task abandoned due to validation issues. Call solvy_end with reason "failed".',
    };
  }

  return {
    next_action: 're_validate',
    message: 'Partially resolved. Re-validate with updated issues by calling solvy_validate again.',
  };
}

// --- Plan guidance ---

export function guidanceForPlanCreated(contextId: string, planId: string): Guidance {
  const steps = db.getStepsByPlan(planId);
  const firstStep = steps[0];

  return {
    next_action: 'execute_step',
    message: `Plan created with ${steps.length} steps. Begin step 1: '${firstStep?.description || 'unknown'}'. Spawn a sub-agent to execute it, passing the context_id and step_id.`,
    next_step: firstStep ? {
      step_id: firstStep.step_id,
      sequence: firstStep.sequence,
      description: firstStep.description,
    } : undefined,
  };
}

// --- Step guidance ---

export function guidanceForStepStart(contextId: string, step: db.StepRow): Guidance {
  const totalAttempts = db.getTotalAttempts(contextId);
  const totalProblems = db.getTotalProblems(contextId);
  const budget = computeBudget(totalAttempts, totalProblems);
  const concernsToDrain = db.getClarifiedConcerns(contextId);

  return {
    next_action: 'execute',
    message: `Step ${step.sequence} worktree created at ${step.workspace_path}. Do your work there. When done, call solvy_step_complete. If you hit an obstacle, call solvy_step_fail.`,
    budget,
    concerns_to_drain: concernsToDrain.map(c => ({
      short_id: c.short_id,
      description: c.description,
    })),
  };
}

export function guidanceForStepComplete(contextId: string, step: db.StepRow, promoted: boolean): Guidance {
  const plan = db.getPlan(step.plan_id);
  if (!plan) throw new Error(`Plan not found: ${step.plan_id}`);

  const steps = db.getStepsByPlan(plan.plan_id);
  const completedSteps = steps.filter(s => s.status === 'completed').length;
  const nextStep = db.getNextPendingStep(plan.plan_id);

  if (!nextStep) {
    return {
      next_action: 'plan_complete',
      message: `Step ${step.sequence} complete. All ${steps.length} steps completed. Plan is done. Call solvy_end with reason "completed".`,
      progress: `${completedSteps}/${steps.length} steps completed`,
    };
  }

  return {
    next_action: 'execute_step',
    message: `Step ${step.sequence} complete.${promoted ? ' Promoted to parent branch.' : ''} Begin step ${nextStep.sequence}: '${nextStep.description}'.`,
    next_step: {
      step_id: nextStep.step_id,
      sequence: nextStep.sequence,
      description: nextStep.description,
    },
    progress: `${completedSteps}/${steps.length} steps completed`,
  };
}

export function guidanceForStepFail(contextId: string, problemId: string, problemDescription: string): Guidance {
  return {
    next_action: 'research',
    message: `Problem surfaced. Research the problem and generate strategies. Call solvy_research with your analysis.`,
    problem: {
      id: problemId,
      description: problemDescription,
    },
  };
}

// --- Research guidance ---

export function guidanceForResearch(contextId: string, researchId: string): Guidance {
  const strategies = db.getStrategiesByResearch(researchId);
  const topStrategy = strategies[0];
  const totalAttempts = db.getTotalAttempts(contextId);
  const totalProblems = db.getTotalProblems(contextId);
  const budget = computeBudget(totalAttempts, totalProblems);

  return {
    next_action: 'attempt_strategy',
    message: `Research complete. ${strategies.length} strategies generated. Attempt strategy 1: '${topStrategy?.description || 'unknown'}'. Spawn a sub-agent to execute it.`,
    top_strategy: topStrategy ? {
      strategy_id: topStrategy.strategy_id,
      description: topStrategy.description,
      type: topStrategy.type,
    } : undefined,
    budget: {
      total_attempts_remaining: budget.total_attempts_remaining,
      reserved_per_strategy: BUDGET_DEFAULTS.reservedAttemptsPerStrategy,
    },
  };
}

// --- Attempt guidance ---

export function guidanceForAttemptStart(contextId: string, attempt: db.AttemptRow): Guidance {
  return {
    next_action: 'execute_attempt',
    message: `Attempt worktree created at ${attempt.workspace_path}. Execute the strategy there. When done, call solvy_attempt_complete with your outputs and evaluation.`,
  };
}

export function guidanceForAttemptComplete(contextId: string, attempt: db.AttemptRow, satisfactory: boolean): Guidance {
  if (satisfactory) {
    // Strategy succeeded → unblock step
    const strategy = db.getStrategy(attempt.strategy_id)!;
    const research = db.getResearch(strategy.research_id)!;
    const problem = db.getProblem(research.problem_id)!;

    return {
      next_action: 'step_unblocked',
      message: `Attempt succeeded. Step unblocked. Continue executing step or call solvy_step_complete if the step's work is done.`,
      step_id: problem.step_id,
    };
  }

  // Failed — determine escalation
  const strategy = db.getStrategy(attempt.strategy_id)!;
  const research = db.getResearch(strategy.research_id)!;
  const problem = db.getProblem(research.problem_id)!;

  const allResearch = db.getResearchByProblem(problem.problem_id);
  let exploratoryCount = 0;
  let pendingStrategies = 0;

  for (const r of allResearch) {
    const strats = db.getStrategiesByResearch(r.research_id);
    for (const s of strats) {
      if (s.type === 'exploratory' && s.status !== 'pending') exploratoryCount++;
      if (s.status === 'pending') pendingStrategies++;
    }
  }

  const totalAttempts = db.getTotalAttempts(contextId);
  const totalProblems = db.getTotalProblems(contextId);
  const activeConcerns = db.getActiveConcerns(contextId);

  const escalationCtx: EscalationContext = {
    pendingStrategiesRemaining: pendingStrategies,
    exploratoryStrategiesUsed: exploratoryCount,
    maxExploratoryRounds: BUDGET_DEFAULTS.maxExploratoryRounds,
    researchRounds: allResearch.length,
    maxResearchRounds: BUDGET_DEFAULTS.maxResearchRounds,
    activeConcernsCount: activeConcerns.length,
    totalAttempts,
    maxTotalAttempts: BUDGET_DEFAULTS.maxTotalAttempts,
    totalProblems,
    maxProblems: BUDGET_DEFAULTS.maxProblems,
  };

  const nextAction = getNextEscalationAction(escalationCtx);
  const message = escalationMessage(nextAction, problem, contextId);

  const result: Guidance = { next_action: nextAction, message };

  // Include next strategy if applicable
  if (nextAction === 'try_next_strategy') {
    const next = db.getNextPendingStrategy(problem.problem_id);
    if (next) {
      result.next_strategy = {
        strategy_id: next.strategy_id,
        description: next.description,
        type: next.type,
      };
    }
  }

  return result;
}

function escalationMessage(action: string, problem: db.ProblemRow, contextId: string): string {
  switch (action) {
    case 'try_next_strategy': {
      const next = db.getNextPendingStrategy(problem.problem_id);
      return `Attempt failed. Try next strategy: '${next?.description || 'unknown'}'. Spawn a sub-agent.`;
    }
    case 'exploratory_round':
      return 'All direct strategies exhausted. Generate exploratory strategies via solvy_research with type "exploratory".';
    case 'widen_research':
      return 'Exploratory strategies exhausted. Widen research scope by calling solvy_research with broader analysis and parent_research_id.';
    case 'reframe':
      return 'Research exhausted. Reframe the problem: re-examine assumptions, consider alternative decompositions. Call solvy_research with fresh analysis.';
    case 'check_concerns':
      return 'Active concerns may be relevant. Review and process pending concerns via solvy_concern_process before continuing.';
    case 'escalate':
      return 'All automated strategies exhausted. Escalate to user: explain the problem, what was tried, and ask for guidance.';
    case 'terminal_failure':
      return 'Budget exhausted. Call solvy_step_fail or solvy_end with reason "failed".';
    default:
      return `Next action: ${action}`;
  }
}

// --- Concern guidance ---

export function guidanceForConcernRaised(contextId: string, saturationReached: boolean): Guidance {
  if (saturationReached) {
    return {
      next_action: 'pause_for_concerns',
      message: 'Concern saturation reached. Pause and ask the user to clarify outstanding concerns before continuing.',
    };
  }
  return {
    next_action: 'continue',
    message: 'Concern raised. Notify the user and continue with widened approach.',
  };
}

export function guidanceForConcernClarified(): Guidance {
  return {
    next_action: 'continue',
    message: 'Clarification recorded. Will be processed at next drain point.',
  };
}

export function guidanceForConcernProcessed(reworkApplied: Record<string, unknown>): Guidance {
  return {
    next_action: 'continue',
    message: 'Concern resolved. Continue execution.',
    rework_applied: reworkApplied,
  };
}

// --- Status guidance ---

export function guidanceForStatus(contextId: string): Guidance {
  const session = db.getSession(contextId)!;
  const activeStep = db.getActiveStep(contextId);
  const activePlan = db.getActivePlan(contextId);
  const workspacePath = path.join(getWorkspacePrefix(), '.worktrees', contextId);

  let nextAction: string;
  let message: string;

  if (session.state === 'executing' && activeStep) {
    const steps = activePlan ? db.getStepsByPlan(activePlan.plan_id) : [];
    const completed = steps.filter(s => s.status === 'completed').length;
    nextAction = activeStep.status === 'blocked' ? 'research' : 'execute_step';
    message = `Executing step ${activeStep.sequence} of ${steps.length}. ${completed} steps completed. Continue with current step.`;
  } else if (session.state === 'planning') {
    nextAction = 'plan';
    message = 'In planning phase. Create or continue plan.';
  } else {
    nextAction = 'check_state';
    message = `Session is in '${session.state}' state.`;
  }

  return {
    next_action: nextAction,
    message,
    workspace_path: activeStep?.workspace_path || workspacePath,
  };
}
