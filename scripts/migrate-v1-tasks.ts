/**
 * Migrate V1 scheduled_tasks to V2 session-based tasks.
 *
 * V1: scheduled_tasks table in store/messages.db
 * V2: messages_in rows with kind='task' in per-session inbound.db
 *
 * Run: pnpm exec tsx scripts/migrate-v1-tasks.ts
 */
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = process.cwd();
const V1_DB_PATH = path.join(PROJECT_ROOT, 'store', 'messages.db');
const V2_DB_PATH = path.join(PROJECT_ROOT, 'data', 'v2.db');
const SESSIONS_DIR = path.join(PROJECT_ROOT, 'data', 'v2-sessions');

interface V1Task {
  id: string;
  group_folder: string;
  chat_jid: string;
  prompt: string;
  script: string | null;
  schedule_type: string;
  schedule_value: string;
  next_run: string | null;
  status: string;
  context_mode: string;
  created_at: string;
}

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

function main(): void {
  const v1 = new Database(V1_DB_PATH, { readonly: true });
  const v2 = new Database(V2_DB_PATH);

  const tasks = v1.prepare(
    "SELECT * FROM scheduled_tasks WHERE status = 'active'"
  ).all() as V1Task[];

  console.log(`Found ${tasks.length} active V1 tasks.`);

  // Filter out tasks with WhatsApp JIDs or stale once tasks
  const validTasks = tasks.filter(t => {
    if (t.chat_jid?.includes('@s.whatsapp.net') || t.chat_jid?.includes('@g.us')) {
      console.log(`  Skipping ${t.id} (WhatsApp JID: ${t.chat_jid})`);
      return false;
    }
    if (t.schedule_type === 'once' && t.next_run && new Date(t.next_run) < new Date()) {
      console.log(`  Skipping ${t.id} (stale once task, was due ${t.next_run})`);
      return false;
    }
    return true;
  });

  console.log(`${validTasks.length} tasks to migrate after filtering.`);

  // Group tasks by folder → find/create sessions
  const tasksByFolder = new Map<string, V1Task[]>();
  for (const t of validTasks) {
    const list = tasksByFolder.get(t.group_folder) || [];
    list.push(t);
    tasksByFolder.set(t.group_folder, list);
  }

  let migrated = 0;

  for (const [folder, folderTasks] of tasksByFolder) {
    // Find agent group
    const ag = v2.prepare('SELECT id FROM agent_groups WHERE folder = ?').get(folder) as { id: string } | undefined;
    if (!ag) {
      console.log(`  No agent group for folder '${folder}', skipping ${folderTasks.length} tasks`);
      continue;
    }

    // Find or create a session for this agent group
    let session = v2.prepare(
      "SELECT id FROM sessions WHERE agent_group_id = ? AND status = 'active'"
    ).get(ag.id) as { id: string } | undefined;

    if (!session) {
      const sessionId = genId('sess');
      const now = new Date().toISOString();
      v2.prepare(
        `INSERT INTO sessions (id, agent_group_id, messaging_group_id, thread_id, agent_provider, status, container_status, last_active, created_at)
         VALUES (?, ?, NULL, NULL, NULL, 'active', 'stopped', NULL, ?)`
      ).run(sessionId, ag.id, now);

      // Init session folder + DBs
      const sessDir = path.join(SESSIONS_DIR, ag.id, sessionId);
      fs.mkdirSync(sessDir, { recursive: true });
      fs.mkdirSync(path.join(sessDir, 'outbox'), { recursive: true });

      // Create inbound.db with schema
      const inDb = new Database(path.join(sessDir, 'inbound.db'));
      inDb.pragma('journal_mode = DELETE');
      inDb.pragma('busy_timeout = 5000');
      inDb.exec(`
        CREATE TABLE IF NOT EXISTS messages_in (
          id TEXT PRIMARY KEY,
          seq INTEGER NOT NULL UNIQUE,
          kind TEXT NOT NULL DEFAULT 'chat',
          timestamp TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          status_changed TEXT,
          process_after TEXT,
          recurrence TEXT,
          series_id TEXT,
          tries INTEGER NOT NULL DEFAULT 0,
          platform_id TEXT,
          channel_type TEXT,
          thread_id TEXT,
          content TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS delivered (
          message_out_id TEXT PRIMARY KEY,
          platform_message_id TEXT,
          status TEXT NOT NULL DEFAULT 'delivered',
          delivered_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS destinations (
          name TEXT NOT NULL,
          display_name TEXT,
          type TEXT NOT NULL,
          channel_type TEXT,
          platform_id TEXT,
          agent_group_id TEXT,
          PRIMARY KEY (name)
        );
        CREATE TABLE IF NOT EXISTS session_routing (
          id INTEGER PRIMARY KEY CHECK (id = 1),
          channel_type TEXT,
          platform_id TEXT,
          thread_id TEXT
        );
      `);
      inDb.close();

      // Create outbound.db
      const outDb = new Database(path.join(sessDir, 'outbound.db'));
      outDb.pragma('journal_mode = DELETE');
      outDb.exec(`
        CREATE TABLE IF NOT EXISTS messages_out (
          id TEXT PRIMARY KEY,
          seq INTEGER NOT NULL UNIQUE,
          in_reply_to TEXT,
          timestamp TEXT NOT NULL,
          delivered INTEGER NOT NULL DEFAULT 0,
          deliver_after TEXT,
          recurrence TEXT,
          kind TEXT NOT NULL DEFAULT 'text',
          platform_id TEXT,
          channel_type TEXT,
          thread_id TEXT,
          content TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS processing_ack (
          message_id TEXT PRIMARY KEY,
          status TEXT NOT NULL,
          status_changed TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS session_state (
          key TEXT PRIMARY KEY,
          value TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
      `);
      outDb.close();

      session = { id: sessionId };
      console.log(`  Created session ${sessionId} for ${folder}`);
    }

    // Find the messaging group for reply routing (first signal DM for this agent group)
    const mgRow = v2.prepare(`
      SELECT mg.channel_type, mg.platform_id FROM messaging_groups mg
      JOIN messaging_group_agents mga ON mga.messaging_group_id = mg.id
      WHERE mga.agent_group_id = ?
      LIMIT 1
    `).get(ag.id) as { channel_type: string; platform_id: string } | undefined;

    // Open inbound.db and insert tasks
    const inDbPath = path.join(SESSIONS_DIR, ag.id, session.id, 'inbound.db');
    const inDb = new Database(inDbPath);
    inDb.pragma('journal_mode = DELETE');
    inDb.pragma('busy_timeout = 5000');

    // Get next even seq
    const getNextSeq = () => {
      const max = inDb.prepare('SELECT COALESCE(MAX(seq), -2) + 2 AS next FROM messages_in').get() as { next: number };
      return max.next % 2 === 0 ? max.next : max.next + 1;
    };

    for (const task of folderTasks) {
      const taskId = genId('task');
      const content = JSON.stringify({
        prompt: task.prompt,
        script: task.script || undefined,
        context_mode: task.context_mode || 'isolated',
        migrated_from: task.id,
      });

      let recurrence: string | null = null;
      let processAfter: string | null = null;

      if (task.schedule_type === 'cron') {
        recurrence = task.schedule_value;
        // Set process_after to next_run if available, otherwise null (will fire on next sweep)
        processAfter = task.next_run || null;
      } else if (task.schedule_type === 'once') {
        processAfter = task.schedule_value;
      } else if (task.schedule_type === 'interval') {
        // V2 doesn't have native interval — convert to a note in the content
        const intervalMs = parseInt(task.schedule_value, 10);
        const intervalMin = Math.round(intervalMs / 60000);
        recurrence = `*/${intervalMin} * * * *`;
        processAfter = task.next_run || null;
        console.log(`  Converted interval ${intervalMs}ms → cron every ${intervalMin}min`);
      }

      const seq = getNextSeq();
      inDb.prepare(
        `INSERT INTO messages_in (id, seq, kind, timestamp, status, process_after, recurrence, series_id, tries, platform_id, channel_type, thread_id, content)
         VALUES (?, ?, 'task', datetime('now'), 'pending', ?, ?, ?, 0, ?, ?, NULL, ?)`
      ).run(
        taskId, seq,
        processAfter, recurrence, taskId,
        mgRow?.platform_id || null,
        mgRow?.channel_type || null,
        content,
      );

      const schedDesc = recurrence ? `cron: ${recurrence}` : `once: ${processAfter}`;
      console.log(`  Migrated: ${task.id} → ${taskId} (${folder}, ${schedDesc})`);
      migrated++;
    }

    // Set session routing so task replies go to the right channel
    if (mgRow) {
      inDb.prepare(
        `INSERT OR REPLACE INTO session_routing (id, channel_type, platform_id, thread_id)
         VALUES (1, ?, ?, NULL)`
      ).run(mgRow.channel_type, mgRow.platform_id);
    }

    inDb.close();
  }

  console.log(`\nMigrated ${migrated} tasks.`);
  v1.close();
  v2.close();
}

main();
