/**
 * X owner-approval holds (delete tweet / unfollow / retweet / unretweet).
 *
 * Regression: an agent that retried x_delete_tweet while the first card was
 * still open sent the owner four identical cards (2026-09-22). A repeat of
 * a request that's already waiting must not create a second card, and the
 * agent must be told it's waiting either way.
 *
 * Setup mirrors self-mod/request.test.ts: real central DB, a fake delivery
 * adapter that records cards, and a mocked writeSessionMessage to read the
 * agent-facing notes.
 */
import * as fs from 'fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { initTestDb, closeDb, runMigrations } from '../../db/index.js';
import { createAgentGroup } from '../../db/agent-groups.js';
import { createMessagingGroup } from '../../db/messaging-groups.js';
import { createSession, getPendingApprovalsByAction } from '../../db/sessions.js';
import { setDeliveryAdapter, type ChannelDeliveryAdapter } from '../../delivery.js';
import { writeSessionMessage } from '../../session-manager.js';
import { upsertUser } from '../permissions/db/users.js';
import { upsertUserDm } from '../permissions/db/user-dms.js';
import { grantRole } from '../permissions/db/user-roles.js';
import type { Session } from '../../types.js';
import { requestXDeleteTweetHold, requestXUnfollowHold } from './request.js';

vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../config.js', async () => {
  const actual = await vi.importActual('../../config.js');
  return { ...actual, DATA_DIR: '/tmp/nanoclaw-test-x-approval' };
});

vi.mock('../../session-manager.js', async () => {
  const actual = await vi.importActual<typeof import('../../session-manager.js')>('../../session-manager.js');
  return { ...actual, writeSessionMessage: vi.fn() };
});

vi.mock('../../webhook-server.js', () => ({
  registerWebhookAdapter: vi.fn(),
}));

const TEST_DIR = '/tmp/nanoclaw-test-x-approval';

function now(): string {
  return new Date().toISOString();
}

let cards: string[];

const fakeAdapter: ChannelDeliveryAdapter = {
  async deliver(_channelType, _platformId, _threadId, _kind, content) {
    cards.push(content);
    return 'pm-1';
  },
};

let session: Session;

beforeEach(() => {
  vi.clearAllMocks();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
  fs.mkdirSync(TEST_DIR, { recursive: true });
  const db = initTestDb();
  runMigrations(db);
  cards = [];

  createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
  session = {
    id: 'sess-1',
    agent_group_id: 'ag-1',
    messaging_group_id: null,
    thread_id: null,
    agent_provider: null,
    status: 'active',
    container_status: 'stopped',
    last_active: now(),
    created_at: now(),
  };
  createSession(session);

  upsertUser({ id: 'slack:owner-1', kind: 'slack', display_name: 'Owner', created_at: now() });
  grantRole({ user_id: 'slack:owner-1', role: 'owner', agent_group_id: null, granted_by: null, granted_at: now() });
  createMessagingGroup({
    id: 'mg-dm-1',
    channel_type: 'slack',
    platform_id: 'D-owner-1',
    name: 'Owner DM',
    is_group: 0,
    unknown_sender_policy: 'strict',
    created_at: now(),
  });
  upsertUserDm({ user_id: 'slack:owner-1', channel_type: 'slack', messaging_group_id: 'mg-dm-1', resolved_at: now() });

  setDeliveryAdapter(fakeAdapter);
});

afterEach(() => {
  closeDb();
  if (fs.existsSync(TEST_DIR)) fs.rmSync(TEST_DIR, { recursive: true, force: true });
});

function notes(): string[] {
  return vi
    .mocked(writeSessionMessage)
    .mock.calls.map((call) => (JSON.parse(call[2].content) as { text: string }).text);
}

const DELETE = { tweetUrl: 'https://x.com/me/status/1', textMustMatch: 'Test tweet' };

describe('X approval holds', () => {
  it('sends one card and tells the agent it is waiting', async () => {
    await requestXDeleteTweetHold(DELETE, session);

    expect(getPendingApprovalsByAction('x_delete_tweet')).toHaveLength(1);
    expect(cards).toHaveLength(1);
    expect(notes().at(-1)).toContain('sent to the owner for approval');
  });

  it('a repeat of a waiting request does not send a second card', async () => {
    await requestXDeleteTweetHold(DELETE, session);
    await requestXDeleteTweetHold(DELETE, session);
    await requestXDeleteTweetHold(DELETE, session);

    expect(getPendingApprovalsByAction('x_delete_tweet')).toHaveLength(1);
    expect(cards).toHaveLength(1);
    expect(notes().at(-1)).toContain('already waiting');
  });

  it('a different target still gets its own card', async () => {
    await requestXDeleteTweetHold(DELETE, session);
    await requestXDeleteTweetHold({ ...DELETE, tweetUrl: 'https://x.com/me/status/2' }, session);
    await requestXUnfollowHold({ handle: 'someone' }, session);

    expect(getPendingApprovalsByAction('x_delete_tweet')).toHaveLength(2);
    expect(getPendingApprovalsByAction('x_unfollow')).toHaveLength(1);
    expect(cards).toHaveLength(3);
  });

  it('does not claim a card was sent when there is no approver', async () => {
    closeDb();
    runMigrations(initTestDb());
    createAgentGroup({ id: 'ag-1', name: 'Agent', folder: 'agent', agent_provider: null, created_at: now() });
    createSession(session);

    await requestXUnfollowHold({ handle: 'someone' }, session);

    expect(getPendingApprovalsByAction('x_unfollow')).toHaveLength(0);
    expect(notes().some((t) => t.includes('sent to the owner'))).toBe(false);
    expect(notes().at(-1)).toContain('failed');
  });
});
