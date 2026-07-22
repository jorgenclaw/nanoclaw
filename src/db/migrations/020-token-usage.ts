import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

// Renumbered 010 → 013 → 020 across two upstream syncs to dodge filename
// collisions (010-engage-modes, then the 013-019 range upstream now owns).
// The runtime framework keys on `name` (stored in schema_version), not
// filename or version field, so the renumbering is purely cosmetic. Do NOT
// change `name` — would cause re-application on existing installs.
export const migration020: Migration = {
  version: 20,
  name: 'token-usage',
  up(db: Database.Database) {
    db.exec(`
      CREATE TABLE IF NOT EXISTS token_usage (
        group_folder    TEXT NOT NULL,
        chat_jid        TEXT NOT NULL,
        run_at          TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
        input_tokens    INTEGER NOT NULL DEFAULT 0,
        output_tokens   INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_token_usage_group ON token_usage(group_folder);
      CREATE INDEX IF NOT EXISTS idx_token_usage_time ON token_usage(run_at);
    `);
  },
};
