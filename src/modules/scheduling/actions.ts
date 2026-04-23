/**
 * Delivery action handlers for scheduling.
 *
 * The container can't write to inbound.db (host-owned). When the agent calls
 * schedule_task / cancel_task / etc. via MCP, the container writes a
 * `kind='system'` outbound message with an `action` field. The delivery path
 * reaches into this module via the delivery-action registry and we apply the
 * change to the central DB here.
 */
import type Database from 'better-sqlite3';

import { wakeContainer } from '../../container-runner.js';
import { getSession } from '../../db/sessions.js';
import { getDb } from '../../db/connection.js';
import { log } from '../../log.js';
import { writeSessionMessage } from '../../session-manager.js';
import type { Session } from '../../types.js';
import {
  insertCentralTask,
  cancelCentralTask,
  pauseCentralTask,
  resumeCentralTask,
  updateCentralTask,
  type CentralTaskUpdate,
} from './central-db.js';

export async function handleScheduleTask(
  content: Record<string, unknown>,
  _session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const prompt = content.prompt as string;
  const script = content.script as string | null;
  const processAfter = content.processAfter as string;
  const recurrence = (content.recurrence as string) || null;

  const centralDb = getDb();
  insertCentralTask(centralDb, {
    id: taskId,
    prompt,
    script,
    processAfter,
    recurrence,
    platformId: (content.platformId as string) ?? null,
    channelType: (content.channelType as string) ?? null,
    threadId: (content.threadId as string) ?? null,
  });
  log.info('Scheduled task created', { taskId, processAfter, recurrence });
}

export async function handleCancelTask(
  content: Record<string, unknown>,
  _session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const centralDb = getDb();
  cancelCentralTask(centralDb, taskId);
  log.info('Task cancelled', { taskId });
}

export async function handlePauseTask(
  content: Record<string, unknown>,
  _session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const centralDb = getDb();
  pauseCentralTask(centralDb, taskId);
  log.info('Task paused', { taskId });
}

export async function handleResumeTask(
  content: Record<string, unknown>,
  _session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const centralDb = getDb();
  resumeCentralTask(centralDb, taskId);
  log.info('Task resumed', { taskId });
}

export async function handleUpdateTask(
  content: Record<string, unknown>,
  session: Session,
  _inDb: Database.Database,
): Promise<void> {
  const taskId = content.taskId as string;
  const update: CentralTaskUpdate = {};
  if (typeof content.prompt === 'string') update.prompt = content.prompt;
  if (typeof content.processAfter === 'string') update.processAfter = content.processAfter;
  if (content.recurrence === null || typeof content.recurrence === 'string') {
    update.recurrence = content.recurrence as string | null;
  }
  if (content.script === null || typeof content.script === 'string') {
    update.script = content.script as string | null;
  }
  const centralDb = getDb();
  const touched = updateCentralTask(centralDb, taskId, update);
  log.info('Task updated', { taskId, touched, fields: Object.keys(update) });
  if (touched === 0) {
    // Notify the agent that update_task matched nothing. Replicates the
    // old notifyAgent helper that used to live in delivery.ts — inlined
    // here so scheduling doesn't depend on delivery's private helpers.
    writeSessionMessage(session.agent_group_id, session.id, {
      id: `sys-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'chat',
      timestamp: new Date().toISOString(),
      platformId: session.agent_group_id,
      channelType: 'agent',
      threadId: null,
      content: JSON.stringify({
        text: `update_task: no live task matched id "${taskId}".`,
        sender: 'system',
        senderId: 'system',
      }),
    });
    const fresh = getSession(session.id);
    if (fresh) {
      wakeContainer(fresh).catch((err) =>
        log.error('Failed to wake container after update_task notification', { err }),
      );
    }
  }
}
