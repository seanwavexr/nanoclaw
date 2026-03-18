import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';
import crypto from 'crypto';

let db: Database.Database | null = null;

export function getDbDir(): string {
  return process.env.SOLVY_DB_DIR || '/workspace/plansolver/';
}

export function getDb(): Database.Database {
  if (!db) {
    const dbDir = getDbDir();
    fs.mkdirSync(dbDir, { recursive: true });
    const dbPath = path.join(dbDir, 'solvy.db');
    db = new Database(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    initSchema(db);
  }
  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}

export function genId(): string {
  return crypto.randomBytes(12).toString('hex');
}

function initSchema(db: Database.Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS sessions (
      context_id TEXT PRIMARY KEY,
      state TEXT NOT NULL DEFAULT 'new',
      complexity TEXT,
      complexity_reasoning TEXT,
      estimated_steps INTEGER,
      ambiguity_level TEXT,
      risk_factors TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      ended_at TEXT,
      end_reason TEXT,
      summary TEXT
    );

    CREATE TABLE IF NOT EXISTS validations (
      id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL REFERENCES sessions(context_id),
      round INTEGER NOT NULL DEFAULT 1,
      issues TEXT NOT NULL,
      user_response TEXT,
      resolution TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS plans (
      plan_id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL REFERENCES sessions(context_id),
      parent_strategy_id TEXT REFERENCES strategies(strategy_id),
      description TEXT NOT NULL,
      depth INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'active',
      workspace_branch TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS steps (
      step_id TEXT PRIMARY KEY,
      plan_id TEXT NOT NULL REFERENCES plans(plan_id),
      context_id TEXT NOT NULL REFERENCES sessions(context_id),
      sequence INTEGER NOT NULL,
      description TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'action',
      status TEXT NOT NULL DEFAULT 'pending',
      concern_id TEXT,
      concern_interpretation TEXT,
      workspace_path TEXT,
      workspace_branch TEXT,
      output TEXT,
      output_summary TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS problems (
      problem_id TEXT PRIMARY KEY,
      step_id TEXT NOT NULL REFERENCES steps(step_id),
      context_id TEXT NOT NULL REFERENCES sessions(context_id),
      description TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'blocking',
      status TEXT NOT NULL DEFAULT 'open',
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS research (
      research_id TEXT PRIMARY KEY,
      problem_id TEXT NOT NULL REFERENCES problems(problem_id),
      context_id TEXT NOT NULL REFERENCES sessions(context_id),
      parent_research_id TEXT REFERENCES research(research_id),
      analysis TEXT NOT NULL,
      constraints TEXT,
      round INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS strategies (
      strategy_id TEXT PRIMARY KEY,
      research_id TEXT NOT NULL REFERENCES research(research_id),
      context_id TEXT NOT NULL REFERENCES sessions(context_id),
      description TEXT NOT NULL,
      type TEXT NOT NULL DEFAULT 'direct',
      estimated_efficacy TEXT,
      rationale TEXT,
      priority INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'pending',
      concern_id TEXT,
      concern_interpretation TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS attempts (
      attempt_id TEXT PRIMARY KEY,
      strategy_id TEXT NOT NULL REFERENCES strategies(strategy_id),
      context_id TEXT NOT NULL REFERENCES sessions(context_id),
      status TEXT NOT NULL DEFAULT 'in_progress',
      workspace_path TEXT,
      workspace_branch TEXT,
      outputs TEXT,
      error TEXT,
      evaluation TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS concerns (
      concern_id TEXT PRIMARY KEY,
      context_id TEXT NOT NULL REFERENCES sessions(context_id),
      short_id TEXT NOT NULL,
      node_type TEXT NOT NULL,
      node_id TEXT NOT NULL,
      source_phase TEXT NOT NULL,
      description TEXT NOT NULL,
      interpretations TEXT NOT NULL,
      widening_applied TEXT,
      status TEXT NOT NULL DEFAULT 'raised',
      user_message TEXT,
      selected_interpretation TEXT,
      impact TEXT,
      impact_reasoning TEXT,
      nodes_to_rework TEXT,
      rework_instructions TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_plans_context ON plans(context_id);
    CREATE INDEX IF NOT EXISTS idx_steps_plan ON steps(plan_id);
    CREATE INDEX IF NOT EXISTS idx_steps_context ON steps(context_id);
    CREATE INDEX IF NOT EXISTS idx_problems_step ON problems(step_id);
    CREATE INDEX IF NOT EXISTS idx_research_problem ON research(problem_id);
    CREATE INDEX IF NOT EXISTS idx_strategies_research ON strategies(research_id);
    CREATE INDEX IF NOT EXISTS idx_attempts_strategy ON attempts(strategy_id);
    CREATE INDEX IF NOT EXISTS idx_concerns_context ON concerns(context_id);
    CREATE INDEX IF NOT EXISTS idx_concerns_node ON concerns(node_type, node_id);
  `);

  // Add summary column to tables that don't have it yet
  const alterStatements = [
    'ALTER TABLE plans ADD COLUMN summary TEXT',
    'ALTER TABLE steps ADD COLUMN summary TEXT',
    'ALTER TABLE problems ADD COLUMN summary TEXT',
    'ALTER TABLE research ADD COLUMN summary TEXT',
    'ALTER TABLE strategies ADD COLUMN summary TEXT',
    'ALTER TABLE attempts ADD COLUMN summary TEXT',
    'ALTER TABLE concerns ADD COLUMN summary TEXT',
  ];
  for (const sql of alterStatements) {
    try { db.exec(sql); } catch { /* column already exists */ }
  }
}

// --- Session CRUD ---

export interface SessionRow {
  context_id: string;
  state: string;
  complexity: string | null;
  complexity_reasoning: string | null;
  estimated_steps: number | null;
  ambiguity_level: string | null;
  risk_factors: string | null;
  created_at: string;
  updated_at: string;
  ended_at: string | null;
  end_reason: string | null;
  summary: string | null;
}

export function createSession(contextId: string): SessionRow {
  const db = getDb();
  db.prepare(`INSERT INTO sessions (context_id) VALUES (?)`).run(contextId);
  return getSession(contextId)!;
}

export function getSession(contextId: string): SessionRow | undefined {
  const db = getDb();
  return db.prepare(`SELECT * FROM sessions WHERE context_id = ?`).get(contextId) as SessionRow | undefined;
}

export function updateSession(contextId: string, updates: Record<string, unknown>): void {
  const db = getDb();
  const keys = Object.keys(updates);
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => updates[k]);
  db.prepare(`UPDATE sessions SET ${sets}, updated_at = datetime('now') WHERE context_id = ?`).run(...values, contextId);
}

// --- Validation CRUD ---

export interface ValidationRow {
  id: string;
  context_id: string;
  round: number;
  issues: string;
  user_response: string | null;
  resolution: string | null;
  created_at: string;
}

export function createValidation(contextId: string, issues: unknown[]): ValidationRow {
  const db = getDb();
  const id = genId();
  const round = (db.prepare(`SELECT MAX(round) as max_round FROM validations WHERE context_id = ?`).get(contextId) as any)?.max_round || 0;
  db.prepare(`INSERT INTO validations (id, context_id, round, issues) VALUES (?, ?, ?, ?)`).run(id, contextId, round + 1, JSON.stringify(issues));
  return db.prepare(`SELECT * FROM validations WHERE id = ?`).get(id) as ValidationRow;
}

export function getLatestValidation(contextId: string): ValidationRow | undefined {
  const db = getDb();
  return db.prepare(`SELECT * FROM validations WHERE context_id = ? ORDER BY round DESC LIMIT 1`).get(contextId) as ValidationRow | undefined;
}

export function updateValidation(id: string, updates: Record<string, unknown>): void {
  const db = getDb();
  const keys = Object.keys(updates);
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => updates[k]);
  db.prepare(`UPDATE validations SET ${sets} WHERE id = ?`).run(...values, id);
}

// --- Plan CRUD ---

export interface PlanRow {
  plan_id: string;
  context_id: string;
  parent_strategy_id: string | null;
  description: string;
  depth: number;
  status: string;
  workspace_branch: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export function createPlan(contextId: string, description: string, parentStrategyId?: string): PlanRow {
  const db = getDb();
  const planId = genId();

  let depth = 0;
  if (parentStrategyId) {
    const parentPlan = db.prepare(`
      SELECT p.depth FROM plans p
      JOIN strategies s ON s.research_id IN (SELECT research_id FROM research WHERE problem_id IN (SELECT problem_id FROM problems WHERE step_id IN (SELECT step_id FROM steps WHERE plan_id = p.plan_id)))
      WHERE s.strategy_id = ?
    `).get(parentStrategyId) as { depth: number } | undefined;
    depth = (parentPlan?.depth || 0) + 1;
  }

  db.prepare(`INSERT INTO plans (plan_id, context_id, parent_strategy_id, description, depth) VALUES (?, ?, ?, ?, ?)`).run(planId, contextId, parentStrategyId || null, description, depth);
  return db.prepare(`SELECT * FROM plans WHERE plan_id = ?`).get(planId) as PlanRow;
}

export function getPlan(planId: string): PlanRow | undefined {
  const db = getDb();
  return db.prepare(`SELECT * FROM plans WHERE plan_id = ?`).get(planId) as PlanRow | undefined;
}

export function getActivePlan(contextId: string): PlanRow | undefined {
  const db = getDb();
  return db.prepare(`SELECT * FROM plans WHERE context_id = ? AND status = 'active' ORDER BY created_at DESC LIMIT 1`).get(contextId) as PlanRow | undefined;
}

export function updatePlan(planId: string, updates: Record<string, unknown>): void {
  const db = getDb();
  const keys = Object.keys(updates);
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => updates[k]);
  db.prepare(`UPDATE plans SET ${sets}, updated_at = datetime('now') WHERE plan_id = ?`).run(...values, planId);
}

// --- Step CRUD ---

export interface StepRow {
  step_id: string;
  plan_id: string;
  context_id: string;
  sequence: number;
  description: string;
  type: string;
  status: string;
  concern_id: string | null;
  concern_interpretation: string | null;
  workspace_path: string | null;
  workspace_branch: string | null;
  output: string | null;
  output_summary: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export function createStep(planId: string, contextId: string, sequence: number, description: string, type: string, concernId?: string, concernInterpretation?: string): StepRow {
  const db = getDb();
  const stepId = genId();
  db.prepare(`INSERT INTO steps (step_id, plan_id, context_id, sequence, description, type, concern_id, concern_interpretation) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(stepId, planId, contextId, sequence, description, type, concernId || null, concernInterpretation || null);
  return db.prepare(`SELECT * FROM steps WHERE step_id = ?`).get(stepId) as StepRow;
}

export function getStep(stepId: string): StepRow | undefined {
  const db = getDb();
  return db.prepare(`SELECT * FROM steps WHERE step_id = ?`).get(stepId) as StepRow | undefined;
}

export function getStepsByPlan(planId: string): StepRow[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM steps WHERE plan_id = ? ORDER BY sequence`).all(planId) as StepRow[];
}

export function getNextPendingStep(planId: string): StepRow | undefined {
  const db = getDb();
  return db.prepare(`SELECT * FROM steps WHERE plan_id = ? AND status = 'pending' ORDER BY sequence LIMIT 1`).get(planId) as StepRow | undefined;
}

export function getActiveStep(contextId: string): StepRow | undefined {
  const db = getDb();
  return db.prepare(`SELECT * FROM steps WHERE context_id = ? AND status = 'in_progress' ORDER BY sequence LIMIT 1`).get(contextId) as StepRow | undefined;
}

export function updateStep(stepId: string, updates: Record<string, unknown>): void {
  const db = getDb();
  const keys = Object.keys(updates);
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => updates[k]);
  db.prepare(`UPDATE steps SET ${sets}, updated_at = datetime('now') WHERE step_id = ?`).run(...values, stepId);
}

// --- Problem CRUD ---

export interface ProblemRow {
  problem_id: string;
  step_id: string;
  context_id: string;
  description: string;
  severity: string;
  status: string;
  summary: string | null;
  created_at: string;
}

export function createProblem(stepId: string, contextId: string, description: string, severity: string): ProblemRow {
  const db = getDb();
  const problemId = genId();
  db.prepare(`INSERT INTO problems (problem_id, step_id, context_id, description, severity) VALUES (?, ?, ?, ?, ?)`).run(problemId, stepId, contextId, description, severity);
  return db.prepare(`SELECT * FROM problems WHERE problem_id = ?`).get(problemId) as ProblemRow;
}

export function getProblem(problemId: string): ProblemRow | undefined {
  const db = getDb();
  return db.prepare(`SELECT * FROM problems WHERE problem_id = ?`).get(problemId) as ProblemRow | undefined;
}

export function getProblemsByStep(stepId: string): ProblemRow[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM problems WHERE step_id = ?`).all(stepId) as ProblemRow[];
}

export function updateProblem(problemId: string, updates: Record<string, unknown>): void {
  const db = getDb();
  const keys = Object.keys(updates);
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => updates[k]);
  db.prepare(`UPDATE problems SET ${sets} WHERE problem_id = ?`).run(...values, problemId);
}

// --- Research CRUD ---

export interface ResearchRow {
  research_id: string;
  problem_id: string;
  context_id: string;
  parent_research_id: string | null;
  analysis: string;
  constraints: string | null;
  round: number;
  summary: string | null;
  created_at: string;
}

export function createResearch(problemId: string, contextId: string, analysis: string, constraints?: string[], parentResearchId?: string): ResearchRow {
  const db = getDb();
  const researchId = genId();
  const round = (db.prepare(`SELECT MAX(round) as max_round FROM research WHERE problem_id = ?`).get(problemId) as any)?.max_round || 0;
  db.prepare(`INSERT INTO research (research_id, problem_id, context_id, parent_research_id, analysis, constraints, round) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(researchId, problemId, contextId, parentResearchId || null, analysis, constraints ? JSON.stringify(constraints) : null, round + 1);
  return db.prepare(`SELECT * FROM research WHERE research_id = ?`).get(researchId) as ResearchRow;
}

export function getResearch(researchId: string): ResearchRow | undefined {
  const db = getDb();
  return db.prepare(`SELECT * FROM research WHERE research_id = ?`).get(researchId) as ResearchRow | undefined;
}

export function getResearchByProblem(problemId: string): ResearchRow[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM research WHERE problem_id = ? ORDER BY round`).all(problemId) as ResearchRow[];
}

// --- Strategy CRUD ---

export interface StrategyRow {
  strategy_id: string;
  research_id: string;
  context_id: string;
  description: string;
  type: string;
  estimated_efficacy: string | null;
  rationale: string | null;
  priority: number;
  status: string;
  concern_id: string | null;
  concern_interpretation: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export function createStrategy(researchId: string, contextId: string, description: string, type: string, priority: number, estimatedEfficacy?: string, rationale?: string, concernId?: string, concernInterpretation?: string): StrategyRow {
  const db = getDb();
  const strategyId = genId();
  db.prepare(`INSERT INTO strategies (strategy_id, research_id, context_id, description, type, estimated_efficacy, rationale, priority, concern_id, concern_interpretation) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(strategyId, researchId, contextId, description, type, estimatedEfficacy || null, rationale || null, priority, concernId || null, concernInterpretation || null);
  return db.prepare(`SELECT * FROM strategies WHERE strategy_id = ?`).get(strategyId) as StrategyRow;
}

export function getStrategy(strategyId: string): StrategyRow | undefined {
  const db = getDb();
  return db.prepare(`SELECT * FROM strategies WHERE strategy_id = ?`).get(strategyId) as StrategyRow | undefined;
}

export function getStrategiesByResearch(researchId: string): StrategyRow[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM strategies WHERE research_id = ? ORDER BY priority`).all(researchId) as StrategyRow[];
}

export function getNextPendingStrategy(problemId: string): StrategyRow | undefined {
  const db = getDb();
  return db.prepare(`
    SELECT s.* FROM strategies s
    JOIN research r ON s.research_id = r.research_id
    WHERE r.problem_id = ? AND s.status = 'pending'
    ORDER BY s.priority LIMIT 1
  `).get(problemId) as StrategyRow | undefined;
}

export function updateStrategy(strategyId: string, updates: Record<string, unknown>): void {
  const db = getDb();
  const keys = Object.keys(updates);
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => updates[k]);
  db.prepare(`UPDATE strategies SET ${sets}, updated_at = datetime('now') WHERE strategy_id = ?`).run(...values, strategyId);
}

// --- Attempt CRUD ---

export interface AttemptRow {
  attempt_id: string;
  strategy_id: string;
  context_id: string;
  status: string;
  workspace_path: string | null;
  workspace_branch: string | null;
  outputs: string | null;
  error: string | null;
  evaluation: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export function createAttempt(strategyId: string, contextId: string): AttemptRow {
  const db = getDb();
  const attemptId = genId();
  db.prepare(`INSERT INTO attempts (attempt_id, strategy_id, context_id) VALUES (?, ?, ?)`).run(attemptId, strategyId, contextId);
  return db.prepare(`SELECT * FROM attempts WHERE attempt_id = ?`).get(attemptId) as AttemptRow;
}

export function getAttempt(attemptId: string): AttemptRow | undefined {
  const db = getDb();
  return db.prepare(`SELECT * FROM attempts WHERE attempt_id = ?`).get(attemptId) as AttemptRow | undefined;
}

export function getAttemptsByStrategy(strategyId: string): AttemptRow[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM attempts WHERE strategy_id = ? ORDER BY created_at`).all(strategyId) as AttemptRow[];
}

export function updateAttempt(attemptId: string, updates: Record<string, unknown>): void {
  const db = getDb();
  const keys = Object.keys(updates);
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => updates[k]);
  db.prepare(`UPDATE attempts SET ${sets}, updated_at = datetime('now') WHERE attempt_id = ?`).run(...values, attemptId);
}

// --- Concern CRUD ---

export interface ConcernRow {
  concern_id: string;
  context_id: string;
  short_id: string;
  node_type: string;
  node_id: string;
  source_phase: string;
  description: string;
  interpretations: string;
  widening_applied: string | null;
  status: string;
  user_message: string | null;
  selected_interpretation: string | null;
  impact: string | null;
  impact_reasoning: string | null;
  nodes_to_rework: string | null;
  rework_instructions: string | null;
  summary: string | null;
  created_at: string;
  updated_at: string;
}

export function getNextConcernShortId(contextId: string): string {
  const db = getDb();
  const count = (db.prepare(`SELECT COUNT(*) as cnt FROM concerns WHERE context_id = ?`).get(contextId) as any).cnt;
  return `C-${count + 1}`;
}

export function createConcern(contextId: string, nodeType: string, nodeId: string, sourcePhase: string, description: string, interpretations: unknown[], wideningApplied?: string): ConcernRow {
  const db = getDb();
  const concernId = genId();
  const shortId = getNextConcernShortId(contextId);
  db.prepare(`INSERT INTO concerns (concern_id, context_id, short_id, node_type, node_id, source_phase, description, interpretations, widening_applied) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(concernId, contextId, shortId, nodeType, nodeId, sourcePhase, description, JSON.stringify(interpretations), wideningApplied || null);
  return db.prepare(`SELECT * FROM concerns WHERE concern_id = ?`).get(concernId) as ConcernRow;
}

export function getConcern(concernId: string): ConcernRow | undefined {
  const db = getDb();
  return db.prepare(`SELECT * FROM concerns WHERE concern_id = ?`).get(concernId) as ConcernRow | undefined;
}

export function getConcernByShortId(contextId: string, shortId: string): ConcernRow | undefined {
  const db = getDb();
  return db.prepare(`SELECT * FROM concerns WHERE context_id = ? AND short_id = ?`).get(contextId, shortId) as ConcernRow | undefined;
}

export function getActiveConcerns(contextId: string): ConcernRow[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM concerns WHERE context_id = ? AND status IN ('raised', 'clarified') ORDER BY created_at`).all(contextId) as ConcernRow[];
}

export function getClarifiedConcerns(contextId: string): ConcernRow[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM concerns WHERE context_id = ? AND status = 'clarified' ORDER BY created_at`).all(contextId) as ConcernRow[];
}

export function updateConcern(concernId: string, updates: Record<string, unknown>): void {
  const db = getDb();
  const keys = Object.keys(updates);
  const sets = keys.map(k => `${k} = ?`).join(', ');
  const values = keys.map(k => updates[k]);
  db.prepare(`UPDATE concerns SET ${sets}, updated_at = datetime('now') WHERE concern_id = ?`).run(...values, concernId);
}

// --- Aggregate queries ---

export function getTotalAttempts(contextId: string): number {
  const db = getDb();
  return (db.prepare(`SELECT COUNT(*) as cnt FROM attempts WHERE context_id = ?`).get(contextId) as any).cnt;
}

export function getTotalProblems(contextId: string): number {
  const db = getDb();
  return (db.prepare(`SELECT COUNT(*) as cnt FROM problems WHERE context_id = ?`).get(contextId) as any).cnt;
}

export function getPlansByContext(contextId: string): PlanRow[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM plans WHERE context_id = ? ORDER BY created_at`).all(contextId) as PlanRow[];
}

export function getConcernsByNode(nodeType: string, nodeId: string): ConcernRow[] {
  const db = getDb();
  return db.prepare(`SELECT * FROM concerns WHERE node_type = ? AND node_id = ? ORDER BY created_at`).all(nodeType, nodeId) as ConcernRow[];
}

export function getSubPlanByStrategy(strategyId: string): PlanRow | undefined {
  const db = getDb();
  return db.prepare(`SELECT * FROM plans WHERE parent_strategy_id = ? LIMIT 1`).get(strategyId) as PlanRow | undefined;
}

export function listSessions(): (SessionRow & { plan_description: string | null })[] {
  const db = getDb();
  return db.prepare(`
    SELECT s.*,
           (SELECT p.description FROM plans p WHERE p.context_id = s.context_id ORDER BY p.created_at LIMIT 1) AS plan_description
    FROM sessions s
    ORDER BY s.updated_at DESC
  `).all() as (SessionRow & { plan_description: string | null })[];
}

export function getExpiredSessions(ttlDays: number): SessionRow[] {
  const db = getDb();
  return db.prepare(`
    SELECT * FROM sessions
    WHERE ended_at IS NOT NULL
    AND datetime(ended_at, '+' || ? || ' days') < datetime('now')
  `).all(ttlDays) as SessionRow[];
}
