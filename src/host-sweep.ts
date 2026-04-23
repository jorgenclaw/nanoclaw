/**
 * Host sweep — periodic maintenance of all session DBs.
 *
 * Two-DB architecture:
 *   - Reads processing_ack from outbound.db to sync message status
 *   - Writes to inbound.db (host-owned) for status updates and recurrence
 *   - Uses heartbeat file mtime for stale container detection (not DB writes)
 *   - Never writes to outbound.db — preserves single-writer-per-file invariant
 */
import type Database from 'better-sqlite3';
import fs from 'fs';

import { getActiveSessions } from './db/sessions.js';
import { getAgentGroup } from './db/agent-groups.js';
import { getDb } from './db/connection.js';
import {
  countDueMessages,
  syncProcessingAcks,
  getStuckProcessingIds,
  getMessageForRetry,
  markMessageFailed,
  retryWithBackoff,
  pruneCompletedTasks,
  getNextDueTimestamp,
} from './db/session-db.js';
import { log } from './log.js';
import { openInboundDb, openOutboundDb, inboundDbPath, heartbeatPath } from './session-manager.js';
import { wakeContainer, isContainerRunning } from './container-runner.js';
import type { Session } from './types.js';
import { nextEvenSeq } from './db/session-db.js';

const SWEEP_INTERVAL_MS = 60_000;
const STALE_THRESHOLD_MS = 10 * 60 * 1000; // 10 minutes
const MAX_TRIES = 5;
const BACKOFF_BASE_MS = 5000;

let running = false;
let preciseTimer: ReturnType<typeof setTimeout> | null = null;

export function startHostSweep(): void {
  if (running) return;
  running = true;
  sweep();
}

export function stopHostSweep(): void {
  running = false;
  if (preciseTimer) {
    clearTimeout(preciseTimer);
    preciseTimer = null;
  }
}

async function sweep(): Promise<void> {
  if (!running) return;

  let earliestDue: number | null = null;

  try {
    // 1. Check central scheduled tasks and push due ones to their sessions
    try {
      const centralDue = await sweepCentralTasks();
      if (centralDue !== null && (earliestDue === null || centralDue < earliestDue)) {
        earliestDue = centralDue;
      }
    } catch (err) {
      log.error('Central task sweep error', { err });
    }

    // 2. Sweep per-session DBs
    const sessions = getActiveSessions();
    for (const session of sessions) {
      const nextDue = await sweepSession(session);
      if (nextDue !== null) {
        if (earliestDue === null || nextDue < earliestDue) {
          earliestDue = nextDue;
        }
      }
    }
  } catch (err) {
    log.error('Host sweep error', { err });
  }

  // Schedule a precise wake for the next due task (if sooner than the regular sweep)
  if (preciseTimer) {
    clearTimeout(preciseTimer);
    preciseTimer = null;
  }
  if (earliestDue !== null) {
    const delayMs = Math.max(1000, earliestDue - Date.now());
    if (delayMs < SWEEP_INTERVAL_MS) {
      preciseTimer = setTimeout(() => {
        preciseTimer = null;
        if (running) sweep();
      }, delayMs);
      log.info('Precise task timer set', { firesInMs: delayMs });
    }
  }

  setTimeout(sweep, SWEEP_INTERVAL_MS);
}

async function sweepSession(session: Session): Promise<number | null> {
  const agentGroup = getAgentGroup(session.agent_group_id);
  if (!agentGroup) return null;

  const inPath = inboundDbPath(agentGroup.id, session.id);
  if (!fs.existsSync(inPath)) return null;

  let inDb: Database.Database;
  let outDb: Database.Database | null = null;
  try {
    inDb = openInboundDb(agentGroup.id, session.id);
  } catch {
    return null;
  }

  try {
    outDb = openOutboundDb(agentGroup.id, session.id);
  } catch {
    // outbound.db might not exist yet (container hasn't started)
  }

  try {
    // 1. Sync processing_ack → messages_in status
    if (outDb) {
      syncProcessingAcks(inDb, outDb);
    }

    // 2. Check for due pending messages → wake container
    const dueCount = countDueMessages(inDb);

    if (dueCount > 0 && !isContainerRunning(session.id)) {
      log.info('Waking container for due messages', { sessionId: session.id, count: dueCount });
      await wakeContainer(session);
    }

    // 3. Detect stale containers via heartbeat file
    if (outDb) {
      detectStaleContainers(inDb, outDb, session, agentGroup.id);
    }

    // 4. Handle recurrence for completed messages.
    // MODULE-HOOK:scheduling-recurrence:start
    const { handleRecurrence } = await import('./modules/scheduling/recurrence.js');
    await handleRecurrence(inDb, session);
    // MODULE-HOOK:scheduling-recurrence:end

    // 5. Prune old completed tasks (retain 7 days)
    const pruned = pruneCompletedTasks(inDb);
    if (pruned > 0) {
      log.info('Pruned completed tasks', { sessionId: session.id, count: pruned });
    }

    // 6. Find the next future due time for precise timer scheduling
    const nextDue = getNextDueTimestamp(inDb);
    return nextDue ? new Date(nextDue + 'Z').getTime() : null;
  } finally {
    inDb.close();
    outDb?.close();
  }
}

async function sweepCentralTasks(): Promise<number | null> {
  const centralDb = getDb();

  // 1. Handle central task recurrence
  const { handleCentralRecurrence } = await import('./modules/scheduling/central-recurrence.js');
  await handleCentralRecurrence(centralDb);

  // 2. Find due central tasks
  const { getDuetasks, getNextDueTime, markTaskProcessing } = await import('./modules/scheduling/central-db.js');
  const dueTasks = getDuetasks(centralDb);

  if (dueTasks.length === 0) {
    const nextDueStr = getNextDueTime(centralDb);
    return nextDueStr ? new Date(nextDueStr + 'Z').getTime() : null;
  }

  // 3. For each due task, find its session and insert into inbound.db
  const sessions = getActiveSessions();
  const sessionMap = new Map<string, Session>();
  for (const session of sessions) {
    sessionMap.set(session.id, session);
  }

  for (const task of dueTasks) {
    try {
      // Find a session that matches this task's destination
      let targetSession: Session | undefined;

      // If the task has platform_id and channel_type, find a session with that messaging group
      if (task.platform_id && task.channel_type) {
        targetSession = sessions.find(
          (s) => s.messaging_group_id && s.agent_group_id === s.agent_group_id, // basic validation
        );
      }

      // If no specific session found, use the main session for the agent group
      if (!targetSession) {
        targetSession = sessions.find((s) => s.agent_group_id === s.agent_group_id);
      }

      if (!targetSession) {
        log.warn('No target session found for central task', { taskId: task.id });
        continue;
      }

      const agentGroup = getAgentGroup(targetSession.agent_group_id);
      if (!agentGroup) continue;

      const inPath = inboundDbPath(agentGroup.id, targetSession.id);
      if (!fs.existsSync(inPath)) {
        log.warn('Session inbound.db does not exist', { sessionId: targetSession.id });
        continue;
      }

      let inDb: Database.Database;
      try {
        inDb = openInboundDb(agentGroup.id, targetSession.id);
      } catch {
        continue;
      }

      try {
        // Insert the task into the session's inbound.db
        inDb
          .prepare(
            `INSERT INTO messages_in (id, seq, timestamp, status, tries, process_after, recurrence, kind, platform_id, channel_type, thread_id, content, series_id)
             VALUES (?, ?, datetime('now'), 'pending', 0, ?, ?, 'task', ?, ?, ?, ?, ?)`,
          )
          .run(
            task.id,
            nextEvenSeq(inDb),
            task.process_after,
            task.recurrence,
            task.platform_id,
            task.channel_type,
            task.thread_id,
            JSON.stringify({ prompt: task.prompt, script: task.script }),
            task.series_id,
          );

        markTaskProcessing(centralDb, task.id);
        log.info('Pushed central task to session inbound.db', {
          taskId: task.id,
          sessionId: targetSession.id,
        });

        // Wake the container if it's not running
        if (!isContainerRunning(targetSession.id)) {
          await wakeContainer(targetSession);
        }
      } finally {
        inDb.close();
      }
    } catch (err) {
      log.error('Failed to push central task to session', { taskId: task.id, err });
    }
  }

  // Return the next due time
  const nextDueStr = getNextDueTime(centralDb);
  return nextDueStr ? new Date(nextDueStr + 'Z').getTime() : null;
}

/**
 * Detect stale containers using heartbeat file mtime.
 * If the heartbeat is older than STALE_THRESHOLD and processing_ack has
 * 'processing' entries, the container likely crashed — reset with backoff.
 */
function detectStaleContainers(
  inDb: Database.Database,
  outDb: Database.Database,
  session: Session,
  agentGroupId: string,
): void {
  const hbPath = heartbeatPath(agentGroupId, session.id);
  let heartbeatAge = Infinity;
  try {
    const stat = fs.statSync(hbPath);
    heartbeatAge = Date.now() - stat.mtimeMs;
  } catch {
    // No heartbeat file — container may never have started, or it's very old
  }

  if (heartbeatAge < STALE_THRESHOLD_MS) return; // Container is alive

  // Heartbeat is stale — check for stuck processing entries
  const processingIds = getStuckProcessingIds(outDb);
  if (processingIds.length === 0) return;

  for (const messageId of processingIds) {
    const msg = getMessageForRetry(inDb, messageId, 'pending');
    if (!msg) continue;

    if (msg.tries >= MAX_TRIES) {
      markMessageFailed(inDb, msg.id);
      log.warn('Message marked as failed after max retries', { messageId: msg.id, sessionId: session.id });
    } else {
      const backoffMs = BACKOFF_BASE_MS * Math.pow(2, msg.tries);
      const backoffSec = Math.floor(backoffMs / 1000);
      retryWithBackoff(inDb, msg.id, backoffSec);
      log.info('Reset stale message with backoff', { messageId: msg.id, tries: msg.tries, backoffMs });
    }
  }
}
