import type Database from 'better-sqlite3';

import type { Migration } from './index.js';

export const migration011: Migration = {
  version: 11,
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
