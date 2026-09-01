import type Database from 'better-sqlite3';
import type { Migration } from './index.js';

// Wires up the `env` / `blocked_hosts` fields that `ContainerConfig` (the
// materialized container.json shape) has declared since the container-configs
// DB migration, but that were never given DB columns — the fields existed only
// for forward compatibility. Needed now: materializeContainerJson() overwrites
// container.json wholesale from the DB on every spawn, so any group whose
// per-group env vars (e.g. OPENCODE_PROVIDER/MODEL) were only ever set by
// hand-editing the file gets them silently wiped the next time a container
// spawns after the DB-backed config lands.
export const migration021: Migration = {
  version: 21,
  name: 'container-config-env',
  up(db: Database.Database) {
    db.exec(`
      ALTER TABLE container_configs ADD COLUMN env TEXT NOT NULL DEFAULT '{}';
      ALTER TABLE container_configs ADD COLUMN blocked_hosts TEXT NOT NULL DEFAULT '[]';
    `);
  },
};
