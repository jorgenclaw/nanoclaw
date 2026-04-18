import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

export const migration010: Migration = {
  version: 10,
  name: 'token-usage',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS token_usage (
        group_folder    TEXT NOT NULL,
        chat_jid        TEXT NOT NULL,
        run_at          TEXT NOT NULL DEFAULT (datetime('now')),
        input_tokens    INTEGER NOT NULL DEFAULT 0,
        output_tokens   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_token_usage_group ON token_usage(group_folder);
      CREATE INDEX IF NOT EXISTS idx_token_usage_time ON token_usage(run_at);
    `);
  },
};
