import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

// Renamed from 011-scheduled-tasks.ts → 014-scheduled-tasks.ts to avoid
// filename collision with upstream's 011-pending-sender-approvals. The
// runtime framework keys on `name` (stored in schema_version), not
// filename or version field — rename is purely cosmetic. Do NOT change
// `name` — would re-apply and fail on "table already exists".
export const migration014: Migration = {
  version: 14,
  name: 'scheduled-tasks-central-table',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE scheduled_tasks (
        id              TEXT PRIMARY KEY,
        series_id       TEXT NOT NULL DEFAULT '',
        prompt          TEXT NOT NULL,
        script          TEXT,
        process_after   TEXT NOT NULL,
        recurrence      TEXT,
        status          TEXT NOT NULL DEFAULT 'pending',
        platform_id     TEXT,
        channel_type    TEXT,
        thread_id       TEXT,
        created_at      TEXT NOT NULL,
        updated_at      TEXT NOT NULL,
        UNIQUE(id)
      );

      CREATE INDEX idx_scheduled_tasks_status ON scheduled_tasks(status);
      CREATE INDEX idx_scheduled_tasks_process_after ON scheduled_tasks(process_after);
      CREATE INDEX idx_scheduled_tasks_series_id ON scheduled_tasks(series_id);
    `);
  },
};
