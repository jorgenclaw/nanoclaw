/**
 * One-time V1 → V2 data migration.
 *
 * Reads V1's store/messages.db (registered_groups, chats) and populates
 * V2's central DB (data/v2.db) with agent_groups, messaging_groups, and wiring.
 *
 * Run: pnpm exec tsx scripts/migrate-v1-data.ts
 *
 * Idempotent — safe to run multiple times.
 */
import Database from 'better-sqlite3';
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

const PROJECT_ROOT = process.cwd();
const V1_DB_PATH = path.join(PROJECT_ROOT, 'store', 'messages.db');
const V2_DB_PATH = path.join(PROJECT_ROOT, 'data', 'v2.db');

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

function parseJid(jid: string): { channelType: string; platformId: string; isGroup: boolean } | null {
  if (jid.startsWith('signal:group.')) {
    return { channelType: 'signal', platformId: `group.${jid.slice('signal:group.'.length)}`, isGroup: true };
  }
  if (jid.startsWith('signal:')) {
    return { channelType: 'signal', platformId: jid.slice('signal:'.length), isGroup: false };
  }
  if (jid.startsWith('whitenoise:')) {
    return { channelType: 'whitenoise', platformId: jid.slice('whitenoise:'.length), isGroup: true };
  }
  if (jid.startsWith('nostr:')) {
    return { channelType: 'nostr-dm', platformId: jid.slice('nostr:'.length), isGroup: false };
  }
  if (jid.startsWith('watch:')) {
    return { channelType: 'watch', platformId: jid, isGroup: false };
  }
  return null;
}

interface V1Group {
  jid: string;
  name: string;
  folder: string;
  trigger_pattern: string;
  requires_trigger: number;
  is_main: number;
  added_at: string;
}

function main(): void {
  if (!fs.existsSync(V1_DB_PATH)) {
    console.log(`V1 database not found at ${V1_DB_PATH} — nothing to migrate.`);
    return;
  }
  if (!fs.existsSync(V2_DB_PATH)) {
    console.error(`V2 database not found at ${V2_DB_PATH} — run the server once first to initialize it.`);
    process.exit(1);
  }

  const v1 = new Database(V1_DB_PATH, { readonly: true });
  const v2 = new Database(V2_DB_PATH);
  const now = new Date().toISOString();

  // Check if registered_groups table exists in V1
  const hasTable = v1.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='registered_groups'").get();
  if (!hasTable) {
    console.log('No registered_groups table in V1 database — nothing to migrate.');
    v1.close();
    v2.close();
    return;
  }

  const v1Groups = v1.prepare('SELECT * FROM registered_groups').all() as V1Group[];
  console.log(`Found ${v1Groups.length} registered groups in V1 database.`);

  // Track created agent_groups by folder to avoid duplicates
  const agentGroupsByFolder = new Map<string, string>();

  // First pass: check existing agent_groups in V2
  const existingAgs = v2.prepare('SELECT id, folder FROM agent_groups').all() as Array<{ id: string; folder: string }>;
  for (const ag of existingAgs) {
    agentGroupsByFolder.set(ag.folder, ag.id);
  }

  let created = 0;
  let skipped = 0;

  for (const g of v1Groups) {
    const parsed = parseJid(g.jid);
    if (!parsed) {
      console.log(`  Skipping unknown JID format: ${g.jid}`);
      skipped++;
      continue;
    }

    // Check if messaging_group already exists
    const existingMg = v2.prepare('SELECT id FROM messaging_groups WHERE channel_type = ? AND platform_id = ?')
      .get(parsed.channelType, parsed.platformId) as { id: string } | undefined;
    if (existingMg) {
      console.log(`  Skipping ${g.jid} (${g.name}) — messaging group already exists as ${existingMg.id}`);
      skipped++;
      continue;
    }

    // Get or create agent_group for this folder
    let agentGroupId = agentGroupsByFolder.get(g.folder);
    if (!agentGroupId) {
      agentGroupId = genId('ag');
      v2.prepare(
        `INSERT INTO agent_groups (id, name, folder, agent_provider, created_at)
         VALUES (?, ?, ?, NULL, ?)`
      ).run(agentGroupId, g.name || g.folder, g.folder, g.added_at || now);
      agentGroupsByFolder.set(g.folder, agentGroupId);
      console.log(`  Created agent_group: ${agentGroupId} (folder: ${g.folder})`);
    }

    // Create messaging_group
    const mgId = genId('mg');
    v2.prepare(
      `INSERT INTO messaging_groups (id, channel_type, platform_id, name, is_group, unknown_sender_policy, created_at)
       VALUES (?, ?, ?, ?, ?, 'request_approval', ?)`
    ).run(mgId, parsed.channelType, parsed.platformId, g.name, parsed.isGroup ? 1 : 0, g.added_at || now);

    // Build trigger rules JSON
    let triggerRules: string | null = null;
    if (g.requires_trigger && g.trigger_pattern) {
      triggerRules = JSON.stringify({
        pattern: g.trigger_pattern,
        requiresTrigger: true,
      });
    }

    // Create messaging_group_agent wiring
    const mgaId = genId('mga');
    v2.prepare(
      `INSERT INTO messaging_group_agents (id, messaging_group_id, agent_group_id, trigger_rules, response_scope, session_mode, priority, created_at)
       VALUES (?, ?, ?, ?, 'all', 'shared', 0, ?)`
    ).run(mgaId, mgId, agentGroupId, triggerRules, g.added_at || now);

    console.log(`  Migrated: ${g.jid} → mg:${mgId} → ag:${agentGroupId} (${g.name}, ${parsed.channelType})`);
    created++;
  }

  // Create owner user for Scott if not exists
  // Scott's Signal UUID from memory
  const scottUserId = 'signal:198c1cdb-8856-4ac7-9b84-a504a0017c79';
  const existingUser = v2.prepare('SELECT id FROM users WHERE id = ?').get(scottUserId);
  if (!existingUser) {
    v2.prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)')
      .run(scottUserId, 'signal', 'Scott Jorgensen', now);
    console.log(`  Created user: ${scottUserId} (Scott Jorgensen)`);
  }

  // Create owner role if not exists
  const existingRole = v2.prepare("SELECT user_id FROM user_roles WHERE user_id = ? AND role = 'owner'").get(scottUserId);
  if (!existingRole) {
    v2.prepare("INSERT INTO user_roles (user_id, role, agent_group_id, granted_by, granted_at) VALUES (?, 'owner', NULL, 'migration', ?)")
      .run(scottUserId, now);
    console.log(`  Created owner role for Scott`);
  }

  console.log(`\nMigration complete: ${created} created, ${skipped} skipped.`);

  v1.close();
  v2.close();
}

main();
