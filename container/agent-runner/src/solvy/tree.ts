import * as db from './db.js';

interface TreeNode {
  type: 'session' | 'plan' | 'step' | 'problem' | 'research' | 'strategy' | 'attempt' | 'concern';
  label: string;
  summary: string;
  status: string;
  children: TreeNode[];
}

function statusIcon(status: string): string {
  switch (status) {
    case 'completed': case 'succeeded': case 'resolved': return '✓';
    case 'failed': return '✗';
    case 'in_progress': return '●';
    case 'pending': case 'open': case 'new': return '○';
    case 'skipped': case 'blocked': case 'cancelled': return '⊘';
    case 'raised': case 'clarified': return '⚠';
    default: return '○';
  }
}

function summarize(text: string | null | undefined, fallback: string | null | undefined): string {
  const src = text || fallback || '';
  const words = src.split(/\s+/).filter(Boolean);
  if (words.length <= 4) return words.join(' ') || '(no summary)';
  return words.slice(0, 4).join(' ') + '...';
}

function buildConcernNodes(nodeType: string, nodeId: string): TreeNode[] {
  const concerns = db.getConcernsByNode(nodeType, nodeId);
  return concerns.map(c => ({
    type: 'concern' as const,
    label: c.short_id,
    summary: summarize(c.summary, c.description),
    status: c.status,
    children: [],
  }));
}

function buildAttemptNodes(strategyId: string): TreeNode[] {
  const attempts = db.getAttemptsByStrategy(strategyId);
  return attempts.map((a, i) => ({
    type: 'attempt' as const,
    label: `Attempt ${i + 1}`,
    summary: summarize(a.summary, a.outputs || a.error),
    status: a.status,
    children: [],
  }));
}

function buildStrategyNodes(researchId: string): TreeNode[] {
  const strategies = db.getStrategiesByResearch(researchId);
  return strategies.map((s, i) => {
    const children: TreeNode[] = [
      ...buildAttemptNodes(s.strategy_id),
      ...buildConcernNodes('strategy', s.strategy_id),
    ];

    // Check for sub-plan
    const subPlan = db.getSubPlanByStrategy(s.strategy_id);
    if (subPlan) {
      children.push(buildPlanNode(subPlan));
    }

    return {
      type: 'strategy' as const,
      label: `Strategy ${i + 1}`,
      summary: summarize(s.summary, s.description),
      status: s.status,
      children,
    };
  });
}

function buildResearchNodes(problemId: string): TreeNode[] {
  const research = db.getResearchByProblem(problemId);
  return research.map(r => ({
    type: 'research' as const,
    label: `Research R${r.round}`,
    summary: summarize(r.summary, r.analysis),
    status: 'completed',
    children: buildStrategyNodes(r.research_id),
  }));
}

function buildProblemNodes(stepId: string): TreeNode[] {
  const problems = db.getProblemsByStep(stepId);
  return problems.map(p => ({
    type: 'problem' as const,
    label: 'Problem',
    summary: summarize(p.summary, p.description),
    status: p.status,
    children: buildResearchNodes(p.problem_id),
  }));
}

function buildStepNodes(planId: string): TreeNode[] {
  const steps = db.getStepsByPlan(planId);
  return steps.map(s => ({
    type: 'step' as const,
    label: `Step ${s.sequence}`,
    summary: summarize(s.summary, s.description),
    status: s.status,
    children: [
      ...buildProblemNodes(s.step_id),
      ...buildConcernNodes('step', s.step_id),
    ],
  }));
}

function buildPlanNode(plan: db.PlanRow): TreeNode {
  return {
    type: 'plan',
    label: 'Plan',
    summary: summarize(plan.summary, plan.description),
    status: plan.status,
    children: [
      ...buildStepNodes(plan.plan_id),
      ...buildConcernNodes('plan', plan.plan_id),
    ],
  };
}

function renderNode(node: TreeNode, prefix: string, isLast: boolean, isRoot: boolean): string[] {
  const connector = isRoot ? '' : isLast ? '└── ' : '├── ';
  const icon = node.type === 'concern' ? '⚠' : statusIcon(node.status);
  const line = `${prefix}${connector}${icon} ${node.label}: "${node.summary}"`;

  const lines = [line];
  const childPrefix = isRoot ? '' : prefix + (isLast ? '    ' : '│   ');

  for (let i = 0; i < node.children.length; i++) {
    const childLines = renderNode(node.children[i], childPrefix, i === node.children.length - 1, false);
    lines.push(...childLines);
  }

  return lines;
}

export function renderTree(contextId: string): string {
  const session = db.getSession(contextId);
  if (!session) return `Session not found: ${contextId}`;

  const plans = db.getPlansByContext(contextId);
  if (plans.length === 0) {
    return `Session ${contextId}: ${session.state} (no plans yet)`;
  }

  // For single root plan, render it as root; for multiple, wrap in session node
  if (plans.filter(p => !p.parent_strategy_id).length === 1) {
    const rootPlan = plans.find(p => !p.parent_strategy_id)!;
    const tree = buildPlanNode(rootPlan);
    return renderNode(tree, '', true, true).join('\n');
  }

  // Multiple root plans
  const rootPlans = plans.filter(p => !p.parent_strategy_id);
  const lines: string[] = [];
  for (let i = 0; i < rootPlans.length; i++) {
    const tree = buildPlanNode(rootPlans[i]);
    const planLines = renderNode(tree, '', i === rootPlans.length - 1, i === 0 && rootPlans.length === 1);
    lines.push(...planLines);
  }
  return lines.join('\n');
}
