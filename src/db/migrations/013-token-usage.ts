import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

// Renamed from 010-token-usage.ts → 013-token-usage.ts to avoid filename
// collision with upstream's 010-engage-modes. The runtime framework keys
// on `name` (stored in schema_version), not filename or version field,
// so the rename is purely cosmetic. Do NOT change `name` — would cause
// re-application on existing installs.
export const migration013: Migration = {
  version: 13,
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
