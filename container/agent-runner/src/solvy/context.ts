/**
 * Context assembly: buildPathContext + status for any node.
 */

import * as db from './db.js';
import { computeBudget } from './state-machine.js';

export interface PathContext {
  session: {
    context_id: string;
    state: string;
    complexity: string | null;
  };
  plan_chain: Array<{
    plan_id: string;
    description: string;
    depth: number;
    total_steps: number;
    completed_steps: number;
  }>;
  current_step?: {
    step_id: string;
    sequence: number;
    description: string;
    status: string;
    workspace_path: string | null;
  };
  problem_chain: Array<{
    problem_id: string;
    description: string;
    severity: string;
    research_rounds: number;
    strategies_tried: number;
  }>;
  active_concerns: Array<{
    concern_id: string;
    short_id: string;
    description: string;
    status: string;
  }>;
  budget: {
    total_attempts_remaining: number;
    max_problems_remaining: number;
  };
  position: string;
}

/**
 * Build path context for a specific node. Walks ancestry to assemble full context.
 */
export function buildPathContext(contextId: string, nodeType?: string, nodeId?: string): PathContext {
  const session = db.getSession(contextId);
  if (!session) throw new Error(`Session not found: ${contextId}`);

  const totalAttempts = db.getTotalAttempts(contextId);
  const totalProblems = db.getTotalProblems(contextId);
  const budget = computeBudget(totalAttempts, totalProblems);
  const activeConcerns = db.getActiveConcerns(contextId).map(c => ({
    concern_id: c.concern_id,
    short_id: c.short_id,
    description: c.description,
    status: c.status,
  }));

  const ctx: PathContext = {
    session: {
      context_id: session.context_id,
      state: session.state,
      complexity: session.complexity,
    },
    plan_chain: [],
    problem_chain: [],
    active_concerns: activeConcerns,
    budget: {
      total_attempts_remaining: budget.total_attempts_remaining,
      max_problems_remaining: budget.max_problems_remaining,
    },
    position: '',
  };

  // Build plan chain
  const activePlan = db.getActivePlan(contextId);
  if (activePlan) {
    const steps = db.getStepsByPlan(activePlan.plan_id);
    ctx.plan_chain.push({
      plan_id: activePlan.plan_id,
      description: activePlan.description,
      depth: activePlan.depth,
      total_steps: steps.length,
      completed_steps: steps.filter(s => s.status === 'completed').length,
    });
  }

  // Resolve current step and problem chain based on nodeType/nodeId
  if (nodeType === 'step' && nodeId) {
    const step = db.getStep(nodeId);
    if (step) {
      ctx.current_step = {
        step_id: step.step_id,
        sequence: step.sequence,
        description: step.description,
        status: step.status,
        workspace_path: step.workspace_path,
      };
    }
  } else if (nodeType === 'problem' && nodeId) {
    const problem = db.getProblem(nodeId);
    if (problem) {
      const research = db.getResearchByProblem(problem.problem_id);
      let totalStrategies = 0;
      for (const r of research) {
        totalStrategies += db.getStrategiesByResearch(r.research_id).length;
      }
      ctx.problem_chain.push({
        problem_id: problem.problem_id,
        description: problem.description,
        severity: problem.severity,
        research_rounds: research.length,
        strategies_tried: totalStrategies,
      });

      // Also set current step
      const step = db.getStep(problem.step_id);
      if (step) {
        ctx.current_step = {
          step_id: step.step_id,
          sequence: step.sequence,
          description: step.description,
          status: step.status,
          workspace_path: step.workspace_path,
        };
      }
    }
  } else if (nodeType === 'strategy' && nodeId) {
    const strategy = db.getStrategy(nodeId);
    if (strategy) {
      const research = db.getResearch(strategy.research_id);
      if (research) {
        const problem = db.getProblem(research.problem_id);
        if (problem) {
          const allResearch = db.getResearchByProblem(problem.problem_id);
          let totalStrategies = 0;
          for (const r of allResearch) {
            totalStrategies += db.getStrategiesByResearch(r.research_id).length;
          }
          ctx.problem_chain.push({
            problem_id: problem.problem_id,
            description: problem.description,
            severity: problem.severity,
            research_rounds: allResearch.length,
            strategies_tried: totalStrategies,
          });

          const step = db.getStep(problem.step_id);
          if (step) {
            ctx.current_step = {
              step_id: step.step_id,
              sequence: step.sequence,
              description: step.description,
              status: step.status,
              workspace_path: step.workspace_path,
            };
          }
        }
      }
    }
  } else {
    // Default: find active step
    const activeStep = db.getActiveStep(contextId);
    if (activeStep) {
      ctx.current_step = {
        step_id: activeStep.step_id,
        sequence: activeStep.sequence,
        description: activeStep.description,
        status: activeStep.status,
        workspace_path: activeStep.workspace_path,
      };
    }
  }

  // Build position string
  const parts: string[] = [`session:${session.state}`];
  if (ctx.plan_chain.length > 0) {
    const p = ctx.plan_chain[0];
    parts.push(`plan(${p.completed_steps}/${p.total_steps})`);
  }
  if (ctx.current_step) {
    parts.push(`step-${ctx.current_step.sequence}:${ctx.current_step.status}`);
  }
  if (ctx.problem_chain.length > 0) {
    const prob = ctx.problem_chain[0];
    parts.push(`problem(r${prob.research_rounds},s${prob.strategies_tried})`);
  }
  ctx.position = parts.join(' → ');

  return ctx;
}

/**
 * Build a status summary for the session.
 */
export function buildStatus(contextId: string): Record<string, unknown> {
  const session = db.getSession(contextId);
  if (!session) throw new Error(`Session not found: ${contextId}`);

  const activePlan = db.getActivePlan(contextId);
  const activeStep = db.getActiveStep(contextId);
  const activeConcerns = db.getActiveConcerns(contextId);
  const totalAttempts = db.getTotalAttempts(contextId);
  const totalProblems = db.getTotalProblems(contextId);
  const budget = computeBudget(totalAttempts, totalProblems);

  const result: Record<string, unknown> = {
    session_state: session.state,
    active_concerns: activeConcerns.map(c => ({
      short_id: c.short_id,
      description: c.description,
      status: c.status,
    })),
    budget,
  };

  if (activePlan) {
    const steps = db.getStepsByPlan(activePlan.plan_id);
    result.plan = {
      plan_id: activePlan.plan_id,
      description: activePlan.description,
      total_steps: steps.length,
      completed_steps: steps.filter(s => s.status === 'completed').length,
      current_step: activeStep ? {
        step_id: activeStep.step_id,
        sequence: activeStep.sequence,
        description: activeStep.description,
        status: activeStep.status,
        workspace_path: activeStep.workspace_path,
      } : null,
    };
  }

  return result;
}
