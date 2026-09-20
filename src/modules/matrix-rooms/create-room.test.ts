/**
 * Tests for create_matrix_room host-side behaviour.
 *
 * Scott's rule (2026-09-19): EVERY room an agent asks for is held for owner
 * approval. These tests drive the REAL wrapped delivery action (the only
 * reachable path) and the approve continuation's grant-carrying re-entry, so
 * they prove: nothing is created without approval, an approval creates exactly
 * what was approved, a dead or mismatched grant creates nothing, and bad
 * requests are answered without ever creating a hold.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { PendingApproval, Session } from '../../types.js';

const {
  mockRequestApproval,
  mockNotifyAgent,
  mockGetAdapter,
  mockCreateRoom,
  mockCreateMessagingGroup,
  mockCreateMessagingGroupAgent,
  mockGetGroupsWiredTo,
  mockGetOwners,
  mockWriteDestinations,
  liveApprovals,
  approvalHandlers,
} = vi.hoisted(() => ({
  mockRequestApproval: vi.fn().mockResolvedValue(undefined),
  mockNotifyAgent: vi.fn(),
  mockGetAdapter: vi.fn(),
  mockCreateRoom: vi.fn(),
  mockCreateMessagingGroup: vi.fn(),
  mockCreateMessagingGroupAgent: vi.fn(),
  mockGetGroupsWiredTo: vi.fn(),
  mockGetOwners: vi.fn(),
  mockWriteDestinations: vi.fn(),
  liveApprovals: new Map<string, import('../../types.js').PendingApproval>(),
  approvalHandlers: new Map<string, (ctx: Record<string, unknown>) => Promise<void>>(),
}));

vi.mock('../approvals/index.js', () => ({
  requestApproval: (...a: unknown[]) => mockRequestApproval(...a),
  notifyAgent: (...a: unknown[]) => mockNotifyAgent(...a),
  registerApprovalHandler: (action: string, handler: (ctx: Record<string, unknown>) => Promise<void>) => {
    approvalHandlers.set(action, handler);
  },
}));
vi.mock('../../channels/channel-registry.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../channels/channel-registry.js')>()),
  getChannelAdapterExact: (...a: unknown[]) => mockGetAdapter(...a),
}));
const GROUPS: Record<string, { id: string; name: string; folder: string; agent_provider: null; created_at: string }> = {
  'ag-1': { id: 'ag-1', name: 'Jorgenclaw', folder: 'main', agent_provider: null, created_at: '' },
  'ag-2': { id: 'ag-2', name: 'Coder', folder: 'coder', agent_provider: null, created_at: '' },
};
vi.mock('../../db/agent-groups.js', () => ({
  getAgentGroup: (id: string) => GROUPS[id],
  getAgentGroupByFolder: () => undefined,
  createAgentGroup: vi.fn(),
}));
vi.mock('../../db/connection.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../db/connection.js')>()),
  getDb: () => ({ transaction: (fn: () => void) => () => fn() }),
}));
vi.mock('../../db/messaging-groups.js', () => ({
  createMessagingGroup: (...a: unknown[]) => mockCreateMessagingGroup(...a),
  createMessagingGroupAgent: (...a: unknown[]) => mockCreateMessagingGroupAgent(...a),
  getMessagingGroupsByAgentGroup: (...a: unknown[]) => mockGetGroupsWiredTo(...a),
}));
vi.mock('../agent-to-agent/db/agent-destinations.js', () => ({
  getDestinationByName: (agentGroupId: string, name: string) =>
    agentGroupId === 'ag-1' && name === 'coder' ? { target_type: 'agent', target_id: 'ag-2' } : undefined,
  getDestinationByTarget: () => ({ local_name: 'bookkeeping' }),
  createDestination: vi.fn(),
  hasDestination: () => true,
  normalizeName: (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
}));
vi.mock('../agent-to-agent/write-destinations.js', () => ({
  writeDestinations: (...a: unknown[]) => mockWriteDestinations(...a),
}));
vi.mock('../permissions/db/user-roles.js', () => ({
  getOwners: (...a: unknown[]) => mockGetOwners(...a),
}));
vi.mock('../../session-manager.js', () => ({
  writeSessionMessage: vi.fn(),
  openInboundDb: vi.fn(),
  openOutboundDb: vi.fn(),
  clearOutbox: vi.fn(),
  readOutboxFiles: vi.fn().mockReturnValue([]),
  resolveSession: vi.fn(),
  sessionDir: vi.fn().mockReturnValue('/tmp/nowhere'),
  inboundDbPath: vi.fn().mockReturnValue('/tmp/nowhere/inbound.db'),
}));
vi.mock('../../container-runner.js', () => ({
  wakeContainer: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../db/sessions.js', () => ({
  getSession: (id: string) => ({ id, agent_group_id: 'ag-1' }),
  getPendingApproval: (id: string) => liveApprovals.get(id),
  getRunningSessions: () => [],
  getActiveSessions: () => [],
  createPendingQuestion: vi.fn(),
}));

// The module barrel registers ./guard.js (catalog entry) and the guard-wrapped
// create_matrix_room delivery action — the path under test.
import './index.js';
import { getDeliveryAction } from '../../delivery.js';
import { guard } from '../../guard/index.js';
import { orchestratorEngagePattern, subAgentEngagePattern } from './addressing.js';
import { matrixRoomsCreate } from './guard.js';

const SESSION = { id: 'sess-1', agent_group_id: 'ag-1' } as Session;
const SCOTT = '@scott:matrix.jorgenclaw.ai';
const NEW_ROOM = { roomId: '!new:matrix.jorgenclaw.ai', platformId: 'matrix:!new%3Amatrix.jorgenclaw.ai' };

async function runCreateRoom(content: Record<string, unknown>): Promise<void> {
  const wrapped = getDeliveryAction('create_matrix_room');
  expect(wrapped).toBeDefined();
  await wrapped!(content, SESSION, undefined as never);
}

function liveGrant(approvalId: string, payload: Record<string, unknown>): PendingApproval {
  const row = {
    approval_id: approvalId,
    session_id: SESSION.id,
    request_id: approvalId,
    action: 'create_matrix_room',
    payload: JSON.stringify(payload),
    created_at: new Date().toISOString(),
    agent_group_id: 'ag-1',
    channel_type: null,
    platform_id: null,
    platform_message_id: null,
    expires_at: null,
    status: 'pending',
    title: '',
    options_json: '[]',
    approver_user_id: null,
  } as PendingApproval;
  liveApprovals.set(approvalId, row);
  return row;
}

async function approve(payload: Record<string, unknown>, id = 'appr-mr-1'): Promise<void> {
  const approval = liveGrant(id, payload);
  const continuation = approvalHandlers.get('create_matrix_room');
  expect(continuation).toBeDefined();
  await continuation!({ session: SESSION, payload, approval, userId: `matrix:${SCOTT}`, notify: vi.fn() });
}

const APPROVED = { name: 'Bookkeeping', topic: null, invite: [SCOTT], agent: null };

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks keeps implementations; a test that makes these throw must not leak into the next.
  mockCreateMessagingGroup.mockReset();
  mockCreateMessagingGroupAgent.mockReset();
  liveApprovals.clear();
  mockGetOwners.mockReturnValue([
    { user_id: `matrix:${SCOTT}`, role: 'owner', agent_group_id: null },
    { user_id: 'signal:198c1cdb', role: 'owner', agent_group_id: null },
  ]);
  mockGetGroupsWiredTo.mockImplementation((agentGroupId: string) =>
    agentGroupId === 'ag-1' ? [{ channel_type: 'matrix', instance: 'matrix' }] : [],
  );
  const defaultAdapter = { createMatrixRoom: (...a: unknown[]) => mockCreateRoom(...a) };
  mockGetAdapter.mockImplementation((key: string) => (key === 'matrix' ? defaultAdapter : undefined));
  mockCreateRoom.mockResolvedValue(NEW_ROOM);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('create_matrix_room — every request is held', () => {
  it('a fresh request asks the owner and creates nothing', async () => {
    await runCreateRoom({ name: 'Bookkeeping' });

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    expect(mockRequestApproval.mock.calls[0][0]).toMatchObject({
      action: 'create_matrix_room',
      // the RESOLVED invite list (the owner's Matrix id, not the signal owner) is what gets approved
      payload: { name: 'Bookkeeping', topic: null, invite: [SCOTT], agent: null },
    });
    expect(mockCreateRoom).not.toHaveBeenCalled();
    expect(mockCreateMessagingGroup).not.toHaveBeenCalled();
  });

  it('a non-agent actor is denied outright', () => {
    const decision = guard(matrixRoomsCreate, { actor: { kind: 'human', userId: 'matrix:@x:y' }, payload: {} });
    expect(decision.effect).toBe('deny');
  });
});

describe('create_matrix_room — approved replay', () => {
  it('creates the room, wires it to the agent, and tells the requester', async () => {
    await approve(APPROVED);

    expect(mockCreateRoom).toHaveBeenCalledWith({
      name: 'Bookkeeping',
      topic: undefined,
      invite: [SCOTT],
      agentGroupId: 'ag-1',
    });
    expect(mockCreateMessagingGroup).toHaveBeenCalledWith(
      expect.objectContaining({
        channel_type: 'matrix',
        instance: 'matrix',
        platform_id: NEW_ROOM.platformId,
        name: 'Bookkeeping',
        is_group: 1,
        unknown_sender_policy: 'strict',
      }),
    );
    expect(mockCreateMessagingGroupAgent).toHaveBeenCalledWith(
      expect.objectContaining({
        agent_group_id: 'ag-1',
        engage_mode: 'pattern',
        engage_pattern: '.',
        sender_scope: 'known',
        session_mode: 'shared',
      }),
    );
    // the requester's own running session must see the new destination immediately
    expect(mockWriteDestinations).toHaveBeenCalledWith('ag-1', 'sess-1');
    expect(mockNotifyAgent).toHaveBeenCalledTimes(1);
    const report = mockNotifyAgent.mock.calls[0][1] as string;
    expect(report).toMatch(/was created/);
    // A report, not an invitation: it must tell the agent NOT to post in the room on its own…
    expect(report).toMatch(/Do NOT post in that room yourself/);
    expect(report).toMatch(/keep answering every message in the conversation it came from/);
    // …while still naming the destination, but only for when Scott asks.
    expect(report).toMatch(
      /Only if Scott asks you to post something into it, use send_message\(\{ to: "bookkeeping" \}\)/,
    );
    expect(mockRequestApproval).not.toHaveBeenCalled(); // no second card
  });

  it('a dead grant (approval already resolved) creates nothing and is not re-held', async () => {
    const approval = liveGrant('appr-mr-2', APPROVED);
    liveApprovals.delete('appr-mr-2');

    await approvalHandlers.get('create_matrix_room')!({
      session: SESSION,
      payload: APPROVED,
      approval,
      userId: `matrix:${SCOTT}`,
      notify: vi.fn(),
    });

    expect(mockCreateRoom).not.toHaveBeenCalled();
    expect(mockRequestApproval).not.toHaveBeenCalled();
  });

  it('a grant approved for a different room refuses the replay', async () => {
    const approval = liveGrant('appr-mr-3', { ...APPROVED, name: 'Something else' });

    await approvalHandlers.get('create_matrix_room')!({
      session: SESSION,
      payload: APPROVED,
      approval,
      userId: `matrix:${SCOTT}`,
      notify: vi.fn(),
    });

    expect(mockCreateRoom).not.toHaveBeenCalled();
    expect(mockRequestApproval).not.toHaveBeenCalled();
  });

  it('a grant approved for different invitees refuses the replay', async () => {
    const approval = liveGrant('appr-mr-4', { ...APPROVED, invite: ['@stranger:matrix.jorgenclaw.ai'] });

    await approvalHandlers.get('create_matrix_room')!({
      session: SESSION,
      payload: APPROVED,
      approval,
      userId: `matrix:${SCOTT}`,
      notify: vi.fn(),
    });

    expect(mockCreateRoom).not.toHaveBeenCalled();
  });

  it('the homeserver refusing leaves no database rows and tells the agent', async () => {
    mockCreateRoom.mockRejectedValue(new Error('M_FORBIDDEN'));

    await approve(APPROVED);

    expect(mockCreateMessagingGroup).not.toHaveBeenCalled();
    expect(mockNotifyAgent.mock.calls[0][1]).toMatch(/Matrix server refused \(M_FORBIDDEN\)/);
  });

  it('a wiring failure after the room exists reports the room id so it is not lost', async () => {
    mockCreateMessagingGroup.mockImplementation(() => {
      throw new Error('disk full');
    });

    await approve(APPROVED);

    expect(mockNotifyAgent.mock.calls[0][1]).toContain(NEW_ROOM.roomId);
    expect(mockNotifyAgent.mock.calls[0][1]).toMatch(/connecting it failed: disk full/);
    expect(mockWriteDestinations).not.toHaveBeenCalled();
  });
});

describe('create_matrix_room — one Matrix account per agent', () => {
  const CODER_REQUEST = { name: 'Coding', agent: 'Coder' };

  it('refuses a sub-agent that has no Matrix account of its own — no card, no room', async () => {
    await runCreateRoom(CODER_REQUEST);

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateRoom).not.toHaveBeenCalled();
    expect(mockNotifyAgent.mock.calls[0][1]).toMatch(/"Coder" has no Matrix account of its own/);
  });

  it("uses the sub-agent's own account once it exists, and does not project into the requester's session", async () => {
    const coderCreate = vi.fn().mockResolvedValue(NEW_ROOM);
    mockGetAdapter.mockImplementation((key: string) =>
      key === 'matrix-coder'
        ? { createMatrixRoom: coderCreate }
        : key === 'matrix'
          ? { createMatrixRoom: (...a: unknown[]) => mockCreateRoom(...a) }
          : undefined,
    );

    await runCreateRoom(CODER_REQUEST); // held first
    expect(mockRequestApproval).toHaveBeenCalledTimes(1);

    await approve({ name: 'Coding', topic: null, invite: [SCOTT], agent: 'Coder' });

    expect(coderCreate).toHaveBeenCalledWith(expect.objectContaining({ agentGroupId: 'ag-2' }));
    expect(mockCreateRoom).not.toHaveBeenCalled(); // NOT created as @jorgenclaw
    expect(mockCreateMessagingGroup).toHaveBeenCalledWith(expect.objectContaining({ instance: 'matrix-coder' }));
    expect(mockCreateMessagingGroupAgent).toHaveBeenCalledWith(expect.objectContaining({ agent_group_id: 'ag-2' }));
    expect(mockWriteDestinations).not.toHaveBeenCalled();
  });

  it('refuses an agent name the requester cannot address', async () => {
    await runCreateRoom({ name: 'Ghost room', agent: 'Ghost' });

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockNotifyAgent.mock.calls[0][1]).toMatch(/not one of your sub-agents/);
  });
});

describe('create_matrix_room — the requester joins a sub-agent room as a quiet member', () => {
  const JORGENCLAW = '@jorgenclaw:matrix.jorgenclaw.ai';
  const NAMES = ['jorgenclaw']; // first word of the group name "Jorgenclaw" == the Matrix localpart
  const CODER_REQUEST = { name: 'Coding', agent: 'Coder' };
  const CODER_APPROVED = { name: 'Coding', topic: null, invite: [SCOTT], agent: 'Coder' };
  const mockJoin = vi.fn();
  let coderCreate: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    mockJoin.mockReset().mockResolvedValue(undefined);
    coderCreate = vi.fn().mockResolvedValue(NEW_ROOM);
    mockGetAdapter.mockImplementation((key: string) =>
      key === 'matrix-coder'
        ? { createMatrixRoom: coderCreate }
        : key === 'matrix'
          ? {
              createMatrixRoom: (...a: unknown[]) => mockCreateRoom(...a),
              matrixUserId: () => JORGENCLAW,
              joinMatrixRoom: (...a: unknown[]) => mockJoin(...a),
            }
          : undefined,
    );
  });

  it('the approval card says so, and the approved payload still lists only who Scott approved', async () => {
    await runCreateRoom(CODER_REQUEST);

    expect(mockRequestApproval).toHaveBeenCalledTimes(1);
    const card = mockRequestApproval.mock.calls[0][0] as { question: string; payload: Record<string, unknown> };
    expect(card.question).toMatch(/Jorgenclaw will also join as a quiet member/);
    expect(card.payload).toEqual(CODER_APPROVED); // the requester is not smuggled into the approved invitees
  });

  it('invites and joins the requester, and wires it to the room next to the sub-agent', async () => {
    await approve(CODER_APPROVED);

    expect(coderCreate).toHaveBeenCalledWith(expect.objectContaining({ invite: [SCOTT, JORGENCLAW] }));
    expect(mockJoin).toHaveBeenCalledWith(NEW_ROOM.roomId);

    // two messaging groups for ONE room, one per account (the instance is part of the key)
    expect(mockCreateMessagingGroup).toHaveBeenCalledTimes(2);
    expect(mockCreateMessagingGroup.mock.calls[0][0]).toMatchObject({
      instance: 'matrix-coder',
      platform_id: NEW_ROOM.platformId,
      name: 'Coding',
    });
    expect(mockCreateMessagingGroup.mock.calls[1][0]).toMatchObject({
      instance: 'matrix',
      platform_id: NEW_ROOM.platformId,
      name: 'Coding room',
      unknown_sender_policy: 'strict',
    });

    // the sub-agent skips messages addressed to the requester; the requester answers only those
    expect(mockCreateMessagingGroupAgent.mock.calls[0][0]).toMatchObject({
      agent_group_id: 'ag-2',
      engage_pattern: subAgentEngagePattern(NAMES),
      ignored_message_policy: 'drop',
    });
    expect(mockCreateMessagingGroupAgent.mock.calls[1][0]).toMatchObject({
      agent_group_id: 'ag-1',
      engage_mode: 'pattern',
      engage_pattern: orchestratorEngagePattern(NAMES),
      sender_scope: 'known',
      ignored_message_policy: 'accumulate',
      session_mode: 'shared',
    });
    // the requester's running session must see its new destination immediately
    expect(mockWriteDestinations).toHaveBeenCalledWith('ag-1', 'sess-1');
  });

  it('tells the requester it is a quiet member, not to post, and how to be addressed', async () => {
    await approve(CODER_APPROVED);

    const report = mockNotifyAgent.mock.calls[0][1] as string;
    expect(report).toMatch(/handled by "Coder", not by you/);
    expect(report).toMatch(/quiet member/);
    expect(report).toMatch(/STARTS with your name \(for example "jorgenclaw, \.\.\."\)/);
    expect(report).toMatch(/Do NOT post in that room yourself/);
  });

  it('failing to join is not fatal: the room is still wired and the requester is told', async () => {
    mockJoin.mockRejectedValue(new Error('M_FORBIDDEN'));

    await approve(CODER_APPROVED);

    expect(mockCreateMessagingGroup).toHaveBeenCalledTimes(2);
    expect(mockNotifyAgent.mock.calls[0][1]).toMatch(/could not join that room yet/);
    expect(mockNotifyAgent.mock.calls[0][1]).not.toMatch(/You are in that room as a quiet member/);
  });

  it("a requester's own room has no quiet member: one messaging group, answers everything, no join", async () => {
    await approve(APPROVED);

    expect(mockJoin).not.toHaveBeenCalled();
    expect(mockCreateMessagingGroup).toHaveBeenCalledTimes(1);
    expect(mockCreateMessagingGroupAgent).toHaveBeenCalledTimes(1);
    expect(mockCreateMessagingGroupAgent.mock.calls[0][0]).toMatchObject({ engage_pattern: '.' });
  });

  it('a requester whose account cannot join makes the room exactly as before', async () => {
    mockGetAdapter.mockImplementation((key: string) =>
      key === 'matrix-coder'
        ? { createMatrixRoom: coderCreate }
        : key === 'matrix'
          ? { createMatrixRoom: (...a: unknown[]) => mockCreateRoom(...a) } // no join, no user id
          : undefined,
    );

    await approve(CODER_APPROVED);

    expect(coderCreate).toHaveBeenCalledWith(expect.objectContaining({ invite: [SCOTT] }));
    expect(mockCreateMessagingGroup).toHaveBeenCalledTimes(1);
    expect(mockCreateMessagingGroupAgent.mock.calls[0][0]).toMatchObject({ engage_pattern: '.' });
  });
});

describe('create_matrix_room — bad requests never create a hold', () => {
  const cases: Array<[string, Record<string, unknown>, RegExp]> = [
    ['missing name', { name: '' }, /name is required/],
    ['name too long', { name: 'x'.repeat(81) }, /too long/],
    ['name with control characters', { name: 'bad\u0007name' }, /control characters/],
    ['topic too long', { name: 'ok', topic: 'x'.repeat(251) }, /topic is too long/],
    ['invite that is not a list', { name: 'ok', invite: '@scott:matrix.jorgenclaw.ai' }, /list of Matrix user ids/],
    ['invite that is not a Matrix id', { name: 'ok', invite: ['scott'] }, /not a Matrix user id/],
    ['an empty invite list', { name: 'ok', invite: [] }, /invite is empty/],
    [
      'too many invitees',
      { name: 'ok', invite: ['@a:x.y', '@b:x.y', '@c:x.y', '@d:x.y', '@e:x.y', '@f:x.y'] },
      /too many/,
    ],
  ];

  it.each(cases)('%s', async (_label, content, message) => {
    await runCreateRoom(content);

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockCreateRoom).not.toHaveBeenCalled();
    expect(mockNotifyAgent.mock.calls[0][1]).toMatch(message);
  });

  it('no owner with a Matrix identity and no explicit invite', async () => {
    mockGetOwners.mockReturnValue([{ user_id: 'signal:198c1cdb', role: 'owner', agent_group_id: null }]);

    await runCreateRoom({ name: 'ok' });

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockNotifyAgent.mock.calls[0][1]).toMatch(/nobody to invite/);
  });

  it('Matrix not connected', async () => {
    mockGetAdapter.mockReturnValue(undefined);

    await runCreateRoom({ name: 'ok' });

    expect(mockRequestApproval).not.toHaveBeenCalled();
    expect(mockNotifyAgent.mock.calls[0][1]).toMatch(/not connected to Matrix/);
  });
});
