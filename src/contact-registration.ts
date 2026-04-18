/**
 * Host-side handler for the register_contact delivery action.
 *
 * When the container agent calls the register_contact MCP tool, it writes
 * a system action to messages_out. The delivery pipeline calls this handler,
 * which creates the user, agent group, messaging group, wiring, and membership
 * in the central DB — no manual host access needed.
 */
import crypto from 'crypto';
import fs from 'fs';
import path from 'path';

import { GROUPS_DIR } from './config.js';
import { getDb, hasTable } from './db/connection.js';
import { createAgentGroup, getAgentGroupByFolder } from './db/agent-groups.js';
import { createMessagingGroup, createMessagingGroupAgent, getMessagingGroupByPlatform } from './db/messaging-groups.js';
import { registerDeliveryAction } from './delivery.js';
import { log } from './log.js';
import type { Session } from './types.js';

function genId(prefix: string): string {
  return `${prefix}-${Date.now()}-${crypto.randomBytes(3).toString('hex')}`;
}

registerDeliveryAction('register_contact', async (content) => {
  const channelType = content.channelType as string;
  const platformId = content.platformId as string;
  const displayName = content.displayName as string;
  const folder = content.folder as string;
  const requiresTrigger = (content.requiresTrigger as boolean) ?? false;

  if (!channelType || !platformId || !displayName || !folder) {
    log.warn('register_contact: missing required fields', { content });
    return;
  }

  const db = getDb();
  const now = new Date().toISOString();
  const userId = `${channelType}:${platformId}`;

  // Create user if not exists
  const existingUser = db.prepare('SELECT id FROM users WHERE id = ?').get(userId);
  if (!existingUser) {
    db.prepare('INSERT INTO users (id, kind, display_name, created_at) VALUES (?, ?, ?, ?)').run(
      userId,
      channelType,
      displayName,
      now,
    );
    log.info('register_contact: created user', { userId, displayName });
  }

  // Get or create agent group
  let ag = getAgentGroupByFolder(folder);
  if (!ag) {
    const agId = genId('ag');
    createAgentGroup({
      id: agId,
      name: displayName,
      folder,
      agent_provider: null,
      created_at: now,
    });
    ag = { id: agId, name: displayName, folder, agent_provider: null, created_at: now };
    log.info('register_contact: created agent group', { agId, folder });

    // Create group folder
    const groupDir = path.join(GROUPS_DIR, folder);
    fs.mkdirSync(groupDir, { recursive: true });
  }

  // Get or create messaging group
  let mg = getMessagingGroupByPlatform(channelType, platformId);
  if (!mg) {
    const mgId = genId('mg');
    createMessagingGroup({
      id: mgId,
      channel_type: channelType,
      platform_id: platformId,
      name: displayName,
      is_group: 0,
      unknown_sender_policy: 'request_approval',
      created_at: now,
    });
    mg = {
      id: mgId,
      channel_type: channelType,
      platform_id: platformId,
      name: displayName,
      is_group: 0,
      unknown_sender_policy: 'request_approval' as const,
      created_at: now,
    };
    log.info('register_contact: created messaging group', { mgId, channelType, platformId });
  }

  // Wire messaging group to agent group
  const existingWiring = db
    .prepare('SELECT id FROM messaging_group_agents WHERE messaging_group_id = ? AND agent_group_id = ?')
    .get(mg.id, ag.id);
  if (!existingWiring) {
    const triggerRules = requiresTrigger ? JSON.stringify({ pattern: '@Jorgenclaw', requiresTrigger: true }) : null;
    createMessagingGroupAgent({
      id: genId('mga'),
      messaging_group_id: mg.id,
      agent_group_id: ag.id,
      trigger_rules: triggerRules,
      response_scope: 'all',
      session_mode: 'shared',
      priority: 0,
      created_at: now,
    });
    log.info('register_contact: wired messaging group to agent group', { mgId: mg.id, agId: ag.id });
  }

  // Add user as member of agent group
  if (hasTable(db, 'agent_group_members')) {
    const existingMember = db
      .prepare('SELECT user_id FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
      .get(userId, ag.id);
    if (!existingMember) {
      db.prepare(
        'INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)',
      ).run(userId, ag.id, now);
      log.info('register_contact: added membership', { userId, agId: ag.id });
    }
  }

  // Also add the owner (Scott) as member so he can see the conversation
  if (hasTable(db, 'user_roles') && hasTable(db, 'agent_group_members')) {
    const owners = db
      .prepare("SELECT user_id FROM user_roles WHERE role = 'owner' AND agent_group_id IS NULL")
      .all() as Array<{ user_id: string }>;
    for (const owner of owners) {
      const ownerMember = db
        .prepare('SELECT user_id FROM agent_group_members WHERE user_id = ? AND agent_group_id = ?')
        .get(owner.user_id, ag.id);
      if (!ownerMember) {
        db.prepare(
          'INSERT INTO agent_group_members (user_id, agent_group_id, added_by, added_at) VALUES (?, ?, NULL, ?)',
        ).run(owner.user_id, ag.id, now);
      }
    }
  }

  log.info('register_contact: complete', { displayName, channelType, platformId, folder });
});
