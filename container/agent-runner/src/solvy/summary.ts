/**
 * Summary document generation on session completion.
 */

import * as db from './db.js';
import { getWorkspacePrefix } from './worktree.js';
import path from 'path';
import fs from 'fs';

/**
 * Generate a markdown summary document for a completed/failed session.
 * Returns the path to the summary file.
 */
export function generateSummary(contextId: string, reason: string, userSummary?: string): string {
  const session = db.getSession(contextId);
  if (!session) throw new Error(`Session not found: ${contextId}`);

  const summaryDir = path.join(getWorkspacePrefix(), 'plansolver', 'summaries');
  fs.mkdirSync(summaryDir, { recursive: true });

  const summaryPath = path.join(summaryDir, `${contextId}.md`);

  const lines: string[] = [];
  lines.push(`# Solvy Session Summary: ${contextId}`);
  lines.push('');
  lines.push(`**Status:** ${reason}`);
  lines.push(`**Complexity:** ${session.complexity || 'unknown'}`);
  lines.push(`**Created:** ${session.created_at}`);
  lines.push(`**Ended:** ${session.ended_at || new Date().toISOString()}`);
  lines.push('');

  if (userSummary) {
    lines.push('## Summary');
    lines.push('');
    lines.push(userSummary);
    lines.push('');
  }

  // Plans
  const plans = db.getDb().prepare(`SELECT * FROM plans WHERE context_id = ? ORDER BY created_at`).all(contextId) as db.PlanRow[];
  if (plans.length > 0) {
    lines.push('## Plans');
    lines.push('');
    for (const plan of plans) {
      const steps = db.getStepsByPlan(plan.plan_id);
      const completedSteps = steps.filter(s => s.status === 'completed').length;
      lines.push(`### ${plan.description}`);
      lines.push(`- Depth: ${plan.depth}`);
      lines.push(`- Steps: ${completedSteps}/${steps.length} completed`);
      lines.push('');

      for (const step of steps) {
        const statusIcon = step.status === 'completed' ? '[x]' : step.status === 'skipped' ? '[-]' : '[ ]';
        lines.push(`- ${statusIcon} Step ${step.sequence}: ${step.description} (${step.status})`);
        if (step.output_summary) {
          lines.push(`  - Output: ${step.output_summary}`);
        }
      }
      lines.push('');
    }
  }

  // Problems and strategies
  const problems = db.getDb().prepare(`SELECT * FROM problems WHERE context_id = ? ORDER BY created_at`).all(contextId) as db.ProblemRow[];
  if (problems.length > 0) {
    lines.push('## Problems Encountered');
    lines.push('');
    for (const problem of problems) {
      lines.push(`### ${problem.description}`);
      lines.push(`- Severity: ${problem.severity}`);
      lines.push(`- Status: ${problem.status}`);

      const research = db.getResearchByProblem(problem.problem_id);
      for (const r of research) {
        lines.push(`- Research round ${r.round}: ${r.analysis.substring(0, 200)}${r.analysis.length > 200 ? '...' : ''}`);
        const strategies = db.getStrategiesByResearch(r.research_id);
        for (const s of strategies) {
          const attempts = db.getAttemptsByStrategy(s.strategy_id);
          const attemptResults = attempts.map(a => a.status).join(', ');
          lines.push(`  - Strategy: ${s.description} (${s.status}) [attempts: ${attemptResults || 'none'}]`);
        }
      }
      lines.push('');
    }
  }

  // Concerns
  const concerns = db.getDb().prepare(`SELECT * FROM concerns WHERE context_id = ? ORDER BY created_at`).all(contextId) as db.ConcernRow[];
  if (concerns.length > 0) {
    lines.push('## Concerns');
    lines.push('');
    for (const concern of concerns) {
      lines.push(`- **${concern.short_id}**: ${concern.description} (${concern.status})`);
      if (concern.selected_interpretation) {
        lines.push(`  - Resolution: ${concern.selected_interpretation} (impact: ${concern.impact})`);
      }
    }
    lines.push('');
  }

  // Budget usage
  const totalAttempts = db.getTotalAttempts(contextId);
  const totalProblems = db.getTotalProblems(contextId);
  lines.push('## Budget Usage');
  lines.push('');
  lines.push(`- Total attempts: ${totalAttempts}`);
  lines.push(`- Total problems: ${totalProblems}`);
  lines.push(`- Concerns raised: ${concerns.length}`);
  lines.push('');

  fs.writeFileSync(summaryPath, lines.join('\n'), 'utf-8');
  return summaryPath;
}
