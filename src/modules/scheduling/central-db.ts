/**
 * Central database helpers for persistent scheduled tasks.
 *
 * Tasks are stored in the central DB's scheduled_tasks table, not in per-session
 * inbound.db. This ensures they survive session lifecycle and container restarts.
 *
 * The host-sweep mechanism polls this table periodically and pushes due tasks
 * to the appropriate session's inbound.db.
 */
import type Database from 'better-sqlite3';

export interface CentralTask {
  id: string;
  series_id: string;
  prompt: string;
  script: string | null;
  process_after: string;
  recurrence: string | null;
  status: string;
  platform_id: string | null;
  channel_type: string | null;
  thread_id: string | null;
  created_at: string;
  updated_at: string;
}

export function insertCentralTask(
  db: Database.Database,
  task: {
    id: string;
    prompt: string;
    script: string | null;
    processAfter: string;
    recurrence: string | null;
    platformId: string | null;
    channelType: string | null;
    threadId: string | null;
  },
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO scheduled_tasks (id, series_id, prompt, script, process_after, recurrence, status, platform_id, channel_type, thread_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
  ).run(
    task.id,
    task.id,
    task.prompt,
    task.script,
    task.processAfter,
    task.recurrence,
    task.platformId,
    task.channelType,
    task.threadId,
    now,
    now,
  );
}

export function cancelCentralTask(db: Database.Database, taskId: string): void {
  db.prepare(
    "UPDATE scheduled_tasks SET status = 'completed', recurrence = NULL, updated_at = ? WHERE (id = ? OR series_id = ?) AND status IN ('pending', 'paused')",
  ).run(new Date().toISOString(), taskId, taskId);
}

export function pauseCentralTask(db: Database.Database, taskId: string): void {
  db.prepare(
    "UPDATE scheduled_tasks SET status = 'paused', updated_at = ? WHERE (id = ? OR series_id = ?) AND status = 'pending'",
  ).run(new Date().toISOString(), taskId, taskId);
}

export function resumeCentralTask(db: Database.Database, taskId: string): void {
  db.prepare(
    "UPDATE scheduled_tasks SET status = 'pending', updated_at = ? WHERE (id = ? OR series_id = ?) AND status = 'paused'",
  ).run(new Date().toISOString(), taskId, taskId);
}

export interface CentralTaskUpdate {
  prompt?: string;
  script?: string | null;
  recurrence?: string | null;
  processAfter?: string;
}

export function updateCentralTask(db: Database.Database, taskId: string, update: CentralTaskUpdate): number {
  const rows = db
    .prepare("SELECT id FROM scheduled_tasks WHERE (id = ? OR series_id = ?) AND status IN ('pending', 'paused')")
    .all(taskId, taskId) as Array<{ id: string }>;

  if (rows.length === 0) return 0;

  const sets: string[] = ['updated_at = ?'];
  const params: unknown[] = [new Date().toISOString()];

  if (update.prompt !== undefined) {
    sets.push('prompt = ?');
    params.push(update.prompt);
  }
  if (update.script !== undefined) {
    sets.push('script = ?');
    params.push(update.script);
  }
  if (update.recurrence !== undefined) {
    sets.push('recurrence = ?');
    params.push(update.recurrence);
  }
  if (update.processAfter !== undefined) {
    sets.push('process_after = ?');
    params.push(update.processAfter);
  }

  const tx = db.transaction(() => {
    for (const row of rows) {
      params.push(row.id);
      db.prepare(`UPDATE scheduled_tasks SET ${sets.join(', ')} WHERE id = ?`).run(...params);
      params.pop();
    }
  });
  tx();
  return rows.length;
}

export function getDuetasks(db: Database.Database): CentralTask[] {
  const now = new Date().toISOString();
  return db
    .prepare("SELECT * FROM scheduled_tasks WHERE status = 'pending' AND process_after <= ? ORDER BY process_after ASC")
    .all(now) as CentralTask[];
}

export function getNextDueTime(db: Database.Database): string | null {
  const row = db
    .prepare("SELECT process_after FROM scheduled_tasks WHERE status = 'pending' ORDER BY process_after ASC LIMIT 1")
    .get() as { process_after: string } | undefined;
  return row?.process_after ?? null;
}

export function markTaskProcessing(db: Database.Database, taskId: string): void {
  // Mark the task as having been sent to session inbound.db. We don't change
  // the status here — the container will process it and the recurrence handler
  // will manage state transitions.
  db.prepare('UPDATE scheduled_tasks SET updated_at = ? WHERE id = ?').run(new Date().toISOString(), taskId);
}

export function getCompletedRecurring(db: Database.Database): CentralTask[] {
  return db
    .prepare("SELECT * FROM scheduled_tasks WHERE status = 'completed' AND recurrence IS NOT NULL")
    .all() as CentralTask[];
}

export function markCentralTaskCompleted(db: Database.Database, taskId: string): void {
  db.prepare("UPDATE scheduled_tasks SET status = 'completed', updated_at = ? WHERE id = ?").run(
    new Date().toISOString(),
    taskId,
  );
}

export function insertCentralRecurrence(
  db: Database.Database,
  task: CentralTask,
  newId: string,
  nextRun: string | null,
): void {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO scheduled_tasks (id, series_id, prompt, script, process_after, recurrence, status, platform_id, channel_type, thread_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?)`,
  ).run(
    newId,
    task.series_id,
    task.prompt,
    task.script,
    nextRun,
    task.recurrence,
    task.platform_id,
    task.channel_type,
    task.thread_id,
    now,
    now,
  );
}

export function clearCentralRecurrence(db: Database.Database, taskId: string): void {
  db.prepare('UPDATE scheduled_tasks SET recurrence = NULL, updated_at = ? WHERE id = ?').run(
    new Date().toISOString(),
    taskId,
  );
}
