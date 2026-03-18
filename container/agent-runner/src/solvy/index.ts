/**
 * Solvy MCP Server: manages plan-solve state and experimental workspaces for LLM agents.
 * Runs as a stdio MCP subprocess.
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

import * as db from './db.js';
import * as session from './session.js';
import * as guidance from './guidance.js';
import * as context from './context.js';
import * as concerns from './concerns.js';
import { BUDGET_DEFAULTS, computeBudget, log } from './state-machine.js';
import { createPlanWorktree, createStepWorktree, createAttemptWorktree, promoteWorktree, archiveWorktree, ensureGitRepo } from './worktree.js';
import { cleanupExpiredSessions } from './cleanup.js';
import { renderTree } from './tree.js';
import { solvyLog } from './log.js';

const server = new McpServer({
  name: 'solvy',
  version: '0.1.0',
});

// ============================================================
// Session tools (2)
// ============================================================

server.tool(
  'solvy_begin',
  'Start a new session or resume an existing one. Pass context_id to resume, omit to create new.',
  {
    context_id: z.string().optional().describe('Existing context ID to resume. Omit to create new session.'),
  },
  async ({ context_id }) => {
    try {
      const result = session.beginSession(context_id || undefined);
      const guidanceObj = result.status === 'created'
        ? guidance.guidanceForNewSession(result.context_id)
        : guidance.guidanceForResumedSession(result.context_id);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            context_id: result.context_id,
            status: result.status,
            session_state: result.session_state,
            guidance: guidanceObj,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  },
);

server.tool(
  'solvy_end',
  'Persist and close the session. Generates summary on completion/failure.',
  {
    context_id: z.string().describe('Session context ID'),
    reason: z.enum(['completed', 'suspended', 'failed']).describe('Reason for ending'),
    summary: z.string().optional().describe('Optional summary text'),
  },
  async ({ context_id, reason, summary }) => {
    try {
      const result = session.endSession(context_id, reason, summary);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  },
);

// ============================================================
// Classification & Validation tools (2)
// ============================================================

server.tool(
  'solvy_classify',
  'Record the complexity classification for the task.',
  {
    context_id: z.string().describe('Session context ID'),
    complexity: z.enum(['simple', 'complex']).describe('Task complexity'),
    reasoning: z.string().describe('Why this classification was chosen'),
    estimated_steps: z.number().optional().describe('Estimated number of steps if complex'),
    ambiguity_level: z.enum(['low', 'medium', 'high']).optional().describe('Level of ambiguity in the task'),
    risk_factors: z.array(z.string()).optional().describe('Risk factors identified'),
  },
  async ({ context_id, complexity, reasoning, estimated_steps, ambiguity_level, risk_factors }) => {
    try {
      const sess = db.getSession(context_id);
      if (!sess) throw new Error(`Session not found: ${context_id}`);

      // Transition to classifying state (validated)
      log('session', context_id, `${sess.state} → classifying`);
      session.updateSessionState(context_id, 'classifying');
      db.updateSession(context_id, {
        complexity,
        complexity_reasoning: reasoning,
        estimated_steps: estimated_steps ?? null,
        ambiguity_level: ambiguity_level ?? null,
        risk_factors: risk_factors ? JSON.stringify(risk_factors) : null,
      });

      // Transition to next state (validated)
      const nextState = complexity === 'simple' ? 'completed' : 'validating';
      log('session', context_id, `classifying → ${nextState} complexity=${complexity}`);
      if (complexity === 'simple') {
        session.updateSessionState(context_id, 'completed');
      } else {
        session.updateSessionState(context_id, 'validating');
      }

      const guidanceObj = guidance.guidanceForClassification(context_id, complexity);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            context_id,
            complexity,
            guidance: guidanceObj,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  },
);

server.tool(
  'solvy_validate',
  'Record a validation round. First call records issues; subsequent calls include user response.',
  {
    context_id: z.string().describe('Session context ID'),
    issues: z.array(z.object({
      category: z.string(),
      severity: z.string(),
      description: z.string(),
      suggested_resolution: z.string(),
    })).optional().describe('Issues found (first call)'),
    user_response: z.string().optional().describe('User response to issues (subsequent calls)'),
    resolution: z.enum(['resolved', 'partially_resolved', 'overridden', 'abandoned']).optional().describe('Resolution status'),
  },
  async ({ context_id, issues, user_response, resolution }) => {
    try {
      const sess = db.getSession(context_id);
      if (!sess) throw new Error(`Session not found: ${context_id}`);

      if (issues && issues.length > 0 && !user_response) {
        // First call: record issues
        const validation = db.createValidation(context_id, issues);
        const guidanceObj = guidance.guidanceForValidation(context_id, false);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              context_id,
              validation_id: validation.id,
              round: validation.round,
              guidance: guidanceObj,
            }, null, 2),
          }],
        };
      }

      if (user_response && resolution) {
        // Subsequent call: record response
        const latest = db.getLatestValidation(context_id);
        if (latest) {
          db.updateValidation(latest.id, { user_response, resolution });
        }

        if (resolution === 'resolved' || resolution === 'overridden') {
          log('session', context_id, `→ planning resolution=${resolution}`);
          db.updateSession(context_id, { state: 'planning' });
        }

        const guidanceObj = guidance.guidanceForValidation(context_id, true, resolution);

        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              context_id,
              resolution,
              guidance: guidanceObj,
            }, null, 2),
          }],
        };
      }

      // No issues and no user_response = skip validation
      log('session', context_id, `→ planning resolution=skip`);
      db.updateSession(context_id, { state: 'planning' });
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            context_id,
            guidance: {
              next_action: 'plan',
              message: 'No issues found. Create a plan by calling solvy_plan_create.',
            },
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  },
);

// ============================================================
// Plan & Steps tools (4)
// ============================================================

server.tool(
  'solvy_plan_create',
  'Create a plan with ordered steps. This is the decomposition tool.',
  {
    context_id: z.string().describe('Session context ID'),
    description: z.string().describe('Plan description'),
    summary: z.string().max(50).optional().describe('Concise summary (≤6 words) for tree display'),
    steps: z.array(z.object({
      description: z.string(),
      type: z.enum(['action', 'checkpoint', 'await']).default('action'),
      summary: z.string().max(50).optional().describe('Concise summary (≤6 words) for tree display'),
      concern_id: z.string().optional(),
      concern_interpretation: z.string().optional(),
    })).describe('Ordered steps for the plan'),
    parent_strategy_id: z.string().optional().describe('Parent strategy ID for sub-plans'),
  },
  async ({ context_id, description, summary, steps: stepDefs, parent_strategy_id }) => {
    try {
      const sess = db.getSession(context_id);
      if (!sess) throw new Error(`Session not found: ${context_id}`);

      // Check plan depth
      const plan = db.createPlan(context_id, description, parent_strategy_id);
      if (plan.depth > BUDGET_DEFAULTS.maxPlanDepth) {
        // Clean up the rejected plan row
        db.updatePlan(plan.plan_id, { status: 'cancelled' });
        return {
          content: [{
            type: 'text' as const,
            text: JSON.stringify({
              error: 'max_plan_depth_exceeded',
              current_depth: plan.depth,
              max_depth: BUDGET_DEFAULTS.maxPlanDepth,
              guidance: {
                next_action: 'simplify_or_reconfigure',
                message: `Plan nesting depth (${plan.depth}) exceeds the maximum (${BUDGET_DEFAULTS.maxPlanDepth}). Either simplify the strategy to avoid sub-plans, or the user can increase the limit by setting SOLVY_MAX_PLAN_DEPTH.`,
              },
            }, null, 2),
          }],
          isError: true,
        };
      }

      // Save plan summary
      if (summary) {
        db.updatePlan(plan.plan_id, { summary });
      }

      // Create worktree for the plan
      const { worktreePath, branch } = createPlanWorktree(context_id);
      db.updatePlan(plan.plan_id, { workspace_branch: branch });

      // Create steps
      const createdSteps: db.StepRow[] = [];
      for (let i = 0; i < stepDefs.length; i++) {
        const stepDef = stepDefs[i];
        const step = db.createStep(
          plan.plan_id,
          context_id,
          i + 1,
          stepDef.description,
          stepDef.type,
          stepDef.concern_id,
          stepDef.concern_interpretation,
        );
        if (stepDef.summary) {
          db.updateStep(step.step_id, { summary: stepDef.summary });
        }
        createdSteps.push(step);
      }

      log('session', context_id, `→ executing plan=${plan.plan_id} steps=${createdSteps.length} depth=${plan.depth}`);
      db.updateSession(context_id, { state: 'executing' });

      const guidanceObj = guidance.guidanceForPlanCreated(context_id, plan.plan_id);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            plan_id: plan.plan_id,
            steps: createdSteps.map(s => ({
              step_id: s.step_id,
              sequence: s.sequence,
              description: s.description,
            })),
            depth: plan.depth,
            guidance: guidanceObj,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  },
);

server.tool(
  'solvy_step_start',
  'Begin executing a step. Creates a worktree forked from the parent plan branch.',
  {
    context_id: z.string().describe('Session context ID'),
    step_id: z.string().optional().describe('Step ID to start. Omit to start next pending step.'),
  },
  async ({ context_id, step_id }) => {
    try {
      let step: db.StepRow | undefined;

      if (step_id) {
        step = db.getStep(step_id);
        if (!step) throw new Error(`Step not found: ${step_id}`);
      } else {
        const plan = db.getActivePlan(context_id);
        if (!plan) throw new Error('No active plan found');
        step = db.getNextPendingStep(plan.plan_id);
        if (!step) throw new Error('No pending steps remaining');
      }

      const plan = db.getPlan(step.plan_id);
      if (!plan) throw new Error(`Plan not found: ${step.plan_id}`);

      // Create step worktree
      const parentBranch = plan.workspace_branch || `solvy/${context_id}`;
      const { worktreePath, branch } = createStepWorktree(context_id, step.sequence, parentBranch);

      log('step', step.step_id, `pending → in_progress seq=${step.sequence}`);
      db.updateStep(step.step_id, {
        status: 'in_progress',
        workspace_path: worktreePath,
        workspace_branch: branch,
      });

      step = db.getStep(step.step_id)!;

      const concernsToDrain = concerns.getConcernsToDrain(context_id);
      const guidanceObj = guidance.guidanceForStepStart(context_id, step);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            step_id: step.step_id,
            sequence: step.sequence,
            description: step.description,
            workspace_path: worktreePath,
            concerns_to_drain: concernsToDrain.map(c => ({
              short_id: c.short_id,
              description: c.description,
            })),
            guidance: guidanceObj,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  },
);

server.tool(
  'solvy_step_complete',
  'Complete a step. Promotes the worktree to the parent branch.',
  {
    context_id: z.string().describe('Session context ID'),
    step_id: z.string().describe('Step ID being completed'),
    output: z.record(z.string(), z.unknown()).describe('Step output data'),
    output_summary: z.string().optional().describe('Human-readable summary of what was done'),
    summary: z.string().max(50).optional().describe('Concise summary (≤6 words) for tree display'),
  },
  async ({ context_id, step_id, output, output_summary, summary }) => {
    try {
      const step = db.getStep(step_id);
      if (!step) throw new Error(`Step not found: ${step_id}`);

      const plan = db.getPlan(step.plan_id);
      if (!plan) throw new Error(`Plan not found: ${step.plan_id}`);

      // Promote worktree to parent branch
      let promoted = false;
      if (step.workspace_branch && plan.workspace_branch) {
        promoted = promoteWorktree(step.workspace_path!, step.workspace_branch, plan.workspace_branch);
      }

      // Archive step worktree
      if (step.workspace_path) {
        archiveWorktree(step.workspace_path);
      }

      log('step', step_id, `in_progress → completed seq=${step.sequence} promoted=${promoted}`);
      db.updateStep(step_id, {
        status: 'completed',
        output: JSON.stringify(output),
        output_summary: output_summary || null,
        ...(summary ? { summary } : {}),
      });

      const updatedStep = db.getStep(step_id)!;
      const guidanceObj = guidance.guidanceForStepComplete(context_id, updatedStep, promoted);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            step_id,
            promoted,
            guidance: guidanceObj,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  },
);

server.tool(
  'solvy_step_fail',
  'Surface a problem on the current step. Transitions step to blocked.',
  {
    context_id: z.string().describe('Session context ID'),
    step_id: z.string().describe('Step ID that encountered a problem'),
    problem_description: z.string().describe('Description of the problem'),
    severity: z.enum(['blocking', 'degrading']).describe('Problem severity'),
    summary: z.string().max(50).optional().describe('Concise problem summary (≤6 words) for tree display'),
  },
  async ({ context_id, step_id, problem_description, severity, summary }) => {
    try {
      const step = db.getStep(step_id);
      if (!step) throw new Error(`Step not found: ${step_id}`);

      log('step', step_id, `in_progress → blocked problem=${step_id}`);
      db.updateStep(step_id, { status: 'blocked' });

      const problem = db.createProblem(step_id, context_id, problem_description, severity);
      if (summary) {
        db.updateProblem(problem.problem_id, { summary });
      }
      const guidanceObj = guidance.guidanceForStepFail(context_id, problem.problem_id, problem_description);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            problem_id: problem.problem_id,
            step_status: 'blocked',
            guidance: guidanceObj,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  },
);

// ============================================================
// Research & Strategy tools (3)
// ============================================================

server.tool(
  'solvy_research',
  'Create research with candidate strategies for a problem.',
  {
    context_id: z.string().describe('Session context ID'),
    problem_id: z.string().describe('Problem ID being researched'),
    analysis: z.string().describe('Research analysis text'),
    summary: z.string().max(50).optional().describe('Concise research summary (≤6 words) for tree display'),
    constraints: z.array(z.string()).optional().describe('Constraints identified'),
    strategies: z.array(z.object({
      description: z.string(),
      summary: z.string().max(50).optional().describe('Concise strategy summary (≤6 words) for tree display'),
      estimated_efficacy: z.string().optional(),
      rationale: z.string().optional(),
      type: z.enum(['direct', 'plan', 'exploratory']).default('direct'),
      concern_id: z.string().optional(),
      concern_interpretation: z.string().optional(),
    })).describe('Candidate strategies'),
    parent_research_id: z.string().optional().describe('Parent research ID for widened research'),
  },
  async ({ context_id, problem_id, analysis, summary, constraints, strategies: strategyDefs, parent_research_id }) => {
    try {
      const problem = db.getProblem(problem_id);
      if (!problem) throw new Error(`Problem not found: ${problem_id}`);

      // Enforce max strategies
      if (strategyDefs.length > BUDGET_DEFAULTS.maxStrategiesPerProblem) {
        throw new Error(`Too many strategies (max ${BUDGET_DEFAULTS.maxStrategiesPerProblem})`);
      }

      const research = db.createResearch(problem_id, context_id, analysis, constraints, parent_research_id);
      if (summary) {
        // Research has no updateResearch, use db directly
        const database = db.getDb();
        database.prepare(`UPDATE research SET summary = ? WHERE research_id = ?`).run(summary, research.research_id);
      }

      const createdStrategies: db.StrategyRow[] = [];
      for (let i = 0; i < strategyDefs.length; i++) {
        const sDef = strategyDefs[i];
        const strategy = db.createStrategy(
          research.research_id,
          context_id,
          sDef.description,
          sDef.type,
          i + 1,
          sDef.estimated_efficacy,
          sDef.rationale,
          sDef.concern_id,
          sDef.concern_interpretation,
        );
        if (sDef.summary) {
          db.updateStrategy(strategy.strategy_id, { summary: sDef.summary });
        }
        createdStrategies.push(strategy);
      }

      const guidanceObj = guidance.guidanceForResearch(context_id, research.research_id);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            research_id: research.research_id,
            strategies: createdStrategies.map(s => ({
              strategy_id: s.strategy_id,
              priority: s.priority,
              description: s.description,
              type: s.type,
            })),
            guidance: guidanceObj,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  },
);

server.tool(
  'solvy_attempt_start',
  'Begin an attempt for a strategy. Creates a worktree forked from the step worktree.',
  {
    context_id: z.string().describe('Session context ID'),
    strategy_id: z.string().describe('Strategy ID to attempt'),
  },
  async ({ context_id, strategy_id }) => {
    try {
      const strategy = db.getStrategy(strategy_id);
      if (!strategy) throw new Error(`Strategy not found: ${strategy_id}`);

      log('strategy', strategy_id, `pending → in_progress`);
      db.updateStrategy(strategy_id, { status: 'in_progress' });

      const research = db.getResearch(strategy.research_id);
      if (!research) throw new Error(`Research not found: ${strategy.research_id}`);

      const problem = db.getProblem(research.problem_id);
      if (!problem) throw new Error(`Problem not found: ${research.problem_id}`);

      const step = db.getStep(problem.step_id);
      if (!step) throw new Error(`Step not found: ${problem.step_id}`);

      // Count existing attempts for this strategy to get attempt number
      const existingAttempts = db.getAttemptsByStrategy(strategy_id);
      const attemptNumber = existingAttempts.length + 1;

      const parentBranch = step.workspace_branch || `solvy/${context_id}-step-${step.sequence}`;
      const { worktreePath, branch } = createAttemptWorktree(context_id, step.sequence, attemptNumber, parentBranch);

      const attempt = db.createAttempt(strategy_id, context_id);
      db.updateAttempt(attempt.attempt_id, {
        workspace_path: worktreePath,
        workspace_branch: branch,
      });

      const updatedAttempt = db.getAttempt(attempt.attempt_id)!;
      const guidanceObj = guidance.guidanceForAttemptStart(context_id, updatedAttempt);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            attempt_id: attempt.attempt_id,
            workspace_path: worktreePath,
            guidance: guidanceObj,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  },
);

server.tool(
  'solvy_attempt_complete',
  'Complete an attempt with outputs and evaluation. Returns escalation guidance on failure.',
  {
    context_id: z.string().describe('Session context ID'),
    attempt_id: z.string().describe('Attempt ID being completed'),
    outputs: z.record(z.string(), z.unknown()).optional().describe('Attempt outputs'),
    error: z.string().optional().describe('Error encountered during attempt'),
    evaluation: z.object({
      satisfactory: z.boolean(),
      reasoning: z.string(),
      quality_score: z.number().optional(),
      new_problems: z.array(z.string()).optional(),
    }).describe('Evaluation of the attempt'),
    summary: z.string().max(50).optional().describe('Concise attempt summary (≤6 words) for tree display'),
  },
  async ({ context_id, attempt_id, outputs, error, evaluation, summary }) => {
    try {
      const attempt = db.getAttempt(attempt_id);
      if (!attempt) throw new Error(`Attempt not found: ${attempt_id}`);

      const strategy = db.getStrategy(attempt.strategy_id);
      if (!strategy) throw new Error(`Strategy not found: ${attempt.strategy_id}`);

      const research = db.getResearch(strategy.research_id);
      if (!research) throw new Error(`Research not found: ${strategy.research_id}`);

      const problem = db.getProblem(research.problem_id);
      if (!problem) throw new Error(`Problem not found: ${research.problem_id}`);

      const step = db.getStep(problem.step_id);
      if (!step) throw new Error(`Step not found: ${problem.step_id}`);

      const verdict = evaluation.satisfactory ? 'succeeded' : 'failed';

      db.updateAttempt(attempt_id, {
        status: verdict,
        outputs: outputs ? JSON.stringify(outputs) : null,
        error: error || null,
        evaluation: JSON.stringify(evaluation),
        ...(summary ? { summary } : {}),
      });

      log('strategy', attempt.strategy_id, `in_progress → ${verdict}`);
      db.updateStrategy(attempt.strategy_id, {
        status: verdict,
      });

      if (evaluation.satisfactory) {
        // Promote attempt worktree to step branch
        if (attempt.workspace_branch && step.workspace_branch) {
          promoteWorktree(attempt.workspace_path!, attempt.workspace_branch, step.workspace_branch);
        }

        // Unblock the step
        log('step', problem.step_id, `blocked → in_progress (unblocked)`);
        db.updateStep(problem.step_id, { status: 'in_progress' });
        db.updateProblem(problem.problem_id, { status: 'resolved' });
      }

      // Archive attempt worktree
      if (attempt.workspace_path) {
        archiveWorktree(attempt.workspace_path);
      }

      const updatedAttempt = db.getAttempt(attempt_id)!;
      const guidanceObj = guidance.guidanceForAttemptComplete(context_id, updatedAttempt, evaluation.satisfactory);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            attempt_id,
            verdict,
            guidance: guidanceObj,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  },
);

// ============================================================
// Concern tools (3)
// ============================================================

server.tool(
  'solvy_concern_raise',
  'Raise an ambiguity concern on any node.',
  {
    context_id: z.string().describe('Session context ID'),
    node_type: z.enum(['plan', 'step', 'problem', 'research', 'strategy']).describe('Type of node the concern is about'),
    node_id: z.string().describe('ID of the node'),
    source_phase: z.enum(['decomposition', 'research', 'strategy_generation', 'evaluation']).describe('Phase where concern was detected'),
    description: z.string().describe('Description of the ambiguity'),
    interpretations: z.array(z.object({
      label: z.string(),
      description: z.string(),
      likelihood: z.string(),
    })).describe('Possible interpretations'),
    widening_applied: z.string().describe('What widening was applied to handle the ambiguity'),
    summary: z.string().max(50).optional().describe('Concise concern summary (≤6 words) for tree display'),
  },
  async ({ context_id, node_type, node_id, source_phase, description, interpretations, widening_applied, summary }) => {
    try {
      const { concern, saturationReached } = concerns.raiseConcern(
        context_id, node_type, node_id, source_phase, description, interpretations, widening_applied,
      );
      if (summary) {
        db.updateConcern(concern.concern_id, { summary });
      }
      const guidanceObj = guidance.guidanceForConcernRaised(context_id, saturationReached);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            concern_id: concern.concern_id,
            short_id: concern.short_id,
            saturation_reached: saturationReached,
            guidance: guidanceObj,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  },
);

server.tool(
  'solvy_concern_clarify',
  "Record a user's clarification for a concern.",
  {
    context_id: z.string().describe('Session context ID'),
    short_id: z.string().describe('Short ID of the concern (e.g., C-1)'),
    user_message: z.string().describe("User's clarification message"),
  },
  async ({ context_id, short_id, user_message }) => {
    try {
      const concern = concerns.clarifyConcern(context_id, short_id, user_message);
      const guidanceObj = guidance.guidanceForConcernClarified();

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            concern_id: concern.concern_id,
            status: 'clarified',
            guidance: guidanceObj,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  },
);

server.tool(
  'solvy_concern_process',
  'Process a clarified concern with impact assessment and rework.',
  {
    context_id: z.string().describe('Session context ID'),
    concern_id: z.string().describe('Concern ID to process'),
    selected_interpretation: z.string().describe('Which interpretation the user confirmed'),
    impact: z.enum(['none', 'compatible', 'significant']).describe('Impact level of the clarification'),
    reasoning: z.string().describe('Why this impact level was assessed'),
    nodes_to_rework: z.array(z.string()).optional().describe('Node IDs that need rework'),
    rework_instructions: z.record(z.string(), z.string()).optional().describe('Instructions per node for rework'),
  },
  async ({ context_id, concern_id, selected_interpretation, impact, reasoning, nodes_to_rework, rework_instructions }) => {
    try {
      const reworkResult = concerns.processConcern(
        context_id, concern_id, selected_interpretation, impact, reasoning, nodes_to_rework, rework_instructions,
      );
      const guidanceObj = guidance.guidanceForConcernProcessed(reworkResult as unknown as Record<string, unknown>);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            rework_applied: reworkResult,
            guidance: guidanceObj,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  },
);

// ============================================================
// Context & Status tools (2)
// ============================================================

server.tool(
  'solvy_status',
  'Get current session state, progress, and guidance. Read-only. Call anytime to reorient.',
  {
    context_id: z.string().describe('Session context ID'),
  },
  async ({ context_id }) => {
    try {
      const status = context.buildStatus(context_id);
      const guidanceObj = guidance.guidanceForStatus(context_id);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({
            ...status,
            guidance: guidanceObj,
          }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  },
);

server.tool(
  'solvy_context',
  'Get detailed path context for a specific node. Used by sub-agents to understand their position.',
  {
    context_id: z.string().describe('Session context ID'),
    node_type: z.string().optional().describe('Type of node to get context for'),
    node_id: z.string().optional().describe('ID of the node'),
  },
  async ({ context_id, node_type, node_id }) => {
    try {
      const pathContext = context.buildPathContext(context_id, node_type, node_id);

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(pathContext, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  },
);

// ============================================================
// Tree visualization tool (1)
// ============================================================

server.tool(
  'solvy_show_tree',
  'Render ASCII tree of full session structure with status and summaries. When a user asks to see a Solvy tree, show them the raw output of this tool.',
  {
    context_id: z.string().describe('Session context ID'),
  },
  async ({ context_id }) => {
    try {
      const tree = renderTree(context_id);
      return { content: [{ type: 'text' as const, text: tree }] };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  },
);

// ============================================================
// Admin tools (2 bonus — cleanup + version)
// ============================================================
// These are utility tools beyond the 16 above, keeping the total at 18.

server.tool(
  'solvy_list_sessions',
  'List all Solvy sessions with their IDs, state, and description.',
  {},
  async () => {
    try {
      const sessions = db.listSessions();
      const result = sessions.map(s => ({
        context_id: s.context_id,
        state: s.state,
        description: s.summary || s.plan_description || null,
        complexity: s.complexity,
        created_at: s.created_at,
        updated_at: s.updated_at,
        ended_at: s.ended_at,
        end_reason: s.end_reason,
      }));

      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify({ sessions: result, count: result.length }, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  },
);

server.tool(
  'solvy_cleanup',
  'Run TTL-based cleanup of expired sessions. Summary documents are preserved.',
  {
    ttl_days: z.number().optional().describe('Override TTL in days (default: 90)'),
  },
  async ({ ttl_days }) => {
    try {
      const result = cleanupExpiredSessions(ttl_days ?? undefined);
      return {
        content: [{
          type: 'text' as const,
          text: JSON.stringify(result, null, 2),
        }],
      };
    } catch (err: any) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: err.message }) }], isError: true };
    }
  },
);

server.tool(
  'solvy_version',
  'Get Solvy MCP server version and configuration.',
  {},
  async () => {
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({
          version: '0.1.0',
          db_dir: db.getDbDir(),
          workspace_prefix: process.env.SOLVY_WORKSPACE_PREFIX || '/workspace/group/',
          git_root: process.env.SOLVY_GIT_ROOT || '/workspace/group/',
          budget_defaults: BUDGET_DEFAULTS,
        }, null, 2),
      }],
    };
  },
);

// ============================================================
// Server startup
// ============================================================

async function main() {
  // Ensure git repo exists in workspace before worktrees can be created
  try {
    ensureGitRepo();
  } catch (err: any) {
    solvyLog(`WARNING: failed to ensure git repo: ${err.message}`);
  }

  // Run cleanup on startup (non-blocking)
  try {
    cleanupExpiredSessions();
  } catch {
    // Cleanup failure shouldn't prevent startup
  }

  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  solvyLog(`FATAL: Solvy MCP server failed to start: ${err}`);
  process.exit(1);
});
