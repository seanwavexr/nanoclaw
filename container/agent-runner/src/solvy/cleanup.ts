/**
 * TTL-based cleanup of expired sessions.
 */

import * as db from './db.js';
import { cleanupContextWorktrees } from './worktree.js';
import fs from 'fs';
import path from 'path';

const DEFAULT_TTL_DAYS = 90;

/**
 * Clean up sessions that have been ended longer than the TTL.
 * Summary documents are never deleted.
 */
export function cleanupExpiredSessions(ttlDays?: number): { cleaned: string[]; errors: string[] } {
  const ttl = ttlDays ?? (parseInt(process.env.SOLVY_CLEANUP_TTL_DAYS || '', 10) || DEFAULT_TTL_DAYS);
  const expired = db.getExpiredSessions(ttl);
  const cleaned: string[] = [];
  const errors: string[] = [];

  for (const session of expired) {
    try {
      // Clean up worktrees
      cleanupContextWorktrees(session.context_id);

      // Delete session data from DB (cascade will handle children)
      const database = db.getDb();
      database.exec(`PRAGMA foreign_keys = OFF`);
      try {
        database.prepare(`DELETE FROM attempts WHERE context_id = ?`).run(session.context_id);
        database.prepare(`DELETE FROM strategies WHERE context_id = ?`).run(session.context_id);
        database.prepare(`DELETE FROM research WHERE context_id = ?`).run(session.context_id);
        database.prepare(`DELETE FROM problems WHERE context_id = ?`).run(session.context_id);
        database.prepare(`DELETE FROM concerns WHERE context_id = ?`).run(session.context_id);
        database.prepare(`DELETE FROM steps WHERE context_id = ?`).run(session.context_id);
        database.prepare(`DELETE FROM validations WHERE context_id = ?`).run(session.context_id);
        database.prepare(`DELETE FROM plans WHERE context_id = ?`).run(session.context_id);
        database.prepare(`DELETE FROM sessions WHERE context_id = ?`).run(session.context_id);
      } finally {
        database.exec(`PRAGMA foreign_keys = ON`);
      }

      cleaned.push(session.context_id);
    } catch (err: any) {
      errors.push(`${session.context_id}: ${err.message}`);
    }
  }

  return { cleaned, errors };
}
