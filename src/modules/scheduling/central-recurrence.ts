/**
 * Central DB recurrence handler for persistent scheduled tasks.
 *
 * Periodically finds completed recurring tasks in the central DB,
 * computes the next run time, inserts a new pending occurrence, and
 * clears the recurrence flag on the completed task.
 *
 * This runs in the main host-sweep loop, not per-session.
 */
import type Database from 'better-sqlite3';

import { log } from '../../log.js';
import {
  getCompletedRecurring,
  insertCentralRecurrence,
  clearCentralRecurrence,
  type CentralTask,
} from './central-db.js';

export async function handleCentralRecurrence(centralDb: Database.Database): Promise<void> {
  const recurring = getCompletedRecurring(centralDb);

  for (const task of recurring) {
    try {
      const { CronExpressionParser } = await import('cron-parser');
      const interval = CronExpressionParser.parse(task.recurrence!);
      const nextRun = interval.next().toISOString();
      const newId = `task-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

      insertCentralRecurrence(centralDb, task, newId, nextRun);
      clearCentralRecurrence(centralDb, task.id);

      log.info('Inserted next central task recurrence', {
        originalId: task.id,
        newId,
        seriesId: task.series_id,
        nextRun,
      });
    } catch (err) {
      log.error('Failed to compute next central task recurrence', {
        taskId: task.id,
        recurrence: task.recurrence,
        err,
      });
    }
  }
}
